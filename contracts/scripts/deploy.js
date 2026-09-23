// Backup to deploying from Remix: deploys VeriCert on Polygon Amoy and Receiver on Avalanche Fuji,
// wires them together, and approves the deployer wallet as an issuer.
// Usage (from contracts/): npm run deploy:testnets   — needs AMOY_RPC_URL, FUJI_RPC_URL, DEPLOYER_PRIVATE_KEY in contracts/.env
const hre = require("hardhat");
const { ethers } = hre;

const AMOY = { router: "0x9C32fCB86BF0f4a1A8921a9Fe46de3198bb884B2", chainSelector: 16281711391670634445n };
const FUJI = { router: "0xF694E193200268f9a4868e4Aa017A0118C9a8177", chainSelector: 14767482510784806043n };

async function deploy(name, wallet, args) {
  const artifact = await hre.artifacts.readArtifact(name);
  const contract = await new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet).deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

async function send(label, txPromise) {
  const tx = await txPromise;
  await tx.wait();
  console.log(`  ${label}: ${tx.hash}`);
}

async function main() {
  const missing = ["AMOY_RPC_URL", "FUJI_RPC_URL", "DEPLOYER_PRIVATE_KEY"].filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Missing in contracts/.env: ${missing.join(", ")} (see .env.example)`);

  await hre.run("compile");
  const amoyWallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, new ethers.JsonRpcProvider(process.env.AMOY_RPC_URL));
  const fujiWallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, new ethers.JsonRpcProvider(process.env.FUJI_RPC_URL));
  console.log(`Deployer wallet: ${amoyWallet.address}`);

  const veriCert = await deploy("VeriCert", amoyWallet, [AMOY.router, FUJI.chainSelector]);
  const veriCertAddress = await veriCert.getAddress();
  console.log(`VeriCert deployed on Amoy: ${veriCertAddress}`);

  const receiver = await deploy("Receiver", fujiWallet, [FUJI.router, AMOY.chainSelector]);
  const receiverAddress = await receiver.getAddress();
  console.log(`Receiver deployed on Fuji: ${receiverAddress}`);

  console.log("Wiring contracts:");
  await send("Receiver.setAllowedSender", receiver.setAllowedSender(veriCertAddress));
  await send("VeriCert.setReceiver", veriCert.setReceiver(receiverAddress));
  await send("VeriCert.addIssuer", veriCert.addIssuer(amoyWallet.address));

  console.log(`\nAdd these to backend/.env:\nVERICERT_ADDRESS=${veriCertAddress}\nRECEIVER_ADDRESS=${receiverAddress}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
