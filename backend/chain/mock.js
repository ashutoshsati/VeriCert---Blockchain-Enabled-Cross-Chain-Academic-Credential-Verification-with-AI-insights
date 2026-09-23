const fs = require("fs");
const path = require("path");

// Mock issuer/verifier chains, saved to a JSON file so records survive a server restart.
const STATE_FILE = process.env.MOCK_CHAIN_FILE || path.join(__dirname, "..", "mock-chain.json");

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return { issuer: {}, verifier: {} };
    throw err;
  }
}

const state = loadState();

function saveState() {
  const tempFile = STATE_FILE + ".tmp";
  fs.writeFileSync(tempFile, JSON.stringify(state, null, 2));
  fs.renameSync(tempFile, STATE_FILE);
}

function fakeHash(prefix) {
  return "0x" + prefix + Math.random().toString(16).slice(2).padEnd(60, "0").slice(0, 60);
}

async function issueAndRelay(credentialHash, issuer) {
  const timestamp = Date.now();
  state.issuer[credentialHash] ??= { issuer, timestamp, revoked: false };
  state.verifier[credentialHash] ??= { issuer, issuedAt: timestamp, receivedAt: Date.now(), revoked: false };
  saveState();
  return { txHash: fakeHash("aa"), ccipMessageId: fakeHash("bb") };
}

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

const requiredEnv = [];

// No settings to validate; kept so both chain implementations share the same interface.
function checkConfig() {}

async function close() {}

module.exports = { mode: "mock", requiredEnv, checkConfig, issueAndRelay, verifyOnChain, revokeAndRelay, chainEvidence, close };
