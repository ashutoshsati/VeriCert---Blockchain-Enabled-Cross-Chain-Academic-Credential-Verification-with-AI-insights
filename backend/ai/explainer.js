// Cache and spending limits around the OpenAI call.
const crypto = require("crypto");
const openai = require("./openai");
const { Explanation } = require("../db");

const PER_IP_PER_MINUTE = 10;
const DEFAULT_DAILY_LIMIT = 500;
const recentByIp = new Map();

function dailyLimit() {
  const raw = process.env.AI_DAILY_LIMIT;
  const value = Number(raw);
  return raw && Number.isInteger(value) && value >= 0 ? value : DEFAULT_DAILY_LIMIT;
}

function takeRateSlot(ip, now) {
  const recent = (recentByIp.get(ip) ?? []).filter((t) => now - t < 60_000);
  const allowed = recent.length < PER_IP_PER_MINUTE;
  if (allowed) recent.push(now);
  recentByIp.set(ip, recent);
  return allowed;
}

function resetRateLimits() {
  recentByIp.clear();
}

async function explainWithLimits(aiInput, { credentialHash, ip, now = Date.now() }) {
  if (!openai.isConfigured()) return { explanationUnavailable: "not_configured" };

  const model = openai.modelName();
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify({ model, aiInput })).digest("hex");
  const saved = await Explanation.findOne({ fingerprint });
  if (saved) {
    return { explanation: saved.explanation, model: saved.model, generatedAt: saved.createdAt.toISOString(), cached: true };
  }

  if (!takeRateSlot(ip, now)) return { explanationUnavailable: "rate_limited" };
  const startOfDay = new Date(now);
  startOfDay.setUTCHours(0, 0, 0, 0);
  if ((await Explanation.countDocuments({ createdAt: { $gte: startOfDay } })) >= dailyLimit()) {
    return { explanationUnavailable: "daily_limit" };
  }

  const outcome = await openai.generateExplanation(aiInput);
  if (outcome.unavailable) return { explanationUnavailable: outcome.unavailable };

  const createdAt = new Date(now);
  await Explanation.updateOne(
    { fingerprint },
    { $setOnInsert: { fingerprint, credentialHash, explanation: outcome.explanation, model, createdAt } },
    { upsert: true }
  );
  return { explanation: outcome.explanation, model, generatedAt: createdAt.toISOString(), cached: false };
}

module.exports = { explainWithLimits, resetRateLimits };
