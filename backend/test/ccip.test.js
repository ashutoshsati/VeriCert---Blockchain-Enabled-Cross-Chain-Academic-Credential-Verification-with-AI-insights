// Runs the backend in CHAIN_MODE=ccip against the real contracts on a local Hardhat node,
// with Chainlink Local's simulator standing in for both CCIP routers.
// Requires `npm install && npm run compile` in contracts/ first; skipped otherwise.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { once } = require("events");
const mongoose = require("mongoose");
const { ethers } = require("ethers");
const { MongoMemoryServer } = require("mongodb-memory-server");

const CONTRACTS_DIR = path.join(__dirname, "..", "..", "contracts");
const ARTIFACTS = {
  simulator: "@chainlink/local/src/ccip/CCIPLocalSimulator.sol/CCIPLocalSimulator.json",
  veriCert: "contracts/VeriCert.sol/VeriCert.json",
  receiver: "contracts/Receiver.sol/Receiver.json",
};
// Hardhat's well-known default test accounts #0 and #1 (public keys, local node only).
const OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const OUTSIDER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const artifactPath = (relative) => path.join(CONTRACTS_DIR, "artifacts", relative);
const artifactsMissing = Object.values(ARTIFACTS).some((relative) => !fs.existsSync(artifactPath(relative)));
const skip = artifactsMissing && "contracts not compiled: run `npm install && npm run compile` in contracts/";

function readArtifact(relative) {
  return JSON.parse(fs.readFileSync(artifactPath(relative), "utf8"));
}

describe("CCIP chain module", { skip }, () => {
  it("ABI fragments match the compiled contracts", () => {
    const ccip = require("../chain/ccip");
    for (const [artifact, abi] of [[ARTIFACTS.veriCert, ccip.VERICERT_ABI], [ARTIFACTS.receiver, ccip.RECEIVER_ABI]]) {
      const compiled = new Set(new ethers.Interface(readArtifact(artifact).abi).fragments.map((f) => f.format("full")));
      for (const fragment of new ethers.Interface(abi).fragments) {
        assert.ok(compiled.has(fragment.format("full")), `${artifact} has no ${fragment.format("full")}`);
      }
    }
  });
});

describe("ccip config validation (no Hardhat node needed)", () => {
  function freshCcip() {
    delete require.cache[require.resolve("../chain/ccip")];
    return require("../chain/ccip");
  }

  function withEnv(overrides, fn) {
    const originals = {};
    for (const key of Object.keys(overrides)) originals[key] = process.env[key];
    Object.assign(process.env, overrides);
    return Promise.resolve()
      .then(fn)
      .finally(() => {
        for (const [key, value] of Object.entries(originals)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        delete require.cache[require.resolve("../chain/ccip")];
      });
  }

  it("checkConfig rejects a malformed ISSUER_PRIVATE_KEY with a generic message", async () => {
    const badKey = "0x" + "1".repeat(63); // one hex digit short of a valid 32-byte key
    await withEnv({ ISSUER_PRIVATE_KEY: badKey }, () => {
      const ccip = freshCcip();
      assert.throws(() => ccip.checkConfig(), (err) => {
        assert.strictEqual(err.message, "ISSUER_PRIVATE_KEY is not a valid private key");
        assert.ok(!err.message.includes(badKey.slice(2)), "must not echo the key");
        return true;
      });
    });
  });

  it("verifyOnChain rejects with the same generic message for a malformed key, not the ethers error", async () => {
    const badKey = "0x" + "2".repeat(63);
    await withEnv(
      {
        AMOY_RPC_URL: "http://127.0.0.1:1",
        FUJI_RPC_URL: "http://127.0.0.1:1",
        ISSUER_PRIVATE_KEY: badKey,
        VERICERT_ADDRESS: ethers.ZeroAddress,
        RECEIVER_ADDRESS: ethers.ZeroAddress,
      },
      async () => {
        const ccip = freshCcip();
        await assert.rejects(ccip.verifyOnChain(ethers.id("whatever")), (err) => {
          assert.strictEqual(err.message, "ISSUER_PRIVATE_KEY is not a valid private key");
          assert.ok(!err.message.includes(badKey.slice(2)), "must not echo the key");
          return true;
        });
      }
    );
  });
});

describe("CHAIN_MODE=ccip end to end", { skip }, () => {
  let node, provider, owner, veriCert, mongo, server, baseUrl, tempDir, chain;

  async function startHardhatNode() {
    const cli = require.resolve("hardhat/internal/cli/cli.js", { paths: [CONTRACTS_DIR] });
    const port = 20000 + Math.floor(Math.random() * 20000);
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
    return { child, url: `http://127.0.0.1:${port}` };
  }

  async function deployArtifact(relative, args) {
    const { abi, bytecode } = readArtifact(relative);
    const contract = await new ethers.ContractFactory(abi, bytecode, owner).deploy(...args);
    await contract.waitForDeployment();
    return contract;
  }

  async function call(method, route, { body, apiKey } = {}) {
    const headers = { "content-type": "application/json" };
    if (apiKey) headers["x-api-key"] = apiKey;
    const res = await fetch(baseUrl + route, { method, headers, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  }

  const credential = (studentId) => ({
    studentName: "Jane Doe", studentId, degree: "Bachelor of Science", major: "Computer Science",
    year: 2024, courses: ["COMP6002"], issuer: "Example University",
  });
  const ADMIN = { apiKey: "test-key" };

  before(async () => {
    node = await startHardhatNode();
    // ethers v6 caches read RPC results (incl. getTransactionCount) for 250ms by default; Hardhat's
    // instant automining lets several of this setup's transactions land within that window, which was
    // producing stale-nonce "nonce has already been used" errors here. Disable the cache for this
    // rapid-fire setup provider only (harmless: it just costs a few extra RPC round trips).
    provider = new ethers.JsonRpcProvider(node.url, undefined, { cacheTimeout: -1 });
    owner = new ethers.Wallet(OWNER_KEY, provider);

    const simulator = await deployArtifact(ARTIFACTS.simulator, []);
    const config = await simulator.configuration();
    veriCert = await deployArtifact(ARTIFACTS.veriCert, [config.sourceRouter_, config.chainSelector_]);
    const receiver = await deployArtifact(ARTIFACTS.receiver, [config.destinationRouter_, config.chainSelector_]);
    await (await receiver.setAllowedSender(await veriCert.getAddress())).wait();
    await (await veriCert.setReceiver(await receiver.getAddress())).wait();
    await (await veriCert.addIssuer(owner.address)).wait();

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vericert-ccip-"));
    Object.assign(process.env, {
      CHAIN_MODE: "ccip",
      AMOY_RPC_URL: node.url,
      FUJI_RPC_URL: node.url,
      ISSUER_PRIVATE_KEY: OWNER_KEY,
      VERICERT_ADDRESS: await veriCert.getAddress(),
      RECEIVER_ADDRESS: await receiver.getAddress(),
      ADMIN_API_KEY: "test-key",
      MOCK_CHAIN_FILE: path.join(tempDir, "unused.json"),
    });

    mongo = await MongoMemoryServer.create();
    const { connectDB } = require("../db");
    await connectDB(mongo.getUri());
    const app = require("../server");
    chain = require("../chain");
    server = app.listen(0);
    await once(server, "listening");
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    server?.close();
    await chain?.close();
    provider?.destroy();
    await mongoose.disconnect();
    await mongo?.stop();
    node?.child.kill();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("uses the CCIP implementation", () => {
    assert.strictEqual(chain, require("../chain/ccip"));
  });

  it("issues, verifies, revokes and re-verifies through the contracts", async () => {
    const issued = await call("POST", "/issue", { body: credential("E2E1"), ...ADMIN });
    assert.strictEqual(issued.status, 200, JSON.stringify(issued.body));
    assert.strictEqual(issued.body.status, "relaying");
    assert.match(issued.body.txHash, /^0x[0-9a-f]{64}$/);
    assert.match(issued.body.ccipMessageId, /^0x[0-9a-f]{64}$/);
    const hash = issued.body.credentialHash;

    const verified = await call("GET", `/verify/${hash}`);
    assert.strictEqual(verified.status, 200);
    assert.strictEqual(verified.body.verification.isValid, true);
    assert.strictEqual(verified.body.verification.issuer, owner.address);
    assert.ok(verified.body.verification.issuedAt > 1_600_000_000_000, "issuedAt should be in milliseconds");
    assert.strictEqual(verified.body.metadata.status, "active");

    const revoked = await call("POST", `/revoke/${hash}`, ADMIN);
    assert.strictEqual(revoked.status, 200, JSON.stringify(revoked.body));

    const reverified = await call("GET", `/verify/${hash}`);
    assert.strictEqual(reverified.status, 200);
    assert.strictEqual(reverified.body.verification.isValid, false);
    assert.strictEqual(reverified.body.verification.revoked, true);
    assert.strictEqual(reverified.body.verification.revocationPending, undefined);
  });

  it("collects Amoy and Fuji evidence for issued and revoked credentials", async () => {
    const issued = await call("POST", "/issue", { body: credential("EVID1"), ...ADMIN });
    assert.strictEqual(issued.status, 200, JSON.stringify(issued.body));
    const hash = issued.body.credentialHash;
    const onChain = await chain.verifyOnChain(hash);

    let evidence = await chain.chainEvidence(hash, { issuer: onChain.issuer, receivedAt: onChain.receivedAt });
    assert.deepStrictEqual(evidence.amoy, { exists: true, issuer: owner.address, issuedAt: onChain.issuedAt, revoked: false });
    assert.strictEqual(evidence.issuerApproved, true);
    assert.deepStrictEqual(evidence.fujiEvents.map((e) => [e.event, e.messageId]), [["CredentialReceived", issued.body.ccipMessageId]]);

    const revokedAt = Date.now();
    assert.strictEqual((await call("POST", `/revoke/${hash}`, ADMIN)).status, 200);
    evidence = await chain.chainEvidence(hash, {
      issuer: onChain.issuer, receivedAt: onChain.receivedAt, revoked: true, revokedAfter: revokedAt,
    });
    assert.strictEqual(evidence.amoy.revoked, true);
    assert.deepStrictEqual(evidence.fujiEvents.map((e) => e.event), ["CredentialReceived", "CredentialRevoked"]);
  });

  it("explains with on-chain checks in ccip mode", async () => {
    const issued = await call("POST", "/issue", { body: credential("EXPL1"), ...ADMIN });
    const hash = issued.body.credentialHash;
    const byId = (body) => Object.fromEntries(body.checks.map((c) => [c.id, c]));

    let result = await call("POST", "/explain", { body: { hash, ai: false } });
    assert.strictEqual(result.status, 200, JSON.stringify(result.body));
    assert.strictEqual(result.body.verdict, "valid");
    for (const id of ["chains-agree", "ccip-message-match", "issuer-approved", "db-matches-chain"]) {
      assert.strictEqual(byId(result.body)[id].status, "passed", `${id}: ${byId(result.body)[id].detail}`);
    }
    assert.deepStrictEqual(result.body.evidence, { backendEvents: 3, fujiEvents: 1, chainSource: "fuji" });

    assert.strictEqual((await call("POST", `/revoke/${hash}`, ADMIN)).status, 200);
    result = await call("POST", "/explain", { body: { hash, ai: false } });
    assert.strictEqual(result.body.verdict, "revoked");
    assert.strictEqual(byId(result.body)["ccip-message-match"].status, "passed");
    assert.strictEqual(result.body.evidence.fujiEvents, 2);
  });

  it("flags an issuer wallet that is no longer approved", async () => {
    const issued = await call("POST", "/issue", { body: credential("EXPL2"), ...ADMIN });
    await (await veriCert.removeIssuer(owner.address)).wait();
    try {
      const result = await call("POST", "/explain", { body: { hash: issued.body.credentialHash, ai: false } });
      const check = result.body.checks.find((c) => c.id === "issuer-approved");
      assert.strictEqual(check.status, "failed");
      assert.strictEqual(check.severity, "warning");
      assert.strictEqual(result.body.verdict, "valid");
    } finally {
      await (await veriCert.addIssuer(owner.address)).wait();
    }
  });

  it("recovers an issue that reached Amoy but whose response was lost", async () => {
    const hash = ethers.id("lost-response");
    const tx = await veriCert.issue(hash);
    const receipt = await tx.wait();
    const sent = receipt.logs.map((log) => veriCert.interface.parseLog(log)).find((e) => e?.name === "CredentialIssued");
    const nonceBefore = await provider.getTransactionCount(owner.address);

    const result = await chain.issueAndRelay(hash, "Example University");

    assert.strictEqual(result.ccipMessageId, sent.args.messageId);
    assert.strictEqual(result.txHash, receipt.hash);
    assert.strictEqual(await provider.getTransactionCount(owner.address), nonceBefore, "must not send a second transaction");
  });

  it("recovers a revoke that reached Amoy but whose response was lost", async () => {
    const hash = ethers.id("lost-revoke");
    await (await veriCert.issue(hash)).wait();
    // Explicit gasLimit: this local Hardhat node's estimateGas cannot reliably size a revoke() call
    // (it is well under 500k gas in practice; see chain/ccip.js's own SEND_GAS_LIMIT for the same fix).
    const receipt = await (await veriCert.revoke(hash, { gasLimit: 1_500_000 })).wait();
    const sent = receipt.logs.map((log) => veriCert.interface.parseLog(log)).find((e) => e?.name === "CredentialRevoked");
    const nonceBefore = await provider.getTransactionCount(owner.address);

    const result = await chain.revokeAndRelay(hash);

    assert.strictEqual(result.txHash, receipt.hash);
    assert.strictEqual(result.ccipMessageId, sent.args.messageId);
    assert.strictEqual(await provider.getTransactionCount(owner.address), nonceBefore, "must not send a second transaction");
  });

  it("explains when the backend wallet is not an approved issuer", async () => {
    await (await veriCert.removeIssuer(owner.address)).wait();
    try {
      await assert.rejects(chain.issueAndRelay(ethers.id("not-allowed"), "Example University"), /not an approved issuer/);
    } finally {
      await (await veriCert.addIssuer(owner.address)).wait();
    }
  });

  it("reports an unknown hash as not found on Fuji", async () => {
    assert.deepStrictEqual(await chain.verifyOnChain(ethers.id("never-issued")), { isValid: false, found: false });
  });

  it("does not let a non-issuer key through by accident", async () => {
    const outsider = new ethers.Wallet(OUTSIDER_KEY, provider);
    // ethers v6 only auto-decodes custom errors into err.revert for staticCall/view paths; a plain
    // .send() (as issue() is here) leaves err.revert null, so fall back to manual ABI decoding too.
    await assert.rejects(veriCert.connect(outsider).issue(ethers.id("outsider")), (err) => {
      const name = err.revert?.name ?? veriCert.interface.parseError(err.data)?.name;
      return name === "NotIssuer";
    });
  });
});
