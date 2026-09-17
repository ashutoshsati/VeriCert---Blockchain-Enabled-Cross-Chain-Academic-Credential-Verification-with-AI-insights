// Live testnet check: issues a throwaway credential hash through the deployed contracts and waits for
// CCIP delivery to Avalanche Fuji. Does not touch MongoDB.
// Usage (from backend/): npm run smoke:ccip   — needs the ccip settings in backend/.env
require("dotenv").config();
const crypto = require("crypto");
const chain = require("../chain/ccip");

const POLL_INTERVAL_MS = 30_000;
const TIMEOUT_MS = 40 * 60_000;

async function main() {
  const missing = chain.requiredEnv.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Missing in backend/.env: ${missing.join(", ")} (see .env.example)`);

  const hash = "0x" + crypto.createHash("sha256").update(`vericert-smoke-${Date.now()}`).digest("hex");
  console.log(`Issuing test hash ${hash} on Polygon Amoy...`);
  const { txHash, ccipMessageId } = await chain.issueAndRelay(hash, "smoke test");
  console.log(`Amoy transaction: https://amoy.polygonscan.com/tx/${txHash}`);
  console.log(`Track delivery:   https://ccip.chain.link/msg/${ccipMessageId}`);

  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await chain.verifyOnChain(hash);
    if (result.found) {
      console.log("Delivered to Avalanche Fuji:", result);
      return;
    }
    console.log("Not on Fuji yet; checking again in 30 seconds...");
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error("Not delivered after 40 minutes; check the CCIP Explorer link above");
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => chain.close());
