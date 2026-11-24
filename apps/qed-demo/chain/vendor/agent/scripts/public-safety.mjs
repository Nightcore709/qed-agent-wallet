/** Railway/public preview guardrails. These never authorize a transaction.
 * Operations still require exact owner confirmation and on-chain enforcement.
 */
export const HEAVY_PUBLIC_TOOLS = new Set(['portfolio', 'private_portfolio', 'clearing', 'execution_bounty']);
export const PUBLIC_SCRIPT_DEFAULT = 'execution';
export function allowedPublicScript(scenario, configuration = process.env.QED_PUBLIC_SCENARIOS ?? PUBLIC_SCRIPT_DEFAULT) {
  return configuration.split(',').map(x => x.trim()).filter(Boolean).includes(scenario);
}
export class PublicWorkBudget {
  constructor({maxGlobal=8,maxPerIp=2,windowMs=3_600_000}={}) {
    this.maxGlobal=maxGlobal; this.maxPerIp=maxPerIp; this.windowMs=windowMs;
    this.all=[];this.perIp=new Map();
  }
  check(ip, now=Date.now()) {
    this.all=this.all.filter(t=>now-t<this.windowMs);
    const current=(this.perIp.get(ip)||[]).filter(t=>now-t<this.windowMs);
    this.perIp.set(ip,current);
    return this.all.length<this.maxGlobal && current.length<this.maxPerIp;
  }
  consume(ip,now=Date.now()) {
    if(!this.check(ip,now))return false;
    this.all.push(now);this.perIp.get(ip).push(now);return true;
  }
}
