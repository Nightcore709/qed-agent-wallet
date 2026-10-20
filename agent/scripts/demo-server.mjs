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
let active = null;
const MAX_BODY = 3000;

export function validateRun(input) {
  if (!input || typeof input !== "object") return "Invalid request.";
  if (!Object.hasOwn(SCENARIOS, input.scenario)) return "Select a supported demonstration.";
  if (input.scenario === "execution") {
    const s = input.instruction;
    if (typeof s !== "string" || s.length > 240 || s.length < 12) return "Enter a concise financial instruction.";
    // The tested scenario starts with an owner-authorized 20 tUSD conversion.
    // We do not pretend to permit changing the owner mandate via natural language.
    if (!/\b(?:convert|move|top up|sweep|exchange|swap)\b/i.test(s) ||
        !/\b(?:reserve|euro)\b/i.test(s) ||
        !/\b20(?:\.0+)?\s*(?:tusd|test(?:\s+)?dollars?)\b/i.test(s))
      return "This bounded demo supports moving exactly 20 tUSD to the euro reserve. Other instructions cannot authorize a transfer.";
    if (/(?:ignore|override|bypass|disable|secret|private key|withdraw to|send to|unapproved|change (?:the )?(?:owner|limit|payee))/i.test(s))
      return "This request attempts to alter security boundaries. No transaction will be submitted.";
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
function mayRun(req) {
  // Deliberately conservative; never trust X-Forwarded-For from the public internet.
  const ip=req.socket.remoteAddress||"anonymous";
  const now=Date.now(), prev=(quotas.get(ip)||[]).filter(t=>now-t<3600000);
  if(prev.length>=4) return false;
  prev.push(now);quotas.set(ip,prev);return true;
}
function environment(run,input) {
  const env={...process.env};
  // Child must NEVER inherit externally configured real wallet signing keys.
  for(const k of Object.keys(env)) if(k.endsWith("_PK") || k.endsWith("_ADDR") ||
    ["SHADOW_OF","START_STATE","EXTRA_KEYS","RPC_URL","CHAIN_ID","DEPL0YER_START_WEI","ANVIL_GENESIS_TS"].includes(k))delete env[k];
  env.KEYS_FILE="/nonexistent";
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
      return json(res,200,{status:"ok",mode:PUBLIC?"public-bounded-demo":"localhost",network:"Anvil 31337",modelConfigured:!!process.env.ANTHROPIC_API_KEY,active:!!active});
    if(method==="GET" && parts.join("/")==="api/latest")
      return json(res,200,{run:active?.id||(Array.from(sessions.values()).at(-1)?.id??null)});
    if(method==="POST" && parts.join("/")==="api/run"){
      if(active)return json(res,409,{error:"A local blockchain run is already in progress. Wait for it to complete."});
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
  server.listen(PORT,HOST,()=>{
    console.log("\nQED Interactive Demo → http://"+(HOST==="0.0.0.0"?"localhost":HOST)+":"+PORT);
    console.log("Blockchain: ephemeral Anvil 31337. No real money. "+(process.env.ANTHROPIC_API_KEY?"Anthropic key configured.":"Offline deterministic model."));
    console.log("Press Ctrl+C to stop.\n");
  });
  for(const s of ["SIGINT","SIGTERM"])process.on(s,()=>{if(active?.child)active.child.kill(s);server.close(()=>process.exit(0));});
}
