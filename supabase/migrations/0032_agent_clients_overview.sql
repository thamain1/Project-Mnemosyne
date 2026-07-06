-- Mnemosyne — 0032: dashboard read path for agent_clients (WORK-ORDER-AGENT-OS-UI.md Part 1 §3).
-- Additive.
--
-- agent_clients is service-role-only BY DESIGN (0031) because it holds token_hash. The Agent OS
-- dashboard section needs the registry's safe columns for team members — so the read path is a
-- SECURITY DEFINER function that (a) gates on is_team_member() like every dashboard table policy,
-- and (b) simply cannot return token_hash: the column is not in the return signature. A view was
-- considered and rejected: a postgres-owned view bypasses RLS silently (the 0022C lesson from the
-- ISB fleet work) and its grants are one ALTER away from over-exposure; a definer function with an
-- explicit column list is the narrower contract.

create or replace function public.list_agent_clients()
returns table (
  client_slug  text,
  display_name text,
  is_active    boolean,
  created_at   timestamptz,
  last_used_at timestamptz
)
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_team_member() then
    raise exception 'list_agent_clients: team members only';
  end if;
  return query
  select c.client_slug, c.display_name, c.is_active, c.created_at, c.last_used_at
  from public.agent_clients c
  order by c.created_at;
end $$;

revoke execute on function public.list_agent_clients() from public, anon;
grant  execute on function public.list_agent_clients() to authenticated;

comment on function public.list_agent_clients() is
  'Agent OS dashboard: safe agent_clients columns (NEVER token_hash) for active team members.';
