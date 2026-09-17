const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { ACTION_ISSUE, ACTION_REVOKE, deploySimulator, buildMessage, deliver } = require("./helpers");

describe("Receiver", function () {
  async function deployFixture() {
    const [owner, trustedSender, issuer, outsider] = await ethers.getSigners();
    const { router, chainSelector } = await deploySimulator();
    const receiver = await (await ethers.getContractFactory("Receiver")).deploy(await router.getAddress(), chainSelector);
    await receiver.setAllowedSender(trustedSender.address);
    const hash = ethers.id("credential-1");
    const fields = (overrides = {}) => ({
      sourceChainSelector: chainSelector,
      sender: trustedSender.address,
      action: ACTION_ISSUE,
      hash,
      issuer: issuer.address,
      issuedAt: 1_700_000_000,
      ...overrides,
    });
    return { owner, trustedSender, issuer, outsider, router, chainSelector, receiver, hash, fields };
  }

  it("stores an ISSUE message and emits CredentialReceived", async function () {
    const { router, receiver, hash, issuer, fields } = await loadFixture(deployFixture);
    const messageId = ethers.id("issue-1");

    const result = await deliver(router, receiver, fields({ messageId }));

    expect(result.success).to.equal(true);
    await expect(result.tx).to.emit(receiver, "CredentialReceived").withArgs(hash, issuer.address, 1_700_000_000, messageId);
    const record = await receiver.getCredential(hash);
    expect(record.exists).to.equal(true);
    expect(record.issuer).to.equal(issuer.address);
    expect(record.issuedAt).to.equal(1_700_000_000n);
    expect(record.receivedAt).to.be.greaterThan(0n);
    expect(record.revoked).to.equal(false);
  });

  it("ignores a duplicate ISSUE message", async function () {
    const { router, receiver, hash, fields } = await loadFixture(deployFixture);
    await deliver(router, receiver, fields());
    const before = await receiver.getCredential(hash);

    const result = await deliver(router, receiver, fields({ issuedAt: 1_800_000_000 }));

    expect(result.success).to.equal(true);
    await expect(result.tx).not.to.emit(receiver, "CredentialReceived");
    const after = await receiver.getCredential(hash);
    expect(after.issuedAt).to.equal(before.issuedAt);
    expect(after.receivedAt).to.equal(before.receivedAt);
  });

  it("marks a credential revoked on a REVOKE message", async function () {
    const { router, receiver, hash, fields } = await loadFixture(deployFixture);
    await deliver(router, receiver, fields());
    const messageId = ethers.id("revoke-1");

    const result = await deliver(router, receiver, fields({ action: ACTION_REVOKE, messageId }));

    await expect(result.tx).to.emit(receiver, "CredentialRevoked").withArgs(hash, messageId);
    expect((await receiver.getCredential(hash)).revoked).to.equal(true);
  });

  it("keeps a credential revoked when REVOKE arrives before ISSUE", async function () {
    const { router, receiver, hash, issuer, fields } = await loadFixture(deployFixture);

    const revoke = await deliver(router, receiver, fields({ action: ACTION_REVOKE }));
    await expect(revoke.tx).to.emit(receiver, "CredentialRevoked");
    const issue = await deliver(router, receiver, fields({ action: ACTION_ISSUE }));

    expect(issue.success).to.equal(true);
    const record = await receiver.getCredential(hash);
    expect(record.exists).to.equal(true);
    expect(record.revoked).to.equal(true);
    expect(record.issuer).to.equal(issuer.address);
  });

  it("ignores a second REVOKE message", async function () {
    const { router, receiver, fields } = await loadFixture(deployFixture);
    await deliver(router, receiver, fields());
    await deliver(router, receiver, fields({ action: ACTION_REVOKE }));

    const result = await deliver(router, receiver, fields({ action: ACTION_REVOKE }));

    expect(result.success).to.equal(true);
    await expect(result.tx).not.to.emit(receiver, "CredentialRevoked");
  });

  it("rejects messages from an unknown sender", async function () {
    const { router, receiver, hash, outsider, chainSelector, fields } = await loadFixture(deployFixture);

    const result = await deliver(router, receiver, fields({ sender: outsider.address }));

    expect(result.success).to.equal(false);
    expect(result.errorName).to.equal("UnauthorizedSource");
    expect(result.errorArgs[0]).to.equal(chainSelector);
    expect(result.errorArgs[1]).to.equal(outsider.address);
    expect((await receiver.getCredential(hash)).exists).to.equal(false);
  });

  it("rejects messages from an unknown source chain", async function () {
    const { router, receiver, fields } = await loadFixture(deployFixture);

    const result = await deliver(router, receiver, fields({ sourceChainSelector: 1n }));

    expect(result.success).to.equal(false);
    expect(result.errorName).to.equal("UnauthorizedSource");
  });

  it("rejects an unknown action", async function () {
    const { router, receiver, fields } = await loadFixture(deployFixture);

    const result = await deliver(router, receiver, fields({ action: 7 }));

    expect(result.success).to.equal(false);
    expect(result.errorName).to.equal("UnknownAction");
  });

  it("only lets the router call ccipReceive", async function () {
    const { receiver, outsider, fields } = await loadFixture(deployFixture);

    await expect(receiver.connect(outsider).ccipReceive(buildMessage(fields())))
      .to.be.revertedWithCustomError(receiver, "InvalidRouter")
      .withArgs(outsider.address);
  });

  it("only lets the owner set a non-zero allowed sender", async function () {
    const { receiver, outsider } = await loadFixture(deployFixture);

    await expect(receiver.connect(outsider).setAllowedSender(outsider.address))
      .to.be.revertedWithCustomError(receiver, "OwnableUnauthorizedAccount")
      .withArgs(outsider.address);
    await expect(receiver.setAllowedSender(ethers.ZeroAddress)).to.be.revertedWithCustomError(receiver, "ZeroAddress");
    await expect(receiver.setAllowedSender(outsider.address)).to.emit(receiver, "AllowedSenderSet").withArgs(outsider.address);
  });

  it("advertises the CCIP receiver and ERC-165 interfaces", async function () {
    const { receiver } = await loadFixture(deployFixture);
    const ccipReceiveSelector = receiver.interface.getFunction("ccipReceive").selector;

    expect(await receiver.supportsInterface(ccipReceiveSelector)).to.equal(true);
    expect(await receiver.supportsInterface("0x01ffc9a7")).to.equal(true);
    expect(await receiver.supportsInterface("0xffffffff")).to.equal(false);
  });
});
