// IN PLAIN ENGLISH: a pretend blockchain for demos and development. Instead of real blockchains, it
// keeps two lists in a file on this computer — an "issuer" list (standing in for Polygon Amoy) and a
// "verifier" list (standing in for Avalanche Fuji). Delivery between them is instant, and the receipt
// numbers it hands back are made up. It behaves the same way as the real version, just without the cost
// or the wait.
const fs = require("fs");
const path = require("path");

// Mock issuer/verifier chains, saved to a JSON file so records survive a server restart.
const STATE_FILE = process.env.MOCK_CHAIN_FILE || path.join(__dirname, "..", "mock-chain.json");

// Reads the saved lists from the file, or starts with empty lists if there is no file yet.
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return { issuer: {}, verifier: {} };
    throw err;
  }
}

const state = loadState();

// Saves the lists back to the file. It writes a temporary copy first, then swaps it in, so a crash
// halfway through can never leave a half-written file.
function saveState() {
  const tempFile = STATE_FILE + ".tmp";
  fs.writeFileSync(tempFile, JSON.stringify(state, null, 2));
  fs.renameSync(tempFile, STATE_FILE);
}

// Makes up a random receipt number that looks like a real blockchain one.
function fakeHash(prefix) {
  return "0x" + prefix + Math.random().toString(16).slice(2).padEnd(60, "0").slice(0, 60);
}

// ISSUE: add the degree to both lists at once (simulating instant cross-chain delivery).
async function issueAndRelay(credentialHash, issuer) {
  const timestamp = Date.now();
  state.issuer[credentialHash] ??= { issuer, timestamp, revoked: false };
  state.verifier[credentialHash] ??= { issuer, issuedAt: timestamp, receivedAt: Date.now(), revoked: false };
  saveState();
  return { txHash: fakeHash("aa"), ccipMessageId: fakeHash("bb") };
}

// VERIFY: look the degree up in the "verifier" list and report whether it exists and is still valid.
async function verifyOnChain(credentialHash) {
  const record = state.verifier[credentialHash];
  if (!record) return { isValid: false, found: false };
  return {
    found: true,
    isValid: !record.revoked,
    issuer: record.issuer,
    issuedAt: record.issuedAt,
    receivedAt: record.receivedAt,
    revoked: record.revoked,
  };
}

// REVOKE: mark the degree as cancelled in both lists.
async function revokeAndRelay(credentialHash) {
  if (state.issuer[credentialHash]) state.issuer[credentialHash].revoked = true;
  if (state.verifier[credentialHash]) state.verifier[credentialHash].revoked = true;
  saveState();
  return { txHash: fakeHash("cc"), ccipMessageId: fakeHash("dd") };
}

// The mock chain has no contracts or events to show.
async function chainEvidence() {
  return null;
}

// The pretend blockchain needs no special settings.
const requiredEnv = [];

// No settings to validate; kept so both chain implementations share the same interface.
function checkConfig() {}

// Nothing to disconnect from.
async function close() {}

module.exports = { mode: "mock", requiredEnv, checkConfig, issueAndRelay, verifyOnChain, revokeAndRelay, chainEvidence, close };
