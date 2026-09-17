// Local end-to-end demo: deploys VeriCert and Receiver to a local Hardhat node, with Chainlink Local's simulator
// standing in for CCIP, runs the API in CHAIN_MODE=ccip against them, and walks through issue -> verify -> revoke.
// Needs no wallet, test tokens or MongoDB install (uses a temporary in-memory database).
// Usage (from backend/): npm run demo   — first run `npm install && npm run compile` in contracts/
const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");
const { ethers } = require("ethers");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const CONTRACTS_DIR = path.join(__dirname, "..", "..", "contracts");
const ARTIFACTS = {
  simulator: "@chainlink/local/src/ccip/CCIPLocalSimulator.sol/CCIPLocalSimulator.json",
  veriCert: "contracts/VeriCert.sol/VeriCert.json",
  receiver: "contracts/Receiver.sol/Receiver.json",
};
// Hardhat's well-known default test account #0 (public key, local node only).
const ISSUER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const API_KEY = "demo-admin-key";

const DEGREE = {
  studentName: "Priya Sharma",
  studentId: "S2024-0117",
  degree: "Bachelor of Computer Science",
  major: "Cybersecurity",
  year: 2024,
  courses: ["COMP6002", "COMP5001", "COMP3010"],
  issuer: "Example University",
};

const say = (text = "") => console.log(text);
const heading = (n, text) => say(`\n━━ ${n}. ${text} ━━`);
const short = (value) => (typeof value === "string" && value.length > 20 ? `${value.slice(0, 10)}…${value.slice(-6)}` : String(value));
const artifactPath = (relative) => path.join(CONTRACTS_DIR, "artifacts", relative);

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}

async function startHardhatNode(port) {
  const cli = require.resolve("hardhat/internal/cli/cli.js", { paths: [CONTRACTS_DIR] });
  const child = spawn(process.execPath, [cli, "node", "--port", String(port)], { cwd: CONTRACTS_DIR });
  child.stderr.resume();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Hardhat node did not start within 60s")), 60_000);
    child.stdout.on("data", (data) => {
      if (String(data).includes("Started HTTP")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", (code) => reject(new Error(`Hardhat node exited with code ${code}`)));
  });
  return child;
}

async function deployArtifact(relative, wallet, args) {
  const { abi, bytecode } = JSON.parse(fs.readFileSync(artifactPath(relative), "utf8"));
  const contract = await new ethers.ContractFactory(abi, bytecode, wallet).deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

async function main() {
  const missing = Object.values(ARTIFACTS).filter((relative) => !fs.existsSync(artifactPath(relative)));
  if (missing.length) throw new Error("Contracts are not compiled: run `npm install && npm run compile` in contracts/ first");

  let node, provider, mongo, server, chain;
  try {
    heading(1, "Start a local blockchain and deploy the contracts");
    const nodePort = await freePort();
    node = await startHardhatNode(nodePort);
    const rpcUrl = `http://127.0.0.1:${nodePort}`;
    provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 });
    const issuer = new ethers.Wallet(ISSUER_KEY, provider);

    const simulator = await deployArtifact(ARTIFACTS.simulator, issuer, []);
    const config = await simulator.configuration();
    const veriCert = await deployArtifact(ARTIFACTS.veriCert, issuer, [config.sourceRouter_, config.chainSelector_]);
    const receiver = await deployArtifact(ARTIFACTS.receiver, issuer, [config.destinationRouter_, config.chainSelector_]);
    await (await receiver.setAllowedSender(await veriCert.getAddress())).wait();
    await (await veriCert.setReceiver(await receiver.getAddress())).wait();
    await (await veriCert.addIssuer(issuer.address)).wait();
    say(`VeriCert ("Amoy"): ${await veriCert.getAddress()}`);
    say(`Receiver ("Fuji"): ${await receiver.getAddress()}`);
    say(`Issuer wallet    : ${issuer.address}`);

    heading(2, "Start the VeriCert API in CHAIN_MODE=ccip");
    // Set before loading the server; dotenv never overrides variables that are already set.
    Object.assign(process.env, {
      CHAIN_MODE: "ccip",
      AMOY_RPC_URL: rpcUrl,
      FUJI_RPC_URL: rpcUrl,
      ISSUER_PRIVATE_KEY: ISSUER_KEY,
      VERICERT_ADDRESS: await veriCert.getAddress(),
      RECEIVER_ADDRESS: await receiver.getAddress(),
      ADMIN_API_KEY: API_KEY,
    });
    mongo = await MongoMemoryServer.create();
    const { connectDB } = require("../db");
    await connectDB(mongo.getUri());
    const app = require("../server");
    chain = require("../chain");
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    say(`API listening on ${baseUrl}`);

    async function api(method, route, { body, admin } = {}) {
      const headers = { "content-type": "application/json" };
      if (admin) headers["x-api-key"] = API_KEY;
      const res = await fetch(baseUrl + route, { method, headers, body: body && JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    }

    heading(3, "Someone without the admin API key tries to issue a degree");
    const noKey = await api("POST", "/issue", { body: DEGREE });
    say(`HTTP ${noKey.status}: ${noKey.body.error}`);

    heading(4, "The university admin issues the degree");
    const issued = await api("POST", "/issue", { body: DEGREE, admin: true });
    const hash = issued.body.credentialHash;
    say(`HTTP ${issued.status}  status=${issued.body.status}`);
    say(`credentialHash : ${hash}`);
    say(`Amoy tx        : ${short(issued.body.txHash)}`);
    say(`CCIP messageId : ${short(issued.body.ccipMessageId)}`);
    say(`On VeriCert: exists=${(await veriCert.getCredential(hash)).exists}`);
    say(`On Receiver: exists=${(await receiver.getCredential(hash)).exists}`);
    say("(The simulator delivers instantly. On the real testnets delivery takes 5–25 minutes and /verify returns 202 meanwhile.)");

    heading(5, "The admin issues the same degree again");
    const duplicate = await api("POST", "/issue", { body: DEGREE, admin: true });
    say(`HTTP ${duplicate.status}: ${duplicate.body.error}`);

    heading(6, "An employer verifies the genuine document, typed differently");
    const retyped = { ...DEGREE, studentName: "  priya   SHARMA ", year: "2024", courses: ["COMP3010", "comp6002", "COMP5001"] };
    const genuine = await api("POST", "/verify", { body: retyped });
    say(`HTTP ${genuine.status}  isValid=${genuine.body.verification.isValid}  issuer=${genuine.body.verification.issuer}`);
    say(`Database status: ${genuine.body.metadata.status}`);
    say(`History        : ${genuine.body.provenance.map((e) => e.eventType).join(" → ")}`);

    heading(7, "An employer checks a tampered document (major changed to Medicine)");
    const tampered = await api("POST", "/verify", { body: { ...DEGREE, major: "Medicine" } });
    say(`HTTP ${tampered.status}: ${tampered.body.error}`);

    heading(8, "The university revokes the degree");
    const revoked = await api("POST", `/revoke/${hash}`, { admin: true });
    say(`HTTP ${revoked.status}  success=${revoked.body.success}`);
    say(`On VeriCert: revoked=${(await veriCert.getCredential(hash)).revoked}`);
    say(`On Receiver: revoked=${(await receiver.getCredential(hash)).revoked}`);

    heading(9, "The employer verifies the genuine document again");
    const afterRevoke = await api("GET", `/verify/${hash}`);
    say(`HTTP ${afterRevoke.status}  isValid=${afterRevoke.body.verification.isValid}  revoked=${afterRevoke.body.verification.revoked}`);
    say(`History        : ${afterRevoke.body.provenance.map((e) => e.eventType).join(" → ")}`);

    heading(10, "Credential events recorded by the Receiver (what the AI layer will read)");
    for (const event of await receiver.queryFilter("*", 0)) {
      if (!event.eventName?.startsWith("Credential")) continue;
      say(`block ${event.blockNumber}: ${event.eventName}(${event.args.map(short).join(", ")})`);
    }

    say("\nDemo complete.");
  } finally {
    server?.close();
    await chain?.close();
    provider?.destroy();
    await mongoose.disconnect();
    await mongo?.stop();
    node?.kill();
  }
}

main().catch((err) => {
  console.error(`Demo failed: ${err.message}`);
  process.exitCode = 1;
});
