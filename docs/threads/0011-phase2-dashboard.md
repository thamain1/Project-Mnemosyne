# 0011 — Phase 2 / Unit A: auth + dashboard shell + read views

**Status:** 🛠️ **BUILT — QC requested.** Frontend builds green + secret-leak-clean; provision script
written + dry-run verified. **Live A1 run (user repair) HELD for Jesse go + Aegis review.** · **Owner:**
Atlas · **Opened:** 2026-06-15

**Topic:** First Phase-2 unit — the web dashboard (accessibility-first universal front door). Login
(admin-set passwords, Jesse's decision) + a guarded shell + three **RLS-gated read views** (Memories,
Activity, Team). No new migration, no serverless, no secrets. Plan: staged MVP (A → B recall → C writes →
D secrets-gated).

---

### Atlas — 2026-06-15 (Unit A for review)

**A2/A3 — frontend (built, `npm run build` green):**
- `src/auth/AuthProvider.tsx` + `useAuth()` — session via `getSession` + `onAuthStateChange`; loads the
  caller's `team_members` row (RLS); exposes `mustChangePassword` (from `user_metadata`).
- `src/pages/Login.tsx` — email + password → `supabase.auth.signInWithPassword` (anon client).
- `src/pages/ChangePassword.tsx` — forced on first login; `updateUser({password, data:{must_change_password:false}})`.
- `src/components/AppShell.tsx` — logo + nav + signed-in member + sign-out.
- `src/pages/Memories.tsx` — `from('memory_entries').select(name,title,kind,source_path,updated_at)` +
  client text filter + detail drawer (`select body`). **Browse/filter, NOT vector search** (semantic =
  Unit B; UI says so).
- `src/pages/Activity.tsx` — `from('activity_log')` feed (empty-state now).
- `src/pages/Team.tsx` — `from('team_members')` roster.
- `src/App.tsx` view-state gate (`loading → Login → ChangePassword → Dashboard`); `src/main.tsx` wraps in
  `AuthProvider`. **No new deps** (no router — view-state switch; respects the 14-day rule).

**Security stance:**
- Browser holds **anon key + user JWT only**. **Secret-leak check on `dist/`: PASS** — service-role /
  secret-key / access-token all **absent**; only the anon key present (expected); 0 stray secret-pattern
  hits.
- All data access is **RLS-gated SELECTs** of `memory_entries` / `activity_log` / `team_members` via the
  existing `is_team_member()` policies — **no new migration, no new grants, no RPC calls, no secrets.**
- The Phase-2 `service_role` vault-bypass prerequisite (thread `0009`) does **not** block Unit A (touches
  no secrets); it still gates Unit D.

**A1 — re-provision the 7 login identities (`scripts/provision-team.mjs`; live run HELD):**
- **Finding:** the 7 `auth.users` rows (Phase-1 direct-SQL seed) are **malformed for GoTrue** — NULL
  `confirmation_token`/`recovery_token`/`email_change`/`email_change_token_new`/`raw_*_meta_data` →
  the Auth Admin API errors "Database error finding users"; plus 0 `auth.identities`, no password,
  unconfirmed. **They cannot log in.**
- **Approach change from the approved plan (safer):** the plan said delete+recreate, but
  `protect_last_admin` fires BEFORE DELETE (cascade-deleting the last admin raises), and delete+recreate
  churns the FK + `OPERATOR_MEMBER_ID`. Instead the script **repairs in place, same uuids**:
  (1) Mgmt-API SQL patches the NULL token/meta columns → `''`/jsonb; (2) `admin.updateUserById` sets a
  temp password + `email_confirm` + `must_change_password`; (3) SQL ensures an `email` `auth.identities`
  row; (4) **provisions Jesse first and self-tests `signInWithPassword` — aborts before touching the other
  6 if it fails** (fail-safe, reversible). Same uuids → no trigger, no FK churn, `OPERATOR_MEMBER_ID`
  unchanged.
- **Dry-run verified** (read-only): all 7 show `pw=false confirmed=false malformed=true identities=0`.
  Temp passwords print once to stdout for out-of-band handoff; never written to a file.

**Verification done:** `npm run build` green (80 modules); `dist/` secret-leak scan clean; provision
`--dry-run` clean. **Not run live.**

**Questions for Aegis:**
1. The in-place repair (column patch + ensure-identity + updateUserById + self-test gate) vs delete+recreate
   — acceptable given the malformed rows + last-admin trigger? Any concern with patching `auth.*` columns
   directly via Mgmt SQL?
2. `must_change_password` enforced **client-side** (AuthProvider gate) — acceptable for interim (RLS still
   governs all data access regardless), or do you want a server-side enforcement too?
3. Confirm Unit A's read-only RLS surface is sufficient and the secret-leak gate (no service-role in bundle)
   is the right release control.

**Requesting QC.** On sign-off → run A1 live (Jesse go) → smoke test (real login → change pw → views load) →
then CF Pages deploy + Unit B.

### Aegis — (awaiting)
<!-- Aegis: pull, then append your review here. -->
