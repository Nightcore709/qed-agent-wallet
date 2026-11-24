/**
 * Builds the dashboard from verified evidence:
 *   site/index.html + site/data.json   → GitHub Pages (live chain reads from a public RPC)
 *   dist/qed-proof-ledger.html          → self-contained page with the evidence embedded
 *   EVIDENCE=evidence/ethereum-sepolia npm run build:app
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { toFunctionSelector } from "viem";

const EV = process.env.EVIDENCE ?? "evidence/ethereum-sepolia";
const read = (p: string) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : undefined);

const manifest = read(`${EV}/manifest.json`);
if (!manifest) throw new Error(`no manifest in ${EV}`);
const portfolio = read(`${EV}/portfolio.json`);
const conversation = read(`${EV}/conversation.json`);
const honeypot = read(`${EV}/honeypot.json`);
const redteam = read("evidence/redteam/report.json")?.summary;

// μ multipliers of zero-weight assets, from the agent's fulfilment record
let portfolioMu: Record<string, string> = {};
const recDir = `${EV}/records/agent`;
if (existsSync(recDir)) {
  const f = readdirSync(recDir).find((x) => x.startsWith("fulfilment-"));
  if (f && portfolio) {
    const rec = JSON.parse(readFileSync(`${recDir}/${f}`, "utf8"));
    const mu: string[] = rec.body.solution.mu;
    portfolio.weights.forEach((w: any, i: number) => {
      if (w.weight === 0) portfolioMu[w.asset] = (Number(mu[i]) / 1e18).toExponential(2);
    });
  }
}
const x17 = manifest.steps.find((s: any) => s.id === "X17");
const lazyGap = x17?.error?.args?.[0] ? Number(x17.error.args[0]) / 1e18 : undefined;

// strip things the page never needs (keeps the embedded copy small)
const slimManifest = {
  ...manifest,
  steps: manifest.steps.map((s: any) => ({ ...s, events: undefined })),
};

const clrManifest = read(`${EV}/clearing/manifest.json`);
const clearing = clrManifest
  ? {
      contracts: clrManifest.contracts,
      final: clrManifest.final,
      sepolia: clrManifest.sepolia,
      steps: clrManifest.steps.map((s: any) => ({ ...s, events: undefined })),
      proof: read(`${EV}/clearing/proof.json`),
    }
  : undefined;

const privManifest = read(`${EV}/private/manifest.json`);
const priv = privManifest
  ? { contracts: privManifest.contracts, final: privManifest.final, sepolia: privManifest.sepolia, actors: privManifest.actors, steps: privManifest.steps.map((s: any) => ({ ...s, events: undefined })) }
  : undefined;

const exManifest = read(`${EV}/execution/manifest.json`);
const exec = exManifest
  ? {
      contracts: exManifest.contracts,
      final: exManifest.final,
      sepolia: exManifest.sepolia,
      actors: exManifest.actors,
      venues: exManifest.venues,
      orders: exManifest.orders,
      plans: { A3: exManifest.plans.A3, A6: exManifest.plans.A6 },
      policyRun: exManifest.policyRun,
      policyChain: exManifest.policyChain,
      bounty: exManifest.bounty,
      steps: exManifest.steps.map((s: any) => ({ ...s, events: undefined })),
    }
  : undefined;

const D = {
  clearing,
  priv,
  exec,
  manifest: slimManifest,
  portfolio,
  portfolioMu,
  lazyGap,
  conversation,
  honeypot,
  redteam,
  selectors: { snapshot: toFunctionSelector("snapshot(address)"), totalCleared: toFunctionSelector("totalCleared()"), grossOpen: toFunctionSelector("grossOpen()"), balanceOf: toFunctionSelector("balanceOf(address)") },
  repo: "https://github.com/Nightcore709/qed-agent-wallet",
  builtAt: new Date().toISOString(),
};

const src = readFileSync("app/index.html", "utf8");
const json = JSON.stringify(D).replace(/</g, "\\u003c");

mkdirSync("site", { recursive: true });
writeFileSync("site/data.json", JSON.stringify(D));
const cut = src.indexOf("</style>") + "</style>".length;
writeFileSync(
  "site/index.html",
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect x='3' y='3' width='10' height='10' fill='%230a7468'/%3E%3C/svg%3E">\n${src.slice(0, cut)}\n<style>body{margin:0}</style>\n</head>\n<body>\n${src.slice(cut)}\n</body>\n</html>\n`,
);
mkdirSync("dist", { recursive: true });
writeFileSync("dist/qed-proof-ledger.html", src.replace("__QED_DATA__", json));
console.log(`built site/ and dist/qed-proof-ledger.html (${(json.length / 1024).toFixed(0)} KB data)`);
