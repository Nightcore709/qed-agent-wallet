# QED design system

## Meridian (24 November 2026, R11): in force on branch `claude/r11-meridian`, for the owner's review (D-109)

**This section supersedes Bounds (rejected, D-108), Proof, Clear, the R7 merge and D1 to D4 wherever they disagree. None
of those is a fallback, and none may come back under another name: no Tyrian on graphite and white, no banknote world
or peacock and marigold, no pale ground with one timid accent, no category blue.** Every fact, figure, route, control,
check and test hook the screens had is kept unless a rule here says otherwise. The oldest system's rules on words,
figures, states and accessibility (its sections 1, 5, 7, 9, 11) still bind. Source of the direction: the owner's R11
mandate (`docs/mandate/20261124-R11-fluid-premium-wallet-continuation.md`, sections 4 to 6) and the supplied references.

### M1. The idea

*Money seen through clear glass, lit from one horizon.* Every screen floats over a living atmosphere: a horizon of light
(three soft lights and a thin arc, the meridian) whose hue follows the section. The page is read through layers of
glass: one frosted stage, tinted panels on it, frosted sheets and menus over everything. Glass is QED's promise made
material: what it does is visible and inspectable. Light is the one place colour is spent freely; figures, risks,
permissions and actions stay opaque-legible on every layer.

What was taken from the references, and how (the owner's words first, then the interpretation, tested in the build):
- **Glassy Dashboard** (source read in full, attachment lines 2323 to 3735): operational clarity and composition. The
  stage-and-panels depth, edge-lit glass (an inset highlight top-left, an inset shade bottom-right, a diagonal sheen),
  pill controls, a tone-filled tile for the one figure that matters, the dock with a sliding indicator, a two-row bar on
  a phone, reduced-transparency and forced-colours fallbacks. Not taken: its stock photograph, its sample figures,
  counters that count up from zero (a money figure must never show an amount that was never true).
- **Ascend, Kage, Umbra, Marcus Vane, Loopstack** (Kage's registered source verified by hash; Umbra inspected live,
  Pro source gated): near-black canvases lit by one warm light, huge tight-tracked type with a dimmer second line
  (Umbra: Inter Tight 600 at 115 px, -0.042em), expo-out reveals (`cubic-bezier(.16,1,.3,1)`, 420 to 720 ms),
  chapters that unfold as the page is scrolled, breathing glows (Kage), grain. Not taken: WebGL scenery, preloaders,
  smooth-scroll hijacking, scenery unrelated to money.
- **Liquid Glass Navbar and Checkout**: the indicator as a drop of lit glass that stretches toward its target and
  gathers (leading edge fast, trailing edge on a spring), icons that pop on arrival, a checkout that says where it is.
- **Peak Chart**: a lit line over a faint grid, a glow behind it, a reading dot that follows the pointer, a figure that
  resolves out of blur. Not taken: the count-up and the comet head that implies motion of value.
- **Hold to Confirm** (source read in full): the press-and-hold fill with run-back on release, pointer capture and
  leave-cancel, keyboard hold. Added for money: an untimed one-step alternative, binding to the document's fingerprint,
  and the rule that the hold expresses intent while the passkey authorises.
- **Glass Folder Cards**: grouping by tactile glass objects that open; for receipts and evidence (Activity).

### M2. Tokens (`src/styles/tokens.css`; never a literal colour or font outside it)

- **Type: Inter Tight** (OFL; `src/fonts/inter-tight/`, fontsource 5.3.0, latin and latin-ext variable files, SHA-256
  `77fefe8c…` and `fd9bedda…`). Chosen on a rendered specimen over Bricolage Grotesque (crowded figures) and Plus
  Jakarta Sans (friendlier, less exact), and for coverage: 20 of 21 currency signs tested, ₹ € £ ¥ ₩ ₦ ₺ ₫ ₱ ₽ ₿ ₪
  included, tabular figures. Onest and Instrument Sans were refused: no ₹. One family; weights 430 (text) to 720.
- **Scale:** text 12, 13, 15, 17; headings 16, 20, 30; display `clamp(36px, 4.4vw, 64px)`; figures 22, 30, 44, 64 and
  the hero `clamp(48px, 6vw, 88px)`, all in rem (those px at the default 16 px root), so a larger text size set in the
  browser enlarges every step. Tracking tightens with size (`--track-hero` -0.05em to `--track-body` -0.006em).
- **Two themes, both first class:** night (black and gold: a deep, nearly neutral black ground, smoky panes, a
  champagne-to-gold action) and day (porcelain ground, espresso action). System chooses unless the person does
  (account menu: System, Day, Night).
- **Colour, refined on 24 Nov after the owner's feedback** ("the gold, bronze, champagne-and-black scheme is
  substantially closer"; one rendered round of three, on Home, Spend, Protect and Home at 390 px): the atmosphere is
  warm metal only (amber, bronze, copper, brass); every section varies the metal, never the hue family (the teal
  counter-light and the violet, blue, indigo and green section lights are gone). One cool accent remains, and only for
  QED's own hand (`--qed`, tide): the span of what QED may move, the orb, QED's meters. Platinum was tried for it and
  refused: it read too close to the bar's own fill to mark QED's part.
- **R12 comparison round, decided on evidence (24 Nov; the owner: the gold direction is "a preferred starting point,
  not a fixed constraint").** Three treatments rendered over the actual interface, each as a complete set of tokens for
  both themes laid over the running app (the app's code unchanged while comparing): **A, Meridian** (warm black,
  champagne-gold action, porcelain and espresso by day), **B, midnight and brass** (a navy-ink ground, ivory figures,
  a brass action, an aqua QED; ivory paper and a navy action by day), **C, graphite and platinum** (neutral black and
  white, a platinum or black action, colour only for states and QED). Home, Spend, Save and the on-chain wallet; 1440
  and 390 px; night and day; the populated household and a short, empty one (Ravi: ₹25,000 in the bank, ₹2,55,333.93
  short, nothing set up): 96 photographs, as contact sheets in `evidence/design/r12-palette/` (A, B, C left to right).

  | | A Meridian | B Midnight and brass | C Graphite and platinum |
  |---|---|---|---|
  | Text runs below threshold, pixel checker, populated (night 1440 / day 390) | 0 of 1,047 / 0 of 1,047 | 0 of 1,047 / 0 of 1,047 | 0 of 1,046 / 0 of 1,046 |
  | The same, short and empty account | 0 of 636 / 1 of 620 (4.50, a faded red paise, fixed since) | 0 of 636 / 0 of 620 | 0 of 636 / 0 of 620 |
  | Weakest bar part against its panel, both accounts (night / day) | 3.31 / 3.95 | 3.10 / 4.01 | 3.23 / 4.08 |
  | Coherence | one warm family from ground to action; the light and the money speak one material | cool surfaces under warm ink and brass: a classic pairing, two temperatures to keep apart | neutral and orderly; the states become the only colour and shout |
  | Appeal | the warmest and most lit; panels read as glass over a horizon | calm and institutional | stark; by day it is the pale ground with one accent the owner refused in Clear |
  | Distinctiveness | the warm-metal atmosphere and champagne are QED's own | navy and gold is the banking default UI UX Pro Max's data proposes for the category (its "Banking" palette) | a generic dark mode |

  **Decision: A, refined.** Readability does not separate the three: each passes the pixel checker and the bar's 3:1
  (a first run found the same two or three failures under all three in the short account, the app's own, not the
  palette's: red paise faded to 2.8:1 and a chart label over the line at 3.0:1; both fixed, and the 4.50 left under A
  then too). So the choice rests on coherence and distinctiveness, where A leads and B is the category default. The round's refinements,
  now in force: the money is never lit (no glow on any bar, meter, mark or dot); reserved money has its own metal,
  separate from amber, which keeps one job, "waits on you" (`--part-kept` pewter instead of the yellow wash of
  `--due`); the bar's parts are a lightness ramp (`--part-*`, M14), each 3:1 on its panel in both themes.
- **Roles:** `--ground`; glass `--stage`, `--pane`, `--pane-2`, `--pane-3`; opaque `--sheet`, `--sheet-2`, `--well`;
  material `--rim`, `--rim-out`, `--gloss`, `--edge-hi`, `--edge-lo`; ink `--ink` to `--ink-4`; the primary action
  `--act`, `--act-2`, `--on-act`; links and the chosen state `--brand`; **QED's own hand `--qed`** (tide: what QED did,
  proposes or may do; the orb; the seal; meters of authority); states `--gain` (money in, a passed check), `--loss`
  (refused, failed, short), `--hold` (in progress), `--due` (waits on the owner); charts `--c1` to `--c6`; the money
  bar's parts `--part-free`, `--part-kept` and `--part-kept-line`, `--part-held`, `--part-pay`, `--part-over`,
  `--part-short`, `--part-reach` (M14); the atmosphere `--glow-a`, `--glow-b`, `--glow-c`, `--meridian`.
- **Figures that fit (R12):** `--t-fig-hero-fit`, `--t-fig-l-fit` and `--t-fig-m-fit` are the hero, large and medium
  figure capped by their panel's width (container units), for a phone at a large browser text size.
- **Shape:** stage 32, panels 24, tiles 18, fields 14, tags 8; every control and chip is a pill.
- **Motion:** `--ease-out` (expo-out) for what arrives and answers, `--ease-move` for what travels, `--ease-spring` and
  `--ease-pop` (damped springs sampled into `linear()`, 4% and 16% overshoot) for what is picked up and let go;
  durations 140, 240, 420, 720 ms and 1100 ms for a scene.

### M3. The shell (`src/app/App.tsx`, `src/styles/shell.css`)

A glass bar floats 12 px from the top: the mark and the practice label; **Ask at the centre** (the orb, a field, this
page's questions and the conversations below it on focus, Cmd-K or Ctrl-K); QED's state with its pause; notifications;
the account. One frosted **stage** holds the page. A glass **dock** floats at the bottom with the seven sections (on a
phone: Home, Spend, Ask, Activity, More); its indicator stretches toward the new section and gathers. The atmosphere's
lights glide to the section's hue (Spend ember, Save sea, Grow jade-gold, Earn gold, Protect steel, Activity moonlight,
Ask iris). The mark: a globe with one meridian, its tail making the Q; the meridian in tide.

### M4. Composition rules

1. **A page is a command grid, not a document.** A strong head (display title, one sentence, the page's actions), then
   panels on twelve columns or two independent columns (`useMasonry`) whose order is the order of importance, which is
   the reading and focus order on a phone. No staircases (panels stepping in and out), no empty halves of a row: a row
   of panels shares a height by design or the columns are independent.
2. **One figure leads each panel.** It is the panel's largest text; labels sit above it in ink-2 at 13 to 15 px, never
   tiny tracked capitals; explanations are one sentence in ink-2 or ink-3.
3. **Tiles for siblings.** Figures of the same kind sit in tiles in one row (2 to 4), each with label, figure and one
   line. The one tile that is QED's (what it may move) takes the tide tint.
4. **Glass by depth, not decoration.** The stage blurs once; panels on it are tinted glass with lit edges and no second
   blur; sheets, menus, the bar and the dock blur again. Nothing is glass for its own sake inside a panel.
5. **Natural language, shared definitions.** Free to use, kept for what is due, held for orders, what QED may move, in
   your bank: the same words on every screen. Different balances that are legitimately different are explained where
   they meet (the bar's sum line), never forced equal.
6. **No synthetic people, no fabricated metrics, no unsupported "Live".** Example figures are labelled as examples.

### M5. Motion (`src/ui/motion.ts`)

- **Arrival:** a page's blocks rise 14 px out of a 6 px blur, 60 ms apart, in reading order; blocks below the fold wait
  and arrive when scrolled to (the page unfolds as it is read). Nothing waits with reduced motion or when printing.
- **Leaving:** the old page blurs out in 160 ms (view transition).
- **Figures resolve** in place out of blur; they never count up. Meters fill from zero to their true value once.
- **Charts draw** their line from today to the right (a clip, values whole from the first frame).
- **Reduced motion** stops every movement; **reduced transparency, more contrast, forced colours** remove the
  atmosphere and make every pane opaque; **"Glass and moving light: Off"** (account menu) or a weak device (two cores or
  fewer, 2 GB or less, Save-Data) does the same (`html[data-fx="plain"]`).
- **The owner's 20-principle framework** (R6 amendment, line 59; Clear's use in C3), as Meridian applies it:
  *squash and stretch* and *follow-through* in the dock's indicator (the leading edge stretches, the trailing edge
  catches up on a spring); *anticipation* in the hold (the button sinks 1.5% as it is pressed); *staggering* in
  arrival (60 ms apart, reading order); *easing* (expo-out to arrive, in-out to travel, springs only for what is
  picked up); *arcs* not used (nothing travels far enough to need one); *secondary action* in the dock's icon pop and
  the orb's turn while QED works; *timing* (140 to 720 ms; a scene 1,100 ms; nothing that answers input takes longer
  than 240 ms to start); *feedback* and *response latency* (every press moves within one frame); *dimensionality* in
  the four depths of glass and the sign-in card's tilt; *origin awareness* (a phone's sheet rises from the bottom,
  menus from their button); *Fitts's law* (44 px targets, the hold at the thumb on a phone); *rubber banding* not used;
  *Hick's law* (one primary action per view, champagne); *Von Restorff* (only what needs the owner is amber; QED's
  own hand is tide); *interruptibility* (a hold cancels on release; arrival never blocks input); *fast closing*
  (sheets and menus leave in 160 ms); *peak-end* (no celebration on money movement: a settled payment says so and
  shows its receipt); *frequency-sensitive animation* (live prices and repeated updates never animate; a block arrives
  once and its animation is removed).

### M6. Charts

Labelled units and a meaningful scale; actual and projected told apart (projected dashed or hatched, said in the key);
uncertainty drawn as a band where it exists; source and freshness under every chart; periods that suit the question;
an accessible equivalent one press away (a statement or table, exact to the paisa); inspection by pointer, finger and
arrow keys with a glass reading label; cash-flow discontinuities drawn as true steps. `src/ui/horizon.tsx` is the
reference implementation.

- **A scale that means something** (Grow, R11): a value scale spans at least 1% of the latest value, so a 10-paise move
  on ₹64 lakh is not drawn from the bottom of the plot to the top; a comparison level (what you paid) is drawn when it
  lies within one range height, otherwise named at the edge.
- **Published values are steps, never slopes** (Grow, R12; `src/ui/timechart.tsx` `holdsOf`, tested in
  `timechart.test.ts`): a fund's NAV (and any daily rate or reference value) is published for one day and holds until
  the next, so it is a level from the start of its day (India time) to the start of the next value's day, across the
  weekend or holiday between; the latest holds to the time the record is read. A jump is a thin riser. Each day a value
  was published is marked: a dot on its step with 6 px or more for each, a tick on the time axis down to 2 px, none
  below that (the key names the mark drawn). A reading says the day the value is for ("NAV for Fri 20 Nov 2026"); on a
  day with none it names the value that holds ("Sat 21 Nov 2026: no NAV published that day. The NAV for Fri 20 Nov 2026
  holds"), and after the latest, "none published yet". The figure says "NAV for <day>" and whether it is current, by the
  server's staleness rule. The table lists every value of the period with the days it held. The server sends every
  published value up to 2,000 (`server/views.ts` `DAILY_POINTS`; until R12 three years of NAVs came thinned to every
  second one, which steps would have drawn as two-day holds); a thinned series says so under the chart.
- **Periods the data has:** the balance path is 120 days (server/liquidity.ts), so Home and Save offer 30, 60 and 120;
  a button never asks for days the server does not draw.
- **Colours with one job each:** balance lines are ink with a gold light (`--c2`); a price line's light is amber
  (`--c3`); a what-if is pewter (`--c6`), dashed, and nothing else uses `--c6`; the kept region is hatched in the kept
  metal (`--part-kept`, R12; it was the amber of `--due`), its label in ink.
- **Words that agree with the model:** the worst case says what the server models (income late or lost, every bill on
  its day, everyday spending at the owner's figure), in the same words on Home and Save.

### M7. Home

The head: the greeting on the left; beside it, as wide as the three actions in one row and set on the greeting's last
line, the day, what QED is doing and the actions (R12; down to 900 px since R13). The position (free to use as the hero figure, the money bar of
free, kept and held, or short, with the span of what QED may move under the free part (M14), three tiles; on a phone
the tiles are rows of one list), what needs the owner (or the calm state, or finishing set-up), the balance at worst over 30, 60 or
150 days (Horizon), what QED may do (each standing authority with its meter, mode and next run), the day book (coming
up, then what happened, around "Today"), where the money is (net position explained: a home is not counted, only its
loan), ways to do better.

### M8. Approving (`src/ui/instrument.tsx`, `src/ui/hold.tsx`)

Every approval that moves money says its three steps as they happen (you confirm, your passkey signs, QED sends it);
settling and the receipt follow on the record. The primary control is **Hold to approve** (900 ms; release, leaving
the button or losing focus cancels; Enter or Space held works); beside it the untimed **one-step** control
(`… with your passkey`). The hold is bound to the document's fingerprint: new terms reset it. A completed hold cannot
fire twice. The passkey's signature over the exact terms is what approves; the gesture is never the authorisation.

### M9. Checks before a screen is done

Rendered at 1440, 1024, 390 and 320 px in both themes; read at the phone widths in the browser, not only photographed;
axe 0; no overflow; contrast of every text over its real composited background (glass over the brightest part of the
atmosphere) at 4.5:1 (3:1 for large text and boundaries); keyboard path through every control with focus visible and
never hidden under the bar or dock; reduced motion and plain effects checked; Core Web Vitals within budget (LCP
2.5 s, INP 200 ms, CLS 0.1); the screen's browser journeys pass.

### M10. Spend (`src/screens/Pay.tsx`, `src/styles/screens/pay.css`)

A checkout. On the left, under a progress rail (From, To, How much, Route, Review; a step is ticked only once it and
every step before it are settled), the steps settle one figure each. On the right, sticky on a computer, the payment
forms as it is chosen: who, how much, from where, the route and when it arrives, what stays free after it at true
scale, and "See what this would do", which asks the server for the exact terms. After the passkey signs, the same card
follows the payment: signed, sent, then settled or returned, in the record's own words, with its record and receipt
one press away. Below: bills on record beside payments so far. (R14: step 5 is in the journey and every part
below the checkout takes the whole width; see "R14, Spend and Save".)

R12 (task comparison, gaps 4 and 11): nobody is chosen on arrival; the person chooses who to pay (a bill asked for in the
address and a payee just added are choices already made). Adding a payee shows the paper bank's name check before it is
saved, the name given beside the name the paper bank holds, with "Use the registered name" on a close match and the same
tick as a look-alike otherwise; the payee's facts carry that answer and its first-day rule before any payment. A large
first-day payment to a new payee waits: the summary says so before the terms are asked for, the card says when it is
sent and offers to cancel it, and a pending payment's card gives the rail's bound and what QED does if no answer comes.
The answers and the wait use the caution's amber (`--due-bg`), never a new colour.

### M12. Status words (`src/ui/kit.tsx` STATE_WORDS and STATUS_GLOSSARY)

One vocabulary for where an action stands, in the order it moves (the owner's R11 list): **Proposed** (drafted by QED
or Ask; nothing checked or sent), **Being checked**, **Awaiting your approval**, **On hold** (R12: approved, waiting a
stated time before it is sent, its money set aside and cancellable: a large first-day payment to a new payee),
**Submitted** (sent; no answer yet),
**Pending** (accepted there, not finished), **Completed** (and Partly completed), then **Refused by QED's checks**
(QED's own guard, before anything was sent), **Rejected by the venue** (the bank, rail or venue, after it was sent),
**Failed**, **Cancelled**, **Expired**, and **Needs attention** (finished, but the venue's record differs; never shown
as completed). "Refused" is always QED's guard and "Rejected" always the other side. Receipts, evidence cases, the
wallet's jobs, Earn and the day book use the same words; Activity says each in one sentence under its filters.

### M13. The screens rebuilt in R11 (one specialist each, merged and checked here)

- **Grow** (`Holdings.tsx`, `grow.css`, `timechart.tsx`): value and risk in one language; the price record as a lit
  line on a meaningful scale with what you paid drawn across it; the ticket beside the prices. R12 (`PriceRecord.tsx`,
  `src/ui/prices.ts`): the lead panels in one row language (the bar's key and the floor's subtraction as rows, label
  and swatch left, figure right-aligned, each figure once); the holdings on one grid, a ruled table from 1,100 px and
  cards below it with the same rows, each holding's four actions in one group in one place; a fund's NAV as steps
  (M6).
- **Save and Statement** (`Save.tsx`, `Passbook.tsx`, `score.tsx`): the reserve beside what it pays for at one height;
  one cash-flow chart with each instruction's days under it and the what-if drawn over it on the same axis.
- **Protect family** (`Protect.tsx`, `Instructions.tsx`, `Compose.tsx`, `Safeguards.tsx`, `Notifications.tsx`,
  `Readiness.tsx`, `src/ui/kinds.tsx`): every protection is Watched, Set by you, or Enforced by QED's server, the
  co-signer or the chain, in words, icon and material (dashed, frosted, opaque with a lit edge); a ladder says who
  enforces what, from the model behind Ask (nothing) to the chain.
- **Activity and records** (`Activity.tsx`, `Evidence.tsx`, `Record.tsx`, `src/ui/folder.tsx`): glass folders file
  the records by kind beside the day book, with a plain List view; search reads every row's words and amounts. The
  folder glass blurs a second time on the stage (an exception to M4's one-blur rule, taken because it frosts the
  folder's own files; the plain look removes it): for the owner to accept or refuse.
- **Earn** (`Earn.tsx`, `src/ui/earn-chain.tsx`): each job is one journey on five stations (offer, escrow, work,
  decision or check, settled) with whose move it is in words; "Held in escrow for you" leads. R12 (task comparison
  gap 16, `server/escrow.ts`): a paper milestone says who acts next, when, and what happens if they do not, as three
  labelled lines (`.er-pn`: Next, When, If not), the four parts a step on the chain is said in; every step in "Who acts
  next" carries its default under its milestone. A dispute is a ruled panel on its milestone (`.er-dsp`, a loss-coloured
  inset rule while open) naming its decider (a simulated mediator the household plays, never a real arbitrator), its
  deadlines, the money meanwhile and every outcome in exact paise; the mediator's part is a dashed group like the paper
  client's (`.er-client.er-med`, neutral glass); every step on record is one disclosure (`.er-hist`). Tokens only.
- **On-chain wallet** (`Vault.tsx`, `WalletInline.tsx`, `src/ui/enforced.tsx`): ownership first (who must sign, who
  may do what); set-up as a three-step checkout; three marks, Contract enforces, QED checks, Observed only.
- **Sign-in:** a primary button and the sentence that says what it will ask for are one group (`.access-act`): the
  sentence 16 px under the button, centred, balanced, at most 40ch, with more room after the group than inside it; a
  wrapped label keeps its icon as its first word.

### M11. Performance (`scripts/perf.ts`, `server/api.ts`)

Budgets (Core Web Vitals "good", at p75 in the field; lab figures stand in until field data exists): LCP 2.5 s, INP
200 ms, CLS 0.1, measured on the built interface in two lab profiles: a computer (1440 px, no throttling) and a phone
(`QED_PROFILE=phone`: 390 px, CPU slowed 4x, a slow 4G link of 1.6 Mb/s). The built interface is sent with Brotli or
gzip; every screen but Home loads on demand and is fetched ahead, one at a time, 6 s after the page has loaded and
only when idle (never on Save-Data, 2G or 3G). **A page draws its head (title, its sentence, its static actions) before
any of its data**: on a phone the head is the largest thing on the first screen, so a head that waits for data waits
for LCP (Spend: 3.1 s with the head behind its data, 1.9 s without). Glass and moving light are compositor-only; a weak
device gets the plain look. Lab on 24 Nov (phone profile): Home 2.1 s, Spend 1.9 s, Activity 1.9 s; CLS at most 0.025;
navigation 80 to 136 ms.

**Usable, not only painted** (`scripts/usable.ts`, the owner's R11 ask): per screen, the first frame on which the
heading is on screen, the key money figure shows a real value, and the primary control is drawn, enabled and topmost;
then how long pressing it takes to answer. Lab, 24 Nov, built interface with Brotli, median of 5 on the phone profile
(desktop in brackets, median of 3; everything within 125 ms there):

| Screen | Heading | Key figure | Primary control | Press answers |
|---|---|---|---|---|
| Home (free to use; Pay someone) | 2.08 s | 2.08 s | 2.08 s | 72 ms (64) |
| Spend (Pay from balances; the amount field) | 1.84 s | 2.62 s | 2.62 s | 48 ms (48) |
| Save (must stay in the bank; Park idle cash) | 2.42 s | 2.96 s | 2.96 s | 72 ms (64) |
| Grow (worth now; Buy or sell) | 2.43 s | 2.92 s | 2.43 s | 80 ms (64) |
| Protect (QED may move; New instruction) | 2.10 s | 2.59 s | 2.10 s | 80 ms (64) |
| Activity (what this came to; search) | 1.94 s | below the first screen | 2.36 s | 48 ms (56) |

Four screens showed their key figure after the 2.5 s budget on the phone profile (Spend, Save, Grow, Protect). Two
changes since, each measured against the alternative: successful data reads are sent compressed (Brotli or gzip, never
the session, sign-in or step-up answers, which carry a secret), cutting /api/home from 17.7 to 5.3 KB and /api/market
from 27.4 to 4.5 KB; and the opened screen's code is asked for at once, in parallel with the session check. Asking for
data early was measured and refused twice: other screens' data competed with their code on a slow link (headings 100
to 230 ms later for no gain), and Home's, asked before the session is known, made signed-out visits log refused
requests (the browser journeys caught it). After (median of 5, code early only): Home 1.93 s, Spend 2.20 s, Save
2.80 s, Grow 2.71 s, Protect 2.48 s for the key figure, headings unchanged, presses 48 to 176 ms. Save and Grow are
still over the budget: their screens' code is the larger part of what a phone waits for. Activity now opens on its
search and totals; the day book follows.

**R12, Grow and Save on the phone profile.** What a phone waited for (static import closure of each screen's chunk,
Brotli, beyond the shared entry of 117.7 KB): Grow 104.6 KB, Save 99.6 KB, mostly other screens' code (Safeguards took
`statusLine` from Instructions and `sessionDevice` from Security, which brought Protect, the on-chain wallet and
Security; Grow also took the wallet's section and its page helpers from Safeguards). Now: shared words in
`lib/words.ts`, page helpers in `ui/page.tsx`; Grow's price record (`PriceRecord.tsx` with `timechart.tsx`) and the
wallet's section are their own chunks, asked for once the figures are drawn; Save's chart is its own chunk
(`ui/score-lazy.tsx`). Grow 13.4 KB, Save 61.2 KB (of which the on-chain wallet, through `WalletSetAside`, is 36.8).
Lab figures, one computer under load from other work (load average 13 to 19 on 10 cores), the built interface with
Brotli on one fixture, before and after interleaved, five runs each (median, min to max); no field data exists:

| Screen | Heading | Key figure | Primary control | Press answers | LCP |
|---|---|---|---|---|---|
| Grow before | 2.46 s (2.45 to 2.47) | 2.72 s (2.70 to 2.75) | 2.46 s | 168 ms (160 to 176) | 2.50 s |
| Grow after | 1.84 s (1.81 to 1.90) | 2.11 s (2.10 to 2.18) | 1.84 s | 192 ms (144 to 256) | 1.95 s |
| Save before | 2.40 s (2.40 to 2.67) | 2.81 s (2.78 to 3.11) | 2.81 s | 192 ms (176 to 248) | 2.45 s |
| Save after | 2.25 s (2.20 to 2.28) | 2.61 s (2.60 to 2.65) | 2.61 s | 168 ms (160 to 352) | 2.29 s |

Grow is within the budget. Save's key figure is still over it: Save.tsx imports the wallet's `WalletSetAside`
directly, and its head's control sits inside the page's `aria-busy` root, so it counts as usable only with the data.
Both are Save's layout (not changed here); measured in the same session as an uncommitted experiment (the wallet's
part loaded after the figure, `aria-busy` on the waiting body only): heading 1.99 s, key figure 2.42 s (2.34 to 2.61),
control 1.99 s, press 136 ms. Waiting to draw Grow's lower parts until scrolled near was tried and refused: a screen
reader's list of headings and a find in the page would miss them.

**R12, Protect on the phone profile.** Protect's key figure ("QED may move") came at 2.96 to 2.98 s, against 2.43 to
2.44 s for R11's code (49da330) on the same data (each build on a fresh fixture from the same script, two rounds of
five; headings 2.13 to 2.14 s and 2.06 to 2.07 s). Not the data: each read answers in 0 to 25 ms on the server, and the ten reads are about 17 KB compressed. A
race: a browser keeps six connections to one server, and R12 split three more small files into Protect's code, so the
session check, sent after them, answered 0.2 s later (1.92 s against 1.72 s). The live stream's first hello, which
reloads every read made before it, then came just after Protect's seven reads had gone out (2.17 s against 2.15 s; on
R11 it came before them), and the reload threw away the answers still on their way: the page's single draw waited for
the second round, queued behind the connection limit. Four changes, each measured on its own:

1. A resource shows the first answer that comes back unless a newer one is shown already; a failure still counts only
   for the latest request (`answerOrder`, `src/lib/core.ts`). Alone: key figure 2.53 s.
2. The session check is sent before the opened screen's code (`App.tsx`). Alone it was slower (2.57 s: the shell drew
   earlier and its reads competed with Protect's code); with 3, the heading came at 1.79 s against 1.97 s without it.
3. Protect asks for the on-chain wallet's mandate part as its own chunk once it has drawn, as Spend, Save and Grow
   already did: imported statically it brought `Vault.tsx` (33 KB compressed), the last of Protect's files to arrive.
   `src/screens/first-draw.test.ts` holds every first screen to it. The part drew nothing until its own reading of the
   wallet came back before, and draws nothing while it loads now.
4. The first section a page opens on is placed, not glided to (`placeSection`, `src/ui/motion.ts`). The atmosphere's
   lights are registered, inherited properties, so a glide restyles every element on every frame: it ran through the
   1.1 s in which Protect became usable (about 700 elements a frame, 10 to 13 ms each), and a press then waited 75 to
   110 ms before it was handled. Between sections the lights still glide (M3).

Lab, phone profile, before (f84658e) and after on two fixtures from the same script, interleaved; median (min to max)
of ten runs for Protect and five for the others; load average 2.5 to 5 on 10 cores, from other work:

| Screen | Heading | Key figure | Primary control | Press answers | LCP |
|---|---|---|---|---|---|
| Protect before | 2.15 s (2.14 to 2.16) | 3.00 s (2.98 to 3.01) | 2.15 s | 56 ms (40 to 64) | 3.06 s |
| Protect after | 1.78 s (1.76 to 1.80) | 2.22 s (2.20 to 2.23) | 1.78 s | 80 ms (72 to 96) | 2.09 s |
| Home before, after | 1.99 s, 1.95 s | 1.99 s, 1.95 s | 1.99 s, 1.95 s | 88 ms, 88 ms | 1.66 s, 1.60 s |
| Spend before, after | 1.94 s, 1.78 s | 2.21 s, 2.07 s | 2.21 s, 2.07 s | 88 ms, 80 ms | 2.00 s, 2.15 s |
| Save before, after | 2.02 s, 1.88 s | 2.38 s, 2.18 s | 2.02 s, 1.88 s | 120 ms, 80 ms | 2.04 s, 2.05 s |
| Grow before, after | 1.93 s, 1.78 s | 2.18 s, 2.05 s | 1.93 s, 1.78 s | 144 ms, 72 ms | 1.96 s, 2.03 s |

Protect's press before was measured at 3.0 s, once its load had settled; after, the page is usable 0.8 s sooner and is
pressed then (pressed at 3.05 s it answers in 80 ms either way). LCP, kept for reference, is later on Spend and Grow:
it is the paint after the web font arrives (`font-display: swap`), and the font now shares the link with the shell's
reads, which start sooner (on Spend it arrived at 2.04 s against 1.96 s). Layout shift on Protect (`scripts/perf.ts`, 15 s watch, three runs
each): 0.0084 before and after on a computer; on a phone 0.0312 before and 0.0217 after, of which 0.0208 in both is
the Activity page the measure opens from the dock, so Protect's own shift went from 0.0095 to none.

Not changed: when the stream's hello still comes after a page's reads have gone out, the reload goes out too (about ten
requests, 17 KB on the phone's link after the page has drawn); it no longer holds anything back. A session answer that
carried the latest event's number, with the stream replaying from it, would make that reload unnecessary (a change to
the stream on the server, proposed). Skipping a redraw for an answer equal to the one shown was measured and refused:
the press did not change (144 to 176 ms), because the glide (4) was the cost.

### M14. The money bar (`src/ui/kit.tsx` MoneyBar and Swatch; `components.css`, "the money bar"), R12

One component draws every bar of money in parts: Home's position, Spend's "what stays free", Save's and Safeguards'
reserve, Protect's "QED may move" and the on-chain wallet's treasury. It replaced six copies (`hm-bar`, `pay-bar`,
`sv-bar`, `rv-bar`, `pr-bar`, `vt-bar`) whose kept part was a hatched yellow wash with an amber outline, whose held part
was a blue outline, and whose bracket of what QED may move was a glowing tide outline over the free part: the owner's
"fluorescent committed-amount outlines and yellowish washes" (R12 mandate, section 2).

- **From Earn's bar, which the owner preferred:** solid parts on one rounded track, separated by gaps, nothing glowing.
  Not taken: its amber part (amber keeps one job here, "waits on you"), its outlined part and its bracket over the bar.
- **True scale, one track:** the parts in a fixed order on a 12 px track, each 3 px from the next, so the panel between
  them draws every boundary and no part needs an outline. A part with a value under the bar's resolution is drawn 4 px
  wide so it can be seen; the figures beside the bar are exact.
- **One material per part,** a lightness ramp of one warm metal plus slate (Hallmark's data-viz rule: one lead series,
  the rest a ramp in a fixed order), told apart by lightness and pattern as well as hue: free to use solid and
  brightest (`--part-free`); kept for what is due hatched pewter (`--part-kept`, `--part-kept-line`); committed, held
  for orders, slate (`--part-held`); this payment, on Spend, bronze (`--part-pay`); taken from what is kept, red
  (`--part-over`); short, a dashed red hollow (`--part-short`), money that is not there (Home now shows it: it drew
  everything as kept while its headline said short).
- **What QED may move is a span, not a part:** a 3 px tide line with end ticks under the right end of the part it may
  come from, as wide as the most it may move (UI UX Pro Max's target marker, labelled in words). Nothing on the bar
  glows; nothing is outlined but the shortfall.
- **Words:** the track is one image whose label says every part and the span with their figures; its key, where shown
  (Spend, Save, Protect), is that sentence's visible form, hidden from a screen reader; the tiles and terms that name a
  part carry its `Swatch` (Home, Save, Safeguards, the wallet). Forced colours: CanvasText, a hatch and a dashed edge.
- **Measured** (`scripts/bar-contrast.ts`, pixels of the running app, WCAG 1.4.11; outputs in
  `evidence/design/r12-palette/contrast/`): every part 3:1 or
  more against the panel just above it, on Home, Spend, Save and the wallet, for both accounts: the lowest is kept, 3.31
  by night at 1440 and 3.95 by day at 390; free against kept 3.84 to 3.91 by night and 3.09 to 3.14 by day; the span
  9.07 to 9.52 by night and 5.35 to 5.51 by day; the shortfall's dashes 7.14 to 7.79 by night and 6.30 to 6.50 by day.
- **The same materials elsewhere:** the charts' kept region (Home's and Save's) is hatched in `--part-kept`; the floor
  rule's falls in `--part-kept-line`, its room line in `--part-reach`; the dollar threshold's mark, every limit meter
  (`.meter`, Spend's `.bnd-bar`), the Instructions and Compose bars and their status dots are flat, without glow.
- **Not yet carried over** (other owners' files, for the next round): the welcome screen's example bar (`shell.css`
  `.v-bar`, `.v-meter`), Ask's glyph over "QED may move" (`ask.css` `.ak-bound .v::before`) and Activity's bound bar
  (`activity.css` `.ac-bound-bar`) still draw the old glowing bracket. *R13: the welcome bar and Ask's glyph were already
  the span; the record's bound bar, the wallet's and the instruction document's bracket glyphs and Protect's holds bullet
  are now M14 too (below). Left: Grow's `.gr-sw.room` swatch (`grow.css`, the Grow specialist's file) still draws the old
  bracket in tide.*

### R12 refinements (24 November 2026): the owner's screen table, done in place

Meridian stays; these are corrections, each checked in the browser at 1440, 1024, 390 and 320 px in both themes, with
the browser's text at 24 px, with every label about 40% longer, and on a populated and a short, empty account.

- **Home:** the space beside "Good afternoon, Asha" holds the day, what QED is doing and the three actions (as wide as
  the actions in one row, set on the greeting's last line), not filler; on a phone the primary action spans the width
  and the other two share the row under it (it was two and one alone). The bar is M14; the figures under it are rows of
  one list on a phone; the hero and the net position fit their panels at any text size.
- **Spend:** the recipients are one list of rows as wide as the step, each with its radio's ring, however many there
  are (the card grid left a hole beside the last card); on a phone the progress rail is one row of numbered rings with
  the current step named (it wrapped four and one), the three kinds are three equal cells, a bill or a payment reads
  when and how much, then what; the bills and payments below take the checkout's two columns.
- **Save:** plain words for the hard passages ("until 6 Jan 2027, when money is tightest", not "the hardest day"; what
  the figure covers and what it does not; the what-if in two sentences; which salary is treated as lost, from the
  server's own allowance), the clearer explanations kept. Its chart's loading belongs to another specialist.
- **Protect:** what needs the owner is said as the thing to do ("Add a second passkey", "Name a recovery contact",
  "Add a recovery key to your on-chain wallet"); "How it holds" is "What enforces it"; on a phone the protections in a
  band are rows of one list (the band carries their kind) and a row that needs the owner keeps its tint. Safeguards'
  panels are containers, so the floor's three figures stack on a phone (they overlapped).
- **On-chain wallet:** M14 for the treasury; on a phone the treasury's parts, the other accounts and the mandate's limits
  are rows of one list (they were cards inside a card inside a panel), its panels keep 16 px at the sides like Home's.
- **Shared causes fixed once:** the bar (M14); glow on measures; amber doing two jobs (reserved money and "waits on
  you"); figures that pushed a phone page wider at large text (`--t-fig-*-fit`); paise in a red figure mixed down to
  2.8:1; panels without a container that container rules depended on.
- **Statement, a chosen period** (task comparison gap 9; `Passbook.tsx`, `server/statement.ts`, `shared/period.ts`):
  since opening, this week (from Monday), this month, last month or chosen dates, in India time, as one `.seg` group
  under the sheet's head (on a phone two equal columns, "Choose dates" across the last row). The four tiles are the
  whole period's: the balance at its start, money in and out with their line counts, the balance at its end (or now).
  A period is a run of the ledger's own order, from the first line entered at or after 00:00 IST of its first day, so
  each line keeps the ledger's balance after it, a line entered exactly at midnight opens the new day, the figures add
  up to the paisa, and a period that has ended never changes; a line entered late says when it took effect. Ordering
  by the time each event took effect was refused: an instalment taken late for want of money keeps its due time, and
  a balance run in that order would show amounts the account never held. An ended period closes on its end balance
  (`.pb-end`) where a running one draws the line marked now. The file is named by its days and opens with the period
  and the four figures. The period lives in the address (`/passbook?period=last-month`).
- **Activity, finding** (gap 9 and the copy fix): search forgives one slip in a name of 4 to 7 letters and two from 8
  (`src/lib/fuzzy.ts`; a swap of neighbours is one), never in a shorter word or a figure, and says which spelling it
  read; three more labelled filters, direction, amount (rupees, ends included) and dates (India days, either end open),
  the ranges on a row of their own across the bar; the count is a status, announced; nothing found names every filter
  in force, each removable, with one button to clear them all; the day book file names its days and opens with them
  and the rows chosen; the search and filters live in the address. A row's details are fragments without closing
  punctuation, joined once by `detailText` for the screen and the file ("Money sent.." came from a fragment that kept
  its stop).

Resources applied as checks, read in their own files on 24 Nov (READMEs and rule files, read-only; what each changed):
- **Hallmark** (data-viz reference, gate F20): the bar as a stacked bar with a 2 to 4 px gap, one lead series and a
  lightness ramp, labels never in the data's colour (the charts' "Kept" label went from amber to ink); no lone item on
  a phone's last row (Home's actions, Spend's rail).
- **Impeccable** (craft floor, layout, colorize, critique): squint test of each screen; "decorative glass" and nested
  cards (Protect and the wallet on a phone became rows); colour by role, never decoration (no glow on figures).
- **Unslop** (signs list): neon borders and coloured glows (the bracket, the meters, the dots, all gone); uneven sibling
  padding (the wallet's phone panels now match Home's 16 px).
- **Taste Skill** (gate and copy tells): 44 px targets (the recipient kinds on a phone are 44 px cells); the new
  sentences checked against its copy tells (no contrast frames, no self-praise, no filler openers).
- **UI UX Pro Max** (charts and colour data): a target marker labelled in text for what QED may move; its banking
  palette (navy and gold) recognised as the category default and so not chosen.
- **Interface Design** (installed skill): swap, squint and token tests; one depth strategy per surface; "keep one hue,
  shift only lightness" for the bar's parts.

### R12, gap 17: what a holding was bought at, why it changed, and a fund order's states (24 November 2026)

From the task comparison (`docs/research/qed-ux-accessibility/20261124-r12-task-comparison.md`, T4-a to T4-d). Words,
figures and states only; no new colour or material.

- **Bought at** (Grow, under each holding's name, table and card alike): one purchase says its price, its NAV day and
  its allotment day ("Bought at ₹178.6000 a unit, the NAV for Tue 24 Nov; allotted Wed 25 Nov"); several say the
  average over the units held and how many purchases, and **Each purchase** opens the list (day, units held of units
  bought, price and NAV day, cost of what is held with its charges; together the cost the row shows). A purchase is an
  order: a market order's several fills are one purchase. A day is one word on a line (`.gr-nb`, no-break spaces).
- **Why it changed** (a disclosure under the figures): since the holding was first bought (its present life, after it
  was last empty), from nothing to what it is worth now, in three lines and a total written as the floor's subtraction
  is: money put in less money taken out; price movement on the units while held; costs (fees, stamp duty, taxes and
  rounding, each named). The lines come from the ledger's own entries and add up to the paisa (`server/performance.ts`,
  property-tested); price movement is within half a paisa of the units times each price change. Under them the annual
  rate: money-weighted, an XIRR on the dated money in and out, shown once a holding is a year old, and otherwise why not.
  Gains and losses carry the sign and the word as well as the colour.
- **A fund order's states**, the same words on the record, Home, Grow and Activity (`src/lib/fund-stages.ts`): *Order
  with the registrar*; *Money received by the fund house, Tue 24 Nov* (it arrived before or after the cut-off, so it
  takes the NAV for that day or the next); *Units allotted, Wed 25 Nov* (units at the NAV for its day). A redemption:
  with the registrar, *Units redeemed*, *Money paid to your bank*. Home's "With the fund house" names only orders whose
  money is there (purchases, and redemptions redeemed); a redemption still with the registrar is units, in Investments.
- **Days as words** on the order sheet, the record, its checks and Grow: "the NAV for Wed 25 Nov", the year only when
  it is not this year's (`shared/day-text.ts`). Not changed here: the price record's "NAV for Tue 24 Nov 2026" (M6),
  which keeps its year; whether the two should be one is for the owner.

### M15. Saving for a goal (`src/ui/goal.tsx`; Save's `sv-goal*` rules in `save.css`), R12

A goal is a card (R12 task comparison, gap 5). What is set aside leads, as the card's medium figure fitted to its width.
Under it the goal at true scale on the money bar (M14), with no new material: set aside in the kept metal (it is kept:
no instruction can spend it), the contributions still scheduled in `--part-pay`'s bronze (money that will move, as on
Spend), and what would be short on the date as the dashed hollow. Then three readings (each month, next, on the date),
which become rows of one list on a phone, and the on-track rule in the server's own words.

- **Behind:** the remedies are rows on the amber of "waits on you", each with its control: more a month and a later date
  (the goal signed again, the passkey signing the new document), a sum now (a payment by hand into the set-aside). A
  paused goal offers Resume first. What happens if nothing changes closes the block.
- **Reached, date passed, stopped:** what happens to the money, and Release (how much, then the approval sheet).
- **Elsewhere:** the same card on the goal's instruction record; Home shows a goal only when it falls behind, as a need.
- **Measured** (24 Nov, design fixture): glass contrast 0 below threshold on Save, Home, the record and the form (night
  1440, day 390); bar parts against their card 3.38 to 5.12 by night and 4.12 to 6.63 by day. Set aside against
  scheduled is 1.02 to 1.5: they are told apart by the hatch and the gap the card shows between parts, as M14 intends.

### R13 refinements (24 November 2026): the screen table completed, the bar family finished, larger text

The owner's R13 (section 6): complete the R12 corrections that remained, preserve the ones that were done, and keep the
fluorescent-outline and yellow-wash correction to the flagged bars and the components that cause them. Audited first on
the design fixture (a populated household and a short, empty one) at 320, 375, 390, 1024 and 1440 px in both themes, with
the browser's text at 200% (Chrome's own default font size, from the first paint, not a style laid over the page); the
photographs, before and after, are in `evidence/design/r13-design/`.

- **The bar family, finished (M14).** Rendered comparison over the real screens (Home, Save's goals, Spend's bar with a
  payment, the wallet's limits; night 1440 and day 390), three treatments laid over the running app as CSS
  (`evidence/design/r13-design/palette/`): A as it was, B "bronze and steel", C "pewter and slate". A's "this payment"
  and a goal's "still scheduled" were `--part-pay` at hue 70 to 76, chroma .11 to .12: a long mustard bar on every goal
  card (M15 had brought the yellow back into Save's bars); the meters of authority and the span were cyan at night
  (oklch 78% .085 212), six full-width lit strips on Home. C took the yellow and the cyan out but left "this payment" a grey
  that read as kept money. **B, chosen:** `--part-pay` is true bronze (night oklch 62% .075 58, day 56% .08 55), still its
  own warm material and 3:1 on its panel; `--part-reach` is a calm steel-tide (night 74% .055 220, day 47% .075 228);
  meters are 6 px; the tiles and panels beside a bar that carry QED's figure (Home's "QED may move", Protect's "QED may
  move" and an instruction's "What it may still do", the wallet's QED tiles and the limit that binds) keep their tint
  and lose their tide outline (the binding limit's double outline too). The old bracket shape is gone from the record's
  bound bar (now flat parts with the span under the track; "asked, not sent" hatched instead of outlined; forced-colours
  fallbacks), the wallet's and the instruction document's crossing glyphs and Protect's "what holds" bullets. Chips,
  QED's seal, the calm state and the notices keep their tide: they are not bars.
- **Home:** the head stays side by side down to 900 px (it stacked at 1099 px and left the right half of a 1024 px stage
  empty beside the greeting), the actions a little tighter there so the three keep one row; from 760 to 899 px they share
  the width in three equal cells. An empty receipt chain says "No receipts yet", not "0 receipts, chain intact".
- **Save:** the goal bars are bronze, not mustard; the dues note ("QED counts on the salary due 1 Jan 2027 only from 6 Jan
  2027, the latest it may arrive") and the instructions' note ("the most each signed instruction's limits allow, not what
  it usually does") say what is counted and what is not in plain sentences. The chart's axis column and each lane's are in
  rem, so labels fit at any text size; the lanes are bounded by their panel (at 200% text they ran 69 px past a 390 px
  phone).
- **Protect:** where a rule holds is a neutral chip with its enforcer's mark (`Scope`), never a passed check's green: QED's
  server "Every action" (it holds only while QED itself is sound), the co-signer "Each payment" or "Required", the chain
  "Even if QED's server fails", with the plain fact that here it is a test chain on this computer and the contracts are not
  externally audited. Observed states (the engine running, a session here only, recovery ready) keep their colours.
- **Activity:** the amount filter's note is a parenthesis in its legend, so the fields are the bar's last row and the count
  sits one ruled line under them (the bar's foot was about 80 px around one number). The net change is said once: on a
  computer the statement's sum line holds it at the lead size, under what came in and what went out by who moved them;
  on a phone it leads, then the two lines that make it, who moved each under it (it had been said three times when nothing
  came in). The wallet's figures stand on the same right edge as the bank's totals, its lead at the same size.
- **Security, the passkey group:** one sentence on what a passkey is; the keys as rows (a row with nothing to do has no
  empty action line); what to do if a device is lost (with one passkey: that it means a recovery) and why removing one
  waits, as two labelled lines; "Add a second passkey" when there is one, a button named "Add a passkey" (the browser asks
  where to keep it, this device or another, so "on this device" was not accurate) and one sentence that QED receives only
  the public key. On a phone every part of the page is a ruled section of its panel, not a card in a card in a panel
  (three nested boxes left a passkey's details 150 px wide at 320 px).
- **Larger text (200%) without loss:** at 390 px nothing is cut off on Home, Save, Protect, Activity, the wallet's pages,
  Security or Safeguards (was: Home's lanes, Save's lanes and windows, Activity's lead, the wallet's figures, ticks and
  stamps, a Security link). Shared causes fixed once: a grid with an `auto` column grows to its widest content (now
  `minmax(0, 1fr)` where it holds text), figures without a fit size (`--t-fig-*-fit` on Activity's lead and the wallet's
  figures), and status chips that never wrapped (on a phone a stamp or chip now wraps inside its pill; at the default size
  it is one line). The top bar's practice chip moves under the mark instead of sliding beneath QED's state (at 150% and
  200% on a 390 px phone it overlapped). Not fixed: 320 px with 200% text (twice what the reflow criterion asks at that width)
  still clips Home's chart and "Where your money is", Save's hero and its period buttons, Protect's "In force" figure, the
  wallet's signer list, Safeguards' panels and the dock's last item.
- **Sign-in:** the agreed composition is unchanged (checked at 320 to 1440 px in both themes); its example bar takes the
  bar family's materials through the tokens.

### R14 layout rules (25 November 2026): shared causes, fixed once

The owner's R14 screenshots (`docs/mandate/r14-screenshots/`) showed the same few faults on every screen. Each has one
rule here, in a shared file, and every screen applies the rule instead of its own CSS. A screen that needs something a
rule does not give changes the rule, here, for every screen. Before and after photographs:
`evidence/design/r14-core/` (`node scripts/r14-core-shots.ts <label>`).

**L1. The bars** (`shell.css` `.app`, `tokens.css` `--bar`, `App.tsx` `usePinnedBars`, `base.css` `html`). Two bars
are pinned to the window: the top bar and the bottom navigation. Nothing is unreadable or unreachable under either.
- Each bar is 97% solid on its own (`--bar`). Blur is a finish; legibility never rests on it (a browser that drew no
  backdrop blur showed the page's words inside the bars).
- A scrim stands behind each bar (`.app::before`, `.app::after`): the page fades as it passes under, so no line is cut
  beside a bar or shows in the strip between a bar and the window's edge.
- The page's foot padding is the navigation's measured height (`--bar-bottom`) and a step of air: the last control can
  always be scrolled clear. Never a fixed number of pixels for a bar's height.
- What takes focus, and what a `#anchor` names, is scrolled clear of both bars. The bottom navigation's height is
  counted once, on the scroller (`html { scroll-padding-bottom }`). The top bar's is counted on the target:
  `scroll-margin-top: calc(var(--bar-top) + var(--s4))`, which `base.css` gives every part with an `id` and every
  control that can take focus. Never both for one edge: counted on the scroller and the target, the top bar left a
  gap of two bars above every anchor (`#goals` landed 96 px under the bar).
- What sticks inside the page sticks under the top bar: `top: calc(var(--bar-top) + var(--s4))`.
- A surface that floats over the page (a chart's label, a menu) uses `--bar` or `--sheet`, not a pane.

**L2. The sticky side summary** (`src/ui/sticky.ts`, `kit.tsx` `useStickySide`, `components.css` `.sticky-side`). A
summary beside a longer column stays in view, starts level with the column's top and ends level with its foot.
- Use: `const side = useStickySide<HTMLElement>()`, then `<aside ref={side} className="sticky-side …">`. The layout's
  own CSS says at which width it has two columns (`position: sticky` there; `.cols > .sticky-side` has it from 960 px).
  Nothing else: no `top`, no `max-height`, no scrolling inside the summary.
- The hook sets `--sticky-top`. `pinned`: under the top bar, as plain sticky, when the column's foot passes the summary
  before the page ends. `lowered`: pinned lower, a fixed place, when the page ends first. `drift`: the pin moves down
  evenly over the whole scroll, when the window is tall and the page short. `static`: not pinned, when the summary is
  taller than the room between the bars (so all of it can be reached).
- The summary's column is its parent element. Put the summary and the action that belongs to it (Spend's "See what
  this would do", set-up's "Open the household") in the one sticky element.

**L3. Columns, cards and fields.**
- *The board* (`src/ui/board.ts`, `kit.tsx` `useMasonry`, `.board`): two columns that stack independently. Two cards
  whose feet would miss by 72 px or less are made level (the shorter is lengthened); the two columns end together when
  they differ by 168 px or less; a last card marked `data-col="auto"` goes under the shorter column, or closes the
  board across both when they are level. A lengthened card carries `data-fill` and a least height: content at the
  top, its `.panel-foot` at the bottom. A board's cards are never stretched to their rows (`align-self: stretch`): a
  card's own height must stay free to change, or one that grows later (its figures arrive, a disclosure opens) runs
  over the next unseen. If two columns still end far apart, mark one more closing card `auto` (Home's holdings by
  currency and "Ways to do better" are); do not add a spacer.
- *Two columns of a page* (`.cols`, `.cols.even`): the main column and a 380 px side; one column below 960 px, in the
  document's order.
- *Cards in a row* share one height (a grid stretches them; never `align-items: start` on a row of tiles). A card that
  must fill a height it did not ask for is a column (`.fills`) whose last part takes the rest.
- *Fields in a row* (`.form-grid.cols-2`, `.form-grid.cols-3`): a row is full or the fields are one column; never a
  last field alone under a full row. Group fields by what they are (what you have: two; what you owe: three) so each
  row is whole. A single field in `.cols-2` keeps a field's width. Each falls to one column by its own width, so it
  holds inside any panel.
- *A field beside its words* (set-up's `.setup-ccy`): the control keeps a field's width; what it decides is said
  beside it, not above it across the panel.
- A footnote under figures has air and a hairline (`.reserve-basis`); it is never set against the cards it explains.

**L4. The money field** (`kit.tsx` `MoneyInput`, `src/lib/money-entry.ts`, `components.css` `.money`). One field for
every amount a person types. Its sign, grouping and decimal places come from the currency: the household's home
currency, or `currency="JPY"` for an amount held in another. The value is whole minor units of that currency (yen 0
places, Bahraini dinar 3; never times a fixed 100).
- Never type a currency sign into CSS, a placeholder or a hint. Write a figure with `fmt.money`; a field with
  `<MoneyInput>`.
- An amount field that is not `MoneyInput` (text kept as typed for the server to read) must still show the currency:
  wrap it as `<div className="money" data-sign={entryFormat(code).sign} data-sign-len={…}>`. A bare
  `<div className="money">` means test rupees on the on-chain wallet and nothing else.
- A screen that enlarges the field sets the wrapper's font size and `--sign-left` (Spend's `.pay-amount .money`); the
  digits then begin after the sign whatever its length. Never a fixed `padding-left`.
- `node scripts/r14-currency-audit.ts` reads every screen of a household in each home currency for a rupee sign it
  should not carry (in the text and in what the stylesheet writes) and for an amount field with another sign;
  `browser/tests/r14-layout.spec.ts` holds the same for the screens with amount fields.

**L5. The balance charts** (`src/ui/chart-marks.tsx`; Home's `horizon.tsx`, Save's `score.tsx`). Nothing is written
across the line.
- A day money moves is a numbered ring beside its step, placed clear of the line, the other rings and the lowest
  point (`placeMarks`); the same number names the day in the list under the chart (`ChartEvents`): the day, what
  moved, how much, with its sign. Every day is there at every width; past eight they wait behind one disclosure.
- A figure that belongs to the key is written in the key ("Kept for what is due: ₹1,57,548.63"), not on the plot.
- The pointer's label stands beside the reading line, inside the plot (`tipPlace`): never over the axis figures, the
  dates along the foot, or the day being read.
- Colour says one thing: the lowest point. Money in is told by its plus sign and a thin green ring. The line's glow is
  a trace. The chart keeps its keyboard reading (arrow keys on the plot) and its Statement view.

**L6. Empty states** (`kit.tsx` `EmptyState`, `components.css` `.empty-state.guided`). An empty part says what it
is, why nothing is in it yet, and the one next step: `<EmptyState icon={…} title="…" action={…} fill>…</EmptyState>`.
Never a figure of zero alone in a tall card. With `fill`, inside a card that is a column (`.fills`), it takes the
height the card has left and sets its words in the middle of it.

### R14, Spend and Save (25 November 2026): the two screens on the layout rules

The owner's screenshots 7 to 19. Before and after photographs of whole pages, each part and the states a still page
does not show: `evidence/design/r14-spend-save/` (`node scripts/r14-spend-save-fixture.ts`, then
`node scripts/r14-spend-save-shots.ts <label>`; measured checks: `node scripts/r14-spend-save-checks.ts`, which writes
`checks.json`). Four throwaway households: a rupee one and a US-dollar one, each with and without data.

**What is added to the shared rules** (small, and each in the shared file):
- *Fields on one baseline, hints under their controls* (`.form-grid.fields`, with L3's `.cols-2` or `.cols-3`): every
  label on the first line (its foot, when one wraps), every control on the second, each error and hint under its own
  control, by `subgrid`. A hint between a label and its input pushed that input a row below its neighbours' (the
  owner's screenshots 7 and 16). In the document the hint still precedes the control it describes
  (`aria-describedby`). Without subgrid the fields still read in that order; only the shared lines are lost. A form
  grid without `.fields` is unchanged (hint over the control): the grids that line controls up by their feet
  (`align-items: end` on Earn, Protect and the wallet) would otherwise lose their line; they can take `.fields` one by
  one.
- *A choice inside a field* (`.seg.fill`): as tall as an input beside it, its choices sharing the width, each a 44 px
  target. No track runs on empty past the last choice (screenshot 16).
- *A disclosure* (`details.disclose`): long detail behind a plain first line. One look, a 44 px target, every word still
  in the page. Used for rules and regulatory text: the first line says what a person must know before acting; the
  disclosure holds the text in full, unchanged.
- *The empty state across a wide panel* (`EmptyState across`, `.empty-state.guided.across`): its words on the left and
  its next step on the right of one row, where L6's stacked form would be a short column beside an empty half
  (screenshots 15 and 17). It stacks where its panel is narrow.
- *The chart's rail* (`score.css` `.sc`, `score.tsx`): Save's what-if follows the chart and the instructions drawn on
  the chart's own days, across the width, at every size, and in that order in the document. Beside the chart it stood
  far taller than the chart and left a hole under it (screenshot 18).

**Spend.** The checkout keeps its two columns from 960 px: the steps, and the summary pinned beside them (L2).
- Every step is one column as wide as the step: a control, then what it means under it. The note for your records is
  a field of its own under the amount, never a second column beside it (screenshot 8).
- Step 5, Review, is in the journey: the bank at true scale with this payment in it, and the subtraction. The summary
  keeps who, how much, the route, the one figure (free now, or what stays free after it; and, in red, what it takes
  from money kept for what is due) and the button. With the review inside it the summary was taller than a laptop's
  window, so L2 could not pin it.
- Under 960 px the summary follows the steps as their last one, and the payment travels with them as one line above the
  bottom navigation (`PaymentStrip`): who, how much, and a link to the summary. It shows once there is someone or an
  amount to show and gives way when the summary is on the screen. It is a way to the review, never an approval: the
  terms are asked for in the summary and signed in the sheet, and the server checks the signature and the payment.
- From the on-chain wallet the rail stands at "To" and claims nothing after it: that step is one form of its own.
- Under the checkout every part is the whole width and composed in columns inside it, so no part stands beside a hole
  however long a neighbour's list grows: bills on record (a bill is one line across the width from 860 px), subscriptions
  (what they are on the left, what was found on the right), paying abroad (who and how much beside the route and the
  year's limit; the form to add a payee takes the width while it is open), the services (three rows: the mandate's
  limits beside the services it names, the choice of product beside what decides, what was bought and refused), and
  payments so far.

**Save.**
- Row one is two cards of one height: the figure with what it allows for (the change in that heading's row), and what
  it pays for with what it does not count under it. The statement folds after five dated lines, so the two stay within
  about 75 px of each other; the difference is shared out inside the shorter card (auto margins above the figure's two
  lower blocks; the statement's lines a little further apart), never left as one hole (screenshot 14).
- Balances by currency, the desk and the goal in another currency are each the whole width: the total beside the rows,
  the desk's four fields on one line from 1000 px (two rows of two below), a goal's standing beside what is left
  (screenshots 15 to 17).
- The cash flow: the chart, the instructions on its days, then the what-if across the width, three columns of two
  fields, each column one thing that could go wrong.
- The last row is three cards on row one's two columns, ending on one line (L3, cards in a row): the most the
  instructions could take over the floor, and what is kept and set aside beside both; its last part takes the height it
  is given (screenshot 19).
- Every button on Save is a 44 px target, as on Spend.

## Bounds (23 November 2026, R10): rejected by the owner on 24 November 2026 (D-108); kept as the record, not to build on

**This section supersedes "Proof", "Clear" and everything older wherever they disagree (D-099).** The owner rejected
Proof and its colours, after D1 to D4, the R7 merge and Clear. Clear and Proof had the same information architecture in
two skins (a hero figure, then lists of rows and cards with long sentences), so the redesign changes the composition
and the interaction model, not only the colours. Every fact, figure, route, control and test hook the screens had is
kept unless a rule here says otherwise; a control whose words change for a reason has its browser journey updated in
the same commit. The rules of the oldest system on words, figures, states and accessibility (its sections 1, 5, 7, 9,
11) still bind.

### B1. The idea

*Every amount QED may touch is shown inside its bound, on one line of time.* QED's product is bounded authority over
money that moves on dated days. So the two signature devices are **the bound** (a bracket that marks the most QED may
move, drawn over the money it may come from) and **the score** (one time axis on which the bank's worst case, what
falls due and every standing authority's runs are read together). Everything else is quiet graphite on white.

Why not the rejected worlds: Hallmark's "spent" list names the faults of the earlier rounds exactly: a pale ground
with one timid accent (Clear), a subject painted on (Proof's seal, intaglio and banknote world), a hue picked for the
category (blue in D1 to D4). Bounds takes its colour from meaning, its character from the two devices and the mark,
and its layout from the questions a person asks: what can I use, what is kept and why, what will QED do and when, what
needs me, what happened, where is my money.

### B2. Tokens (`src/styles/tokens.css`; never a literal colour or font outside it)

- **Brand: Tyrian** (`--brand`, `--brand-2` fill, `--brand-3` pressed, `--brand-bg`, `--brand-line`). Tyrian purple was
  the colour of granted authority; here it marks only QED's own hand: what QED may do (the bound, the score's lanes),
  what it did ("By QED"), what it proposes, the one primary action of a view, links and focus. It sits in the widest
  gap of the status hues (green 155, amber 70, red 27, blue 250), so it is never read as a status.
- **Neutrals:** one cool graphite ramp: `--ground` (page), `--sheet` (surfaces), `--sheet-2` (raised rows),
  `--well` (inset fields, tracks), `--ink`, `--ink-2`, `--ink-3` (all at least 4.5:1 on every surface), `--ink-4`
  (disabled, decoration only), `--rule`, `--rule-2`, `--edge` (3:1 boundary of anything typed or chosen).
- **Status:** `--gain` money in or a passed check, `--loss` refused, failed or short, `--hold` in progress, `--due`
  waiting on you (`--due-mark` for its 3:1 marker); each with a `-bg`. A status always carries a word and an icon.
- **Charts:** `--c1` to `--c6` in order; c1 is ink (the owner's money), c2 is QED's; the rest separate by lightness
  as well as hue, each at least 3:1 on the surface.
- **Measured (23 Nov, `scripts` in the R10 lab):** every text pair 5.3:1 or more in light and 6.0:1 or more in dark
  (ink-3 on well is the lowest in light, 5.28); edge 3.19 and 3.97; focus 7.6 and above; chart series 3.2 to 6.6.
- **Type: Reddit Sans** (OFL; `src/fonts/reddit-sans/`), one family, weights 400 to 760. Chosen from eleven open faces
  by the measured gates that matter for money: tabular figures, compact digits, and currency coverage (₹ € £ ¥ ₩ ₦ ₺ ₫;
  ₿ falls back). Schibsted Grotesk's figures were too widely spaced, Atkinson Hyperlegible's slashed zeros read as
  code, Geologica was four times heavier. Scale: 12, 13, 15, 16, 17, 19, 22, 28, 40, 56 px (`--t-*`), each set once.
  Figures are tabular and lining wherever they change; the paise of a hero figure are set smaller.
- **Shape by rank:** the instrument 16 px, panels and rows 12, controls 8, status 6; a pill only for chips and the
  status control. Depth is one ring (`--lift-1`) on resting surfaces; only what floats (the Ask dock, menus, sheets)
  has a shadow.

### B3. The shell (`src/app/App.tsx`, `src/styles/shell.css`)

A top bar: the mark and name, the practice chip, seven sections (Home, Spend, Save, Grow, Earn, Protect, Activity),
then the one pause control (QED's state in words and its action) and the account menu. Under 1100 px the sections
move to a tab bar (Home, Spend, Ask, Activity, More), Ask in the middle. **Ask is docked** on every page but its own
(wide screens): one line until used, then this page's questions above it; ⌘K focuses it; sending hands the question to
the Ask page in memory (`handAsk`), never in the address. Protect and Activity have their pages as tabs at the top
(`SectionNav`): the on-chain wallet's pages are under Protect (D-080: it is used from the everyday pages).

### B4. Composition rules

- **Answer the screen's question first, in figures that add up.** A screen opens on its instrument: the few figures
  it is about, written so the parts visibly add up (free + kept = in your bank), then the device that explains them.
- **No card soup.** Content that is a list is a list of full-width rows on one surface with hairlines between rows,
  not a grid of cards. Things that need the owner are full-width rows with a coloured leading edge and their actions
  on the right. A grid of equal tiles is allowed only for things that are truly equal and few (four figures).
- **No paired panels of unequal length.** Two lists that would end at different heights are one panel on shared
  columns (Home's day book, split at Today), or stacked. A two-column panel ends its columns together (totals on one
  line). `scripts/design-checks.ts` still fails a column under 35% of its neighbour's height.
- **Never truncate an amount.** Labels wrap to two lines; amounts never ellipsize.
- **One sum, one way (D-097).** A sum a chart labels is written as the figures beside it write it: if the instrument
  says ₹6,95,030.18, the chart's "Lowest" says ₹6,95,030.18, not ₹6,95,030. Rounding is for axis ticks only.
- **Nothing recorded is drawn as its edges and its name, never as a filled shape over a chart** (R10 Grow: the opaque
  block over the Bitcoin chart was a full-height rectangle for a stretch with no record). Pointing inside it reads
  "No record from … to …", and the values table lists the stretch.
- **Explain once, briefly.** One sentence under a figure; the rest one press away (`Clamped`, disclosures). Copy names
  things by what a person sees ("kept for what is due"), never by how the system is built.
- **Every region has four states:** a skeleton in its shape, an empty state that says what belongs there and offers
  the action that fills it, an error with what to do (`Problem`), and the full state.

### B5. The two devices

- **The bound** (`PositionBar` in `Home.tsx`; reuse its classes or its idea wherever a limit is shown): the money at
  true scale (free in ink, kept hatched, held in blue), and the most QED may move as a Tyrian bracket over the part it
  may come from. A limit elsewhere is the same idea in one row: used, left, and the bracket at the limit.
- **The score** (`src/ui/score.tsx`, styles in `src/styles/score.css`): labels, one plot column whose leading edge is
  today in Tyrian, and a figures column. Row one is the bank balance at worst as true steps (`runwayDays`, tested to the
  paisa), the amount kept hatched between the line and the lowest level, the lowest point marked; then one row per
  standing authority: filled dots where QED acts, rings where it asks first, an amber square where something waits for
  the owner, a dotted line for what only watches, a band for a contract's grant, a tick where the authority lapses,
  and what is left of its limit on the right. Pointer, finger and keyboard read any day into one live line; a
  Statement view gives the same days as rows. On a plot under 420 px the event labels give way to the reading line.

### B6. Home

What needs you (full-width rows; finishing set-up is one of them); the position as one instrument (four figures, the
bound, the score with its lanes); one day book (coming up, then Today, then what happened, on shared columns); where
the money is as a balance sheet (what you have beside what you owe, totals on one line); ways to do better from the
fixed rules, worked out only when asked and opened only as unsigned drafts.

### B7. Briefs for the other screens (what each must become; owner's defects in brackets)

- **Spend** [connected journey, no reserved blank areas, no confusing totals, no disconnected approval]: one journey on
  one surface: who, how much, from where (account, wallet), the route and when it arrives, the bound it falls under and
  what is left, the free money after it, then the signing step in place (the approval sheet opens from the journey with
  the same figures). Bills and instructions that pay are rows with their bound.
- **Save** [no staircase layouts, no decorative charts; cash flow, commitments, reserves, thresholds, scenarios]: the
  score at full size with the Statement; a scenario strip that changes the worst case's assumptions locally (spend X
  today, a salary late, a bill larger) and redraws the line beside the recorded one, clearly labelled as a what-if
  that changes nothing; reserves and set-asides as rows with their bound.
- **Grow** [misaligned risk bars and prices; the opaque Bitcoin chart block]: holdings as a ruled table with aligned
  columns (value, change, worst case if limits hold, limit), price charts with labelled axes, source and freshness,
  and the protective floor as one rule; find the Bitcoin chart block's real cause in its rendering code and fix it.
- **Earn** [timeline and escrow composition, uneven heights, empty income areas]: each job as one row with its
  lifecycle line (offered, in escrow, delivered, paid) and whose move is next; money in as a day book; no empty panels.
- **Protect** [unexplained gaps; observed vs configured vs enforced]: three bands, each with its own colour-free label:
  what QED observes (devices, sessions, recovery state), what you configured (limits, payees, instructions), what is
  enforced independently (the wallet's contract, co-signing, the kernel's checks), each row saying who enforces it.
- **Wallet and onboarding** [no contract knowledge needed]: plain words first; addresses, chains and hashes one step
  down; set-up as a short guided flow with the passkey step named for what the device does (Face ID, Touch ID, Windows
  Hello, a security key).
- **Activity, statements, evidence** [clear records, useful detail, traceability]: a day book with filters; each row
  opens its record; a record is a document with its checks and references one step down.
- **Ask**: the conversation, its proposals and the composer on one surface; the composer stays at the bottom, above a
  phone's keyboard; proposals are rows with their bound and their checks; nothing scrolls inside a fixed box.

### B8. Checks before a screen is done

Tokens only (no literal colours or sizes; `src/styles/type-scale.test.ts`, `scripts/css-collisions.ts`); every screen
photographed at 1440 and 390 px in light and dark and read figure by figure; `scripts/design-checks.ts`,
`scripts/a11y.ts` and `scripts/design-measures.ts` on the fixture; a walk at 375 and 320 px in a real browser (touch
targets of 24 px or more, no sideways overflow, focus never under a pinned bar or the Ask dock, sheets usable by
keyboard); the browser journeys that read the screen's controls by name.

Found by the walk at 320 and 375 px on 23 November, now rules: a link set in a row of text (a lane title, a payee in
the day book, a name on the balance sheet) reaches 24 px with block padding and an equal negative margin, so the row
does not move; a chart's key wraps rather than running past the window; sideways tabs bring the current tab into view
and fade an edge that has more beyond it; a figure in a narrow column may wrap after its amount, never inside it.

### B9. Transitional aliases

`tokens.css` maps Proof's names (`--peacock*`, `--marigold*`, `--teal*`, `--paper-*`, `--on-field-*`, `--seal-*`,
`--ovi-*`) to Bounds roles so that unconverted screens still draw. A screen is converted when its stylesheet uses none
of them; the aliases are removed when the last one is.

### B10. Resources applied in R10: technique, change, outcome

What each resource actually changed in this build, and how the result was inspected. Pins and what was read are in the
resource record of 18 November (`docs/research/qed-ux-accessibility/20261118-design-resource-playbook.md`, section 1);
this list adds only what R10 applied. A resource not listed here changed nothing in R10.

| Resource (playbook row) | Technique used | Change in the product | Outcome, inspected |
|---|---|---|---|
| Anthropic frontend-design (row 10) | Plan first, then review the plan against the five generated-look clusters and the template-chrome list | Tyrian on graphite neutrals instead of the rejected Proof; Reddit Sans; no eyebrow labels, middle-dot meta strings or arrows on links (B1, B2) | Compared side by side in the direction lab (`docs/research/qed-ux-accessibility/20261123-r10-direction/`); owner review pending (R10-004) |
| heydamir/unslop (row 6) | Its signs of card soup, repeated tiles and paired panels | B4: content that is a list is rows on one surface; no paired panels of unequal length; Home's day book on shared columns | Protect, Activity, Earn, Save and the wallet rebuilt as rows (their photographs); `scripts/design-checks.ts` 0 findings over 30 screens |
| meodai color-expert (row 11) | Role tokens; contrast measured on the composited colour | `tokens.css` roles with text at 5.28:1 or more (light) and 6.0:1 (dark); `--on-loss` added when a red filled button measured 2.8:1 | axe colour contrast, the accessibility pass on the merged build |
| pbakaus/impeccable (row 3) | Its typesetting and critique rubric: few sizes, one scale | A seven-step type scale with four figure sizes, held by `src/styles/type-scale.test.ts` | Grow went from 8 type sizes to 6, Earn from 8 to 7 (their measures) |
| Google Fonts (fontsource 5.3.0) | A self-hosted OFL face with its coverage read (fontTools) | Reddit Sans: tabular figures and the most currency signs among the candidates (₹ € £ ¥ ₩ ₦ ₺ ₫); hashes pinned in `THIRD_PARTY_MATRIX.md` | No font request leaves the app |
| Context7 (SimpleWebAuthn 14 docs) | Conditional mediation: `useBrowserAutofill`, `WebAuthnAbortService` | Passkey autofill on sign-in (D-101) | `browser/tests/passkey-autofill.spec.ts` (virtual authenticator only) |
| Playwright MCP and `scripts/a11y.ts` | A walk at 320, 375 and 640 by 360 px; Tab and Shift+Tab focus walks | The fixes of `38dee2f` and `e4d49f7`; the script now names the stops it finds half hidden | No sideways overflow at seven widths; the counts in EV-080 |

Not applied in R10: Hue (the Bounds design skill that replaces `qed-proof-design` is still to be generated); Hallmark,
Taste Skill, UI UX Pro Max and Interface Design beyond what the 18 November playbook already took from them; GSAP
(reference only); the Figma, Paper and 21st Magic tools (they need an account or a key: inaccessible).

## Proof (22 November 2026, R9): superseded by Bounds (D-099)

**This section supersedes "Clear" (below) and everything older wherever they disagree.** The owner rejected Clear and
the five directions before it (D-069; R9 owner directive of 22 Nov). Proof replaces the visual world, the shell and the
composition of every screen; it keeps every fact, figure, route, control and test hook the screens had, and the rules
below "Clear" on words, figures, states and accessibility (sections 1, 5, 7, 9, 11, 12 of the oldest system) still bind,
except where Proof decides otherwise: section 12's bans on gradients and on rounded cards with soft shadows give way to
Proof's seal ink (a conic gradient, on proof only), the sign-in field's glow, and 20 px panels with layered shadows
(D-092, D-093).

### P1. The idea and the world

*Money moves only with its proof attached.* QED's founding sentence ("an AI agent should move money only when it can
prove that it should") becomes the look: whatever carries proof (a receipt, a signed instruction, a verified record,
the vault's chain state) carries the **proof seal**, a small square printed in an optically variable ink, as the
security thread and numeral on an Indian banknote change colour. The world is Indian money as a printed security
document: banknote intaglio, the peacock's blue-green with its bronze eye, marigold, the passbook's ruled columns.
Derived through Impeccable's world steps (seven systems from the audience's world, three material families; the rut
named and refused: navy-and-gold banking, dark dashboard cards, cream-and-serif "calm finance"), Hallmark's custom
direction (stamp at the top of `src/styles/app.css`), Interface Design's domain/colour-world/signature/defaults, and
frontend-design's plan-then-review. UI UX Pro Max's generated system (Swiss, gold and purple, IBM Plex) was read and
not adopted: purple is banned here and Plex is on every saturated list; its UX rules (reserved space for live values,
contextual live regions, accessible authentication, skippable onboarding, chart table fallbacks) were adopted.

### P2. Tokens (`src/styles/tokens.css`; never a literal colour or font outside it)

- **Ground and surfaces:** `--ground` (page), `--sheet` (panels), `--sheet-2` (raised rows, quiet blocks), `--well`
  (inset: inputs, tracks; darker than what holds it). Depth is one strategy: layered shadows in light (`--lift-1` resting
  panel, `--lift-2` hover and raised, `--lift-3` sheets and menus), surface steps and rings in dark.
- **Ink:** `--ink`, `--ink-2`, `--ink-3` (all 4.5:1 or more on every surface), `--ink-4` (disabled only).
- **Rules:** `--rule`, `--rule-2` (hairlines, drawn as inset box-shadows so they never shift layout), `--edge` (the
  3:1 boundary of anything typed or chosen).
- **Peacock** (`--peacock`, `-2`, `-3`, `--peacock-ink`, `-ink-2`, `--peacock-rule`): the committed brand field, used
  only where the owner's position or authority is the subject: Home's position, sign-in, the onboarding preview, the
  avatar, the signing moment. Never a whole page, never a sidebar.
- **Teal** (`--teal`, `--teal-bg`): links, focus on light, QED's own hand, the main series of a chart (the one series
  that carries colour; marigold marks a single point on it, such as the runway's lowest day).
- **Marigold** (`--marigold`, `--on-marigold`, `--marigold-ink`): the one accent. What needs the owner (count badge,
  urgent ring), the current page's marker in the sidebar, the lowest point of the runway, grants enforced on-chain. It
  marks; it never carries meaning alone (1.9:1 on a light sheet) and it is not the primary action, which is `.fill`
  (`tokens.css` line 12 still lists "the hero action" among its jobs: that line is out of date).
- **Meaning:** `--gain` (money in, a passed check, in force), `--loss` (refused, failed, short, owed), `--hold` (in
  progress), `--due` (waiting on the owner). Each has a `-bg` tint. Status is never colour alone: it has a word and an
  icon (`Stamp` in `src/ui/kit.tsx`).
- **Type:** one family for everything a person reads, Anek Latin (Ek Type, Mumbai; OFL; self-hosted woff2 in
  `src/fonts/anek-latin/`), variable in weight and width; `--mono` only for hashes and codes. Three cuts: `--wide`
  (116%) for headline figures, `--text` for reading, `--narrow` (88%) for chips, axis labels and dense tables. Scale
  12/13/15/17/20/30, figures 22/30/44/64, each a `--t-` token; every size the stylesheets set is one of these tokens or
  one of the exceptions named under "Type sizes" below, and `src/styles/type-scale.test.ts` fails on any other and on a
  `--t-` token set outside `tokens.css` (it reads the stylesheets: a size a browser gives by default, as to a bare
  `small`, is outside it, and every `small` the interface draws has a rule of its own). Weights
  400 to 680; hierarchy by size, weight and ink level together. Remaining drift (the `qed-proof-design` skill's audit,
  D2 to D6, 23 Nov): weights up to 800, cuts of 98 to 108%, radii of 8 to 12 px and more than one icon stroke. Every
  figure that can change is `tabular-nums lining-nums`. No tracked capitals, no eyebrows over headings, no italics for
  emphasis, no gradient text.
- **Type sizes** (folded onto the scale on 23 Nov; before it the stylesheets held 170 literal sizes off the scale in 18
  values, 12.5 px most often, and a screen showed 10.7 distinct sizes on average; 6.2 after, on one fixture, before and
  after measured back to back: `evidence/design/proof-type/compare.md`; every changed rule with its reason:
  `evidence/design/proof-type/type-map.md`). By role:
  - 30 (`--t-h1`): the page title, at every width (it was 34 on Home, Protect's pages and the setup, and 26 to 28 on a
    phone).
  - 20 (`--t-h2`): a sheet's title, a section outside a panel, and a title at the head of a card or a step, so that only
    the page title is 30 (sign-in, the wallet's setup, Ask's question, the payee being paid, the readiness verdict: 24
    and 26 before); an instrument's pay line (17 on a phone; 20 at every width on a slip and on an instruction's page);
    the wordmark (17 on the rail and in the phone's top bar).
  - 17 (`--t-h3`, `--t-lead`): a panel's or section's head; an opening sentence; a proposal's title in Ask; a draft's
    terms beside its figure while an instruction is written; the stats under a field's lead figure on a phone.
  - 15 (`--t-body`): reading text, a control's words (13 in a small button, a segmented control and the pause control's
    action; 17 in a large button), a field's label and the sidebar's items; at 620 to 640 the title of a
    row or card, which stays under its 17 px head (14.5 to 17 before: an instruction's title is now one size on Home,
    Protect and Instructions).
  - 13 (`--t-small`): notes, hints, metadata, errors, column heads, stamps and chips, keys under a chart, and a dense
    table on a phone.
  - 12 (`--t-micro`): chart and axis text (P5), the basis tag, kbd, timestamps under a figure, the tab bar's labels,
    and a few marks (the practice-money chip, an "in use" tag, the hint under Ask's composer).
  - Figures: 64 Home's position (44 on a phone); 44 a field's lead figure, on a phone too (the wallet's treasury, 52
    before and 38 on a phone; Protect's and the live instruction's, 38 on a phone before), and the lead figure of
    Save, Grow and Safeguards, a record's amount and the amount being paid (40 before), each 30 on a phone (36 and 32
    before); 30 a figure in a panel or a second account (28 and 34 before); 22 the stats under Home's lead figure (20
    under Protect's: both steps, not yet made one size).
  - How a stray size moved: to the nearest step. 12.5 went up to 13, never down to 12, except where the same role is 12
    elsewhere (the full runway's and the floor rule's chart labels, two basis tags, the stage named beside a phone's
    track), which joined it; nothing else that was 12.5 or more is now under 12.5. A tie went by role: from 14, a name,
    control or reading line to 15 and an error or a phone's dense table to 13; from 16, a title under a 17 px head to
    15 and a lead sentence or a figure to 17; from 21, 24 and 26, a title that is not the page's to 20. Text that sat
    on 22, a figure step, went to the text step 20 (an instruction page's pay line, a transaction's status, and on a
    phone Ask's question and the payee being paid).
  - Fields are 17 px under 560 px: a phone zooms the page when a field under 16 px takes focus.
  - Named exceptions, each relative on purpose and each listed in the test: a lead figure's paise at .56 of the figure
    (36 px on Home's 64, 24.6 on 44); an identifier in the system monospace at .86 of its line, never under 12 px, and a
    recovery code shown once at 1.2 of it; the sign-in headline, the one size that follows the window, between two
    figure steps (44 to 64 px, and 30 to 44 under 980 px), so that its two lines hold at every width.
- **Space and shape:** a 4 px grid (`--s1` to `--s16`). Radii are concentric: chips 6, controls 10, inner cards 14,
  panels 20, fields and sheets 28.
- **Motion:** `--ease-out` for what enters and answers, `--ease-move` for travel; 120/200/320 ms. Transform and
  opacity only (never `transition: all`, never layout properties). Pages cross with a 260 ms fade-and-rise through
  view transitions; sheets rise; menus scale from their trigger; a pressed control scales to .97; the seal "prints"
  once when a receipt is made. Nothing loops except a spinner while something is actually loading. Reduced motion
  removes all of it.

### P3. The shell (`src/app/App.tsx`, `src/styles/shell.css`)

A canvas-toned sidebar (248 px) with the wordmark and the practice-money chip, the workspace, the sections in three
groups (Home and Ask; Money: Spend, Save, Grow, Earn; Control: Protect, Activity, On-chain wallet), and at its foot the
one pause control (QED's state, its instructions in force, and Pause or Resume) and the account menu (security,
workspace, safeguards, what this build is, appearance: system/light/dark, sign out). 760 to 1179 px: an icon rail of
76 px. Under 760 px: a top bar (wordmark, practice chip, pause control, account) and a five-tab bar (Home, Spend, Ask,
Activity, More). The page column is capped at 1240 px plus gutters.

### P4. Composition rules

- **One focal object per screen**, the screen's "bright element", carrying the colour and the craft: Home's position
  field with its runway; Save's runway at full size; Grow's portfolio chart; Spend's payment being composed; Ask's
  proposal; the wallet's vault state. Everything around it stays quiet.
- **No holes.** Two columns of different heights stack independently (Home's board: `useMasonry` in `Home.tsx`), or
  bounded content keeps them even. A long explanation shows its first lines with the rest one press away (`Clamped`).
  `scripts/design-checks.ts` fails a screen where one column is under 35% of the other's height.
- **Panels** (`.panel`, 20 px radius, `--lift-1`, 24 px padding) hold a section; their head is `.panel-head` (h2 at
  17 px with a quiet right-hand note). A row list inside a panel separates rows with an inset hairline. No card inside
  a card; no bordered rectangle where a hairline or space will do.
- **Equal things are equal:** the four actions on Home are one `.dock` of equal tiles; grants are equal cards in a grid.
- **Technical detail is one step down:** hashes, addresses, block numbers and token tickers live in a disclosure or a
  record page, never on a money overview (design-checks enforces it).
- **Every region that loads has four states:** a skeleton in its shape (`.skel`), an empty state that says what
  belongs there and offers the one action that fills it (`.empty-state` with a `.glyph`), an error with what to do
  (`Problem`), and the full state.
- **Start from the owner's own position.** A screen that asks the owner something opens on what is waiting on the
  account (Ask: bills over a cap, a lost-device risk, a refused policy, an unsigned draft, each one press from a
  question; the question it fills in names no payee, as Ask promises). A figure means one thing everywhere: a figure
  that is not Home's "Free to use" is not called free (Ask's "In your bank, less the next 7 days' dues").
- **Events are sentences, documents are documents.** Activity is a day book of sentences ("You paid Meera Nair",
  "QED refused to pay City Power") with a summary of what the period came to; a record is a document with its seal
  set like a stamp and its references one step down; a milestone sits on a four-station lifecycle line whose ring says
  whose move is next (Earn).
- **Repeats fold.** Consecutive records that say the same thing are one row with a count and a time range ("7
  ticks, 23:50 to 00:20"); the row says what was asked for and why it ended as it did, in a sentence; the raw
  figures, the full record and each occurrence's link sit behind a disclosure (the wallet's tick log and its list of
  jobs, `TickLog` and `JobList` in `Vault.tsx`). A page leads with its figures, not a sentence about them
  (`.t-figs` on the wallet's "Pay and set aside").

### P5. Components (`src/styles/components.css`, `src/ui/kit.tsx`, `src/ui/charts.tsx`)

Buttons: `.btn` (sheet, lift), `.fill` (the view's primary: peacock in light, off-white in dark), `.accent` (marigold;
rare), `.quiet` (text), `.void` / `.void.fill` (destructive), sizes `.sm` 32 px, default 40 px, `.lg` 48 px; busy keeps
its width and turns a ring where the label was. Fields: `Field` with label, hint and error; `.input` inset in the well
with a 3:1 edge; `MoneyInput` prefixes ₹. Choices: `.choice` cards for radio groups, `.seg` segmented controls,
`.subnav` tabs. Status: `Stamp` (word plus icon), `.chip`, `.count`, `.basis`. Proof: `Seal` (`size`, `live`).
Containers: `.panel`, `.field-hero`, `.plain-list`, `.ledger` tables (ruled, sticky head, right-aligned tabular
figures), `.kv`, `.note` tones, `.banner`. Sheets: `Sheet` (a dialog; bottom sheet on phones). Limits: `.meter`.
Charts (`src/ui/charts.tsx`, `src/ui/timechart.tsx`): `Runway`, the worst-case bank balance day by day as true steps,
the free band from empty to the lowest point, coming bills and income marked on their days, readable by pointer,
touch and keyboard with a live reading. Given the server's `basis` it also accounts for each day exactly (the listed
items plus that day's spending equal the server's change, to the paisa: `runwayDays`, tested in `charts.test.ts`),
marks salaries counted on and the one allowed for as lost (`uncounted`), stops the band at the server's free figure
when the hardest day lies beyond the days drawn (`beyond`), and offers the same days as a passbook statement
(`table`). `TimeChart`, a recorded price series with a crosshair, axis labels, a reading line, keyboard reading and
gaps shaded as "No record", prices written at the venue's own step (`priceText`). `FloorRule`, the worst case against
the floor as one rule. Live figures sit in columns of reserved width with fixed decimals, so streaming prices move
nothing (`scripts/column-stability.ts`: 0 px on Grow). Chart text is the narrow cut at 12 px in `--ink-3`; one series
carries the accent. The kit's earlier `Runway`, `Chart` and `WorstBar` were removed on 23 Nov.

### P6. Sign-in and the first run

Sign-in is a split: the peacock field (wordmark, the headline "Money that moves only with proof", one sentence, three
example objects drawn from the real components, the practice-money note) beside the way in. Both ordinary ways in:
a passkey (one press) or a handle and password; creating an account offers the same two (D-094). A password session
can look at everything and set up; every approval is still a passkey signature over the exact terms, so the next
step offers to add one ("Not now" is allowed and says what it leaves out). Recovery codes are shown once, with copy
and download. Opening the household is a form beside a live peacock preview of where the figures leave the owner.
Home then shows "Finish setting up" until the passkey, the on-chain wallet and a first instruction exist.

### P7. Checks before a screen is done

Hallmark's floor (stamp, tokens only, focus-visible, reduced motion, overflow clipped, no eyebrow, no middle-dot meta
strings, no purple, no card in a card); one stylesheet per class: every stylesheet loads on every page, so a screen's
file names its own classes and never redefines a shared one bare (`scripts/css-collisions.ts`, run by
`src/styles/collisions.test.ts`; it caught the Grow page's root class `.grow` restyling the shared `.grow` utility,
and a second `.board`); every type size a `--t-` token or a named exception (`src/styles/type-scale.test.ts`);
Unslop's checklist (4 px grid, one accent, three text roles, one icon set at
one stroke, sentence case, tabular figures, nested radii, no dead band); Interface Design's swap, squint, signature
and token tests; `scripts/design-checks.ts`, `scripts/a11y.ts`, `scripts/design-measures.ts` on the fixture; and a
person reading the screenshots at 1440 and 390 px in light and dark. Browser journeys read controls by their
accessible names: a redesign keeps a control's name unless its words change for a reason, and then the journey is
updated in the same commit with the reason.

### P8. How the design resources were used (what each changed)

| Resource | What was run or applied | What it changed |
|---|---|---|
| Hallmark (`tooling/vendor-quarantine/nutlope-hallmark@04977e1`) | Custom direction (`references/direction.md`), its app-screen rules (`flow.md`), `theme.mjs scaffold --custom --redesign full --scope app`, and `sloplint.mjs` over the whole stylesheet and the rebuilt screens | The stamp and pre-emit critique at the top of `app.css`; the floor adopted into `base.css`; the linter's 58 failures brought to 0: 48 colour literals lifted into tokens (including a fixed "printed paper" palette for the sign-in example), a width transition removed, `100vw` on sheets replaced, tracked mono codes untracked, two sticky bars resolved by making the sidebar fixed and dropping a table head that could never stick, eyebrows replaced by a breadcrumb (`Crumb`); structural spacing moved onto the 4 px grid, control nudges waived on the record |
| Impeccable (`.claude/skills/impeccable`) | `new-work-world.md` (seven candidate systems from the audience's world across three material families, the rut named), `craft-floor.md`, colour strategy (a committed field on a restrained ground) | The world (security print, peacock, marigold, passbook) and the refusals (no eyebrows, no gradient text, no glass, no hero-metric template); browser surfaces themed (selection, caret, scrollbar); its local note that kept the wallet to "restraint, not bolder" was superseded (D-092) |
| Unslop (`.claude/skills/unslop`) | Its direction (product, character, world, moments, signature) and the nine passes; its checklist | One neutral ramp with one accent; one icon set at one stroke; glyphs standing in for icons replaced (`Mark`); sentence case; tabular figures; nested radii; one rich object per screen with quiet chrome |
| Taste Skill (`tooling/vendor-quarantine/leonxlnx-taste-skill@f6b7657`) | `scripts/copy-lint.mjs --kind software` on the rendered sign-in, Home, Spend, Ask and wallet screens | 0 failures and 0 warnings; its notes (long sentences on Home) feed the copy pass |
| UI UX Pro Max (`tooling/vendor-quarantine/nextlevelbuilder-ui-ux-pro-max-skill@7436a6e`) | `search.py --design-system` and domain searches (chart, ux, product) | Its generated system (gold and purple, IBM Plex) declined with reasons (P1); its UX rules adopted: reserved space for live values, contextual live regions, accessible authentication (paste and password managers allowed, a passkey alternative), a skippable first-run step, a table alternative for charts, balanced headings |
| Anthropic frontend-design (plugin skill) | Plan, review against the generic defaults it names, build, critique with screenshots | The plan was checked against its five calibration looks (cream and serif, near-black and neon, broadsheet hairlines, the SaaS card kit, template chrome) and kept clear of each |
| Interface Design (`.claude/skills/interface-design`, vendored 22 Nov) | Intent, domain, colour world, signature, defaults; its craft rules and its four checks | Sidebar on the canvas tone; inputs inset darker than their surface; one depth strategy per theme; four ink levels; press feedback and ease-out motion; DESIGN.md is its design memory (no separate `.interface-design/`) |
| Hue (`.claude/skills/hue`, vendored 22 Nov) | Codebase mode, generating a loadable design-language skill for Proof | `.claude/skills/qed-proof-design/`: a design model taken verbatim from `tokens.css` (checked by its `scripts/check-model.mjs`: 105 colours, 155 properties, 52 contrast pairs), component and token references, and two rendered specimens. Its audit found what the screens' own checks had not: a stamp label at 3.98:1, a focus ring that forced-colours mode drops, explanations reachable only by hover, a 1.24:1 chart segment in dark, text under 12 px, a status stamp without an icon (all fixed 23 Nov), and the type-scale drift recorded under P2 |
| Measurement | `scripts/perf.ts` (new), `scripts/design-onboarding.ts` (new), `scripts/design-shots.ts`, the probe of computed layout | LCP 84 to 160 ms and CLS under 0.001 on Home, Spend, Ask and the wallet in the lab; Grow's layout shift (0.06) found and handed to its workstream; a class collision (`.main`) found by measuring computed padding |
| Considered, not used in Proof | GSAP and its skills; ThreeUI and img2threejs; 21st.dev Magic; Figma; Dqnamo, Elaya, Awesome DESIGN.md and getdesign.md | GSAP: the motion Proof needs (page changes, the seal printing, sheets) is done with View Transitions and CSS, nothing needs a timeline, and every added script is weight on a money screen. ThreeUI and img2threejs: three-dimensional scenes do not help a person read money or authority, and the content layer stays flat. 21st.dev Magic: blocked (an account key and paid generation, `docs/setup/THIRD_PARTY_MATRIX.md`). Figma: available, but the system was built and checked in the browser on the real screens rather than drawn first. Dqnamo, Elaya, Awesome DESIGN.md and getdesign.md: reference only; nothing from them is used in Proof |

## Clear (22 November 2026): superseded by Proof

**This section supersedes "instrument and passbook" (sections 2, 3, 4, 6, 8 and 10 below) wherever they disagree.**
The owner rejected the running interface and all five directions of 21 November (D1 Native, D2 Envelopes, D3 Desk,
D4 Lumen and the R7 merge; decision D-069). Clear is a new direction, built into the application itself, not a
prototype. Sections 1, 5, 7, 9, 11 and 12 below still bind. The owner's review decides whether Clear stands.

### C1. The idea

Three questions are answered on every screen, always by the same three objects, so a person learns them once:

| Question | Object | Where it lives |
|---|---|---|
| What is mine, and what can I use? | **Position**: money split into states that add up to the account balance (free to use, kept for what is due, held for orders), then the accounts (bank, investments, on-chain wallet, what is owed) | Home, Save, every account page |
| What may QED do? | **Authority**: one line per signed instruction, said as a sentence, with what it has left this month, the figure the policy check itself counts (`programUsage`), and its own pause | Home, Protect, each pillar |
| What happened, and why? | **Record**: who acted (you, QED, your bank), under which instruction, at what cost, and the balance after; proof behind a disclosure | Home, Activity, record pages |

Navigation is the five pillars with home and the record around them: Home, Spend, Save, Grow, Earn, Protect,
Activity. Ask is in the bar on every page (Cmd-K or Ctrl-K). There is **one** control that pauses QED: the status
button in the bar, labelled with QED's state ("QED active", "QED paused", "Paused, protection on", "QED not
running"). It opens a sheet that states what stops, what can keep running and what cannot be recalled. One
instruction is paused on its own line or page; the on-chain wallet's contract pause is on the wallet's page.
Account matters (security, workspace, safeguards, what this build is, sign out) are in the account menu.

### C2. Visual system (tokens in `src/styles/app.css`)

- **Type: one family, Familjen Grotesk** (Familjen STHLM, SIL OFL 1.1, variable 400 to 700, 90 KB, file and
  licence in `src/fonts/familjen-grotesk/`). Chosen on the real home screen against Radio Canada and Fira Sans, the
  two other faces that pass both measured gates (rupee sign in the file; ten equal-width figures) and were not used
  by any rejected direction (current QED: Plex; D2 and R7: Anek Latin; D3: Source Sans 3; D4: Archivo; D1: system).
  Evidence: `evidence/design/type-radio/`, `type-fira/`, `type-familjen/` and the zoomed small-text comparison
  `evidence/design/type-compare-small-text.png`. Familjen was the most distinctive of the three and the lightest
  to deliver (90 KB against 455 KB and 1.9 MB); its small grey text is the lightest of the three, so secondary text
  never goes below 12.5 px and keeps a contrast of 4.5:1 or more. Figures are tabular and lining wherever money or
  time is shown. Identifiers (addresses, hashes, codes) are in the system mono and appear only inside disclosures
  on primary screens.
- **Colour roles** (each has one job; light and dark both defined): text, text-2, text-3 for reading order; `act`
  (ink, not a hue) for the one primary action of a view; `link` for links and the focus ring; `you` and `qed` for
  who acted, always with a word ("By you", "By QED"), never colour alone; `pos`, `att`, `neg` for settled or in
  force, waiting on you, refused or failed; `info` for in progress. No colour is used as decoration.
- **Shape and depth**: containers 12 to 14 px radius, controls 8 px, status 6 px. Only what floats (sheets, menus)
  has a shadow. Hairlines separate; cards hold one subject each and are never nested more than one level.
- **Layout**: a 1200 px page on a 12-column feel; two columns that flow independently (home: position and
  authority on the left, needs-you, coming-up and recent on the right) so neither leaves a hole beside the other.
  Phones get one column in the order position, needs you, authority, coming up, recent, and a bottom bar
  (Home, Spend, Grow, Activity, More).
- **Money**: the hero figure sets its paise smaller; every figure that is part of an equation is shown exactly
  (₹6,97,900.16 + ₹1,74,117.65 = ₹8,72,017.81) so the parts visibly add up. Negative amounts use U+2212. Test
  tokens are written as rupees or dollars with "test rupees" or "test dollars" said once beside them; the symbols
  tINR and tUSD stay in forms and technical records.
- **Dates**: near dates as a person says them ("Today", "Tomorrow", "Tue 24 Nov"), clock times in 12-hour IST
  ("3:57 pm"). Full timestamps stay in records and evidence.

### C3. Motion (the supplied 20-principle framework, applied)

The framework the owner supplied (R6 amendment, line 59: squash and stretch, anticipation, staggering,
follow-through, easing, arcs, secondary action, timing, feedback, dimensionality, origin awareness, Fitts's law,
rubber banding, Hick's law, Von Restorff, response latency, interruptibility, fast closing, peak-end, frequency-
sensitive animation) is used as heuristics, not as a quota. Where Clear applies them: **feedback and response
latency** (buttons respond in 120 ms, press moves 1 px); **origin awareness and fast closing** (sheets rise 12 px
from where they appear and close at once); **easing** (one curve, `cubic-bezier(.2,.8,.2,1)`); **Hick's law**
(one primary action per view; the pause sheet offers two scopes, not five); **Von Restorff** (only what needs the
owner is tinted amber; an urgent item gets an inset bar); **Fitts's law** (controls 40 px or more, 32 px for small
ones beside text); **frequency-sensitive animation** (nothing that repeats animates; figures never animate);
**interruptibility** (every animation is under 200 ms and input is never blocked). Not used, on purpose: squash
and stretch, arcs and rubber banding (no gesture surfaces yet), and celebratory peak-end effects on money movement.
`prefers-reduced-motion` removes all of it. Motion never delays a figure or shows success before confirmation.

### C4. The owner's rejection, kept as checks

`scripts/design-checks.ts` runs on the rendered interface (design fixture, desktop and phone) and fails when a
screen falls back into a fault the owner named: raw addresses or hashes on a primary screen outside a disclosure;
block numbers, chain ids, ERC or EIP numbers on a primary screen; tINR or tUSD on the money overviews; more than one
pause control or anything labelled "Stop everything"; sideways overflow on a phone; a two-column layout where one
column is under 35% of the other's height while the other is taller than a window; a fault page or console error.
Run on 22 Nov 2026 over 30 screens: one finding (Save's columns, `evidence/design/checks-v1`), fixed by moving the two short sections above the
reserve detail; the re-run found none (`evidence/design/checks-v2/checks.json`). Judgements a script cannot make (alignment, unnatural wording, synthetic names dominating, quality
dropping on secondary screens) are made by reading the screenshots: `evidence/design/<label>/`.

Accessibility on Clear (22 Nov 2026, `node scripts/a11y.ts` with `QED_FIXTURE=1` on the design fixture; report
`evidence/design/a11y-clear-20261122.json`): the first run found three faults, two of them introduced by Clear (the
account button's name did not contain its visible initials, WCAG 2.5.3; a sticky side column on long pages left
focused controls below the window; a vault operation's page overflowed on phones because a 40-character address sat in
its heading). After the fixes: 124 axe runs over 31 screens with no rule violated, no sideways overflow at seven widths
(320 to 1440 px), none of 5,724 focus stops hidden under a pinned bar, the approval sheet usable by keyboard alone, and
no motion when less is asked for. An automated pass finds a minority of faults; a screen-reader review is still owed.

### C5. Tools behind the screens

`scripts/design-fixture.ts` starts an isolated stack with one fresh passkey household with realistic activity on
both the paper side and the on-chain wallet (all through the public API with passkey approvals; nothing written to
the database directly). `scripts/design-shots.ts` photographs every screen at 1440 and 390 px in light and dark;
`scripts/design-states.ts` photographs the sheets and menus (payment review, instruction signing, pause, account
menu) without approving anything. Baseline of the running interface before Clear: `evidence/design/baseline-20261122/`.

### C6. Measured refinement (22 November, evening)

Clear's own rules were measured on every screen, not judged by eye, and the faults the measures found were fixed.
The instrument is `scripts/design-measures.ts` (definitions in its header: words, type sizes, text colours,
contrast by the WCAG formula, controls under 24 and 32 px, the largest blank rectangle inside the first window's
content, the edges text is set against, overflow, and axe's WCAG 2.2 AA rules), compared by
`scripts/design-compare.ts`. **Before** is the interface the owner rejected (revision `9ffcf3b`), built and served by
today's server on the same fixture data; **after** is revision `b496449`. Both at 1440 and 390 px, light and dark.

| Over the 16 screens both have, at both widths | Before | After |
|---|---:|---:|
| Type sizes per screen, mean | 8.8 | 6.1 |
| Controls under 32 px (Clear's floor beside text, C3) | 85 | 0 |
| Controls under 24 px (WCAG 2.5.8) | 72 | 0 |
| Text under its contrast minimum (light and dark) | 0 | 0 |
| axe WCAG 2.2 AA violations (light and dark) | 0 | 0 |
| Words in the first window, mean | 199 | 213 |
| Largest blank in the first window, mean share | 16% | 15% |

Every one of the 19 screens of the new interface, at both widths and in both themes (76 measurements), has no
control under 32 px, no text under its contrast minimum and no axe violation. Evidence:
`evidence/design/measures-before/`, `measures-after/` (with `compare.md`), `clear-final/` (72 photographs) and
`checks-final/` (the C4 checks: 30 screens, 0 findings).

**On the final revision of 22 November (`97eae28`, a clean worktree, the same fixture data)** the measures were taken
again on the 19 screens they cover, including Save, Protect and Evidence, which the first comparison did not have:
in all 76 measurements (both widths, both themes) no control is under 32 px, no text is under its contrast minimum,
there is no axe violation and nothing overflows; type sizes per screen average 6.0. Over the 16 screens both designs
have, words in the first window are 218 on average (199 before; the on-chain wallet's sections joined Save, Grow and
Protect) and the largest blank 15% (16%). The photographs cover 24 screens, adding the statement, an evidence case
and the welcome, new-account and recovery screens, at both widths and in both themes (96, none with an error), and the
C4 checks found nothing on 30 screens. Evidence: `evidence/design/measures-final/` (with `compare.md`),
`clear-final-2/` and `checks-final-2/`. Two faults the final measure found were fixed before it: three links on
Protect under 24 px, and a check that no longer recognised the pause button after its label gained its action word.

What changed because of the measures:
- **One type scale**: 12.5, 13.5, 15, 17, 19, 24, 26, 34, 36 and 44 px (and 16 px for fields on a phone, which
  would otherwise zoom when they take focus). Nineteen declared pixel sizes became eleven; the smallest text is
  12.5 px, as C2 says (the keyboard hint, chart labels and code were below it). The hero figure's paise at half size
  is deliberate.
- **Targets**: a link that stands on its own, a disclosure and a link-like button get 32 px or more to press;
  vertical padding with an equal negative margin enlarges what can be pressed without moving anything around it.
- **More** on a wide screen: its nine parts in three columns instead of nine rows a page wide, with words that do
  not mention a bottom bar the desktop does not have.
- **The price chart** (R7-114) states the question it answers, answers it in words with exact values, reads any
  point under the pointer or a finger, gives the same values as a table and says it forecasts nothing.
- **Side columns** (D-079): Earn's money-in records and Security's account recovery moved to the side column at
  desktop width, so the on-chain sections keep the columns even; the phone order is unchanged.

What the measures do not show: blank space and the words on the first screen hardly changed on average (the
redesign moved and named things more than it removed them). At desktop width Home's largest blank fell from 22% to
6% and More's from 60% to 26%; the instruction list's rose from 34% to 40%, because its rows are short at full
width. The edge count is a weak proxy for alignment. None of
this measures whether people understand the screens: that is the walkthrough and the study with participants of
R7-111 (EXT-02).

---

# Superseded where section "Clear" disagrees: instrument and passbook (20 November 2026)

**This is the one authoritative statement of how QED looks, reads and behaves.** The stylesheet
(`src/styles/app.css`) implements it; where the two disagree, that is a defect in one of them, to be found and
fixed, not a choice. Written 20 November 2026.

It replaces, as the source to design from: the R4 interface specification and reference study
(`docs/research/qed-ux-accessibility/20261117-r4-ux-spec.md`, `…-reference-study.md`), whose "Horizon" and "Line"
identity the owner rejected; and the tokens in the earlier prototypes. It keeps the working rules of the supplied
framework (`…/20261118-supplied-materials-digest.md`, section 8) and of the resource playbook
(`…/20261118-design-resource-playbook.md`); the ones that bind are restated here so that nobody needs three files
open. No `DESIGN.md` or `.interface-design/system.md` existed before this file, so there was nothing else to
reconcile.

**Approval.** The owner's review decides whether this design stands. Until then it is a proposal that happens to
be built.

## 1. What the interface is for

An owner hands money decisions to software and walks away. When they look, they need four answers, in this order:
what do I have and what is free; does anything need me; what has been done in my name; what can still be done in
my name, how much, until when, and how do I stop it. Every screen is judged by whether it answers its share of
those without the owner having to trust the screen: each figure says what kind of figure it is, each act links to
its record, and each record can be checked without asking the server.

## 2. The language: instrument and passbook

Two familiar paper objects carry the two hard ideas.

- **Authority is an instrument.** A signed instruction looks like what it is: a document with a pay line in words,
  a crossing that states the most it can ever move and by when, clauses (limits, only if, never, not limited, how,
  ends, stopping), the owner's signature, QED's stamp, and a counterfoil that fills as it is used. A draft has a
  dashed edge and no signature. The security ground appears only when it is in force.
- **Record is a passbook.** One line per entry, a running balance, who caused it. A black line marks "now". Below
  it the passbook continues into what is expected: promises and estimates, visibly not entries.

Everything else is ruled paper around those two: statements, tables, notes. No cards with shadows, no gradient,
no icon tiles, no decorative chart.

## 3. Colour: each hue has one job

| Token | Light | Dark | The one job |
|---|---|---|---|
| `--ink` | `#1D3FBB` | `#93ABFF` | **Your hand.** Your signature, what you entered, anything you can press |
| `--qed` | `#5A3D99` | `#BDA3F5` | **QED's hand.** Its stamp, and what it did under your instruction |
| `--ok` | `#136A47` | `#62C99C` | Settled, in force, agrees; money in |
| `--wait` | `#855000` | `#E2A94F` | Waiting on you, or something you should know before it matters |
| `--void` | `#B02318` | `#F18B81` | Refused, failed, missed, a breach; the stop control |
| `--print`, `--print-2`, `--print-3` | `#15191F`, `#47505B`, `#5F6975` | `#E8ECF1`, `#B4BDC8`, `#909BA8` | Text: what is said, what explains it, what labels it |
| `--paper`, `--sheet`, `--sunk` | `#F1F3F2`, `#FFFFFF`, `#E8EBEA` | `#0F141B`, `#161D27`, `#0B0F15` | The desk, a document or table on it, a well |
| `--edge` | `#7A8490` | `#707D8F` | The boundary of anything you type in or choose from |
| `--rule`, `--rule-strong` | `#D2D7DB`, `#98A1AB` | `#2A3441`, `#4F5C6C` | Lines that separate. Never the only sign of anything |
| hatch (a pattern, not a hue) | | | Money that could be lost under a limit; time after authority has ended |

Rules: a hue is never the only carrier of a meaning (a refusal is red *and* says "Refused"). One filled button per
view. Violet is never used for anything the owner does, blue never for anything QED does. Each wash
(`--ink-wash`, `--qed-wash`, …) exists only as the ground for its own hue.

**Measured contrast** (WCAG relative luminance, computed from the hex values on 20 November 2026; text needs 4.5,
a control's boundary needs 3):

| Pair | Light | Dark |
|---|---|---|
| `print` on paper / sheet | 15.8 / 17.6 | 15.6 / 14.3 |
| `print-2` on paper / sheet | 7.3 / 8.2 | 9.7 / 8.9 |
| `print-3` on paper / sheet / sunk | 5.0 / 5.6 / 4.7 | 6.6 / 6.0 / 6.8 |
| `ink` on paper / sheet / its wash | 7.6 / 8.5 / 7.2 | 8.4 / 7.7 / 6.7 |
| white on `ink` (filled button) | 8.5 | 8.4 |
| `qed` on sheet / its wash | 8.2 / 7.0 | 7.8 / 6.9 |
| `ok` on sheet / its wash | 6.6 / 5.7 | 8.4 / 7.0 |
| `wait` on sheet / its wash | 6.7 / 5.8 | 8.1 / 7.0 |
| `void` on sheet / its wash | 6.8 / 5.6 | 7.1 / 6.6 |
| `edge` on sheet / paper / ink wash | 3.8 / 3.4 / 3.2 | 4.1 / 4.4 / 3.5 |
| `rule-strong` on sheet / paper | 2.6 / 2.4 | 2.5 / 2.7 |

**A failure found by measuring, and what was done.** Input fields, choices and segmented controls were bounded by
`rule-strong`, which is below 3:1. That fails the rule for control boundaries. `--edge` was added at a measured
3.2 or more against every surface it sits on, and those controls now use it. `rule-strong` remains for lines that
only separate. The table is computed from the hex values. As rendered, axe's own contrast rule found no failing text
in 96 runs over 24 screens, in light and dark (`evidence/20261120-accessibility.json`); axe does not test control
boundaries, so the `edge` figures rest on the computation.

## 4. Type

| Role | Face | Where |
|---|---|---|
| The words that bind | IBM Plex Serif, 500 to 700 | The pay line and clauses of an instrument, page titles, the owner's signature (italic) |
| Everything else, and every figure | IBM Plex Sans (variable), 400 to 700 | Interface, tables, labels. Tabular figures always, so columns align and a changing figure does not shift |

Sizes: page title 28 px serif; lead figure 34 px (30 on a phone); body 15 px; secondary 13.5 px; labels and
column heads 12.5 px. Nothing smaller than 12.5 px. Line length under about 80 characters. Sentence case
everywhere; no tracked capitals; no label perched above a heading; no single coloured word in a headline. Both
faces are open (SIL OFL), self-hosted from the package, and no font is fetched from another site.

**Figures.** Rupees with Indian grouping (₹7,63,039). Paise are shown where the amount is exact and the owner is
acting on it (a ledger line, a receipt, an order) and dropped where it is an estimate or a summary. A sum that
carries paise shows both places (₹194.80, never ₹194.8, which reads as a mistake): the interface and every sentence
the server writes about money use the formatters in `shared/money.ts`, and nothing else formats a sum. An average
or an estimate introduced with "about" is shown to the rupee. A price is not a sum: it is written as the venue
quotes it, at the venue's own step. A negative is written with a true minus. A figure is never abbreviated (no
"7.6L") where the owner acts.

## 5. Every figure says what kind it is

A recorded balance, a live price, an estimate and a bound are different things and must not look alike.

- A basis tag follows a consequential figure: "from your records", "live", "an estimate", "if limits hold",
  "modelled", "past change".
- A live price carries its age and its source; when it is too old to trade on, it says so in red.
- A daily value says which day it is for.
- An illustrative limit says it is not calibrated, wherever it is used.
- A worst case names what it allows for ("income up to 5 days late and one salary not arriving").
- What is expected sits under the "now" line and is worded as expected.

## 6. Shape, space, density

- Documents and tables have square corners and ruled edges. Things you press have 6 px corners. Stamps are
  outlined, never filled. A sheet (dialog) has 10 px corners because it floats.
- A 4 px grid. Sections are separated by space and a rule, not by boxes.
- Dense where the owner compares (tables), generous where they decide (an instrument, an approval).
- Controls are at least 38 px tall, 40 for buttons, 42 for inputs.
- Width: content column up to 1180 px. Two columns from 900 px; one below. No screen overflows sideways at 320,
  360, 390, 768, 1024 or 1440 px (checked by script, section 11). How each looks at 768 and 1024 has not been
  judged by eye.

## 7. Words

Plain verbs, sentence case, the owner's vocabulary. "Instruction", not program, mandate or rule. "QED refused
this", not "blocked by policy". A button says what happens ("Sign and put in force") and the result uses the same
word ("In force"). An error says what happened and what to do; it does not apologise and it is never vague. An
empty screen says what would appear there and how to make it so. No exclamation marks, no celebration. Nothing
is called "smart", "seamless" or "powerful".

A refusal always names the check that failed, with the figures: "₹7,63,235 is available in the bank and this takes
₹200, leaving ₹7,63,035; ₹1,78,784 must stay for what is due by 6 Jan 2027."

## 8. Motion

The supplied framework's gate, kept in full: **first ask whether it should move at all.**

1. Only a change of state may animate, and only the thing that changed, one place at a time.
2. 200 ms or less. No animation loops.
3. **Money never animates.** No counting up, no flashing price, no sliding balance. A figure changes by changing.
4. Nothing essential waits for an animation, and no input is blocked by one.
5. **Success is never shown before it is confirmed.** "Being sent" stays "being sent" until the venue answers.
6. With reduced motion requested, every animation and transition is cut to nothing; nothing is lost by that.

What moves today, in total: a sheet rises 10 px and fades in over 180 ms when it opens. That is all. A flash on a
changing price (600 ms, several at once) was removed on 20 November 2026 for breaking rules 1 to 3; a price's age
is written beside it instead.

## 9. States every screen must show

Loading (what is being read, in words); empty (what would be here); stale (which figure, how old, what it stops);
pending (with whom, and what happens next); partial (what was done and what was not); refused (the check and its
figures); failed (what came back); cancelled; done. The engine not running is a state of the whole interface: a
banner on every page, and nothing is presented as current.

## 10. Components, by what they are for

| Component | For | Rule |
|---|---|---|
| Statement | The balance and what is free | One lead figure; the subtraction shown as a subtraction |
| Worst-case strip (`Runway`) | The lowest the bank would stand, day by day | Steps, not a curve; the lowest point labelled; the band beneath it is what is free |
| Passbook table (`.ledger`) | Entries and what is expected | Running balance; who caused each line; the "now" line; row opens the record |
| Instrument (`InstrumentDoc`) | A signed or draft authority | Never restyled per screen; the document shown is the document signed |
| Coming weeks (`ComingWeeks`) | When a scheduled instruction runs and where a limit stops it | A calendar, Monday first; a filled mark is QED acting, an open ring is a request to you; the same in words beneath |
| Approval sheet | Giving authority | Shows the exact document; asks for the password when the rule says so, and also when the server asks at the moment of approval (several small requests can reach the day's password-free amount only as each is approved); nothing in it comes from a model. Focus goes into it when it opens and back to what opened it when it closes |
| Password when asked (`usePasswordWhenAsked`) | A change that weakens a protection | The change is tried; if the server asks for the password, a field appears with the server's own reason and both figures; nothing is saved until it is given |
| Record timeline | One action from asked to receipted | Every check with its figures; times to the millisecond; the receipt's fingerprint recomputed in the browser |
| Everything done (`ActivityScreen`) | Auditing at a glance | Checks passed out of how many; red only where one failed. The runs an instruction missed on one day are one row, with how many and between which times |
| Since you were last here | Returning after an absence | From the records, never written by a model; can be closed |
| Stamp | A state | Outlined; word plus colour |
| Note | Something to know | Left rule in the role's hue; amber before it matters, red when it has. Its title is its own first line, not a heading, so that a note placed anywhere never breaks the page's outline |
| Worst bar | The floor | Solid is kept, hatch is at risk, a red mark is the floor |

## 11. Accessibility

Target: WCAG 2.2 level AA.

**Checked by script on 20 November 2026** (`npm run a11y`, report in `evidence/20261120-accessibility.json`), on
24 screens of the built interface as the API serves it, signed in as the review account, the vault's seven inner
screens included:

| Check | Result |
|---|---|
| axe-core, WCAG 2.0, 2.1 and 2.2 rules, levels A and AA; light and dark; 1440 and 390 px | 96 runs, no rule violated |
| Exactly one `h1`; headings never skip a level | True on all 24. Two faults were found by this check and fixed: the Vault skipped a level, and a titled note under a page heading did the same on the standing-policy screen |
| Nothing overflows sideways at 320, 360, 390, 640, 768, 1024, 1440 px. 640 and 320 are a 1280 px window zoomed to 200% and 400% | True on all 24 (Ask overflowed at 320 and was fixed) |
| Motion: the approval sheet's entrance is the only animation; it is gone when the system asks for less motion | 0.18 s as computed by the page; 0.00001 s with less motion asked for, and no transition on the page is longer |
| Every screen draws: none shows the "This page could not be drawn" fallback, and none logs an error to the console | True on all 24. Added after the vault's Convert screen was found broken by eye: a list of prices reached a function that expected whole units, the page fell back to its apology, and the apology passes every accessibility rule, so the earlier runs of this script had called that screen clean |
| The first Tab stop is a skip link; each focused control has a visible outline | True for the 38 stops checked on the passbook |
| A control that takes keyboard focus is never wholly under a bar pinned to the window (WCAG 2.2, 2.4.11). Every screen is walked with Tab and back with Shift+Tab at 1280 by 720, 390 by 844 and 640 by 360 | True for 5,176 focus stops on all 24. Found failing by hand first: 123 stops on seven screens came to rest under the bar at the top or the phone's bar at the bottom, and axe has no rule for it. The shell now measures both bars and the page keeps focused controls clear of them |
| The approval sheet with the keyboard only: Enter opens it with focus inside and a name; Tab never reaches the page behind it; Escape closes it; focus returns to the button that opened it | True. Found broken by hand first: a button was disabled while its action ran, lost focus, and closing the sheet left focus at the top of the page. A busy button now stays focusable and ignores a second press, and the sheet puts focus back itself if the browser does not |

In the code: labels bound to their fields; errors tied to their fields; tables with header scope; charts and the
calendar with a text alternative that states the finding, and the same facts in words beside them; colour never
alone; reduced motion honoured; light and dark from the system setting.

**Not done.** An automated pass finds a minority of faults. Still owed: a keyboard walk of every journey to its
end (the approval sheet is opened, tabbed through and closed by the script, not approved); a reading with a screen
reader; text enlarged by a browser's text-only setting; high-contrast mode; and whether
the words are understood by someone who did not write them. The browser tests in `e2e/` belong to the earlier
demonstration and do not cover this interface.

## 12. What is not allowed

System fonts as the identity; a serif headline over a cream page with an orange accent; near-black with one neon
accent; identical rounded cards with soft shadows; gradients; a tracked-capitals label above a heading; one
coloured word in a headline; bullets joined by middle dots; an arrow glued to a link; a monospace face for
"data"; animated counters; any decoration that does not carry information. And, for this product specifically:
an approval that looks like something a model could have written; a figure without its kind; success before
confirmation.

## 13. Adopted from the directions study

`docs/research/qed-ux-accessibility/20261120-r6-directions/` compares this language with three others on the same
account. Four things were taken from them and built on 20 November 2026:

| From | Built | Where |
|---|---|---|
| Day book | The worst case, day by day, on the passbook's first screen; a shorter explanation on a phone | `screens/Passbook.tsx`, `Runway` |
| Day book | The next five weeks of a scheduled instruction as a calendar, naming the limit that refuses a run | `screens/Instructions.tsx` `ComingWeeks`; `server/liquidity.ts` `runCalendar` |
| Control room | "Everything done": every action and every run that did not happen, with checks passed | `screens/Activity.tsx` |
| Conversation | "Since you were last here", from the records | `screens/Passbook.tsx` `SinceLast`; `server/views.ts` `sinceView` |

Not taken, and why, is in that study's README.

## 14. Known weaknesses

- Safeguards is long. It reads as a report, which suits it, but its sections are not yet reachable from one another.
- The instrument is text-heavy on a phone.
- "Everything done" lists missed runs one by one; a night's worth should fold into one row, as the instruction
  page already does.
- Nothing here has been put in front of a user.
