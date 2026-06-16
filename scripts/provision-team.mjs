// Mnemosyne — Phase 2 / Unit A1: make the 7 seeded team identities loginable (IN PLACE, same uuids).
//
// WHY IN-PLACE (not delete+recreate): the 7 auth.users rows were direct-SQL inserts (Phase-1 expedient).
// They have NULL in confirmation_token/recovery_token/email_change/email_change_token_new/raw_*_meta_data
// (GoTrue scans those into non-null Go strings → the Auth Admin API errors "Database error finding users"),
// 0 auth.identities, no password, unconfirmed. team_members.id is FK-pinned to these uuids and
// protect_last_admin fires BEFORE DELETE (deleting the last admin raises). So delete+recreate is awkward
// AND would churn the FK + OPERATOR_MEMBER_ID. Instead we REPAIR IN PLACE:
//   1) SQL (Mgmt API): patch the NULL token/meta columns → '' / proper jsonb so GoTrue can read the rows.
//   2) Admin API updateUserById: set a temp password + confirm email + must_change_password.
//   3) SQL: ensure an 'email' provider row in auth.identities (insert if missing).
//   4) Self-test signInWithPassword for JESSE FIRST — only proceed to the other 6 if it passes (fail-safe).
// Same uuids → no trigger, no FK churn, OPERATOR_MEMBER_ID unchanged.
//
// Temp passwords printed ONCE to stdout for out-of-band handoff — never written to a file.
//
// Run:
//   node --env-file=.env.local scripts/provision-team.mjs --dry-run   # inspect only (read-only SQL)
//   node --env-file=.env.local scripts/provision-team.mjs             # LIVE (Jesse-go-gated)
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ACCESS_TOKEN,
//      SUPABASE_PROJECT_REF.

import { randomBytes } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const URL = process.env.VITE_SUPABASE_URL
const ANON = process.env.VITE_SUPABASE_ANON_KEY
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
const MGMT = process.env.SUPABASE_ACCESS_TOKEN
const REF = process.env.SUPABASE_PROJECT_REF
for (const [k, v] of Object.entries({ VITE_SUPABASE_URL: URL, VITE_SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE_KEY: SERVICE, SUPABASE_ACCESS_TOKEN: MGMT, SUPABASE_PROJECT_REF: REF }))
  if (!v) throw new Error(`Missing ${k}`)

const DRY = process.argv.slice(2).includes('--dry-run')

// docs/BOOTSTRAP.md roster. Jesse first so the self-test gates the rest.
const ROSTER = [
  { email: 'jmorgan@4wardmotions.com', operator: true },
  { email: 'larry@4wardmotions.com' },
  { email: 'dave@4wardmotions.com' },
  { email: 'bryan@4wardmotions.com' },
  { email: 'brandon@4wardmotions.com' },
  { email: 'wayne@4wardmotions.com' },
  { email: 'haile@4wardmotions.com' },
]
const EMAILS = ROSTER.map((r) => r.email)
const admin = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } })
const tempPw = () => 'Mz' + randomBytes(18).toString('base64url') + '9!'

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${MGMT}`, 'Content-Type': 'application/json', 'User-Agent': 'mnemosyne-provision' },
    body: JSON.stringify({ query }),
  })
  if (!res.ok) throw new Error(`Mgmt SQL ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return res.json()
}
const inList = "(" + EMAILS.map((e) => `'${e}'`).join(',') + ")"

async function inspect(label) {
  const rows = await sql(`
    select u.email,
      (u.encrypted_password is not null and u.encrypted_password<>'') has_pw,
      (u.email_confirmed_at is not null) confirmed,
      (u.confirmation_token is null or u.recovery_token is null or u.email_change is null or u.raw_app_meta_data is null) malformed,
      (select count(*) from auth.identities i where i.user_id = u.id) identities,
      (u.raw_user_meta_data->>'must_change_password') must_change
    from auth.users u where u.email in ${inList} order by u.email;`)
  console.log(`=== ${label} ===`)
  for (const r of rows) console.log(`  ${r.email}  pw=${r.has_pw}  confirmed=${r.confirmed}  malformed=${r.malformed}  identities=${r.identities}  must_change=${r.must_change}`)
  return rows
}

async function patchColumns() {
  // NULL token/change columns → '' ; meta → proper jsonb. Only touches the 7 roster rows.
  await sql(`
    update auth.users set
      confirmation_token        = coalesce(confirmation_token, ''),
      recovery_token            = coalesce(recovery_token, ''),
      email_change              = coalesce(email_change, ''),
      email_change_token_new    = coalesce(email_change_token_new, ''),
      email_change_token_current= coalesce(email_change_token_current, ''),
      reauthentication_token    = coalesce(reauthentication_token, ''),
      phone_change              = coalesce(phone_change, ''),
      phone_change_token        = coalesce(phone_change_token, ''),
      raw_app_meta_data         = coalesce(raw_app_meta_data, '{"provider":"email","providers":["email"]}'::jsonb),
      raw_user_meta_data        = coalesce(raw_user_meta_data, '{}'::jsonb)
    where email in ${inList};`)
}

async function ensureIdentities() {
  // Create an 'email' provider identity for any roster user missing one (GoTrue expects it).
  await sql(`
    insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at, email)
    select u.id::text, u.id,
      jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true, 'phone_verified', false),
      'email', now(), now(), now(), u.email
    from auth.users u
    where u.email in ${inList}
      and not exists (select 1 from auth.identities i where i.user_id = u.id and i.provider = 'email');`)
}

async function getUserId(email) {
  const r = await sql(`select id from auth.users where email = '${email}' limit 1;`)
  return r[0]?.id
}

async function setPassword(email) {
  const id = await getUserId(email)
  if (!id) throw new Error(`${email}: no auth.users row`)
  const password = tempPw()
  const { error } = await admin.auth.admin.updateUserById(id, {
    password,
    email_confirm: true,
    user_metadata: { must_change_password: true },
  })
  if (error) throw new Error(`${email}: updateUserById failed: ${error.message}`)
  return { id, email, password }
}

async function selfTest(email, password) {
  const probe = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await probe.auth.signInWithPassword({ email, password })
  const ok = !error && !!data?.session
  await probe.auth.signOut().catch(() => {})
  return { ok, msg: error ? error.message : ok ? 'session issued' : 'no session' }
}

async function main() {
  console.log(`[provision-team] mode=${DRY ? 'DRY-RUN' : 'LIVE'}  project=${URL}`)
  await inspect('current state')
  if (DRY) {
    console.log('\n[dry-run] no mutations. Re-run without --dry-run (Jesse-go-gated) to repair in place.')
    return
  }

  console.log('\n[live] 1/4 patching malformed auth.users columns…')
  await patchColumns()
  console.log('[live] 2/4 ensuring email identities…')
  await ensureIdentities()

  // 3/4 Jesse first + self-test gate
  const jesse = ROSTER[0].email
  console.log(`[live] 3/4 provisioning ${jesse} (operator) + self-test…`)
  const first = await setPassword(jesse)
  const t = await selfTest(first.email, first.password)
  console.log(`[live]     login self-test: ${t.ok ? 'PASS' : 'FAIL'} (${t.msg})`)
  if (!t.ok) throw new Error('Self-test login FAILED after in-place repair — aborting before the other 6. No password set for the rest; investigate identities/columns.')

  // 4/4 the rest
  console.log('[live] 4/4 provisioning the other 6…')
  const creds = [first]
  for (const r of ROSTER.slice(1)) { console.log(`        ${r.email}`); creds.push(await setPassword(r.email)) }

  await inspect('post-provision verification')
  console.log('\n=== TEMP PASSWORDS (out-of-band handoff; users rotate on first login; NOT saved anywhere) ===')
  for (const c of creds) console.log(`  ${c.email}\t${c.password}`)
  console.log(`\n[live] OPERATOR_MEMBER_ID unchanged (same uuid): ${first.id}`)
  console.log('[live] done — team_members + OPERATOR_MEMBER_ID untouched.')
}

main().catch((e) => { console.error('[provision-team] ERROR:', e.message); process.exitCode = 1 })
