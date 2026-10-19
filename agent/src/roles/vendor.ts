/**
 * Helix Data — an independent data-vendor agent. Sells a licensed risk model. It issues signed
 * invoices, and releases the data only after it can SEE the payment on-chain (it trusts the chain,
 * not the buyer's word).
 */
import { getAddress, keccak256, toHex, type Address, type Hex, type LocalAccount } from "viem";
import { QEDVaultAbi } from "../abi/contracts.js";
import type { Chain$ } from "../chain.js";
import { HELIX_ASSETS, helixSpec, specHash } from "../engine/riskModel.js";
import { invoiceDigest, type Invoice } from "../protocol/records.js";

export const HELIX_PRODUCT = {
  productId: "helix-risk-model-2026-10",
  title: "Helix Risk Model — Oct 2026 (6-asset covariance, illustrative)",
  price: 6_000_000n,
  assets: [...HELIX_ASSETS],
};

export const helixCommitment = (): Hex => specHash(helixSpec());

export class DataVendor {
  private invoices = new Map<string, Invoice>();
  private counter = 0;
  constructor(
    private chain: Chain$,
    private key: LocalAccount,
    private deployBlock: bigint,
  ) {}

  get address() {
    return this.key.address;
  }

  catalog() {
    return {
      vendor: this.key.address,
      products: [{ ...HELIX_PRODUCT, dataCommitment: helixCommitment(), tolerance: "1e-9" }],
    };
  }

  async invoice(req: { productId: string; buyer: Address; jobId: string }): Promise<{ invoice: Invoice; signature: Hex }> {
    if (req.productId !== HELIX_PRODUCT.productId) throw new Error("unknown product");
    const now = Math.floor(Date.now() / 1000);
    const inv: Invoice = {
      invoiceId: `HELIX-${now}-${++this.counter}`,
      productId: HELIX_PRODUCT.productId,
      title: HELIX_PRODUCT.title,
      vendor: this.key.address,
      payTo: this.key.address,
      buyer: getAddress(req.buyer),
      amount: HELIX_PRODUCT.price.toString(),
      dataCommitment: helixCommitment(),
      jobId: req.jobId,
      issuedAt: now,
      expiresAt: now + 3600,
    };
    this.invoices.set(inv.invoiceId, inv);
    const signature = await this.key.signMessage({ message: { raw: invoiceDigest(inv) } });
    return { invoice: inv, signature };
  }

  /** Releases the licensed data only if a matching on-chain payment exists. */
  async deliver(req: { invoiceId: string }) {
    const inv = this.invoices.get(req.invoiceId);
    if (!inv) throw new Error("unknown invoice");
    const ref = keccak256(toHex(inv.invoiceId));
    const logs = (await this.chain.pub.getContractEvents({
      address: inv.buyer,
      abi: QEDVaultAbi,
      eventName: "PaymentExecuted",
      fromBlock: this.deployBlock,
    })) as any[];
    const paid = logs.find(
      (l) => l.args.ref === ref && getAddress(l.args.recipient) === getAddress(this.key.address) && BigInt(l.args.amount) >= BigInt(inv.amount),
    );
    if (!paid) throw new Error("no matching on-chain payment found — data not released");
    const spec = helixSpec();
    const payload = {
      productId: inv.productId,
      invoiceId: inv.invoiceId,
      paymentTx: paid.transactionHash as Hex,
      n: spec.n,
      assets: HELIX_PRODUCT.assets,
      cov: spec.cov.map(String),
      tol: spec.tol.toString(),
      universe: spec.universe,
      dataCommitment: inv.dataCommitment,
    };
    const signature = await this.key.signMessage({ message: JSON.stringify(payload) });
    return { payload, signature };
  }
}
