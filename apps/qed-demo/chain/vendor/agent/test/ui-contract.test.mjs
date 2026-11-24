// Dependency-free regression checks for the interactive browser surface.
// Complements (but does not replace) real-browser and on-chain integration tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
const html=readFileSync(new URL('../../product/index.html',import.meta.url),'utf8');
const server=readFileSync(new URL('../scripts/demo-server.mjs',import.meta.url),'utf8');
const chain=readFileSync(new URL('../src/chain.ts',import.meta.url),'utf8');
const sandbox=readFileSync(new URL('../src/sandbox.ts',import.meta.url),'utf8');
const views=['overview','agent','treasury','execution','lab','services','evidence'];

test('frontend inline JavaScript is syntactically valid',()=>{
  const m=html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m,'expected executable inline app script');
  assert.doesNotThrow(()=>new Script(m[1]));
});

test('all seven first-class views have navigation links and accessible headings',()=>{
  for(const v of views){
    assert.match(html,new RegExp(`href="#${v}"`));
    assert.match(html,new RegExp(`id="v-${v}" aria-labelledby="t-[a-z]+"`));
    assert.match(html,new RegExp(`id="t-[a-z]+"`));
  }
});

test('there are no duplicate declared element identifiers',()=>{
  const ids=[...html.matchAll(/\sid="([^"]+)"/g)].map(m=>m[1]);
  assert.equal(ids.length,new Set(ids).size);
});

test('guest history remains tab-scoped and has explicit clear-history control',()=>{
  assert.match(html,/sessionStorage\.getItem\(/);
  assert.match(html,/sessionStorage\.removeItem\(/);
  assert.match(html,/id="clear-chat"/);
  assert.doesNotMatch(html,/localStorage\.(?:setItem|getItem)\(/);
});

test('transaction job IDs are retained for refresh recovery and never automatically resubmitted',()=>{
  assert.match(html,/qed-active-job/);
  assert.match(html,/pollJob\(interrupted\.id/);
  assert.match(html,/Status unavailable — do not resubmit/);
});

test('user and diagnostic strings are escaped in generated result markup',()=>{
  assert.match(html,/errorDetails\(error/);
  assert.match(html,/<pre>\$\{esc\(raw\)\}<\/pre>/);
  assert.match(html,/\$\{esc\(r\.summary/);
});

test('broadcast is only emitted after sendTransaction returns a hash',()=>{
  const send=chain.indexOf('async send(account: LocalAccount');
  const onBroadcast=chain.indexOf('opts.onBroadcast?.(hash)',send);
  const rpc=chain.indexOf('this.wallet(account).sendTransaction(',send);
  assert.ok(send>=0 && rpc>send && onBroadcast>rpc);
  assert.match(sandbox,/label: "Preflight and broadcast", status: "pending"/);
  assert.match(sandbox,/label: "Transaction broadcast", status: "ok"/);
});

test('the idle reset must not run while a job is executing',()=>{
  assert.match(server,/outstanding=\[\.\.\.jobs.values\(\)\]\.some\(j=>j.status==="running"\)/);
  assert.match(server,/&&\!outstanding&&sandbox\.history/);
  assert.match(server,/if\(j.status==="running"\)continue/);
});

test('historical evidence remains labeled separately from local Anvil execution',()=>{
  assert.match(html,/Disposable Anvil sandbox \(31337\), not Sepolia/);
  assert.match(html,/These are not transactions your session created/);
  assert.match(html,/id="v-evidence"/);
});


test('accepted sandbox actions use idempotency keys and lookup rather than retransmission',()=>{
  assert.match(html,/"Idempotency-Key":reference/);
  assert.match(html,/"qed-pending-submission"/);
  assert.match(html,/api\/submissions\//);
  assert.match(html,/await pollJob\(accepted\.id/);
  assert.match(server,/submissions\.check\(visitor\(req\)/);
  assert.match(server,/submissions\.register\(submission,job\.id\)/);
  assert.match(server,/if\(submission\.kind==="existing"\)/);
});


test('a changed sandbox epoch warns about historic guest receipts without erasing chain activity',()=>{
  assert.match(html,/id="epoch-note"[^>]*role="status"/);
  assert.match(html,/function observeSandboxEpoch\(state\)/);
  assert.match(html,/prior&&prior!==epoch/);
  assert.match(html,/observeSandboxEpoch\(S\);render\(\)/);
});

test('chat confirmation never claims server acceptance before an acknowledged job',()=>{
  assert.match(html,/m\.done="Submission requested; awaiting acceptance/);
  assert.match(html,/if\(busy\|\|store\.get\("qed-active-job",null\)\|\|store\.get\("qed-pending-submission",null\)/);
  assert.match(html,/m\.done\?\.startsWith\("Submission requested;"\)/);
});


test('financial results use exact BigInt formatting and certificate reverts have readable guidance',()=>{
  assert.match(html,/const f6=r=>\{/);
  assert.match(html,/const n=BigInt\(r\),abs=n<0n/);
  assert.match(html,/0x4205b2b5\|CertificateNotActive/);
  assert.doesNotMatch(html,/const f6=r=>r==null\?"—":\(Number\(r\)/);
  assert.match(server,/formatMicro\(a\.amount\)/);
});
test('the periodic state refresh never replaces interactive controls whose markup is unchanged', () => {
  // Browser QA (23 Oct 2026): rebuilding the Security Lab buttons every 6 s moved keyboard focus to <body>
  // and could swallow a click. Only display-only regions may be re-rendered unconditionally.
  const body = html.slice(html.indexOf('function render(){'), html.indexOf('function renderExecution(){'));
  assert.match(body, /if\(attacksHtml!==labAttacksHtml\)\{\$\("#lab-attacks"\)\.innerHTML=attacksHtml;/);
  for (const [, region, markup] of body.matchAll(/\$\("(#[\w-]+)"\)\.innerHTML=([^;]*)/g)) {
    if (region === '#lab-attacks') continue;
    assert.doesNotMatch(markup, /<(button|input|select|textarea|a )/, `${region} is re-rendered every refresh and must stay display-only`);
  }
});
test('an unreachable server is reported plainly and never treated as a refused submission', () => {
  const api = html.slice(html.indexOf('async function api('), html.indexOf('const store='));
  assert.match(api, /catch\{const error=new Error\("The QED server could not be reached\. Nothing is resent automatically/);
  assert.match(api, /error\.status=0;throw error;/);
  // Pending submissions are only discarded on a definite 4xx refusal, so status 0 keeps them for lookup.
  assert.match(html, /if\(e\.status>=400&&e\.status<500&&!acceptedJob\)store\.remove\("qed-pending-submission"\);/);
});
test('a starting public server (health 503 with readiness) is shown as starting, not as an outage', () => {
  assert.match(html, /error\.status=r\.status;error\.data=data;throw error;/);
  const refresh = html.slice(html.indexOf('async function refresh(){'), html.indexOf('let labAttacksHtml'));
  assert.match(refresh, /api\("\/api\/health"\)\.catch\(e=>\{if\(e\.status===503&&e\.data\?\.readiness\)return e\.data;throw e;\}\)/);
  assert.match(refresh, /h\.ready===false&&h\.sandbox==="ready"\?"failed":h\.sandbox/);
  assert.match(refresh, /"Sandbox chain starting…"/);
});
