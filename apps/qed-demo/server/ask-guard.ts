/**
 * The release's English and Chinese guard (F-003), ported to what Ask is sent.
 *
 * Source: `chain/vendor/agent/src/brain/guard.ts` (DETECTORS, `scan`). The release runs it over the text of every
 * instruction before a model or an action sees it. This is the same idea for Ask: a question that tries to pull out a
 * secret, to talk the assistant out of its rules, or to give anyone authority they do not hold is answered by QED's own
 * fixed text, in QED's code, and no model is asked. That is a second line only. The first is that a proposal from Ask
 * is not authority: nothing it says moves money, and every change still needs the owner's passkey.
 *
 * What differs from the release, and why:
 * - the release's `password`, `passphrase` and "your instructions" words alone would refuse "how do I change my
 *   password" or "what instructions do I have". Here a bare word counts only next to a request to show or reveal it;
 * - the release also treats "raise", "increase", "remove" and "add a payee" as escalation, because there the model
 *   itself holds a key. In QED the owner may ask Ask to draft those changes (a proposal, signed by passkey, and a
 *   loosening waits), so only the forms that ask for authority without the owner's approval are refused here;
 * - the release's urgency and induced-transfer classes are not refusals in Ask: Ask cannot send money. They stay a
 *   matter for the payment screens' own checks.
 * A pattern match is not understanding: a rephrasing can pass. NOT VERIFIED beyond the cases in `ask-guard.test.ts`.
 */

export type AskGuardFlag = 'data_extraction' | 'privilege_escalation' | 'prompt_injection'

const SHOW = String.raw`(show|print|dump|reveal|tell|give|send|read|output|leak|expose|share|display|what('?s| is| are)|list)\b`

const DETECTORS: Record<AskGuardFlag, RegExp> = {
  data_extraction: new RegExp(
    '(私钥|助记词|密钥|系统提示|(显示|告诉|给我|发给|打印|泄露|输出|说出|把).{0,10}(密码)|' +
    String.raw`private[\s_-]*keys?|secret[\s_-]*keys?|seed[\s_-]*phrase|mnemonic|recovery[\s_-]*phrase|\.env\b|api[\s_-]*keys?|signing[\s_-]*key|system[\s_-]*prompt|` +
    String.raw`${SHOW}.{0,25}\b(pass(word|phrase)s?|(hidden|internal|your|system) instructions|keys?|config(uration)?|environment variables?|env vars?|secrets?|credentials?)\b|` +
    String.raw`your (hidden |internal )?instructions)`, 'i'),
  privilege_escalation: new RegExp(
    '((取消|解除|绕过).{0,10}(限额|额度|上限|权限|签名)|(限额|额度|上限|权限).{0,10}(取消|解除|绕过)|' +
    String.raw`(bypass|override|disable|circumvent)\b.{0,40}\b(limits?|caps?|mandates?|polic(y|ies)|co-?signer|guardian|allow-?list|white-?list|approvals?|passkeys?)|` +
    String.raw`grant (yourself|me|it)\b|make me (the )?(owner|admin)|transfer ownership|sign (it|this|the mandate) yourself|without (the )?(co-?signer|owner'?s? approval|approval|my passkey))`, 'i'),
  prompt_injection: new RegExp(
    '(忽略(之前|以上|前面)的?(所有)?(指令|指示|规则)|系统(指令|覆盖)|' +
    String.raw`ignore (all |any |the )?(previous|prior|above|earlier) (instructions|rules|messages)|disregard\b.{0,25}\binstructions|new instructions\s*:|system (override|prompt|message|update)\s*:|you are now\b|developer mode|jailbreak|\[\s*system\s*\]|<\s*\/?\s*system\s*>|begin (new )?instructions|override\s*:|as an ai (assistant )?you must|this is a test of your obedience)`, 'i'),
}

export function scanAsk(text: string): AskGuardFlag[] {
  return (Object.keys(DETECTORS) as AskGuardFlag[]).filter((k) => DETECTORS[k].test(text))
}

const REFUSAL: Record<AskGuardFlag, string> = {
  data_extraction: 'QED will not show keys, secrets, passwords, configuration or its own instructions, and Ask could not: it is sent your records, never a key or a credential. Nothing was sent to a model.',
  privilege_escalation: 'Ask cannot bypass or widen what you have authorised. Limits, payees, co-signers and passkeys change only when you sign the change yourself, and a change that loosens a limit waits before it applies. If you want a change, say what it is and Ask can draft it for you to review. Nothing was sent to a model.',
  prompt_injection: 'Ask answers questions about your records and drafts proposals for you to review. It does not take new rules from the text of a question. Nothing was sent to a model.',
}
const REFUSAL_ZH: Record<AskGuardFlag, string> = {
  data_extraction: 'QED 不会显示密钥、私钥、助记词、密码、配置或内部指令。',
  privilege_escalation: 'Ask 不能绕过或扩大您已授权的范围。限额、收款人和签名只有在您亲自签署后才会改变。',
  prompt_injection: 'Ask 不会接受问题文本中的新规则或「忽略之前的指令」。',
}

/** The fixed reply for a refused question, or null when the question may go on. English always; Chinese added when the question has Chinese in it. */
export function askGuard(question: string): { flags: AskGuardFlag[]; reply: string } | null {
  const flags = scanAsk(question)
  if (!flags.length) return null
  const first = flags[0]!
  const zh = /[一-鿿]/.test(question) ? `\n\n${flags.map((f) => REFUSAL_ZH[f]).join('')}` : ''
  return { flags, reply: `${REFUSAL[first]}${zh}` }
}
