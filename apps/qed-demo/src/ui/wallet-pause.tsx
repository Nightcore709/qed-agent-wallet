/**
 * The pause sheet's "Also pause the on-chain wallet" (R12 task comparison, gap 2 and T6-c). Pausing QED stops what it
 * does on its own; the wallet's mandate stays in force on the chain until the wallet itself is paused. Once QED is
 * paused, this proposes the wallet's own pause and opens its exact terms for the passkey to sign, as "Pause the wallet"
 * does under On-chain wallet; the record of the pause on the chain opens when it is sent. Closing the terms unsigned,
 * or a refusal, is handed back (`onClosed`), and the pause sheet says the wallet was not paused. Loaded only when asked
 * for: it brings the wallet page's code.
 */
import { useEffect, useRef } from 'react'
import type { ApiError } from '../lib/core.ts'
import { useVaultApproval } from '../screens/Vault.tsx'

export function WalletPauseNow({ onClosed }: { onClosed: (sent: boolean, error?: ApiError) => void }) {
  const v = useVaultApproval({ onClosed })
  const asked = useRef(false)
  useEffect(() => {
    if (asked.current) return
    asked.current = true
    void v.start('/api/vault/proposals', { kind: 'pause', params: {} }, {
      title: 'Pause the on-chain wallet too',
      intro: <p>QED is paused. While the wallet is paused too, its contract refuses every payment QED would make from it, even with QED&apos;s own keys. Someone you promised money can still collect what is set aside for them. Resuming QED does not resume the wallet: you resume it under On-chain wallet.</p>,
    })
  }, [v])
  // the vault would not prepare the terms (its service not answering, the wallet already paused): handed back to say
  useEffect(() => { if (v.error) onClosed(false, v.error) }, [v.error, onClosed])
  return <>{v.sheet}</>
}
