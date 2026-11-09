// IN PLAIN ENGLISH: this file describes what we store in our private database (MongoDB) — think of
// each "schema" below as the column headings of a spreadsheet. There are three "sheets":
//   1. Credentials: the full details of each degree, plus its fingerprint and current status.
//   2. Provenance events: the activity log (issued, sent, delivered, verified, revoked...).
//   3. Explanations: saved AI explanations, so we don't pay to generate the same one twice.
const mongoose = require("mongoose");

// SHEET 1: one row per degree.
const credentialSchema = new mongoose.Schema({
  credentialHash: { type: String, required: true, unique: true },
  studentName: String,
  studentId: String,
  degree: String,
  major: String,
  year: Number,
  courses: [String],
  issuer: String,
  // pending: saved, not yet on Amoy (re-issuing retries). relaying: on Amoy, CCIP message in transit.
  // active: delivered to Fuji. revoked: revocation sent.
  status: { type: String, enum: ["pending", "relaying", "active", "revoked"], default: "pending" },
  createdAt: { type: Date, default: Date.now },
});

// SHEET 2: one row per thing that happened to a degree — what, on which blockchain, the blockchain
// receipt numbers (if any), and when. This is the degree's "paper trail".
const provenanceEventSchema = new mongoose.Schema({
  credentialHash: { type: String, required: true, index: true },
  eventType: String,
  chain: String,
  txHash: String,
  ccipMessageId: String,
  details: String,
  timestamp: { type: Date, default: Date.now },
});

// SHEET 3:
// Saved AI explanations, keyed by a fingerprint of everything the AI was shown.
const explanationSchema = new mongoose.Schema({
  fingerprint: { type: String, required: true, unique: true },
  credentialHash: { type: String, index: true },
  explanation: { type: mongoose.Schema.Types.Mixed, required: true },
  model: String,
  createdAt: { type: Date, default: Date.now, index: true },
});

const Credential = mongoose.model("Credential", credentialSchema);
const ProvenanceEvent = mongoose.model("ProvenanceEvent", provenanceEventSchema);
const Explanation = mongoose.model("Explanation", explanationSchema);

// Opens the connection to the database when the server starts.
async function connectDB(uri) {
  await mongoose.connect(uri);
  console.log("Connected to MongoDB");
}

module.exports = { connectDB, Credential, ProvenanceEvent, Explanation };
