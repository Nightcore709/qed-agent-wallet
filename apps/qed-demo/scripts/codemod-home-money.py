#!/usr/bin/env python3
"""R13 S8 codemod: every call of the rupee formatters becomes a call of the home-currency formatter (shared/home-money.ts).

Rules (the whole of it; run with --write from apps/qed-demo on the tree before the move):
  1. interface: fmt.inr( -> fmt.money(
  2. a file importing inr / inrExact / inrCompact from shared/money.ts: the calls become homeMoney / homeMoneyExact /
     homeMoneyCompact and the import moves to shared/home-money.ts (names not about formatting stay on money.ts).
  3. a file that wrapped the formatter in a local `const inr = ...`: the wrapper is deleted and its calls go straight to the
     formatter it wrapped (EXACT: homeMoneyExact; MINOR: homeMoneyMinor, always the currency's own decimals).
  4. a file importing `inr` from server/programs.ts (its two-argument helper): the name becomes amountText.
  Tests, scripts and shared/money.ts itself keep the rupee formatters: they state a rupee on purpose.
"""
import re, sys, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
write = '--write' in sys.argv
FILES = sorted(p for d in ('src', 'server', 'shared') for p in (root / d).rglob('*') if p.suffix in ('.ts', '.tsx') and '.test.' not in p.name and 'node_modules' not in p.parts)
# Rupee-only features: INR instruments, the chain rail's test tINR, the rupee desk, paper escrow, Indian tax. They keep the
# explicit rupee formatters (shared/money.ts); server/home-money-scan.test.ts holds this list and the reason for each.
KEEP_RUPEES = set('''src/lib/core.ts server/earn-chain.ts server/directory.ts server/escrow.ts server/rfq.ts server/netting.ts server/institutional.ts
server/securities-books.ts server/tax.ts server/ideas.ts server/evidence.ts src/ui/earn-chain.tsx src/ui/earn-directory.tsx
src/ui/earn-terms.tsx src/ui/vault-ownership.tsx src/screens/WalletInline.tsx src/screens/Earn.tsx src/screens/Idea.tsx src/screens/Lab.tsx
src/screens/Desk.tsx src/screens/Holdings.tsx src/screens/Watching.tsx src/screens/GrowCompare.tsx src/screens/Tax.tsx'''.split())
EXACT = {'workspaces.ts', 'netting.ts', 'institutional.ts', 'liquidity.ts', 'goals.ts'}
MINOR = {'commerce-mandate.ts', 'ask-kinds.ts', 'policy.ts', 'commerce.ts'}
VIA_PROGRAMS = {'ai.ts', 'owner.ts', 'conversation.ts', 'runner.ts'}
NAMES = {'inr': 'homeMoney', 'inrExact': 'homeMoneyExact', 'inrCompact': 'homeMoneyCompact'}
IMPORT = re.compile(r"^import \{([^}]*)\} from '((?:\.\./)+shared/)money\.ts'\n", re.M)
WRAP = re.compile(r"^(?:  )?const inr = [^\n]*\n", re.M)
ident = lambda n: re.compile(r'(?<![\w.$])' + n + r'\b(?=\s*[(,)])')
changed = []
for p in FILES:
    if p.name in ('home-money.ts', 'money.ts'): continue
    s = out = p.read_text()
    n = p.name
    if str(p.relative_to(root)) in KEEP_RUPEES: continue
    if 'fmt.inr' in out: out = re.sub(r'\bfmt\.inr\b', 'fmt.money', out)
    if n == 'programs.ts':
        out = re.sub(r"^import \{ inr as money, inrExact \} from '\.\./shared/money\.ts'\n", "import { homeMoney, homeMoneyExact } from '../shared/home-money.ts'\n", out, flags=re.M)
        out = out.replace("export const inr = (paise: number | bigint, dp: 0 | 2 = 0): string => (dp === 0 ? inrExact(paise) : money(Number(paise), { paise: true }))",
                          "export const amountText = (paise: number | bigint, dp: 0 | 2 = 0): string => (dp === 0 ? homeMoneyExact(paise) : homeMoney(Number(paise), undefined, { paise: true }))")
        out = ident('inr').sub('amountText', out)
    elif n in VIA_PROGRAMS:
        out = re.sub(r"(import \{[^}]*)\binr\b([^}]*\} from '\./programs\.ts')", r'\1amountText\2', out)
        out = ident('inr').sub('amountText', out)
        out = re.sub(r'(export \{[^}]*)\binr\b', r'\1amountText', out)
    else:
        m = IMPORT.search(out)
        if m:
            names = [x.strip() for x in m.group(1).split(',') if x.strip()]
            keep, moved = [], []
            for x in names:
                base, _, alias = x.partition(' as ')
                if base in NAMES:
                    target = NAMES[base]
                    if n in EXACT: target = 'homeMoneyExact'
                    if n in MINOR: target = 'homeMoneyMinor'
                    if target not in moved: moved.append(target)
                else: keep.append(x)
            if n in EXACT | MINOR: out = WRAP.sub('', out)
            for old, new in NAMES.items():
                tgt = 'homeMoneyExact' if n in EXACT else 'homeMoneyMinor' if n in MINOR else new
                out = ident(old).sub(tgt, out)
            out = out.replace('const inr = inrExact\n', '')
            # `inr as money` style aliases: calls use the alias, which now names the new formatter
            imp = (f"import {{ {', '.join(keep)} }} from '{m.group(2)}money.ts'\n" if keep else '') + f"import {{ {', '.join(sorted(moved))} }} from '{m.group(2)}home-money.ts'\n"
            out = out.replace(m.group(0), imp, 1)
            out = out.replace('const rupees = inrExact\n', 'const rupees = homeMoneyExact\n')
            out = re.sub(r'\.map\((homeMoney\w*)\)', r'.map((x) => \1(x))', out)
    if out != s:
        changed.append(str(p.relative_to(root)))
        if write: p.write_text(out)
print(len(changed), 'files changed')
if '--list' in sys.argv: print('\n'.join(changed))
