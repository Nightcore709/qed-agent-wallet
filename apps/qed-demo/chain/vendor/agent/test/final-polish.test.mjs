import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';

const html = readFileSync(new URL('../../product/index.html', import.meta.url), 'utf8');
const server = readFileSync(new URL('../scripts/demo-server.mjs', import.meta.url), 'utf8');

test('first-use agent uses four real routes and an adaptive, non-centred command workspace', () => {
  assert.match(html, /data-welcome-question="Convert 10 tUSD to tEUR"/);
  assert.match(html, /data-welcome-question="Quote 12\.5 tUSD to tEUR"/);
  assert.match(html, /data-welcome-question="Would converting 80 tUSD violate my mandate\?"/);
  assert.match(html, /class="welcome-service-link"/);
  assert.match(html, /class="welcome-trust-line"/);
  assert.match(html, /#v-agent \.chat:has\(\.agent-welcome\)\{height:auto;min-height:0/);
  assert.doesNotMatch(html, /#v-agent \.chat\{height:850px/);
});

test('deeper Agent routes lead to actual configurable tool forms', () => {
  for(const tool of ['portfolio','clearing','private_portfolio'])
    assert.match(html,new RegExp(`data-preset-workbench="${tool}"`));
  assert.match(html,/function workbenchFields\(\)/);
  assert.match(html,/a\.dataset\.presetWorkbench/);
  assert.match(html,/\$\("#wb-tool"\)\.value=value;workbenchFields\(\)/);
  assert.match(html,/id="workbench-form"/);
});

test('financial parameters respect micro-token precision at the native form boundary', () => {
  assert.match(html,/id="m-cap"[^>]*step="0\.000001"/);
  assert.match(html,/id="p-target"[^>]*step="0\.000001"/);
  assert.match(server,/export function exactSetting\(value\)/);
});

test('Claude connectivity is distinguished from merely configured credentials and offline mode', () => {
  assert.match(html,/h\.claudeObserved\?\.at/);
  assert.match(html,/Claude configured · not yet verified/);
  assert.match(html,/Claude connected · actual response observed/);
  assert.match(html,/AI offline · deterministic parser/);
  assert.match(html,/"CHAIN LIVE"/);
});

test('guest browser identifiers are cryptographically random even outside secure-context randomUUID', () => {
  assert.match(html, /function secureUUID\(\)/);
  assert.match(html, /globalThis\.crypto\.getRandomValues\(bytes\)/);
  assert.match(html, /id=secureUUID\(\)/);
  assert.match(html, /const reference=secureUUID\(\)/);
  assert.doesNotMatch(html, /Math\.random\(/);
});

test('the final UI keeps every main destination and protects state-changing tool confirmation', () => {
  for(const screen of ['overview','agent','treasury','execution','lab','services','evidence'])
    assert.match(html, new RegExp(`id="v-${screen}"`));
  assert.match(server, /const owner=visitor\(req\),submission=submissions\.check\(owner/);
  assert.match(server, /conversations\.claim\(sandbox,owner,input\.proposalId\)/);
  const source = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(source);
  assert.doesNotThrow(()=>new Script(source));
});
