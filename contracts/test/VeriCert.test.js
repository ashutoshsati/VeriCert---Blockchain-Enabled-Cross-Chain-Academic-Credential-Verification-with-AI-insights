const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const { ACTION_ISSUE, ACTION_REVOKE, deploySimulator } = require("./helpers");

describe("VeriCert", function () {
  async function deployFixture() {
    const [owner, issuer, outsider] = await ethers.getSigners();
    const { router, chainSelector } = await deploySimulator();
    const routerAddress = await router.getAddress();

    const veriCert = await (await ethers.getContractFactory("VeriCert")).deploy(routerAddress, chainSelector);
    const receiver = await (await ethers.getContractFactory("Receiver")).deploy(routerAddress, chainSelector);
    await receiver.setAllowedSender(await veriCert.getAddress());
    await veriCert.setReceiver(await receiver.getAddress());
    await veriCert.addIssuer(issuer.address);

    return { owner, issuer, outsider, router, routerAddress, chainSelector, veriCert, receiver, hash: ethers.id("credential-1") };
  }

  describe("issue", function () {
    it("records the credential and delivers it to the Receiver", async function () {
      const { issuer, veriCert, receiver, hash } = await loadFixture(deployFixture);

      const tx = veriCert.connect(issuer).issue(hash);

      await expect(tx).to.emit(veriCert, "CredentialIssued").withArgs(hash, issuer.address, anyValue);
      await expect(tx).to.emit(receiver, "CredentialReceived").withArgs(hash, issuer.address, anyValue, anyValue);
      const onAmoy = await veriCert.getCredential(hash);
      const onFuji = await receiver.getCredential(hash);
      expect(onAmoy.exists).to.equal(true);
      expect(onAmoy.issuer).to.equal(issuer.address);
      expect(onAmoy.revoked).to.equal(false);
      expect(onFuji.exists).to.equal(true);
      expect(onFuji.issuer).to.equal(issuer.address);
      expect(onFuji.issuedAt).to.equal(onAmoy.issuedAt);
      expect(onFuji.revoked).to.equal(false);
    });

    it("rejects a hash that is already issued", async function () {
      const { issuer, veriCert, hash } = await loadFixture(deployFixture);
      await veriCert.connect(issuer).issue(hash);

      await expect(veriCert.connect(issuer).issue(hash)).to.be.revertedWithCustomError(veriCert, "AlreadyIssued").withArgs(hash);
    });

    it("rejects callers that are not approved issuers", async function () {
      const { outsider, veriCert, hash } = await loadFixture(deployFixture);

      await expect(veriCert.connect(outsider).issue(hash))
        .to.be.revertedWithCustomError(veriCert, "NotIssuer")
        .withArgs(outsider.address);
    });

    it("fails when no Receiver has been set", async function () {
      const { owner, routerAddress, chainSelector, hash } = await loadFixture(deployFixture);
      const unwired = await (await ethers.getContractFactory("VeriCert")).deploy(routerAddress, chainSelector);
      await unwired.addIssuer(owner.address);

      await expect(unwired.issue(hash)).to.be.revertedWithCustomError(unwired, "ReceiverNotSet");
    });

    it("is rejected by a Receiver that does not trust this VeriCert", async function () {
      const { owner, router, routerAddress, chainSelector, receiver, hash } = await loadFixture(deployFixture);
      const rogue = await (await ethers.getContractFactory("VeriCert")).deploy(routerAddress, chainSelector);
      await rogue.setReceiver(await receiver.getAddress());
      await rogue.addIssuer(owner.address);

      // The local simulator delivers in the same transaction, so a rejected delivery reverts the send.
      await expect(rogue.issue(hash)).to.be.revertedWithCustomError(router, "ReceiverError");
      expect((await receiver.getCredential(hash)).exists).to.equal(false);
    });
  });

  describe("revoke", function () {
    it("marks the credential revoked on both contracts", async function () {
      const { issuer, veriCert, receiver, hash } = await loadFixture(deployFixture);
      await veriCert.connect(issuer).issue(hash);

      const tx = veriCert.connect(issuer).revoke(hash);

      await expect(tx).to.emit(veriCert, "CredentialRevoked").withArgs(hash, issuer.address, anyValue);
      await expect(tx).to.emit(receiver, "CredentialRevoked").withArgs(hash, anyValue);
      expect((await veriCert.getCredential(hash)).revoked).to.equal(true);
      expect((await receiver.getCredential(hash)).revoked).to.equal(true);
    });

    it("lets any approved issuer revoke, and sends the original issuer in the message", async function () {
      const { owner, issuer, outsider, veriCert, receiver, hash } = await loadFixture(deployFixture);
      await veriCert.connect(issuer).issue(hash);
      await veriCert.connect(owner).addIssuer(outsider.address);

      await veriCert.connect(outsider).revoke(hash);

      const onFuji = await receiver.getCredential(hash);
      expect(onFuji.revoked).to.equal(true);
      expect(onFuji.issuer).to.equal(issuer.address);
    });

    it("rejects unknown and already-revoked hashes", async function () {
      const { issuer, veriCert, hash } = await loadFixture(deployFixture);

      await expect(veriCert.connect(issuer).revoke(hash)).to.be.revertedWithCustomError(veriCert, "NotIssued").withArgs(hash);
      await veriCert.connect(issuer).issue(hash);
      await veriCert.connect(issuer).revoke(hash);
      await expect(veriCert.connect(issuer).revoke(hash)).to.be.revertedWithCustomError(veriCert, "AlreadyRevoked").withArgs(hash);
    });

    it("rejects callers that are not approved issuers", async function () {
      const { issuer, outsider, veriCert, hash } = await loadFixture(deployFixture);
      await veriCert.connect(issuer).issue(hash);

      await expect(veriCert.connect(outsider).revoke(hash))
        .to.be.revertedWithCustomError(veriCert, "NotIssuer")
        .withArgs(outsider.address);
    });
  });

  describe("fees", function () {
    it("quotes the router fee", async function () {
      const { router, veriCert, hash } = await loadFixture(deployFixture);
      await router.setFee(1_000n);

      expect(await veriCert.quoteFee(ACTION_ISSUE, hash)).to.equal(1_000n);
      expect(await veriCert.quoteFee(ACTION_REVOKE, hash)).to.equal(1_000n);
    });

    it("rejects a payment below the fee", async function () {
      const { router, issuer, veriCert, hash } = await loadFixture(deployFixture);
      await router.setFee(1_000n);

      await expect(veriCert.connect(issuer).issue(hash, { value: 999n }))
        .to.be.revertedWithCustomError(veriCert, "InsufficientFee")
        .withArgs(1_000n, 999n);
    });

    it("pays exactly the fee to the router and refunds the rest", async function () {
      const { router, issuer, veriCert, hash } = await loadFixture(deployFixture);
      await router.setFee(1_000n);

      await expect(veriCert.connect(issuer).issue(hash, { value: 1_500n })).to.changeEtherBalances(
        [issuer, router, veriCert],
        [-1_000n, 1_000n, 0n]
      );
    });
  });

  describe("administration", function () {
    it("only lets the owner manage issuers, receiver and gas limit", async function () {
      const { outsider, veriCert } = await loadFixture(deployFixture);

      for (const call of [
        veriCert.connect(outsider).addIssuer(outsider.address),
        veriCert.connect(outsider).removeIssuer(outsider.address),
        veriCert.connect(outsider).setReceiver(outsider.address),
        veriCert.connect(outsider).setGasLimit(1n),
      ]) {
        await expect(call).to.be.revertedWithCustomError(veriCert, "OwnableUnauthorizedAccount").withArgs(outsider.address);
      }
    });

    it("stops a removed issuer from issuing", async function () {
      const { owner, issuer, veriCert, hash } = await loadFixture(deployFixture);

      await expect(veriCert.connect(owner).removeIssuer(issuer.address)).to.emit(veriCert, "IssuerRemoved").withArgs(issuer.address);
      await expect(veriCert.connect(issuer).issue(hash)).to.be.revertedWithCustomError(veriCert, "NotIssuer");
    });

    it("rejects zero addresses and records configuration changes", async function () {
      const { owner, veriCert } = await loadFixture(deployFixture);

      await expect(veriCert.connect(owner).addIssuer(ethers.ZeroAddress)).to.be.revertedWithCustomError(veriCert, "ZeroAddress");
      await expect(veriCert.connect(owner).setReceiver(ethers.ZeroAddress)).to.be.revertedWithCustomError(veriCert, "ZeroAddress");
      await expect(veriCert.connect(owner).setGasLimit(300_000n)).to.emit(veriCert, "GasLimitSet").withArgs(300_000n);
      expect(await veriCert.gasLimit()).to.equal(300_000n);
    });
  });
});
