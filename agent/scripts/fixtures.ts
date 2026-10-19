/**
 * Generates Solidity test fixtures from the TypeScript certifying solver, so that the on-chain
 * checker is tested against exactly the bytes the live agent will submit.
 *   npm run fixtures  →  contracts/test/fixtures/minvar.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { keccak256 } from "viem";
import { certify, checkCertificate, counterfeitEqualWeight, counterfeitNudged } from "../src/engine/minvar.js";
import { encodeSolution, encodeSpec, helixSpec } from "../src/engine/riskModel.js";

const spec = helixSpec();
const honest = certify(spec);
const report = checkCertificate(spec, honest);
if (!report.ok) throw new Error("honest certificate failed local check: " + report.violations.join(","));

const badPsd = { ...honest, L: honest.L.map((x, i) => (i === 0 ? x + 10n ** 15n : x)) };

const fixture = {
  n: spec.n,
  tol: spec.tol.toString(),
  spec: encodeSpec(spec),
  specHash: keccak256(encodeSpec(spec)),
  honest: encodeSolution(honest),
  honestW: honest.w.map(String),
  honestNu: honest.nu.toString(),
  variance: report.variance.toString(),
  equalWeight: encodeSolution(counterfeitEqualWeight(spec)),
  nudged1bp: encodeSolution(counterfeitNudged(spec, 1n)),
  badPsd: encodeSolution(badPsd),
};

mkdirSync("contracts/test/fixtures", { recursive: true });
writeFileSync("contracts/test/fixtures/minvar.json", JSON.stringify(fixture, null, 2));
console.log("wrote contracts/test/fixtures/minvar.json  variance =", report.variance.toString());
