const test = require("node:test");
const assert = require("node:assert");

function loadChain(mode) {
  if (mode === undefined) delete process.env.CHAIN_MODE;
  else process.env.CHAIN_MODE = mode;
  delete require.cache[require.resolve("../chain")];
  return require("../chain");
}

test.afterEach(() => {
  delete process.env.CHAIN_MODE;
});

test("defaults to the mock chain", () => {
  assert.strictEqual(loadChain(undefined), require("../chain/mock"));
});

test("CHAIN_MODE=mock selects the mock chain", () => {
  assert.strictEqual(loadChain("mock"), require("../chain/mock"));
});

test("an unknown CHAIN_MODE fails with a clear message", () => {
  assert.throws(() => loadChain("bogus"), /CHAIN_MODE must be one of: mock, ccip/);
});

test("the mock chain needs no extra environment variables", () => {
  const mock = require("../chain/mock");
  assert.deepStrictEqual(mock.requiredEnv, []);
  assert.strictEqual(typeof mock.close, "function");
});

test("CHAIN_MODE=ccip selects the CCIP chain and lists its settings", () => {
  const ccip = loadChain("ccip");
  assert.strictEqual(ccip, require("../chain/ccip"));
  assert.deepStrictEqual(ccip.requiredEnv, ["AMOY_RPC_URL", "FUJI_RPC_URL", "ISSUER_PRIVATE_KEY", "VERICERT_ADDRESS", "RECEIVER_ADDRESS"]);
});

test("each chain reports its own mode name", () => {
  assert.strictEqual(require("../chain/mock").mode, "mock");
  assert.strictEqual(require("../chain/ccip").mode, "ccip");
});
