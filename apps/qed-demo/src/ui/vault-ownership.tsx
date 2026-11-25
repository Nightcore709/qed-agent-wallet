/**
 * The Vault screen's ownership and claims (R13, audit item S5; R7-050, R7-097; F-021, F-026; server/ownership.ts).
 * The release's QEDVault can change owner (offered, then accepted: two steps) and lets a creditor forgive or move what a
 * vault set aside for it. Here each is asked for by the other household's handle and approved with the passkey, in the
 * wallet's approval sheet, over the vault service's exact terms. A transfer, a release and an assignment wait the owner
 * account's delay, shown before signing; until it ends any one of the household's passkeys can cancel them, under
 * "Changes waiting out the delay". Accepting a wallet, and setting money aside for another household, take effect at once.
 */
import { useState } from 'react'
import { fmt, useData } from '../lib/core.ts'
import { useVaultApproval } from '../screens/Vault.tsx'
import { Btn, Field, MoneyInput, Note, Problem } from './kit.tsx'

interface Named { name?: string | null; handle: string | null }
interface Mine { which: 'treasury' | 'reserve'; vault: string; ownedByYou: boolean; offeredTo: Named | null; owner: Named | null }
interface Offered { which: 'treasury' | 'reserve'; vault: string; from: Named | null; balance: string }
interface Claim { vault: string; liabilityId: string; debtor: Named | null; amount: string; dueAt: number; status: string; due: boolean; yours: boolean; assignedAway: boolean }
interface OwnView { delaySeconds: number; mine: Mine[]; offeredToYou: Offered[]; ownedHere: Offered[]; claims: Claim[] }

const span = (x: number): string => (x % 86_400 === 0 ? `${x / 86_400} day${x === 86_400 ? '' : 's'}` : x % 3600 === 0 ? `${x / 3600} hour${x === 3600 ? '' : 's'}` : x % 60 === 0 ? `${x / 60} minute${x === 60 ? '' : 's'}` : `${x} seconds`)
const who = (n: Named | null): string => (n?.handle ? `${n.name ? `${n.name} ` : ''}(@${n.handle})` : 'another account')
const WHICH: Record<string, string> = { treasury: 'The treasury (test rupees)', reserve: 'The reserve (test dollars)' }

export function OwnershipPanel({ col }: { col: string }) {
  const v = useData<OwnView>('/api/vault/ownership', ['vault'])
  const va = useVaultApproval({ stay: true, onDone: () => v.reload() })
  const [open, setOpen] = useState<null | 'transfer' | 'promise' | string>(null)
  const [handle, setHandle] = useState('')
  const [amount, setAmount] = useState<number | null>(null)
  const [days, setDays] = useState('30')
  const [assignTo, setAssignTo] = useState<'my-vault' | 'handle'>('my-vault')
  if (!v.data) return <section data-col={col} className="panel vt-own" aria-labelledby="wo-h"><div className="panel-head"><h2 id="wo-h">Ownership, and money owed to you</h2></div>{v.error ? <Problem error={v.error} /> : <p className="small faint">Reading who owns the wallet.</p>}</section>
  const d = v.data
  const delay = span(d.delaySeconds)
  const start = (path: string, body: Record<string, unknown>, title: string, intro: string) => { void va.start(path, body, { title, intro: <p>{intro}</p> }).then(() => v.reload()) }
  const transferred = d.mine.some((m) => !m.ownedByYou)
  const offered = d.mine.find((m) => m.offeredTo)
  const claims = d.claims.filter((c) => c.yours && c.status === 'open')
  return (
    <section data-col={col} className="panel vt-own" aria-labelledby="wo-h">
      <div className="panel-head"><h2 id="wo-h">Ownership, and money owed to you</h2><p>Each change here waits {delay} after your passkey approves it</p></div>
      <p className="vt-panel-say">Until the delay ends, any one of your passkeys can cancel it under "Changes waiting out the delay". After it, the wallet service applies it.</p>

      <h3 className="vt-sub-h">Who owns this wallet</h3>
      <ul className="vt-rows">{d.mine.map((m) => (
        <li key={m.vault}><span className="vt-rn"><b>{WHICH[m.which]}</b><span>{m.ownedByYou ? (m.offeredTo ? `Offered to ${who(m.offeredTo)}: it changes hands only when they accept with their own passkeys` : 'Owned by your passkeys') : `Now owned by ${who(m.owner)}: your passkeys no longer control it`}</span></span></li>
      ))}</ul>
      {transferred ? <Note tone="wait" title="This wallet changed hands">QED refuses every owner action on a vault you no longer own, before anything is signed.</Note> : null}
      {offered ? <p className="small faint">The release's vault has no call that withdraws an offer once it is applied: only another transfer (to nobody) clears it, which waits the same {delay}, during which the offer can still be accepted.</p> : null}
      {!transferred && open !== 'transfer' ? <div><Btn small tone="quiet" onClick={() => { setOpen('transfer'); setHandle('') }}>Transfer this wallet to another household</Btn></div> : null}
      {open === 'transfer' ? (
        <form className="vt-own-form" aria-label="Transfer this wallet" onSubmit={(e) => { e.preventDefault(); start('/api/vault/ownership/transfer', { handle }, 'Approve: offer this wallet to another household', `Both vaults, with everything in them and every owner power over them, are offered to @${handle.replace(/^@/, '')}. Nothing changes for ${delay}; any one of your passkeys can cancel it until then. After that it is an offer: the wallet changes hands only when they accept with their own passkeys, and from then on your passkeys no longer control it.`) }}>
          <Field label="The household's handle" hint="It needs its own on-chain wallet on this QED installation.">{(p) => <input {...p} className="input" autoCapitalize="none" maxLength={40} value={handle} onChange={(e) => setHandle(e.target.value)} />}</Field>
          <div className="vt-own-go"><Btn tone="fill" type="submit" busy={va.busy}>See the terms</Btn><Btn tone="quiet" onClick={() => setOpen(null)}>Not now</Btn></div>
        </form>
      ) : null}

      {d.offeredToYou.length ? <>
        <h3 className="vt-sub-h">Wallets offered to you</h3>
        <ul className="vt-rows">{d.offeredToYou.map((o) => (
          <li key={o.vault}><span className="vt-rn"><b>{WHICH[o.which]} of {who(o.from)}</b><span>Accepting makes your passkeys its owner at once.</span></span>
            <span className="vt-ra"><Btn small busy={va.busy} onClick={() => start('/api/vault/ownership/accept', { vault: o.vault }, 'Approve: accept this wallet', `You become the owner of ${o.which === 'treasury' ? 'the treasury' : 'the reserve'} vault of ${who(o.from)}, at once. Its money stays in the vault, promises to creditors included. QED shows it here; it does not yet manage a second wallet from one household.`)}>Accept it</Btn></span></li>
        ))}</ul>
      </> : null}
      {d.ownedHere.length ? <p className="small">You also own {d.ownedHere.map((o) => `${o.which === 'treasury' ? 'the treasury' : 'the reserve'} vault you accepted from ${who(o.from)}`).join('; ')}. Its money is safe in the vault; managing it from here is not offered yet.</p> : null}

      <h3 className="vt-sub-h">Money other households set aside for you</h3>
      {claims.length === 0 ? <p className="small faint">No other household has set money aside for you.</p> : <ul className="vt-rows">{claims.map((c) => {
        const k = `${c.vault}:${c.liabilityId}`
        return (
          <li key={k}><span className="vt-rn"><b>{fmt.inr(Number(c.amount), true)} from {who(c.debtor)}</b><span>Due {fmt.day(c.dueAt * 1000)}{c.due ? ': anyone can pay it to you now' : ''}. Only you can forgive it or move it.</span></span>
            <span className="vt-ra">
              <Btn small tone="quiet" busy={va.busy} onClick={() => start('/api/vault/claims/release', { vault: c.vault, liabilityId: c.liabilityId }, 'Approve: forgive this money', `${fmt.inr(Number(c.amount), true)} that ${who(c.debtor)} set aside for you goes back to their free money, for good. It waits ${delay}; any one of your passkeys can cancel it until then. If it is paid to you first, the release does nothing.`)}>Forgive it</Btn>
              <Btn small tone="quiet" onClick={() => { setOpen(k); setAssignTo('my-vault'); setHandle('') }}>Move it</Btn>
            </span>
            {open === k ? (
              <form className="vt-own-form" aria-label="Move this claim" onSubmit={(e) => { e.preventDefault(); start('/api/vault/claims/assign', { vault: c.vault, liabilityId: c.liabilityId, to: assignTo === 'my-vault' ? 'my-vault' : handle }, 'Approve: move this claim', `From then on ${assignTo === 'my-vault' ? 'it is paid straight into your treasury vault' : `only @${handle.replace(/^@/, '')} is paid, and only they may forgive or move it`}. It waits ${delay}; any one of your passkeys can cancel it until then.`) }}>
                <div className="seg" role="group" aria-label="Move it to"><button type="button" aria-pressed={assignTo === 'my-vault'} onClick={() => setAssignTo('my-vault')}>Your own treasury vault</button><button type="button" aria-pressed={assignTo === 'handle'} onClick={() => setAssignTo('handle')}>Another household</button></div>
                {assignTo === 'handle' ? <Field label="The household's handle">{(p) => <input {...p} className="input" autoCapitalize="none" maxLength={40} value={handle} onChange={(e) => setHandle(e.target.value)} />}</Field> : null}
                <div className="vt-own-go"><Btn tone="fill" type="submit" busy={va.busy}>See the terms</Btn><Btn tone="quiet" onClick={() => setOpen(null)}>Not now</Btn></div>
              </form>
            ) : null}
          </li>
        )
      })}</ul>}
      {d.claims.some((c) => c.assignedAway) ? <p className="small faint">{d.claims.filter((c) => c.assignedAway).length} claim{d.claims.filter((c) => c.assignedAway).length === 1 ? '' : 's'} you moved elsewhere earlier.</p> : null}

      <h3 className="vt-sub-h">Set money aside for another household</h3>
      {open !== 'promise' ? <div><Btn small tone="quiet" onClick={() => { setOpen('promise'); setHandle(''); setAmount(null) }}>Set money aside for a household</Btn></div> : (
        <form className="vt-own-form" aria-label="Set money aside for another household" onSubmit={(e) => { e.preventDefault(); start('/api/vault/claims/promise', { handle, amount: amount === null ? '' : `${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, '0')}`, dueInDays: Number(days) }, 'Approve: set money aside for them', `From the next block ${amount === null ? 'this amount' : fmt.inr(amount, true)} of your treasury's free money can only ever reach @${handle.replace(/^@/, '')}: neither you nor QED can spend, withdraw or take it back. Anyone can pay it to them once it is due; only they can forgive it or move it.`) }}>
          <div className="vt-own-fields">
            <Field label="The household's handle">{(p) => <input {...p} className="input" autoCapitalize="none" maxLength={40} value={handle} onChange={(e) => setHandle(e.target.value)} />}</Field>
            <Field label="How much">{(p) => <MoneyInput {...p} value={amount} onChange={setAmount} />}</Field>
            <Field label="Due in, days" hint="1 to 365">{(p) => <input {...p} className="input" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />}</Field>
          </div>
          <div className="vt-own-go"><Btn tone="fill" type="submit" busy={va.busy}>See the terms</Btn><Btn tone="quiet" onClick={() => setOpen(null)}>Not now</Btn></div>
        </form>
      )}
      <Problem error={va.error} />
      {va.sheet}
    </section>
  )
}
