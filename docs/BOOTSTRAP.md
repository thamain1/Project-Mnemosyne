# Bootstrapping team members (service-role seed)

`team_members` starts empty, so `is_team_member()` is `false` for everyone and RLS denies all normal
access until the first row exists. This is resolved by seeding via the **service role**, which bypasses
RLS. There is **no chicken-and-egg trap**: the service role does not depend on `is_team_member()`.

## Prerequisite: the auth user must exist first
A `team_members` row's `id` is a FK to `auth.users(id)`. Create the auth identity first via Supabase
Auth (dashboard invite, or the Admin API `auth.admin.inviteUserByEmail`). Then look up the id:

```sql
select id, email from auth.users where email = 'larry@4wardmotions.com';
```

## Seed transaction (run as service_role — e.g. SQL Editor or service-key client)
Idempotent and transactional. The first member **must** be an admin so the last-admin invariant has a
holder. Replace UUIDs/emails with real values.

```sql
begin;

insert into public.team_members (id, full_name, email, title, role, can_code, active) values
  ('<larry-auth-uuid>',   'Larry Golden Jr',  'larry@4wardmotions.com',   'CEO',                'admin',  false, true),
  ('<jesse-auth-uuid>',   'Jesse Morgan',     'jmorgan@4wardmotions.com', 'Co-Founder & CTO',   'admin',  true,  true),
  ('<dave-auth-uuid>',    'David Fagel',      'dave@4wardmotions.com',    'VP, Technology',     'member', true,  true),
  ('<bryan-auth-uuid>',   'Bryan Hill',       'bryan@4wardmotions.com',   'VP, Sales',          'member', true,  true),
  ('<brandon-auth-uuid>', 'Brandon Tillman',  'brandon@4wardmotions.com', 'VP, Business Dev',   'member', false, true),
  ('<wayne-auth-uuid>',   'Wayne Kuechler',   'wayne@4wardmotions.com',   'COO',                'member', false, true),
  ('<haile-auth-uuid>',   'Haile Hantal',     'haile@4wardmotions.com',   'CXO',                'member', false, true)
on conflict (id) do update set
  full_name = excluded.full_name, email = excluded.email, title = excluded.title,
  role = excluded.role, can_code = excluded.can_code, active = excluded.active;

commit;
```

## Notes
- `can_code = true` grants code-write (repos). Set for technical roles (Jesse, David Fagel, Bryan Hill);
  flip others later with a plain `update` — no migration needed.
- `role = 'admin'` grants membership management + admin-gated writes. Keep **at least two** admins so
  the last-admin survivability trigger never strands the org on one person.
- The trigger `protect_last_admin()` fires for the service role too — to intentionally remove the last
  admin you must first promote another active admin.
- **Test (post-seed):** as an `authenticated` member, confirm you can read everything and write
  knowledge/work tables; confirm you cannot read `secrets_vault.encrypted_value` directly, cannot
  write `activity_log`, and cannot demote the last admin.
