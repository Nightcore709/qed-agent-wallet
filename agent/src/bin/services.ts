/**
 * Process entry point for one role: `tsx agent/src/bin/services.ts <cosigner|vendor|agent>`.
 * The parent (scripts/live.ts) passes exactly ONE private key in this process's environment.
 */
import { readFileSync } from "node:fs";
import type { Address, Hex } from "viem";
import { account, chain, loadDeployment, rpcConfig } from "../config.js";
import { serve } from "../net.js";
import { fromJson } from "../protocol/eip712.js";
import { PolicyEngine } from "../roles/cosigner.js";
import { DataVendor } from "../roles/vendor.js";
import { QEDAgent } from "../roles/agent.js";
import { makeBrain } from "../brain/index.js";

const role = process.argv[2];
const { chainId } = rpcConfig();
const dep = loadDeployment(chainId);
const c = chain();
const shared = fromJson<any>(readFileSync(process.env.QED_SHARED_FILE!, "utf8"));

async function main() {
  if (role === "cosigner") {
    const engine = new PolicyEngine(c, account("COSIGNER"), {
      vault: dep.vault,
      escrow: dep.escrow,
      owner: shared.owner,
      vendorKeys: { [String(shared.vendor).toLowerCase()]: shared.vendor, [String(shared.creditor).toLowerCase()]: shared.creditor },
      catalogPrices: { "helix-risk-model-2026-10": 6_000_000n },
      denylist: shared.denylist as Address[],
      deployBlock: BigInt(dep.deployBlock),
      recordsDir: process.env.QED_RECORDS_DIR! + "/cosigner",
    });
    await serve(Number(process.env.PORT), { "POST /certify": (b) => engine.evaluate(b), "GET /health": async () => ({ ok: true, cosigner: engine.address }) }, "cosigner");
  } else if (role === "vendor") {
    const v = new DataVendor(c, account("VENDOR"), BigInt(dep.deployBlock));
    await serve(
      Number(process.env.PORT),
      {
        "GET /catalog": async () => v.catalog(),
        "POST /invoice": (b) => v.invoice(b),
        "POST /deliver": (b) => v.deliver(b),
        "GET /health": async () => ({ ok: true, vendor: v.address }),
      },
      "vendor",
    );
  } else if (role === "agent") {
    const a = new QEDAgent(c, account("AGENT"), makeBrain(), {
      vault: dep.vault,
      escrow: dep.escrow,
      verifier: dep.verifier,
      token: dep.token,
      mandate: shared.mandate,
      ownerSig: shared.ownerSig as Hex,
      vendorUrl: process.env.VENDOR_URL!,
      cosignerUrl: process.env.COSIGNER_URL!,
      payees: shared.payees,
      deployBlock: BigInt(dep.deployBlock),
      recordsDir: process.env.QED_RECORDS_DIR! + "/agent",
    });
    await serve(
      Number(process.env.PORT),
      {
        "POST /rfq": (b) => a.handleRfq(b),
        "POST /poll": async () => a.pollJobs(),
        "POST /chat": (b) => a.chat(b.message, b.confirmation),
        "GET /health": async () => ({ ok: true, agent: a.address }),
      },
      "agent",
    );
  } else {
    throw new Error(`unknown role ${role}`);
  }
}

main().catch((e) => {
  console.error(`[${role}] fatal:`, e);
  process.exit(1);
});
