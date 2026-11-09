// =====================================================================================================
// IN PLAIN ENGLISH
// -----------------------------------------------------------------------------------------------------
// This is the backend: the "front desk" that the website talks to. It receives requests over the
// internet and answers them. The main requests ("routes") are:
//
//   POST /issue        A university issues a new degree (admin key required).
//   POST /revoke/:hash A university cancels a degree (admin key required).
//   POST /verify       An employer checks a degree by typing in its details (public).
//   GET  /verify/:hash An employer checks a degree by its fingerprint code (public).
//   POST /explain      Get the verdict plus a plain-language AI explanation of it (public).
//   GET  /credentials  List recently issued degrees (admin key required).
//   GET  /events       The activity log of everything that has happened (admin key required).
//   GET  /health       "Are you running?" plus whether we're using real blockchains or a simulation.
//
// The backend keeps full degree details in a private database (MongoDB) and puts only each degree's
// fingerprint (hash) on the blockchain, so personal data is never made public.
// =====================================================================================================

// Load settings (passwords, addresses, etc.) from a private .env file, and pull in the tools we use.
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { connectDB, Credential, ProvenanceEvent } = require("./db");
const chain = require("./chain");
const { ValidationError, parseCredential, assertYearIssuable, hashCredential, normalizeHash } = require("./credential");
const { logEvent, checkCredential } = require("./verification");
const { parseExplainRequest, runExplain } = require("./ai");

// Create the web server. It accepts requests from the website (cors) and reads data sent as JSON.
const app = express();
app.use(cors());
app.use(express.json());

// Turns any text into a fixed-length fingerprint (used below to compare passwords safely).
function sha256(value) {
  return crypto.createHash("sha256").update(value).digest();
}

// THE BOUNCER for admin-only requests: lets the request through only if it carries the correct admin
// key. The comparison is done in a way that doesn't leak hints to someone guessing the key.
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

// Turns a problem into a sensible reply: "you sent bad data" (400), "that already exists" (409), or a
// generic "something went wrong" (500). Public users never see internal error details.
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

// Same as above, but admins (who hold the key) get the detailed reason so they can fix the problem.
function sendAdminError(res, err) {
  sendError(res, err, { exposeMessage: true });
}

// ISSUE A DEGREE (admin only).
// 1. Check the degree details are complete, the year isn't in the future, and calculate its fingerprint.
// 2. Refuse if this degree was already issued; otherwise save it in the database as "pending".
// 3. Record the fingerprint on the blockchain and send it across to the verification blockchain.
// 4. Mark it "relaying" (on its way; delivery takes a few minutes) and note it in the activity log.
app.post("/issue", requireApiKey, async (req, res) => {
  try {
    const credential = parseCredential(req.body);
    assertYearIssuable(credential);
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

// Shared by both "verify" routes: look the degree up on the verification blockchain and in the
// database, then reply with one of:
//   - "still on its way" (issued, but the cross-chain message hasn't arrived yet),
//   - "not found" (no such degree was ever issued), or
//   - the full result: valid or not, the degree's details, and its complete history.
async function sendVerification(res, credentialHash) {
  const { onChain, verification, metadata } = await checkCredential(credentialHash);

  if (!onChain.found && metadata?.status === "relaying") {
    const relayed = await ProvenanceEvent.findOne({ credentialHash, eventType: "relayed" }).sort({ timestamp: -1 });
    return res.status(202).json({
      credentialHash,
      status: "relaying",
      ccipMessageId: relayed?.ccipMessageId ?? null,
      message: "Issued on Polygon Amoy and waiting for CCIP delivery to Avalanche Fuji. Try again in a few minutes.",
    });
  }

  // A revocation still in transit is reported (as invalid) even though Fuji has no record yet.
  if (!onChain.found && metadata?.status !== "revoked") {
    return res.status(404).json({ error: "Credential not found on chain", credentialHash });
  }

  await logEvent(credentialHash, "verified", "avalanche-fuji", null, null, "Verification requested");
  const provenance = await ProvenanceEvent.find({ credentialHash }).sort({ timestamp: 1, _id: 1 });

  res.json({ credentialHash, verification, metadata, provenance });
}

// VERIFY BY FINGERPRINT (public): the employer already has the degree's hash code.
app.get("/verify/:hash", async (req, res) => {
  try {
    await sendVerification(res, normalizeHash(req.params.hash));
  } catch (err) {
    sendError(res, err);
  }
});

// VERIFY BY DETAILS (public): the employer types in what the candidate's certificate says. We calculate
// the fingerprint ourselves, so if any detail has been altered, it won't match the official record.
// Employers submit the credential details from the candidate's document; the server hashes them itself.
app.post("/verify", async (req, res) => {
  try {
    await sendVerification(res, hashCredential(parseCredential(req.body)));
  } catch (err) {
    sendError(res, err);
  }
});

// EXPLAIN A RESULT (public): returns the verdict decided by fixed rules in our code, and (if asked) a
// plain-language explanation written by AI. The AI never decides whether a degree is valid.
// The verdict and code checks for a credential, plus an AI explanation when "ai" is true. Public like /verify.
app.post("/explain", async (req, res) => {
  try {
    res.json(await runExplain(parseExplainRequest(req.body), { ip: req.ip }));
  } catch (err) {
    sendError(res, err);
  }
});

// REVOKE A DEGREE (admin only).
// Refuses if the degree doesn't exist, is already revoked, or never made it onto the blockchain.
// Otherwise records the cancellation on the blockchain first, then updates the database and the log.
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

// HEALTH CHECK: "is the server up?" plus whether we're using the real blockchains or the simulation.
// Lets the frontend show which chain it is talking to; mock-mode transaction hashes are not real.
app.get("/health", (req, res) => {
  res.json({ status: "ok", chainMode: chain.mode });
});

// Reads "how many items to show" from a request: 50 by default, and only 1 to 200 allowed.
function parseLimit(value) {
  if (value === undefined) return 50;
  const limit = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!(limit >= 1 && limit <= 200)) throw new ValidationError("limit must be a whole number from 1 to 200");
  return limit;
}

// Admin dashboard: the most recently issued credentials with their current status.
app.get("/credentials", requireApiKey, async (req, res) => {
  try {
    const limit = parseLimit(req.query.limit);
    const credentials = await Credential.find().sort({ createdAt: -1, _id: -1 }).limit(limit);
    res.json({ credentials });
  } catch (err) {
    sendAdminError(res, err);
  }
});

// Admin activity log: provenance events newest first, optionally for a single credential.
app.get("/events", requireApiKey, async (req, res) => {
  try {
    const limit = parseLimit(req.query.limit);
    const filter = req.query.hash === undefined ? {} : { credentialHash: normalizeHash(req.query.hash) };
    const events = await ProvenanceEvent.find(filter).sort({ timestamp: -1, _id: -1 }).limit(limit);
    res.json({ events });
  } catch (err) {
    sendAdminError(res, err);
  }
});

// SAFETY NET: catches any error not handled above (e.g. garbled data) and replies politely.
// Malformed JSON bodies and other errors thrown by middleware.
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status === 500) {
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
  res.status(status).json({ error: err.message });
});

// STARTING THE SERVER (only when this file is run directly, not during automated tests):
// check every required setting is present, check the blockchain settings make sense, connect to the
// database, then start listening for requests.
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
