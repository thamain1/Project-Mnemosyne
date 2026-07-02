-- Mnemosyne — 0026: machine accounts for the hosted remote MCP server (thread 0027, P1-HOSTED-MCP).
-- Additive. UNAPPLIED until Aegis post-build QC + Jesse apply-go (design already Aegis-approved,
-- thread 0027 r2 re-review).
--
-- Machines (teammate/agent access via the hosted MCP endpoint) live in team_members alongside humans —
-- see thread 0027 "Machine identity model" for the full reasoning. Summary: dropping the auth.users FK
-- is safe because every RLS/authz path keys on `id = auth.uid()` (a machine's random uuid can never
-- equal any auth.uid(), so machines stay structurally locked out of every JWT-gated surface with zero
-- code change), and it lets activity_log/rate_limits/usage_events keep working unchanged (all three FK
-- team_members for actor attribution).
--
-- Invariant (documented, gate-checked, NOT FK-enforced): kind='human' rows have id = <their auth.users
-- id> (existing provisioning already guarantees this); kind='machine' rows have id = gen_random_uuid()
-- and no auth user, full_name = machine label, email = null.

-- ── 1. Drop the auth.users FK (discovered via catalog, per Aegis's binding gate note — do not assume
--    a constraint name; Supabase-generated names can differ across environments) ─────────────────────
do $$
declare v_conname text;
begin
  select conname into v_conname
  from pg_constraint
  where conrelid = 'public.team_members'::regclass
    and contype = 'f'
    and confrelid = 'auth.users'::regclass;
  if v_conname is not null then
    execute format('alter table public.team_members drop constraint %I', v_conname);
  end if;
end $$;

-- ── 2. kind + scopes columns. `kind` backfills to 'human' via the column default (existing rows get it
--    for free); `scopes` backfills to '{}' the same way, then explicit UPDATE grants the human-default
--    remote scope set (idempotent — guarded by scopes = '{}' so a re-run can't clobber a customized set) ──
alter table public.team_members
  add column if not exists kind text not null default 'human',
  add column if not exists scopes text[] not null default '{}';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'team_members_kind_chk' and conrelid = 'public.team_members'::regclass) then
    alter table public.team_members add constraint team_members_kind_chk check (kind in ('human', 'machine'));
  end if;
end $$;

update public.team_members set scopes = '{recall,fetch,log_update,brief}' where kind = 'human' and scopes = '{}';

-- ── 3. machine_tokens — service-role-only bookkeeping. The token hash is itself sensitive (it enables
--    offline hash comparison), so no client role gets any privilege at all — not even SELECT, unlike
--    usage_events which is intentionally member-readable. This project auto-grants anon/authenticated
--    on new public tables; explicit revoke per house standard. ──────────────────────────────────────
create table if not exists public.machine_tokens (
  id           uuid primary key default gen_random_uuid(),
  member_id    uuid not null references public.team_members (id) on delete cascade,
  token_hash   text not null unique,
  label        text not null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz,
  revoked_at   timestamptz,
  last_used_at timestamptz
);

alter table public.machine_tokens enable row level security;
revoke all on public.machine_tokens from anon, authenticated;

create index if not exists machine_tokens_member_id_idx on public.machine_tokens (member_id);

-- ── 4. verify_machine_token — the sole read+write path for token verification. Single UPDATE...FROM
--    statement (no read-then-write race, same atomicity discipline as rate_take/log_activity): matches
--    a non-revoked, non-expired hash on a kind='machine' row, bumps last_used_at, and returns the
--    joined member row in one shot. Returns EMPTY on any miss (bad shape, unknown hash, revoked,
--    expired, OR a token somehow minted against a non-machine row) — never raises, so a bad token
--    produces no oracle distinguishing any of those cases from each other. The `kind = 'machine'` guard
--    (thread 0029) means a mis-provisioned token against a human row is dead on arrival here; mcp.ts
--    ALSO re-checks `kind` after verification as a belt-and-suspenders layer, in case a future caller
--    of this RPC ever changes the filter. The caller additionally checks the returned `active` flag
--    itself — a deactivated member's token must look identical (401) to any other invalid-token case at
--    the HTTP layer, so that check is NOT folded into this RPC's WHERE clause. ───────────────────────
create or replace function public.verify_machine_token(p_hash text)
returns table (
  member_id uuid,
  kind      text,
  scopes    text[],
  active    boolean
)
language plpgsql security definer set search_path = '' as $$
begin
  if p_hash is null or length(p_hash) <> 64 or p_hash !~ '^[0-9a-f]{64}$' then
    return;
  end if;

  return query
  update public.machine_tokens t
  set last_used_at = now()
  from public.team_members m
  where t.token_hash = p_hash
    and t.member_id = m.id
    and t.revoked_at is null
    and (t.expires_at is null or t.expires_at > now())
    and m.kind = 'machine'   -- thread 0029: a mis-provisioned token against a human row must be dead on arrival
  returning m.id, m.kind, m.scopes, m.active;
end $$;

revoke execute on function public.verify_machine_token(text) from public, anon, authenticated;
grant  execute on function public.verify_machine_token(text) to service_role;
