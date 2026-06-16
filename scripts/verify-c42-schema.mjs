// One-off: verify the 0013+0014 schema state matches Aegis's required post-apply checks.
// node --env-file=.env.local scripts/verify-c42-schema.mjs
const REF = process.env.SUPABASE_PROJECT_REF, TOK = process.env.SUPABASE_ACCESS_TOKEN
async function q(sql) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  })
  return r.json()
}
const show = (label, rows) => console.log(`\n--- ${label} ---\n` + JSON.stringify(rows, null, 0))

show('origin column', await q(`select column_name, data_type, column_default, is_nullable
  from information_schema.columns where table_schema='public' and table_name='documents' and column_name='origin'`))

show('documents_origin_chk on public.documents', await q(`select conname, pg_get_constraintdef(oid) as def
  from pg_constraint where conname='documents_origin_chk' and conrelid='public.documents'::regclass`))

show('save_document props (definer / search_path / args)', await q(`select p.proname, p.prosecdef as security_definer,
  pg_get_function_identity_arguments(p.oid) as args, p.proconfig
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='save_document'`))

show('save_document execute grants (expect service_role only)', await q(`select r.rolname
  from pg_proc p, aclexplode(p.proacl) a join pg_roles r on r.oid=a.grantee
  where p.proname='save_document' and a.privilege_type='EXECUTE' order by r.rolname`))

show('policies on documents + document_chunks', await q(`select tablename, policyname, cmd, roles
  from pg_policies where tablename in ('documents','document_chunks') order by tablename, policyname`))

show('table privileges for anon/authenticated (expect SELECT only)', await q(`select grantee, table_name, privilege_type
  from information_schema.role_table_grants
  where table_schema='public' and table_name in ('documents','document_chunks')
  and grantee in ('anon','authenticated') order by table_name, grantee, privilege_type`))

show('row counts by origin (baseline: 12 ingested, 0 draft)', await q(`select origin, count(*) from public.documents group by origin order by origin`))
