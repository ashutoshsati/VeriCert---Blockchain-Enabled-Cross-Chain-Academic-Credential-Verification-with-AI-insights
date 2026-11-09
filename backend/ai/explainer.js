// IN PLAIN ENGLISH: the "budget keeper" for the AI. Every AI explanation costs money, so before asking
// the AI, this file:
//   1. reuses a saved explanation if we've explained exactly the same evidence before (free),
//   2. limits each visitor to 10 new explanations per minute (stops abuse), and
//   3. stops at a daily maximum (500 by default) so costs can never run away.
// If the AI isn't set up, or a limit is hit, the page still shows the verdict and checks, just without
// the AI's written explanation.
//
// Cache and spending limits around the OpenAI call.
const crypto = require("crypto");
const openai = require("./openai");
const { SYSTEM_INSTRUCTIONS } = require("./prompt");
const { Explanation } = require("../db");

// The limits, and a short-term memory of when each visitor (by internet address) last asked.
const PER_IP_PER_MINUTE = 10;
const DEFAULT_DAILY_LIMIT = 500;
const recentByIp = new Map();

// The daily maximum: taken from the AI_DAILY_LIMIT setting if it's a sensible number, otherwise 500.
function dailyLimit() {
  const raw = process.env.AI_DAILY_LIMIT;
  const value = Number(raw);
  return raw && Number.isInteger(value) && value >= 0 ? value : DEFAULT_DAILY_LIMIT;
}

// Has this visitor made fewer than 10 requests in the last minute? If so, count this one and allow it.
function takeRateSlot(ip, now) {
  const recent = (recentByIp.get(ip) ?? []).filter((t) => now - t < 60_000);
  const allowed = recent.length < PER_IP_PER_MINUTE;
  if (allowed) recent.push(now);
  recentByIp.set(ip, recent);
  return allowed;
}

// Forgets all visitors' recent requests (used by automated tests).
function resetRateLimits() {
  recentByIp.clear();
}

// Gets an explanation, applying the reuse and spending rules above in order.
async function explainWithLimits(aiInput, { credentialHash, ip, now = Date.now() }) {
  if (!openai.isConfigured()) return { explanationUnavailable: "not_configured" };

  // Make a fingerprint of everything the AI would be shown, and check whether we've saved an
  // explanation for exactly that before.
  const model = openai.modelName();
  // The instructions are part of the key, so rewording them never serves an explanation written under the old wording.
  const fingerprint = crypto
    .createHash("sha256")
    .update(JSON.stringify({ model, instructions: SYSTEM_INSTRUCTIONS, aiInput }))
    .digest("hex");
  const saved = await Explanation.findOne({ fingerprint });
  if (saved) {
    return { explanation: saved.explanation, model: saved.model, generatedAt: saved.createdAt.toISOString(), cached: true };
  }

  // No saved copy, so this will cost money: check the per-minute and per-day limits first.
  if (!takeRateSlot(ip, now)) return { explanationUnavailable: "rate_limited" };
  const startOfDay = new Date(now);
  startOfDay.setUTCHours(0, 0, 0, 0);
  if ((await Explanation.countDocuments({ createdAt: { $gte: startOfDay } })) >= dailyLimit()) {
    return { explanationUnavailable: "daily_limit" };
  }

  // Ask the AI.
  const outcome = await openai.generateExplanation(aiInput);
  if (outcome.unavailable) return { explanationUnavailable: outcome.unavailable };

  // Save the new explanation so the same question is free next time.
  const createdAt = new Date(now);
  await Explanation.updateOne(
    { fingerprint },
    { $setOnInsert: { fingerprint, credentialHash, explanation: outcome.explanation, model, createdAt } },
    { upsert: true }
  );
  return { explanation: outcome.explanation, model, generatedAt: createdAt.toISOString(), cached: false };
}

module.exports = { explainWithLimits, resetRateLimits };
