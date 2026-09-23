// POST /explain: the code-decided verdict and checks, plus an optional AI explanation.
const { ValidationError, parseCredential, hashCredential, normalizeHash } = require("../credential");
const { gatherEvidence } = require("./evidence");
const { evaluate } = require("./checks");

const CREDENTIAL_KEYS = ["studentName", "studentId", "degree", "major", "year", "courses", "issuer"];

function parseExplainRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("Request body must be a JSON object");
  }
  const ai = body.ai ?? true;
  if (typeof ai !== "boolean") throw new ValidationError("ai must be true or false");

  const hasHash = body.hash !== undefined;
  const hasDetails = CREDENTIAL_KEYS.some((key) => body[key] !== undefined);
  if (hasHash === hasDetails) throw new ValidationError("Send either a credential hash or the credential details");

  if (hasHash) {
    if (body.claimedHash !== undefined) throw new ValidationError("claimedHash can only be sent with credential details");
    return { presentedHash: normalizeHash(body.hash), credential: null, claimedHash: null, ai };
  }
  const credential = parseCredential(body);
  const claimedHash = body.claimedHash == null ? null : normalizeHash(body.claimedHash);
  return { presentedHash: hashCredential(credential), credential, claimedHash, ai };
}

function summariseEvidence(evidence) {
  let chainSource = "fuji";
  if (evidence.mode === "mock") chainSource = "mock";
  else if (evidence.chain?.unavailable) chainSource = "unavailable";
  return {
    backendEvents: evidence.backendEvents.length,
    fujiEvents: evidence.chain?.fujiEvents?.length ?? 0,
    chainSource,
  };
}

async function runExplain(request, { now = Date.now() } = {}) {
  const evidence = await gatherEvidence(request);
  const result = evaluate(evidence, now);
  return {
    credentialHash: request.presentedHash,
    ...result,
    explanation: null,
    explanationUnavailable: null,
    evidence: summariseEvidence(evidence),
    model: null,
    generatedAt: null,
    cached: false,
  };
}

module.exports = { parseExplainRequest, runExplain };
