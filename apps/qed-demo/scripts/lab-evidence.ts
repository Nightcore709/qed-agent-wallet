/**
 * The Portfolio lab's research evidence (R12): the recorded R11 portfolio run, read from its committed result files and
 * written to server/lab-research.json with the SHA-256 of every file it came from, so each figure the lab shows as
 * "research" can be traced to its file and checked against it. Nothing here is recomputed or re-run: these are the
 * run's own numbers (historical simulation on public data; docs/research/qed-quant-finance/20261124-portfolio-intelligence.md).
 *
 *   node scripts/lab-evidence.ts            rewrite server/lab-research.json
 *   node scripts/lab-evidence.ts --check    exit 1 if the file no longer matches the result files
 *
 * The monthly net returns of the five baselines are kept (rounded to 1e-7) so the lab can redraw their growth and
 * recompute their CAGR and drawdowns from the series itself, and show that recomputation agrees with the run's table.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const APP = join(import.meta.dirname, '..')
const REPO = resolve(APP, '..', '..')
const EXP = join(REPO, 'experiments', 'r11-portfolio')
const R = join(EXP, 'results')
const OUT = join(APP, 'server', 'lab-research.json')

const files: { path: string; sha256: string }[] = []
function read(path: string): string {
  const text = readFileSync(path, 'utf8')
  files.push({ path: relative(REPO, path), sha256: createHash('sha256').update(readFileSync(path)).digest('hex') })
  return text
}
function csv(path: string): Record<string, string>[] {
  const lines = read(path).trim().split(/\r?\n/)
  const split = (l: string): string[] => { const out: string[] = []; let cur = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) { out.push(cur); cur = '' } else cur += ch } out.push(cur); return out }
  const head = split(lines[0]!).map((h, i) => (h === '' && i === 0 ? 'key' : h))
  return lines.slice(1).map((l) => Object.fromEntries(split(l).map((v, i) => [head[i]!, v])))
}
const num = (v: string | undefined): number | null => (v === undefined || v === '' || v === 'nan' ? null : Number(v))
const r6 = (x: number | null): number | null => (x === null ? null : Math.round(x * 1e6) / 1e6)

const LABEL: Record<string, [string, 'baseline' | 'optimiser']> = {
  EW: ['Equal weight (1/N), monthly', 'baseline'], VW_MKT: ['US market, held', 'baseline'], B6040: ['60/40 market and 10-year Treasury', 'baseline'],
  MINV_LW: ['Minimum variance (shrunk covariance)', 'baseline'], RP_LW: ['Risk parity (equal risk contribution)', 'baseline'],
  MV_BS: ['Mean-variance, Bayes-Stein means', 'optimiser'], MV_BS_TC: ['Mean-variance with trading costs', 'optimiser'], RMV_ELL: ['Robust mean-variance', 'optimiser'],
  MCVAR: ['Mean-CVaR', 'optimiser'], DRO_MCVAR: ['Wasserstein DRO mean-CVaR', 'optimiser'], MCVAR_K4: ['Mean-CVaR, at most 4 assets (MIP)', 'optimiser'], REGIME_MV: ['Regime-switching mean-variance', 'optimiser'],
}

const run = JSON.parse(read(join(R, 'core_w120', 'run_manifest.json'))) as { seed: number; window: number; start: string; end: string; c_equity: number; c_bond: number; data_sha256: Record<string, string> }
const manifest = JSON.parse(read(join(EXP, 'data', 'MANIFEST.json'))) as { sources: Record<string, { publisher: string; url: string; accessed_utc: string; sha256: string; licence_note?: string }> }
const prereg = read(join(R, 'PREREGISTRATION.sha256')).trim()
const perf = csv(join(R, 'core_w120', 'analysis', 'perf_full.csv'))
const tests = csv(join(R, 'core_w120', 'analysis', 'tests_vs_EW.csv'))
const t1 = csv(join(R, 'core_w120', 'analysis', 'tests_vs_EW_1972_1999.csv'))
const t2 = csv(join(R, 'core_w120', 'analysis', 'tests_vs_EW_2000_2026.csv'))
const cost = csv(join(R, 'core_w120', 'analysis', 'cost_sensitivity_sharpe.csv'))
const net = csv(join(R, 'core_w120', 'net.csv'))
const household = csv(join(R, 'household', 'summary.csv'))
const hgTests = csv(join(R, 'household', 'tests_growth_vs_EW.csv'))
const rebEW = csv(join(R, 'studies', 'rebalancing_ew.csv')), reb6040 = csv(join(R, 'studies', 'rebalancing_6040.csv'))
const hedgeL = csv(join(R, 'studies', 'hedging_usd_liability.csv')), hedgeS = csv(join(R, 'studies', 'hedging_equity_fx.csv'))
const varbt = csv(join(R, 'studies', 'var_backtests.csv')), worst = csv(join(R, 'studies', 'worst_months.csv'))
const cases = csv(join(R, 'guarantee', 'cases.csv'))

const byKey = (rows: Record<string, string>[], k: string) => new Map(rows.map((r) => [r[k]!, r]))
const T = byKey(tests, 'strategy'), T1 = byKey(t1, 'strategy'), T2 = byKey(t2, 'strategy'), C = byKey(cost, 'strategy')
const strategies = perf.map((p) => {
  const id = p.strategy!, t = T.get(id), a = T1.get(id), b = T2.get(id), c = C.get(id)
  return {
    id, label: LABEL[id]?.[0] ?? id, kind: LABEL[id]?.[1] ?? 'optimiser',
    cagr: r6(num(p.cagr)), vol: r6(num(p.ann_vol)), sharpe: r6(num(p.sharpe)), sortino: r6(num(p.sortino)), maxDD: r6(num(p.max_dd)), cvar95: r6(num(p.cvar95_month)), worstMonth: r6(num(p.worst_month)),
    turnover: r6(num(p.turnover_month)), costDrag: r6(num(p.cost_drag_ann)),
    vsEW: t ? { diff: r6(num(t.sharpe_diff_ann)), pHac: r6(num(t.p_hac)), pBoot: r6(num(t.p_boot)), pFwer: r6(num(t.p_maxt_fwer)), early: a ? { diff: r6(num(a.sharpe_diff_ann)), pFwer: r6(num(a.p_maxt_fwer)) } : null, late: b ? { diff: r6(num(b.sharpe_diff_ann)), pFwer: r6(num(b.p_maxt_fwer)) } : null } : null,
    sharpeAtCost: c ? { bp0: r6(num(c['0bp'])), bp10: r6(num(c['10bp'])), bp25: r6(num(c['25bp'])), bp50: r6(num(c['50bp'])) } : null,
  }
})
const KEEP = ['EW', 'B6040', 'RP_LW', 'MINV_LW', 'VW_MKT']
const series = Object.fromEntries(KEEP.map((k) => [k, net.map((r) => Math.round(Number(r[k]) * 1e7) / 1e7)]))
const hg = byKey(hgTests, hgTests[0] && 'strategy' in hgTests[0] ? 'strategy' : 'key')

const out = {
  label: 'Research: historical simulation on public data',
  caveat: 'Every figure here is a historical simulation of the R11 study, net of the stated costs. It is not a forecast and not advice. The household is synthetic.',
  source: {
    note: 'docs/research/qed-quant-finance/20261124-portfolio-intelligence.md', experiment: 'experiments/r11-portfolio', author: 'qed-quant-finance', date: '2026-11-24',
    preregistration: prereg, seed: run.seed, window: run.window, start: run.start, end: run.end, costs: { equity: run.c_equity, treasury: run.c_bond },
    files,
  },
  data: Object.entries(manifest.sources).map(([key, s]) => ({ key, publisher: s.publisher, url: s.url, accessed: s.accessed_utc, sha256: s.sha256, usedInRun: run.data_sha256[key] === s.sha256 })),
  core: { months: net.length, from: net[0]!.month, to: net[net.length - 1]!.month, strategies },
  net: { months: net.map((r) => r.month), series },
  household: household.map((h) => ({ run: h.run, liquidation: r6(num(h.terminal_liquidation_inr)), real2001: r6(num(h.terminal_real_2001_inr)), tax: r6(num(h.tax_paid)), trading: r6(num(h.trading_costs)), fees: r6(num(h.fund_fees)), fx: r6(num(h.fx_costs)), missed: num(h.missed_obligations), sharpe: r6(num(h.growth_sharpe_vs_inr_rate)), maxDD: r6(num(h.growth_max_dd)), pFwer: r6(num(hg.get(h.run ?? '')?.p_maxt_fwer)) })),
  rebalancing: { EW: rebEW.map((r) => ({ policy: r.key, sharpe: r6(num(r.sharpe)), turnover: r6(num(r.turnover_month)), events: num(r.rebalancing_events), tracking: r6(num(r.tracking_error_vs_monthly_ann)), maxDD: r6(num(r.max_dd)) })), B6040: reb6040.map((r) => ({ policy: r.key, sharpe: r6(num(r.sharpe)), turnover: r6(num(r.turnover_month)), events: num(r.rebalancing_events), tracking: r6(num(r.tracking_error_vs_monthly_ann)), maxDD: r6(num(r.max_dd)) })) },
  hedging: {
    liability: hedgeL.map((r) => ({ horizon: num(r.horizon_months), starts: num(r.start_months), pShort: r6(num(r.p_shortfall)), mean: r6(num(r.mean_shortfall_pct)), cvar95: r6(num(r.cvar95_shortfall_pct)), worst: r6(num(r.worst_shortfall_pct)) })),
    sleeve: hedgeS.map((r) => ({ policy: r.key, sharpe: r6(num(r.sharpe_vs_inr_rate)), maxDD: r6(num(r.max_dd)), cagr: r6(num(r.cagr)) })),
  },
  risk: {
    var: varbt.filter((r) => r.portfolio === 'EW').map((r) => ({ model: r.model, months: num(r.months), rate: r6(num(r.rate)), kupiec: r6(num(r.kupiec_p)), christoffersen: r6(num(r.christoffersen_p)), lossOverCvar: r6(num(r.loss_over_cvar_when_hit)) })),
    worst: worst.filter((r) => r.portfolio === 'EW').slice(0, 4).map((r) => ({ month: r.month, loss: r6(num(r.loss)), cvar: r6(num(r.hs_cvar95)), multiple: r6(num(r.loss_over_cvar)) })),
  },
  guarantee: cases.map((c) => ({ case: c.case, status: c.status, reasons: c.reasons ? c.reasons.split('; ') : [], property: c.property })),
}
const text = `${JSON.stringify(out)}\n`
if (process.argv.includes('--check')) {
  const have = readFileSync(OUT, 'utf8')
  if (have !== text) { console.error('server/lab-research.json does not match the result files: run node scripts/lab-evidence.ts'); process.exit(1) }
  console.log(`server/lab-research.json matches ${files.length} result files.`)
} else {
  writeFileSync(OUT, text)
  console.log(`Wrote ${relative(APP, OUT)} (${text.length} bytes) from ${files.length} result files.`)
}
