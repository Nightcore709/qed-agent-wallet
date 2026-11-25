import { Check, Copy, Download } from 'lucide-react'
import { useState } from 'react'
import { Btn } from './kit.tsx'

/**
 * The account's saved recovery codes, shown once (R14; review F1): they are made with the first device, and this is the
 * one place every screen that shows them uses. Copy, Download and Continue; no confirmation box. One plain line on why
 * they matter: a person with two devices needs a code to settle a dispute between them.
 */
export function SavedCodes({ codes, onContinue, replaced, label = 'Recovery codes' }: { codes: string[]; onContinue?: () => void; replaced?: boolean; label?: string }) {
  const [copied, setCopied] = useState(false)
  const download = () => {
    const blob = new Blob([`QED recovery codes, made ${new Date().toISOString().slice(0, 10)}. Each works once.\n\n${codes.join('\n')}\n`], { type: 'text/plain' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'qed-recovery-codes.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }
  return (
    <div className="stack" style={{ ['--gap' as string]: '10px' }} role="group" aria-label="Your saved recovery codes">
      <p className="small muted">Your saved recovery codes, shown only now. They settle a dispute between two of your devices, so keep them somewhere other than this device. Each works once, and no code gets anyone in by itself.</p>
      {replaced ? <p className="small muted">Codes made earlier no longer work: only this set does.</p> : null}
      <ol className="codes" aria-label={label}>{codes.map((c) => <li key={c} className="code">{c}</li>)}</ol>
      <div className="row">
        <Btn onClick={() => void navigator.clipboard?.writeText(codes.join('\n')).then(() => setCopied(true)).catch(() => {})}>{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}{copied ? 'Copied' : 'Copy them'}</Btn>
        <Btn onClick={download}><Download aria-hidden="true" />Download as a text file</Btn>
        {onContinue ? <Btn tone="fill" onClick={onContinue}>Continue</Btn> : null}
      </div>
    </div>
  )
}
