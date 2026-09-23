const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { once } = require("events");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vericert-explain-"));
process.env.MOCK_CHAIN_FILE = path.join(tempDir, "mock-chain.json");
process.env.ADMIN_API_KEY = "test-key";
process.env.CHAIN_MODE = "mock";
delete process.env.OPENAI_API_KEY;

const app = require("../server");
const { connectDB, ProvenanceEvent } = require("../db");

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

const ADMIN = { apiKey: "test-key" };

function credential(studentId, extra = {}) {
  return {
    studentName: "Jane Doe", studentId, degree: "Bachelor of Science", major: "Computer Science",
    year: 2024, courses: ["COMP6002", "COMP5001"], issuer: "Example University", ...extra,
  };
}

async function issue(studentId, extra) {
  const issued = await call("POST", "/issue", { body: credential(studentId, extra), ...ADMIN });
  assert.strictEqual(issued.status, 200, JSON.stringify(issued.body));
  return issued.body.credentialHash;
}

const explain = (body) => call("POST", "/explain", { body });
const byId = (body) => Object.fromEntries(body.checks.map((c) => [c.id, c]));

test("explains a valid credential by hash without calling the AI", async () => {
  const hash = await issue("EX1");
  const result = await explain({ hash, ai: false });
  assert.strictEqual(result.status, 200, JSON.stringify(result.body));
  assert.strictEqual(result.body.credentialHash, hash);
  assert.strictEqual(result.body.verdict, "valid");
  assert.strictEqual(result.body.checks.length, 10);
  assert.strictEqual(byId(result.body)["chains-agree"].detail, "Mock chain: no on-chain data to compare");
  assert.deepStrictEqual(result.body.fieldChanges, []);
  assert.strictEqual(result.body.explanation, null);
  assert.strictEqual(result.body.explanationUnavailable, null);
  assert.strictEqual(result.body.model, null);
  assert.strictEqual(result.body.cached, false);
  assert.deepStrictEqual(result.body.evidence, { backendEvents: 3, fujiEvents: 0, chainSource: "mock" });
});

test("explain does not add verified events to the history", async () => {
  const hash = await issue("EX2");
  await explain({ hash, ai: false });
  await explain({ hash, ai: false });
  assert.strictEqual(await ProvenanceEvent.countDocuments({ credentialHash: hash, eventType: "verified" }), 0);
});

test("an edited credential file is tampered, with the changed field", async () => {
  const original = await issue("EX3");
  const result = await explain({ ...credential("EX3", { major: "Medicine" }), claimedHash: original, ai: false });
  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.body.verdict, "tampered");
  assert.notStrictEqual(result.body.credentialHash, original);
  assert.deepStrictEqual(result.body.fieldChanges, [
    { field: "major", label: "Major", presented: "Medicine", official: "Computer Science" },
  ]);
  assert.strictEqual(byId(result.body)["file-hash"].status, "failed");
});

test("an untouched credential file is valid and its hash check passes", async () => {
  const original = await issue("EX4");
  const result = await explain({ ...credential("EX4", { studentName: "JANE doe" }), claimedHash: original, ai: false });
  assert.strictEqual(result.body.verdict, "valid");
  assert.strictEqual(byId(result.body)["file-hash"].status, "passed");
});

test("unknown and revoked credentials get their verdicts with status 200", async () => {
  assert.strictEqual((await explain({ hash: "0x" + "0".repeat(64), ai: false })).body.verdict, "not_found");
  const hash = await issue("EX5");
  assert.strictEqual((await call("POST", `/revoke/${hash}`, ADMIN)).status, 200);
  const revoked = await explain({ hash, ai: false });
  assert.strictEqual(revoked.status, 200);
  assert.strictEqual(revoked.body.verdict, "revoked");
});

test("invalid explain requests are rejected with 400", async () => {
  const hash = "0x" + "1".repeat(64);
  for (const body of [
    {},
    { hash, ...credential("BAD1") },
    { hash, claimedHash: hash },
    { hash, ai: "yes" },
    { hash: "0x123" },
    { ...credential("BAD2"), claimedHash: "nope" },
  ]) {
    const result = await explain(body);
    assert.strictEqual(result.status, 400, JSON.stringify(body));
    assert.ok(result.body.error);
  }
});
