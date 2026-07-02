// Mnemosyne — shared FK-drop-safe smoke cleanup helper (thread 0029 QC fix round).
//
// Migration 0026 drops `team_members -> auth.users ON DELETE CASCADE`. Before 0026, a plain
// `deleteUser(uid)` cascades away the team_members row for free; after 0026 it does NOT — any smoke
// script that only calls deleteUser() silently leaves the team_members row behind (ACTIVE, not even a
// deactivated tombstone, since there's no more cascade failure to surface a fallback through). This
// helper is correct on BOTH sides of that migration: it never depends on deleteUser's cascade behavior
// for correctness — it resolves the team_members row's fate itself, before ever touching the auth user.
//
// team_members.id is referenced by MANY more tables than the obvious ones (verified against prod
// catalog 2026-07-02): activity_log.actor_id, projects.owner_id, memory_entries.created_by,
// documents.created_by, secrets_vault.created_by, deals.owner_id, memory_mirror.created_by,
// memory_versions.edited_by, document_versions.edited_by are ALL plain (NO ACTION / blocking) FKs.
// Only rate_limits.actor_id (CASCADE) and usage_events.actor_id (SET NULL) are non-blocking. This
// helper does NOT try to enumerate every possible blocker — the pre-clean step below only clears the
// rows every smoke actor is virtually guaranteed to have (activity_log/usage_events/rate_limits); the
// try-delete-then-deactivate fallback is what guarantees correctness regardless of WHICH FK (if any
// other) blocks the delete, exactly like the existing accepted tombstone policy.
//
// Order: delete dependent actor-keyed rows -> try a real delete on team_members -> on failure fall
// back to deactivate (never leave an active orphan) -> best-effort deleteUser regardless of the
// outcome above (no cascade dependency either way, post-0026).
//
// NOT used by scripts/smoke-save-rendered.mjs, which deliberately PRESERVES activity_log to test the
// tombstone (deactivate-not-delete) path itself as a first-class assertion — this helper's default is
// full cleanup, not audit preservation, which is what every OTHER smoke script actually wants for its
// throwaway actors.

export async function cleanupMember(admin, uid, { extraActorTables = [], preserveActivityLog = false } = {}) {
  if (!uid) return

  const actorTables = preserveActivityLog
    ? ['usage_events', 'rate_limits', ...extraActorTables]
    : ['activity_log', 'usage_events', 'rate_limits', ...extraActorTables]
  for (const table of actorTables) {
    try { await admin.from(table).delete().eq('actor_id', uid) } catch { /* best-effort */ }
  }

  const { error: delErr } = await admin.from('team_members').delete().eq('id', uid)
  if (delErr) {
    try { await admin.from('team_members').update({ active: false }).eq('id', uid) } catch { /* best-effort */ }
  }

  // best-effort — some callers pass a uid that was never a real auth user; never let this throw
  try { await admin.auth.admin.deleteUser(uid) } catch { /* best-effort */ }
}
