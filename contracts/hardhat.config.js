// IN PLAIN ENGLISH: settings for Hardhat, the developer tool we use to compile, test and deploy the smart
// contracts. It says which Solidity version to use and how to connect to the two test blockchains.
require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

// The wallet used to deploy, read from a private settings file (.env) that is never shared or committed.
const accounts = process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [];

module.exports = {
  // How to compile the contracts. The optimizer makes them cheaper to run on-chain.
  solidity: {
    version: "0.8.24",
    // "paris" avoids newer opcodes so the same bytecode deploys cleanly on Amoy, Fuji and from Remix.
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris" },
  },
  // The two test blockchains: Polygon Amoy (where degrees are issued) and Avalanche Fuji (where they are
  // checked). Each has a public web address to connect to, used if we haven't set our own.
  networks: {
    amoy: { url: process.env.AMOY_RPC_URL || "https://polygon-amoy-bor-rpc.publicnode.com", chainId: 80002, accounts },
    fuji: { url: process.env.FUJI_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc", chainId: 43113, accounts },
  },
};
