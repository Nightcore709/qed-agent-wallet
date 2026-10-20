/**
 * QED Interactive Demo — a deliberately bounded, executable local-chain product.
 * No cloud/private signing keys are accepted. Only deterministic DEV identities on Anvil.
 * The browser never receives ANTHROPIC_API_KEY. Scripts remain the single source of truth.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeBrain, guard } from "../src/brain/index.js";
import { Sandbox, ATTACK_KINDS, fmt6, ser } from "../src/sandbox.js";
import { agentReply } from "./agent-chat.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const EVIDENCE = join(ROOT, "evidence", "demo-runs");
const PAGE = join(ROOT, "product", "index.html");
const PORT = Number(process.env.PORT ?? 4173);
const PUBLIC = process.env.QED_PUBLIC_DEMO === "1";
const HOST = PUBLIC ? "0.0.0.0" : "127.0.0.1";
const ANVIL_PORT = Number(process.env.QED_DEMO_ANVIL_PORT ?? 8645);
const SCENARIOS = Object.freeze({
  execution: "agent/scripts/execute.ts",
  economy: "agent/scripts/live.ts",
  clearing: "agent/scripts/clearing.ts",
  privacy: "agent/scripts/private.ts",
});
const sessions = new Map();
const quotas = new Map();
const chatQuotas=new Map();
const MAX_TOTAL_RUNS=Number(process.env.QED_MAX_DEMO_RUNS??40);
let totalRunCount=0;
const MAX_CHAT_CALLS=Number(process.env.QED_MAX_CHAT_CALLS??80);
let totalChatCount=0;
let active = null;
const MAX_BODY = 3000;

// The client can propose amounts; only the signed owner mandate can authorize them.
// This allowlist narrows the *demo objective*, not the numerical amount.
const PAYMENT_CAP_MICRO = 25_000_000n;
function parseRequestedAmount(text) {
  if(typeof text!=="string")return {error:"Enter a financial instruction."};
  // Strictly parse each explicitly denominated test-dollar amount. Ambiguity is refused,
  // including two numbers with different values or a number without token units.
  const matches=[...text.matchAll(/\b(\d{1,9}(?:\.\d{1,6})?)\s*(?:tUSD|test\s*(?:USD|dollars?))\b/gi)];
  if(matches.length!==1)return {error:"Specify one unambiguous amount in tUSD (for example, 10 tUSD)."};
  const [whole,fract=""]=matches[0][1].split(".");
  return {amount:BigInt(whole)*1_000_000n+BigInt(fract.padEnd(6,"0"))};
}
export function validateRun(input) {
  if (!input || typeof input !== "object") return "Invalid request.";
  if (!Object.hasOwn(SCENARIOS, input.scenario)) return "Select a supported demonstration.";
  if(PUBLIC && process.env.QED_PUBLIC_SCENARIOS && !process.env.QED_PUBLIC_SCENARIOS.split(",").includes(input.scenario)) return "This scripted economy is disabled on the public service.";
  if (input.scenario === "execution") {
    const s = input.instruction;
    if (typeof s !== "string" || s.length > 240 || s.length < 12) return "Enter a concise financial instruction (12–240 characters).";
    if (/(?:ignore|override|bypass|disable|secret|private key|withdraw to|send to|unapproved|change (?:the )?(?:owner|limit|payee))/i.test(s))
      return "Policy-escalation request refused. Only the owner can change a signed mandate; no transaction was submitted.";
    if (!/\b(?:convert|move|top up|sweep|exchange|swap)\b/i.test(s) ||
        !/\b(?:reserve|euro)\b/i.test(s))
      return "The demo owner authorized tUSD → euro-reserve conversions only. Other financial objectives require a separate signed mandate.";
    const a=parseRequestedAmount(s);
    if(a.error)return a.error;
    if(a.amount<=0n)return "An execution amount must be greater than zero.";
    if(a.amount>PAYMENT_CAP_MICRO)
      return "Owner mandate refuses this payment: "+(Number(a.amount)/1e6).toLocaleString("en-US")+" tUSD exceeds the signed per-payment limit of 25 tUSD. The AI cannot raise it. Ask the owner to sign a new mandate.";
    // Certified execution tolerances and pool liquidity determine whether any given
    // positive amount can actually settle. We never promise one will succeed.
  }
  if (input.impact !== undefined && ![50,150].includes(input.impact)) return "Supported impact policies: 50 or 150 basis points.";
  return null;
}

function publicStep(step) {
  return {
    id:step.id, phase:step.phase, title:step.title, narrative:step.narrative,
    actor:step.actor, at:step.at, offchain:!!step.offchain, expect:step.expect,
    transaction:step.tx ? {hash:step.tx.hash, status:step.tx.status, block:step.tx.blockNumber, gas:step.tx.gasUsed, from:step.tx.from, to:step.tx.to} : null,
    error:step.error ? {name:step.error.name, args:step.error.args} : null,
    attack:step.attack || null
  };
}
function readEvidence(run) {
  try {
    const file=join(EVIDENCE, run.id,"manifest.json");
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file,"utf8"));
  } catch { return null; }
}
function sendEvent(run,kind,data) {
  const event={kind,at:new Date().toISOString(),data};
  run.events.push(event);
  if(run.events.length>800)run.events.shift();
  for(const res of run.listeners) {
    try{res.write("data: "+JSON.stringify(event)+"\n\n");}catch{run.listeners.delete(res);}
  }
}
function refresh(run) {
  const evidence=readEvidence(run);
  if(!evidence) return;
  const steps=evidence.steps||[];
  for(let i=run.emitted;i<steps.length;i++)sendEvent(run,"step",publicStep(steps[i]));
  run.emitted=steps.length;
}
function report(run) {
  const ev=readEvidence(run);
  let aiEngine="not yet observed";
  try {
    const brain=JSON.parse(readFileSync(join(EVIDENCE,run.id,"records","A1-brain.json"),"utf8"));
    aiEngine=brain.engine||"unknown";
  } catch {
    aiEngine=run.modelRequested ? "model requested; no transcript recorded yet" : "offline-deterministic";
  }
  return {
    id:run.id, scenario:run.scenario, startedAt:run.startedAt, finishedAt:run.finishedAt,
    status:run.status, exitCode:run.exitCode, network:"Anvil 31337 (local, disposable, valueless)",
    modelRequested:run.modelRequested, aiEngine, emittedSteps:run.emitted,
    final:ev?.final||null, policyRun:ev?.policyRun||null, policyChain:ev?.policyChain||null,
    plans:ev?.plans ? {A3:ev.plans.A3,A6:ev.plans.A6} : null,
    steps:(ev?.steps||[]).map(publicStep), lastLines:run.logs.slice(-14),
    error:run.error||null
  };
}
function clientIp(req){
  // Railway's edge sets X-Real-IP; trusted only when QED_TRUST_PROXY=1 (set in the Docker image).
  if(process.env.QED_TRUST_PROXY==="1"&&typeof req.headers["x-real-ip"]==="string")return req.headers["x-real-ip"].slice(0,64);
  return req.socket.remoteAddress||"anonymous";
}
const opQuotas=new Map();
const MAX_OPS_PER_HOUR=Number(process.env.QED_MAX_OPS_PER_HOUR??30);
const MAX_TOTAL_OPS=Number(process.env.QED_MAX_TOTAL_OPS??1500);
let totalOps=0;
function mayOperate(req){
  const ip=clientIp(req),now=Date.now();
  const prev=(opQuotas.get(ip)||[]).filter(t=>now-t<3600000);
  if(prev.length>=MAX_OPS_PER_HOUR||totalOps>=MAX_TOTAL_OPS)return false;
  prev.push(now);opQuotas.set(ip,prev);totalOps++;return true;
}
const agentQuotas=new Map();
function mayAsk(req){
  const ip=clientIp(req),now=Date.now();
  const prev=(agentQuotas.get(ip)||[]).filter(t=>now-t<3600000);
  if(prev.length>=Number(process.env.QED_MAX_QUESTIONS_PER_HOUR??60))return false;
  prev.push(now);agentQuotas.set(ip,prev);return true;
}
// Sandbox jobs: chain-mutating operations run one at a time; the browser polls /api/jobs/:id.
const jobs=new Map();
function newJob(kind,run){
  const id=randomUUID();
  const job={id,kind,status:"running",steps:[],result:null,error:null,createdAt:new Date().toISOString()};
  jobs.set(id,job);
  if(jobs.size>300){for(const k of jobs.keys()){jobs.delete(k);if(jobs.size<=250)break;}}
  run(s=>job.steps.push(s)).then(r=>{job.result=r;job.status="done";},e=>{job.error=String(e?.message||e).slice(0,400);job.status="failed";});
  return job;
}
export const sandbox=new Sandbox();
// The public sandbox is shared: after QED_IDLE_RESET_MIN minutes without a chain operation, it returns to its initial
// state (100 tUSD, empty reserve, mandate v1) so the next visitor starts fresh. Resets are recorded in the history.
let lastOpAt=Date.now();
const IDLE_RESET_MS=Number(process.env.QED_IDLE_RESET_MIN??15)*60000;
setInterval(()=>{if(sandbox.status==="ready"&&sandbox.history.some(h=>h.kind!=="reset")&&Date.now()-lastOpAt>IDLE_RESET_MS){lastOpAt=Date.now();sandbox.reset().catch(()=>{});}},60000).unref();
let sandboxStarting=null;
export function startSandbox(){
  if(!sandboxStarting)sandboxStarting=sandbox.start().catch(e=>{console.error("sandbox failed:",e.message);});
  return sandboxStarting;
}
let evidenceCache=null;
function evidenceIndex(){
  if(evidenceCache)return evidenceCache;
  const runs=[["evidence/ethereum-sepolia/manifest.json","Run 1 · authorised payments, escrow, attacks, honeypot"],["evidence/ethereum-sepolia/clearing/manifest.json","Run 2 · certified clearing"],["evidence/ethereum-sepolia/private/manifest.json","Run 3 · zero-knowledge optimality"],["evidence/ethereum-sepolia/execution/manifest.json","Run 4 · certified best execution and treasury policy"]];
  const txs=[];
  for(const [file,run] of runs){
    try{const m=JSON.parse(readFileSync(join(ROOT,file),"utf8"));
      for(const st of m.steps||[])if(st.tx)txs.push({run,id:st.id,phase:st.phase,title:st.title,hash:st.tx.hash,status:st.tx.status,block:st.tx.blockNumber,gas:st.tx.gasUsed,error:st.error?.name||null,expect:st.expect||null});
    }catch{}
  }
  let contracts=[];
  try{contracts=JSON.parse(readFileSync(join(ROOT,"verification/sourcify.json"),"utf8")).contracts.map(c=>({name:c.name,address:c.address,match:c.match}));}catch{}
  evidenceCache={network:"Ethereum Sepolia (chain 11155111)",explorer:"https://sepolia.etherscan.io",note:"Historical: mined earlier on the public Ethereum Sepolia testnet by the QED team. Not generated by your session.",transactions:txs,contracts,ledger:"https://nightcore709.github.io/qed-agent-wallet/"};
  return evidenceCache;
}
function mayChat(req){
  const ip=clientIp(req),now=Date.now();
  const prev=(chatQuotas.get(ip)||[]).filter(t=>now-t<3600000);
  if(prev.length>=12)return false;
  prev.push(now);chatQuotas.set(ip,prev);return true;
}
function readOnlyContext(){
  // No chain session means no treasury; never invent balances or approvals.
  return { balance:0n,protectedBalance:0n,free:0n,blastRadius24h:0n,dailyCap:25_000_000n,
    spentInWindow:0n,paused:false,payees:[] };
}
function mayRun(req) {
  const ip=clientIp(req);
  const now=Date.now(), prev=(quotas.get(ip)||[]).filter(t=>now-t<3600000);
  if(prev.length>=4) return false;
  prev.push(now);quotas.set(ip,prev);return true;
}
function environment(run,input) {
  const env={...process.env};
  // Child must NEVER inherit externally configured real wallet signing keys.
  for(const k of Object.keys(env)) if(k.endsWith("_PK") || k.endsWith("_ADDR") ||
    ["SHADOW_OF","START_STATE","EXTRA_KEYS","RPC_URL","CHAIN_ID","DEPLOYER_START_WEI","ANVIL_GENESIS_TS"].includes(k))delete env[k];
  // The main economy relies on local.ts generating deterministic DEV role keys.
  if(run.scenario==="economy") delete env.KEYS_FILE;
  else env.KEYS_FILE="/nonexistent";
  env.SCRIPT=SCENARIOS[run.scenario];
  env.EVIDENCE_DIR=join(EVIDENCE,run.id);
  env.ANVIL_PORT=String(ANVIL_PORT);
  env.QED_DEMO_INSTRUCTION=run.scenario==="execution"?input.instruction:"";
  env.POLICY_IMPACT_BPS=String(input.impact??150);
  env.QED_OFFLINE=run.modelRequested?"0":"1";
  return env;
}
function startRun(run,input) {
  mkdirSync(join(EVIDENCE,run.id),{recursive:true});
  active=run;
  run.status="running";
  sendEvent(run,"status",{status:"running",network:"Anvil 31337",model:run.modelRequested?"Anthropic requested; transcript will confirm":"offline-deterministic"});
  const child=spawn(process.execPath,["--import","tsx","agent/scripts/local.ts"],{
    cwd:ROOT,env:environment(run,input),stdio:["ignore","pipe","pipe"]
  });
  run.child=child;
  const pushLog=(v,type)=>{
    for(const line of v.split(/\r?\n/)) {
      const cleaned=line.replace(/\x1b\[[0-9;]*m/g,"").trim();
      if(!cleaned)continue;
      const text=cleaned.slice(0,700);
      run.logs.push(text);if(run.logs.length>140)run.logs.shift();
      // Do not stream potentially sensitive shell/environment dumps.
      if(/^(PHASE |DONE\.|FATAL|✓|✗|•|QED Execute|no \.keys\.env|ERROR)/.test(text))
        sendEvent(run,"log",{text,source:type});
    }
  };
  child.stdout.on("data",buf=>{pushLog(buf.toString(),"stdout");refresh(run);});
  child.stderr.on("data",buf=>{pushLog(buf.toString(),"stderr");refresh(run);});
  const poll=setInterval(()=>refresh(run),400);poll.unref();
  const complete=(status,code,error)=>{
    if(run.finishedAt)return;
    clearInterval(poll);refresh(run);
    run.status=status;run.exitCode=code;run.error=error||null;run.finishedAt=new Date().toISOString();
    if(status==="complete" && !readEvidence(run)?.steps?.length) {
      run.status="failed";run.error="The process exited without producing transaction evidence.";
    }
    sendEvent(run,"status",{status:run.status,error:run.error,exitCode:run.exitCode,aiEngine:report(run).aiEngine});
    active=null;
  };
  child.on("error",e=>complete("failed",null,e.message));
  child.on("exit",code=>complete(code===0?"complete":"failed",code,code===0?null:"Financial workflow did not complete; inspect the log."));
}
function json(res,status,obj){res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});res.end(JSON.stringify(obj));}
async function body(req){
  const parts=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>MAX_BODY)throw new Error("Request exceeds the 3 KB limit.");parts.push(chunk);}
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
}
function pathParts(req){return new URL(req.url||"/","http://localhost").pathname.split("/").filter(Boolean);}
export function createDemoServer() {
  const server=createServer(async(req,res)=>{
    const parts=pathParts(req), method=req.method||"GET";
    res.setHeader("X-Content-Type-Options","nosniff");
    res.setHeader("X-Frame-Options","DENY");
    res.setHeader("Referrer-Policy","strict-origin-when-cross-origin");
    res.setHeader("Content-Security-Policy","default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'");
    const origin=req.headers.origin;
    if(origin){
      let okay=false;
      try {const u=new URL(origin);const allowed=process.env.QED_ALLOWED_ORIGIN;
        okay=u.host===req.headers.host || (allowed&&u.origin===allowed);
      }catch{}
      if(!okay)return json(res,403,{error:"Cross-origin requests are not permitted."});
    }
    if(method==="GET" && (parts.length===0 || parts[0]==="index.html")){
      res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"});
      return res.end(readFileSync(PAGE));
    }
    if(method==="GET" && parts.join("/")==="api/health")
      return json(res,200,{status:"ok",mode:PUBLIC?"public-bounded-demo":"localhost",network:"Anvil 31337",modelConfigured:!!process.env.ANTHROPIC_API_KEY&&process.env.QED_OFFLINE!=="1",aiEngine:sandbox.brain.engine,sandbox:sandbox.status,sandboxError:sandbox.error,active:!!active});
    if(method==="POST" && parts.join("/")==="api/chat"){
      if(!mayChat(req))return json(res,429,{error:"Read-only agent question limit: 12 per hour per connection."});
      if(totalChatCount>=MAX_CHAT_CALLS)return json(res,429,{error:"Global read-only AI question budget exhausted."});
      totalChatCount++;
      let input;try{input=await body(req);}catch{return json(res,400,{error:"Invalid request."});}
      if(typeof input?.message!=="string"||input.message.trim().length<2||input.message.length>1000)
        return json(res,422,{error:"Enter a question between 2 and 1,000 characters."});
      // This pathway NEVER starts a signing process or submits a transaction.
      // It only interprets the request and produces an independently guarded proposal.
      const message=input.message.trim();
      if(/(?:balance|how much|reserve|available|spent|status|holdings|blast radius|what can i lose)/i.test(message))
        return json(res,200,{engine:"local-state-gate",intent:"status",reply:"Read-only chat is intentionally not an authenticated on-chain treasury account. Do not treat it as your balance. Launch the local execution workflow and inspect the actual, recorded reserve snapshots and receipts. Historical Sepolia numbers are separately labeled.",flags:[],proposedAction:null,requiresOwnerAuthorization:false});
      try{
        const brain=makeBrain();
        const {result,transcript}=await brain.interpret(message,readOnlyContext(),"owner");
        const decision=guard(message,result,readOnlyContext(),25_000_000n);
        const proposal=decision.proposal?.kind==="pay" ? {
          type:"pay",payeeLabel:decision.proposal.payeeLabel,
          amountTUSD:decision.proposal.amount?Number(decision.proposal.amount)/1e6:null
        }:null;
        return json(res,200,{engine:transcript.engine,intent:decision.intent,reply:decision.reply,
          flags:decision.flags,proposedAction:proposal,requiresOwnerAuthorization:!!decision.needsConfirmation,
          execution:"none",notice:"Read-only QED language-layer evaluation. The signed mandate and on-chain contracts alone authorize execution."});
      }catch{return json(res,503,{error:"The agent interpretation service is unavailable. No transaction was attempted."});}
    }
    const route=parts.join("/");
    if(method==="GET"&&route==="api/sandbox/state"){
      try{return json(res,200,await sandbox.state());}catch(e){return json(res,503,{status:"failed",error:"Sandbox state unavailable."});}
    }
    if(method==="GET"&&route==="api/evidence")return json(res,200,evidenceIndex());
    if(method==="GET"&&parts[0]==="api"&&parts[1]==="jobs"&&parts[2]){
      const job=jobs.get(parts[2]);
      return job?json(res,200,job):json(res,404,{error:"Unknown job."});
    }
    if(method==="POST"&&route==="api/agent"){
      if(!mayAsk(req))return json(res,429,{error:"Question limit reached for this connection (60 per hour)."});
      let input;try{input=await body(req);}catch{return json(res,400,{error:"Invalid request."});}
      if(typeof input?.message!=="string"||input.message.trim().length<2||input.message.length>600)return json(res,422,{error:"Ask something between 2 and 600 characters."});
      try{return json(res,200,ser(await agentReply(sandbox,input.message.trim())));}
      catch(e){return json(res,503,{error:"The agent could not answer: "+String(e?.message||e).slice(0,200)+". No transaction was attempted."});}
    }
    if(method==="POST"&&parts[0]==="api"&&parts[1]==="sandbox"&&parts[2]){
      const op=parts[2];
      if(!["convert","attack","policy-tick","mandate","policy","reset"].includes(op))return json(res,404,{error:"Not found."});
      if(sandbox.status!=="ready")return json(res,503,{error:sandbox.status==="starting"?"The sandbox chain is still starting; try again in a few seconds.":"The sandbox chain is unavailable."});
      lastOpAt=Date.now();
      if(!mayOperate(req))return json(res,429,{error:"Operation limit reached (30 per hour per connection, global cap applies)."});
      let input;try{input=await body(req);}catch{return json(res,400,{error:"Invalid request."});}
      input=input&&typeof input==="object"?input:{};
      if(op==="convert"){
        const s=input.instruction;
        if(typeof s!=="string"||s.trim().length<4||s.length>240)return json(res,422,{error:"Enter a conversion instruction (4–240 characters)."});
        return json(res,202,newJob("convert",emit=>sandbox.convert(s.trim(),emit)));
      }
      if(op==="attack"){
        if(!ATTACK_KINDS.includes(input.kind))return json(res,422,{error:"Unknown attack."});
        return json(res,202,newJob("attack",emit=>sandbox.attack(input.kind,emit)));
      }
      if(op==="policy-tick")return json(res,202,newJob("policy-tick",emit=>sandbox.policyTick(emit)));
      if(op==="mandate"){
        const n=Number(input.maxPerPayment);
        if(!(n>=1&&n<=100))return json(res,422,{error:"The sandbox owner may sign a per-conversion limit between 1 and 100 tUSD."});
        return json(res,202,newJob("mandate",()=>sandbox.setMandate(n)));
      }
      if(op==="policy"){
        const n=Number(input.targetFree);
        if(!(n>=2&&n<=80))return json(res,422,{error:"Choose a reserve target between 2 and 80 tEUR."});
        return json(res,202,newJob("policy",()=>sandbox.setPolicy(n)));
      }
      if(op==="reset")return json(res,202,newJob("reset",()=>sandbox.reset()));
    }
    if(method==="GET" && parts.join("/")==="api/latest")
      return json(res,200,{run:active?.id||(Array.from(sessions.values()).at(-1)?.id??null)});
    if(method==="POST" && parts.join("/")==="api/run"){
      if(active)return json(res,409,{error:"A local blockchain run is already in progress. Wait for it to complete."});
      if(totalRunCount>=MAX_TOTAL_RUNS)return json(res,429,{error:"Global public demo budget exhausted; no additional execution may be started."});
      if(!mayRun(req))return json(res,429,{error:"Demo limit reached: four runs per hour per connection."});
      let input;try{input=await body(req);}catch(e){return json(res,400,{error:"Invalid request body."});}
      const problem=validateRun(input);
      if(problem)return json(res,422,{error:problem});
      const id=randomUUID();
      const run={id,scenario:input.scenario,status:"queued",startedAt:new Date().toISOString(),
        finishedAt:null,exitCode:null,events:[],logs:[],emitted:0,listeners:new Set(),
        modelRequested:!!process.env.ANTHROPIC_API_KEY && process.env.QED_OFFLINE!=="1",error:null};
      sessions.set(id,run);
      // Do not create unlimited in-memory history.
      if(sessions.size>12){for(const [key,r] of sessions){if(r!==active && r!==run){sessions.delete(key);break;}}}
      totalRunCount++;
      startRun(run,input);
      return json(res,202,{id,status:"running",url:"/api/run/"+id});
    }
    if(parts[0]==="api"&&parts[1]==="run"&&parts[2]&&sessions.has(parts[2])){
      const run=sessions.get(parts[2]);
      if(method==="GET" && parts.length===3)return json(res,200,report(run));
      if(method==="GET"&&parts[3]==="events"){
        res.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-cache, no-transform","Connection":"keep-alive","X-Accel-Buffering":"no"});
        res.write(": connected\n\n");
        // Buffered events make page refresh consistent.
        for(const event of run.events)res.write("data: "+JSON.stringify(event)+"\n\n");
        if(run.finishedAt){res.end();return;}
        run.listeners.add(res);
        req.on("close",()=>run.listeners.delete(res));
        return;
      }
    }
    if(method==="GET"&&parts.join("/")==="api/config")
      return json(res,200,{public:PUBLIC,modelConfigured:!!process.env.ANTHROPIC_API_KEY,scenarios:Object.keys(SCENARIOS),
        caveat:"A real, finite scripted economy runs against a fresh local Anvil chain; each accepted browser instruction is passed into the existing QED interpreter. This is not a persistent production wallet."});
    return json(res,404,{error:"Not found."});
  });
  return server;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const server=createDemoServer();
  if(process.env.QED_SANDBOX!=="0")startSandbox();
  server.listen(PORT,HOST,()=>{
    console.log("\nQED Interactive Demo → http://"+(HOST==="0.0.0.0"?"localhost":HOST)+":"+PORT);
    console.log("Blockchain: ephemeral Anvil 31337. No real money. "+(process.env.ANTHROPIC_API_KEY?"Anthropic key configured.":"Offline deterministic model."));
    console.log("Press Ctrl+C to stop.\n");
  });
  for(const s of ["SIGINT","SIGTERM"])process.on(s,()=>{if(active?.child)active.child.kill(s);sandbox.stop();server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),1500).unref();});
}
