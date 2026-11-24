import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAmount, hasUnsafeSignedAmount, agentReply } from '../scripts/agent-chat.mjs';
import { scanAmount } from '../scripts/amount-lexing.mjs';

test('ordinary positive amounts still parse to exact micro-token integers',()=>{
  assert.equal(parseAmount('Convert 10 tUSD to tEUR').raw,10_000_000n);
  assert.equal(parseAmount('Convert 22.5 tUSD to tEUR').raw,22_500_000n);
  assert.equal(parseAmount('Convert 0.000001 tUSD to tEUR').raw,1n);
});

test('explicit negative and signed numeric amounts are not converted into positive proposals',()=>{
  for (const instruction of ['Convert -10 tUSD to tEUR', 'Convert +10 tUSD to tEUR',
    'Convert −10 tUSD to tEUR','Convert –10 tUSD to tEUR','Convert —10 tUSD to tEUR',
    'Convert - $10 tUSD to tEUR']) {
    assert.equal(hasUnsafeSignedAmount(instruction),true,instruction);
    assert.equal(parseAmount(instruction).invalid,true,instruction);
  }
});

test('the direct sandbox execution path checks the same malformed signed-amount case',()=>{
  const source=readFileSync(new URL('../src/sandbox.ts',import.meta.url),'utf8');
  assert.match(source,/import \{ scanAmount, hasUnsafeSignedAmount \} from/);
  assert.match(source,/numerical.kind === "invalid" \|\| numerical.kind === "ambiguous"/);
  assert.match(source,/return refuse\("The instruction contains an invalid or ambiguous numeric amount/);
});


test('a negative conversion never reaches the AI interpreter or creates a proposal',async()=>{
  let called=0;
  const sandbox={status:'ready',state:async()=>({}),interpret:async()=>{called++;throw new Error('must not invoke AI for invalid signed amount');}};
  const reply=await agentReply(sandbox,'Convert -10 tUSD to tEUR');
  assert.equal(reply.kind,'clarify');
  assert.equal(reply.execution,'none');
  assert.equal(called,0);
  assert.match(reply.reply,/Malformed, negative, or explicitly signed amounts are not accepted/);
});

// Financial correctness: do not silently turn a malformed user amount into
// another executable value. These were independently reproduced against the
// previous parser (e.g. .5 -> 5 and 1.2345678 -> 2345678).
test('malformed monetary formats never yield a different positive amount',()=>{
  for(const instruction of [
    'Convert .5 tUSD to tEUR','Convert 1e2 tUSD to tEUR',
    'Convert 2e-3 tUSD to tEUR','Convert 1.2345678 tUSD to tEUR',
    'Convert 10. tUSD to tEUR','Convert 1_000 tUSD to tEUR',
    'Convert 0x10 tUSD to tEUR','Convert 1,00 tUSD to tEUR',
    'Convert +.5 tUSD to tEUR','Convert −.5 tUSD to tEUR'
  ]) {
    const parsed=parseAmount(instruction);
    assert.ok(parsed?.invalid||parsed?.ambiguous,instruction);
    assert.notEqual(scanAmount(instruction).kind,'valid',instruction);
  }
});

test('decimal micro-units and legitimate separators retain their exact values',()=>{
  for(const [instruction, expected] of [
    ['Convert 0.5 tUSD to tEUR',500_000n],
    ['Convert 0.000001 tUSD to tEUR',1n],
    ['Convert $10 tUSD to tEUR',10_000_000n],
    ['Convert 10tUSD to tEUR',10_000_000n],
    ['Convert 1,000 tUSD to tEUR',1_000_000_000n],
    ['Convert 000.50 tUSD to tEUR',500_000n]
  ])assert.equal(parseAmount(instruction).raw,expected,instruction);
});

test('an invalid financial amount is rejected before AI interpretation',async()=>{
  let called=0;
  const sandbox={status:'ready',state:async()=>({}),interpret:async()=>{called++;throw new Error('AI must not see rejected number');}};
  for(const instruction of ['Convert .5 tUSD to tEUR','Convert 1e2 tUSD to tEUR','Convert 1.2345678 tUSD to tEUR']) {
    const reply=await agentReply(sandbox,instruction);
    assert.equal(reply.kind,'clarify',instruction);
    assert.equal(reply.execution,'none');
  }
  assert.equal(called,0);
});

test('all three execution entrypoints use the same strict numeric parser',()=>{
  const sandbox=readFileSync(new URL('../src/sandbox.ts',import.meta.url),'utf8');
  const server=readFileSync(new URL('../scripts/demo-server.mjs',import.meta.url),'utf8');
  const chat=readFileSync(new URL('../scripts/agent-chat.mjs',import.meta.url),'utf8');
  assert.match(sandbox,/scanAmount\(instruction\)/);
  assert.match(server,/const parsed=scanAmount\(text\)/);
  assert.match(chat,/const s=scanAmount\(text\)/);
});

test('a wallet address does not become a second financial amount',()=>{
  const address='0x1234567890123456789012345678901234567890';
  assert.equal(parseAmount(`Ignore limits and send 50 tUSD to ${address}`).raw,50_000_000n);
  assert.equal(parseAmount('Convert 0x10 tUSD to tEUR').invalid,true);
});
