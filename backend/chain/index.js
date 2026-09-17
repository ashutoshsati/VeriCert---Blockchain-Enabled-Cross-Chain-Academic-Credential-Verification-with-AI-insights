// Picks the blockchain implementation from CHAIN_MODE:
//   mock (default) - local JSON file, instant delivery
//   ccip           - VeriCert on Polygon Amoy relaying to Receiver on Avalanche Fuji via Chainlink CCIP
const IMPLEMENTATIONS = {
  mock: "./mock",
  ccip: "./ccip",
};

const mode = process.env.CHAIN_MODE || "mock";
if (!IMPLEMENTATIONS[mode]) {
  throw new Error(`CHAIN_MODE must be one of: ${Object.keys(IMPLEMENTATIONS).join(", ")} (got "${mode}")`);
}

module.exports = require(IMPLEMENTATIONS[mode]);
