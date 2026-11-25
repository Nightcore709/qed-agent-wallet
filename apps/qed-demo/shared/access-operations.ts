/**
 * Account access is five separate operations, never interchangeable (R14, Priority 1; the owner's words):
 *
 *   1. enter           creating and entering an application account
 *   2. enrol-device    enrolling a device for convenient sign-in
 *   3. approve         cryptographically approving a protected financial action
 *   4. recover-access  recovering account access
 *   5. recover-wallet  recovering actual authority over the wallet
 *
 * This module is the one statement of that rule that both the server and the screens read. GRANTS says, for each proof a
 * person can present, what it does for each operation BY ITSELF: 'yes', 'no', or 'limited' with the limit in words. The
 * server enforces every cell where the operation happens (the file named beside it); shared/access-operations.test.ts
 * holds the cells the owner fixed: a password, Google, an email code or a signed-in session never approves money and
 * never becomes authority over the wallet.
 *
 * Where each is enforced:
 *   enter            server/auth.ts login, server/access.ts signUpWithEmail and loginWithEmail, server/google.ts,
 *                    server/passkeys.ts finishLogin
 *   enrol-device     server/passkeys.ts beginAddPasskey and finishAddPasskey
 *   approve          server/api.ts POST /api/approvals/:id/passkey and /confirm (a passkey assertion over the hash of the
 *                    exact terms: passkeys.ts approvalChallenge); there is no password, Google or email path to it
 *   recover-access   server/recovery.ts (password reset, recovery by email), server/passkeys.ts startRecovery (saved codes)
 *   recover-wallet   server/recovery.ts requestAuthority (a recovered device asks, waits, can be stopped);
 *                    server/rail-signers.ts (the on-chain wallet's own signers, recovery key, guardian and time-lock)
 */

export type OperationId = 'enter' | 'enrol-device' | 'approve' | 'recover-access' | 'recover-wallet'
export type ProofId = 'password' | 'google' | 'email-code' | 'session' | 'saved-code' | 'recovered-device' | 'device'
export type Grant = 'yes' | 'limited' | 'no'

export interface Operation { id: OperationId; title: string; plain: string }
export interface Proof { id: ProofId; title: string }

/** The five operations, in the owner's order, in the words the screens use. */
export const OPERATIONS: readonly Operation[] = [
  { id: 'enter', title: 'Signing in',
    plain: 'Your email and password, Google where it is offered, or your device. Signing in lets you look and prepare. It approves nothing.' },
  { id: 'enrol-device', title: 'Setting up a device',
    plain: 'Your fingerprint, Face ID or device PIN, for faster, more secure access. The first device is set up after you sign in; each further one is confirmed from a device you already use.' },
  { id: 'approve', title: 'Approving money',
    plain: 'Always on your device. Its check signs the exact terms you see, and that signature is what QED and the wallet verify. A password, Google, an email code or being signed in never approves.' },
  { id: 'recover-access', title: 'Getting back in',
    plain: 'A forgotten password is reset through your verified email. With every device lost, your email and one more proof start a recovery that waits, tells every device and contact of yours, and can be stopped.' },
  { id: 'recover-wallet', title: 'Getting back authority over your wallet',
    plain: 'Separate from getting back in. A device added by a recovery signs in only; it approves again after a further wait that your other devices or your recovery contact can stop. The on-chain wallet changes its signers only under its own rules.' },
]

/** What a person can present. 'device' is a passkey with approval authority; 'recovered-device' one that signs in only. */
export const PROOFS: readonly Proof[] = [
  { id: 'password', title: 'Password' },
  { id: 'google', title: 'Google' },
  { id: 'email-code', title: 'A link or code sent to your email' },
  { id: 'session', title: 'Being signed in already' },
  { id: 'saved-code', title: 'A saved recovery code' },
  { id: 'recovered-device', title: 'A device added by a recovery' },
  { id: 'device', title: 'Your device (fingerprint, Face ID or PIN)' },
]

/** The proofs of an ordinary sign-in and what follows from one: the ones that must never approve or take the wallet. */
export const ORDINARY_PROOFS = ['password', 'google', 'email-code', 'session'] as const satisfies readonly ProofId[]

type Cell = { grant: Grant; limit?: string }
const yes: Cell = { grant: 'yes' }, no: Cell = { grant: 'no' }
const limited = (limit: string): Cell => ({ grant: 'limited', limit })
const FIRST_ONLY = 'Only the account\'s first device, and only when the password is typed again in the last five minutes.'
const FIRST_GOOGLE = 'Only the first device of an account with no password, and only when Google is confirmed again in the last five minutes. An account with a password needs the password.'
const ONE_PART = 'One of the two proofs a recovery needs. Never enough alone, and the recovery then waits and can be stopped.'

export const GRANTS: Readonly<Record<ProofId, Readonly<Record<OperationId, Cell>>>> = {
  'password': { 'enter': yes, 'enrol-device': limited(FIRST_ONLY), 'approve': no, 'recover-access': limited(ONE_PART), 'recover-wallet': no },
  'google': { 'enter': yes, 'enrol-device': limited(FIRST_GOOGLE), 'approve': no, 'recover-access': no, 'recover-wallet': no },
  'email-code': { 'enter': no, 'enrol-device': no, 'approve': no, 'recover-access': limited('Resets a forgotten password only on an account with no device that approves. For a recovery it is one of two proofs.'), 'recover-wallet': no },
  'session': { 'enter': yes, 'enrol-device': no, 'approve': no, 'recover-access': no, 'recover-wallet': no },
  'saved-code': { 'enter': no, 'enrol-device': no, 'approve': no, 'recover-access': limited(ONE_PART), 'recover-wallet': no },
  'recovered-device': { 'enter': yes, 'enrol-device': no, 'approve': no, 'recover-access': no, 'recover-wallet': limited('It asks for approval authority, which is given after a wait unless another device or a recovery contact stops it.') },
  'device': { 'enter': yes, 'enrol-device': limited('A device added beside another is limited for its first 24 hours.'), 'approve': yes, 'recover-access': limited('It cancels a recovery, and suspends another device with a saved code.'), 'recover-wallet': limited('Under the wallet\'s own rules: its signers, recovery key, guardian and time-lock.') },
}

export const can = (proof: ProofId, operation: OperationId): Grant => GRANTS[proof][operation].grant
export const operationWords = (id: OperationId): Operation => OPERATIONS.find((o) => o.id === id)!

/** One sentence for the sign-in page and every place an ordinary sign-in is offered. */
export const ORDINARY_SIGN_IN_LIMIT = 'Signing in lets you look and set things up. Moving money is approved on your device, with your fingerprint, Face ID or device PIN.'

/** The owner's sentence for the step after an account is opened (R14), and what QED says where a device has no such check. */
export const ENROL_WORDS = 'Use your fingerprint, Face ID or device PIN for faster, more secure access.'
export const DEVICE_SIGN_IN = 'Sign in with your fingerprint, Face ID or device PIN'
export const NO_DEVICE_CHECK = 'This device has no fingerprint, face or PIN check that QED can use. You can use a phone nearby, or a security key, instead.'
export const NO_PASSKEYS_AT_ALL = 'This browser cannot set up a device for QED. Open QED in a current Safari, Chrome, Edge or Firefox to use your fingerprint, Face ID or device PIN. Until then you sign in with your email and password.'
