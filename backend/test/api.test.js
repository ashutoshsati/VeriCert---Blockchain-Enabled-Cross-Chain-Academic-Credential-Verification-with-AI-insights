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
  const hash = issued.body.credentialHash;

  const byHash = await call("GET", "/verify/0x" + hash.slice(2).toUpperCase());
  assert.strictEqual(byHash.status, 200);
  assert.strictEqual(byHash.body.verification.isValid, true);

  const messy = credential("V1", { studentName: " jane  doe", year: "2024", courses: ["COMP5001", "COMP6002"] });
  const byDocument = await call("POST", "/verify", { body: messy });
  assert.strictEqual(byDocument.status, 200);
  assert.strictEqual(byDocument.body.credentialHash, hash);

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
  assert.strictEqual(record.status, "active");
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
  assert.strictEqual((await Credential.findOne({ credentialHash: hash })).status, "active");
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
