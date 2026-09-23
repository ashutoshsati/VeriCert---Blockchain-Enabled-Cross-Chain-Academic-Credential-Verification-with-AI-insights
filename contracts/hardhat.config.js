require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const accounts = process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [];

module.exports = {
  solidity: {
    version: "0.8.24",
    // "paris" avoids newer opcodes so the same bytecode deploys cleanly on Amoy, Fuji and from Remix.
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris" },
  },
  networks: {
    amoy: { url: process.env.AMOY_RPC_URL || "https://rpc-amoy.polygon.technology", chainId: 80002, accounts },
    fuji: { url: process.env.FUJI_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc", chainId: 43113, accounts },
  },
};
