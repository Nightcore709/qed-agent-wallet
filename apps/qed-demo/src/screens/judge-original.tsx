/**
 * The original QED's public-chain and mathematical evidence, for judges: what it proved on Ethereum Sepolia on 19 and 20
 * October 2026, which protection refused each attack, the guarantees with their assumptions, and how to check it all
 * without trusting this page. Every statement is taken from the published repository's README.md and docs/EVIDENCE.md;
 * the attack rows join EVIDENCE.md's table to the vendored manifests by step id, so each link is the recorded hash.
 * Historical only: this build does not use those contracts (it runs its own mandates and co-signer on its own test chain).
 */
import type { ReactNode } from 'react'

const REPO = 'https://github.com/Nightcore709/qed-agent-wallet'
const tx = (h: string) => `https://sepolia.etherscan.io/tx/${h}`
const src = (p: string) => `${REPO}/blob/main/${p}`

type Tx = { id?: string; hash: string; status?: string }

/** docs/EVIDENCE.md, "Attack transactions (19)": step, attack, the custom error that refused it, and where. */
const ATTACKS: [id: string, attack: string, error: string, layer: string][] = [
  ['X2', "Tamper with the agent's quote: price 15 → 1 tUSD", 'BadProviderSignature', 'ProofEscrow'],
  ['X3', "Redirect the agent's payee to the attacker", 'BadProviderSignature', 'ProofEscrow'],
  ['X5', 'Stolen agent key with a forged co-signature', 'BadCosignerSignature', 'QEDVault'],
  ['X6', 'Both hot keys stolen: a genuinely co-signed payment to the attacker', 'PayeeNotInMandate', 'QEDVault'],
  ['X7', 'Stolen keys with a mandate the attacker signed', 'BadOwnerSignature', 'QEDVault'],
  ['X8', "Reuse the agent's real certificate with the amount changed 6 → 9", 'BadCosignerSignature', 'QEDVault'],
  ['X9', 'The same certificate redirected to another approved payee', 'BadCosignerSignature', 'QEDVault'],
  ['X10', 'Replay the exact genuine certificate', 'IntentAlreadyUsed', 'QEDVault'],
  ['X11', 'Both hot keys: pay one dollar more than the free balance', 'SolvencyViolation', 'QEDVault'],
  ['X12', "Both hot keys: pay above the day's remaining limit", 'ExceedsDailyCap', 'QEDVault'],
  ['X13', 'Stolen agent key calls withdraw()', 'NotOwner', 'QEDVault'],
  ['X14', "Stolen agent key releases a creditor's ring fence", 'NotCreditor', 'QEDVault'],
  ['X15', 'Stolen agent key raises the daily cap', 'NotOwner', 'QEDVault'],
  ['X17', 'A lazy 1/N portfolio dressed with the best possible multipliers', 'DualityGapTooLarge', 'MinVarianceVerifier'],
  ['X18', "An 'almost optimal' portfolio (optimum shifted 0.01%)", 'StationarityViolated', 'MinVarianceVerifier'],
  ['H4', 'Published keys: pay the attacker 10 tUSD', 'PayeeNotInMandate', 'QEDVault'],
  ['H5', 'Published keys: pay a creditor 50 tUSD early', 'ExceedsPerPaymentCap', 'QEDVault'],
  ['H6', 'Published agent key calls withdraw()', 'NotOwner', 'QEDVault'],
  ['P2', 'While paused, a fully valid agent payment', 'VaultPaused', 'QEDVault'],
]

/** README.md: refusals in the later runs (clearing, zero-knowledge, bounties), with their recorded hashes. */
const LATER: [label: string, what: string, result: string, hash: string][] = [
  ['N1', 'A naive shortest-cycle-first netting', 'NotProvablyMaximal(162, 169)', '0x1b62ae8cbdd1fcaacda3f3305b880e75b504c712575389e7ad780c69c4724976'],
  ['N2', "A netting that cancels 1 tUSD more of one member's debt", 'NetPositionChanged(Northwind, 1)', '0x29c4ef66a5eb98558fce184b0058cf295bc39e095e8eccf58ec6ba99172b3eaf'],
  ['N7', 'Replay the proven netting', 'IncompleteSnapshot', '0x4588659bad4770f283e3600885b6dabbb95e8b734fb5c27c14ac491acc2e4df5'],
  ['ZA1', "Replay QED's zero-knowledge proof in another job", 'ProofRejected', '0xbe69abd9db0d21661c45e34dcbb8351363917c534b180196eaaae1a607e6d28e'],
  ['ZA3', 'A genuine proof about data the attacker attested herself', 'UntrustedDataAttestation', '0x35bbaa47631852c780312e00431e77d28decb6bce43b5d8621f22fb2582625b7'],
  ['BA1', 'Claim the optimality bounty with an equal-weight portfolio', 'TheoremHolds', '0x6a5849455a07b9fcf279d197b1ad2fe0de8d8b7d260328f54150c138b028d19d'],
  ['BM1', 'Claim the maximality bounty with the naive 162 tUSD netting', 'TheoremHolds(169, 162)', '0x47ef93bf3c1a6eea445dc7f0c1b6ccc4c013105c49da0b508130db38f06562bb'],
]

/** README.md, "The idea in eight sentences" and the run sections: each guarantee, what it assumes, its public evidence. */
const GUARANTEES: { name: string; what: string; assumes: string; evidence: [string, string][]; source: [string, string][] }[] = [
  {
    name: 'Three layers on every payment, and a ring fence for creditors',
    what: "The AI's key can call one function. A payment needs an owner-signed mandate and a certificate from an independent co-signer (a separate process and key, 12 policy checks), and must keep an on-chain solvency invariant that ring-fences money owed to creditors. Pausing stops the AI, never the creditors.",
    assumes: "The owner's key is safe. QEDLens.blastRadius gives the most the vault can lose if both hot keys are stolen; that it is an upper bound is checked by fuzz tests, not a formal proof.",
    evidence: [['L4: the agent key pays under mandate and certificate', '0x56a2334eaf8ef1a22323b456f608851a571295a9adac3fb1a8c379c5e58b83b6']],
    source: [['QEDVault.sol', 'contracts/src/QEDVault.sol'], ['QEDLens.sol', 'contracts/src/QEDLens.sol']],
  },
  {
    name: 'Best execution, proved at the moment of the trade',
    what: "The agent may route a conversion as it likes but must attach one price per token. From those prices and the live reserves of every venue the owner allows, QEDExecution computes in the same transaction an upper bound on what any route could return (weak Lagrangian duality, every rounding upward) and refuses the trade if what arrived is more than 1 ppm below it.",
    assumes: "Constant-product venues, and only the venues the owner allows; the bound is computed on the state the trade executes on.",
    evidence: [],
    source: [['QEDExecution.sol', 'contracts/src/QEDExecution.sol'], ['Run 4 in the evidence', 'docs/EVIDENCE.md#run-4--best-execution-proved-at-the-instant-of-the-trade-qedexecution']],
  },
  {
    name: "The owner's treasury policy as a contract",
    what: "QEDTreasuryPolicy is the execution module's only operator. In the trade's own transaction it refuses a conversion when the reserve already meets its target, when the tranche is outside the owner's bounds, when its cost exceeds the owner's limit against the direct venues' mid price, or when a smaller tranche provably covered the shortfall (the best output is concave with OPT(0) = 0).",
    assumes: "The target, bounds and cost limit the owner set, and the owner's venue set.",
    evidence: [],
    source: [['QEDTreasuryPolicy.sol', 'contracts/src/QEDTreasuryPolicy.sol'], ['Algorithms §12.9', 'docs/ALGORITHMS.md#129-the-policy-as-a-contract-qedtreasurypolicy']],
  },
  {
    name: 'Certified clearing of an agent economy',
    what: "Five AI businesses owe each other 200 tUSD and hold 28 tUSD. Anyone may submit a netting; QEDClearing executes it only if every member's net position is unchanged, no debt goes below zero or is created, every open debt is covered, and an exact linear-programming duality certificate proves no larger netting exists. QED's netting cancelled 169 tUSD (gross 200 → 31) and moved no token.",
    assumes: "The obligations as recorded at the snapshot; 'largest' means the most debt cancelled.",
    evidence: [['N6: the proven netting executes', '0x46288ece141a762a1889eb8e4692b6a19719643b341e0dd31a1e4166c51a05a2']],
    source: [['QEDClearing.sol', 'contracts/src/QEDClearing.sol']],
  },
  {
    name: 'AI work paid for a proof of optimality',
    what: "In ProofEscrow a client pays only when the delivered answer passes an on-chain optimality check (exact-integer KKT conditions and a positive-semidefiniteness witness). A lazy or dishonest provider is refused and the client refunded (X17, X18 below).",
    assumes: "The problem as posed (a minimum-variance portfolio); the check proves the answer optimal for the stated inputs, not that the inputs are true.",
    evidence: [],
    source: [['ProofEscrow.sol', 'contracts/src/ProofEscrow.sol'], ['Verifiers', 'contracts/src/verifiers']],
  },
  {
    name: 'Optimality proved in zero knowledge',
    what: 'A Groth16 proof, verified on chain, shows a portfolio optimal for a data model its vendor attested by commitment; the escrow paid on that proof and the chain never saw the model or the portfolio.',
    assumes: 'The proving parameters came from a local ceremony and must be trusted (the release lists this as risk K18). In this build the zero-knowledge part is switched off.',
    evidence: [['Z3: the escrow pays on the proof', '0xbb619bf09eebacd240514eab5ec4a03c189612954101b07c59a11fa56f612ec7']],
    source: [['Circuit', 'circuits'], ['Groth16Verifier', 'contracts/src/verifiers']],
  },
  {
    name: 'Theorems with money on them',
    what: "Bounty contracts each hold 1,000 tUSD and pay it automatically to anyone who refutes on chain the optimality theorem, the clearing's maximality theorem or the best-execution bound. Every attempt so far reverted with the gap it could not close.",
    assumes: 'The pools are test tokens on a test network; the repository checks daily that the optimality and maximality pools are still full.',
    evidence: [['BA1: an equal-weight portfolio fails to refute it', '0x6a5849455a07b9fcf279d197b1ad2fe0de8d8b7d260328f54150c138b028d19d']],
    source: [['Bounties', 'contracts/src/bounties'], ['Algorithms §11', 'docs/ALGORITHMS.md#11-theorems-with-money-on-them-optimalitybounty-maximalitybounty']],
  },
]

const Ext = ({ href, children }: { href: string; children: ReactNode }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>

export function OriginalEvidence({ transactions }: { transactions: Tx[] | undefined }) {
  const byId = new Map((transactions ?? []).filter((t) => t.id).map((t) => [t.id!, t]))
  return (
    <div className="jg-orig">
      <h3>What the original QED proved on a public network</h3>
      <ul className="jg-hist-runs">
        <li><b>A separate AI-agent key paid only under the owner&apos;s signed mandate and an independent co-signer&apos;s certificate.</b> <Ext href={tx('0x56a2334eaf8ef1a22323b456f608851a571295a9adac3fb1a8c379c5e58b83b6')}>See L4 on the explorer</Ext></li>
        <li><b>Paid AI work settled in escrow on a zero-knowledge proof of optimality.</b> <Ext href={tx('0xbb619bf09eebacd240514eab5ec4a03c189612954101b07c59a11fa56f612ec7')}>See Z3</Ext></li>
        <li><b>Five AI businesses cleared 169 tUSD of debt by proof, moving no token.</b> <Ext href={tx('0x46288ece141a762a1889eb8e4692b6a19719643b341e0dd31a1e4166c51a05a2')}>See N6</Ext></li>
        <li><b>Every attack below was refused on the chain with exactly the error it was designed to meet.</b></li>
      </ul>

      <h3>The guarantees, and what each one assumes</h3>
      <div className="jg-guar">
        {GUARANTEES.map((g) => (
          <details key={g.name}>
            <summary>{g.name}</summary>
            <p>{g.what}</p>
            <p><b>Assumes:</b> {g.assumes}</p>
            <p className="small">
              {g.evidence.map(([label, h]) => <span key={h}><Ext href={tx(h)}>{label}</Ext> · </span>)}
              {g.source.map(([label, p], i) => <span key={p}>{i ? ' · ' : ''}<Ext href={src(p)}>{label}</Ext></span>)}
            </p>
          </details>
        ))}
      </div>

      <h3>19 attacks on the vault, each refused on the chain</h3>
      <div className="jg-scroll" role="region" aria-label="The 19 refused attacks" tabIndex={0}>
        <table className="ledger">
          <thead><tr><th scope="col">Attack</th><th scope="col">Refused by</th><th scope="col">Transaction</th></tr></thead>
          <tbody>
            {ATTACKS.map(([id, attack, error, layer]) => {
              const t = byId.get(id)
              return (
                <tr key={id}>
                  <td>{attack}</td>
                  <td><code>{error}</code> in {layer}</td>
                  <td>{t ? <Ext href={tx(t.hash)}>{id}{t.status === 'reverted' ? ', reverted' : ''}</Ext> : <span>{id} (see the evidence document)</span>}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <details className="jg-more">
        <summary>More refusals in the later runs (clearing, zero knowledge, bounties)</summary>
        <ul className="jg-hist-runs">
          {LATER.map(([label, what, result, h]) => <li key={label}>{what}: <code>{result}</code>. <Ext href={tx(h)}>See {label}</Ext></li>)}
        </ul>
      </details>

      <h3>Check it without trusting this page</h3>
      <ul className="jg-hist-runs">
        <li><code>npm run verify</code> in the published repository re-derives every claim from a public node with no keys: deployed bytecode against the compiled source, every receipt, every revert&apos;s error, the signatures and the certificates. The repository&apos;s own check runs it on every change and daily; <Ext href={`${REPO}/actions/runs/45753369154`}>it last passed on 26 November 2026</Ext>.</li>
        <li><code>forge test</code> runs 145 Solidity tests (invariants with both hot keys stolen, clearing economies, a real zero-knowledge proof attacked, best-execution fuzzers); <code>npx tsx benchmarks/run.ts</code> reproduces the benchmarks.</li>
        <li><Ext href={src('docs/EVIDENCE.md')}>The evidence document</Ext> · <Ext href={src('verification/README.md')}>Verified contract sources</Ext> · <Ext href={`${REPO}/tree/main/contracts/src`}>The contracts</Ext> · <Ext href={src('docs/ALGORITHMS.md')}>The mathematics</Ext> · <Ext href={src('docs/SECURITY.md')}>Known risks</Ext></li>
      </ul>

      <h3>Limits, stated plainly</h3>
      <p>A test-network prototype with a valueless token, not audited. The transactions were signed against a replica of the network and sent unchanged; every public receipt was compared with the replica&apos;s (the evidence document discloses how). These contracts are not used by this build: here, owner-signed mandates, the independent co-signer and refusals run on this build&apos;s own test chain, and nothing is sent to the public network.</p>
    </div>
  )
}
