// IN PLAIN ENGLISH: a switch that chooses which "blockchain" the backend uses.
//   - "mock": a pretend blockchain saved in a file on this computer. Instant and free; great for demos
//     and development, and a fallback if the real test networks are slow or out of funds.
//   - "ccip": the real thing. Degrees go to the VeriCert contract on Polygon Amoy and are relayed to
//     the Receiver contract on Avalanche Fuji by Chainlink CCIP.
// Both options offer exactly the same functions, so the rest of the backend doesn't care which is in use.
//
// Picks the blockchain implementation from CHAIN_MODE:
//   mock (default) - local JSON file, instant delivery
//   ccip           - VeriCert on Polygon Amoy relaying to Receiver on Avalanche Fuji via Chainlink CCIP
const IMPLEMENTATIONS = {
  mock: "./mock",
  ccip: "./ccip",
};

// Read the chosen mode from the settings (default: mock) and refuse to start if it's not a known option.
const mode = process.env.CHAIN_MODE || "mock";
if (!IMPLEMENTATIONS[mode]) {
  throw new Error(`CHAIN_MODE must be one of: ${Object.keys(IMPLEMENTATIONS).join(", ")} (got "${mode}")`);
}

module.exports = require(IMPLEMENTATIONS[mode]);
