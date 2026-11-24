import { afterEach, describe, expect, it } from 'vitest'
import { balance, ensureAccount, placeHold, verifyLedger } from './ledger.ts'
import { issueReceipt } from './receipts.ts'
import { createBusiness, addMember } from './workspaces.ts'
import { accessLog, applyDueDeletions, logMemberRead, purgeApprovers, purgeCandidates, runPurge, cancelDeletion, DELETION_DELAY_MS, deletionState, eraseAccount, exportPerson, liveTables, logAccess, moneyInFlight, openFor, RETENTION, requestDeletion, retentionSchedule, sealFor, TABLES } from './records.ts'
import { makeKit, T0 } from './testkit.ts'

describe('every table is decided', () => {
  it('lists every table of the schema, so a new table cannot be missed silently', () => {
    const k = makeKit()
    const live = liveTables(k.db)
    expect(live.filter((t) => !TABLES[t])).toEqual([])
    expect(Object.keys(TABLES).filter((t) => !live.includes(t))).toEqual([])
  })
  it('treats any table with a column that names a person as a person table, with a way to find the rows', () => {
    const k = makeKit()
    for (const t of liveTables(k.db)) {
      const cols = k.db.all<{ name: string }>(`PRAGMA table_info(${t})`).map((c) => c.name)
      const names = cols.some((c) => ['user_id', 'person_id', 'contact_id', 'approver_id'].includes(c))
      if (names) expect(['person', 'secret'], `${t} names a person`).toContain(TABLES[t]!.scope)
      const rule = TABLES[t]!
      if (rule.scope === 'person') {
        expect(rule.where, t).toBeTruthy()
        expect(['delete', 'scrub', 'keep'], t).toContain(rule.onDelete)
        if (rule.onDelete === 'keep') expect(rule.keep, t).toBeTruthy()
        // the where clause and every scrubbed column are valid SQL on the real table
        expect(() => k.db.all(`SELECT * FROM ${t} WHERE ${rule.where} LIMIT 1`, ...Array(((rule.where ?? '').match(/\?/g) ?? []).length).fill('x'))).not.toThrow()
        for (const c of Object.keys(rule.scrub ?? {})) expect(cols, `${t}.${c}`).toContain(c)
        for (const c of rule.withhold ?? []) expect(cols, `${t}.${c}`).toContain(c)
      }
    }
  })
  it('names a schedule row for every person table, with its source behind the periods', () => {
    expect(retentionSchedule().length).toBe(Object.values(TABLES).filter((r) => r.scope !== 'shared').length)
    expect(RETENTION.sources.map((s) => s.id)).toEqual(['R1', 'R2', 'R3', 'R4'])
    expect(RETENTION.physical).toMatch(/does not claim physical erasure/)
  })
  it('cites each retention period to its text as read in the Gazette or the regulator\'s page, and says where a rule is not yet in force', () => {
    const by = Object.fromEntries(RETENTION.sources.map((s) => [s.id, s]))
    expect(by.R1!.claim).toMatch(/section 12\(3\) and \(4\).*paragraph 50/)
    expect(by.R2!.claim).toMatch(/rule 8\(3\).*rule 1\(4\).*not yet in force/)
    expect(by.R4!.claim).toMatch(/rolling 180 days.*direction \(iv\)/)
    for (const s of RETENTION.sources) expect(s.status, s.id).toMatch(/^verified 24 Nov 2026/)
    expect(RETENTION.financialYears).toBe(5) // the five years of PMLA section 12(3)
    expect(RETENTION.logDays).toBeGreaterThanOrEqual(365) // the one year of DPDP rule 6(1)(e), above CERT-In's 180 days
  })
})

describe('export', () => {
  it('carries the person\'s rows from every person table that has any, and no secrets', () => {
    const k = makeKit()
    k.db.run(`INSERT INTO payees (id, user_id, name, handle, category, created_at) VALUES ('pay_1', ?, 'Asha Rao', 'asha@bank', 'person', ?)`, k.userId, T0)
    logAccess(k.db, k.userId, 'sign-in', { ip: '203.0.113.9', ua: 'TestBrowser' }, T0)
    const x = exportPerson(k.db, k.userId, T0 + 1)
    expect(x.format).toBe('qed-export/1')
    expect(x.tables.users).toHaveLength(1)
    expect(x.tables.users![0]).not.toHaveProperty('pw_hash')
    expect(x.tables.payees![0]).toMatchObject({ name: 'Asha Rao' })
    expect(x.tables.entries!.length).toBeGreaterThan(0)
    expect(x.tables.postings!.length).toBeGreaterThan(0)
    expect(x.tables.access_log![0]).toMatchObject({ kind: 'sign-in', ip: '203.0.113.9' })
    expect(x.tables).not.toHaveProperty('terms')
    expect(x.tables).not.toHaveProperty('person_keys')
    expect(x.notIncluded.map((n) => n.table)).toContain('person_keys')
    // one table per classified person table, so the export cannot silently skip one
    expect(Object.keys(x.tables).sort()).toEqual(Object.entries(TABLES).filter(([, r]) => r.scope === 'person').map(([t]) => t).sort())
    expect(() => JSON.stringify(x)).not.toThrow()
  })
  it('holds nothing of another person', () => {
    const k = makeKit()
    k.db.run(`INSERT INTO users (id, handle, display_name, pw_hash, created_at) VALUES ('usr_other', 'other', 'Other Person', 'x', ?)`, T0)
    k.db.run(`INSERT INTO payees (id, user_id, name, handle, category, created_at) VALUES ('pay_o', 'usr_other', 'Zed Zee', 'zed@bank', 'person', ?)`, T0)
    expect(JSON.stringify(exportPerson(k.db, k.userId, T0))).not.toContain('Zed Zee')
  })
})

describe('the per-person key and the access log', () => {
  it('seals under the person\'s key; destroying it makes the sealed text unreadable by anyone', () => {
    const k = makeKit()
    const s = sealFor(k.db, k.userId, 'secret words', T0)
    expect(s).not.toContain('secret')
    expect(openFor(k.db, k.userId, s)).toBe('secret words')
    expect(openFor(k.db, 'usr_other', s)).toBeNull()
    eraseAccount(k.db, k.userId, T0, T0 + 1)
    expect(openFor(k.db, k.userId, s)).toBeNull()
    expect(k.db.get<{ key: unknown; destroyed_at: number }>('SELECT key, destroyed_at FROM person_keys WHERE person_id = ?', k.userId)).toMatchObject({ key: null, destroyed_at: T0 + 1 })
  })
  it('shows a year of entries, newest first, and drops what is older than that on the next write', () => {
    const k = makeKit(), DAY = 86_400_000
    logAccess(k.db, k.userId, 'sign-in', { ip: '10.0.0.1' }, T0 - 364 * DAY)
    logAccess(k.db, k.userId, 'sign-in', { ip: '10.0.0.2' }, T0 - 10 * DAY)
    expect(accessLog(k.db, k.userId, T0).map((e) => e.ip)).toEqual(['10.0.0.2', '10.0.0.1'])
    expect(accessLog(k.db, k.userId, T0 + 2 * DAY).map((e) => e.ip)).toEqual(['10.0.0.2'])
    logAccess(k.db, k.userId, 'export', {}, T0 + 40 * DAY)
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM access_log WHERE person_id = ?', k.userId)!.n).toBe(2)
  })
})

describe('deletion', () => {
  it('needs the exact words, waits the delay, and can be cancelled until it takes effect', () => {
    const k = makeKit()
    expect(() => requestDeletion(k.db, k.userId, 'yes', T0)).toThrow(/Type/)
    const d = requestDeletion(k.db, k.userId, 'delete my account', T0)
    expect(d.effectiveAt).toBe(T0 + DELETION_DELAY_MS)
    expect(() => requestDeletion(k.db, k.userId, 'delete my account', T0)).toThrow(/already scheduled/)
    expect(applyDueDeletions(k.db, T0 + DELETION_DELAY_MS - 1)).toBe(0)
    cancelDeletion(k.db, k.userId, T0 + 5)
    expect(deletionState(k.db, k.userId).pending).toBeNull()
    expect(applyDueDeletions(k.db, T0 + DELETION_DELAY_MS + 1)).toBe(0)
    expect(k.db.get('SELECT 1 FROM erasures WHERE person_id = ?', k.userId)).toBeUndefined()
  })
  it('is refused while money is in flight, at the request and again when the delay ends', () => {
    const k = makeKit()
    placeHold(k.db, k.userId, 'bank', 1_000n, 'Payment in progress', 'act:1', T0)
    expect(moneyInFlight(k.db, k.userId).join()).toMatch(/reservation/)
    expect(() => requestDeletion(k.db, k.userId, 'delete my account', T0)).toThrow(/money is in flight/)
    k.db.run('UPDATE holds SET released_at = ?', T0)
    requestDeletion(k.db, k.userId, 'delete my account', T0 + 1)
    k.db.run('UPDATE holds SET released_at = NULL')
    expect(applyDueDeletions(k.db, T0 + DELETION_DELAY_MS + 2)).toBe(0)
    expect(deletionState(k.db, k.userId).pending).toBeNull()
    expect(k.db.get<{ kind: string }>(`SELECT kind FROM security_events WHERE person_id = ? ORDER BY id DESC LIMIT 1`, k.userId)!.kind).toBe('deletion-refused')
    expect(k.db.get('SELECT 1 FROM erasures')).toBeUndefined()
  })
  it('erases personal fields, keeps the books whole under a pseudonymous id, and records the retention', () => {
    const k = makeKit()
    k.db.run(`INSERT INTO payees (id, user_id, name, handle, category, created_at) VALUES ('pay_1', ?, 'Asha Rao', 'asha@bank', 'person', ?)`, k.userId, T0)
    k.db.run(`INSERT INTO contact_points (id, person_id, kind, address, address_key, created_at) VALUES ('cp_1', ?, 'email', 'me@example.test', 'me@example.test', ?)`, k.userId, T0)
    k.db.run(`INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, expires_at, csrf) VALUES ('h1', ?, ?, ?, ?, 'c')`, k.userId, T0, T0, T0 + 1e9)
    logAccess(k.db, k.userId, 'sign-in', { ip: '203.0.113.9' }, T0)
    const entries = k.db.get<{ n: number }>('SELECT COUNT(*) n FROM entries WHERE user_id = ?', k.userId)!.n, bank = balance(k.db, k.userId, 'bank')
    requestDeletion(k.db, k.userId, 'delete my account', T0)
    expect(applyDueDeletions(k.db, T0 + DELETION_DELAY_MS)).toBe(1)
    const u = k.db.get<{ handle: string; display_name: string; pw_hash: string }>('SELECT handle, display_name, pw_hash FROM users WHERE id = ?', k.userId)!
    expect(u).toEqual({ handle: `erased-${k.userId}`, display_name: 'Erased account', pw_hash: '!' })
    expect(k.db.get('SELECT 1 FROM sessions WHERE user_id = ?', k.userId)).toBeUndefined()
    expect(k.db.get('SELECT 1 FROM contact_points WHERE person_id = ?', k.userId)).toBeUndefined()
    expect(k.db.get<{ name: string; handle: string }>('SELECT name, handle FROM payees WHERE id = ?', 'pay_1')).toEqual({ name: '[erased]', handle: '[erased-pay_1]' })
    // the books are whole
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM entries WHERE user_id = ?', k.userId)!.n).toBe(entries)
    expect(balance(k.db, k.userId, 'bank')).toBe(bank)
    expect(verifyLedger(k.db, k.userId)).toEqual([])
    // the log remains, but what was sealed cannot be read; nothing new is logged for an erased account
    expect(accessLog(k.db, k.userId, T0 + DELETION_DELAY_MS).map((e) => [e.kind, e.ip])).toEqual(expect.arrayContaining([['sign-in', null]]))
    logAccess(k.db, k.userId, 'sign-in', {}, T0 + DELETION_DELAY_MS + 5)
    const e = k.db.get<{ retain_until: number; schedule_json: string; counts_json: string }>('SELECT retain_until, schedule_json, counts_json FROM erasures WHERE person_id = ?', k.userId)!
    expect(new Date(e.retain_until).getUTCFullYear() - new Date(T0 + DELETION_DELAY_MS).getUTCFullYear()).toBe(RETENTION.financialYears)
    expect(JSON.parse(e.schedule_json).find((r: { table: string }) => r.table === 'entries')).toMatchObject({ what: 'kept' })
    expect(JSON.parse(e.counts_json).sessions).toBe(1)
    // a live instruction is revoked, so nothing runs for the account
    expect(k.db.all(`SELECT 1 FROM programs WHERE user_id = ? AND state IN ('active', 'paused')`, k.userId)).toEqual([])
  })
})

describe('deletion is refused while the on-chain wallet holds funds or has jobs in flight', () => {
  const holder = (k: ReturnType<typeof makeKit>, code: string, text: string): void => {
    const a = ensureAccount(k.db, k.userId, code, 'asset', 'INR', 'Treasury') // the asset is beside the point here: the code is what the check reads
    k.db.run('INSERT INTO balances (account_id, amount, amount_text) VALUES (?, ?, ?) ON CONFLICT (account_id) DO UPDATE SET amount = excluded.amount, amount_text = excluded.amount_text', a.id, Number(text), text)
  }
  it('refuses with the reason when a wallet account holds a balance', () => {
    const k = makeKit()
    holder(k, 'chain:treasury:eip155:31337/erc20:0xabc', '5000000')
    expect(moneyInFlight(k.db, k.userId).join()).toMatch(/on-chain wallet holds test tokens/)
    expect(() => requestDeletion(k.db, k.userId, 'delete my account', T0)).toThrow(/on-chain wallet holds test tokens/)
  })
  it('allows it again when the wallet is empty', () => {
    const k = makeKit()
    holder(k, 'chain:treasury:eip155:31337/erc20:0xabc', '0')
    expect(moneyInFlight(k.db, k.userId)).toEqual([])
  })
  it('refuses while a job is funded in the escrow or offered, and says so in words', () => {
    const k = makeKit()
    k.db.run(`INSERT INTO earn_jobs (id, user_id, title, client, state, created_at) VALUES ('job_1', ?, 'Work', 'Client', 'open', ?)`, k.userId, T0)
    k.db.run(`INSERT INTO earn_milestones (id, job_id, user_id, title, amount, state, updated_at) VALUES ('m1', 'job_1', ?, 'M1', 100, 'chain-funded', ?)`, k.userId, T0)
    expect(moneyInFlight(k.db, k.userId).join()).toMatch(/on-chain job is in flight/)
    expect(() => requestDeletion(k.db, k.userId, 'delete my account', T0)).toThrow(/on-chain job is in flight/)
    k.db.run(`UPDATE earn_milestones SET state = 'chain-released'`)
    expect(moneyInFlight(k.db, k.userId)).toEqual([])
  })
  it('refuses when a wallet exists whose history is not yet in the books', () => {
    const k = makeKit()
    k.db.run(`INSERT INTO meta (key, value) VALUES (?, '{}')`, `vault.workspace:${k.userId}`)
    k.db.run(`INSERT INTO chain_books (user_id, network, backfill) VALUES (?, 'eip155:31337', 'needed')`, k.userId)
    expect(moneyInFlight(k.db, k.userId).join()).toMatch(/not been read into your books/)
  })
})

describe('other members\' reads and business workspaces', () => {
  function world() {
    const k = makeKit()
    k.db.run(`INSERT INTO users (id, handle, display_name, pw_hash, created_at) VALUES ('usr_peer', 'peer', 'Peer Member', 'x', ?)`, T0)
    const ws = createBusiness(k.db, k.userId, 'Acme Studio', T0)
    addMember(k.db, ws, { personId: k.userId, role: 'owner' }, 'peer', 'admin', T0)
    return { k, ws }
  }
  it('logs a member\'s read of a workspace in each owner\'s own access log, once a quarter hour, never their own reads', () => {
    const { k, ws } = world()
    expect(logMemberRead(k.db, ws, 'usr_peer', 'admin', '/api/passbook', T0)).toBe(1)
    expect(logMemberRead(k.db, ws, 'usr_peer', 'admin', '/api/passbook', T0 + 60_000)).toBe(0)
    expect(logMemberRead(k.db, ws, 'usr_peer', 'admin', '/api/passbook', T0 + 16 * 60_000)).toBe(1)
    expect(logMemberRead(k.db, ws, k.userId, 'owner', '/api/passbook', T0 + 99 * 60_000)).toBe(0) // an owner's own read is not logged to themselves
    const log = accessLog(k.db, k.userId, T0 + 17 * 60_000).filter((e) => e.kind === 'member-read')
    expect(log).toHaveLength(2)
    expect(log[0]).toMatchObject({ by: 'Peer Member', role: 'admin', workspace: ws, path: '/api/passbook' })
    // sealed under the owner's key like the rest of the log
    expect(k.db.get<{ detail_sealed: string }>(`SELECT detail_sealed FROM access_log WHERE kind = 'member-read' LIMIT 1`)!.detail_sealed).not.toContain('Peer')
  })
  it('a read of someone\'s personal workspace by a member is logged for that person', () => {
    const k = makeKit()
    k.db.run(`INSERT INTO users (id, handle, display_name, pw_hash, created_at) VALUES ('usr_spouse', 'spouse', 'Spouse', 'x', ?)`, T0)
    expect(logMemberRead(k.db, k.userId, 'usr_spouse', 'viewer', '/api/holdings', T0 + 7 * 24 * 3600_000)).toBe(1)
    expect(accessLog(k.db, k.userId, T0 + 7 * 24 * 3600_000).some((e) => e.kind === 'member-read' && e.by === 'Spouse')).toBe(true)
  })
  it('the export carries the business workspaces the person belongs to, and nothing of a workspace they are not in', () => {
    const { k, ws } = world()
    k.db.run(`INSERT INTO payees (id, user_id, name, handle, category, created_at) VALUES ('pay_ws', ?, 'Vendor Ltd', 'vendor@bank', 'business', ?)`, ws, T0)
    const other = createBusiness(k.db, 'usr_peer', 'Peer Only Co', T0)
    k.db.run(`INSERT INTO payees (id, user_id, name, handle, category, created_at) VALUES ('pay_other', ?, 'Secret Vendor', 'sv@bank', 'business', ?)`, other, T0)
    const x = exportPerson(k.db, k.userId, T0)
    expect(x.workspaces.map((w) => w.id)).toEqual([ws])
    expect(x.workspaces[0]).toMatchObject({ name: 'Acme Studio', role: 'owner' })
    expect(x.workspaces[0]!.members.map((m) => m.handle).sort()).toEqual(['peer', 'tester'])
    expect(x.workspaces[0]!.tables.payees![0]).toMatchObject({ name: 'Vendor Ltd' })
    const text = JSON.stringify(x)
    expect(text).not.toContain('Secret Vendor')
    for (const banned of ['webauthn_credentials', 'sessions', 'contact_points', 'access_log', 'person_keys']) expect(Object.keys(x.workspaces[0]!.tables)).not.toContain(banned)
    expect(JSON.stringify(x.workspaces)).not.toContain('pw_hash')
  })
})

describe('the purge', () => {
  const SAVED = process.env.QED_PURGE_APPROVERS
  afterEach(() => { if (SAVED === undefined) delete process.env.QED_PURGE_APPROVERS; else process.env.QED_PURGE_APPROVERS = SAVED })
  /** An erased person with books, receipts and a payee, past retention, and an operator who may approve. */
  function erased() {
    const k = makeKit()
    k.db.run(`INSERT INTO users (id, handle, display_name, pw_hash, created_at) VALUES ('usr_op', 'operator', 'Operator', 'x', ?)`, T0)
    k.db.run(`INSERT INTO payees (id, user_id, name, handle, category, created_at) VALUES ('pay_1', ?, 'Asha Rao', 'asha@bank', 'person', ?)`, k.userId, T0)
    issueReceipt(k.db, k.userId, 'test', 'subject', { n: 1 }, T0)
    requestDeletion(k.db, k.userId, 'delete my account', T0)
    applyDueDeletions(k.db, T0 + DELETION_DELAY_MS)
    const retainUntil = k.db.get<{ retain_until: number }>('SELECT retain_until FROM erasures WHERE person_id = ?', k.userId)!.retain_until
    process.env.QED_PURGE_APPROVERS = 'operator'
    return { k, retainUntil, after: retainUntil + 1 }
  }
  it('is not offered before the retention period ends, and names nobody as approver by default', () => {
    const { k, retainUntil } = erased()
    expect(purgeCandidates(k.db, retainUntil - 1)).toEqual([])
    delete process.env.QED_PURGE_APPROVERS
    expect(purgeApprovers()).toEqual([])
    expect(() => runPurge(k.db, 'usr_op', k.userId, 'x', retainUntil + 1)).toThrow(/purge approver/)
  })
  it('previews what it would remove, and what it leaves, without changing anything', () => {
    const { k, after } = erased()
    const entries = k.db.get<{ n: number }>('SELECT COUNT(*) n FROM entries WHERE user_id = ?', k.userId)!.n
    const [c] = purgeCandidates(k.db, after)
    expect(c).toMatchObject({ personId: k.userId, ledgerOk: true, receiptsOk: true })
    expect(c!.tables.find((t) => t.table === 'entries')!.rows).toBe(entries)
    expect(c!.left.map((l) => l.table)).toEqual(expect.arrayContaining(['audit', 'events', 'netting_claims']))
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM entries WHERE user_id = ?', k.userId)!.n).toBe(entries)
  })
  it('refuses a person who is not erased, one whose period has not ended, and a preview that has changed', () => {
    const { k, retainUntil, after } = erased()
    expect(() => runPurge(k.db, 'usr_op', 'usr_nobody', 'x', after)).toThrow(/not been erased/)
    expect(() => runPurge(k.db, 'usr_op', k.userId, 'x', retainUntil - 1)).toThrow(/kept until/)
    expect(() => runPurge(k.db, 'usr_op', k.userId, 'stale', after)).toThrow(/not what you were shown/)
    expect(() => runPurge(k.db, k.userId, k.userId, purgeCandidates(k.db, after)[0]!.previewDigest, after)).toThrow(/purge approver/)
  })
  it('removes the records in one transaction, keeps the triggers, writes the closing summary and audits it', () => {
    const { k, after } = erased()
    const c = purgeCandidates(k.db, after)[0]!
    const triggersBefore = k.db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name`).map((t) => t.name)
    const r = runPurge(k.db, 'usr_op', k.userId, c.previewDigest, after)
    for (const t of ['entries', 'postings', 'accounts', 'balances', 'receipts', 'payees']) expect(k.db.get<{ n: number }>(`SELECT COUNT(*) n FROM ${t} WHERE ${TABLES[t]!.where}`, ...Array(((TABLES[t]!.where ?? '').match(/\?/g) ?? []).length).fill(k.userId))!.n, t).toBe(0)
    expect(r.removed.entries).toBe(c.tables.find((t) => t.table === 'entries')!.rows)
    expect(verifyLedger(k.db, k.userId)).toEqual([])
    // the append-only triggers are all back
    expect(k.db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name`).map((t) => t.name)).toEqual(triggersBefore)
    expect(() => k.db.run('DELETE FROM purge_runs')).toThrow(/append-only/)
    expect(() => k.db.run(`UPDATE purge_runs SET digest = 'x'`)).toThrow(/append-only/)
    const run = k.db.get<{ approved_by: string; approval_method: string; summary_json: string; digest: string }>('SELECT * FROM purge_runs WHERE person_id = ?', k.userId)!
    expect(run).toMatchObject({ approved_by: 'usr_op', approval_method: 'passkey', digest: r.digest })
    const summary = JSON.parse(run.summary_json)
    expect(summary.ledger.entries).toBe(c.tables.find((t) => t.table === 'entries')!.rows)
    expect(summary.receipts.count).toBeGreaterThan(0)
    expect(summary.note).toMatch(/does not claim physical erasure|do not claim physical erasure|not claim physical erasure/)
    expect(k.db.get('SELECT 1 FROM audit WHERE action = ? AND subject = ?', 'records.purged', k.userId)).toBeTruthy()
    // the erasure record and the pseudonymous user stay; a second run is refused and none is offered
    expect(k.db.get('SELECT 1 FROM erasures WHERE person_id = ?', k.userId)).toBeTruthy()
    expect(purgeCandidates(k.db, after)).toEqual([])
    expect(() => runPurge(k.db, 'usr_op', k.userId, c.previewDigest, after)).toThrow(/already/)
  })
  it('is refused, and changes nothing, when the receipt chain does not verify', () => {
    const { k, after } = erased()
    k.db.exec('DROP TRIGGER receipts_no_update')
    k.db.run(`UPDATE receipts SET body_json = '{"n":2}' WHERE user_id = ?`, k.userId)
    const c = purgeCandidates(k.db, after)[0]!
    expect(c.receiptsOk).toBe(false)
    const entries = k.db.get<{ n: number }>('SELECT COUNT(*) n FROM entries WHERE user_id = ?', k.userId)!.n
    expect(() => runPurge(k.db, 'usr_op', k.userId, c.previewDigest, after)).toThrow(/receipt chain does not verify/)
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM entries WHERE user_id = ?', k.userId)!.n).toBe(entries)
    expect(k.db.get('SELECT 1 FROM purge_runs')).toBeUndefined()
  })
  it('is refused when the ledger does not verify', () => {
    const { k, after } = erased()
    k.db.exec('DROP TRIGGER postings_no_update')
    k.db.run(`UPDATE postings SET amount = amount + 1, amount_text = CAST(amount + 1 AS TEXT) WHERE id = 1`)
    const c = purgeCandidates(k.db, after)[0]!
    expect(c.ledgerOk).toBe(false)
    expect(() => runPurge(k.db, 'usr_op', k.userId, c.previewDigest, after)).toThrow(/ledger does not verify/)
  })
  it('rolls back whole when another record still points at a row it would remove', () => {
    const { k, after } = erased()
    k.db.run(`INSERT INTO users (id, handle, display_name, pw_hash, created_at) VALUES ('usr_x', 'xx', 'X', 'x', ?)`, T0)
    const acc = k.db.get<{ id: string }>('SELECT id FROM accounts WHERE user_id = ? LIMIT 1', k.userId)!.id
    k.db.run(`INSERT INTO holds (id, user_id, account_id, amount, amount_text, reason, ref, created_at) VALUES ('h_x', 'usr_x', ?, 1, '1', 'x', 'r', ?)`, acc, T0)
    const c = purgeCandidates(k.db, after)[0]!
    const entries = k.db.get<{ n: number }>('SELECT COUNT(*) n FROM entries WHERE user_id = ?', k.userId)!.n
    expect(() => runPurge(k.db, 'usr_op', k.userId, c.previewDigest, after)).toThrow()
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM entries WHERE user_id = ?', k.userId)!.n).toBe(entries)
    expect(k.db.get('SELECT 1 FROM purge_runs')).toBeUndefined()
    expect(k.db.all(`SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'entries_no_delete'`)).toHaveLength(1)
  })
})
