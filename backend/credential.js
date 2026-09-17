const crypto = require("crypto");

const STRING_FIELDS = ["studentName", "studentId", "degree", "major", "issuer"];
const HASH_PATTERN = /^0x[0-9a-f]{64}$/;

class ValidationError extends Error {}

function cleanString(value) {
  return value.trim().replace(/\s+/g, " ");
}

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Picks only the credential fields from a request body, tidies them up, and
// throws a ValidationError listing everything that is missing or malformed.
function parseCredential(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("Request body must be a JSON object");
  }

  const errors = [];
  const credential = {};

  for (const field of STRING_FIELDS) {
    const value = body[field];
    if (typeof value !== "string" || !value.trim()) errors.push(`${field} is required`);
    else credential[field] = cleanString(value);
  }

  const year = typeof body.year === "string" ? Number(body.year.trim() || NaN) : body.year;
  if (!Number.isInteger(year) || year < 1900 || year > 2100) {
    errors.push("year must be a whole number between 1900 and 2100");
  } else {
    credential.year = year;
  }

  const courses = body.courses ?? [];
  if (!Array.isArray(courses) || courses.some((c) => typeof c !== "string" || !c.trim())) {
    errors.push("courses must be a list of non-empty strings");
  } else {
    credential.courses = courses.map(cleanString);
  }

  if (errors.length) throw new ValidationError(errors.join("; "));
  return credential;
}

// Hashes a parsed credential. Text is lowercased and courses are sorted so the
// same degree always produces the same hash regardless of formatting.
function hashCredential(credential) {
  const canonical = JSON.stringify({
    studentName: credential.studentName.toLowerCase(),
    studentId: credential.studentId.toLowerCase(),
    degree: credential.degree.toLowerCase(),
    major: credential.major.toLowerCase(),
    year: credential.year,
    courses: credential.courses.map((c) => c.toLowerCase()).sort(compareStrings),
    issuer: credential.issuer.toLowerCase(),
  });
  return "0x" + crypto.createHash("sha256").update(canonical).digest("hex");
}

function normalizeHash(value) {
  const hash = String(value).trim().toLowerCase();
  if (!HASH_PATTERN.test(hash)) {
    throw new ValidationError("Credential hash must be 0x followed by 64 hex characters");
  }
  return hash;
}

module.exports = { ValidationError, parseCredential, hashCredential, normalizeHash };
