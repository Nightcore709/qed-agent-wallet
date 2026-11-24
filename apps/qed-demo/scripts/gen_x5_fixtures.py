"""Generate golden fixtures from the X5 research checker (v3.1) for the demo's TypeScript port.

Run from the workspace root:
  uv run --directory envs/quant python apps/qed-demo/scripts/gen_x5_fixtures.py
Writes apps/qed-demo/shared/kernel/x5.fixtures.json. X5 is imported read-only; nothing in X5 changes.
"""
import importlib.util, json, math, os, random

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))  # the workspace root
spec = importlib.util.spec_from_file_location("x5run", f"{ROOT}/experiments/r4/X5-dominance-engine/run.py")
x5 = importlib.util.module_from_spec(spec); spec.loader.exec_module(x5)
Z = x5.ZERO

def enc(v):
    if isinstance(v, float) and not math.isfinite(v):
        return "nan" if math.isnan(v) else ("inf" if v > 0 else "-inf")
    if isinstance(v, dict): return {k: enc(u) for k, u in v.items()}
    if isinstance(v, list): return [enc(u) for u in v]
    return v

cases = []
def add(name, plan, s0=x5.S0):
    cases.append({"name": name, "plan": enc(plan), "s0": enc(s0), "expect": enc(x5.exact_check(plan, s0))})

add("card_50k", {**Z, "card": 50_000.0})
add("lp_plan_rounded", {**Z, "card": 42_400.0, "fd": 757_600.0})
add("zero", dict(Z))
add("pl_40k_cash_short", {**Z, "personal_loan": 40_000.0}, 600_000.0)
add("card_40k_cash_short", {**Z, "card": 40_000.0}, 600_000.0)
add("fd_200k_cash_short", {**Z, "fd": 200_000.0}, 600_000.0)
add("liquid_fund_100k", {**Z, "liquid_fund": 100_000.0})
add("home_loan_100k", {**Z, "home_loan": 100_000.0})
add("pl_100k", {**Z, "personal_loan": 100_000.0})
add("mixed_card_fd_lf", {**Z, "card": 120_000.0, "fd": 300_000.0, "liquid_fund": 100_000.0})
add("card_full_120k", {**Z, "card": 120_000.0})
add("invalid_negative_fd", {**Z, "fd": -50_000.0, "card": 50_000.0})
add("invalid_nan_card", {**Z, "card": float("nan")})
add("invalid_overpay_rich", {**Z, "card": 200_000.0}, 5_000_000.0)
add("invalid_conservation", {**Z, "card": 120_000.0, "personal_loan": 300_000.0}, 420_000.0)

rng = random.Random(20261118)
for i in range(240):
    s0 = rng.choice([600_000.0, 800_000.0, 1_200_000.0])
    plan = dict(Z)
    for k in rng.sample(list(Z), rng.randint(1, 3)):
        cap = x5.DEBT.get(k, s0)
        plan[k] = float(round(rng.uniform(0, min(cap, s0 * 0.6)), -2))
    add(f"random_{i:03d}", plan, s0)

# Per-scenario detail for one plan, to localise any discrepancy.
detail = []
for s in x5.scenarios():
    nw_p, sh_p = x5.ledger({**Z, "card": 50_000.0}, s)
    nw_b, sh_b = x5.ledger(Z, s)
    detail.append({"scenario": s, "nw_plan": nw_p, "nw_base": nw_b, "sh_plan": sh_p, "sh_base": sh_b})

out = {"source": "experiments/r4/X5-dominance-engine/run.py v3.1 (commit 8e1b753)",
       "generated_by": "apps/qed-demo/scripts/gen_x5_fixtures.py", "cases": cases, "card_50k_detail": detail}
path = f"{ROOT}/apps/qed-demo/shared/kernel/x5.fixtures.json"
json.dump(out, open(path, "w"), indent=1)
print(len(cases), "cases;", sum(1 for c in cases if c["expect"]["tier_D"]), "certified;",
      sum(1 for c in cases if c["expect"].get("rejected")), "rejected")
