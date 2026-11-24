/** Bounded tool schemas. Model output is untrusted until normalized here. */
import { scanAmount, formatMicro } from './amount-lexing.mjs';
const amountSchema={type:'string',pattern:'^[0-9]+(\\.[0-9]{1,6})?$',description:'Exact positive token amount, at most six decimal places; no rounding.'};
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const vols={type:'array',items:{type:'number',minimum:1,maximum:100},minItems:2,maxItems:6,description:'Synthetic annual volatilities in percent; covariance is diagonal (zero correlations).'};
export const CAPABILITIES=Object.freeze({
  quote_conversion:{label:'Read-only conversion quote',mode:'read',schema:object({amount:amountSchema})},
  convert:{label:'Certified tUSD → tEUR conversion',mode:'treasury',schema:object({amount:amountSchema})},
  policy_tick:{label:'Run the signed treasury policy once',mode:'treasury',schema:object({})},
  portfolio:{label:'Custom portfolio & paid-work escrow',mode:'scenario',schema:object({price:amountSchema,volatilities:vols})},
  private_portfolio:{label:'Private portfolio & Groth16 escrow',mode:'scenario',schema:object({price:amountSchema,volatilities:{...vols,minItems:6,maxItems:6}})},
  clearing:{label:'Custom certified debt clearing',mode:'scenario',schema:object({members:{type:'array',items:{type:'string'},minItems:2,maxItems:6},obligations:{type:'array',minItems:1,maxItems:16,items:object({from:{type:'string'},to:{type:'string'},amount:amountSchema})}})},
  payment:{label:'Delegated payment to CloudCo',mode:'scenario',schema:object({amount:amountSchema})},
  liability:{label:'Protect and settle a CloudCo liability',mode:'scenario',schema:object({amount:amountSchema})},
  execution_bounty:{label:'Challenge the execution upper bound',mode:'scenario',schema:object({amount:amountSchema})},
});
export const MODEL_TOOLS=Object.entries(CAPABILITIES).map(([name,c])=>({name,description:`${c.label}. ${c.mode==='read'?'Read only; no signing.':c.mode==='scenario'?'Propose a NEW isolated scenario with fresh valueless tokens; does not spend the main treasury. User must explicitly confirm.':'Propose only; signed limits and explicit user confirmation required.'}`,input_schema:c.schema}));
function money(value,max,label){
  if(typeof value!=='string'||!/^\d+(?:\.\d{1,6})?$/.test(value))throw new Error(`${label}: use an exact positive decimal string with at most six decimal places.`);
  const parsed=scanAmount(value);
  if(parsed.kind!=='valid'||parsed.raw<=0n||parsed.raw>max)throw new Error(`${label} must be greater than zero and at most ${formatMicro(max)}.`);
  const [whole,fraction='']=value.split('.');
  return BigInt(whole).toString()+(fraction.replace(/0+$/,'')?'.'+fraction.replace(/0+$/,''):'');
}
export function validateCapability(name,input){
  const c=CAPABILITIES[name];
  if(!c)throw new Error('Unsupported capability. No arbitrary scripts, destinations or RPC endpoints are accepted.');
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Tool input must be an object.');
  const fields=Object.keys(c.schema.properties);
  if(Object.keys(input).some(k=>!fields.includes(k))||fields.some(k=>!Object.hasOwn(input,k)))throw new Error('Supply exactly the required tool fields.');
  if(name==='policy_tick')return {};
  if(name==='portfolio'||name==='private_portfolio'){
    const v=input.volatilities;
    if(!Array.isArray(v)||v.length<2||v.length>6||(name==='private_portfolio'&&v.length!==6)||v.some(n=>typeof n!=='number'||!Number.isFinite(n)||n<1||n>100))throw new Error('Use 2–6 annual volatilities between 1 and 100 percent; the private circuit requires exactly six.');
    return {price:money(input.price,25_000_000n,'Escrow price'),volatilities:[...v]};
  }
  if(name==='clearing'){
    const m=input.members,o=input.obligations;
    if(!Array.isArray(m)||m.length<2||m.length>6||m.some(x=>typeof x!=='string'||!/^[A-Za-z][A-Za-z0-9 _-]{0,23}$/.test(x))||new Set(m.map(x=>x.toLowerCase())).size!==m.length)throw new Error('Use 2–6 distinct member labels, up to 24 letters, digits or spaces.');
    if(!Array.isArray(o)||!o.length||o.length>16)throw new Error('Use 1–16 obligations.');
    return {members:[...m],obligations:o.map(e=>{
      if(!e||typeof e!=='object'||Object.keys(e).sort().join(',')!=='amount,from,to'||!m.includes(e.from)||!m.includes(e.to)||e.from===e.to)throw new Error('Every debt must name two different members from the member list.');
      return {from:e.from,to:e.to,amount:money(e.amount,1_000_000_000n,'Debt')};
    })};
  }
  const cap=name==='payment'?10_000_000n:name==='liability'?95_000_000n:name==='execution_bounty'?25_000_000n:10n**66n;
  return {amount:money(input.amount,cap,'Amount')};
}
export function describeCapability(name,input){
  const p=validateCapability(name,input), c=CAPABILITIES[name];
  if(name==='portfolio'||name==='private_portfolio')return `${c.label}: ${p.price} tUSD escrow; ${p.volatilities.length} synthetic assets, annual volatilities ${p.volatilities.join(', ')}%; zero correlations. ${name==='private_portfolio'?'Six-asset circuit; model and weights remain off-chain.':''}`;
  if(name==='clearing')return `${c.label}: ${p.members.join(', ')}. ${p.obligations.map(o=>`${o.from} → ${o.to}: ${o.amount} tUSD`).join('; ')}.`;
  return c.label+(p.amount?`: ${p.amount} tUSD.`:'.');
}
