// One-off: ground C5 in the live CRM table state. node --env-file=.env.local scripts/probe-crm-state.mjs
const REF = process.env.SUPABASE_PROJECT_REF, TOK = process.env.SUPABASE_ACCESS_TOKEN
async function q(sql) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  })
  return r.json()
}
const show = (l, r) => console.log(`\n--- ${l} ---\n` + JSON.stringify(r))
show('row counts', await q(`select 'clients' t, count(*) from public.clients union all select 'contacts', count(*) from public.contacts union all select 'deals', count(*) from public.deals`))
show('policies on clients/contacts/deals', await q(`select tablename, policyname, cmd, roles from pg_policies where tablename in ('clients','contacts','deals') order by tablename`))
show('anon/authenticated grants', await q(`select grantee, table_name, privilege_type from information_schema.role_table_grants where table_schema='public' and table_name in ('clients','contacts','deals') and grantee in ('anon','authenticated') and privilege_type in ('INSERT','UPDATE','DELETE','SELECT') order by table_name, grantee, privilege_type`))
show('deal_stage enum values', await q(`select enumlabel from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='deal_stage' order by e.enumsortorder`))
show('documents → deal linkage? (columns)', await q(`select column_name from information_schema.columns where table_schema='public' and table_name='documents' order by ordinal_position`))
