const mongoose = require("mongoose");

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

const provenanceEventSchema = new mongoose.Schema({
  credentialHash: { type: String, required: true, index: true },
  eventType: String,
  chain: String,
  txHash: String,
  ccipMessageId: String,
  details: String,
  timestamp: { type: Date, default: Date.now },
});

const Credential = mongoose.model("Credential", credentialSchema);
const ProvenanceEvent = mongoose.model("ProvenanceEvent", provenanceEventSchema);

async function connectDB(uri) {
  await mongoose.connect(uri);
  console.log("Connected to MongoDB");
}

module.exports = { connectDB, Credential, ProvenanceEvent };
