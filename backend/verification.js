// IN PLAIN ENGLISH: the core "is this degree genuine?" check, plus a helper for writing to the
// activity log. Both the verify page and the AI explanation use this same check.
const chain = require("./chain");
const { Credential, ProvenanceEvent } = require("./db");

// Adds one line to the activity log: which degree, what happened, on which blockchain, and receipts.
async function logEvent(credentialHash, eventType, chainName, txHash, ccipMessageId, details) {
  await ProvenanceEvent.create({
    credentialHash, eventType, chain: chainName, txHash, ccipMessageId, details,
  });
}

// Looks the degree up in two places: the verification blockchain (the trusted public record) and our
// database (the full details and status). Two special cases:
//   - If a university has revoked it but the news hasn't reached the blockchain yet, we already treat
//     it as NOT valid. When in doubt, we say no ("fail closed").
//   - If it was "on its way" and has now arrived on the blockchain, we mark it "active" and log that.
// Reads a credential from Avalanche Fuji and the database. A revocation still in transit makes it
// invalid (fail closed), and a relaying credential that has reached Fuji is promoted to active.
// Shared by /verify and /explain; logs no "verified" event itself.
async function checkCredential(credentialHash) {
  const onChain = await chain.verifyOnChain(credentialHash);
  const metadata = await Credential.findOne({ credentialHash });

  let verification = onChain;
  if (metadata?.status === "revoked" && !onChain.revoked) {
    verification = onChain.found
      ? { ...onChain, isValid: false, revocationPending: true }
      : { found: false, isValid: false, revoked: false, revocationPending: true };
  }

  if (onChain.found && metadata?.status === "relaying") {
    metadata.status = "active";
    await metadata.save();
    await logEvent(credentialHash, "delivered", "avalanche-fuji", null, null, "Received on Avalanche Fuji");
  }

  return { onChain, verification, metadata };
}

module.exports = { logEvent, checkCredential };
