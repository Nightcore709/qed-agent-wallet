import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../product/index.html', import.meta.url), 'utf8');
const finalStyle = html.slice(html.indexOf('/* Final Agent layout: NEVER'), html.indexOf('</style>'));

test('all desktop Agent states derive height from content without delayed scrolling', () => {
  assert.match(finalStyle, /#v-agent \.agent:not\(:has\(\.agent-welcome\)\)[\s\S]*?height:\s*auto/);
  assert.match(finalStyle, /#v-agent \.agent > \.chat[\s\S]*?height:\s*auto/);
  assert.match(finalStyle, /#v-agent \.chat > \.msgs\s*\{[^}]*max-height:\s*clamp/);
  assert.match(finalStyle, /#v-agent \.chat > \.msgs\s*\{[^}]*overflow-y:\s*auto/);
  assert.doesNotMatch(finalStyle, /justify-content:\s*safe center/);
});

test('the rail is out of document grid flow for welcome and active conversation immediately', () => {
  assert.match(finalStyle, /#v-agent \.agent > \.panel,[\s\S]*?#v-agent \.agent:has\(\.agent-welcome\) > \.panel\s*\{[^}]*position:\s*absolute/);
  assert.match(finalStyle, /#v-agent \.agent > \.panel,[\s\S]*?#v-agent \.agent:has\(\.agent-welcome\) > \.panel\s*\{[^}]*height:\s*100%/);
  assert.match(finalStyle, /#v-agent \.agent > \.panel,[\s\S]*?#v-agent \.agent:has\(\.agent-welcome\) > \.panel\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(html, /class="panel" role="region" aria-label="Execution trail and treasury balances; scroll independently" tabindex="0"/);
});

test('mobile Agent uses natural height and accessible page scrolling', () => {
  const responsive=finalStyle.slice(finalStyle.indexOf('@media (max-width:1080px)'));
  assert.match(responsive, /#v-agent \.agent:not\(:has\(\.agent-welcome\)\)[\s\S]*?height:\s*auto/);
  assert.match(responsive, /#v-agent \.agent > \.panel,[\s\S]*?#v-agent \.agent:has\(\.agent-welcome\) > \.panel\s*\{[^}]*position:\s*static/);
  assert.match(responsive, /#v-agent \.agent > \.panel,[\s\S]*?#v-agent \.agent:has\(\.agent-welcome\) > \.panel\s*\{[^}]*overflow:\s*visible/);
});
