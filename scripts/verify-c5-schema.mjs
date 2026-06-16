// node --env-file=.env.local scripts/verify-c5-schema.mjs
const REF = process.env.SUPABASE_PROJECT_REF, TOK = process.env.SUPABASE_ACCESS_TOKEN
async function q(sql) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  })
  return r.json()
}
const show = (l, r) => console.log(`\n--- ${l} ---\n` + JSON.stringify(r))
show('CRM RPCs (definer / search_path)', await q(`select p.proname, p.prosecdef as secdef, p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('upsert_client','upsert_deal','link_document_deal') order by p.proname`))
show('execute grants (expect service_role only, + owner postgres)', await q(`select p.proname, r.rolname from pg_proc p, aclexplode(p.proacl) a join pg_roles r on r.oid=a.grantee where p.proname in ('upsert_client','upsert_deal','link_document_deal') and a.privilege_type='EXECUTE' order by p.proname, r.rolname`))
show('documents.deal_id FK', await q(`select column_name from information_schema.columns where table_schema='public' and table_name='documents' and column_name='deal_id'`))
show('policies (expect SELECT-only)', await q(`select tablename, policyname, cmd from pg_policies where tablename in ('clients','contacts','deals') order by tablename`))
show('anon/authenticated write grants (expect NONE)', await q(`select grantee, table_name, privilege_type from information_schema.role_table_grants where table_schema='public' and table_name in ('clients','contacts','deals') and grantee in ('anon','authenticated') and privilege_type in ('INSERT','UPDATE','DELETE') order by table_name, grantee`))
