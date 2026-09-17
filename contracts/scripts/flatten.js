// Writes single-file copies of the contracts to flat/ for deploying from Remix,
// and fails if a flattened file does not compile on its own with the project's compiler settings.
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const solc = require("solc");

const CONTRACTS = ["VeriCert", "Receiver"];

function compileErrors(fileName, source) {
  const input = {
    language: "Solidity",
    sources: { [fileName]: { content: source } },
    settings: { ...hre.config.solidity.compilers[0].settings, outputSelection: { "*": { "*": ["abi"] } } },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  return (output.errors || []).filter((e) => e.severity === "error").map((e) => e.formattedMessage);
}

async function main() {
  const outDir = path.join(__dirname, "..", "flat");
  fs.mkdirSync(outDir, { recursive: true });

  for (const name of CONTRACTS) {
    const source = await hre.run("flatten:get-flattened-sources", { files: [`contracts/${name}.sol`] });
    const errors = compileErrors(`${name}.sol`, source);
    if (errors.length) throw new Error(`flat/${name}.sol does not compile:\n${errors.join("\n")}`);
    fs.writeFileSync(path.join(outDir, `${name}.sol`), source);
    console.log(`Wrote flat/${name}.sol (compiles with solc ${solc.version()})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
