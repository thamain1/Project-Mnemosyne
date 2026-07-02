-- Mnemosyne — 0025: fix usage_events grants (thread 0025, P5-TELEMETRY). Additive follow-up to 0024.
--
-- 0024 copied 0023's rate_limits posture verbatim ("revoke all ... from anon, authenticated"), but
-- rate_limits is pure service-role bookkeeping with NO member-readable policy — usage_events IS
-- meant to be member-readable (the dashboard Usage rollup card). `revoke all` also revokes the
-- base SELECT grant that RLS policies need underneath them, so the usage_events_select policy
-- (added in 0024) was unreachable: authenticated got "permission denied for table" before RLS
-- even evaluated. Correct pattern is activity_log's (0002): grant SELECT to authenticated only
-- (anon never has a legitimate reason to read this table, so it's withheld outright rather than
-- relying on RLS alone for defense in depth), keep insert/update/delete revoked from both.

grant select on public.usage_events to authenticated;
revoke insert, update, delete on public.usage_events from anon, authenticated;
