// IN PLAIN ENGLISH: the "evidence collector". Before any verdict is reached, this gathers every fact we
// have about a degree into one bundle: what the blockchain says, what our database says, the activity
// log, and (on the real blockchains) the public announcements recorded on-chain.
//
// Collects everything the checks and the AI look at, as plain objects.
const chain = require("../chain");
const { Credential, ProvenanceEvent } = require("../db");
const { checkCredential } = require("../verification");

// Converts a database record into a simple, plain object.
const plain = (doc) => (doc ? doc.toObject() : null);

// Reads the public blockchain announcements about this degree. Only possible on the real blockchains
// and only if the degree is there. If the blockchains don't answer, we note that rather than failing.
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

// Builds the full evidence bundle.
async function gatherEvidence({ presentedHash, credential, claimedHash }) {
  const { verification, metadata } = await checkCredential(presentedHash);

  // Tamper detection: the certificate's details don't match any issued degree, but the file also states
  // a fingerprint. Look that one up too. If it IS a real degree, the details were edited afterwards.
  let claimedOnChain = null;
  let claimedRecord = null;
  if (claimedHash && claimedHash !== presentedHash && !verification.found) {
    claimedOnChain = await chain.verifyOnChain(claimedHash);
    claimedRecord = plain(await Credential.findOne({ credentialHash: claimedHash }));
  }

  // The degree's activity log, oldest first.
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
