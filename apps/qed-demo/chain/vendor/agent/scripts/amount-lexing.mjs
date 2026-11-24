/**
 * Exact, dependency-free parsing of a user's monetary number in the disposable
 * tUSD sandbox. Never guess a different amount from a malformed number.
 *
 * Accept: 10, 22.5, 0.000001, $10, 1,000, 10tUSD.
 * Reject rather than reinterpret: .5, 1e2, 1_000, 0x10, 1.2345678,
 * misplaced separators, explicit signs, or multiple numeric values.
 * Word-only amounts may still go to the AI, but its output is independently
 * subject to the chain limits and the owner's final confirmation.
 */
export function hasUnsafeSignedAmount(text) {
  return /(?:^|[^\p{L}\p{N}_])[-+\u2212\u2013\u2014]\s*(?:\$\s*)?(?:\d|\.\d)/u.test(text);
}

/** @returns {{kind:'valid',raw:bigint,text:string}|{kind:'none'|'invalid'|'ambiguous',reason:string}} */
export function scanAmount(text) {
  if (typeof text !== 'string') return {kind:'invalid',reason:'A text instruction is required.'};
  if (hasUnsafeSignedAmount(text)) return {kind:'invalid',reason:'Explicitly signed amounts are not permitted.'};
  // Consume complete numeric-looking tokens so that malformed formats never
  // match a smaller valid substring (e.g. .5 -> 5 or 1e2 -> 1).
  // Wallet addresses and transaction hashes are identifiers, not financial amounts.
  const withoutIdentifiers=text.replace(/\b0x(?:[0-9a-f]{40}|[0-9a-f]{64})\b/gi,'');
  const tokens = [...withoutIdentifiers.matchAll(/(?<![\p{L}\p{N}_])(?:\$\s*)?(?:\.\d[\d.,_a-zA-Z]*|\d[\d.,_a-zA-Z]*)/gu)].map(m => m[0]);
  if (!tokens.length) return {kind:'none',reason:'No numeric amount found.'};
  if (tokens.length !== 1) return {kind:'ambiguous',reason:'Specify exactly one numeric amount.'};
  let token=tokens[0].replace(/^\$\s*/, '');
  token=token.replace(/(?:t?usd|dollars?)$/i,'');
  // Commas are allowed only in standard groups of three; decimals max six
  // places because the token contract uses six decimals.
  const canonical=/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,6})?$/;
  if (!canonical.test(token)) return {kind:'invalid',reason:'Use a positive standard decimal with at most six fractional digits (such as 0.5 tUSD).'};
  const normalized=token.replaceAll(',','');
  const [whole,fraction='']=normalized.split('.');
  // Preserve arbitrarily chosen realistic amounts without truncation; financial
  // authorization will refuse values exceeding the signed mandate. The bound
  // prevents pathological payload sizes and stays below uint256 (6 decimals).
  if(whole.length>60)return {kind:'invalid',reason:'Amount exceeds the supported token integer range.'};
  const raw=BigInt(whole)*1_000_000n+BigInt(fraction.padEnd(6,'0'));
  return {kind:'valid',raw,text:normalized};
}

/** Render exact 6-decimal token micro-units without IEEE-754 precision loss. */
export function formatMicro(raw) {
  const value=BigInt(raw);
  const abs=value<0n?-value:value;
  const whole=(abs/1_000_000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g,',');
  const fractional=(abs%1_000_000n).toString().padStart(6,'0').replace(/0+$/,'').padEnd(2,'0');
  return (value<0n?'-':'')+whole+'.'+fractional;
}
