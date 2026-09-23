const test = require("node:test");
const assert = require("node:assert");
const { ValidationError, parseCredential, hashCredential, normalizeHash, canonicalCredential } = require("../credential");

const base = {
  studentName: "Jane Doe",
  studentId: "S123",
  degree: "Bachelor of Science",
  major: "Computer Science",
  year: 2024,
  courses: ["COMP6002", "COMP5001"],
  issuer: "Example University",
};

const hashOf = (body) => hashCredential(parseCredential(body));

test("same credential in different formatting gives the same hash", () => {
  const messy = {
    ...base,
    studentName: "  jane   DOE ",
    degree: "bachelor of science",
    year: "2024",
    courses: [" comp5001", "COMP6002  "],
  };
  assert.strictEqual(hashOf(messy), hashOf(base));
});

test("different credential data gives a different hash", () => {
  assert.notStrictEqual(hashOf({ ...base, year: 2025 }), hashOf(base));
  assert.notStrictEqual(hashOf({ ...base, courses: ["COMP6002"] }), hashOf(base));
});

test("hash is lowercase 0x-prefixed sha256", () => {
  assert.match(hashOf(base), /^0x[0-9a-f]{64}$/);
});

test("missing courses is treated as an empty list", () => {
  const { courses, ...rest } = base;
  assert.strictEqual(hashOf(rest), hashOf({ ...base, courses: [] }));
});

test("rejects missing or invalid fields", () => {
  const { studentName, ...noName } = base;
  assert.throws(() => parseCredential(noName), ValidationError);
  assert.throws(() => parseCredential({ ...base, studentId: "   " }), ValidationError);
  assert.throws(() => parseCredential({ ...base, year: "abc" }), ValidationError);
  assert.throws(() => parseCredential({ ...base, year: 2024.5 }), ValidationError);
  assert.throws(() => parseCredential({ ...base, courses: "COMP6002" }), ValidationError);
  assert.throws(() => parseCredential({ ...base, courses: ["COMP6002", 42] }), ValidationError);
  assert.throws(() => parseCredential(undefined), ValidationError);
});

test("ignores fields that are not part of a credential", () => {
  const parsed = parseCredential({ ...base, status: "revoked", credentialHash: "0xdead", createdAt: "2000-01-01" });
  assert.deepStrictEqual(Object.keys(parsed).sort(), Object.keys(base).sort());
});

test("normalizeHash lowercases valid hashes and rejects invalid ones", () => {
  const hash = hashOf(base);
  assert.strictEqual(normalizeHash(hash.toUpperCase().replace("0X", "0x")), hash);
  assert.strictEqual(normalizeHash("0X" + hash.slice(2)), hash);
  assert.throws(() => normalizeHash("0x123"), ValidationError);
  assert.throws(() => normalizeHash("not-a-hash"), ValidationError);
});

test("canonicalCredential lowercases text and sorts courses", () => {
  const parsed = parseCredential({ ...base, degree: "BACHELOR of Science", courses: ["COMP6002", "comp5001"] });
  assert.deepStrictEqual(canonicalCredential(parsed), {
    studentName: "jane doe",
    studentId: "s123",
    degree: "bachelor of science",
    major: "computer science",
    year: 2024,
    courses: ["comp5001", "comp6002"],
    issuer: "example university",
  });
});
