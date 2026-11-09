// IN PLAIN ENGLISH: the "explain this result" feature, start to finish.
//   1. Read the request (either a degree's fingerprint, or its full details from the certificate).
//   2. Gather all the evidence: blockchain records, our database record and the activity log.
//   3. Run fixed, testable rules in our code to decide the verdict (valid, revoked, tampered, ...).
//   4. Optionally ask the AI to explain that verdict in plain language. The AI only explains; it never
//      decides whether a degree is genuine.
//
// POST /explain: the code-decided verdict and checks, plus an optional AI explanation.
const { ValidationError, parseCredential, hashCredential, normalizeHash } = require("../credential");
const { gatherEvidence } = require("./evidence");
const { evaluate } = require("./checks");
const { buildAiInput } = require("./prompt");
const { explainWithLimits } = require("./explainer");

// The names of a degree's detail fields.
const CREDENTIAL_KEYS = ["studentName", "studentId", "degree", "major", "year", "courses", "issuer"];

// Checks the request makes sense: it must contain EITHER a fingerprint OR the degree's details (not
// both, not neither). If an uploaded certificate file also stated a fingerprint ("claimedHash"), keep
// it, so we can spot a file whose details were edited after it was issued.
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

// A short summary of where the evidence came from (how many log entries, which blockchain source),
// shown on the page so readers know what the explanation was based on.
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

// Runs steps 2-4 above and builds the reply. If no AI explanation was asked for, it stops after the
// verdict and checks.
async function runExplain(request, { ip, now = Date.now() } = {}) {
  const evidence = await gatherEvidence(request);
  const result = evaluate(evidence, now);
  const body = {
    credentialHash: request.presentedHash,
    ...result,
    explanation: null,
    explanationUnavailable: null,
    evidence: summariseEvidence(evidence),
    model: null,
    generatedAt: null,
    cached: false,
  };
  if (!request.ai) return body;
  const ai = await explainWithLimits(buildAiInput(evidence, result), { credentialHash: request.presentedHash, ip, now });
  return { ...body, ...ai };
}

module.exports = { parseExplainRequest, runExplain };
