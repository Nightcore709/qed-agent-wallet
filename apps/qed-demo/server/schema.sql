-- QED local backend schema (SQLite, STRICT tables). Money and quantities are integers in the asset's smallest
-- unit ("atoms"); prices are decimal strings exactly as received or computed. Times are Unix milliseconds, UTC.
-- The ledger (entries, postings), receipts and audit tables are append-only; triggers enforce it.

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;

-- ---------------------------------------------------------------- identity
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  profile_json TEXT NOT NULL DEFAULT '{}',
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  stop_at INTEGER,              -- emergency stop: set when the owner halts all autonomous activity
  stop_reason TEXT,
  kind TEXT NOT NULL DEFAULT 'person', -- 'person' (signs in) | 'business' (a workspace people belong to)
  stop_protective INTEGER NOT NULL DEFAULT 0, -- 1: while stopped, protective selling (floor, sell-if-falls) still runs, because the owner chose that
  policy_json TEXT NOT NULL DEFAULT '{}', -- a business workspace's approval policy (signers required, maker-checker)
  authority_hold_at INTEGER,    -- v7: set by a password reset or an account recovery; until a passkey's approval authority is
                                -- restored, a passkey added with the password signs in only (server/recovery.ts)
  password_reset_at INTEGER     -- v7: when a reset link last set the password; for the protection delay after it, that password
                                -- confirms no change to how the account gets back in (passkeys.ts passwordHeldUntil)
) STRICT;

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,     -- SHA-256 of the cookie token; the token itself is never stored
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  csrf TEXT NOT NULL,
  ua TEXT,
  stepup_at INTEGER,            -- last time the owner re-authenticated in this session (passkey, or a legacy password)
  revoked_at INTEGER,
  auth_method TEXT NOT NULL DEFAULT 'password', -- how the session was opened: 'passkey' | 'password' (legacy accounts)
  credential_id TEXT,           -- the passkey that opened it
  workspace_id TEXT,            -- the workspace the session is acting in (a users row the person is a member of)
  stepup_method TEXT,           -- how the last re-authentication was made: 'passkey' | 'password'
  stepup_credential_id TEXT     -- v8 (r): the passkey that gave the latest confirmation (NULL: a password, or not known)
) STRICT;
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

-- Passkeys (WebAuthn). Only ES256 (P-256) is accepted, because the same key must also verify on chain (EIP-7951).
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id TEXT PRIMARY KEY,          -- credential id (base64url)
  person_id TEXT NOT NULL REFERENCES users(id),
  public_key BLOB NOT NULL,     -- COSE_Key as registered
  x TEXT NOT NULL,              -- P-256 public key, hex, for the on-chain owner account
  y TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  device_type TEXT,             -- 'singleDevice' | 'multiDevice' (synced)
  backed_up INTEGER NOT NULL DEFAULT 0,
  aaguid TEXT,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  removed_at INTEGER,
  removed_reason TEXT,
  suspended_at INTEGER,         -- set at once by another of the person's passkeys; a suspended passkey can do nothing
  suspended_by TEXT,
  authority TEXT NOT NULL DEFAULT 'full', -- v7: 'full' signs in, confirms and approves; 'signin' (registered by a recovery, or
                                -- after a password reset) signs in only, until a delayed restoration makes it 'full'
  authority_reason TEXT,        -- why a passkey signs in only: 'recovery' | 'after-password-reset'
  cool_off_until INTEGER        -- v8 (r): a passkey added to an account is limited until then (server/passkeys.ts COOL_OFF_MS)
) STRICT;
CREATE INDEX IF NOT EXISTS webauthn_credentials_person ON webauthn_credentials(person_id);

-- One row per challenge the server has issued; single use, short-lived.
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id TEXT PRIMARY KEY,
  person_id TEXT,               -- null while registering a new account or signing in without a handle
  purpose TEXT NOT NULL,        -- 'register' | 'add' | 'recover' | 'login' | 'stepup' | 'approval'
  challenge TEXT NOT NULL,      -- base64url
  context_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
) STRICT;

-- Single-use recovery codes; only a salted hash is stored. Using one starts a delayed, cancellable recovery.
CREATE TABLE IF NOT EXISTS recovery_codes (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES users(id),
  salt TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  used_at INTEGER,
  replaced_at INTEGER,
  algo TEXT NOT NULL DEFAULT 'sha256' -- 'scrypt' from v3 (one salt per batch); 'sha256' for codes made before, put under
                                -- scrypt by the v8 step, part (r): 'scrypt-sha256' (server/core.ts layerLegacyCodes)
) STRICT;
CREATE INDEX IF NOT EXISTS recovery_codes_person ON recovery_codes(person_id);

CREATE TABLE IF NOT EXISTS recovery_requests (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES users(id),
  code_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  available_at INTEGER NOT NULL, -- the new passkey may be registered from this moment
  cancelled_at INTEGER,
  cancelled_by TEXT,
  completed_at INTEGER,
  credential_id TEXT,
  contact_code_id TEXT,         -- the second recovery code, issued by a recovery contact
  method TEXT NOT NULL DEFAULT 'saved-code', -- 'saved+contact' | 'saved+password' from v3; 'saved-code' before
  secret_hash TEXT,             -- v4: SHA-256 of the secret in the reference only the starter was given; NULL before
  via TEXT NOT NULL DEFAULT 'codes', -- v7: how the first proof came: 'codes' (a saved code and a second code, the backup path) | 'email'
  ready_sent_at INTEGER         -- v7: when the message saying it can be finished went to the account's email addresses
) STRICT;

-- A recovery contact: a person with their own account who can issue a one-time code for this person's recovery, after
-- confirming with their own passkey. Nominating one makes recovery easier, so it takes effect only after the
-- protection delay, and only once the contact has accepted.
CREATE TABLE IF NOT EXISTS recovery_contacts (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES users(id),
  contact_id TEXT NOT NULL REFERENCES users(id),
  requested_at INTEGER NOT NULL,
  effective_at INTEGER NOT NULL,
  accepted_at INTEGER,
  removed_at INTEGER,
  removed_by TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS recovery_contacts_person ON recovery_contacts(person_id);
CREATE INDEX IF NOT EXISTS recovery_contacts_contact ON recovery_contacts(contact_id);

CREATE TABLE IF NOT EXISTS contact_codes (
  id TEXT PRIMARY KEY,
  link_id TEXT NOT NULL REFERENCES recovery_contacts(id),
  person_id TEXT NOT NULL,      -- whose recovery it is for
  contact_id TEXT NOT NULL,     -- who issued it
  salt TEXT NOT NULL,
  code_hash TEXT NOT NULL,      -- scrypt
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  replaced_at INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS contact_codes_person ON contact_codes(person_id);

-- Addresses that reach the person outside QED (v7, server/recovery.ts): email (confirmed by a one-time link or code; one
-- confirmed for longer than the protection delay can start a password reset or an account recovery) and a phone number
-- (confirmed by a code; receives security notices only, never a recovery factor). Delivery goes through the adapter of
-- server/delivery.ts: in this build the local test outbox, which sends nothing.
CREATE TABLE IF NOT EXISTS contact_points (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,           -- 'email' | 'phone'
  address TEXT NOT NULL,        -- as it is shown and sent to
  address_key TEXT NOT NULL,    -- normalised for lookup (email lower-cased; phone in E.164)
  created_at INTEGER NOT NULL,
  verified_at INTEGER,
  usable_from INTEGER,          -- email: from when it may start a reset or a recovery (confirmed + the protection delay)
  replaces_id TEXT,             -- the address this one replaces once it is confirmed (a change)
  removed_at INTEGER,
  removed_reason TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS contact_points_person ON contact_points(person_id);
CREATE INDEX IF NOT EXISTS contact_points_key ON contact_points(kind, address_key);

-- One-time secrets sent outside QED: a link token (256 random bits; this table keeps only its SHA-256) and, where a person
-- may type it instead, a short code (scrypt, attempts counted). Single use, expiring; asking for another replaces the
-- earlier one. The text of the message that carried them is kept in outbound_messages until they stop working.
CREATE TABLE IF NOT EXISTS one_time_tokens (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  purpose TEXT NOT NULL,        -- 'verify-email' | 'verify-phone' | 'password-reset' | 'recovery-email'
  subject TEXT,                 -- the contact point or recovery request it concerns
  token_hash TEXT,
  code_salt TEXT,
  code_hash TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  replaced_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX IF NOT EXISTS one_time_tokens_hash ON one_time_tokens(token_hash);
CREATE INDEX IF NOT EXISTS one_time_tokens_person ON one_time_tokens(person_id, purpose);

-- Every message QED hands to a delivery adapter (server/delivery.ts). With the local test outbox (this build's only one)
-- nothing leaves this computer: status 'simulated', shown on the developer page and never as a real message.
CREATE TABLE IF NOT EXISTS outbound_messages (
  id TEXT PRIMARY KEY,
  person_id TEXT,
  channel TEXT NOT NULL,        -- 'email' | 'sms'
  to_address TEXT NOT NULL,
  purpose TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL,         -- 'simulated' | 'queued' | 'sent' | 'failed'
  adapter TEXT NOT NULL,
  sent_at INTEGER,
  provider_ref TEXT,
  error TEXT,
  token_id TEXT,                -- the one-time token whose link or code the text carries, if any
  body_redacted TEXT,           -- the text with that link and code taken out, which replaces it once they stop working
  redacted_at INTEGER           -- when the link and code were taken out of the kept text (used, replaced or expired)
) STRICT;
CREATE INDEX IF NOT EXISTS outbound_messages_created ON outbound_messages(created_at);
CREATE INDEX IF NOT EXISTS outbound_messages_token ON outbound_messages(token_id);

-- Changes that reduce protection wait out a delay, during which any of the person's other passkeys can cancel them.
CREATE TABLE IF NOT EXISTS scheduled_changes (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  workspace_id TEXT,
  kind TEXT NOT NULL,           -- 'remove-passkey' | 'unsuspend-passkey' | 'lower-policy' | 'restore-authority' (v7) |
                                -- 'loosen-profile' | 'remove-bill' | 'grant-member' (R13 hardening: a member given authority)
  subject TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  requested_at INTEGER NOT NULL,
  requested_by TEXT,            -- the credential that asked for it
  effective_at INTEGER NOT NULL,
  cancelled_at INTEGER,
  cancelled_by TEXT,
  applied_at INTEGER
) STRICT;

-- Security events the owner is told about (sign-ins, new passkeys, recovery, removals, session ends).
CREATE TABLE IF NOT EXISTS security_events (
  id INTEGER PRIMARY KEY,
  person_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  seen_at INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS security_events_person ON security_events(person_id, ts);

-- Who may act in which workspace. A personal workspace is the person's own users row.
CREATE TABLE IF NOT EXISTS memberships (
  workspace_id TEXT NOT NULL REFERENCES users(id),
  person_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,           -- 'owner' | 'admin' | 'approver' | 'operator' | 'viewer'
  created_at INTEGER NOT NULL,
  added_by TEXT,
  removed_at INTEGER,
  PRIMARY KEY (workspace_id, person_id)
) STRICT;
CREATE INDEX IF NOT EXISTS memberships_person ON memberships(person_id);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  user_id TEXT,
  actor TEXT NOT NULL,          -- 'owner' | 'engine' | 'model' | 'system'
  action TEXT NOT NULL,
  subject TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  ip TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS audit_user ON audit(user_id, id);

-- ---------------------------------------------------------------- assets, instruments, market data
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,          -- 'INR', 'BTC', 'MF:120716'
  kind TEXT NOT NULL,           -- 'fiat' | 'crypto' | 'fund_unit'
  name TEXT NOT NULL,
  scale INTEGER NOT NULL        -- decimal places of one atom
) STRICT;

CREATE TABLE IF NOT EXISTS instruments (
  id TEXT PRIMARY KEY,          -- 'coindcx:BTCINR', 'amfi:120716', 'ecb:USDINR'
  kind TEXT NOT NULL,           -- 'crypto_spot' | 'mutual_fund' | 'fx_reference' | 'rate' | 'crypto_reference'
  name TEXT NOT NULL,
  base_asset TEXT NOT NULL,
  quote_asset TEXT NOT NULL,
  provider TEXT NOT NULL,
  venue TEXT NOT NULL,
  symbol TEXT NOT NULL,
  tradable INTEGER NOT NULL,
  meta_json TEXT NOT NULL DEFAULT '{}'
) STRICT;

-- Latest value per instrument and price type. source_ts is the provider's own timestamp when it supplies one.
-- instrument_id in this table names a market line (a row of instruments: 'coindcx:BTCINR', 'amfi:120716'), not the canonical
-- instrument id that accounts and postings carry since v5; never read it as one (D-110; the rename waits for stage S8).
CREATE TABLE IF NOT EXISTS quotes (
  instrument_id TEXT NOT NULL,
  price_type TEXT NOT NULL,     -- 'bid' | 'ask' | 'last' | 'nav' | 'reference' | 'rate'
  price TEXT NOT NULL,
  size TEXT,
  source_ts INTEGER,
  source_precision TEXT NOT NULL, -- 'ms' | 's' | 'day' | 'none'
  recv_ts INTEGER NOT NULL,
  provider TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (instrument_id, price_type)
) STRICT;

-- instrument_id in this table names a market line (a row of instruments: 'coindcx:BTCINR', 'amfi:120716'), not the canonical
-- instrument id that accounts and postings carry since v5; never read it as one (D-110; the rename waits for stage S8).
CREATE TABLE IF NOT EXISTS quote_history (
  id INTEGER PRIMARY KEY,
  instrument_id TEXT NOT NULL,
  price_type TEXT NOT NULL,
  price TEXT NOT NULL,
  source_ts INTEGER,
  recv_ts INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS quote_history_i ON quote_history(instrument_id, price_type, recv_ts);

-- Daily published values (fund NAVs, reference FX fixes, reference rates), keyed by the provider's date.
-- instrument_id in this table names a market line (a row of instruments: 'coindcx:BTCINR', 'amfi:120716'), not the canonical
-- instrument id that accounts and postings carry since v5; never read it as one (D-110; the rename waits for stage S8).
CREATE TABLE IF NOT EXISTS daily_values (
  instrument_id TEXT NOT NULL,
  value_date TEXT NOT NULL,     -- 'YYYY-MM-DD' as published
  value TEXT NOT NULL,
  recv_ts INTEGER NOT NULL,     -- when this engine first received it (history backfills are marked in source)
  source TEXT NOT NULL,         -- 'amfi-navall' | 'mfapi-history' | 'frankfurter' | 'nyfed'
  PRIMARY KEY (instrument_id, value_date)
) STRICT;

-- Evidence captured at decision time: the order book or quote set an execution or refusal was based on.
-- instrument_id in this table names a market line (a row of instruments: 'coindcx:BTCINR', 'amfi:120716'), not the canonical
-- instrument id that accounts and postings carry since v5; never read it as one (D-110; the rename waits for stage S8).
CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  instrument_id TEXT NOT NULL,
  kind TEXT NOT NULL,           -- 'book' | 'quote' | 'nav'
  body_json TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS provider_status (
  provider TEXT PRIMARY KEY,
  state TEXT NOT NULL,          -- 'connecting' | 'live' | 'degraded' | 'down' | 'idle'
  since INTEGER NOT NULL,
  last_ok INTEGER,
  last_error TEXT,
  last_error_at INTEGER,
  messages INTEGER NOT NULL DEFAULT 0,
  reconnects INTEGER NOT NULL DEFAULT 0,
  detail_json TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE TABLE IF NOT EXISTS clock_checks (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  reference TEXT NOT NULL,
  offset_ms REAL NOT NULL,      -- reference clock minus local clock
  uncertainty_ms REAL NOT NULL  -- half the measured round trip
) STRICT;

-- Rates, fees and contractual terms that change rarely. Each row carries its source and the date it was read.
CREATE TABLE IF NOT EXISTS terms (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,           -- 'rate' | 'fee' | 'rule' | 'limit'
  name TEXT NOT NULL,
  value_json TEXT NOT NULL,
  source TEXT NOT NULL,
  source_url TEXT,
  as_of TEXT NOT NULL,
  status TEXT NOT NULL          -- 'verified' | 'unverified' | 'modelled'
) STRICT;

-- ---------------------------------------------------------------- ledger (double entry, append-only)
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  code TEXT NOT NULL,           -- 'bank', 'card', 'pos:coindcx:BTCINR', 'trade:INR', 'clearing:payments'
  kind TEXT NOT NULL,           -- 'asset' | 'liability' | 'income' | 'expense' | 'equity' | 'clearing' | 'trading'
  asset_id TEXT NOT NULL REFERENCES assets(id),
  name TEXT NOT NULL,
  nonneg INTEGER NOT NULL DEFAULT 0, -- 1: natural balance may never go below zero (cash, holdings, debts)
  meta_json TEXT NOT NULL DEFAULT '{}',
  -- Since v5 (ADR-0012, stage S2 of the global money model): the asset's canonical instrument id ('iso4217:INR',
  -- 'claim:paper-crypto/BTC'), written beside asset_id, which readers still use. Not a row of the instruments table.
  instrument_id TEXT,
  UNIQUE (user_id, code)
) STRICT;

CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  seq INTEGER NOT NULL,         -- per-user sequence, gap-free
  ts INTEGER NOT NULL,          -- when it was recorded here
  effective_ts INTEGER NOT NULL,-- when the economic event happened at the venue or rail
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,            -- idempotency key
  memo TEXT NOT NULL,
  meta_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (user_id, ref),
  UNIQUE (user_id, seq)
) STRICT;

-- Amounts in postings, balances and holds (since v6, stage S3 of the global money model, ADR-0012): amount_text is the
-- amount in the instrument's minor units as canonical integer text ("0", or an optional "-" and digits with no leading
-- zero, at most 78 digits: 2^256 - 1, the largest ERC-20 balance), and it is what every reader uses. amount, the INTEGER
-- beside it, is a copy kept by every writer: the same value when it fits 64 bits, NULL when it does not (an 18-decimal
-- token above 9.22 units). The CHECKs, which use SQLite's built-in functions only, refuse a row whose text is not canonical
-- or whose two columns disagree. The text must also hold no NUL byte: GLOB, length and substr stop at the first NUL while
-- CAST and = read past it, so '1' followed by a NUL and anything passed the other tests with the copy NULL (found by the
-- review of 8e9929b). The CHECKs hold unless switched off (PRAGMA ignore_check_constraints, allowed even in defensive mode);
-- verifyLedger's amount-text check and PRAGMA integrity_check report a row written so. SQL sums use amount_sum
-- (server/amount-sql.ts), never SUM: SUM fails past 2^63 - 1 and turns integer text past 64 bits into a float.
-- server/migrate-v6.ts keeps its own copy of these three definitions; server/amount-text-migration.test.ts checks that a
-- migrated database stores them exactly as written here.
CREATE TABLE IF NOT EXISTS postings (
  id INTEGER PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES entries(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  asset_id TEXT NOT NULL,
  amount INTEGER,               -- signed; positive = debit. Since v6 a copy of amount_text, NULL past 64 bits
  instrument_id TEXT,           -- since v5: the account's canonical instrument id, beside asset_id (see accounts)
  amount_text TEXT NOT NULL CHECK (instr(amount_text, char(0)) = 0 AND length(ltrim(amount_text, '-')) <= 78 AND (amount_text = '0' OR ((amount_text GLOB '[1-9]*' OR amount_text GLOB '-[1-9]*') AND NOT (substr(amount_text, 2) GLOB '*[^0-9]*')))),
  CHECK (CASE WHEN CAST(CAST(amount_text AS INTEGER) AS TEXT) = amount_text THEN amount IS CAST(amount_text AS INTEGER) ELSE amount IS NULL END)
) STRICT;
CREATE INDEX IF NOT EXISTS postings_account ON postings(account_id);
CREATE INDEX IF NOT EXISTS postings_entry ON postings(entry_id);

-- Running balances: a cache of the postings' sum kept in the same transaction and checked by reconciliation.
CREATE TABLE IF NOT EXISTS balances (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  amount INTEGER,               -- since v6 a copy of amount_text, NULL past 64 bits
  amount_text TEXT NOT NULL CHECK (instr(amount_text, char(0)) = 0 AND length(ltrim(amount_text, '-')) <= 78 AND (amount_text = '0' OR ((amount_text GLOB '[1-9]*' OR amount_text GLOB '-[1-9]*') AND NOT (substr(amount_text, 2) GLOB '*[^0-9]*')))),
  CHECK (CASE WHEN CAST(CAST(amount_text AS INTEGER) AS TEXT) = amount_text THEN amount IS CAST(amount_text AS INTEGER) ELSE amount IS NULL END)
) STRICT;

CREATE TABLE IF NOT EXISTS holds (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  amount INTEGER CHECK (amount > 0), -- since v6 a copy of amount_text, NULL past 64 bits
  reason TEXT NOT NULL,
  ref TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  released_at INTEGER,
  amount_text TEXT NOT NULL CHECK (instr(amount_text, char(0)) = 0 AND length(amount_text) <= 78 AND amount_text GLOB '[1-9]*' AND NOT (amount_text GLOB '*[^0-9]*')),
  CHECK (CASE WHEN CAST(CAST(amount_text AS INTEGER) AS TEXT) = amount_text THEN amount IS CAST(amount_text AS INTEGER) ELSE amount IS NULL END),
  UNIQUE (user_id, ref)
) STRICT;

-- Open tax lots, first in first out. cost is in the quote asset's atoms and includes purchase charges.
-- instrument_id in this table names a market line (a row of instruments: 'coindcx:BTCINR', 'amfi:120716'), not the canonical
-- instrument id that accounts and postings carry since v5; never read it as one (D-110; the rename waits for stage S8).
CREATE TABLE IF NOT EXISTS lots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  qty INTEGER NOT NULL,
  remaining INTEGER NOT NULL,
  cost INTEGER NOT NULL,
  entry_id TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS lots_open ON lots(user_id, instrument_id, opened_at);

-- instrument_id in this table names a market line (a row of instruments: 'coindcx:BTCINR', 'amfi:120716'), not the canonical
-- instrument id that accounts and postings carry since v5; never read it as one (D-110; the rename waits for stage S8).
CREATE TABLE IF NOT EXISTS realised (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  qty INTEGER NOT NULL,
  proceeds INTEGER NOT NULL,
  cost INTEGER NOT NULL,
  opened_at INTEGER NOT NULL,
  entry_id TEXT NOT NULL
) STRICT;

CREATE TRIGGER IF NOT EXISTS entries_no_update BEFORE UPDATE ON entries BEGIN SELECT RAISE(ABORT, 'ledger entries are append-only'); END;
CREATE TRIGGER IF NOT EXISTS entries_no_delete BEFORE DELETE ON entries BEGIN SELECT RAISE(ABORT, 'ledger entries are append-only'); END;
CREATE TRIGGER IF NOT EXISTS postings_no_update BEFORE UPDATE ON postings BEGIN SELECT RAISE(ABORT, 'ledger postings are append-only'); END;
CREATE TRIGGER IF NOT EXISTS postings_no_delete BEFORE DELETE ON postings BEGIN SELECT RAISE(ABORT, 'ledger postings are append-only'); END;

-- ---------------------------------------------------------------- household objects
CREATE TABLE IF NOT EXISTS payees (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  handle TEXT NOT NULL,         -- UPI-style address or account reference (paper)
  category TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  verified_at INTEGER,
  -- v8: what the paper bank's name check answered when the payee was added (server/name-check.ts): 'match' | 'close' |
  -- 'no_match' | 'unknown' (an address it does not know) | 'no_answer'; NULL for a payee added before the check existed
  name_check TEXT,
  registered_name TEXT,         -- v8: the name the paper bank holds for the address, on a match or a close match only
  UNIQUE (user_id, handle)
) STRICT;

CREATE TABLE IF NOT EXISTS bills (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  payee_id TEXT NOT NULL REFERENCES payees(id),
  amount INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  memo TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL,          -- 'due' | 'scheduled' | 'paying' | 'paid' | 'failed' | 'cancelled'
  action_id TEXT,
  created_at INTEGER NOT NULL
) STRICT;
-- v8 part (k), lead L-09: one tenant's bills without reading every tenant's
CREATE INDEX IF NOT EXISTS bills_user ON bills(user_id);

CREATE TABLE IF NOT EXISTS earn_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  client TEXT NOT NULL,
  state TEXT NOT NULL,          -- 'open' | 'complete' | 'disputed' | 'cancelled'
  created_at INTEGER NOT NULL,
  meta_json TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE TABLE IF NOT EXISTS earn_milestones (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES earn_jobs(id),
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  amount INTEGER NOT NULL,
  -- paper: 'proposed' | 'funded' | 'submitted' | 'refund-asked' | 'disputed' | 'released' | 'refunded' | 'split'
  -- (server/escrow.ts); on the chain every state begins with 'chain-' (server/earn-chain.ts)
  state TEXT NOT NULL,
  evidence_hash TEXT,
  updated_at INTEGER NOT NULL,
  -- Since v8: when the paper escrow's next default applies to this milestone under its accepted terms (the end of the
  -- client's review, of the earner's time to answer a refund, or of a dispute's evidence or decision period), worked out
  -- from those terms and the step that started the period; a cache the engine checks against both before it acts. NULL:
  -- nothing happens on its own. Never set on the chain's milestones, whose deadlines are the escrow contract's own.
  due_at INTEGER,
  -- Since v8 (R13): the terms both sides accepted for this milestone (earn_terms). NULL: a milestone from before terms were
  -- recorded, which keeps the terms it was opened on: no deadline and no default until both sides agree terms.
  terms_id TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS earn_milestones_due ON earn_milestones(due_at) WHERE due_at IS NOT NULL;
-- accepted terms are bound to the milestone for good: they can be given once and never replaced or taken away
CREATE TRIGGER IF NOT EXISTS earn_milestones_terms_fixed BEFORE UPDATE OF terms_id ON earn_milestones WHEN OLD.terms_id IS NOT NULL AND NEW.terms_id IS NOT OLD.terms_id BEGIN SELECT RAISE(ABORT, 'accepted escrow terms cannot be replaced'); END;

-- Since v8 (R13 section 2): the terms of paper escrow, exactly as shown before they were accepted: every deadline as a
-- period, what happens when each runs out, the delivery date, who plays each role and what the simulated mediator may do
-- (server/escrow.ts Terms), as canonical JSON with its SHA-256. A job's terms (milestone_id NULL) or, for a milestone from
-- before terms were recorded, the terms its two sides agreed later. In force once both sides have accepted that hash
-- (earn_terms_accepts). Append-only: changed terms are new terms.
CREATE TABLE IF NOT EXISTS earn_terms (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES earn_jobs(id),
  milestone_id TEXT REFERENCES earn_milestones(id),
  version INTEGER NOT NULL,
  terms_json TEXT NOT NULL,
  hash TEXT NOT NULL,
  proposed_by TEXT NOT NULL,    -- 'earner' | 'client'
  proposed_at INTEGER NOT NULL,
  person_id TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS earn_terms_job ON earn_terms(job_id, milestone_id);
-- Each side's acceptance of one set of terms, who accepted it and when: on paper the household plays both sides.
CREATE TABLE IF NOT EXISTS earn_terms_accepts (
  terms_id TEXT NOT NULL REFERENCES earn_terms(id),
  side TEXT NOT NULL,           -- 'earner' | 'client'
  person_id TEXT,
  at INTEGER NOT NULL,
  PRIMARY KEY (terms_id, side)
) STRICT;
CREATE TRIGGER IF NOT EXISTS earn_terms_no_update BEFORE UPDATE ON earn_terms BEGIN SELECT RAISE(ABORT, 'escrow terms are append-only'); END;
CREATE TRIGGER IF NOT EXISTS earn_terms_no_delete BEFORE DELETE ON earn_terms BEGIN SELECT RAISE(ABORT, 'escrow terms are append-only'); END;
CREATE TRIGGER IF NOT EXISTS earn_terms_accepts_no_update BEFORE UPDATE ON earn_terms_accepts BEGIN SELECT RAISE(ABORT, 'escrow terms are append-only'); END;
CREATE TRIGGER IF NOT EXISTS earn_terms_accepts_no_delete BEFORE DELETE ON earn_terms_accepts BEGIN SELECT RAISE(ABORT, 'escrow terms are append-only'); END;

-- Since v8 (R12 task comparison, gap 16): a dispute over a paper milestone, raised by either side with a reason (the client
-- against submitted work, the earner against the client taking the money back). Its decider is a simulated mediator played
-- by the household, or the stated rule when a side stays silent or no decision comes (server/escrow.ts). Amounts in exact
-- paise; the money stays in escrow until it is decided. One per milestone: every outcome is final.
CREATE TABLE IF NOT EXISTS earn_disputes (
  id TEXT PRIMARY KEY,
  milestone_id TEXT NOT NULL UNIQUE REFERENCES earn_milestones(id),
  user_id TEXT NOT NULL,
  raised_by TEXT NOT NULL,      -- 'client' | 'earner'
  against TEXT NOT NULL,        -- 'work' | 'refund'
  reason TEXT NOT NULL,
  raised_at INTEGER NOT NULL,
  evidence_due_at INTEGER NOT NULL,
  decide_by INTEGER NOT NULL,
  heard_at INTEGER,             -- when the side that did not raise it first answered: both sides are then heard
  state TEXT NOT NULL,          -- 'open' | 'decided'
  outcome TEXT,                 -- 'released' | 'refunded' | 'split'
  earner_paise INTEGER,
  client_paise INTEGER,
  decided_by TEXT,              -- 'mediator' | 'rule' | 'client' | 'earner' (a side that gave way)
  decided_at INTEGER
) STRICT;

-- Since v8: every step on a paper milestone, the role it was taken in and when: 'earner', 'client' (the paper client),
-- 'mediator' (the simulated mediator) or 'rule' (the escrow applying its accepted terms at a deadline); person_id is the
-- member who took it (in a personal workspace the household plays every role). Append-only, as the ledger is.
CREATE TABLE IF NOT EXISTS earn_steps (
  id INTEGER PRIMARY KEY,
  milestone_id TEXT NOT NULL REFERENCES earn_milestones(id),
  user_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  step TEXT NOT NULL,
  person_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE INDEX IF NOT EXISTS earn_steps_milestone ON earn_steps(milestone_id, id);
CREATE TRIGGER IF NOT EXISTS earn_steps_no_update BEFORE UPDATE ON earn_steps BEGIN SELECT RAISE(ABORT, 'earning steps are append-only'); END;
CREATE TRIGGER IF NOT EXISTS earn_steps_no_delete BEFORE DELETE ON earn_steps BEGIN SELECT RAISE(ABORT, 'earning steps are append-only'); END;

-- ---------------------------------------------------------------- programs (versioned standing instructions)
CREATE TABLE IF NOT EXISTS programs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  pillar TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL,          -- 'draft' | 'active' | 'paused' | 'completed' | 'revoked' | 'expired'
  live_version INTEGER,
  next_due_at INTEGER,
  paused_reason TEXT,
  memo_json TEXT NOT NULL DEFAULT '{}', -- small working state a program keeps between runs (for example a trailing high)
  origin TEXT NOT NULL,         -- 'owner' | 'proposal:<id>'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS programs_due ON programs(state, next_due_at);
-- v8 part (k), R13 review lead L-09: one tenant's instructions are found without reading every tenant's
CREATE INDEX IF NOT EXISTS programs_user ON programs(user_id);

CREATE TABLE IF NOT EXISTS program_versions (
  program_id TEXT NOT NULL REFERENCES programs(id),
  version INTEGER NOT NULL,
  params_json TEXT NOT NULL,
  authority_json TEXT NOT NULL,
  analysis_json TEXT NOT NULL,
  document TEXT NOT NULL,       -- the exact authorisation text shown to the owner
  content_hash TEXT NOT NULL,   -- SHA-256 over kind, params, authority and document
  state TEXT NOT NULL,          -- 'draft' | 'live' | 'superseded' | 'discarded'
  created_at INTEGER NOT NULL,
  approved_at INTEGER,
  approval_id TEXT,
  PRIMARY KEY (program_id, version)
) STRICT;

CREATE TABLE IF NOT EXISTS program_events (
  id INTEGER PRIMARY KEY,
  program_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE INDEX IF NOT EXISTS program_events_p ON program_events(program_id, id);

-- An approval binds the owner's confirmation to one exact document (its hash), once, before it expires.
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  purpose TEXT NOT NULL,        -- 'program-version' | 'run' | 'action' | 'revoke' | 'profile'
  subject TEXT NOT NULL,
  document TEXT NOT NULL,
  doc_hash TEXT NOT NULL,
  nonce TEXT NOT NULL,
  requires_stepup INTEGER NOT NULL DEFAULT 1, -- 1: the password must be re-entered (or have been within five minutes)
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  method TEXT,                  -- 'password' | 'passkey' | 'session'
  evidence_json TEXT,
  session_hash TEXT,
  consumed_at INTEGER,
  cancelled_at INTEGER,
  approver_id TEXT,             -- the person whose signature completed it (the workspace is user_id)
  created_by TEXT,              -- the person who prepared it (maker); in a business workspace their own signature does not count
  required_signers INTEGER NOT NULL DEFAULT 1, -- distinct members whose passkeys must sign before it takes effect
  size_paise INTEGER            -- v8 (r): the size the request was measured at when made (NULL before: read from its document)
) STRICT;

-- Each member's passkey signature on an approval. An approval takes effect when enough distinct members have signed.
CREATE TABLE IF NOT EXISTS approval_signatures (
  approval_id TEXT NOT NULL REFERENCES approvals(id),
  person_id TEXT NOT NULL REFERENCES users(id),
  credential_id TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  signed_at INTEGER NOT NULL,
  PRIMARY KEY (approval_id, person_id)
) STRICT;
CREATE INDEX IF NOT EXISTS approvals_subject ON approvals(user_id, subject);

-- How the session that prepared something was opened, and when (RISK-076): payees, bills, instruction drafts (one row
-- per saved version) and approval requests. Read from the session's own record (sessions.auth_method), never from the
-- request; written once, when the thing is made, and never changed or removed. A row of a password session becomes a
-- sentence in the document the passkey signs (server/prepared.ts). Nothing made outside a request (the engine's own
-- work) has a row.
CREATE TABLE IF NOT EXISTS prepared (
  kind TEXT NOT NULL,           -- 'payee' | 'bill' | 'program-version' | 'approval'
  subject TEXT NOT NULL,        -- the payee, bill or approval id; '<program id>@<version>' for a draft
  workspace_id TEXT NOT NULL,
  person_id TEXT NOT NULL,      -- who was signed in
  method TEXT NOT NULL,         -- how that session was opened: 'password' | 'passkey' | 'signin-passkey' (a passkey that signs in only, R12)
  session TEXT NOT NULL,        -- the session's id as Security lists it (the first 12 characters of its hash)
  at INTEGER NOT NULL,
  PRIMARY KEY (kind, subject)
) STRICT;
CREATE TRIGGER IF NOT EXISTS prepared_no_update BEFORE UPDATE ON prepared BEGIN SELECT RAISE(ABORT, 'prepared is append-only'); END;
CREATE TRIGGER IF NOT EXISTS prepared_no_delete BEFORE DELETE ON prepared BEGIN SELECT RAISE(ABORT, 'prepared is append-only'); END;

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  program_id TEXT NOT NULL REFERENCES programs(id),
  version INTEGER NOT NULL,
  occurrence TEXT NOT NULL,     -- claim key, scoped to the program lineage
  state TEXT NOT NULL,          -- 'due' | 'awaiting_approval' | 'objection_window' | 'executing' | 'done' | 'partial'
                                -- | 'failed' | 'blocked' | 'skipped' | 'cancelled' | 'expired' | 'missed'
  trigger_json TEXT NOT NULL DEFAULT '{}',
  due_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  deadline_at INTEGER,          -- approval or objection deadline
  reason TEXT,
  decision_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (program_id, occurrence)
) STRICT;
CREATE INDEX IF NOT EXISTS runs_state ON runs(state);
CREATE INDEX IF NOT EXISTS runs_user ON runs(user_id, created_at);

-- One economic effect the wallet wants: an order, a payment, an internal transfer.
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  run_id TEXT,
  program_id TEXT,
  origin TEXT NOT NULL,         -- 'program' | 'owner'
  kind TEXT NOT NULL,           -- 'order' | 'payment' | 'transfer'
  venue TEXT NOT NULL,          -- 'paper-crypto' | 'paper-mf' | 'paper-rail' | 'paper-bank'
  economic_id TEXT NOT NULL,    -- idempotency key, also sent to the venue as the client reference
  state TEXT NOT NULL,          -- 'planned' | 'held' | 'blocked' | 'awaiting_approval' | 'submitting' | 'working' | 'done'
                                -- | 'partial' | 'rejected' | 'failed' | 'cancelled' | 'expired' ('held': a payment to a new
                                -- payee waiting until its signed terms' time, its money set aside; server/new-payee.ts)
  params_json TEXT NOT NULL,
  policy_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT NOT NULL DEFAULT '{}',
  times_json TEXT NOT NULL DEFAULT '{}',
  recon_state TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'reconciled' | 'break' | 'not_applicable'
  receipt_id TEXT,
  approval_id TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, economic_id)
) STRICT;
CREATE INDEX IF NOT EXISTS actions_state ON actions(state);
CREATE INDEX IF NOT EXISTS actions_user ON actions(user_id, created_at);
CREATE INDEX IF NOT EXISTS actions_run ON actions(run_id);
-- v8 part (k), lead L-09: an instruction's actions without reading every tenant's
CREATE INDEX IF NOT EXISTS actions_program ON actions(program_id);

-- ---------------------------------------------------------------- paper venues (their own books; the wallet
-- reads them only through the venue adapter, exactly as it would read a broker or a rail)
-- instrument_id in this table names a market line (a row of instruments: 'coindcx:BTCINR', 'amfi:120716'), not the canonical
-- instrument id that accounts and postings carry since v5; never read it as one (D-110; the rename waits for stage S8).
CREATE TABLE IF NOT EXISTS pv_orders (
  id TEXT PRIMARY KEY,
  venue TEXT NOT NULL,
  client_ref TEXT NOT NULL,
  user_id TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  side TEXT NOT NULL,           -- 'buy' | 'sell'
  type TEXT NOT NULL,           -- 'market' | 'limit' | 'stop' | 'nav'
  qty INTEGER,                  -- base atoms, or NULL when the order is by amount
  amount INTEGER,               -- quote atoms, or NULL when the order is by quantity
  limit_price TEXT,
  stop_price TEXT,
  max_slippage_bps INTEGER,
  state TEXT NOT NULL,          -- 'new' | 'accepted' | 'funded' | 'filled' | 'partially_filled' | 'rejected' | 'cancelled' | 'expired'
                                -- ('funded': a fund purchase whose money the fund house has received; since v8)
  reject_reason TEXT,
  filled_qty INTEGER NOT NULL DEFAULT 0,
  filled_amount INTEGER NOT NULL DEFAULT 0,
  fees INTEGER NOT NULL DEFAULT 0,
  taxes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  meta_json TEXT NOT NULL DEFAULT '{}',
  funds_at INTEGER,             -- when the fund house received a purchase's money (paper-mf buys; since v8, added by its step)
  UNIQUE (venue, client_ref)
) STRICT;
CREATE INDEX IF NOT EXISTS pv_orders_state ON pv_orders(venue, state);

-- instrument_id in this table names a market line (a row of instruments: 'coindcx:BTCINR', 'amfi:120716'), not the canonical
-- instrument id that accounts and postings carry since v5; never read it as one (D-110; the rename waits for stage S8).
CREATE TABLE IF NOT EXISTS pv_fills (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES pv_orders(id),
  user_id TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  side TEXT NOT NULL,
  ts INTEGER NOT NULL,          -- when the paper venue executed it
  effective_date TEXT,          -- NAV date for fund orders
  qty INTEGER NOT NULL,
  price TEXT NOT NULL,
  amount INTEGER NOT NULL,      -- gross consideration in quote atoms
  fee INTEGER NOT NULL,
  tax INTEGER NOT NULL,
  cash_at INTEGER,              -- when cash moves (payout date for fund redemptions)
  cash_done INTEGER NOT NULL DEFAULT 0,
  snapshot_id TEXT,
  note TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS pv_fills_order ON pv_fills(order_id);

CREATE TABLE IF NOT EXISTS pv_payments (
  id TEXT PRIMARY KEY,
  client_ref TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  rail TEXT NOT NULL,           -- 'upi' | 'imps' | 'neft' | 'rtgs' | 'internal'
  payee_handle TEXT NOT NULL,
  amount INTEGER NOT NULL,
  state TEXT NOT NULL,          -- 'pending' | 'settled' | 'failed' | 'reversed' | 'unknown'
  reason TEXT,
  reference TEXT,               -- rail reference shown to the owner (paper)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolve_at INTEGER,
  meta_json TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE INDEX IF NOT EXISTS pv_payments_state ON pv_payments(state);

-- ---------------------------------------------------------------- evidence
CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  seq INTEGER NOT NULL,         -- per-user chain position
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_json TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  UNIQUE (user_id, seq)
) STRICT;
CREATE TRIGGER IF NOT EXISTS receipts_no_update BEFORE UPDATE ON receipts BEGIN SELECT RAISE(ABORT, 'receipts are append-only'); END;
CREATE TRIGGER IF NOT EXISTS receipts_no_delete BEFORE DELETE ON receipts BEGIN SELECT RAISE(ABORT, 'receipts are append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;

CREATE TABLE IF NOT EXISTS recon_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  checked_json TEXT NOT NULL,
  breaks_json TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS recon_user ON recon_runs(user_id, ts);

-- The on-chain wallet in the books (R13, RISK-084; server/chain-books.ts). Since v8 (part d of the v7 to v8 step).
-- chain_books: one row per household and network: how far its wallet's movements are booked (every movement up to
-- cursor_block is booked, and cursor_hash is that block's hash then: if the chain later holds another block there, blocks
-- were reorganised away), which chain it was kept against, the backfill a household with history needs ('needed', set by
-- the v7 to v8 step; 'done'), a lease so that one sync runs at a time across the API and the engine, and the last comparison.
CREATE TABLE IF NOT EXISTS chain_books (
  user_id TEXT NOT NULL,
  network TEXT NOT NULL,            -- 'eip155:31337'
  rail_workspace TEXT,
  genesis_id TEXT,                  -- the chain the books are kept against: a new one is never booked silently
  cursor_block INTEGER NOT NULL DEFAULT -1,
  cursor_hash TEXT,
  backfill TEXT,                    -- 'needed' | 'done' | NULL (a wallet set up since v8)
  backfill_at INTEGER,
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  synced_at INTEGER,
  compared_at INTEGER,
  compare_state TEXT,               -- 'agrees' | 'disagrees' | 'unknown'
  compare_json TEXT,
  PRIMARY KEY (user_id, network)
) STRICT;
-- chain_movements: every movement booked, by transaction hash and log index in its block. At most one live booking of a
-- log per household (the partial unique index), so no path can book it twice; a booking whose block is reorganised away
-- is reversed by a new ledger entry and marked here, never deleted.
CREATE TABLE IF NOT EXISTS chain_movements (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  network TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  block_ts INTEGER NOT NULL,        -- ms, the block's time: the entry's effective time
  kind TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  amount_text TEXT NOT NULL,
  entry_id TEXT NOT NULL,           -- the ledger entry that booked it
  posted_at INTEGER NOT NULL,       -- the entry time
  source TEXT NOT NULL,             -- 'sync' | 'backfill'
  reversed_at INTEGER,
  reversal_entry_id TEXT,
  UNIQUE (user_id, network, tx_hash, log_index, block_hash)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS chain_movements_live ON chain_movements(user_id, network, tx_hash, log_index) WHERE reversed_at IS NULL;
CREATE INDEX IF NOT EXISTS chain_movements_block ON chain_movements(user_id, network, block_number);
CREATE TRIGGER IF NOT EXISTS chain_movements_no_delete BEFORE DELETE ON chain_movements BEGIN SELECT RAISE(ABORT, 'chain movements are kept'); END;
CREATE TRIGGER IF NOT EXISTS chain_movements_reverse_once BEFORE UPDATE ON chain_movements
  WHEN OLD.reversed_at IS NOT NULL OR NEW.tx_hash IS NOT OLD.tx_hash OR NEW.log_index IS NOT OLD.log_index OR NEW.block_hash IS NOT OLD.block_hash OR NEW.entry_id IS NOT OLD.entry_id OR NEW.amount_text IS NOT OLD.amount_text OR NEW.asset_id IS NOT OLD.asset_id
  BEGIN SELECT RAISE(ABORT, 'a chain movement is only ever marked reversed, once'); END;
-- chain_closings (R13, part q of the v7 to v8 step): the owner-approved closing of the books of a chain the wallet service
-- no longer runs (its data folder was replaced). Never automatic: one row for each closing, written in the same transaction
-- as the closing ledger entry, with who approved it (a passkey-confirmed approval of the shown preview), the two chains,
-- the balances closed and the bookings taken out of the live set; never changed or deleted.
CREATE TABLE IF NOT EXISTS chain_closings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  network TEXT NOT NULL,
  old_genesis TEXT NOT NULL,
  new_genesis TEXT NOT NULL,
  closed_at INTEGER NOT NULL,
  approved_by TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  approval_method TEXT NOT NULL,     -- 'passkey'
  entry_id TEXT,                     -- the closing ledger entry (NULL when every balance was already nothing)
  figures_json TEXT NOT NULL,        -- per account: what the books held of each token on the old chain, now closed
  movements INTEGER NOT NULL,        -- live bookings of the old chain taken out of the live set
  digest TEXT NOT NULL               -- the preview's digest the owner approved
) STRICT;
CREATE INDEX IF NOT EXISTS chain_closings_user ON chain_closings(user_id, closed_at);
CREATE TRIGGER IF NOT EXISTS chain_closings_no_update BEFORE UPDATE ON chain_closings BEGIN SELECT RAISE(ABORT, 'chain closings are append-only'); END;
CREATE TRIGGER IF NOT EXISTS chain_closings_no_delete BEFORE DELETE ON chain_closings BEGIN SELECT RAISE(ABORT, 'chain closings are append-only'); END;
-- chain_recon: each comparison of the books with the wallet service's balances whose result or figures changed. A
-- disagreement is an error state with its figures; it is kept (append-only), and a later agreement is a new row beside it.
CREATE TABLE IF NOT EXISTS chain_recon (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  network TEXT NOT NULL,
  ts INTEGER NOT NULL,
  state TEXT NOT NULL,              -- 'agrees' | 'disagrees' | 'unknown'
  block_number INTEGER,
  figures_json TEXT NOT NULL,       -- per asset: books, in flight, chain, difference
  why TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS chain_recon_user ON chain_recon(user_id, ts);
CREATE TRIGGER IF NOT EXISTS chain_recon_no_update BEFORE UPDATE ON chain_recon BEGIN SELECT RAISE(ABORT, 'chain reconciliation is append-only'); END;
CREATE TRIGGER IF NOT EXISTS chain_recon_no_delete BEFORE DELETE ON chain_recon BEGIN SELECT RAISE(ABORT, 'chain reconciliation is append-only'); END;

CREATE TABLE IF NOT EXISTS disputes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  state TEXT NOT NULL,          -- 'open' | 'resolved_refund' | 'resolved_upheld' | 'withdrawn'
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolution TEXT
) STRICT;

-- ---------------------------------------------------------------- model proposals
CREATE TABLE IF NOT EXISTS ai_calls (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  question TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  output_json TEXT,
  ok INTEGER NOT NULL,
  error TEXT,
  latency_ms INTEGER,
  usage_json TEXT,
  conversation_id TEXT,
  sent_json TEXT                -- what was sent besides the snapshot: earlier turns and the question, as sent (tokens, not names)
) STRICT;

-- Every request Ask makes to the Anthropic API (R13, part (w) of the v8 step; server/ask-models.ts): which model was asked,
-- which answered, the tokens the response reported and what they cost at the published prices. A row is written before
-- the request with the most it can cost (reserved) and settled after it, so the spending limits count calls in flight and
-- survive a restart: a row still 'reserved' counts at its reserved amount. No question, answer or prompt text is kept here.
CREATE TABLE IF NOT EXISTS ai_attempts (
  id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL,              -- the ai_calls row of the question (written after the attempts; failed questions too)
  n INTEGER NOT NULL,                 -- 1, 2, 3: the order of the attempts for one question
  user_id TEXT NOT NULL,              -- the workspace
  person_id TEXT NOT NULL,
  session_key TEXT NOT NULL,          -- a one-way digest of the sign-in session (never its token or the stored hash)
  tier TEXT NOT NULL CHECK (tier IN ('demanding', 'routine')),
  model_requested TEXT NOT NULL,
  model_answered TEXT,                -- from the response, not the request; NULL when no response came
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'settled')),
  outcome TEXT,                       -- answered, refused, unusable, not_found, overloaded, rate_limited, server_error, timeout, connection, bad_request, permission, auth, billing, error, interrupted
  http_status INTEGER,
  request_id TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  reserved_micros INTEGER NOT NULL CHECK (reserved_micros >= 0),   -- US$ millionths: the most this request could cost
  cost_micros INTEGER CHECK (cost_micros IS NULL OR cost_micros >= 0), -- what it cost, once settled
  cost_basis TEXT,                    -- usage (priced from the response), reserved (no response: the most it could cost is kept), none (refused by the API before it ran)
  latency_ms INTEGER,
  detail_json TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE INDEX IF NOT EXISTS ai_attempts_started ON ai_attempts(started_at);
CREATE INDEX IF NOT EXISTS ai_attempts_person ON ai_attempts(person_id, started_at);
CREATE INDEX IF NOT EXISTS ai_attempts_session ON ai_attempts(session_key);
CREATE INDEX IF NOT EXISTS ai_attempts_call ON ai_attempts(call_id);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  ai_call_id TEXT,
  ts INTEGER NOT NULL,
  origin TEXT NOT NULL,         -- 'model' | 'rules'
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  rationale TEXT NOT NULL,
  params_json TEXT NOT NULL,
  analysis_json TEXT NOT NULL,
  state TEXT NOT NULL,          -- 'new' | 'drafted' | 'dismissed' | 'invalid' | 'superseded' | 'review' | 'declined' (N-006)
  invalid_reason TEXT,
  conversation_id TEXT,
  turn_id TEXT,
  supersedes TEXT,              -- the earlier proposal this one replaces after the owner corrected it
  superseded_by TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS proposals_user ON proposals(user_id, ts);

-- N-006, a production setting (QED_ADVISER_REVIEW=1): a model's investment proposal waits here for a registered
-- investment adviser's review before it can be opened or signed. Off in this build.
CREATE TABLE IF NOT EXISTS adviser_reviews (
  proposal_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  state TEXT NOT NULL,          -- 'pending' | 'approved' | 'declined'
  reviewer TEXT,                -- the adviser's name and SEBI registration, as they gave them
  registration TEXT,
  note TEXT,
  decided_at INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS adviser_reviews_state ON adviser_reviews(state, requested_at);
CREATE INDEX IF NOT EXISTS proposals_conversation ON proposals(conversation_id);

-- Ask as a conversation: each turn is the owner's words and what answered them (the model, or QED's own code for a
-- cancellation). A conversation belongs to one person acting in one workspace.
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,        -- the workspace
  person_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS conversations_person ON conversations(user_id, person_id, updated_at);

CREATE TABLE IF NOT EXISTS conversation_turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  ts INTEGER NOT NULL,
  question TEXT NOT NULL,
  kind TEXT NOT NULL,           -- 'model' | 'cancel'
  ai_call_id TEXT,
  answer TEXT,                  -- as shown: tokens mapped back to names
  refusal TEXT,
  questions_json TEXT NOT NULL DEFAULT '[]',
  cites_json TEXT NOT NULL DEFAULT '[]',
  grounding_json TEXT NOT NULL DEFAULT '{}',
  links_json TEXT NOT NULL DEFAULT '[]',
  withdrawn_json TEXT NOT NULL DEFAULT '[]',
  superseded_json TEXT NOT NULL DEFAULT '[]',
  engine_json TEXT NOT NULL DEFAULT '{}',
  clarify_json TEXT NOT NULL DEFAULT '[]'   -- structured questions: offered choices and whether a typed answer is allowed (v8 part i)
) STRICT;
CREATE INDEX IF NOT EXISTS conversation_turns_conversation ON conversation_turns(conversation_id, ts);

-- ---------------------------------------------------------------- operations
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  user_id TEXT,                 -- NULL: visible to every signed-in user (market and system events)
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE TABLE IF NOT EXISTS heartbeats (
  service TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  beat_at INTEGER NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE TABLE IF NOT EXISTS downtime (
  id INTEGER PRIMARY KEY,
  service TEXT NOT NULL,
  from_ts INTEGER NOT NULL,
  to_ts INTEGER NOT NULL,
  missed_runs INTEGER NOT NULL DEFAULT 0,
  note TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS notices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL,          -- 'action' | 'warning' | 'info'
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  subject TEXT,
  dedupe TEXT,
  read_at INTEGER,
  resolved_at INTEGER,
  UNIQUE (user_id, dedupe)
) STRICT;
CREATE INDEX IF NOT EXISTS notices_user ON notices(user_id, resolved_at, ts);

-- How each notice reaches its person (server/notify.ts; R10-006): its urgency, when it is surfaced as new (a warning
-- raised in the owner's quiet hours waits for them to end; info waits for the daily digest), when it was acknowledged
-- and when it was escalated for want of an acknowledgement. One row per notice, made by the engine's tick.
CREATE TABLE IF NOT EXISTS notice_delivery (
  notice_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  urgency TEXT NOT NULL,        -- 'critical' | 'action' | 'warning' | 'info'
  surface_at INTEGER NOT NULL,
  acked_at INTEGER,
  escalated_at INTEGER,
  digest_id TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS notice_delivery_user ON notice_delivery(user_id, surface_at);
CREATE TABLE IF NOT EXISTS notify_prefs (
  user_id TEXT PRIMARY KEY,
  quiet_from TEXT,              -- 'HH:MM' Indian time, or NULL for no quiet hours
  quiet_to TEXT,
  digest_at TEXT NOT NULL,
  escalate_min INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS digests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  from_ts INTEGER NOT NULL,
  body_json TEXT NOT NULL       -- [{ kind, title, count, first, last }]
) STRICT;

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
) STRICT;

-- Investment ideas (R13, Grow's central journey; server/ideas.ts): an idea as the owner wrote it, the investigation of
-- it on the household's books and the recorded prices (kept whole, with its hash, as it was shown), the owner's
-- decision and why, and what that decision handed to the approval flows (an order's approval, or an instruction).
-- Whether anything was signed or ran is read from those flows, never stored twice.
CREATE TABLE IF NOT EXISTS ideas (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  text TEXT NOT NULL,
  title TEXT NOT NULL,
  investigation_json TEXT NOT NULL,
  investigation_hash TEXT NOT NULL,
  state TEXT NOT NULL,          -- 'open' | 'awaiting-signature' | 'declined' | 'no-action'
  choice TEXT,                  -- 'order' | 'instruction' | 'alt:liquid' | 'alt:spread' | 'reject' | 'nothing'
  reason TEXT,
  decided_at INTEGER,
  approval_id TEXT,
  program_id TEXT,
  revises TEXT,                 -- the idea this one revises
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS ideas_user ON ideas(user_id, created_at);
CREATE TABLE IF NOT EXISTS idea_events (
  idea_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,           -- 'investigated' | 'decided' | 'revised'
  says TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idea_events_idea ON idea_events(idea_id, at);
-- Incidents (R13, RE6, schema v8 part e): a fault of the engine, the wallet service, readiness or reconciliation, from the
-- time it opened to its resolution, with its timeline and what it affected (server/incidents.ts). New tables only.
CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,                -- what it is about; at most one open incident per key
  source TEXT NOT NULL,             -- 'engine' | 'wallet-service' | 'readiness' | 'reconciliation' | 'api'
  title TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolution TEXT,
  affected_json TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS incidents_one_open ON incidents (key) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS incidents_opened ON incidents (opened_at DESC);
CREATE TABLE IF NOT EXISTS incident_events (
  id INTEGER PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  ts INTEGER NOT NULL,
  event TEXT NOT NULL,
  detail TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS incident_events_incident ON incident_events (incident_id, id);
-- ---------------------------------------------------------------- Spend: subscriptions, revocation, duplicates (R13, v8 part f)
-- A person's review of a recurring payment QED found (server/subscriptions.ts). One row per payee address and cadence key.
--   'stopped'        QED's own instruction or paper mandate for it was ended (a tightening, so at once)
--   'cancel-myself'  the person says they must cancel it with the merchant; QED cannot cancel a third party's subscription
CREATE TABLE IF NOT EXISTS subscription_reviews (
  user_id TEXT NOT NULL,
  payee_handle TEXT NOT NULL,
  state TEXT NOT NULL,          -- 'stopped' | 'cancel-myself'
  note TEXT NOT NULL DEFAULT '',
  reviewed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, payee_handle)
) STRICT;

-- The paper bank's standing debit mandates (a simulated institution): one for an instruction that pays bills, registered
-- when the instruction goes live and ended when it is revoked, with the bank's own reference and answer (server/revocation.ts).
CREATE TABLE IF NOT EXISTS paper_mandates (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  reference TEXT NOT NULL,      -- the paper bank's reference for the mandate
  state TEXT NOT NULL,          -- 'active' | 'revoked'
  registered_at INTEGER NOT NULL,
  revoked_at INTEGER,           -- when the bank acknowledged the revocation
  UNIQUE (user_id, program_id)
) STRICT;

-- One revocation of an instruction, and one row per channel it reaches, each with the answer that channel gave and when.
CREATE TABLE IF NOT EXISTS revocations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL,   -- 'instruction'
  subject_id TEXT NOT NULL,
  title TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  UNIQUE (user_id, subject_kind, subject_id)
) STRICT;
CREATE TABLE IF NOT EXISTS revocation_channels (
  revocation_id TEXT NOT NULL REFERENCES revocations(id),
  channel TEXT NOT NULL,        -- 'instruction' | 'scheduled' | 'paper-bank' | 'chain'
  state TEXT NOT NULL,          -- 'acknowledged' | 'no-answer' | 'needs-you' | 'sent'
  asked_at INTEGER NOT NULL,
  answered_at INTEGER,          -- when the channel acknowledged; NULL until it did
  reference TEXT,               -- the channel's own reference for its answer
  detail TEXT NOT NULL DEFAULT '',
  simulated INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (revocation_id, channel)
) STRICT;
-- ---------------------------------------------------------------- R13: the person's data rights (server/records.ts)
-- v8, part (g). A person's own key (AES-256-GCM, 32 bytes): the sealed details of their access log are written under it, and
-- deleting the account overwrites and clears it (destroyed_at set), after which those details cannot be read.
CREATE TABLE IF NOT EXISTS person_keys (
  person_id TEXT PRIMARY KEY,
  key BLOB,
  created_at INTEGER NOT NULL,
  destroyed_at INTEGER
) STRICT;
-- When the account was used, how, and (sealed under the person's key) from where. Shown to the person for a year.
CREATE TABLE IF NOT EXISTS access_log (
  id INTEGER PRIMARY KEY,
  person_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,           -- 'sign-in' | 'step-up' | 'export' | 'deletion-requested' | 'deletion-cancelled'
  detail_sealed TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS access_log_person ON access_log(person_id, ts);
-- That an account was erased, when, what its records are kept until, and what was done to each table.
CREATE TABLE IF NOT EXISTS erasures (
  person_id TEXT PRIMARY KEY,
  requested_at INTEGER NOT NULL,
  erased_at INTEGER NOT NULL,
  retain_until INTEGER NOT NULL,
  schedule_json TEXT NOT NULL,
  counts_json TEXT NOT NULL
) STRICT;

-- ---------------------------------------------------------------- agent commerce (R13, v8 part i; server/commerce.ts)
-- What QED may buy from simulated paywalled services on the owner's behalf, signed with the passkey: a limit for each purchase,
-- a limit for each calendar month and the services allowed. A new mandate replaces the one before; the old stays on record.
CREATE TABLE IF NOT EXISTS commerce_mandates (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  per_purchase INTEGER NOT NULL,   -- paise
  per_month INTEGER NOT NULL,      -- paise
  services_json TEXT NOT NULL,     -- the allowed service ids
  expires_at INTEGER NOT NULL,
  approval_id TEXT NOT NULL,
  doc_hash TEXT NOT NULL,
  state TEXT NOT NULL,             -- 'active' | 'replaced' | 'revoked'
  created_at INTEGER NOT NULL,
  ended_at INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS commerce_mandates_user ON commerce_mandates(user_id, created_at);
-- Each request to buy: the quotes compared, the choice, the verdict of the mandate check, and the receipt.
CREATE TABLE IF NOT EXISTS commerce_purchases (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  mandate_id TEXT,
  sku TEXT NOT NULL,
  service_id TEXT,
  service_name TEXT,
  amount INTEGER,                  -- paise, as the service quoted
  state TEXT NOT NULL,             -- 'refused' | 'paying' | 'paid' | 'failed'
  reason TEXT,
  quotes_json TEXT NOT NULL DEFAULT '[]',
  action_id TEXT,
  receipt_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS commerce_purchases_user ON commerce_purchases(user_id, created_at);

-- ---------------------------------------------------------------- R13: the institutional desk (netting.ts, rfq.ts, institutional.ts)
-- v8, part (l). What one workspace says another owes it, agreed by both sides before it can be netted. Whole paise.
CREATE TABLE IF NOT EXISTS netting_claims (
  id TEXT PRIMARY KEY,
  creditor_ws TEXT NOT NULL,    -- the workspace owed
  debtor_ws TEXT NOT NULL,      -- the workspace that owes
  amount INTEGER NOT NULL,
  memo TEXT NOT NULL,
  state TEXT NOT NULL,          -- 'proposed' | 'agreed' | 'in-cycle' | 'netted' | 'withdrawn' | 'declined'
  proposed_by_ws TEXT NOT NULL,
  proposed_by TEXT NOT NULL,    -- the person who recorded it
  created_at INTEGER NOT NULL,
  agreed_by TEXT,
  agreed_at INTEGER,
  cycle_id TEXT,
  CHECK (creditor_ws <> debtor_ws),
  CHECK (amount > 0)
) STRICT;
CREATE INDEX IF NOT EXISTS netting_claims_ws ON netting_claims(creditor_ws, debtor_ws, state);
-- A cycle: the fixed terms (claims, positions, payments), their fingerprint, and how it ended.
CREATE TABLE IF NOT EXISTS netting_cycles (
  id TEXT PRIMARY KEY,
  proposed_by_ws TEXT NOT NULL,
  proposed_by TEXT NOT NULL,
  state TEXT NOT NULL,          -- 'open' | 'settled' | 'cancelled'
  terms_json TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  settled_at INTEGER,
  cancelled_at INTEGER,
  cancelled_by TEXT
) STRICT;
-- Each workspace in a cycle: who agreed to its fingerprint, and the approval that signs its payment.
CREATE TABLE IF NOT EXISTS netting_participants (
  cycle_id TEXT NOT NULL REFERENCES netting_cycles(id),
  workspace_id TEXT NOT NULL,
  agreed_by TEXT,
  agreed_at INTEGER,
  approval_id TEXT,
  PRIMARY KEY (cycle_id, workspace_id)
) STRICT;
-- A request for quotes: what was asked, and every answer (each labelled as a paper venue's own book or a simulated dealer).
CREATE TABLE IF NOT EXISTS rfqs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  valid_until INTEGER NOT NULL,
  request_json TEXT NOT NULL,
  result_json TEXT NOT NULL
) STRICT;
-- A model portfolio an owner offers to other workspaces: append-only, a new version is a new row.
CREATE TABLE IF NOT EXISTS model_portfolios (
  id TEXT PRIMARY KEY,
  owner_ws TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  weights_json TEXT NOT NULL,   -- [{ instrumentId, weightBps }] summing to 10000
  basis_json TEXT NOT NULL,     -- how the weights were chosen, and what is claimed for them
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  retired_at INTEGER,
  UNIQUE (owner_ws, name, version)
) STRICT;
-- An offer of one version of a model to one workspace. Nothing happens in that workspace until its own member accepts, and then
-- only a draft instruction is made, which that workspace's signers read and sign through the usual approval.
CREATE TABLE IF NOT EXISTS model_offers (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES model_portfolios(id),
  offered_by_ws TEXT NOT NULL,
  client_ws TEXT NOT NULL,
  offered_by TEXT NOT NULL,
  offered_at INTEGER NOT NULL,
  state TEXT NOT NULL,          -- 'offered' | 'accepted' | 'declined' | 'withdrawn'
  decided_by TEXT,
  decided_at INTEGER,
  program_id TEXT,
  UNIQUE (model_id, client_ws)
) STRICT;

-- v8 (h), 24 Nov 2026, R13 (server/fx.ts, server/abroad.ts): the paper bank's foreign-currency side. Amounts are minor
-- units of the named currency (ISO 4217) as canonical integer text, never floats. Made here, so a v7 database gains these
-- tables when it is next opened; nothing of a v7 household is changed (core.ts, part (h) of the v7 to v8 step).
-- A conversion's fill keeps its rate, the spread and the fee apart (R7-038). Append-only.
CREATE TABLE IF NOT EXISTS fx_fills (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  quote_id TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  entry_id TEXT NOT NULL REFERENCES entries(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('conversion', 'payment')),
  sell_ccy TEXT NOT NULL,
  sell_text TEXT NOT NULL,
  buy_ccy TEXT NOT NULL,
  buy_text TEXT NOT NULL,
  rate TEXT NOT NULL,           -- the executable rate the quote stated: rupees per one unit of the other currency
  reference_json TEXT NOT NULL, -- the reference rate the desk priced from: mid, source, label, when observed
  spread_bps INTEGER NOT NULL,  -- the desk's stated spread
  spread_text TEXT NOT NULL,    -- paise: what the spread cost against the reference mid (derived)
  fee_text TEXT NOT NULL,       -- paise: the fee, charged apart from the rate
  lrs_usd_text TEXT,            -- US cents counted toward the Liberalised Remittance Scheme (rupees sold), else NULL
  filled_at INTEGER NOT NULL,
  UNIQUE (user_id, quote_id),
  UNIQUE (user_id, approval_id)
) STRICT;
CREATE INDEX IF NOT EXISTS fx_fills_user ON fx_fills(user_id, filled_at);
CREATE TRIGGER IF NOT EXISTS fx_fills_no_update BEFORE UPDATE ON fx_fills BEGIN SELECT RAISE(ABORT, 'fills are append-only'); END;
CREATE TRIGGER IF NOT EXISTS fx_fills_no_delete BEFORE DELETE ON fx_fills BEGIN SELECT RAISE(ABORT, 'fills are append-only'); END;

-- A payee abroad: who, in which country and currency, and the account in its scheme (checked when added).
CREATE TABLE IF NOT EXISTS xb_payees (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  country TEXT NOT NULL,        -- ISO 3166-1 alpha-2
  currency TEXT NOT NULL,       -- ISO 4217
  scheme TEXT NOT NULL CHECK (scheme IN ('iban', 'aba', 'bic-account')),
  account TEXT NOT NULL,        -- the IBAN; or the routing number and account; or the account, normalised
  bank TEXT,                    -- the BIC, where the scheme needs one
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, currency, account)
) STRICT;

-- A payment abroad on a paper route: the route, what the payee receives, the fee, the value date in the route's calendar.
CREATE TABLE IF NOT EXISTS xb_payments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  payee_id TEXT NOT NULL REFERENCES xb_payees(id),
  route TEXT NOT NULL,
  purpose TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount_text TEXT NOT NULL,    -- what the payee receives, in minor units of currency
  funded_from TEXT NOT NULL,    -- 'INR' (changed at a quote) or the payment's own currency (a balance held)
  debit_text TEXT NOT NULL,     -- what left the funding balance, in its minor units, the fee not included
  fee_text TEXT NOT NULL,       -- paise: the route's fee
  tcs_text TEXT,                -- paise of tax collected at source; NULL when it was not computed (server/abroad.ts says why)
  fill_id TEXT REFERENCES fx_fills(id),
  value_date TEXT NOT NULL,     -- the day the payee's bank is credited on paper, in the route's calendar
  calendar TEXT NOT NULL,
  time_zone TEXT NOT NULL,      -- the household's zone when it was approved
  approval_id TEXT NOT NULL UNIQUE,
  entry_id TEXT NOT NULL REFERENCES entries(id),
  duplicate_of TEXT,            -- an earlier payment the owner confirmed this one is not a duplicate of
  state TEXT NOT NULL CHECK (state IN ('in_transit', 'credited')),
  created_at INTEGER NOT NULL,
  credited_at INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS xb_payments_user ON xb_payments(user_id, created_at);

-- v8 (h), R13: a goal in another currency (server/fx-goals.ts): a target held in the household's balance in that currency,
-- one open goal per currency. It moves no money. Target in minor units of the currency, canonical integer text.
CREATE TABLE IF NOT EXISTS fx_goals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  target_text TEXT NOT NULL,
  by_date TEXT NOT NULL,        -- YYYY-MM-DD in the household's zone
  created_at INTEGER NOT NULL,
  removed_at INTEGER
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS fx_goals_open ON fx_goals(user_id, currency) WHERE removed_at IS NULL;

-- R13 E4 (schema v8 part m): the work directory (server/directory.ts). Listings a household of this installation
-- publishes (an offer of work it does, a request for work it needs) and the quotes households send on a request, or the
-- record of a standing offer taken. The simulated workspaces beyond this installation are generated by the server and
-- never stored here.
CREATE TABLE IF NOT EXISTS directory_listings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('offer', 'request')),
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  problem_json TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  deliver_within_hours INTEGER NOT NULL CHECK (deliver_within_hours BETWEEN 1 AND 336),
  state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
  created_at INTEGER NOT NULL,
  closed_at INTEGER,
  closed_why TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS directory_listings_open ON directory_listings(state, created_at);
CREATE TABLE IF NOT EXISTS directory_quotes (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES directory_listings(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  client_id TEXT NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  deliver_within_hours INTEGER NOT NULL CHECK (deliver_within_hours BETWEEN 1 AND 336),
  note TEXT NOT NULL,
  dispute_json TEXT,
  state TEXT NOT NULL CHECK (state IN ('open', 'chosen', 'not-chosen', 'withdrawn')),
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  job_id TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS directory_quotes_listing ON directory_quotes(listing_id, state);
-- v8 (p), R13 (server/records.ts purge): the owner-approved removal of an erased person's financial records once their retention
-- period has ended. One row for each run and person, written in the same transaction as the removal and never changed or deleted:
-- the closing summary of the person's books (counts, totals, the receipt chain's head and a digest of every row removed), which
-- is what remains to show what was removed, when, and on whose approval.
CREATE TABLE IF NOT EXISTS purge_runs (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  approved_at INTEGER NOT NULL,
  approval_method TEXT NOT NULL,
  retain_until INTEGER NOT NULL,
  summary_json TEXT NOT NULL,   -- the closing summary: ledger entries, postings, totals by asset, receipt head, per-table counts and digests
  digest TEXT NOT NULL          -- SHA-256 over the per-table digests
) STRICT;
CREATE INDEX IF NOT EXISTS purge_runs_person ON purge_runs(person_id);
CREATE TRIGGER IF NOT EXISTS purge_runs_no_update BEFORE UPDATE ON purge_runs BEGIN SELECT RAISE(ABORT, 'purge records are append-only'); END;
CREATE TRIGGER IF NOT EXISTS purge_runs_no_delete BEFORE DELETE ON purge_runs BEGIN SELECT RAISE(ABORT, 'purge records are append-only'); END;

-- v8 (v), R13 not-met rows N-018, N-016/N-004, N-020 (server/dispute-pause.ts, channel-terms.ts, institution-setup.ts).
-- dispute_pauses: reporting a problem pauses what QED does on its own on that payment's rail (QED-origin payments only; the
-- person's own are untouched) until the person releases it; every pause keeps when it began and when and by whom it was released.
CREATE TABLE IF NOT EXISTS dispute_pauses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  dispute_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  scope TEXT NOT NULL,          -- 'payments:<venue>', e.g. 'payments:paper-rail'
  started_at INTEGER NOT NULL,
  released_at INTEGER,
  released_by TEXT              -- the person who released it
) STRICT;
CREATE INDEX IF NOT EXISTS dispute_pauses_user ON dispute_pauses(user_id, released_at);
-- channel_terms: the terms a channel at a (simulated) institution was given for an instruction, derived from its signed
-- authority and never wider (an e-mandate, a variable recurring payment consent, a data consent).
CREATE TABLE IF NOT EXISTS channel_terms (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  channel TEXT NOT NULL,        -- 'e-mandate' | 'vrp-consent' | 'data-consent'
  institution TEXT NOT NULL,    -- a simulated institution's id (server/institution-terms.ts)
  reference TEXT,               -- the institution's own reference for it
  terms_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  ended_at INTEGER,
  UNIQUE (user_id, program_id, channel)
) STRICT;
-- institution_setups: a workspace's set-up of a simulated institution: the terms version it was shown, the bank entitlements
-- mapped from the workspace's roles at that time, and, for a US business, the acknowledged UCC Article 4A disclosure.
CREATE TABLE IF NOT EXISTS institution_setups (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  institution TEXT NOT NULL,
  terms_version TEXT NOT NULL,
  entitlement_json TEXT NOT NULL,
  disclosure_json TEXT,
  set_up_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, institution)
) STRICT;

-- R14 (schema v9 part d): a household's watchlist (server/watchlist.ts). One row for each instrument a household watches,
-- with the price, its type, source and times at the moment it was added, which a row's change since added is counted from.
-- It moves no money and places no order. At most 50 a household (checked in the code, under the write lock).
CREATE TABLE IF NOT EXISTS watchlist_items (
  user_id TEXT NOT NULL REFERENCES users(id),
  instrument_id TEXT NOT NULL REFERENCES instruments(id),
  added_at INTEGER NOT NULL,
  added_role TEXT NOT NULL,
  price_type TEXT NOT NULL,
  added_price TEXT,             -- NULL when no price was on record at the moment it was added
  added_provider TEXT,
  added_source_ts INTEGER,
  added_recv_ts INTEGER,
  PRIMARY KEY (user_id, instrument_id)
) STRICT;
