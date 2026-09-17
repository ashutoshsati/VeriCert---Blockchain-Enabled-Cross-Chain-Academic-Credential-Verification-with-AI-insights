// Picks the blockchain implementation from CHAIN_MODE: "mock" (default, local JSON file).
const IMPLEMENTATIONS = {
  mock: "./mock",
};

const mode = process.env.CHAIN_MODE || "mock";
if (!IMPLEMENTATIONS[mode]) {
  throw new Error(`CHAIN_MODE must be one of: ${Object.keys(IMPLEMENTATIONS).join(", ")} (got "${mode}")`);
}

module.exports = require(IMPLEMENTATIONS[mode]);
