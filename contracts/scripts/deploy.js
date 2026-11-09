// IN PLAIN ENGLISH: a one-command setup script. It puts both smart contracts onto the two test
// blockchains, connects them so they trust each other, and approves our own wallet as a university that
// may issue degrees.
//
// Backup to deploying from Remix: deploys VeriCert on Polygon Amoy and Receiver on Avalanche Fuji,
// wires them together, and approves the deployer wallet as an issuer.
// Usage (from contracts/): npm run deploy:testnets   — needs AMOY_RPC_URL, FUJI_RPC_URL, DEPLOYER_PRIVATE_KEY in contracts/.env
const hre = require("hardhat");
const { ethers } = hre;

// Chainlink's published addresses and ID numbers for each test blockchain: the "post office" (router)
// on each chain and each chain's ID in Chainlink's system.
const AMOY = { router: "0x9C32fCB86BF0f4a1A8921a9Fe46de3198bb884B2", chainSelector: 16281711391670634445n };
const FUJI = { router: "0xF694E193200268f9a4868e4Aa017A0118C9a8177", chainSelector: 14767482510784806043n };

// Puts one compiled contract onto a blockchain and waits until it is live there.
async function deploy(name, wallet, args) {
  const artifact = await hre.artifacts.readArtifact(name);
  const contract = await new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet).deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

// Sends one transaction, waits until the blockchain confirms it, and prints its receipt number.
async function send(label, txPromise) {
  const tx = await txPromise;
  await tx.wait();
  console.log(`  ${label}: ${tx.hash}`);
}

async function main() {
  // Step 0: make sure the settings we need (blockchain connections and wallet key) have been filled in.
  const missing = ["AMOY_RPC_URL", "FUJI_RPC_URL", "DEPLOYER_PRIVATE_KEY"].filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Missing in contracts/.env: ${missing.join(", ")} (see .env.example)`);

  // Step 1: turn the contract source code into a form the blockchain can run, and connect the same
  // wallet to both blockchains.
  await hre.run("compile");
  const amoyWallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, new ethers.JsonRpcProvider(process.env.AMOY_RPC_URL));
  const fujiWallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, new ethers.JsonRpcProvider(process.env.FUJI_RPC_URL));
  console.log(`Deployer wallet: ${amoyWallet.address}`);

  // Step 2: put the issuing contract (VeriCert) on Amoy, pointed at Fuji as its destination.
  const veriCert = await deploy("VeriCert", amoyWallet, [AMOY.router, FUJI.chainSelector]);
  const veriCertAddress = await veriCert.getAddress();
  console.log(`VeriCert deployed on Amoy: ${veriCertAddress}`);

  // Step 3: put the receiving contract (Receiver) on Fuji, set to accept messages from Amoy.
  const receiver = await deploy("Receiver", fujiWallet, [FUJI.router, AMOY.chainSelector]);
  const receiverAddress = await receiver.getAddress();
  console.log(`Receiver deployed on Fuji: ${receiverAddress}`);

  // Step 4: introduce the two contracts to each other, and approve our wallet as an issuing university.
  console.log("Wiring contracts:");
  await send("Receiver.setAllowedSender", receiver.setAllowedSender(veriCertAddress));
  await send("VeriCert.setReceiver", veriCert.setReceiver(receiverAddress));
  await send("VeriCert.addIssuer", veriCert.addIssuer(amoyWallet.address));

  // Step 5: print the two contract addresses so the backend can be configured to use them.
  console.log(`\nAdd these to backend/.env:\nVERICERT_ADDRESS=${veriCertAddress}\nRECEIVER_ADDRESS=${receiverAddress}`);
}

// Run the steps above; if anything goes wrong, print the reason and report failure.
main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
