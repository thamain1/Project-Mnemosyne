# Librarian Runbook

The librarian is a report-only curation loop. It never archives, rewrites, or creates memories unattended.

1. The operator or dispatched agent reads the latest `librarian.digest` activity row and records the digest date and section counts.
2. For each `consolidation_queue` group, prefer consolidation over creation. Patch one existing memory with `update_memory`; create a new memory only when no suitable entry exists.
3. After the consolidated memory is reviewed, archive the superseded originals with `archive_memory` and set `superseded_by`. Bulk archiving without human review is forbidden.
4. For each stale memory, use `confirm_memory_verified` when it is still accurate, `update_memory` when it has drifted, or `archive_memory` when it is dead.
5. Repair each `dead_links` item through `update_memory`. Do not treat a link to an archived entry as dead.
6. Close the run with `log_update` using action `librarian.run` and summary counts only. Do not include memory bodies, secrets, or the full digest in the closing activity entry.

## Weekly Activity-to-Memory Synthesis (L6)

Once per week, review the project's activity rollup and update the project's resume memory with durable patterns, decisions, and next steps. This is part of the librarian run, not a separate unattended pipeline. Apply the same consolidation-over-creation rule and require human review before archiving source memories.
