"""Golden fixtures for Checker B: the independently written X7 checker (Python), run with the FD-break reading
adopted as rule v3.2 on 18 Nov 2026 (principal equal to the shortfall, break interest credited on top).

Run from the workspace root:
  uv run --directory envs/quant python apps/qed-demo/scripts/gen_x7_fixtures.py
Inputs are the same cases as x5.fixtures.json, so the demo can also test that Checkers A and B agree.
"""
import importlib.util, json, math, os

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))  # the workspace root
spec = importlib.util.spec_from_file_location("x7checker", f"{ROOT}/experiments/r4/X7-independent-checker/checker.py")
import sys
x7 = importlib.util.module_from_spec(spec); sys.modules["x7checker"] = x7; spec.loader.exec_module(x7)
RULE = x7.Interp(fd_break="principal_equals_shortfall")

def dec(v):
    if v == "nan": return float("nan")
    if v == "inf": return float("inf")
    if v == "-inf": return float("-inf")
    if isinstance(v, dict): return {k: dec(u) for k, u in v.items()}
    return v

src = json.load(open(f"{ROOT}/apps/qed-demo/shared/kernel/x5.fixtures.json"))
cases = []
for c in src["cases"]:
    v = x7.check_detailed(dec(c["plan"]), dec(c["s0"]), interp=RULE).verdict
    cases.append({"name": c["name"], "plan": c["plan"], "s0": c["s0"], "expect": {k: v[k] for k in ("rejected", "tier_D", "min_exact_improvement_inr", "max_shortfall_deepening_inr")}})
out = {"source": "experiments/r4/X7-independent-checker/checker.py (Interp fd_break=principal_equals_shortfall, rule v3.2)",
       "generated_by": "apps/qed-demo/scripts/gen_x7_fixtures.py", "cases": cases}
json.dump(out, open(f"{ROOT}/apps/qed-demo/shared/kernel/checkerB.fixtures.json", "w"), indent=1)
agree = sum(1 for a, b in zip(src["cases"], cases) if a["expect"]["tier_D"] == b["expect"]["tier_D"] and a["expect"]["rejected"] == b["expect"]["rejected"])
print(len(cases), "cases; verdict agreement with X5:", agree, "/", len(cases))
