/** Configurable local scenarios using the original contracts and certifying solvers.
 * Separate role keys, token and contracts per scenario. Never accepts a URL, key,
 * calldata, payee address or caller-selected contract. Called only after confirmation.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { keccak256, toHex, parseUnits, parseEther, type Hex, type Address, type LocalAccount } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import * as A from './abi/contracts.js';
import { Chain$, fn, type TxResult } from './chain.js';
import { certify, checkCertificate, covToWad, WAD } from './engine/minvar.js';
import { encodeSpec, encodeSolution } from './engine/riskModel.js';
import { solveNetting, checkNetting, netPositions, settlementOrder } from './engine/netting.js';
import { signQuote, signMandate, type Mandate } from './protocol/eip712.js';
import { PolicyEngine, ownerInstructionMessage } from './roles/cosigner.js';
import { planTrade, pricesForChain, hopsForChain } from './roles/trader.js';
import { validateCapability } from '../scripts/capabilities.mjs';
import type { Emit, Step } from './sandbox.js';
const json=(x:unknown):any=>JSON.parse(JSON.stringify(x,(_,v)=>typeof v==='bigint'?v.toString():v));
const U=(x:string)=>parseUnits(x,6);

export async function runWorkbench(c:Chain$, name:string, raw:unknown, emit:Emit, market?:{exec:Address;usd:Address;eur:Address}) {
  if(c.chainId!==31337||!/^http:\/\/127\.0\.0\.1:\d+$/.test(c.rpcUrl)||await c.pub.getChainId()!==31337)throw new Error('Workbench is restricted to the local Anvil sandbox.');
  const input=validateCapability(name,raw), id=randomUUID(), steps:Step[]=[];
  const recordsDir=`evidence/demo-runs/workbench/${id}/records`;mkdirSync(recordsDir,{recursive:true});
  const role=(n:string)=>privateKeyToAccount(keccak256(toHex(`qed-workbench-${id}-${n}`)));
  const owner=role('owner'),agent=role('agent'),checker=role('checker'),client=role('client'),vendor=role('vendor'),creditor=role('cloudco');
  const push=(key:string,label:string,status:Step['status'],detail:string,data:unknown={})=>{const s={key,label,status,detail,data:json(data),at:new Date().toISOString()};steps.push(s);emit(s);};
  const brief=(t:TxResult)=>({hash:t.hash,status:t.status,block:String(t.blockNumber),gasUsed:String(t.gasUsed),error:t.error?.name});
  const receipt=(label:string,t:TxResult)=>{push('receipt',label,t.status==='success'?'ok':'reverted',`${t.status==='success'?'Mined':'Mined revert'} in block ${t.blockNumber}${t.error?`: ${t.error.name}`:''}.`,{tx:brief(t)});return t;};
  const send=async(who:LocalAccount,to:Address,abi:any,method:string,args:any[]=[])=>c.send(who,to,fn(abi,method,args),{onBroadcast:hash=>push('submit','Transaction broadcast','pending','Awaiting the real mined receipt.',{hash})});
  const deploy=async(n:string,args:any[]=[])=>{const a=A as any;const d=await c.deploy(owner,a[n+'Abi'],a[n+'Bytecode'],args);receipt(`Deployed ${n}`,d);return d.address;};
  const read=async(address:Address,abi:any,functionName:string,args:any[]=[])=>c.pub.readContract({address,abi,functionName,args} as any) as any;
  for(const a of [owner,agent,checker,client,vendor,creditor])await (c.pub as any).request({method:'anvil_setBalance',params:[a.address,toHex(parseEther('2'))]});
  push('owner','Confirmed local scenario','ok','Explicit confirmation authorizes this bounded scenario. Fresh valueless test assets and independent development roles; main treasury authority is unchanged.');
  let result:any, finalTx:TxResult|undefined;
  if(name==='execution_bounty'){
    if(!market)throw new Error('Execution market unavailable.');
    const b=await deploy('ExecutionBounty',[market.exec,market.usd]);
    await send(owner,market.usd,A.TestUSDAbi,'faucet');
    await send(owner,market.usd,A.TestUSDAbi,'transfer',[b,U(input.amount)]);
    const p=await planTrade(c.pub,market.exec,market.usd,market.eur,U(input.amount));
    const t=receipt('Execution bounty challenge',await c.sendExpectingRevert(agent,b,fn(A.ExecutionBountyAbi,'claim',[U(input.amount),market.eur,pricesForChain(p.plan.prices),hopsForChain(p.plan.route)]),6_000_000n));
    if(t.error?.name!=='TheoremHolds')throw new Error(`Unexpected challenge result: ${t.error?.name}`);
    if(await read(b,A.ExecutionBountyAbi,'asset')!==market.usd)throw new Error('Bounty asset mismatch');
    const left=await read(market.usd,A.TestUSDAbi,'balanceOf',[b]);
    if(left!==U(input.amount))throw new Error('Bounty pool changed after rejected claim');
    return {outcome:'reverted',summary:`Execution bounty challenge reverted with TheoremHolds. ${input.amount} tUSD remains in the isolated bounty pool.`,steps,tx:brief(t),evidence:json({bounty:b,pool:left,bound:p.onchainBound})};
  }
  const token=await deploy('TestUSD');
  const balance=(who:Address)=>read(token,A.TestUSDAbi,'balanceOf',[who]);
  if(name==='portfolio'||name==='private_portfolio'){
    const escrow=await deploy('ProofEscrow');
    const S=input.volatilities.map((v:number,i:number)=>input.volatilities.map((w:number,j:number)=>i===j?(v/100)**2:0));
    let spec:Hex,solution:Hex,verifier:Address,proofInfo:any,cert:any;
    const universe=keccak256(toHex(`qed-local-custom-${id}`));
    if(name==='portfolio'){
      verifier=await deploy('MinVarianceVerifier');
      const problem={n:S.length,cov:covToWad(S),tol:10n**9n,universe};cert=certify(problem);
      const checked=checkCertificate(problem,cert);if(!checked.ok)throw new Error(checked.violations.join('; '));
      spec=encodeSpec(problem);solution=encodeSolution(cert);
      proofInfo={weights:cert.w,weightScale:WAD,variance:checked.variance,certificate:checked};
      push('plan','Portfolio certificate constructed','ok','Existing solver produced exact-budget weights and a KKT/convexity certificate. Contract verification remains required.',proofInfo);
    }else{
      const z=await import('./engine/privateMinvar.js');
      const groth=await deploy('Groth16Verifier');verifier=await deploy('PrivateMinVarianceVerifier',[groth,vendor.address]);
      const cov=z.covToFixed(S),saltData=z.randomSalt(),saltW=z.randomSalt();
      const dataCommitment=await z.commitData({cov,salt:saltData});
      const vendorSig=await vendor.signMessage({message:{raw:z.attestationDigest(31337n,dataCommitment,universe)}});
      cert=z.certifyFixed(cov);const checked=z.checkWitness({cov,...cert});if(!checked.ok)throw new Error(checked.violations.join('; '));
      push('plan','Generating Groth16 proof','pending','Real local proving is running. Synthetic model and private weights will not enter transaction calldata.');
      const proof=await z.prove({cov,saltData,...cert,saltW,dataCommitment,provider:BigInt(agent.address)});
      spec=z.encodePrivateSpec({dataCommitment,universe,provider:agent.address,vendorSig});
      solution=z.encodePrivateSolution(proof.calldata,proof.signals.weightsCommitment,proof.signals.variance);
      proofInfo={dataCommitment,weightsCommitment:proof.signals.weightsCommitment,variance:proof.signals.variance,provingMs:proof.provingMs,private:true};
      push('plan','Groth16 proof generated','ok','Provider-bound proof and vendor attestation prepared. On-chain verifier will decide acceptance.',proofInfo);
    }
    const price=U(input.price),now=BigInt(Math.max(Number((await c.pub.getBlock()).timestamp),Math.floor(Date.now()/1000)));
    const quote={provider:agent.address,payee:agent.address,client:client.address,token,price,verifier,specHash:keccak256(spec),deliverBy:now+3600n,validUntil:now+1800n,quoteId:keccak256(toHex(id))};
    const sig=await signQuote(agent,31337,escrow,quote);
    await send(client,token,A.TestUSDAbi,'faucet');await send(client,token,A.TestUSDAbi,'approve',[escrow,price]);
    const before=await balance(client.address);
    const open=receipt('Client funded signed escrow quote',await send(client,escrow,A.ProofEscrowAbi,'open',[quote,sig]));
    const jobId=(open.events.find(e=>e.name==='JobOpened')!.args as any).jobId;
    const bad=receipt('Wrong-provider delivery rejected',await c.sendExpectingRevert(vendor,escrow,fn(A.ProofEscrowAbi,'deliver',[jobId,spec,solution]),4_000_000n));
    if(bad.error?.name!=='NotProvider')throw new Error('Unexpected escrow authorization result');
    finalTx=receipt('Verified delivery settled escrow',await send(agent,escrow,A.ProofEscrowAbi,'deliver',[jobId,spec,solution]));
    const after=await balance(client.address),providerBalance=await balance(agent.address),escrowBalance=await balance(escrow);
    if(BigInt(before)-BigInt(after)!==price||providerBalance!==price||escrowBalance!==0n)throw new Error('Escrow balance reconciliation failed; inspect mined receipts before retrying.');
    const job=await read(escrow,A.ProofEscrowAbi,'getJob',[jobId]);if(Number(job.status)!==2)throw new Error('Escrow job did not settle');
    result={token,escrow,verifier,jobId,price,before,after,providerBalance,escrowBalance,...proofInfo};
    if(name==='portfolio'){
      const bounty=await deploy('OptimalityBounty',[verifier,token]);
      await send(owner,token,A.TestUSDAbi,'faucet');await send(owner,token,A.TestUSDAbi,'transfer',[bounty,U('10')]);
      const challenge=receipt('Optimality bounty: certified optimum cannot refute itself',await c.sendExpectingRevert(client,bounty,fn(A.OptimalityBountyAbi,'claim',[spec,solution,cert.w]),5_000_000n));
      if(challenge.error?.name!=='TheoremHolds')throw new Error('Unexpected optimality challenge result');
      result.bounty={address:bounty,tx:brief(challenge),pool:await balance(bounty)};
    }
    push('reconcile','Escrow balances reconciled','ok',`${input.price} tUSD moved from the isolated client to the provider only after proof acceptance. Escrow holds zero.`,result);
  }else if(name==='clearing'){
    const clearing=await deploy('QEDClearing',[token]);
    const members=input.members.map((_:string,i:number)=>role(`member-${i}`));
    for(const m of members){await (c.pub as any).request({method:'anvil_setBalance',params:[m.address,toHex(parseEther('2'))]});receipt('Member consent recorded',await send(m,clearing,A.QEDClearingAbi,'join'));}
    const obs=input.obligations.map((o:any,i:number)=>({id:BigInt(i+1),debtor:input.members.indexOf(o.from),creditor:input.members.indexOf(o.to),amount:U(o.amount)}));
    const due=BigInt(Math.floor(Date.now()/1000)+86400);
    for(const o of obs)receipt('Debtor recorded its own obligation',await send(members[o.debtor],clearing,A.QEDClearingAbi,'issue',[members[o.creditor].address,o.amount,due,keccak256(toHex(id+o.id))]));
    const proof=solveNetting(members.length,obs),check=checkNetting(members.length,obs,proof);if(!check.ok)throw new Error(check.violations.join('; '));
    const pos=netPositions(members.length,obs),before=await read(clearing,A.QEDClearingAbi,'positions');
    // Mint only each debtor's net debit; no fictitious aggregate settlement liquidity.
    for(let i=0;i<members.length;i++)if(pos[i]<0n){await send(owner,token,A.TestUSDAbi,'mint',[members[i].address,-pos[i]]);}
    for(const m of members)await send(m,token,A.TestUSDAbi,'approve',[clearing,obs.reduce((s:bigint,o:any)=>s+o.amount,0n)]);
    if(proof.cleared>0n){
      finalTx=receipt('Certified maximal netting executed',await send(agent,clearing,A.QEDClearingAbi,'net',[{ids:obs.map((o:any)=>o.id),amounts:obs.map((o:any)=>o.amount),x:proof.x,potential:proof.potential,y:proof.y}]));
      const after=await read(clearing,A.QEDClearingAbi,'positions');
      for(let i=0;i<members.length;i++)if(BigInt(before[1][i])-BigInt(before[2][i])!==BigInt(after[1][i])-BigInt(after[2][i]))throw new Error('Net positions changed');
      const bounty=await deploy('MaximalityBounty',[token]);await send(owner,token,A.TestUSDAbi,'mint',[bounty,U('10')]);
      const econ={members:BigInt(members.length),debtor:obs.map((o:any)=>BigInt(o.debtor)),creditor:obs.map((o:any)=>BigInt(o.creditor)),d:obs.map((o:any)=>o.amount)};
      const t=receipt('Maximality bounty challenge',await c.sendExpectingRevert(client,bounty,fn(A.MaximalityBountyAbi,'claim',[econ,{x:proof.x,potential:proof.potential,y:proof.y},proof.x]),5_000_000n));
      if(t.error?.name!=='TheoremHolds')throw new Error('Unexpected maximality challenge result');
    }else push('plan','No cycle to cancel','info','This graph has zero cancellable circulation. No netting transaction is claimed; settle the outstanding debts instead.');
    const remaining=obs.map((o:any,i:number)=>o.amount-proof.x[i]);
    for(const i of settlementOrder(members.length,obs,remaining))finalTx=receipt('Residual obligation paid',await send(members[obs[i].debtor],clearing,A.QEDClearingAbi,'pay',[obs[i].id]));
    const open=await read(clearing,A.QEDClearingAbi,'openCount'),balances=await Promise.all(members.map((m:LocalAccount)=>balance(m.address)));
    if(open!==0n||balances.some((b:bigint,i:number)=>b!==(pos[i]>0n?pos[i]:0n)))throw new Error('Clearing final balances did not reconcile');
    result={token,clearing,members:input.members,memberAddresses:members.map((m:LocalAccount)=>m.address),gross:obs.reduce((s:bigint,o:any)=>s+o.amount,0n),cleared:proof.cleared,bound:proof.bound,netPositions:pos,balances,open,proof};
    push('reconcile','Every obligation settled','ok','Net positions preserved exactly; final member balances match their net credits; no open obligations remain.',result);
  }else if(name==='payment'||name==='liability'){
    const amount=U(input.amount),vault=await deploy('QEDVault',[token,owner.address,agent.address,checker.address,owner.address,U('25')]);
    const lens=await deploy('QEDLens');await send(owner,token,A.TestUSDAbi,'mint',[vault,U('100')]);
    const now=BigInt(Math.max(Math.floor(Date.now()/1000),Number((await c.pub.getBlock()).timestamp)));
    if(name==='payment'){
      const escrow=await deploy('ProofEscrow');
      const mandate:Mandate={vault,agent:agent.address,payees:[creditor.address],maxPerPayment:U('10'),maxPerPeriod:U('25'),period:86400n,maxTotal:U('25'),validFrom:now-60n,validUntil:now+3600n,epoch:0n,requireCosign:true,purpose:keccak256(toHex('Confirmed isolated CloudCo payment')),salt:keccak256(toHex(id))};
      const ownerSig=await signMandate(owner,31337,mandate),nonce=id;
      const instructionSig=await owner.signMessage({message:ownerInstructionMessage(vault,creditor.address,amount,undefined,nonce)});
      const engine=new PolicyEngine(c,checker,{vault,lens,escrow,owner:owner.address,vendorKeys:{},catalogPrices:{},denylist:[],deployBlock:0n,recordsDir});
      const checked=await engine.evaluate({kind:'owner-instructed',mandate,ownerSig,payee:creditor.address,amount,instruction:`Pay CloudCo ${input.amount} tUSD`,nonce,instructionSig});
      push('cosigner','Independent payment policy','info',checked.approved?'Co-signer re-read chain state and approved exact terms.':checked.reasons.join('; '),{checks:checked.checks});
      if(!checked.approved)return {outcome:'refused',summary:checked.reasons.join('; '),steps};
      finalTx=receipt('Delegated payment settled',await send(agent,vault,A.QEDVaultAbi,'executePayment',[mandate,ownerSig,checked.certificate,checked.signature]));
      const replay=receipt('Payment replay rejected',await c.sendExpectingRevert(agent,vault,fn(A.QEDVaultAbi,'executePayment',[mandate,ownerSig,checked.certificate,checked.signature]),3_000_000n));
      result={vault,token,cosignerChecks:checked.checks,replay:brief(replay)};
    }else{
      const ring=receipt('Owner protected creditor funds',await send(owner,vault,A.QEDVaultAbi,'ringFence',[creditor.address,amount,now+3n,keccak256(toHex(id))]));
      const free=await read(vault,A.QEDVaultAbi,'freeBalance');if(free!==U('100')-amount)throw new Error('Protected balance mismatch');
      const denied=receipt('Agent cannot release creditor funds',await c.sendExpectingRevert(agent,vault,fn(A.QEDVaultAbi,'release',[1n]),2_000_000n));
      if(denied.error?.name!=='NotCreditor')throw new Error('Unexpected creditor protection result');
      receipt('Owner paused the isolated agent',await send(owner,vault,A.QEDVaultAbi,'pause'));
      await new Promise(r=>setTimeout(r,Math.max(0,Number(now+3n)*1000-Date.now()+150)));
      await (c.pub as any).request({method:'evm_mine',params:[]});
      finalTx=receipt('Creditor settled while agent paused',await send(client,vault,A.QEDVaultAbi,'settle',[1n]));
      result={vault,token,ringFence:brief(ring),protectedBefore:amount,freeBefore:free,paused:true};
    }
    const vaultBalance=await balance(vault),creditorBalance=await balance(creditor.address);
    if(vaultBalance!==U('100')-amount||creditorBalance!==amount)throw new Error('Payment balance reconciliation failed');
    result={...result,vaultBalance,creditorBalance};
    push('reconcile','Payment balances reconciled','ok',`${input.amount} tUSD reached only the approved creditor. Remaining isolated vault balance reconciled.`,result);
  }else throw new Error('Unsupported scenario');
  return {outcome:'executed',summary:`${name.replaceAll('_',' ')} completed on local Anvil. Real receipts and reconciled balances are attached; main treasury balance is unchanged.`,steps,tx:finalTx?brief(finalTx):undefined,evidence:json(result)};
}
