import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SubmissionTracker } from '../scripts/submission-tracker.mjs';
const key='d3bbf6e2-0b0e-41ac-9852-6e30926e5240';
const other='d3bbf6e2-0b0e-41ac-9852-6e30926e5241';
const input={instruction:'Convert 10 tUSD to tEUR'};

test('a lost POST response can recover the original job without scheduling another',()=>{
  const registry=new SubmissionTracker();
  const first=registry.check('userA',key,'convert',input);
  assert.equal(first.kind,'new');
  registry.register(first,'chain-job-1');
  assert.deepEqual(registry.check('userA',key,'convert',input),{kind:'existing',jobId:'chain-job-1'});
  assert.equal(registry.lookup('userA',key),'chain-job-1');
});

test('a reused request reference cannot authorize a different transaction',()=>{
  const registry=new SubmissionTracker();
  registry.register(registry.check('userA',key,'convert',input),'chain-job-1');
  assert.equal(registry.check('userA',key,'convert',{instruction:'Convert 20 tUSD to tEUR'}).kind,'conflict');
  assert.equal(registry.check('userA',key,'reset',{}).kind,'conflict');
  assert.equal(registry.lookup('userA',key),'chain-job-1');
});

test('one visitor cannot resolve another visitor’s private job reference',()=>{
  const registry=new SubmissionTracker();
  registry.register(registry.check('userA',key,'convert',input),'chain-job-1');
  assert.equal(registry.lookup('userB',key),undefined);
  assert.equal(registry.check('userB',key,'convert',input).kind,'new');
  assert.equal(registry.check('userA',other,'convert',input).kind,'new');
});

test('legacy scripted callers work but malformed references are refused',()=>{
  const registry=new SubmissionTracker();
  assert.equal(registry.check('userA',undefined,'convert',input).kind,'unkeyed');
  for(const broken of ['not-a-uuid','',123,null,[]])assert.equal(registry.check('userA',broken,'convert',input).kind,'invalid');
  assert.equal(registry.lookup('userA','invalid'),undefined);
});
