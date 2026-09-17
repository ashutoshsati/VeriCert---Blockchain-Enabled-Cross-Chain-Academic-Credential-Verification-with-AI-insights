require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { connectDB, Credential, ProvenanceEvent } = require("./db");
const chain = require("./chain");
const { ValidationError, parseCredential, hashCredential, normalizeHash } = require("./credential");

const app = express();
app.use(cors());
app.use(express.json());

async function logEvent(credentialHash, eventType, chainName, txHash, ccipMessageId, details) {
  await ProvenanceEvent.create({
    credentialHash, eventType, chain: chainName, txHash, ccipMessageId, details,
  });
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest();
}

// Admin-only routes need the x-api-key header to match ADMIN_API_KEY.
function requireApiKey(req, res, next) {
  const expected = process.env.ADMIN_API_KEY;
  if (!expected) return res.status(503).json({ error: "ADMIN_API_KEY is not configured on the server" });
  const provided = req.get("x-api-key") || "";
  if (!crypto.timingSafeEqual(sha256(provided), sha256(expected))) {
    return res.status(401).json({ error: "Invalid or missing API key" });
  }
  next();
}

// Public routes must not echo raw error messages for unexpected 500s (a malformed ISSUER_PRIVATE_KEY,
// for example, would otherwise reach anonymous /verify callers via ethers' own error text). The
// API-key-protected admin routes (/issue, /revoke) keep exposing err.message: those errors are
// meant to explain the failure to whoever holds the admin key (e.g. "not an approved issuer").
function sendError(res, err, { exposeMessage = false } = {}) {
  if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
  if (err.code === 11000) return res.status(409).json({ error: "This credential already exists" });
  console.error(err);
  if (exposeMessage) return res.status(500).json({ error: err.message });
  res.status(500).json({ error: "Internal server error" });
}

function sendAdminError(res, err) {
  sendError(res, err, { exposeMessage: true });
}

app.post("/issue", requireApiKey, async (req, res) => {
  try {
    const credential = parseCredential(req.body);
    const credentialHash = hashCredential(credential);

    let record = await Credential.findOne({ credentialHash });
    if (record && record.status !== "pending") {
      return res.status(409).json({ error: "This credential already exists", credentialHash });
    }
    if (!record) {
      record = await Credential.create({ ...credential, credentialHash, status: "pending" });
      await logEvent(credentialHash, "issued", "polygon-amoy", null, null, "Credential created");
    }

    // A record that is still pending had its earlier relay fail, so this retries it.
    const { txHash, ccipMessageId } = await chain.issueAndRelay(credentialHash, credential.issuer);
    record.status = "relaying";
    await record.save();
    await logEvent(credentialHash, "relayed", "polygon-amoy", txHash, ccipMessageId, "Sent to Avalanche Fuji via CCIP");

    res.json({ success: true, credentialHash, status: "relaying", txHash, ccipMessageId });
  } catch (err) {
    sendAdminError(res, err);
  }
});

async function sendVerification(res, credentialHash) {
  const onChain = await chain.verifyOnChain(credentialHash);
  const metadata = await Credential.findOne({ credentialHash });

  if (!onChain.found && metadata?.status === "relaying") {
    const relayed = await ProvenanceEvent.findOne({ credentialHash, eventType: "relayed" }).sort({ timestamp: -1 });
    return res.status(202).json({
      credentialHash,
      status: "relaying",
      ccipMessageId: relayed?.ccipMessageId ?? null,
      message: "Issued on Polygon Amoy and waiting for CCIP delivery to Avalanche Fuji. Try again in a few minutes.",
    });
  }

  let verification = onChain;
  if (metadata?.status === "revoked" && !onChain.revoked) {
    // The revocation has been sent but has not reached Fuji yet: never report the credential as valid.
    verification = onChain.found
      ? { ...onChain, isValid: false, revocationPending: true }
      : { found: false, isValid: false, revoked: false, revocationPending: true };
  } else if (!onChain.found) {
    return res.status(404).json({ error: "Credential not found on chain", credentialHash });
  }

  if (onChain.found && metadata?.status === "relaying") {
    metadata.status = "active";
    await metadata.save();
    await logEvent(credentialHash, "delivered", "avalanche-fuji", null, null, "Received on Avalanche Fuji");
  }

  await logEvent(credentialHash, "verified", "avalanche-fuji", null, null, "Verification requested");
  const provenance = await ProvenanceEvent.find({ credentialHash }).sort({ timestamp: 1, _id: 1 });

  res.json({ credentialHash, verification, metadata, provenance });
}

app.get("/verify/:hash", async (req, res) => {
  try {
    await sendVerification(res, normalizeHash(req.params.hash));
  } catch (err) {
    sendError(res, err);
  }
});

// Employers submit the credential details from the candidate's document; the server hashes them itself.
app.post("/verify", async (req, res) => {
  try {
    await sendVerification(res, hashCredential(parseCredential(req.body)));
  } catch (err) {
    sendError(res, err);
  }
});

app.post("/revoke/:hash", requireApiKey, async (req, res) => {
  try {
    const credentialHash = normalizeHash(req.params.hash);
    const cred = await Credential.findOne({ credentialHash });
    if (!cred) return res.status(404).json({ error: "Credential not found" });
    if (cred.status === "revoked") return res.status(409).json({ error: "Credential is already revoked" });
    if (cred.status === "pending") {
      return res.status(409).json({ error: "Credential was never relayed on-chain; retry /issue first" });
    }

    // Revoke on-chain first so a failed relay leaves the database untouched and the request can be retried.
    const { txHash, ccipMessageId } = await chain.revokeAndRelay(credentialHash);
    cred.status = "revoked";
    await cred.save();
    await logEvent(credentialHash, "revoked", "both", txHash, ccipMessageId, "Credential revoked");

    res.json({ success: true, credentialHash });
  } catch (err) {
    sendAdminError(res, err);
  }
});

// Malformed JSON bodies and other errors thrown by middleware.
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status === 500) {
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
  res.status(status).json({ error: err.message });
});

if (require.main === module) {
  const missing = ["MONGODB_URI", "ADMIN_API_KEY", ...chain.requiredEnv].filter((name) => !process.env[name]);
  if (missing.length) {
    console.error(`Missing required environment variables: ${missing.join(", ")} (see .env.example)`);
    process.exit(1);
  }

  try {
    chain.checkConfig();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const PORT = process.env.PORT || 3000;
  connectDB(process.env.MONGODB_URI)
    .then(() => app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`)))
    .catch((err) => {
      console.error("Failed to connect to MongoDB:", err.message);
      process.exit(1);
    });
}

module.exports = app;
