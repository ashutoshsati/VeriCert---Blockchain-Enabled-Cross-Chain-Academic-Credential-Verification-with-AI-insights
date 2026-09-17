const { ethers } = require("ethers");

// Real chain: VeriCert on Polygon Amoy relays to Receiver on Avalanche Fuji through Chainlink CCIP.
const ACTION_ISSUE = 1;
const ACTION_REVOKE = 2;
const FEE_BUFFER_PERCENT = 110n; // the contract refunds anything above the actual fee
const LOG_SEARCH_WINDOW = 2_000; // blocks per eth_getLogs call (public RPCs cap the range)
const LOG_SEARCH_MAX_BLOCKS = 50_000; // about a day on Amoy
// issue/revoke cost well under 500k gas in practice; a fixed limit skips automatic estimateGas,
// which some RPCs (including local Hardhat nodes) fail to compute reliably for this call shape.
const SEND_GAS_LIMIT = 1_500_000n;

const VERICERT_ABI = [
  "function issue(bytes32 hash) payable returns (bytes32 messageId)",
  "function revoke(bytes32 hash) payable returns (bytes32 messageId)",
  "function quoteFee(uint8 action, bytes32 hash) view returns (uint256)",
  "function getCredential(bytes32 hash) view returns (bool exists, address issuer, uint64 issuedAt, bool revoked)",
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

function getClients() {
  if (!clients) {
    // ethers v6 caches reads (incl. getTransactionCount) for 250ms by default; a fast-mining local
    // Hardhat node can produce several of this module's transactions within that window, which
    // returned a stale nonce and caused "nonce has already been used" errors. Disabling the cache
    // costs a few extra RPC round trips, which is negligible against real Amoy/Fuji block times.
    const amoy = new ethers.JsonRpcProvider(process.env.AMOY_RPC_URL, undefined, { cacheTimeout: -1 });
    const fuji = new ethers.JsonRpcProvider(process.env.FUJI_RPC_URL, undefined, { cacheTimeout: -1 });
    const wallet = new ethers.Wallet(process.env.ISSUER_PRIVATE_KEY, amoy);
    clients = {
      providers: [amoy, fuji],
      veriCert: new ethers.Contract(process.env.VERICERT_ADDRESS, VERICERT_ABI, wallet),
      receiver: new ethers.Contract(process.env.RECEIVER_ADDRESS, RECEIVER_ABI, fuji),
    };
  }
  return clients;
}

function explain(err, veriCert) {
  let name = err?.revert?.name;
  // ethers v6 only auto-decodes custom errors via a contract's ABI for staticCall/view paths, never
  // for a plain state-changing send() (err.revert stays null there). And because issue()/revoke() are
  // sent with an explicit gasLimit (see SEND_GAS_LIMIT) to skip an unreliable estimateGas, a revert
  // surfaces from eth_sendRawTransaction itself as a plain UNKNOWN_ERROR, where ethers nests the raw
  // revert bytes at err.error.data.data instead of the top-level err.data used for a CALL_EXCEPTION.
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

// The transaction already succeeded earlier (e.g. the response was lost), so return its details instead of resending.
async function recover(veriCert, filter) {
  const event = await findLatestEvent(veriCert, filter);
  if (!event) throw new Error("Already recorded on Polygon Amoy, but the CCIP message could not be found in recent blocks");
  return { txHash: event.transactionHash, ccipMessageId: event.args.messageId };
}

async function send(veriCert, method, action, eventName, credentialHash) {
  const fee = await veriCert.quoteFee(action, credentialHash);
  const tx = await veriCert[method](credentialHash, { value: (fee * FEE_BUFFER_PERCENT) / 100n, gasLimit: SEND_GAS_LIMIT });
  const receipt = await tx.wait();
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

async function close() {
  if (!clients) return;
  for (const provider of clients.providers) provider.destroy();
  clients = undefined;
}

module.exports = { requiredEnv, issueAndRelay, verifyOnChain, revokeAndRelay, close, VERICERT_ABI, RECEIVER_ABI };
