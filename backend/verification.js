const chain = require("./chain");
const { Credential, ProvenanceEvent } = require("./db");

async function logEvent(credentialHash, eventType, chainName, txHash, ccipMessageId, details) {
  await ProvenanceEvent.create({
    credentialHash, eventType, chain: chainName, txHash, ccipMessageId, details,
  });
}

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
