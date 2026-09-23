const { ethers } = require("ethers");

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

const FRIENDLY_ERRORS = {
  NotIssuer: "The backend wallet is not an approved issuer on the VeriCert contract",
  ReceiverNotSet: "The VeriCert contract has no Receiver address set",
  AlreadyIssued: "This credential is already recorded on Polygon Amoy",
  NotIssued: "This credential is not recorded on Polygon Amoy",
  AlreadyRevoked: "This credential is already revoked on Polygon Amoy",
  InsufficientFee: "The CCIP fee sent was too low; please retry",
  RefundFailed: "The VeriCert contract could not refund the excess CCIP fee",
};

const requiredEnv = ["AMOY_RPC_URL", "FUJI_RPC_URL", "ISSUER_PRIVATE_KEY", "VERICERT_ADDRESS", "RECEIVER_ADDRESS"];

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

async function close() {
  if (!clients) return;
  for (const provider of clients.providers) provider.destroy();
  clients = undefined;
}

module.exports = { mode: "ccip", requiredEnv, checkConfig, issueAndRelay, verifyOnChain, revokeAndRelay, chainEvidence, close, VERICERT_ABI, RECEIVER_ABI };
