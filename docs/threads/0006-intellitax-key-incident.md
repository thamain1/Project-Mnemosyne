# 0006 — IntelliTax service-role key disclosure (incident)

**Status:** 🟠 **OPEN — remediation deferred by Jesse (2026-06-15)** to prioritize finishing Project 4ward
+ client builds. Tracked here; not blocking 4ward (data reconciliation approved in `0005`). · **Owner:**
Jesse (IntelliTax-side action) · Atlas (tracking) · **Opened:** 2026-06-15 by Atlas

---

### Atlas — 2026-06-15 (incident log)

**What:** A **live Supabase service-role key** for the IntelliTax project (`ftihkwpirdvykfqabgic`) was stored
in plaintext in the memory topic file `intellitax.md` (a Supabase-creds section). Service-role keys bypass
RLS — high value.

**Disclosure path (the part I initially missed; Aegis caught it in `0005`):** during the 4ward Helios
frontmatter-backfill (`0005`), **Helios (the Gemini CLI) classified `intellitax.md`** to propose its
frontmatter. Producing that content-derived description means Helios read the file body, and per `GEMINI.md`
Helios-processed content is sent to Google's API. **Therefore the service-role key was very likely
transmitted to Google's Gemini API.** Treat as disclosed to a third party.

- Distinct from the 4ward **ingestion** path, which correctly **quarantined** `intellitax.md` before any
  embed — so the key is **not** in the 4ward brain and was never sent via the ingest/embed pipeline.
- The disclosure was the **Helios classification step**, not ingestion.

**Scope of the credential found in the file:**
- **Service-role key** — live, high-value → **rotate.**
- **Anon key** — not secret (RLS-protected, client-distributable) → no rotation.
- **`sbp_d626…` mgmt token** — already revoked (2026-06-04) → no action.

**Remediation (deferred; IntelliTax-side, via its own controlled deploy):**
1. Rotate the IntelliTax service-role key in the Supabase dashboard; update IntelliTax `.env` + CF Pages
   secrets; redeploy.
2. Confirm the plaintext key is absent from the IntelliTax repo git history and any synced backup within
   the team's control.
3. (Done in 4ward) the key is redacted from the canonical `intellitax.md`; the stored brain content is
   scanner-clean (0 `sbp_`/JWT across all 12 IntelliTax texts in the DB).

**Root cause:** the backfill worklist was derived from "files missing frontmatter" **without
cross-checking the known quarantine list**, so a secret-bearing file was handed to a data-plane agent
that ships content to Google. Contributing: a live secret was stored in plaintext in a memory file.

**Prevention (bank into the working model):**
- Any worklist handed to Helios MUST be diffed against the quarantine/secret list first; never hand a
  secret-bearing file to a data-plane agent.
- Live secrets do not belong in plaintext memory files — they belong in the audited `secrets_vault`
  (the very capability Phase 1's `get_secret` unit will provide).

**Decision:** Jesse deferred remediation to move forward (2026-06-15); logged as an open incident to action
on the IntelliTax side later. Aegis's security close-out in `0005` remains **not approved** until rotation
+ confirmations above are done.

### Aegis — (awaiting close-out when remediation is performed)
<!-- Aegis: append your close-out review once the key is rotated + scope confirmed. -->
