// Writes the Solidity standard-JSON input for each deployed contract to verification/<Name>.json, so that
// anyone (or Sourcify) can recompile the exact bytecode: same sources, same settings as foundry.toml.
//   node agent/scripts/sourcify-inputs.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const REMAP = [["@openzeppelin/contracts/", "lib/openzeppelin-contracts/contracts/"], ["forge-std/", "lib/forge-std/src/"]];
const resolve = (from, imp) => {
  for (const [p, t] of REMAP) if (imp.startsWith(p)) return t + imp.slice(p.length);
  return normalize(join(dirname(from), imp));
};
function collect(entry, acc = new Map()) {
  if (acc.has(entry)) return acc;
  const src = readFileSync(entry, "utf8");
  acc.set(entry, src);
  for (const m of src.matchAll(/^\s*import\s+(?:[^"']*from\s+)?["']([^"']+)["']/gm)) collect(resolve(entry, m[1]), acc);
  return acc;
}
const targets = {
  TestUSD: "contracts/src/TestUSD.sol",
  QEDVault: "contracts/src/QEDVault.sol",
  QEDLens: "contracts/src/QEDLens.sol",
  ProofEscrow: "contracts/src/ProofEscrow.sol",
  MinVarianceVerifier: "contracts/src/verifiers/MinVarianceVerifier.sol",
  QEDClearing: "contracts/src/QEDClearing.sol",
  Groth16Verifier: "contracts/src/verifiers/zk/Groth16Verifier.sol",
  PrivateMinVarianceVerifier: "contracts/src/verifiers/PrivateMinVarianceVerifier.sol",
  OptimalityBounty: "contracts/src/bounties/OptimalityBounty.sol",
  MaximalityBounty: "contracts/src/bounties/MaximalityBounty.sol",
  QEDExecution: "contracts/src/QEDExecution.sol",
  CPMMPool: "contracts/src/venues/CPMMPool.sol",
  TestToken: "contracts/src/venues/TestToken.sol",
};
mkdirSync("verification", { recursive: true });
for (const [name, file] of Object.entries(targets)) {
  const sources = Object.fromEntries([...collect(file)].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, content]) => [p, { content }]));
  const input = {
    language: "Solidity",
    sources,
    settings: {
      remappings: REMAP.map(([a, b]) => `${a}=${b}`),
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      evmVersion: "cancun",
      metadata: { bytecodeHash: "none", appendCBOR: false },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "evm.deployedBytecode.immutableReferences", "metadata"] } },
      libraries: {},
    },
  };
  writeFileSync(`verification/${name}.json`, JSON.stringify(input));
  console.log(name, Object.keys(sources).length, "sources");
}
