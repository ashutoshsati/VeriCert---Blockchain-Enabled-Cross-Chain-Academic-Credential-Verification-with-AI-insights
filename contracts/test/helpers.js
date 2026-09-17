const { ethers } = require("hardhat");

const ACTION_ISSUE = 1;
const ACTION_REVOKE = 2;
const GAS_FOR_CALL_EXACT_CHECK = 5_000;
const DELIVERY_GAS_LIMIT = 500_000;

const coder = ethers.AbiCoder.defaultAbiCoder();

// Deploys Chainlink Local's simulator. Its single mock router acts as both the Amoy and Fuji router.
async function deploySimulator() {
  const simulator = await (await ethers.getContractFactory("CCIPLocalSimulator")).deploy();
  const config = await simulator.configuration();
  const router = await ethers.getContractAt("MockCCIPRouter", config.sourceRouter_);
  return { router, chainSelector: config.chainSelector_ };
}

function buildMessage({ messageId = ethers.id("message"), sourceChainSelector, sender, action, hash, issuer, issuedAt }) {
  return {
    messageId,
    sourceChainSelector,
    sender: coder.encode(["address"], [sender]),
    data: coder.encode(["uint8", "bytes32", "address", "uint64"], [action, hash, issuer, issuedAt]),
    destTokenAmounts: [],
  };
}

// Delivers a hand-built CCIP message to `receiver` through the mock router, as the real router would.
// routeMessage does not revert when the receiver reverts, so the outcome is read with staticCall first.
async function deliver(router, receiver, fields) {
  const message = buildMessage(fields);
  const target = await receiver.getAddress();
  const [success, retData] = await router.routeMessage.staticCall(message, GAS_FOR_CALL_EXACT_CHECK, DELIVERY_GAS_LIMIT, target);
  if (!success) {
    const parsed = receiver.interface.parseError(retData);
    return { success, errorName: parsed?.name, errorArgs: parsed?.args, tx: null };
  }
  const tx = await router.routeMessage(message, GAS_FOR_CALL_EXACT_CHECK, DELIVERY_GAS_LIMIT, target);
  return { success, errorName: null, errorArgs: null, tx };
}

module.exports = { ACTION_ISSUE, ACTION_REVOKE, deploySimulator, buildMessage, deliver };
