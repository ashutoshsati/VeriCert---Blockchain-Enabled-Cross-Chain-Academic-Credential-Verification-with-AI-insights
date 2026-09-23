// The one place that talks to OpenAI. Tests replace getClient() with a fake.
const OpenAI = require("openai");
const { SYSTEM_INSTRUCTIONS, EXPLANATION_SCHEMA } = require("./prompt");

const DEFAULT_MODEL = "gpt-6-luna";
const REQUEST_TIMEOUT_MS = 30_000;
// Room for the model's own reasoning tokens as well as the answer: 600 cut off about half of the altered-file explanations.
const MAX_OUTPUT_TOKENS = 2_000;
const MAX_OBSERVATIONS = 5;

let client;

const isConfigured = () => Boolean(process.env.OPENAI_API_KEY);
const modelName = () => process.env.OPENAI_MODEL || DEFAULT_MODEL;

function getClient() {
  client ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

function isExplanation(value) {
  return Boolean(value)
    && typeof value.summary === "string" && value.summary.trim() !== ""
    && typeof value.recommendation === "string"
    && Array.isArray(value.observations)
    && value.observations.every((o) => o && ["info", "warning"].includes(o.severity) && typeof o.text === "string");
}

async function generateExplanation(aiInput) {
  try {
    const response = await module.exports.getClient().responses.create(
      {
        model: modelName(),
        store: false,
        max_output_tokens: MAX_OUTPUT_TOKENS,
        instructions: SYSTEM_INSTRUCTIONS,
        input: `<verification_data>\n${JSON.stringify(aiInput, null, 2)}\n</verification_data>`,
        text: { format: { type: "json_schema", name: "verification_explanation", strict: true, schema: EXPLANATION_SCHEMA } },
      },
      { timeout: REQUEST_TIMEOUT_MS, maxRetries: 1 }
    );
    const refused = response.output?.some((item) => item.content?.some((part) => part.type === "refusal"));
    if (response.status !== "completed" || refused) {
      const reason = refused ? "refused" : `${response.status} (${response.incomplete_details?.reason ?? "no reason given"})`;
      console.error(`OpenAI response unusable: ${reason}`);
      return { unavailable: "failed" };
    }
    const explanation = JSON.parse(response.output_text);
    if (!isExplanation(explanation)) {
      console.error("OpenAI response unusable: not in the expected format");
      return { unavailable: "failed" };
    }
    return { explanation: { ...explanation, observations: explanation.observations.slice(0, MAX_OBSERVATIONS) } };
  } catch (err) {
    // Only the kind of failure is logged: never the prompt or the reply, which contain credential details.
    console.error(`OpenAI request failed: ${err?.status ?? err?.name ?? "unknown error"}`);
    return { unavailable: "failed" };
  }
}

module.exports = { isConfigured, modelName, getClient, generateExplanation };
