// Collects everything the checks and the AI look at, as plain objects.
const chain = require("../chain");
const { Credential, ProvenanceEvent } = require("../db");
const { checkCredential } = require("../verification");

const plain = (doc) => (doc ? doc.toObject() : null);

async function onChainEvidence(credentialHash, verification, backendEvents) {
  if (chain.mode !== "ccip" || !verification.found) return null;
  const revokeEvent = backendEvents.filter((event) => event.eventType === "revoked").at(-1);
  try {
    return await chain.chainEvidence(credentialHash, {
      issuer: verification.issuer,
      receivedAt: verification.receivedAt,
      revoked: Boolean(verification.revoked),
      revokedAfter: revokeEvent ? new Date(revokeEvent.timestamp).getTime() : null,
    });
  } catch {
    return { unavailable: "Could not read the blockchain (Polygon Amoy or Avalanche Fuji did not respond)" };
  }
}

async function gatherEvidence({ presentedHash, credential, claimedHash }) {
  const { verification, metadata } = await checkCredential(presentedHash);

  let claimedOnChain = null;
  let claimedRecord = null;
  if (claimedHash && claimedHash !== presentedHash && !verification.found) {
    claimedOnChain = await chain.verifyOnChain(claimedHash);
    claimedRecord = plain(await Credential.findOne({ credentialHash: claimedHash }));
  }

  // "verified" events are left out: they say nothing about the credential and would defeat caching.
  const backendEvents = (
    await ProvenanceEvent.find({ credentialHash: presentedHash, eventType: { $ne: "verified" } }).sort({ timestamp: 1, _id: 1 })
  ).map(plain);

  return {
    mode: chain.mode,
    presented: { credential, hash: presentedHash },
    claimedHash,
    verification,
    record: plain(metadata),
    claimedRecord,
    claimedOnChain,
    backendEvents,
    chain: await onChainEvidence(presentedHash, verification, backendEvents),
  };
}

module.exports = { gatherEvidence };
