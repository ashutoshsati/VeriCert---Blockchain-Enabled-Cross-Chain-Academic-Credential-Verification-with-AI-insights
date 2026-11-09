// =====================================================================================================
// IN PLAIN ENGLISH
// -----------------------------------------------------------------------------------------------------
// This file connects the backend to the REAL blockchains. It:
//   - issues and revokes degrees by sending transactions to the VeriCert contract on Polygon Amoy
//     (which then relays them to Avalanche Fuji via Chainlink CCIP),
//   - verifies degrees by reading the Receiver contract on Avalanche Fuji, and
//   - digs up on-chain "evidence" (the public log of what happened) for the AI explanation.
// It also translates technical blockchain errors into plain sentences, and takes care not to waste
// money on transactions that are bound to fail.
// =====================================================================================================
const { ethers } = require("ethers");

// TUNING SETTINGS. Searching the blockchain's history is done in chunks ("blocks" are the pages of the
// blockchain's ledger; a new one is added every few seconds), and transactions get safety limits.
// Real chain: VeriCert on Polygon Amoy relays to Receiver on Avalanche Fuji through Chainlink CCIP.
const ACTION_ISSUE = 1;
const ACTION_REVOKE = 2;
const FEE_BUFFER_PERCENT = 110n; // the contract refunds anything above the actual fee
const LOG_SEARCH_WINDOW = 2_000; // blocks per eth_getLogs call (public RPCs cap the range)
const LOG_SEARCH_MAX_BLOCKS = 50_000; // about a day on Amoy
const RECEIVED_EVENT_WINDOW = 20; // blocks after the first one stamped receivedAt (several Fuji blocks can share a second)
const REVOKE_SEARCH_BLOCKS = 4_000; // about two hours of Fuji blocks after the revoke was recorded
const REVOKE_SEARCH_MARGIN_MS = 10 * 60 * 1000; // start a little before the backend's own revoke timestamp
// issue/revoke cost well under 500k gas in practice. Used only as a last-resort gasLimit when
// estimateGas itself cannot be computed (observed on a local Hardhat node for revoke(), even though
// the call actually succeeds cheaply) and the failure carries no revert data to explain instead.
const SEND_GAS_LIMIT = 1_500_000n;
const GAS_ESTIMATE_PADDING_PERCENT = 120n; // headroom over the estimate, in case on-chain conditions shift slightly
const SEND_CONFIRM_TIMEOUT_MS = 180_000; // tx.wait() would otherwise hang forever on a dropped/underpriced tx
const INVALID_KEY_MESSAGE = "ISSUER_PRIVATE_KEY is not a valid private key";

// A "menu" of what the backend can ask each contract to do and what announcements (events) it can
// read from them. This must match the contracts in contracts/contracts/.
const VERICERT_ABI = [
  "function issue(bytes32 hash) payable returns (bytes32 messageId)",
  "function revoke(bytes32 hash) payable returns (bytes32 messageId)",
  "function quoteFee(uint8 action, bytes32 hash) view returns (uint256)",
  "function getCredential(bytes32 hash) view returns (bool exists, address issuer, uint64 issuedAt, bool revoked)",
  "function isIssuer(address) view returns (bool)",
  "event CredentialIssued(bytes32 indexed hash, address indexed issuer, bytes32 messageId)",
  "event CredentialRevoked(bytes32 indexed hash, address indexed revokedBy, bytes32 messageId)",
  "error NotIssuer(address account)",
  "error ReceiverNotSet()",
  "error AlreadyIssued(bytes32 hash)",
  "error NotIssued(bytes32 hash)",
  "error AlreadyRevoked(bytes32 hash)",
  "error InsufficientFee(uint256 required, uint256 sent)",
  "error RefundFailed()",
];

const RECEIVER_ABI = [
  "function getCredential(bytes32 hash) view returns (bool exists, address issuer, uint64 issuedAt, uint64 receivedAt, bool revoked)",
  "event CredentialReceived(bytes32 indexed hash, address indexed issuer, uint64 issuedAt, bytes32 messageId)",
  "event CredentialRevoked(bytes32 indexed hash, bytes32 messageId)",
];

// Plain-English versions of the reasons the VeriCert contract can refuse a request.
const FRIENDLY_ERRORS = {
  NotIssuer: "The backend wallet is not an approved issuer on the VeriCert contract",
  ReceiverNotSet: "The VeriCert contract has no Receiver address set",
  AlreadyIssued: "This credential is already recorded on Polygon Amoy",
  NotIssued: "This credential is not recorded on Polygon Amoy",
  AlreadyRevoked: "This credential is already revoked on Polygon Amoy",
  InsufficientFee: "The CCIP fee sent was too low; please retry",
  RefundFailed: "The VeriCert contract could not refund the excess CCIP fee",
};

// Settings that must be filled in to use real blockchains: how to connect to each chain, the backend's
// wallet key (used to sign transactions), and the two contract addresses.
const requiredEnv = ["AMOY_RPC_URL", "FUJI_RPC_URL", "ISSUER_PRIVATE_KEY", "VERICERT_ADDRESS", "RECEIVER_ADDRESS"];

// The open connections to both blockchains, created the first time they're needed and then reused.
let clients;

// Never let a malformed ISSUER_PRIVATE_KEY reach a caller via its original ethers error message
// (e.g. "invalid BytesLike value (argument="value", value="0x<the key>", ...)"), since that message
// nearly reproduces the key itself. Anonymous callers can trigger this lazily through /verify.
function buildWallet(provider) {
  try {
    return new ethers.Wallet(process.env.ISSUER_PRIVATE_KEY, provider);
  } catch {
    throw new Error(INVALID_KEY_MESSAGE);
  }
}

// Connects to Amoy and Fuji (once), loads the backend's wallet, and sets up a handle for each contract:
// VeriCert on Amoy (with the wallet, so we can send transactions) and Receiver on Fuji (read-only).
function getClients() {
  if (!clients) {
    // ethers v6 caches reads (incl. getTransactionCount) for 250ms by default; a fast-mining local
    // Hardhat node can produce several of this module's transactions within that window, which
    // returned a stale nonce and caused "nonce has already been used" errors. Disabling the cache
    // costs a few extra RPC round trips, which is negligible against real Amoy/Fuji block times.
    const amoy = new ethers.JsonRpcProvider(process.env.AMOY_RPC_URL, undefined, { cacheTimeout: -1 });
    const fuji = new ethers.JsonRpcProvider(process.env.FUJI_RPC_URL, undefined, { cacheTimeout: -1 });
    const wallet = buildWallet(amoy);
    clients = {
      providers: [amoy, fuji],
      veriCert: new ethers.Contract(process.env.VERICERT_ADDRESS, VERICERT_ABI, wallet),
      receiver: new ethers.Contract(process.env.RECEIVER_ADDRESS, RECEIVER_ABI, fuji),
    };
  }
  return clients;
}

// Validates settings eagerly (e.g. at server startup) instead of waiting for the first lazy getClients() call.
function checkConfig() {
  buildWallet();
}

// Turns a raw blockchain error into a plain-English one (e.g. "The CCIP fee sent was too low"). The
// technical notes below explain where the error details hide in different cases.
function explain(err, veriCert) {
  // send()'s staticCall pre-check (see below) decodes a predictable revert into err.revert directly,
  // so this is the common case. The fallbacks below cover the rarer paths where ethers does not: a
  // raw estimateGas CALL_EXCEPTION carries revert bytes at the top-level err.data instead (ethers v6
  // never runs ABI-based decoding for a plain estimateGas/send() call, only for staticCall); and on a
  // local Hardhat node specifically, a transaction that reverts on broadcast (e.g. a race between the
  // staticCall above and the actual send) is rejected immediately from eth_sendRawTransaction as a
  // plain UNKNOWN_ERROR, with the revert bytes nested at err.error.data.data instead.
  let name = err?.revert?.name;
  const data = err?.data ?? err?.error?.data?.data;
  if (!name && data) {
    try {
      name = veriCert.interface.parseError(data)?.name;
    } catch {
      // not a VeriCert error
    }
  }
  if (name && FRIENDLY_ERRORS[name]) return new Error(FRIENDLY_ERRORS[name]);
  if (err?.code === "INSUFFICIENT_FUNDS") return new Error("The backend wallet has insufficient POL for gas + CCIP fee");
  return err;
}

// SEARCH HELPERS. The three functions below search the blockchain's public log for a particular
// announcement, e.g. "when did Fuji receive this degree?". Searching the whole history at once isn't
// allowed by public blockchain services, so they search chunk by chunk, as efficiently as possible.

// Newest matching event within the last LOG_SEARCH_MAX_BLOCKS blocks, searched backwards in windows.
async function findLatestEvent(contract, filter) {
  const latest = await contract.runner.provider.getBlockNumber();
  const floor = Math.max(0, latest - LOG_SEARCH_MAX_BLOCKS);
  for (let to = latest; to >= floor; to -= LOG_SEARCH_WINDOW) {
    const from = Math.max(floor, to - LOG_SEARCH_WINDOW + 1);
    const events = await contract.queryFilter(filter, from, to);
    if (events.length) return events[events.length - 1];
  }
  return null;
}

// First block whose timestamp (seconds) is at or after `timestamp`, by binary search: about 25 getBlock calls on Fuji.
async function firstBlockAtOrAfter(provider, timestamp) {
  let low = 0;
  let high = await provider.getBlockNumber();
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if ((await provider.getBlock(mid)).timestamp < timestamp) low = mid + 1;
    else high = mid;
  }
  return low;
}

// Oldest matching event from block `from` onwards, searched forwards in windows for up to `maxBlocks` blocks.
async function findFirstEventFrom(contract, filter, from, maxBlocks) {
  const latest = await contract.runner.provider.getBlockNumber();
  const ceiling = Math.min(latest, from + maxBlocks);
  for (let start = from; start <= ceiling; start += LOG_SEARCH_WINDOW) {
    const events = await contract.queryFilter(filter, start, Math.min(ceiling, start + LOG_SEARCH_WINDOW - 1));
    if (events.length) return events[0];
  }
  return null;
}

// The transaction already succeeded earlier (e.g. the response was lost), so return its details instead of resending.
async function recover(veriCert, filter) {
  const event = await findLatestEvent(veriCert, filter);
  if (!event) throw new Error("Already recorded on Polygon Amoy, but the CCIP message could not be found in recent blocks");
  return { txHash: event.transactionHash, ccipMessageId: event.args.messageId };
}

// SENDS ONE TRANSACTION to the VeriCert contract (issue or revoke), carefully:
//   1. Ask the contract for the CCIP fee and add 10%. The contract refunds whatever is left over.
//   2. Rehearse it for free; if it would be refused, stop now without spending anything.
//   3. Work out how much "gas" (processing fee) it needs, plus a little headroom.
//   4. Send it, wait (up to 3 minutes) for the blockchain to confirm it, and pull the CCIP tracking
//      number out of the receipt.
// The wallet pays both the CCIP fee and the gas in POL.
async function send(veriCert, method, action, eventName, credentialHash) {
  const fee = await veriCert.quoteFee(action, credentialHash);
  const value = (fee * FEE_BUFFER_PERCENT) / 100n;

  // Simulate before broadcasting: staticCall decodes a predictable revert (NotIssuer, ReceiverNotSet,
  // AlreadyIssued/AlreadyRevoked, InsufficientFee) into err.revert, on every network, at zero gas cost.
  // Without this, a call that will revert would only be caught after being mined on a public RPC
  // (burning real gas) and tx.wait() cannot recover any revert reason from a mined-but-failed receipt.
  await veriCert[method].staticCall(credentialHash, { value });

  // Prefer the real gas estimate (padded for headroom) over the fixed fallback, so a normal, cheap
  // call does not over-reserve balance against gasLimit * maxFeePerGas. Only fall back to the fixed
  // limit when estimateGas itself cannot be computed and carries no revert data to explain (the local
  // Hardhat node's revoke() estimation bug); a real revert with data is rethrown as-is.
  let gasLimit;
  try {
    gasLimit = ((await veriCert[method].estimateGas(credentialHash, { value })) * GAS_ESTIMATE_PADDING_PERCENT) / 100n;
  } catch (err) {
    if (err?.data || err?.error?.data?.data) throw err;
    gasLimit = SEND_GAS_LIMIT;
  }

  const tx = await veriCert[method](credentialHash, { value, gasLimit });
  const receipt = await tx.wait(1, SEND_CONFIRM_TIMEOUT_MS);
  const address = (await veriCert.getAddress()).toLowerCase();
  const event = receipt.logs
    .filter((log) => log.address.toLowerCase() === address)
    .map((log) => veriCert.interface.parseLog(log))
    .find((parsed) => parsed?.name === eventName);
  return { txHash: receipt.hash, ccipMessageId: event.args.messageId };
}

// ISSUE A DEGREE on the real blockchain. If it's already recorded (say, an earlier attempt worked but
// the reply got lost), find and return that earlier receipt instead of paying to send it again.
// `issuer` (the university name) is kept in MongoDB; on-chain the issuer is the signing wallet.
async function issueAndRelay(credentialHash, issuer) {
  const { veriCert } = getClients();
  try {
    const existing = await veriCert.getCredential(credentialHash);
    if (existing.exists) return await recover(veriCert, veriCert.filters.CredentialIssued(credentialHash));
    return await send(veriCert, "issue", ACTION_ISSUE, "CredentialIssued", credentialHash);
  } catch (err) {
    throw explain(err, veriCert);
  }
}

// REVOKE A DEGREE on the real blockchain, with the same "don't pay twice" safeguard as issuing.
async function revokeAndRelay(credentialHash) {
  const { veriCert } = getClients();
  try {
    const existing = await veriCert.getCredential(credentialHash);
    if (existing.revoked) return await recover(veriCert, veriCert.filters.CredentialRevoked(credentialHash));
    return await send(veriCert, "revoke", ACTION_REVOKE, "CredentialRevoked", credentialHash);
  } catch (err) {
    throw explain(err, veriCert);
  }
}

// VERIFY A DEGREE: ask the Receiver contract on Fuji whether it knows this fingerprint and whether it
// has been revoked. Reading from a blockchain is free. (Blockchain times are in seconds; we convert
// them to milliseconds, which is what the rest of the backend uses.)
async function verifyOnChain(credentialHash) {
  const { receiver } = getClients();
  const record = await receiver.getCredential(credentialHash);
  if (!record.exists) return { isValid: false, found: false };
  return {
    found: true,
    isValid: !record.revoked,
    issuer: record.issuer,
    issuedAt: Number(record.issuedAt) * 1000,
    receivedAt: Number(record.receivedAt) * 1000,
    revoked: record.revoked,
  };
}

// On-chain evidence for /explain: the Amoy source record, whether its issuer is still approved, and this
// credential's Fuji events. receivedAt/revokedAfter (ms) let the search jump straight to the right blocks.
async function chainEvidence(credentialHash, { issuer, receivedAt, revoked, revokedAfter } = {}) {
  const { veriCert, receiver } = getClients();
  const fuji = receiver.runner.provider;
  const amoy = await veriCert.getCredential(credentialHash);
  const issuerApproved = issuer ? await veriCert.isIssuer(issuer) : null;
  const fujiEvents = [];

  if (receivedAt) {
    const start = await firstBlockAtOrAfter(fuji, Math.floor(receivedAt / 1000));
    const end = Math.min(await fuji.getBlockNumber(), start + RECEIVED_EVENT_WINDOW);
    const [event] = await receiver.queryFilter(receiver.filters.CredentialReceived(credentialHash), start, end);
    if (event) {
      fujiEvents.push({
        event: "CredentialReceived",
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
        messageId: event.args.messageId,
        issuer: event.args.issuer,
        issuedAt: Number(event.args.issuedAt) * 1000,
      });
    }
  }

  if (revoked) {
    const filter = receiver.filters.CredentialRevoked(credentialHash);
    let event = null;
    if (revokedAfter) {
      const from = await firstBlockAtOrAfter(fuji, Math.floor((revokedAfter - REVOKE_SEARCH_MARGIN_MS) / 1000));
      event = await findFirstEventFrom(receiver, filter, from, REVOKE_SEARCH_BLOCKS);
    }
    event ??= await findLatestEvent(receiver, filter);
    if (event) {
      fujiEvents.push({ event: "CredentialRevoked", blockNumber: event.blockNumber, transactionHash: event.transactionHash, messageId: event.args.messageId });
    }
  }

  return {
    amoy: { exists: amoy.exists, issuer: amoy.issuer, issuedAt: Number(amoy.issuedAt) * 1000, revoked: amoy.revoked },
    issuerApproved,
    fujiEvents,
  };
}

// Closes the connections to both blockchains (used when shutting down and in tests).
async function close() {
  if (!clients) return;
  for (const provider of clients.providers) provider.destroy();
  clients = undefined;
}

module.exports = { mode: "ccip", requiredEnv, checkConfig, issueAndRelay, verifyOnChain, revokeAndRelay, chainEvidence, close, VERICERT_ABI, RECEIVER_ABI };
