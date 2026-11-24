import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {allowedPublicScript,PublicWorkBudget,HEAVY_PUBLIC_TOOLS} from '../scripts/public-safety.mjs';
import {certificateNow} from '../src/sandboxClock.ts';
const server=readFileSync(new URL('../scripts/demo-server.mjs',import.meta.url),'utf8');
test('public scripted execution remains allowlisted without extra configuration',()=>{
 assert.equal(allowedPublicScript('execution'),true);
 for (const s of ['privacy','clearing','economy','shell']) assert.equal(allowedPublicScript(s),false);
 assert.equal(allowedPublicScript('privacy','execution,privacy'),true);
 assert.match(server,/PUBLIC && !allowedPublicScript\(input\.scenario\)/);
});
test('costly crypto-workbench tasks have a global and per-connection sliding budget',()=>{
 const b=new PublicWorkBudget({maxGlobal:3,maxPerIp:2,windowMs:60});
 assert.equal(b.consume('a',100),true);
 assert.equal(b.consume('a',101),true);
 assert.equal(b.consume('a',102),false);
 assert.equal(b.consume('b',103),true);
 assert.equal(b.consume('c',104),false);
 assert.equal(b.consume('a',200),true);
 assert.equal(HEAVY_PUBLIC_TOOLS.has('private_portfolio'),true);
 assert.equal(HEAVY_PUBLIC_TOOLS.has('convert'),false);
 assert.match(server,/publicWorkBudget\.consume/);
});
test('sandbox certificate clock guards against Anvil idle-time drift without changing mainnet expiry semantics',()=>{
 // A stale last mined block is not a safe clock for an immediately forthcoming Anvil tx.
 const oneHour=3600;
 assert.equal(certificateNow(1_700_000_000,31337,1_700_000_000+oneHour*10),1_700_000_000+oneHour*10);
 assert.equal(certificateNow(1_700_000_000,11155111,1_700_000_000+oneHour*10),1_700_000_000);
 assert.equal(certificateNow(200,31337,100),200);
 assert.throws(()=>certificateNow(-1,31337,100),RangeError);
});
test('public sandbox never gets unrestricted CLI or contract calldata from a user',()=>{
 assert.doesNotMatch(server,/exec\(input\.|spawn\(input\./);
 assert.match(server,/HEAVY_PUBLIC_TOOLS/);
 assert.match(server,/releaseId:RELEASE_ID/);
 assert.match(server,/submissions\.check\(owner/);
});
