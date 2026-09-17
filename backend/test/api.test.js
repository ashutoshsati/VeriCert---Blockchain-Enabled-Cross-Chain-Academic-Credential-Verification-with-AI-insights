const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { once } = require("events");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vericert-"));
process.env.MOCK_CHAIN_FILE = path.join(tempDir, "mock-chain.json");
process.env.ADMIN_API_KEY = "test-key";
// dotenv never overrides variables that are already set, so a developer's CHAIN_MODE=ccip in .env cannot leak in.
process.env.CHAIN_MODE = "mock";

const app = require("../server");
const chain = require("../chain");
const { connectDB, Credential, ProvenanceEvent } = require("../db");

let mongo, server, baseUrl;

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  await connectDB(mongo.getUri());
  server = app.listen(0);
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  await mongoose.disconnect();
  await mongo.stop();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function call(method, route, { body, apiKey } = {}) {
  const headers = { "content-type": "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey;
  const res = await fetch(baseUrl + route, { method, headers, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

function credential(studentId, extra = {}) {
  return {
    studentName: "Jane Doe",
    studentId,
    degree: "Bachelor of Science",
    major: "Computer Science",
    year: 2024,
    courses: ["COMP6002", "COMP5001"],
    issuer: "Example University",
    ...extra,
  };
}

const ADMIN = { apiKey: "test-key" };

// Temporarily replaces a chain function for one test.
async function withChain(overrides, fn) {
  const originals = {};
  for (const [name, impl] of Object.entries(overrides)) {
    originals[name] = chain[name];
    chain[name] = impl;
  }
  try {
    return await fn();
  } finally {
    Object.assign(chain, originals);
  }
}

const fakeRelay = async () => ({ txHash: "0x" + "1".repeat(64), ccipMessageId: "0x" + "2".repeat(64) });

test("issue and revoke require a valid API key", async () => {
  assert.strictEqual((await call("POST", "/issue", { body: credential("AUTH1") })).status, 401);
  assert.strictEqual((await call("POST", "/issue", { body: credential("AUTH1"), apiKey: "wrong" })).status, 401);
  assert.strictEqual((await call("POST", "/revoke/0x" + "a".repeat(64))).status, 401);
  assert.strictEqual(await Credential.countDocuments({ studentId: "AUTH1" }), 0);
});

test("invalid input is rejected with 400", async () => {
  const bad = await call("POST", "/issue", { body: credential("BAD1", { year: "soon" }), ...ADMIN });
  assert.strictEqual(bad.status, 400);
  assert.match(bad.body.error, /year/);
  assert.strictEqual((await call("GET", "/verify/not-a-hash")).status, 400);
  assert.strictEqual((await call("POST", "/verify", { body: { studentName: "x" } })).status, 400);
});

test("issued credential verifies by hash (any case) and by document data", async () => {
  const issued = await call("POST", "/issue", { body: credential("V1"), ...ADMIN });
  assert.strictEqual(issued.status, 200);
  assert.strictEqual(issued.body.status, "relaying");
  const hash = issued.body.credentialHash;

  const byHash = await call("GET", "/verify/0x" + hash.slice(2).toUpperCase());
  assert.strictEqual(byHash.status, 200);
  assert.strictEqual(byHash.body.verification.isValid, true);
  assert.strictEqual(byHash.body.metadata.status, "active");
  assert.deepStrictEqual(
    byHash.body.provenance.map((e) => e.eventType),
    ["issued", "relayed", "delivered", "verified"]
  );

  const messy = credential("V1", { studentName: " jane  doe", year: "2024", courses: ["COMP5001", "COMP6002"] });
  const byDocument = await call("POST", "/verify", { body: messy });
  assert.strictEqual(byDocument.status, 200);
  assert.strictEqual(byDocument.body.credentialHash, hash);
  assert.strictEqual(await ProvenanceEvent.countDocuments({ credentialHash: hash, eventType: "delivered" }), 1);

  const tampered = await call("POST", "/verify", { body: credential("V1", { major: "Medicine" }) });
  assert.strictEqual(tampered.status, 404);
});

test("issuing the same credential twice returns 409", async () => {
  assert.strictEqual((await call("POST", "/issue", { body: credential("DUP1"), ...ADMIN })).status, 200);
  assert.strictEqual((await call("POST", "/issue", { body: credential("DUP1"), ...ADMIN })).status, 409);
});

test("client cannot set status or other internal fields", async () => {
  const issued = await call("POST", "/issue", { body: credential("MASS1", { status: "revoked" }), ...ADMIN });
  assert.strictEqual(issued.status, 200);
  const record = await Credential.findOne({ credentialHash: issued.body.credentialHash });
  assert.strictEqual(record.status, "relaying");
});

test("a failed relay leaves the credential pending and can be retried", async () => {
  const original = chain.issueAndRelay;
  chain.issueAndRelay = async () => { throw new Error("CCIP unavailable"); };
  let failed;
  try {
    failed = await call("POST", "/issue", { body: credential("RETRY1"), ...ADMIN });
  } finally {
    chain.issueAndRelay = original;
  }
  assert.strictEqual(failed.status, 500);
  const pending = await Credential.findOne({ studentId: "RETRY1" });
  assert.strictEqual(pending.status, "pending");

  const retried = await call("POST", "/issue", { body: credential("RETRY1"), ...ADMIN });
  assert.strictEqual(retried.status, 200);
  const hash = retried.body.credentialHash;
  assert.strictEqual((await Credential.findOne({ credentialHash: hash })).status, "relaying");
  assert.strictEqual(await ProvenanceEvent.countDocuments({ credentialHash: hash, eventType: "issued" }), 1);
  assert.strictEqual((await call("GET", `/verify/${hash}`)).status, 200);
});

test("mock chain state survives a restart", async () => {
  const issued = await call("POST", "/issue", { body: credential("PERSIST1"), ...ADMIN });
  const hash = issued.body.credentialHash;

  delete require.cache[require.resolve("../chain/mock")];
  const reloadedChain = require("../chain/mock");
  const record = await reloadedChain.verifyOnChain(hash);
  assert.strictEqual(record.found, true);
  assert.strictEqual(record.isValid, true);
});

test("revoked credential verifies as invalid and cannot be revoked twice", async () => {
  const hash = (await call("POST", "/issue", { body: credential("REV1"), ...ADMIN })).body.credentialHash;

  assert.strictEqual((await call("POST", `/revoke/${hash}`, ADMIN)).status, 200);
  const verified = await call("GET", `/verify/${hash}`);
  assert.strictEqual(verified.status, 200);
  assert.strictEqual(verified.body.verification.isValid, false);
  assert.strictEqual(verified.body.metadata.status, "revoked");

  assert.strictEqual((await call("POST", `/revoke/${hash}`, ADMIN)).status, 409);
});

test("verify returns 202 while the CCIP message is still in transit", async () => {
  const issued = await withChain({ issueAndRelay: fakeRelay }, () =>
    call("POST", "/issue", { body: credential("TRANSIT1"), ...ADMIN })
  );
  assert.strictEqual(issued.status, 200);

  const verified = await call("GET", `/verify/${issued.body.credentialHash}`);
  assert.strictEqual(verified.status, 202);
  assert.strictEqual(verified.body.status, "relaying");
  assert.strictEqual(verified.body.ccipMessageId, "0x" + "2".repeat(64));
  assert.strictEqual((await Credential.findOne({ studentId: "TRANSIT1" })).status, "relaying");
});

test("a revoke still in transit makes verification fail closed", async () => {
  const hash = (await call("POST", "/issue", { body: credential("REVPEND1"), ...ADMIN })).body.credentialHash;
  assert.strictEqual((await call("GET", `/verify/${hash}`)).body.verification.isValid, true);

  const revoked = await withChain({ revokeAndRelay: fakeRelay }, () => call("POST", `/revoke/${hash}`, ADMIN));
  assert.strictEqual(revoked.status, 200);

  const verified = await call("GET", `/verify/${hash}`);
  assert.strictEqual(verified.status, 200);
  assert.strictEqual(verified.body.verification.isValid, false);
  assert.strictEqual(verified.body.verification.revocationPending, true);
});

test("a credential revoked before its issue was delivered verifies as invalid", async () => {
  const issued = await withChain({ issueAndRelay: fakeRelay }, () =>
    call("POST", "/issue", { body: credential("REVEARLY1"), ...ADMIN })
  );
  const hash = issued.body.credentialHash;

  const revoked = await withChain({ revokeAndRelay: fakeRelay }, () => call("POST", `/revoke/${hash}`, ADMIN));
  assert.strictEqual(revoked.status, 200);

  const verified = await call("GET", `/verify/${hash}`);
  assert.strictEqual(verified.status, 200);
  assert.strictEqual(verified.body.verification.found, false);
  assert.strictEqual(verified.body.verification.isValid, false);
  assert.strictEqual(verified.body.verification.revocationPending, true);
});

test("a pending credential cannot be revoked", async () => {
  const failed = await withChain({ issueAndRelay: async () => { throw new Error("CCIP unavailable"); } }, () =>
    call("POST", "/issue", { body: credential("REVPENDING1"), ...ADMIN })
  );
  assert.strictEqual(failed.status, 500);
  const hash = (await Credential.findOne({ studentId: "REVPENDING1" })).credentialHash;

  const revoked = await call("POST", `/revoke/${hash}`, ADMIN);
  assert.strictEqual(revoked.status, 409);
});
