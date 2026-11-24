/**
 * Workspace: which workspace you are acting in, who must sign (how many signatures, maker and checker apart, the rule
 * for large amounts), its members and what each role may do, the requests waiting for signatures, and the workspaces
 * you belong to. A personal workspace has one member, you; a business has as many as it needs. Each part is a list of
 * full-width rows on one surface (DESIGN.md "Bounds", B4 and B7), not a grid of cards.
 */
import { Building2, Check, Minus, User } from 'lucide-react'
import { useRef, useState } from 'react'
import { api, fmt, navigate, useData, useNow } from '../lib/core.ts'
import { protectionDelayWords } from '../lib/words.ts'
import { confirmWithPasskey, signForVault } from '../lib/passkey.ts'
import { ApprovalSheet } from '../ui/instrument.tsx'
import { Btn, Field, Loading, MoneyInput, Note, Problem, useAction, useSession } from '../ui/kit.tsx'
import { listed } from './Protect.tsx'
import { policyLowering } from './Security.tsx'
import { VaultRequest } from './Vault.tsx'

type Role = 'owner' | 'admin' | 'approver' | 'operator' | 'viewer'
interface Policy { signers: number; makerChecker: boolean; largePaise: number | null; largeSigners: number | null; bands: { fromPaise: number; signers: number }[]; limits: Record<string, number> }
interface Enforcement { chain: { threshold: number | null; checks: string[] }; qedAlone: string[]; note: string }
interface Grant { id: string; personId: string; handle: string; role: Role; before: Role | null; requestedBy: string; requestedAt: number; effectiveAt: number }
interface WorkspaceView { id: string; role: Role; code: string | null; enforcement: Enforcement; policy: Policy; members: { personId: string; handle: string; name: string; role: Role; since: number }[]; pending: { id: string; effectiveAt: number; requestedAt: number; requestedBy: string; policy?: Record<string, unknown>; before?: Record<string, unknown> }[]; grants?: Grant[] }
interface Open { id: string; purpose: string; subject: string; document: string; docHash: string; createdAt: number; expiresAt: number; createdBy: string | null; signed: number; required: number; canSign: boolean; why: string | null }

const ROLE_TEXT: Record<Role, string> = {
  owner: 'Owner: everything, including members and policy', admin: 'Admin: members and policy, and signing', approver: 'Approver: signs requests',
  operator: 'Operator: prepares requests, cannot sign them', viewer: 'Viewer: looks, changes nothing',
}
const ROLES: Role[] = ['owner', 'admin', 'approver', 'operator', 'viewer']
const can = (role: Role, need: Role): boolean => ['viewer', 'operator', 'approver', 'admin', 'owner'].indexOf(role) >= ['viewer', 'operator', 'approver', 'admin', 'owner'].indexOf(need)
const signs = (r: Role): boolean => can(r, 'approver')
async function fresh(stepUpFresh: boolean | undefined): Promise<void> { if (!stepUpFresh) await confirmWithPasskey() }
const initials = (name: string): string => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?'

/** What a request does, in words, from its document. */
function summary(o: Open): string {
  try { const d = JSON.parse(o.document) as Record<string, unknown>; return String(d.title ?? d.what ?? d.summary ?? o.subject) } catch { return o.subject }
}

export function WorkspaceScreen() {
  const { session, reload } = useSession()
  const now = useNow(30_000)
  const w = useData<WorkspaceView>('/api/workspace', ['workspace'])
  const open = useData<{ approvals: Open[] }>('/api/approvals/open', ['approval', 'workspace'])
  const [name, setName] = useState('')
  const [handle, setHandle] = useState(''), [role, setRole] = useState<Role>('approver')
  const [signing, setSigning] = useState<Open | null>(null)
  // A request for the on-chain vault is signed digest by digest (what its owner account checks); when the last member's
  // signature completes it, it is sent at once and its job opens.
  const digests = (o: Open | null): number => { if (!o || o.purpose !== 'rail') return 0; try { return ((JSON.parse(o.document) as { sign?: unknown[] }).sign ?? []).length } catch { return 0 } }
  const vaultJob = useRef<string | null>(null)
  const vaultSigner = async (id: string, docHash: string) => { const r = await signForVault(id, docHash) as Awaited<ReturnType<typeof signForVault>> & { jobId?: string }; vaultJob.current = r.jobId ?? null; return r }
  const create = useAction(async () => { await fresh(session.stepUpFresh); await api('POST', '/api/workspaces', { name }); setName(''); await reload() })
  // Giving a member authority waits out the protection delay (server/workspaces.ts requestMember; Q-048): the answer says when.
  const [added, setAdded] = useState<string | null>(null)
  const add = useAction(async () => {
    await fresh(session.stepUpFresh)
    const r = await api<{ grant: { applied: boolean; effectiveAt: number | null } }>('POST', '/api/workspace/members', { handle, role })
    setAdded(r.grant.applied ? `@${handle} is a member now, as a viewer.` : `@${handle} becomes ${role === 'viewer' ? 'a' : 'an'} ${role} on ${fmt.dayTime(r.grant.effectiveAt!)}, when the protection delay ends, unless a member who may sign cancels it first. Every member who may sign has been told.`)
    setHandle(''); w.reload()
  })
  const cancelGrant = useAction(async (id: string) => { await fresh(session.stepUpFresh); await api('POST', `/api/security/changes/${id}/cancel`); w.reload() })
  const changeRole = useAction(async (personId: string, to: Role) => { await fresh(session.stepUpFresh); await api('POST', `/api/workspace/members/${personId}/role`, { role: to }); w.reload(); void reload() })
  const removeMember = useAction(async (personId: string) => { await fresh(session.stepUpFresh); await api('POST', `/api/workspace/members/${personId}/remove`); w.reload(); void reload() })
  const switchTo = useAction(async (id: string) => { await api('POST', `/api/workspaces/${id}/switch`); await reload(); w.reload(); open.reload() })
  const title = session.workspace?.name ?? 'Workspace'
  if (!w.data) return <div className="workspace"><WorkspaceHead title={title} />{w.error ? <Problem error={w.error} /> : <Loading what="Reading the workspace" />}</div>
  const ws = w.data
  const business = session.workspace?.kind === 'business'
  // A personal workspace may list no membership of its own: its one member is the person signed in.
  const people = ws.members.length || business || !session.user ? ws.members : [{ personId: session.user.id, handle: session.user.handle, name: session.user.displayName, role: 'owner' as Role, since: session.user.createdAt }]
  const signers = people.filter((m) => signs(m.role))
  const list = session.workspaces ?? []
  return (
    <div className="workspace">
      <WorkspaceHead title={title} lead={business ? `A business workspace. You are ${ws.role === 'owner' ? 'its owner' : `an ${ws.role}`} here.` : 'Your personal workspace: you are its only member and every request needs only your signature.'} />

      {business ? (
        <section className="pg-sec" aria-labelledby="queue-h">
          <div className="pg-sec-head"><div className="pg-sec-t"><h2 id="queue-h">Requests waiting for signatures</h2>{open.data?.approvals.length ? <span className="pg-aside">{open.data.approvals.length} waiting</span> : null}</div></div>
          {!open.data ? (open.error ? <Problem error={open.error} /> : <Loading what="Reading the requests" />)
            : open.data.approvals.length ? <ul className="pg-sheet wk-rows">{open.data.approvals.map((o) => (
              <li key={o.id} className="wk-need">
                <span className="wk-count" aria-hidden="true">{o.signed}<small>/{o.required}</small></span>
                <div className="wk-main"><p className="wk-t">{summary(o)}</p><p className="wk-d">{o.signed} of {o.required} signatures; prepared {fmt.dayTime(o.createdAt)}; expires {fmt.rel(o.expiresAt, now)}</p>{o.why ? <p className="wk-d">{o.why}</p> : null}</div>
                {o.canSign ? <span className="wk-acts"><Btn small tone="fill" onClick={() => setSigning(o)}>Review and sign</Btn></span> : null}
              </li>
            ))}</ul>
            : <p className="pg-sheet wk-empty">Nothing is waiting for a signature.</p>}
        </section>
      ) : null}

      <section className="pg-sec" aria-labelledby="pol-h">
        <div className="pg-sec-head"><div className="pg-sec-t"><h2 id="pol-h">Who must sign</h2><span className="pg-aside">{business ? 'Every request, before anything moves' : 'In this workspace'}</span></div></div>
        <div className="pg-sheet">
          <div className="wk-rule">
            <p className="wk-n">{ws.policy.signers}</p>
            <div>
              <p className="wk-t">{ws.policy.signers === 1 ? 'signature for every request' : 'signatures for every request, each from a different member'}</p>
              <p className="wk-d">{business ? `From the ${signers.length} member${signers.length === 1 ? '' : 's'} who may sign: ${listed(signers.map((m) => m.name))}.` : 'Yours, with your passkey. No one else can approve anything here.'}</p>
            </div>
          </div>
          <dl className="wk-terms">
            <div><dt>Maker and checker</dt><dd>{ws.policy.makerChecker ? 'Whoever prepares a request cannot sign it.' : business ? 'Whoever prepares a request may also sign it.' : 'Not needed: you are the only member.'}</dd></div>
            <div><dt>Large amounts</dt><dd>{ws.policy.largePaise !== null && ws.policy.largeSigners !== null ? `From ${fmt.money(ws.policy.largePaise)}: ${ws.policy.largeSigners} signatures.` : 'No larger requirement.'}</dd></div>
            {business ? <div><dt>Amount bands</dt><dd>{ws.policy.bands.length ? ws.policy.bands.map((b) => `From ${fmt.money(b.fromPaise)}: ${b.signers} signature${b.signers === 1 ? '' : 's'}`).join('; ') + '.' : 'None. Every request needs the count above.'}</dd></div> : null}
            {business ? <div><dt>Who checks it</dt><dd data-testid="enforcement">{ws.enforcement.note}</dd></div> : null}
          </dl>
          {business ? <PolicyForm ws={ws} onSaved={() => { w.reload(); void reload() }} /> : <div className="wk-part"><p className="wk-hint">In a business workspace you choose how many members must sign, whether whoever prepares a request may sign it too, and a higher count from a large amount.</p></div>}
        </div>
      </section>

      <section className="pg-sec" aria-labelledby="mem-h">
        <div className="pg-sec-head"><div className="pg-sec-t"><h2 id="mem-h">Members</h2><span className="pg-aside">{people.length} {people.length === 1 ? 'member' : 'members'}</span></div></div>
        <div className="pg-sheet">
          <ul className="wk-rows">{people.map((m) => (
            <li key={m.personId}>
              <span className="avatar sm" aria-hidden="true">{initials(m.name)}</span>
              <div className="wk-main"><p className="wk-t">{m.name} <span className="wk-d">@{m.handle}</span>{m.handle === session.user?.handle ? <span className="wk-tag">you</span> : null}</p><p className="wk-d">{ROLE_TEXT[m.role]}; since {fmt.dayTime(m.since)}{ws.policy.limits[m.personId] ? `; limit ${fmt.money(ws.policy.limits[m.personId]!)} for a request they prepare or sign` : ''}</p></div>
              {business && can(ws.role, 'admin') && can(ws.role, m.role) ? <MemberActions member={m} mine={ws.role} busy={changeRole.busy || removeMember.busy} onRole={(to) => void changeRole.run(m.personId, to)} onRemove={() => void removeMember.run(m.personId)} /> : null}
            </li>
          ))}</ul>
          {changeRole.error ? <Problem error={changeRole.error} /> : null}
          {removeMember.error ? <Problem error={removeMember.error} /> : null}
          {ws.grants?.length ? <div className="wk-part">
            <h3>Waiting to be given authority</h3>
            <ul className="wk-rows">{ws.grants.map((g) => (
              <li key={g.id}>
                <div className="wk-main"><p className="wk-t">@{g.handle} <span className="wk-d">to become {g.role}{g.before ? ` (now ${g.before})` : ''}</span></p><p className="wk-d">Takes effect {fmt.dayTime(g.effectiveAt)}, unless a member who may sign cancels it first. Asked {fmt.dayTime(g.requestedAt)}.</p></div>
                {signs(ws.role) ? <span className="wk-acts"><Btn small busy={cancelGrant.busy} onClick={() => void cancelGrant.run(g.id)}>Cancel<span className="sr"> giving @{g.handle} the {g.role} role</span></Btn></span> : null}
              </li>
            ))}</ul>
            {cancelGrant.error ? <Problem error={cancelGrant.error} /> : null}
          </div> : null}
          {business && can(ws.role, 'admin') ? <form className="wk-part wk-form" onSubmit={(e) => { e.preventDefault(); void add.run() }}>
            <h3>Add a member</h3>
            <div className="form-grid">
              <Field label="Their handle" error={add.error?.fields.handle}>{(p) => <input {...p} className="input" autoCapitalize="none" value={handle} onChange={(e) => setHandle(e.target.value)} />}</Field>
              <Field label="Role">{(p) => <select {...p} className="input" value={role} onChange={(e) => setRole(e.target.value as Role)}>{ROLES.filter((r) => can(ws.role, r)).map((r) => <option key={r} value={r}>{ROLE_TEXT[r]}</option>)}</select>}</Field>
            </div>
            <p className="wk-hint">Your passkey confirms it. Giving someone authority here (any role but viewer) waits {protectionDelayWords(session.delays?.protectionMs ?? 72 * 3600_000)}, and any member who may sign can cancel it meanwhile; a viewer is added at once. Lowering a role or removing a member takes effect at once.</p>
            {added ? <Note>{added}</Note> : null}
            {add.error && !add.error.fields.handle ? <Problem error={add.error} /> : null}
            <div><Btn type="submit" busy={add.busy} disabled={!handle}>Add member</Btn></div>
          </form> : null}
        </div>
      </section>

      <section className="pg-sec" aria-labelledby="roles-h">
        <div className="pg-sec-head"><div className="pg-sec-t"><h2 id="roles-h">{business ? 'What each member may do' : 'What members of a business may do'}</h2></div><p className="pg-note">Only owners, admins and approvers can sign. An operator prepares requests for others to sign, so the person who asks for a payment need not be the person who approves it.</p></div>
        <div className="pg-sheet">
          <table className="wk-roles">
            <thead><tr><th scope="col">Member</th><th scope="col">May do</th><th scope="col" className="c">Signs</th></tr></thead>
            <tbody>{ROLES.map((r) => { const [k, d] = ROLE_TEXT[r].split(': ') as [string, string]; return (
              <tr key={r} className={business && ws.role === r ? 'you' : ''}><th scope="row">{k}{business && ws.role === r ? <span className="wk-tag">you</span> : null}</th><td>{d.replace(/^./, (c) => c.toUpperCase())}</td><td className="c">{signs(r) ? <span className="wk-yes"><Check aria-hidden="true" /><span className="sr">Yes</span></span> : <span className="wk-no"><Minus aria-hidden="true" /><span className="sr">No</span></span>}</td></tr>
            ) })}</tbody>
          </table>
        </div>
      </section>

      {list.length > 1 ? (
        <section className="pg-sec" aria-labelledby="yours-h">
          <div className="pg-sec-head"><div className="pg-sec-t"><h2 id="yours-h">Your workspaces</h2><span className="pg-aside">{list.length}</span></div></div>
          <ul className="pg-sheet wk-rows">{list.map((x) => { const here = x.id === session.workspace?.id; return (
            <li key={x.id}><span className="wk-glyph" aria-hidden="true">{x.kind === 'business' ? <Building2 /> : <User />}</span><div className="wk-main"><p className="wk-t">{x.kind === 'business' ? x.name : 'Personal'}{here ? <span className="wk-tag">open now</span> : null}</p><p className="wk-d">{x.kind === 'business' ? `You are its ${x.role}; ${x.members} member${x.members === 1 ? '' : 's'}` : 'Only you'}</p></div>
              {here ? null : <span className="wk-acts"><Btn small busy={switchTo.busy} onClick={() => void switchTo.run(x.id)}>Switch to it<span className="sr"> ({x.kind === 'business' ? x.name : 'Personal'})</span></Btn></span>}</li>
          ) })}</ul>
          <Problem error={switchTo.error} />
        </section>
      ) : null}

      <section className="pg-sec" aria-labelledby="new-h">
        <div className="pg-sec-head"><div className="pg-sec-t"><h2 id="new-h">Start a business workspace</h2></div><p className="pg-note">Its own vault, its own records and its own members. You become its owner; add members and how many must sign afterwards.</p></div>
        <form className="pg-sheet wk-new" onSubmit={(e) => { e.preventDefault(); void create.run() }}>
          <input className="input" aria-label="Business name" placeholder="Business name" value={name} onChange={(e) => setName(e.target.value)} />
          <Btn type="submit" busy={create.busy} disabled={name.trim().length < 2}>Create</Btn>
        </form>
        <Problem error={create.error} />
      </section>

      <ApprovalSheet approval={signing ? { approvalId: signing.id, docHash: signing.docHash, expiresAt: signing.expiresAt, requiresStepUp: true } : null} title="Sign this request" action="Sign" withdrawOnClose={false} signer={digests(signing) ? vaultSigner : undefined} prompts={Math.max(1, digests(signing))} onClose={() => { setSigning(null); open.reload() }} onApproved={async () => { setSigning(null); open.reload(); if (vaultJob.current) { const j = vaultJob.current; vaultJob.current = null; navigate(`/vault/job/${j}`) } }}>
        {signing ? (signing.purpose === 'rail' ? <VaultRequest document={signing.document} /> : <><p>{summary(signing)}</p><RequestDoc document={signing.document} /></>) : null}
      </ApprovalSheet>
    </div>
  )
}

/**
 * A request's signed document in words: what it does, its warnings, then a line for each figure or action (to whom,
 * how much, in what, by which route, what follows once approved), and its note; the exact text one step down
 * (R12 section 4: the approval names the recipient, amount, asset, network and consequences, not raw JSON).
 */
type DocLine = { label: string; value: string; note?: string }
function RequestDoc({ document }: { document: string }) {
  let d: Record<string, any> | null = null
  try { d = JSON.parse(document) as Record<string, any> } catch { /* shown as written below */ }
  if (!d) return <pre className="doc small">{document}</pre>
  const rows: DocLine[] = d.kind === 'action'
    ? ((d.estimate ?? []) as DocLine[]).map((l) => ({ label: l.label, value: l.value, note: l.note }))
    : d.kind === 'run-approval'
      ? ((d.lines ?? []) as { to: string; amount: string; asset: string; route: string; once: string }[]).flatMap((l, n) => [
        { label: n ? `Action ${n + 1}: to` : 'To', value: l.to }, ...(l.amount ? [{ label: 'Amount', value: l.amount }] : []), ...(l.asset ? [{ label: 'Asset', value: l.asset }] : []), { label: 'Route', value: l.route }, { label: 'Once approved', value: l.once }])
      : []
  return (
    <article className="adoc" aria-label="What you sign">
      <div className="doc-body">
        {typeof d.what === 'string' ? <p className="doc-pay">{d.what}.</p> : typeof d.program === 'string' ? <p className="doc-pay">One run of “{d.program}”.</p> : null}
        {((d.warnings ?? []) as string[]).map((w, i) => <p key={i} className="doc-warn">{w}</p>)}
        {((d.willDo ?? []) as string[]).map((w, i) => <p key={i} className="i-pay">{w}.</p>)}
        {rows.length ? <dl className="doc-lines">{rows.map((l, i) => <div key={i}><dt>{l.label}</dt><dd><strong>{l.value}</strong>{l.note ? <span className="doc-note">{l.note}</span> : null}</dd></div>)}</dl> : null}
        {typeof d.note === 'string' ? <p className="doc-foot">{d.note}</p> : null}
        <details className="doc-basis"><summary>The exact document you sign</summary><pre className="doc small">{JSON.stringify(d, null, 2)}</pre></details>
      </div>
    </article>
  )
}

function WorkspaceHead({ title, lead }: { title: string; lead?: string }) {
  return <header className="pg-head"><h1>{title}</h1>{lead ? <p>{lead}</p> : null}</header>
}

function PolicyForm({ ws, onSaved }: { ws: WorkspaceView; onSaved: () => void }) {
  const { session } = useSession()
  const [signers, setSigners] = useState(String(ws.policy.signers)), [mc, setMc] = useState(ws.policy.makerChecker)
  const [large, setLarge] = useState<number | null>(ws.policy.largePaise), [largeSigners, setLargeSigners] = useState(String(ws.policy.largeSigners ?? ''))
  const [bands, setBands] = useState<{ from: number | null; signers: string }[]>(ws.policy.bands.map((b) => ({ from: b.fromPaise, signers: String(b.signers) })))
  const [limits, setLimits] = useState<Record<string, number | null>>({ ...ws.policy.limits })
  const [result, setResult] = useState<{ applied: boolean; effectiveAt: number | null } | null>(null)
  // Any member who may sign can cancel a scheduled lowering while it waits; their passkey confirms it.
  const cancel = useAction(async (id: string) => { await fresh(session.stepUpFresh); await api('POST', `/api/security/changes/${id}/cancel`); setResult(null); onSaved() })
  const save = useAction(async () => { await fresh(session.stepUpFresh); setResult(await api('POST', '/api/workspace/policy', { signers: Number(signers), makerChecker: mc, largePaise: large, largeSigners: largeSigners ? Number(largeSigners) : null, bands: bands.filter((b) => b.from && b.signers).map((b) => ({ fromPaise: b.from, signers: Number(b.signers) })), limits: Object.fromEntries([...ws.members.map((m) => [m.personId, limits[m.personId] ?? null])]) })); onSaved() })
  const editable = can(ws.role, 'admin')
  return (
    <div className="wk-part wk-policy">
      <p className="wk-hint">Asking for more signatures takes effect at once. Asking for fewer waits 72 hours, and any member who signs can cancel it in that time, so no one member can quietly weaken the rule.</p>
      {ws.pending.map((c) => <Note key={c.id} tone="wait" title="A lowering is waiting to take effect">{policyLowering(c)}, from {fmt.full(c.effectiveAt)}; asked by @{ws.members.find((m) => m.personId === c.requestedBy)?.handle ?? 'a member'} {fmt.dayTime(c.requestedAt)}.{can(ws.role, 'approver') ? <div style={{ marginTop: 8 }}><Btn small tone="void" busy={cancel.busy} onClick={() => void cancel.run(c.id)}>Cancel this lowering</Btn></div> : null}</Note>)}
      <Problem error={cancel.error} />
      {editable ? <form className="wk-form" onSubmit={(e) => { e.preventDefault(); void save.run() }}>
        <h3>Change who must sign</h3>
        <div className="form-grid">
          <Field label="Signatures for every request">{(p) => <input {...p} className="input" inputMode="numeric" value={signers} onChange={(e) => setSigners(e.target.value)} />}</Field>
          <Field label="From this amount" hint="Leave empty for no larger requirement.">{(p) => <MoneyInput {...p} value={large} onChange={setLarge} />}</Field>
          <Field label="Signatures from that amount">{(p) => <input {...p} className="input" inputMode="numeric" value={largeSigners} onChange={(e) => setLargeSigners(e.target.value)} />}</Field>
        </div>
        <fieldset className="wk-bands">
          <legend>Amount bands</legend>
          <p className="wk-hint">From each amount, that many different members must sign. Under the first band the count above applies. Each band must ask for at least as many as the one below it.</p>
          {bands.map((b, i) => (
            <div key={i} className="form-grid wk-band-row">
              <Field label={`Band ${i + 1}: from this amount`}>{(p) => <MoneyInput {...p} value={b.from} onChange={(v) => setBands(bands.map((x, k) => (k === i ? { ...x, from: v } : x)))} />}</Field>
              <Field label={`Band ${i + 1}: signatures`}>{(p) => <input {...p} className="input" inputMode="numeric" value={b.signers} onChange={(e) => setBands(bands.map((x, k) => (k === i ? { ...x, signers: e.target.value } : x)))} />}</Field>
              <div className="wk-band-x"><Btn small tone="void" onClick={() => setBands(bands.filter((_, k) => k !== i))}>Remove band {i + 1}</Btn></div>
            </div>
          ))}
          {bands.length < 6 ? <div><Btn small onClick={() => setBands([...bands, { from: null, signers: '' }])}>Add a band</Btn></div> : null}
        </fieldset>
        <fieldset className="wk-bands">
          <legend>Each member's limit</legend>
          <p className="wk-hint">The most a member may prepare or sign in one request. Leave empty for no limit. A limit set or lowered takes effect at once; raising or removing one waits 72 hours.</p>
          {ws.members.map((m) => (
            <div key={m.personId} className="form-grid wk-band-row">
              <Field label={`${m.name} (@${m.handle}), ${m.role}`}>{(p) => <MoneyInput {...p} value={limits[m.personId] ?? null} onChange={(v) => setLimits({ ...limits, [m.personId]: v })} />}</Field>
            </div>
          ))}
        </fieldset>
        <p className="wk-hint" data-testid="enforcement-form">{ws.enforcement.note}</p>
        <label className="check"><input type="checkbox" checked={mc} onChange={(e) => setMc(e.target.checked)} /> Whoever prepares a request cannot sign it (maker-checker)</label>
        {result ? result.applied ? <Note tone="ok" title="In force now">The new requirement applies to every request from now on.</Note> : <Note tone="wait" title="Scheduled">It applies {fmt.full(result.effectiveAt!)} unless a member who signs cancels it under Security.</Note> : null}
        <Problem error={save.error} />
        <div><Btn type="submit" busy={save.busy}>Save who must sign</Btn></div>
      </form> : null}
    </div>
  )
}

/** An admin's controls for one member: a lower or higher role (higher waits out the protection delay), or removal (at once). */
function MemberActions({ member, mine, busy, onRole, onRemove }: { member: { personId: string; name: string; role: Role }; mine: Role; busy: boolean; onRole: (to: Role) => void; onRemove: () => void }) {
  const [to, setTo] = useState<Role>(member.role)
  return (
    <span className="wk-acts">
      <label className="sr" htmlFor={`role-${member.personId}`}>What {member.name} may do</label>
      <select id={`role-${member.personId}`} className="input" value={to} onChange={(e) => setTo(e.target.value as Role)}>{ROLES.filter((r) => can(mine, r)).map((r) => <option key={r} value={r}>{r}</option>)}</select>
      <Btn small busy={busy} disabled={to === member.role} onClick={() => onRole(to)}>Change role<span className="sr"> of {member.name}</span></Btn>
      <Btn small busy={busy} onClick={onRemove}>Remove<span className="sr"> {member.name}</span></Btn>
    </span>
  )
}
