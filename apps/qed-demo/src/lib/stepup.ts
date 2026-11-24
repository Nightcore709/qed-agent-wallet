/**
 * For a change the server makes only after a fresh passkey confirmation: try it, and if the server asks for the passkey,
 * confirm and try once more. Kept here (not only in screens/Protect.tsx, which re-exports the same behaviour) so that
 * Home does not pull the Protect and on-chain wallet screens into the first script a phone downloads.
 */
import { ApiError } from './core.ts'
import { confirmWithPasskey } from './passkey.ts'

export async function withPasskeyIfAsked<T>(call: () => Promise<T>, hasPasskey: boolean | undefined): Promise<T> {
  try { return await call() }
  catch (e) {
    if (!(e instanceof ApiError) || e.code !== 'stepup_required' || hasPasskey === false) throw e
    await confirmWithPasskey()
    return call()
  }
}
