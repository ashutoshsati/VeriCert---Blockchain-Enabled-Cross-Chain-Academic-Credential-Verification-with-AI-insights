const test = require("node:test");
const assert = require("node:assert");
const { evaluate } = require("../ai/checks");

const HASH = "0x" + "a".repeat(64);
const OTHER = "0x" + "f".repeat(64);
const MSG = "0x" + "b".repeat(64);
const WALLET = "0x" + "c".repeat(40);
const T0 = Date.parse("2026-09-24T10:00:00Z");
const NOW = T0 + 60 * 60 * 1000;
const MIN = 60 * 1000;

const RECORD = {
  studentName: "Jane Doe", studentId: "S1", degree: "Bachelor of Science", major: "Computer Science",
  year: 2024, courses: ["COMP6002"], issuer: "Example University", status: "active",
};

function events(...list) {
  return list.map(([eventType, minutes, ccipMessageId = null]) => ({
    eventType, chain: "polygon-amoy", timestamp: new Date(T0 + minutes * MIN), txHash: null, ccipMessageId,
  }));
}

// A healthy credential on the live testnets; tests override single parts.
function ccipEvidence(overrides = {}) {
  return {
    mode: "ccip",
    presented: { credential: null, hash: HASH },
    claimedHash: null,
    verification: { found: true, isValid: true, revoked: false, issuer: WALLET, issuedAt: T0, receivedAt: T0 + 5 * MIN },
    record: { ...RECORD },
    claimedRecord: null,
    claimedOnChain: null,
    backendEvents: events(["issued", 0], ["relayed", 0.1, MSG], ["delivered", 6]),
    chain: {
      amoy: { exists: true, issuer: WALLET, issuedAt: T0, revoked: false },
      issuerApproved: true,
      fujiEvents: [{ event: "CredentialReceived", blockNumber: 10, transactionHash: "0x" + "e".repeat(64), messageId: MSG, issuer: WALLET, issuedAt: T0 }],
    },
    ...overrides,
  };
}

const run = (evidence) => evaluate(evidence, NOW);
const byId = (result) => Object.fromEntries(result.checks.map((c) => [c.id, c]));

test("a healthy live credential passes every check", () => {
  const result = run(ccipEvidence());
  assert.strictEqual(result.verdict, "valid");
  assert.deepStrictEqual(result.checks.map((c) => c.id), [
    "on-fuji", "not-revoked", "chains-agree", "ccip-message-match", "issuer-approved",
    "db-matches-chain", "in-database", "delivery-time", "timeline-order", "file-hash",
  ]);
  for (const check of result.checks.filter((c) => c.id !== "file-hash")) {
    assert.strictEqual(check.status, "passed", `${check.id}: ${check.detail}`);
    assert.strictEqual(check.severity, null);
  }
  assert.strictEqual(byId(result)["file-hash"].status, "skipped");
  assert.deepStrictEqual(result.fieldChanges, []);
});

test("mock mode skips the on-chain comparisons", () => {
  const result = run(ccipEvidence({ mode: "mock", chain: null }));
  assert.strictEqual(result.verdict, "valid");
  for (const id of ["chains-agree", "ccip-message-match", "issuer-approved"]) {
    assert.strictEqual(byId(result)[id].status, "skipped");
    assert.strictEqual(byId(result)[id].detail, "Mock chain: no on-chain data to compare");
  }
});

test("an unreachable chain skips the on-chain comparisons with the reason", () => {
  const result = run(ccipEvidence({ chain: { unavailable: "Could not read the blockchain" } }));
  assert.strictEqual(byId(result)["chains-agree"].status, "skipped");
  assert.strictEqual(byId(result)["chains-agree"].detail, "Could not read the blockchain");
});

test("revoked on Fuji gives a revoked verdict", () => {
  const result = run(ccipEvidence({
    verification: { found: true, isValid: false, revoked: true, issuer: WALLET, issuedAt: T0, receivedAt: T0 + 5 * MIN },
    record: { ...RECORD, status: "revoked" },
    chain: { amoy: { exists: true, issuer: WALLET, issuedAt: T0, revoked: true }, issuerApproved: true, fujiEvents: [] },
  }));
  assert.strictEqual(result.verdict, "revoked");
  assert.strictEqual(byId(result)["not-revoked"].status, "failed");
  assert.strictEqual(byId(result)["not-revoked"].severity, "critical");
  assert.strictEqual(byId(result)["chains-agree"].status, "passed");
});

test("a revocation still in transit is revoked, and the chains still agree", () => {
  const result = run(ccipEvidence({
    verification: { found: true, isValid: false, revoked: false, revocationPending: true, issuer: WALLET, issuedAt: T0, receivedAt: T0 + 5 * MIN },
    record: { ...RECORD, status: "revoked" },
    chain: { amoy: { exists: true, issuer: WALLET, issuedAt: T0, revoked: true }, issuerApproved: true, fujiEvents: [] },
  }));
  assert.strictEqual(result.verdict, "revoked");
  assert.match(byId(result)["not-revoked"].detail, /still being delivered/);
  assert.strictEqual(byId(result)["chains-agree"].status, "passed");
  assert.match(byId(result)["chains-agree"].detail, /on its way/);
});

test("revoked before it was ever delivered is revoked, not not_found", () => {
  const result = run(ccipEvidence({
    verification: { found: false, isValid: false, revoked: false, revocationPending: true },
    record: { ...RECORD, status: "revoked" },
    chain: null,
  }));
  assert.strictEqual(result.verdict, "revoked");
});

test("Amoy and Fuji disagreeing on the issuer is critical", () => {
  const evidence = ccipEvidence();
  evidence.chain.amoy.issuer = "0x" + "9".repeat(40);
  const check = byId(run(evidence))["chains-agree"];
  assert.strictEqual(check.status, "failed");
  assert.strictEqual(check.severity, "critical");
});

test("a CCIP message ID mismatch is critical", () => {
  const evidence = ccipEvidence();
  evidence.chain.fujiEvents[0].messageId = "0x" + "d".repeat(64);
  const check = byId(run(evidence))["ccip-message-match"];
  assert.strictEqual(check.status, "failed");
  assert.strictEqual(check.severity, "critical");
});

test("an issuer that is no longer approved is a warning, and the verdict stays valid", () => {
  const result = run(ccipEvidence({ chain: { ...ccipEvidence().chain, issuerApproved: false } }));
  assert.strictEqual(result.verdict, "valid");
  assert.strictEqual(byId(result)["issuer-approved"].status, "failed");
  assert.strictEqual(byId(result)["issuer-approved"].severity, "warning");
});

test("the database saying active while Fuji says revoked is critical", () => {
  const result = run(ccipEvidence({
    verification: { found: true, isValid: false, revoked: true, issuer: WALLET, issuedAt: T0, receivedAt: T0 + 5 * MIN },
    chain: { amoy: { exists: true, issuer: WALLET, issuedAt: T0, revoked: true }, issuerApproved: true, fujiEvents: [] },
  }));
  assert.strictEqual(result.verdict, "revoked");
  assert.strictEqual(byId(result)["db-matches-chain"].status, "failed");
  assert.strictEqual(byId(result)["db-matches-chain"].severity, "critical");
});

test("on chain but missing from the database is a warning", () => {
  const result = run(ccipEvidence({ record: null, backendEvents: [] }));
  assert.strictEqual(byId(result)["in-database"].status, "failed");
  assert.strictEqual(byId(result)["in-database"].severity, "warning");
  assert.strictEqual(byId(result)["db-matches-chain"].status, "skipped");
});

test("slow delivery and a long wait in transit are warnings", () => {
  const slow = ccipEvidence();
  slow.verification.receivedAt = T0 + 45 * MIN;
  assert.strictEqual(byId(run(slow))["delivery-time"].severity, "warning");

  const waiting = run(ccipEvidence({
    verification: { found: false, isValid: false },
    record: { ...RECORD, status: "relaying" },
    backendEvents: events(["issued", 0], ["relayed", 0.1, MSG]),
    chain: null,
  }));
  assert.strictEqual(waiting.verdict, "relaying");
  assert.strictEqual(byId(waiting)["delivery-time"].status, "failed");
  assert.match(byId(waiting)["delivery-time"].detail, /60 min/);
});

test("events out of order are critical", () => {
  const result = run(ccipEvidence({ backendEvents: events(["issued", 0], ["relayed", 10, MSG], ["delivered", 5]) }));
  assert.strictEqual(byId(result)["timeline-order"].status, "failed");
  assert.strictEqual(byId(result)["timeline-order"].severity, "critical");
});

test("an edited credential file is tampered, with the changed fields listed", () => {
  const presented = { ...RECORD, studentName: "JANE doe", major: "Medicine" }; // case-only differences must not count
  delete presented.status;
  const result = run(ccipEvidence({
    presented: { credential: presented, hash: OTHER },
    claimedHash: HASH,
    verification: { found: false, isValid: false },
    record: null,
    claimedRecord: { ...RECORD },
    claimedOnChain: { found: true, isValid: true },
    backendEvents: [],
    chain: null,
  }));
  assert.strictEqual(result.verdict, "tampered");
  assert.deepStrictEqual(result.fieldChanges, [
    { field: "major", label: "Major", presented: "Medicine", official: "Computer Science" },
  ]);
  assert.strictEqual(byId(result)["file-hash"].status, "failed");
  assert.match(byId(result)["file-hash"].detail, /genuine/);
});

test("unknown details are not_found, with or without a bogus claimed hash", () => {
  const base = { presented: { credential: null, hash: OTHER }, verification: { found: false, isValid: false }, record: null, backendEvents: [], chain: null };
  assert.strictEqual(run(ccipEvidence(base)).verdict, "not_found");

  const bogus = run(ccipEvidence({ ...base, claimedHash: HASH, claimedOnChain: { found: false, isValid: false } }));
  assert.strictEqual(bogus.verdict, "not_found");
  assert.strictEqual(byId(bogus)["file-hash"].status, "failed");
  assert.deepStrictEqual(bogus.fieldChanges, []);
});

test("a file whose hash matches its details passes the file check", () => {
  const result = run(ccipEvidence({ claimedHash: HASH }));
  assert.strictEqual(byId(result)["file-hash"].status, "passed");
});
