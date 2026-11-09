// =====================================================================================================
// IN PLAIN ENGLISH
// -----------------------------------------------------------------------------------------------------
// This is the "inspector's checklist". Given all the evidence about a degree, it:
//   1. decides the VERDICT: valid, revoked, tampered (details were altered), relaying (still on its
//      way between blockchains) or not_found, and
//   2. runs ten individual CHECKS, each marked passed, failed or skipped, with a one-line reason.
//      A failed check is either "critical" (a real problem) or a "warning" (worth a look).
// These are fixed rules written in code, so they always give the same answer for the same evidence
// and can be tested. The AI never makes these decisions; it only puts them into plain words.
// =====================================================================================================
// The code checks behind every /explain answer. Pure functions: the verdict and each check come from
// here, never from the AI, so they can be tested and trusted on their own.
const { canonicalCredential } = require("../credential");

// Anything taking longer than 30 minutes to travel between blockchains is flagged as unusual.
const DELIVERY_LIMIT_MS = 30 * 60 * 1000;
const MOCK_SKIP = "Mock chain: no on-chain data to compare";
const FIELD_LABELS = {
  studentName: "Student name",
  studentId: "Student ID",
  degree: "Degree",
  major: "Major",
  year: "Year",
  courses: "Courses",
  issuer: "Issuing university",
};

// Small helpers: shorten long codes for display, compare wallet addresses, format times and lists, and
// build a "passed" / "failed" / "skipped" result.
const short = (value) => (value && value.length > 20 ? `${value.slice(0, 10)}…${value.slice(-6)}` : String(value));
const time = (value) => new Date(value).getTime();
const sameAddress = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const display = (value) => (Array.isArray(value) ? value.join(", ") : String(value));

function minutes(ms) {
  const value = ms / 60000;
  return value < 1 ? "under a minute" : `${Math.round(value)} min`;
}

const passed = (id, label, detail) => ({ id, label, status: "passed", severity: null, detail });
const failed = (id, label, severity, detail) => ({ id, label, status: "failed", severity, detail });
const skipped = (id, label, detail) => ({ id, label, status: "skipped", severity: null, detail });

// Has the degree been revoked (anywhere)? What was the latest log entry of a given kind? Did Fuji
// announce a given event?
const isRevoked = (e) => Boolean(e.verification.revoked || e.verification.revocationPending || e.record?.status === "revoked");
const lastEvent = (e, type) => e.backendEvents.filter((event) => event.eventType === type).at(-1) ?? null;
const fujiEvent = (e, name) => e.chain?.fujiEvents?.find((event) => event.event === name) ?? null;

// Why a ccip-only check cannot run, or null when it can.
function chainSkipReason(e) {
  if (e.mode !== "ccip") return MOCK_SKIP;
  if (!e.verification.found) return "Nothing on Avalanche Fuji to compare";
  if (e.chain?.unavailable) return e.chain.unavailable;
  if (!e.chain) return "No on-chain data was collected";
  return null;
}

// THE VERDICT, decided in this order of priority:
//   tampered  - the certificate claims to be a genuine degree, but its details have been changed;
//   relaying  - issued, still travelling to the verification blockchain;
//   revoked   - the university cancelled it;
//   not_found - no such degree was ever issued;
//   valid     - otherwise: it exists and has not been revoked.
function decideVerdict(e) {
  const found = e.verification.found === true;
  if (!found && e.claimedHash && e.claimedHash !== e.presented.hash && e.claimedOnChain?.found) return "tampered";
  if (!found && e.record?.status === "relaying") return "relaying";
  if (isRevoked(e)) return "revoked";
  if (!found) return "not_found";
  return "valid";
}

// CHECK 1: Is the degree on the verification blockchain (Avalanche Fuji)?
function onFuji(e) {
  const label = "Recorded on Avalanche Fuji";
  if (e.verification.found) return passed("on-fuji", label, "Avalanche Fuji holds a credential with this hash");
  if (e.record?.status === "relaying") {
    return failed("on-fuji", label, "warning", "Not on Avalanche Fuji yet: Chainlink CCIP is still delivering it");
  }
  return failed("on-fuji", label, "critical", "Avalanche Fuji has no credential with this hash");
}

// CHECK 2: Has the degree been revoked (including a revocation that is still on its way)?
function notRevoked(e) {
  const label = "Not revoked";
  if (isRevoked(e)) {
    const detail = e.verification.revoked
      ? "Avalanche Fuji marks this credential as revoked"
      : "The university revoked it; the revocation is still being delivered to Avalanche Fuji";
    return failed("not-revoked", label, "critical", detail);
  }
  if (!e.verification.found) return skipped("not-revoked", label, "Nothing on Avalanche Fuji to check");
  return passed("not-revoked", label, "Neither Avalanche Fuji nor the VeriCert database marks it as revoked");
}

// CHECK 3: Do the issuing blockchain (Amoy) and the verification blockchain (Fuji) tell the same story
// about who issued it and whether it's revoked?
function chainsAgree(e) {
  const label = "Amoy and Fuji agree";
  const reason = chainSkipReason(e);
  if (reason) return skipped("chains-agree", label, reason);
  const { amoy } = e.chain;
  if (!amoy.exists) return failed("chains-agree", label, "critical", "Avalanche Fuji has the credential but Polygon Amoy does not");
  if (!sameAddress(amoy.issuer, e.verification.issuer)) {
    return failed("chains-agree", label, "critical", `Issuer differs: ${short(amoy.issuer)} on Amoy, ${short(e.verification.issuer)} on Fuji`);
  }
  if (amoy.revoked && !e.verification.revoked) {
    return passed("chains-agree", label, "Revoked on Polygon Amoy; the revocation is on its way to Avalanche Fuji");
  }
  if (!amoy.revoked && e.verification.revoked) {
    return failed("chains-agree", label, "critical", "Avalanche Fuji says revoked but Polygon Amoy does not");
  }
  return passed("chains-agree", label, "Polygon Amoy and Avalanche Fuji agree on the issuer and revocation status");
}

// CHECK 4: Is the message Fuji received the very same message the university sent? (Compares the
// Chainlink tracking numbers on both ends.)
function ccipMessageMatch(e) {
  const label = "CCIP message matches";
  const reason = chainSkipReason(e);
  if (reason) return skipped("ccip-message-match", label, reason);
  const received = fujiEvent(e, "CredentialReceived");
  const relayed = lastEvent(e, "relayed");
  if (!received) return skipped("ccip-message-match", label, "Could not find the CredentialReceived event on Avalanche Fuji");
  if (!relayed?.ccipMessageId) return skipped("ccip-message-match", label, "The VeriCert database has no record of sending this credential");
  if (!sameAddress(relayed.ccipMessageId, received.messageId)) {
    return failed("ccip-message-match", label, "critical", `Sent message ${short(relayed.ccipMessageId)} but Fuji received ${short(received.messageId)}`);
  }
  const revokedOnFuji = fujiEvent(e, "CredentialRevoked");
  const revokedSent = lastEvent(e, "revoked");
  if (revokedOnFuji && revokedSent?.ccipMessageId && !sameAddress(revokedOnFuji.messageId, revokedSent.ccipMessageId)) {
    return failed("ccip-message-match", label, "critical", `Revocation sent as ${short(revokedSent.ccipMessageId)} but Fuji received ${short(revokedOnFuji.messageId)}`);
  }
  return passed("ccip-message-match", label, `Avalanche Fuji received the same CCIP message the university sent (${short(received.messageId)})`);
}

// CHECK 5: Is the university wallet that issued it still on the approved list?
function issuerApproved(e) {
  const label = "Issuer still approved";
  const reason = chainSkipReason(e);
  if (reason) return skipped("issuer-approved", label, reason);
  if (e.chain.issuerApproved === null || e.chain.issuerApproved === undefined) {
    return skipped("issuer-approved", label, "The issuing wallet is unknown");
  }
  const wallet = short(e.verification.issuer);
  return e.chain.issuerApproved
    ? passed("issuer-approved", label, `The issuing wallet ${wallet} is still an approved VeriCert issuer`)
    : failed("issuer-approved", label, "warning", `The issuing wallet ${wallet} is no longer an approved VeriCert issuer`);
}

// CHECK 6: Does our database's status for the degree agree with what the blockchain says?
function dbMatchesChain(e) {
  const label = "Database matches the chain";
  if (!e.record) return skipped("db-matches-chain", label, "No VeriCert database record to compare");
  const v = e.verification;
  const status = e.record.status;
  const consistent = {
    active: v.found && !v.revoked,
    relaying: !v.found,
    pending: !v.found,
    revoked: Boolean(v.revoked || v.revocationPending),
  }[status];
  if (consistent) return passed("db-matches-chain", label, `The database status ("${status}") matches the chain`);
  const chainState = !v.found ? "has no record" : v.revoked ? "says revoked" : "says active";
  return failed("db-matches-chain", label, "critical", `The database says "${status}" but Avalanche Fuji ${chainState}`);
}

// CHECK 7: Do we hold the degree's full details in our database?
function inDatabase(e) {
  const label = "In the VeriCert database";
  if (!e.verification.found) return skipped("in-database", label, "Nothing on chain to look up");
  return e.record
    ? passed("in-database", label, "The VeriCert database has the details for this credential")
    : failed("in-database", label, "warning", "On Avalanche Fuji, but the VeriCert database has no details for it (issued elsewhere, or data was lost)");
}

// CHECK 8: Did the degree reach Fuji within 30 minutes (or, if still travelling, has it been under 30
// minutes so far)?
function deliveryTime(e, now) {
  const label = "Delivered promptly";
  const v = e.verification;
  if (v.found && v.issuedAt && v.receivedAt) {
    const took = v.receivedAt - v.issuedAt;
    return took <= DELIVERY_LIMIT_MS
      ? passed("delivery-time", label, `Delivered to Avalanche Fuji in ${minutes(took)}`)
      : failed("delivery-time", label, "warning", `Took ${minutes(took)} to reach Avalanche Fuji, longer than usual`);
  }
  const relayed = lastEvent(e, "relayed");
  if (!v.found && e.record?.status === "relaying" && relayed) {
    const waited = now - time(relayed.timestamp);
    return waited <= DELIVERY_LIMIT_MS
      ? passed("delivery-time", label, `In transit for ${minutes(waited)}, which is normal`)
      : failed("delivery-time", label, "warning", `In transit for ${minutes(waited)}, longer than usual`);
  }
  return skipped("delivery-time", label, "No delivery to time");
}

// CHECK 9: Did things happen in a sensible order (issued, then sent, then delivered)? Out-of-order
// history could mean the records were interfered with.
function timelineOrder(e) {
  const label = "Timeline in order";
  const v = e.verification;
  if (!e.backendEvents.length && !v.found) return skipped("timeline-order", label, "No history to check");
  const first = (type) => {
    const event = e.backendEvents.find((item) => item.eventType === type);
    return event ? time(event.timestamp) : null;
  };
  const problems = [];
  for (const [before, after] of [["issued", "relayed"], ["relayed", "delivered"], ["issued", "revoked"]]) {
    const a = first(before);
    const b = first(after);
    if (a !== null && b !== null && b < a) problems.push(`"${after}" is recorded before "${before}"`);
  }
  if (v.found && v.issuedAt && v.receivedAt && v.receivedAt < v.issuedAt) {
    problems.push("Avalanche Fuji received it before Polygon Amoy issued it");
  }
  return problems.length
    ? failed("timeline-order", label, "critical", `Out of order: ${problems.join("; ")}`)
    : passed("timeline-order", label, "Issue, relay and delivery happened in the expected order");
}

// CHECK 10: If a certificate file was uploaded, do its details still produce the fingerprint written
// inside it? If not, someone has edited the details.
function fileHash(e) {
  const label = "File matches its details";
  if (!e.claimedHash) return skipped("file-hash", label, "No credential file was uploaded");
  if (e.claimedHash === e.presented.hash) return passed("file-hash", label, "The hash written in the file matches the details in it");
  if (e.claimedOnChain?.found) {
    return failed("file-hash", label, "critical",
      `The file claims credential ${short(e.claimedHash)}, which is genuine, but its details now produce ${short(e.presented.hash)}`);
  }
  return failed("file-hash", label, "critical",
    `The file's details don't produce the hash written in it (${short(e.claimedHash)}), and that hash isn't on Avalanche Fuji either`);
}

// For a tampered certificate: list exactly which details were changed, showing what the certificate
// says next to what the university officially issued (e.g. Year: 2024 vs 2021).
function fieldChanges(e, verdict) {
  if (verdict !== "tampered" || !e.presented.credential || !e.claimedRecord) return [];
  const presented = canonicalCredential(e.presented.credential);
  const official = canonicalCredential(e.claimedRecord);
  return Object.keys(FIELD_LABELS)
    .filter((field) => JSON.stringify(presented[field]) !== JSON.stringify(official[field]))
    .map((field) => ({
      field,
      label: FIELD_LABELS[field],
      presented: display(e.presented.credential[field]),
      official: display(e.claimedRecord[field]),
    }));
}

// THE MAIN ENTRY POINT: decide the verdict, run all ten checks, and list any altered details.
function evaluate(evidence, now = Date.now()) {
  const verdict = decideVerdict(evidence);
  const checks = [
    onFuji(evidence),
    notRevoked(evidence),
    chainsAgree(evidence),
    ccipMessageMatch(evidence),
    issuerApproved(evidence),
    dbMatchesChain(evidence),
    inDatabase(evidence),
    deliveryTime(evidence, now),
    timelineOrder(evidence),
    fileHash(evidence),
  ];
  return { verdict, checks, fieldChanges: fieldChanges(evidence, verdict) };
}

module.exports = { evaluate };
