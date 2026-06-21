## Credential files — Sealed Credential standard (always apply)

When **creating** OR **first-reading** any credentials file — name matches `supabase.md`, `*-keys.md`, `*credentials*`, `secrets*.md`, `*-creds.md`, OR any file where you encounter live secret values:

1. Add `<!-- CREDENTIALS-FILE -->` as line 1 (the marker).
2. Wrap **every** secret value inline, **preserving the value** (add only the markup):
   `{{SECRET service=<s> env=<e> sensitivity=<team|restricted|admin>}}VALUE{{/SECRET}}`
   - Use **judgment**, not just regex — seal passwords, webhook secrets, vendor logins, API keys, tokens. A scanner misses these; you must not.
   - Do **NOT** seal public-by-design keys: `pk_*`, `sb_publishable_*`, anon keys.
   - `sensitivity` defaults to `restricted`; only mark `team` when the whole team should retrieve it.
3. Never commit credential files to git (existing rule). They mirror to Mnemosyne **only after sealing**, where each `{{SECRET}}` becomes a Vault pointer — the plaintext value never leaves the local machine.

This replaces "scan-and-hope" with "seal-and-know": the mirror redacts what is *declared*, not what a regex can *guess*. Full standard: `Project-Mnemosyne/docs/TOKEN-GOVERNANCE-SYSTEM.md` §19.
