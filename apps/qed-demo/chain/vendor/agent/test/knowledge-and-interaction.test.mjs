import {test} from 'node:test';
import assert from 'node:assert/strict';
import {agentReply} from '../scripts/agent-chat.mjs';
import {identifyKnowledgeTopic,KNOWLEDGE} from '../scripts/knowledge.mjs';

const makeSandbox=()=>{
  let called=0, checked=[];
  const s={
    status:'ready',
    state:async()=>({
      network:{name:'Anvil',block:21},
      treasury:{balance:'90000000',free:'67500000',ringFenced:'22500000',spentInWindow:'22500000',availableToday:'67500000'},
      reserve:{balance:'29142335',free:'29142335'},
      mandate:{version:1,maxPerPayment:'25000000',maxPerPeriod:'90000000',payees:['euro reserve']},
      policy:null,history:[],lastTrade:null
    }),
    interpret:async()=>{called++;return {g:{flags:[],intent:'help',reply:'General help.',proposal:null},transcript:{engine:'offline-deterministic'}}},
    checkLimits:async amt=>{checked.push(amt);return {allowed:amt<=25_000_000n,checks:[{rule:'Amount per payment',pass:amt<=25_000_000n,limit:25_000_000n}]}}
  };
  return {s,called:()=>called,checked};
};

test('non-monetary pitch-deck numbers never become financial proposals',async()=>{
  for(const question of ['What do the 48 attacks prove?', 'Explain the 1 ppm bound', 'What happened in Sepolia transaction E1?', 'What were the 196 transactions?', 'How did five agents clear 200 in debt?']){
    const {s,checked}=makeSandbox();
    const r=await agentReply(s,question);
    assert.equal(r.kind,'answer',question);
    assert.equal(r.execution,'none',question);
    assert.deepEqual(checked,[],question);
  }
});

test('pitch-deck mechanisms are explained honestly and link to real product pages',async()=>{
  for(const [question,topic] of [
    ['How does payment-for-work escrow settle?','escrow'],
    ['Explain minimum variance and KKT portfolio','portfolio'],
    ['Show me certified debt clearing','clearing'],
    ['What is the zero-knowledge portfolio proof?','privacy'],
    ['What are the three mathematical bounties?','bounty'],
    ['What if both hot keys were stolen?','security'],
    ['What are QED limitations?','limitations']
  ]){
    assert.equal(identifyKnowledgeTopic(question),topic);
    const r=await agentReply(makeSandbox().s,question);
    assert.equal(r.kind,'answer',question);
    assert.ok(r.reply.length>90);
    assert.equal(r.action.href,KNOWLEDGE[topic].path);
    assert.match(r.reply,/(document|historic|script|contract|proof|limit|local)/i);
  }
});

test('convert maximum permitted canonicalizes exact on-chain spendable amount',async()=>{
  const {s,checked}=makeSandbox();
  const r=await agentReply(s,'Convert the maximum allowed amount');
  assert.equal(r.kind,'proposal');
  assert.equal(r.amount,25_000_000n);
  assert.equal(r.instruction,'Convert 25.00 tUSD to tEUR');
  assert.deepEqual(checked,[25_000_000n,25_000_000n]);
  assert.equal(r.execution,'awaiting owner confirmation');
});

test('maximum amount question does not propose or broadcast',async()=>{
  const {s,checked}=makeSandbox();
  const r=await agentReply(s,'What is the maximum conversion amount?');
  assert.equal(r.kind,'answer');
  assert.equal(r.execution,'none');
  assert.match(r.reply,/25\.00 tUSD/);
  assert.deepEqual(checked,[25_000_000n]);
});

test('unsupported financial instructions cannot acquire a new execution tool',async()=>{
  const {s,checked}=makeSandbox();
  for(const question of ['Run a Groth16 proof for my private portfolio','Show me the mathematical bounties']){
    const r=await agentReply(s,question);
    assert.equal(r.execution,'none',question);
    assert.notEqual(r.kind,'proposal',question);
  }
  assert.deepEqual(checked,[]);
});


test('questions about historic financial amounts never create proposals',async()=>{
  for (const q of [
    'Why did the escrow pay 15 tUSD after buying 6 tUSD in data?',
    'How did QED convert 20 tUSD in the Sepolia E1 example?',
    'What is the maximum convert amount?',
    'Explain why the agent refused to send 80 tUSD'
  ]) {
    const {s}=makeSandbox();
    const result=await agentReply(s,q);
    assert.equal(result.execution,'none',q);
    assert.notEqual(result.kind,'proposal',q);
  }
});

test('large authorized-format amounts stay exact and are refused by live limits',async()=>{
  const {scanAmount,formatMicro}=await import('../scripts/amount-lexing.mjs');
  const n=scanAmount('Convert 12,345,678,901.000001 tUSD to tEUR');
  assert.equal(n.kind,'valid');
  assert.equal(n.raw,12345678901000001n);
  assert.equal(formatMicro(n.raw),'12,345,678,901.000001');
  const {s}=makeSandbox();
  const answer=await agentReply(s,'Would converting 12,345,678,901.000001 tUSD violate my mandate?');
  assert.equal(answer.kind,'check');
  assert.equal(answer.allowed,false);
  assert.equal(answer.amount,n.raw);
});

test('maximum spend respects the independent reserve-buffer limit',async()=>{
  const {s}=makeSandbox();
  s.checkLimits=async amt=>({allowed:amt<=19_500_000n,checks:[
    {rule:'Amount per payment',pass:amt<=25_000_000n,limit:25_000_000n},
    {rule:'Co-signer reserve buffer',pass:amt<=19_500_000n,limit:19_500_000n}
  ]});
  const r=await agentReply(s,'Convert the maximum allowed amount');
  assert.equal(r.kind,'proposal');
  assert.equal(r.amount,19_500_000n);
  assert.equal(r.allowed,true);
  assert.match(r.instruction,/19\.50 tUSD/);
});
