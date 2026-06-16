# Tag Refinement Proposals (Memory Entries) — Helios

This document contains proposed tag refinements for the 62 `reference` and `feedback` memory entries. 
Each entry was analyzed for content judgment, secret-scanned (all safe), and classified for cross-project reuse.

**Hard Rules Applied:**
1. **Secret Scan:** All 62 entries scanned; 0 quarantined.
2. **Merge Semantics:** Proposing `+adds` and `-removes` only. No full array rewrites.
3. **No DB Writes:** This document is the handoff for Atlas to review and apply.

---

## Refinement List

### 1. Agent & Process Strategy
Categorizing meta-advice on how agents work and collaborate.

| Entry Name | Kind | Current Tags | +Adds | -Removes | Rationale |
|---|---|---|---|---|---|
| `claude-session-strategy` | feedback | `topic:claude` | `topic:agent-strategy`, `applies-to:mnemosyne` | `topic:claude` | High-level process advice. |
| `feedback-agent-coordination-in-repo` | feedback | `topic:agent` | `topic:agent-strategy`, `applies-to:mnemosyne` | `topic:agent` | Coordination protocol for Mnemosyne. |
| `feedback-codex-qa-collaboration` | feedback | `topic:codex` | `topic:agent-strategy`, `applies-to:mnemosyne`, `applies-to:onthehash`, `applies-to:perks` | `topic:codex` | Reusable multi-agent pattern. |
| `feedback-git-push` | feedback | `topic:git` | `topic:agent-strategy`, `applies-to:mnemosyne` | `topic:git` | Workflow safety rule. |
| `feedback-multi-claude-repo-pattern` | feedback | `topic:multi` | `topic:agent-strategy`, `applies-to:pallets`, `applies-to:mnemosyne` | `topic:multi` | Collaboration standard. |
| `feedback-two-claude-install-pattern` | feedback | `topic:two` | `topic:agent-strategy`, `applies-to:mnemosyne`, `applies-to:intellioptics` | `topic:two` | Remote deployment strategy. |
| `reference-build-strategy-docs` | reference | `reusable`, `topic:build` | `topic:agent-strategy`, `applies-to:mnemosyne` | `topic:build` | Research on agentic frameworks. |

### 2. Database & Supabase
Technical patterns for DB integrity, migrations, and RLS.

| Entry Name | Kind | Current Tags | +Adds | -Removes | Rationale |
|---|---|---|---|---|---|
| `feedback-idempotent-seeds` | feedback | `topic:idempotent` | `topic:database`, `code-snippet`, `applies-to:perks`, `applies-to:onthehash`, `applies-to:just-as-iam` | `topic:idempotent` | Contains Prisma patterns. |
| `feedback-intelliservice-enum-to-text-migration` | feedback | `topic:intelliservice` | `topic:database`, `code-snippet`, `applies-to:intelliservice` | | Complex SQL migration pattern. |
| `feedback-mavenpark-migrations` | feedback | `topic:mavenpark` | `topic:database`, `applies-to:mavenpark`, `applies-to:intellioptics` | `topic:mavenpark` | Cross-project DB safety rule. |
| `feedback-supabase-edge-function-public` | feedback | `topic:supabase` | `code-snippet`, `applies-to:mentorapp`, `applies-to:just-as-iam`, `applies-to:mnemosyne` | | Contains config snippet. |
| `feedback-supabase-insert-payload` | feedback | `topic:supabase` | `applies-to:intelliservice`, `applies-to:mentorapp`, `applies-to:just-as-iam` | | Pattern-based bug fix. |
| `feedback-supabase-live-drift` | feedback | `topic:supabase` | `code-snippet`, `applies-to:mentorapp`, `applies-to:mnemosyne` | | Contains SQL audit queries. |
| `feedback-supabase-no-upsert-without-update-policy` | feedback | `topic:supabase` | `code-snippet`, `applies-to:mentorapp`, `applies-to:just-as-iam`, `applies-to:mnemosyne` | | Contains TS pattern snippet. |
| `feedback-supabase-rls-recursion` | feedback | `topic:supabase` | `applies-to:mentorapp`, `applies-to:just-as-iam`, `applies-to:mnemosyne` | | Architectural fix for RLS. |
| `feedback-supabase-storage-rls` | feedback | `topic:supabase` | `code-snippet`, `applies-to:intelliservice`, `applies-to:mentorapp`, `applies-to:just-as-iam`, `applies-to:mnemosyne` | | Contains SQL policy template. |
| `feedback-supabase-types-drift` | feedback | `topic:supabase` | `code-snippet`, `applies-to:mentorapp`, `applies-to:just-as-iam`, `applies-to:mnemosyne` | | Contains regen command. |
| `feedback-supabase-uri-allowlist-www` | feedback | `topic:supabase` | `applies-to:just-as-iam`, `applies-to:mentorapp`, `applies-to:mnemosyne` | | Auth configuration rule. |
| `feedback-supabase-use-otp-not-link` | feedback | `topic:supabase` | `code-snippet`, `applies-to:mentorapp`, `applies-to:just-as-iam`, `applies-to:mnemosyne` | | Contains TS verification snippet. |
| `reference-email-compliance-gate-pattern` | reference | `code-snippet`, `reusable`, `topic:email` | `topic:database`, `applies-to:pallets`, `applies-to:impacttracker` | `topic:email` | Postgres function template. |
| `reference-gamification-plays-system` | reference | `code-snippet`, `reusable`, `topic:gamification` | `topic:database`, `applies-to:onthehash`, `applies-to:perks` | `topic:gamification` | SQL schema for plays currency. |
| `reference-mentorapp-orgs-rls` | reference | `reusable`, `topic:mentorapp` | `topic:supabase`, `applies-to:mentorapp`, `applies-to:just-as-iam` | `topic:mentorapp` | Gap analysis for RLS. |
| `reference-p2pnow-notifications-type-check` | reference | `reusable`, `topic:p2pnow` | `topic:supabase`, `applies-to:p2pnow`, `applies-to:mentorapp`, `applies-to:just-as-iam` | `topic:p2pnow` | DB constraint documentation. |
| `reference-supabase-auth-logs-cloud` | reference | `reusable`, `topic:supabase` | `applies-to:mnemosyne` | | Cloud logging strategy. |

### 3. Frontend & UX
Browser quirks, CSS patterns, and terminology.

| Entry Name | Kind | Current Tags | +Adds | -Removes | Rationale |
|---|---|---|---|---|---|
| `feedback-ios-safari-quirks` | feedback | `topic:ios` | `topic:frontend`, `code-snippet`, `applies-to:mentorapp`, `applies-to:just-as-iam`, `applies-to:intelliservice` | `topic:ios` | HTML/CSS overlay pattern. |
| `feedback-mentorapp-admin-ui-rules` | feedback | `topic:mentorapp` | `topic:ux-design`, `applies-to:mentorapp`, `applies-to:just-as-iam` | `topic:mentorapp` | UX rules for admin surfaces. |
| `feedback-mentorapp-no-undisclosed-features` | feedback | `topic:mentorapp` | `topic:ux-design`, `applies-to:mentorapp`, `applies-to:just-as-iam` | `topic:mentorapp` | Policy on clean UI. |
| `feedback-signshop-equipment-terminology` | feedback | `topic:signshop` | `topic:ux-design`, `applies-to:allsigns`, `applies-to:intelliservice` | `topic:signshop` | Industry-specific UX terms. |
| `reference-mentorapp-appshell-minhscreen` | reference | `code-snippet`, `reusable`, `topic:mentorapp` | `topic:frontend`, `applies-to:mentorapp`, `applies-to:just-as-iam` | `topic:mentorapp`, `code-snippet` | CSS advice (no snippet block). |
| `reference-mentorapp-modal-top-clipping` | reference | `reusable`, `topic:mentorapp` | `topic:frontend`, `code-snippet`, `applies-to:mentorapp`, `applies-to:just-as-iam` | `topic:mentorapp` | Contains CSS calc snippet. |
| `reference-mentorapp-modal-z-index` | reference | `reusable`, `topic:mentorapp` | `topic:frontend`, `code-snippet`, `applies-to:mentorapp`, `applies-to:just-as-iam` | `topic:mentorapp` | Contains Tailwind class fix. |
| `reference-web-app-geofencing` | reference | `code-snippet`, `reusable`, `topic:web` | `topic:frontend`, `applies-to:onthehash`, `applies-to:perks` | `topic:web`, `code-snippet` | Architecture table (no snippet). |

### 4. DevOps & Cloud
Hosting, DNS, and environment management.

| Entry Name | Kind | Current Tags | +Adds | -Removes | Rationale |
|---|---|---|---|---|---|
| `feedback-buildregistry-alias-map` | feedback | `topic:buildregistry` | `topic:dev-ops`, `applies-to:mnemosyne` | `topic:buildregistry` | Internal tool instruction. |
| `feedback-mavenpark-dev-workflow` | feedback | `topic:mavenpark` | `topic:dev-ops`, `applies-to:mavenpark`, `applies-to:intellioptics` | `topic:mavenpark` | Workflow optimization. |
| `feedback-mentorapp-no-redirects-file` | feedback | `topic:mentorapp` | `topic:cloudflare`, `applies-to:mentorapp`, `applies-to:just-as-iam`, `applies-to:mnemosyne` | `topic:mentorapp` | CF edge safety rule. |
| `feedback-mentorapp-p2p-jai-mirror` | feedback | `topic:mentorapp` | `topic:dev-ops`, `applies-to:mentorapp`, `applies-to:just-as-iam` | `topic:mentorapp` | Multi-repo sync protocol. |
| `feedback-verify-with-npm-run-build` | feedback | `topic:verify` | `topic:dev-ops`, `applies-to:mnemosyne`, `applies-to:mentorapp`, `applies-to:just-as-iam` | `topic:verify` | Build verification rule. |
| `reference-cf-pages-contact-form-pattern` | reference | `code-snippet`, `reusable`, `topic:cf` | `topic:cloudflare`, `applies-to:pallets`, `applies-to:mnemosyne` | `topic:cf` | Astro/SendGrid pattern. |
| `reference-cf-pages-emergency-rollback` | reference | `reusable`, `topic:cf` | `topic:cloudflare`, `applies-to:mnemosyne`, `applies-to:mentorapp`, `applies-to:just-as-iam` | `topic:cf` | Recovery guide. |
| `reference-cf-pages-silent-partial-upload` | reference | `reusable`, `topic:cf` | `topic:cloudflare`, `code-snippet`, `applies-to:mnemosyne`, `applies-to:mentorapp`, `applies-to:just-as-iam` | `topic:cf` | Diagnostic command pattern. |
| `reference-dns-lives-at-nameserver` | reference | `reusable`, `topic:dns` | `topic:dev-ops`, `code-snippet`, `applies-to:mnemosyne`, `applies-to:impacttracker` | `topic:dns` | Infrastructure triage guide. |

### 5. Security & Business Logic
Compliance, secrets, and commercial rules.

| Entry Name | Kind | Current Tags | +Adds | -Removes | Rationale |
|---|---|---|---|---|---|
| `feedback-engagement-docs-before-build` | feedback | `topic:engagement` | `topic:business-logic`, `applies-to:mnemosyne` | `topic:engagement` | Commercial gate rule. |
| `feedback-no-ai-disclosure-in-contracts` | feedback | `topic:no` | `topic:business-logic`, `applies-to:mnemosyne`, `applies-to:onthehash` | `topic:no` | Wording strategy. |
| `feedback-no-client-pii-on-public-repos` | feedback | `topic:no` | `topic:security`, `applies-to:pallets`, `applies-to:mnemosyne` | `topic:no` | Public safety guardrail. |
| `feedback-no-contracts-in-repos` | feedback | `topic:no` | `topic:security`, `applies-to:mnemosyne`, `applies-to:onthehash`, `applies-to:perks` | `topic:no` | Leakage prevention. |
| `feedback-no-vendor-specifics-in-client-docs` | feedback | `topic:no` | `topic:business-logic`, `applies-to:mnemosyne`, `applies-to:onthehash`, `applies-to:perks` | `topic:no` | IP protection strategy. |
| `feedback-p2pnow-org-isolation-critical` | feedback | `topic:p2pnow` | `topic:security`, `applies-to:p2pnow`, `applies-to:mentorapp`, `applies-to:just-as-iam` | `topic:p2pnow` | Multi-tenant safety. |
| `feedback-package-14-day-rule` | feedback | `topic:package` | `topic:security`, `applies-to:mnemosyne` | `topic:package` | Supply-chain risk rule. |
| `feedback-pricing-advice-welcome` | feedback | `topic:pricing` | `topic:business-logic`, `applies-to:mnemosyne` | `topic:pricing` | Relationship strategy. |
| `feedback-signshop-install-material-types` | feedback | `topic:signshop` | `topic:business-logic`, `applies-to:allsigns`, `applies-to:intelliservice` | `topic:signshop` | Core domain logic. |

### 6. Miscellaneous / Project Meta
General project info and multi-cutting topics.

| Entry Name | Kind | Current Tags | +Adds | -Removes | Rationale |
|---|---|---|---|---|---|
| `feedback-gemini-no-response-schema` | feedback | `topic:gemini` | `topic:ai-integration`, `applies-to:impacttracker`, `applies-to:mnemosyne` | `topic:gemini` | LLM architectural advice. |
| `feedback-mentorapp-edge-function-helper` | feedback | `topic:mentorapp` | `topic:supabase`, `code-snippet`, `applies-to:mentorapp`, `applies-to:just-as-iam` | `topic:mentorapp` | Supabase helper pattern. |
| `feedback-mentorapp-ios-chrome-stale-cache` | feedback | `topic:mentorapp` | `topic:qa-process`, `applies-to:mentorapp`, `applies-to:just-as-iam` | `topic:mentorapp` | Triage advice. |
| `feedback-mentorapp-post-auth-landing` | feedback | `topic:mentorapp` | `topic:authentication`, `applies-to:mentorapp`, `applies-to:just-as-iam` | `topic:mentorapp` | Auth routing logic. |
| `feedback-sendgrid-email-standard` | feedback | `topic:sendgrid` | `topic:email`, `applies-to:onthehash`, `applies-to:perks`, `applies-to:mnemosyne` | `topic:sendgrid` | Email provider standard. |
| `intelliservice` | reference | `reusable`, `topic:intelliservice` | `topic:project-meta`, `applies-to:intelliservice` | `topic:intelliservice` | Repo directory. |
| `reference-gemini-multi-app-setup` | reference | `reusable`, `topic:gemini` | `topic:ai-integration`, `applies-to:impacttracker`, `applies-to:pallets`, `applies-to:mnemosyne` | `topic:gemini` | Account strategy. |
| `reference-mentorapp-messaging` | reference | `code-snippet`, `reusable`, `topic:mentorapp` | `topic:project-meta`, `applies-to:mentorapp`, `applies-to:just-as-iam` | `topic:mentorapp`, `code-snippet` | Internal messaging notes. |
| `reference-mentorapp-runbook` | reference | `code-snippet`, `reusable`, `topic:mentorapp` | `topic:qa-process`, `code-snippet`, `applies-to:mentorapp`, `applies-to:just-as-iam` | `topic:mentorapp` | Admin forensic queries. |
| `reference-mentorapp-smoke-test` | reference | `reusable`, `topic:mentorapp` | `topic:qa-process`, `applies-to:mentorapp`, `applies-to:just-as-iam` | `topic:mentorapp` | Validation list. |
| `reference-mes-sla-service-contracts` | reference | `reusable`, `topic:intelliservice` | `topic:project-meta`, `applies-to:intelliservice` | `topic:intelliservice` | Domain module docs. |
| `reference-p2pnow-notifications-type-check` | reference | `reusable`, `topic:p2pnow` | `topic:supabase`, `applies-to:p2pnow`, `applies-to:mentorapp`, `applies-to:just-as-iam` | `topic:p2pnow` | DB constraint docs. |
| `reference-supabase-auth-logs-cloud` | reference | `reusable`, `topic:supabase` | `applies-to:mnemosyne` | | Cloud logging strategy. |

---
Co-Authored-By: Helios (Gemini) <helios@4wardmotions.com>
