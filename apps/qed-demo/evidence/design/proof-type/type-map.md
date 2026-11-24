# The type pass: every font size that changed

Generated from the edit list that made the change: 289 declarations in `apps/qed-demo/src/styles`, line numbers as they were before it. Made by hand after it and listed at the end: the sign-in headline's two sizes, one size added (a bill's amount on a phone) and the pause control's grid areas. The rules for the mapping are in DESIGN.md P2, "Type sizes".

| File:line | Selector | Media | Before | After | Why |
|---|---|---|---|---|---|
| base.css:35 | `kbd` |  | 12px | var(--t-micro) (12) | on the scale; written as its token |
| base.css:36 | `pre` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| base.css:52 | `.code` |  | max(12px, .86em) | max(var(--t-micro), .86em) | a named exception: an identifier in the system monospace, .86 of its line, never under 12 |
| components.css:45 | `.field > label, .field > span:first-child, .legend, legend.legend` |  | 14px | var(--t-body) (15) | tie between 13 and 15: by role |
| components.css:92 | `.stamp, .pill, .chip` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| components.css:102 | `.stamp.big small` |  | 12px | var(--t-micro) (12) | on the scale; written as its token |
| components.css:103 | `.basis` |  | 12px | var(--t-micro) (12) | on the scale; written as its token |
| components.css:108 | `.count` |  | 12px | var(--t-micro) (12) | on the scale; written as its token |
| components.css:177 | `.ledger th` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| components.css:184 | `.ledger tr.now td` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| components.css:187 | `.ledger .sub` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| components.css:214 | `.menu-pop a, .menu-pop button.item` |  | 14px | var(--t-body) (15) | tie between 13 and 15: by role |
| components.css:231 | `.i-pay` |  | 20px | var(--t-h2) (20) | on the scale; written as its token |
| components.css:239 | `.signature small` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| components.css:243 | `.i-pay` | (max-width: 560px) | 18px | var(--t-lead) (17) | nearest step |
| components.css:256 | `.timeline .t` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| components.css:261 | `.weeks .wd` |  | 12px | var(--t-micro) (12) | on the scale; written as its token |
| components.css:265 | `.weeks .day .n` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| components.css:266 | `.weeks .day .v.over` |  | 12px | var(--t-micro) (12) | on the scale; written as its token |
| components.css:269 | `.weeks .day .v` | (max-width: 560px) | 12px | var(--t-micro) (12) | on the scale; written as its token |
| components.css:272 | `.codes` |  | 15px | var(--t-body) (15) | on the scale; written as its token |
| components.css:283 | `.chart text` |  | 12px | var(--t-micro) (12) | on the scale; written as its token |
| components.css:308 | `.statement .lead` |  | 38px | var(--t-fig-l) (44) | nearest step |
| components.css:320 | `.runway.sheet .rw-free-label` |  | 12.5px | var(--t-micro) (12) | chart text is 12 (DESIGN.md P5), as the same labels on Home |
| components.css:327 | `.runway.sheet .rw-latest` |  | 12.5px | var(--t-micro) (12) | chart text is 12 (DESIGN.md P5), as the same labels on Home |
| components.css:331 | `.tip-events li` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| components.css:343 | `.avatar.sm` |  | 12px | var(--t-micro) (12) | on the scale; written as its token |
| components.css:344 | `.avatar.lg` |  | 17px | var(--t-h3) (17) | on the scale; written as its token |
| components.css:353 | `.signing p` |  | 13.5px | var(--t-small) (13) | nearest step |
| components.css:358 | `.slip .i-pay` |  | 21px | var(--t-h2) (20) | tie between 20 and 22: by role |
| components.css:363 | `.terms dt` |  | 13px | var(--t-small) (13) | on the scale; written as its token |
| components.css:371 | `aside.margin > section > h2:first-child` |  | 17px | var(--t-h3) (17) | on the scale; written as its token |
| components.css:390 | `.input, select.input, textarea.input` | (max-width: 560px) | 16px | var(--t-lead) (17) | a field on a phone: 16 px or more, or the phone zooms |
| shell.css:8 | `.brand b` |  | 21px | var(--t-h2) (20) | tie between 20 and 22: by role |
| shell.css:9 | `.practice-chip` |  | 12px | var(--t-micro) (12) | on the scale; written as its token |
| shell.css:17 | `.side-ws .ws-kind` |  | 12px | var(--t-micro) (12) | on the scale; written as its token |
| shell.css:18 | `.side-ws .ws-name` |  | 14px | var(--t-body) (15) | tie between 13 and 15: by role |
| shell.css:21 | `.side-label` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| shell.css:22 | `.side-nav a` |  | 14.5px | var(--t-body) (15) | nearest step |
| shell.css:36 | `.autonomy .a-state` |  | 14px | var(--t-body) (15) | tie between 13 and 15: by role |
| shell.css:40 | `.autonomy .a-sub` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| shell.css:41 | `.autonomy .a-act` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| shell.css:44 | `.autonomy.compact .a-state` |  | 13px | var(--t-small) (13) | on the scale; written as its token |
| shell.css:50 | `.avatar` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| shell.css:52 | `.account-who b` |  | 14px | var(--t-body) (15) | tie between 13 and 15: by role |
| shell.css:53 | `.account-who small` |  | 12px | var(--t-micro) (12) | on the scale; written as its token |
| shell.css:58 | `.theme-pick button` |  | 13px | var(--t-small) (13) | on the scale; written as its token |
| shell.css:78 | `.side-top .brand b` | (max-width: 1179px) | 16px | var(--t-h3) (17) | tie between 15 and 17: by role |
| shell.css:89 | `.autonomy .a-act` | (max-width: 1179px) | 12px | var(--t-micro) (12) | on the scale; written as its token |
| shell.css:99 | `.topbar .brand b` | (max-width: 759px) | 18px | var(--t-h3) (17) | nearest step |
| shell.css:108 | `h1` | (max-width: 759px) | 26px | (rule removed: the size it set is now the base size) | the page title is 30 at every width |
| shell.css:110 | `.bottombar a` | (max-width: 759px) | 12px | var(--t-micro) (12) | on the scale; written as its token |
| shell.css:138 | `.welcome-fine` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| shell.css:144 | `.v-ex` |  | 12px | var(--t-micro) (12) | on the scale; written as its token |
| shell.css:145 | `.v-label` |  | 13px | var(--t-small) (13) | on the scale; written as its token |
| shell.css:146 | `.v-figure` |  | 40px | var(--t-fig-l) (44) | nearest step |
| shell.css:147 | `.v-title` |  | 14.5px | var(--t-body) (15) | nearest step |
| shell.css:148 | `.v-sub` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| shell.css:163 | `.access-seg button` |  | 14px | var(--t-body) (15) | tie between 13 and 15: by role |
| shell.css:164 | `.access-title` |  | 26px | var(--t-h2) (20) | tie between 22 and 30: by role |
| shell.css:167 | `.or` |  | 13px | var(--t-small) (13) | on the scale; written as its token |
| shell.css:188 | `.steps li` |  | 13.5px | var(--t-small) (13) | nearest step |
| shell.css:190 | `.steps i` |  | 12px | var(--t-micro) (12) | on the scale; written as its token |
| shell.css:199 | `.onboard-card h1` |  | 30px | var(--t-h1) (30) | on the scale; written as its token |
| shell.css:207 | `.setup-head h1` |  | 34px | (rule removed: the size it set is now the base size) | the page title is 30 at every width |
| shell.css:211 | `.sp-label` |  | 14px | var(--t-body) (15) | tie between 13 and 15: by role |
| shell.css:212 | `.sp-figure` |  | 44px | var(--t-fig-l) (44) | on the scale; written as its token |
| shell.css:213 | `.sp-sub` |  | 13px | var(--t-small) (13) | on the scale; written as its token |
| shell.css:215 | `.sp-rows div` |  | 14px | var(--t-body) (15) | tie between 13 and 15: by role |
| shell.css:218 | `.sp-verdict` |  | 13.5px | var(--t-small) (13) | nearest step |
| shell.css:240 | `.sp-rows dd small` |  | 12px | var(--t-micro) (12) | on the scale; written as its token |
| screens/home.css:5 | `.home-head h1` |  | 34px | (declaration removed: the base size applies) | the page title is 30 at every width |
| screens/home.css:10 | `.dock a` |  | 13px | var(--t-small) (13) | on the scale; written as its token |
| screens/home.css:20 | `.pos-label` |  | 15px | var(--t-body) (15) | on the scale; written as its token |
| screens/home.css:21 | `.pos-asof` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| screens/home.css:24 | `.pos-sentence` |  | 15px | var(--t-body) (15) | on the scale; written as its token |
| screens/home.css:28 | `.pos-stats dt` |  | 13px | var(--t-small) (13) | on the scale; written as its token |
| screens/home.css:29 | `.pos-stats dd` |  | 22px | var(--t-fig-s) (22) | on the scale; written as its token |
| screens/home.css:30 | `.pos-stats dd.pos-note` |  | 12px | var(--t-micro) (12) | on the scale; written as its token |
| screens/home.css:31 | `.pos-link` |  | 13.5px | var(--t-small) (13) | nearest step |
| screens/home.css:42 | `.runway.field .rw-free-label` |  | 12px | var(--t-micro) (12) | on the scale; written as its token |
| screens/home.css:58 | `.attention-item .t` |  | 15.5px | var(--t-body) (15) | nearest step |
| screens/home.css:59 | `.attention-item .d` |  | 13.5px | var(--t-small) (13) | nearest step |
| screens/home.css:61 | `.attention-item .d .more` |  | 13px | var(--t-small) (13) | on the scale; written as its token |
| screens/home.css:62 | `.attention-item .when` |  | 13px | var(--t-small) (13) | on the scale; written as its token |
| screens/home.css:65 | `.calm` |  | 14px | var(--t-body) (15) | tie between 13 and 15: by role |
| screens/home.css:70 | `.setup-steps h3` |  | 14.5px | var(--t-body) (15) | nearest step |
| screens/home.css:72 | `.setup-steps li` |  | 13.5px | var(--t-small) (13) | nearest step |
| screens/home.css:90 | `.alloc-key` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| screens/home.css:100 | `.accounts .what` |  | 13px | var(--t-small) (13) | on the scale; written as its token |
| screens/home.css:102 | `.accounts .val small` |  | 12px | var(--t-micro) (12) | on the scale; written as its token |
| screens/home.css:108 | `.days .when` |  | 13px | var(--t-small) (13) | on the scale; written as its token |
| screens/home.css:111 | `.days .what small` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| screens/home.css:120 | `.grant .s` |  | 16px | var(--t-body) (15) | tie between 15 and 17: by role |
| screens/home.css:122 | `.grant .meta` |  | 13px | var(--t-small) (13) | on the scale; written as its token |
| screens/home.css:124 | `.grant-left p` |  | 13.5px | var(--t-small) (13) | nearest step |
| screens/home.css:128 | `.authority-foot` |  | 14px | var(--t-body) (15) | tie between 13 and 15: by role |
| screens/home.css:135 | `.record .when` |  | 13px | var(--t-small) (13) | on the scale; written as its token |
| screens/home.css:136 | `.record .when small` |  | 12px | var(--t-micro) (12) | on the scale; written as its token |
| screens/home.css:138 | `.record .why` |  | 13px | var(--t-small) (13) | on the scale; written as its token |
| screens/home.css:142 | `.record .amt small` |  | 12px | var(--t-micro) (12) | on the scale; written as its token |
| screens/home.css:143 | `.records-foot` |  | 13.5px | var(--t-small) (13) | nearest step |
| screens/home.css:152 | `.home-head h1` | (max-width: 759px) | 28px | (rule removed: the size it set is now the base size) | the page title is 30 at every width |
| screens/home.css:154 | `.dock a` | (max-width: 759px) | 12px | var(--t-micro) (12) | on the scale; written as its token |
| screens/home.css:156 | `.pos-figure` | (max-width: 759px) | 44px | var(--t-fig-l) (44) | on the scale; written as its token |
| screens/home.css:158 | `.pos-stats dd` | (max-width: 759px) | 18px | var(--t-h3) (17) | nearest step |
| screens/home.css:160 | `.record .when` | (max-width: 759px) | 12px | var(--t-micro) (12) | on the scale; written as its token |
| screens/home.css:169 | `.records .record .when` |  | 12px | var(--t-micro) (12) | on the scale; written as its token |
| screens/home.css:170 | `.records .record .when small` |  | 12px | var(--t-micro) (12) | on the scale; written as its token |
| screens/home.css:175 | `.grant-alert` |  | 13px | var(--t-small) (13) | on the scale; written as its token |
| screens/home.css:182 | `.runway.field .rw-low-label` |  | 12px | var(--t-micro) (12) | on the scale; written as its token |
| screens/spend.css:14 | `.pick-label` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| screens/spend.css:24 | `.rc-main b` |  | 14.5px | var(--t-body) (15) | nearest step |
| screens/spend.css:25 | `.rc-main small` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| screens/spend.css:26 | `.rc-tag` |  | 12px | var(--t-micro) (12) | on the scale; written as its token |
| screens/spend.css:29 | `.add-payee h3` |  | 15px | var(--t-body) (15) | on the scale; written as its token |
| screens/spend.css:30 | `.test-payees summary` |  | 13px | var(--t-small) (13) | on the scale; written as its token |
| screens/spend.css:32 | `.test-payees .kv dt` |  | 12px | var(--t-micro) (12) | on the scale; written as its token |
| screens/spend.css:37 | `.to-name` |  | 26px | var(--t-h2) (20) | tie between 22 and 30: by role |
| screens/spend.css:38 | `.to-history` |  | 13.5px | var(--t-small) (13) | nearest step |
| screens/spend.css:41 | `.money-xl .money::before` |  | 34px | var(--t-fig-m) (30) | nearest step |
| screens/spend.css:42 | `.money-xl .input` |  | 40px | var(--t-fig-l) (44) | nearest step |
| screens/spend.css:44 | `.to-amount` |  | 40px | var(--t-fig-l) (44) | nearest step |
| screens/spend.css:47 | `.path` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| screens/spend.css:49 | `.path li::before` |  | 12px | var(--t-micro) (12) | on the scale; written as its token |
| screens/spend.css:77 | `.money-xl .input` | (max-width: 819px) | 32px | var(--t-fig-m) (30) | nearest step |
| screens/spend.css:78 | `.to-name` | (max-width: 819px) | 22px | (rule removed: the size it set is now the base size) | the same size at every width now |
| screens/spend.css:80 | `.after` |  | 13.5px | var(--t-small) (13) | nearest step |
| screens/save.css:58 | `:is(.save, .sg, .grow-page) .ledger tbody th .sub` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| screens/save.css:67 | `.rv-asof` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| screens/save.css:138 | `.env-list dt` | (max-width: 560px) | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| screens/save.css:159 | `.runway.sheet .rw-free-label` |  | 12.5px | (rule removed: the size it set is now the base size) | duplicate of the shared rule, which is now 12 (chart text) |
| screens/save.css:169 | `.runway.sheet .rw-low-label` |  | 12.5px | var(--t-micro) (12) | chart text is 12 (DESIGN.md P5), as the same labels on Home |
| screens/save.css:179 | `.tip-note` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| screens/save.css:188 | `.rw-key` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| screens/save.css:221 | `.floor-rule text` |  | 12.5px | var(--t-micro) (12) | chart text is 12 (DESIGN.md P5), as the same labels on Home |
| screens/save.css:246 | `.sg-figure .basis` |  | 12.5px | (declaration removed: the base size applies) | joins its role's 12 px (the basis tag) |
| screens/save.css:283 | `.rv-figure, .sg-figure, .gr-figure` | (max-width: 759px) | 36px | var(--t-fig-m) (30) | nearest step |
| screens/grow.css:26 | `.gr-key` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| screens/grow.css:33 | `.gr-worst .basis` |  | 12.5px | (declaration removed: the base size applies) | joins its role's 12 px (the basis tag) |
| screens/grow.css:45 | `.holdings > li.h-cols` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| screens/grow.css:51 | `.holding .sub` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| screens/grow.css:58 | `.h-limit > summary` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| screens/grow.css:59 | `.h-limit > span` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| screens/grow.css:94 | `.tchart text.tc-gap` |  | 12px | var(--t-micro) (12) | on the scale; written as its token |
| screens/grow.css:165 | `.h-lab:not(.dup)` | (max-width: 899px) | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| screens/grow.css:177 | `table.market .btn.pick` | (max-width: 759px) | 14px | var(--t-small) (13) | tie between 13 and 15: by role |
| screens/grow.css:182 | `table.market td.num` | (max-width: 759px) | 13.5px | var(--t-small) (13) | nearest step |
| screens/earn.css:160 | `.lifeline::after` | (max-width: 759px) | 12.5px | var(--t-micro) (12) | joins its role's 12 px (the basis tag; the stage axis) |
| screens/protect.css:7 | `.head-p h1` |  | 34px | (declaration removed: the base size applies) | the page title is 30 at every width |
| screens/protect.css:10 | `.back-link-p` |  | 13.5px | var(--t-small) (13) | nearest step |
| screens/protect.css:25 | `.limit-left p` |  | 13.5px | var(--t-small) (13) | nearest step |
| screens/protect.css:27 | `.limit-left p + p` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| screens/protect.css:33 | `.explain-p` |  | 14px | var(--t-body) (15) | tie between 13 and 15: by role |
| screens/protect.css:46 | `.am-label` |  | 15px | var(--t-body) (15) | on the scale; written as its token |
| screens/protect.css:47 | `.am-count` |  | 13px | var(--t-small) (13) | on the scale; written as its token |
| screens/protect.css:50 | `.am-sentence` |  | 15px | var(--t-body) (15) | on the scale; written as its token |
| screens/protect.css:53 | `.am-stats dt` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| screens/protect.css:54 | `.am-stats dd` |  | 20px | var(--t-h2) (20) | on the scale; written as its token |
| screens/protect.css:55 | `.am-state` |  | 13.5px | var(--t-small) (13) | nearest step |
| screens/protect.css:70 | `.am-title` |  | 16px | var(--t-body) (15) | tie between 15 and 17: by role |
| screens/protect.css:73 | `.am-mode` |  | 13.5px | var(--t-small) (13) | nearest step |
| screens/protect.css:74 | `.am-meta` |  | 13.5px | var(--t-small) (13) | nearest step |
| screens/protect.css:76 | `.am-sells` |  | 13px | var(--t-small) (13) | on the scale; written as its token |
| screens/protect.css:87 | `.am-sub h3` |  | 15px | var(--t-body) (15) | on the scale; written as its token |
| screens/protect.css:88 | `.am-sub span` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| screens/protect.css:90 | `.am-chain-paused` |  | 13.5px | var(--t-small) (13) | nearest step |
| screens/protect.css:93 | `.am-mandate .tablet > p` |  | 14px | var(--t-body) (15) | tie between 13 and 15: by role |
| screens/protect.css:96 | `.am-mandate .tablet > .row > a:not(.btn)` |  | 13.5px | var(--t-small) (13) | nearest step |
| screens/protect.css:99 | `.am-foot` |  | 13.5px | var(--t-small) (13) | nearest step |
| screens/protect.css:110 | `.posture-verdict` |  | 17px | var(--t-h3) (17) | on the scale; written as its token |
| screens/protect.css:115 | `.posture-list .pt` |  | 14.5px | var(--t-body) (15) | nearest step |
| screens/protect.css:116 | `.posture-list .pd` |  | 13px | var(--t-small) (13) | on the scale; written as its token |
| screens/protect.css:117 | `.posture-list .pa` |  | 13.5px | var(--t-small) (13) | nearest step |
| screens/protect.css:127 | `.more-p-row .t` |  | 14.5px | var(--t-body) (15) | nearest step |
| screens/protect.css:128 | `.more-p-row .d` |  | 13px | var(--t-small) (13) | on the scale; written as its token |
| screens/protect.css:137 | `.head-p h1` | (max-width: 759px) | 28px | (rule removed: the size it set is now the base size) | the page title is 30 at every width |
| screens/protect.css:139 | `.am-figure` | (max-width: 759px) | 38px | (rule removed: the size it set is now the base size) | the same size at every width now |
| screens/protect.css:141 | `.am-stats dd` | (max-width: 759px) | 16px | var(--t-h3) (17) | tie between 15 and 17: by role |
| screens/protect.css:158 | `.rows-p .rt, .drafts-p .rt, .versions-p .rt, .runs-list-p .rt` |  | 14.5px | var(--t-body) (15) | nearest step |
| screens/protect.css:161 | `.rd` |  | 13px | var(--t-small) (13) | on the scale; written as its token |
| screens/protect.css:162 | `.rt .rd` |  | 13px | var(--t-small) (13) | on the scale; written as its token |
| screens/protect.css:163 | `.rs` |  | 13px | var(--t-small) (13) | on the scale; written as its token |
| screens/protect.css:168 | `.tag-p` |  | 12px | var(--t-micro) (12) | on the scale; written as its token |
| screens/protect.css:170 | `.hint-p` |  | 13px | var(--t-small) (13) | on the scale; written as its token |
| screens/protect.css:173 | `.sub-p h3, .sub-h-p` |  | 15px | var(--t-body) (15) | on the scale; written as its token |
| screens/protect.css:175 | `.disclose-p` |  | 13.5px | var(--t-small) (13) | nearest step |
| screens/protect.css:182 | `.history-p > li` |  | 13.5px | var(--t-small) (13) | nearest step |
| screens/protect.css:184 | `.history-p time` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| screens/protect.css:185 | `.confirm-p` |  | 14px | var(--t-body) (15) | tie between 13 and 15: by role |
| screens/protect.css:189 | `.testmode-p` |  | 13.5px | var(--t-small) (13) | nearest step |
| screens/protect.css:211 | `.path-p .rt` |  | 14px | var(--t-body) (15) | tie between 13 and 15: by role |
| screens/protect.css:215 | `.sig-count` |  | 15px | var(--t-body) (15) | on the scale; written as its token |
| screens/protect.css:216 | `.sig-count small` |  | 12px | var(--t-micro) (12) | on the scale; written as its token |
| screens/protect.css:222 | `.rule-t` |  | 16px | var(--t-body) (15) | tie between 15 and 17: by role |
| screens/protect.css:223 | `.rule-d` |  | 13.5px | var(--t-small) (13) | nearest step |
| screens/protect.css:229 | `.rule-terms > div` |  | 14px | var(--t-body) (15) | tie between 13 and 15: by role |
| screens/protect.css:230 | `.rule-terms dt` |  | 13.5px | var(--t-small) (13) | nearest step |
| screens/protect.css:232 | `.policy-p h3, .add-member-p h3` |  | 15px | var(--t-body) (15) | on the scale; written as its token |
| screens/protect.css:236 | `.roles-p` |  | 14px | var(--t-body) (15) | tie between 13 and 15: by role |
| screens/protect.css:238 | `.roles-p thead th` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| screens/protect.css:252 | `.verdict-stamp` |  | 24px | var(--t-h2) (20) | by role (nearest is 22) |
| screens/protect.css:254 | `.verdict-why` |  | 16px | var(--t-lead) (17) | tie between 15 and 17: by role |
| screens/protect.css:257 | `.verdict-figs dt` |  | 13px | var(--t-small) (13) | on the scale; written as its token |
| screens/protect.css:259 | `.verdict-figs .vf-note` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| screens/protect.css:260 | `.verdict-note` |  | 13px | var(--t-small) (13) | on the scale; written as its token |
| screens/protect.css:265 | `.bid` |  | 13px | var(--t-small) (13) | on the scale; written as its token |
| screens/protect.css:266 | `.blockers-p .bt` |  | 14.5px | var(--t-body) (15) | nearest step |
| screens/protect.css:267 | `.blockers-p .bd` |  | 13px | var(--t-small) (13) | on the scale; written as its token |
| screens/protect.css:273 | `.area-p h3` |  | 13.5px | var(--t-small) (13) | nearest step |
| screens/protect.css:276 | `.reason-p .bt` |  | 14.5px | var(--t-body) (15) | nearest step |
| screens/protect.css:278 | `.rid-p` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| screens/protect.css:281 | `.build-p` |  | 14px | var(--t-body) (15) | tie between 13 and 15: by role |
| screens/protect.css:283 | `.build-p dt` |  | 13.5px | var(--t-small) (13) | nearest step |
| screens/protect.css:290 | `.req-key` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| screens/protect.css:293 | `.runs-p` |  | 13px | var(--t-small) (13) | on the scale; written as its token |
| screens/protect.css:295 | `.runs-p th` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| screens/protect.css:300 | `.ins-summary` |  | 14.5px | var(--t-body) (15) | nearest step |
| screens/protect.css:308 | `.gp-mode` |  | 13px | var(--t-small) (13) | on the scale; written as its token |
| screens/protect.css:309 | `.gp-title` |  | 17px | var(--t-body) (15) | one size for an instruction's title (Home, Protect, Instructions), under its 17 px head |
| screens/protect.css:314 | `.gp-status` |  | 13.5px | var(--t-small) (13) | nearest step |
| screens/protect.css:316 | `.gp-sells` |  | 13px | var(--t-small) (13) | on the scale; written as its token |
| screens/protect.css:317 | `.gp-foot` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| screens/protect.css:329 | `.cat-col h3` |  | 15px | var(--t-body) (15) | on the scale; written as its token |
| screens/protect.css:332 | `.cat-col li` |  | 14px | var(--t-body) (15) | tie between 13 and 15: by role |
| screens/protect.css:348 | `.ip-doc .i-pay` |  | 22px | var(--t-h2) (20) | by role (nearest is 22) |
| screens/protect.css:357 | `.fig-p dt` |  | 13px | var(--t-small) (13) | on the scale; written as its token |
| screens/protect.css:358 | `.fig-p .v` |  | 20px | var(--t-h2) (20) | on the scale; written as its token |
| screens/protect.css:359 | `.fig-p .n` |  | 13px | var(--t-small) (13) | on the scale; written as its token |
| screens/protect.css:361 | `.plain-p h3` |  | 15px | var(--t-body) (15) | on the scale; written as its token |
| screens/protect.css:362 | `.plain-p > ul` |  | 13.5px | var(--t-small) (13) | nearest step |
| screens/protect.css:366 | `.cal-key` |  | 13px | var(--t-small) (13) | on the scale; written as its token |
| screens/protect.css:372 | `.ip-cal .weeks .day .v` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| screens/protect.css:376 | `.months-p .rt` |  | 14px | var(--t-body) (15) | tie between 13 and 15: by role |
| screens/protect.css:393 | `.kind-pillar h2` |  | 17px | var(--t-h3) (17) | on the scale; written as its token |
| screens/protect.css:394 | `.kind-pillar p` |  | 13.5px | var(--t-small) (13) | nearest step |
| screens/protect.css:402 | `.kt-body .t` |  | 15.5px | var(--t-body) (15) | nearest step |
| screens/protect.css:403 | `.kt-body span` |  | 13.5px | var(--t-small) (13) | nearest step |
| screens/protect.css:422 | `.cp-allows` |  | 15px | var(--t-body) (15) | on the scale; written as its token |
| screens/protect.css:424 | `.cp-refused` |  | 14px | var(--t-small) (13) | tie between 13 and 15: by role |
| screens/protect.css:430 | `.lf-top h2` |  | 15px | var(--t-body) (15) | on the scale; written as its token |
| screens/protect.css:431 | `.lf-state` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| screens/protect.css:435 | `.lf-sentence` |  | 14.5px | var(--t-body) (15) | nearest step |
| screens/protect.css:436 | `.lf-headline` |  | 15px | var(--t-body) (15) | on the scale; written as its token |
| screens/protect.css:439 | `.lf-terms dt` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| screens/protect.css:440 | `.lf-terms dd` |  | 16px | var(--t-h3) (17) | tie between 15 and 17: by role |
| screens/protect.css:445 | `.live-doc .ld-t` |  | 15px | var(--t-body) (15) | on the scale; written as its token |
| screens/protect.css:446 | `.live-doc .ld-d` |  | 13px | var(--t-small) (13) | on the scale; written as its token |
| screens/protect.css:465 | `.verdict-stamp` | (max-width: 759px) | 20px | (rule removed: the size it set is now the base size) | the same size at every width now |
| screens/protect.css:478 | `.ip-doc .i-pay` | (max-width: 759px) | 19px | (rule removed: the size it set is now the base size) | the same size at every width now |
| screens/protect.css:481 | `.lf-figure` | (max-width: 759px) | 38px | (rule removed: the size it set is now the base size) | the same size at every width now |
| screens/vault.css:31 | `.setup-card h2` |  | 24px | var(--t-h2) (20) | by role (nearest is 22) |
| screens/vault.css:37 | `.facts li span` |  | 14px | var(--t-body) (15) | tie between 13 and 15: by role |
| screens/vault.css:38 | `.tech summary` |  | 13.5px | var(--t-small) (13) | nearest step |
| screens/vault.css:71 | `.va-head h3` |  | 15px | var(--t-body) (15) | on the scale; written as its token |
| screens/vault.css:73 | `.vault-acct .lead` |  | 34px | var(--t-fig-m) (30) | nearest step |
| screens/vault.css:74 | `.vault-acct.primary .lead` |  | 52px | var(--t-fig-l) (44) | nearest step |
| screens/vault.css:76 | `.va-lines > div` |  | 14px | var(--t-body) (15) | tie between 13 and 15: by role |
| screens/vault.css:79 | `.va-lines dd small` |  | 12px | var(--t-micro) (12) | on the scale; written as its token |
| screens/vault.css:87 | `.vf-note` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| screens/vault.css:90 | `.wallet-side .panel h2` |  | 17px | var(--t-h3) (17) | on the scale; written as its token |
| screens/vault.css:98 | `.vault-acct.primary .lead` | (max-width: 759px) | 38px | (rule removed: the size it set is now the base size) | the same size at every width now |
| screens/vault.css:109 | `.tx-head h2` |  | 17px | var(--t-h3) (17) | on the scale; written as its token |
| screens/vault.css:110 | `.tx-status` |  | 22px | var(--t-h2) (20) | by role (nearest is 22) |
| screens/vault.css:155 | `.t-figs dd` |  | 19px | var(--t-h2) (20) | nearest step |
| screens/vault.css:156 | `.t-figs .lead dd` |  | 28px | var(--t-fig-m) (30) | nearest step |
| screens/ask.css:3 | `.engine-chip` |  | 13px | var(--t-small) (13) | on the scale; written as its token |
| screens/ask.css:10 | `.ask-rail h2` |  | 14px | var(--t-body) (15) | tie between 13 and 15: by role |
| screens/ask.css:13 | `.conv .t` |  | 14px | var(--t-body) (15) | tie between 13 and 15: by role |
| screens/ask.css:21 | `.hero-title` |  | 26px | var(--t-h2) (20) | tie between 22 and 30: by role |
| screens/ask.css:36 | `.qed-mark` |  | 12px | var(--t-micro) (12) | on the scale; written as its token |
| screens/ask.css:40 | `.grounded` |  | 13px | var(--t-small) (13) | on the scale; written as its token |
| screens/ask.css:45 | `.rests dt` |  | 12px | var(--t-micro) (12) | on the scale; written as its token |
| screens/ask.css:46 | `.rests dd` |  | 14px | var(--t-body) (15) | tie between 13 and 15: by role |
| screens/ask.css:47 | `.rests .cite-obj ul` |  | 13px | var(--t-small) (13) | on the scale; written as its token |
| screens/ask.css:54 | `.chip-q` |  | 13.5px | var(--t-small) (13) | nearest step |
| screens/ask.css:64 | `.p-origin` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| screens/ask.css:66 | `.proposal h3` |  | 18px | var(--t-h3) (17) | nearest step |
| screens/ask.css:68 | `.p-ceiling` |  | 13.5px | var(--t-small) (13) | nearest step |
| screens/ask.css:74 | `.p-figs .p-note` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| screens/ask.css:75 | `.p-figs dt` |  | 12px | var(--t-micro) (12) | on the scale; written as its token |
| screens/ask.css:77 | `.ask-track` |  | 12px | var(--t-micro) (12) | on the scale; written as its token |
| screens/ask.css:86 | `.composer .field > label` |  | 13px | var(--t-small) (13) | on the scale; written as its token |
| screens/ask.css:87 | `.composer .field .hint` |  | 12px | var(--t-micro) (12) | on the scale; written as its token |
| screens/ask.css:91 | `.composer-foot kbd` |  | 12px | var(--t-micro) (12) | on the scale; written as its token |
| screens/ask.css:98 | `.hero-title` | (max-width: 759px) | 22px | (rule removed: the size it set is now the base size) | the same size at every width now |
| screens/ask.css:106 | `.starters-h` |  | 13px | var(--t-small) (13) | on the scale; written as its token |
| screens/ask.css:109 | `.starters.waiting .w-a` |  | 12px | var(--t-micro) (12) | on the scale; written as its token |
| screens/legacy.css:4 | `pre.doc` |  | 12.5px | var(--t-small) (13) | nearest step, up (never under 12.5) |
| shell.css:136 | `.welcome-pitch h1` |  | clamp(36px, 4.2vw, 56px) | clamp(var(--t-fig-l), 4.2vw, var(--t-fig-xl)) | the one fluid size, now between two figure steps (44 to 64) so its two lines hold |
| shell.css:179 | `.welcome-pitch h1` | (max-width: 979px) | clamp(30px, 7.5vw, 40px) | clamp(var(--t-fig-m), 7.5vw, var(--t-fig-l)) | the same, 30 to 44, under 980 px |
| screens/spend.css:77 (added) | `.to-amount` | (max-width: 819px) | 44 (the rule above, at every width) | var(--t-fig-m) (30) | a bill's amount stands where the amount is typed, which is 30 here; at 44 a five-figure bill ran past its box at 320 px |
| shell.css:33 | `.autonomy` (grid areas, not a size) |  | "state act" "sub act" | "state act" "sub sub" | at 13 px the count no longer fitted beside Pause in the 248 px sidebar and broke after "in" |
