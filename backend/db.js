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
  // "pending" means saved locally but not yet relayed on-chain; re-issuing retries the relay.
  status: { type: String, enum: ["pending", "active", "revoked"], default: "pending" },
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
