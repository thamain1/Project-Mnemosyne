# Team MCP Onboarding — connect to the Mnemosyne shared brain

Hosted MCP is LIVE (thread `0027`, signed off `0031`, 2026-07-02; ownership-parity update 2026-07-04):
`https://project-mnemosyne.pages.dev/api/mcp`. Zero install, zero shared master key — each owner gets
one revocable, fully-audited token and one setup line, with full parity (including vault secrets).

Two roles: **Jesse (operator)** mints tokens; **the teammate** pastes one command. That's the entire process.

---

## 1. Jesse: provision a token (once per person/device)

**2026-07-04 update — ownership parity.** All 7 `team_members` are co-owners with signing authority, not employees/agents, so every owner gets the SAME full-scope grant Jesse has — including `get_secret`. Withholding company secrets from people who already have legal authority over them doesn't reduce risk; it just adds friction. The safe way to give everyone that access isn't copying Jesse's local service-role master key to 6 more laptops (that recreates the exact single-point-of-failure this project exists to kill) — it's this: a scoped, individually-revocable, fully-audited token per owner.

```
cd C:\Dev\Project-Mnemosyne
node --env-file=.env.local scripts/provision-machine.mjs "<label>" --scopes recall,fetch,log_update,brief,get_secret,remember,update --admin
```

- `<label>` — the person's name, e.g. `"Larry"` or `"larry-laptop"` if they'll have more than one device. Idempotent — re-running the same label updates scopes instead of duplicating.
- Scopes: the 7-scope set above is full owner parity — read (`recall`, `fetch`, `brief`), append (`log_update`), write (`remember`, `update`), and vault (`get_secret`).
- `--admin` sets this machine's `role='admin'` in the database. This matters specifically for `get_secret`: the vault's sensitivity gate (unchanged, migration 0010) still requires `role='admin'` to read `admin`/`restricted`-tier secrets — without `--admin`, a token can only read `team`-tier secrets. Every owner should get `--admin`; reserve role=member (omit the flag) for a non-owner agent/build-machine token that shouldn't reach the most sensitive secrets.
- The script prints the plaintext token **exactly once** (never stored, never recoverable — only its SHA-256 hash lives in the DB) plus the ready-to-paste client command. Copy both immediately.
- **Run this yourself, locally — never inside a chat/agent session.** The token prints to your own terminal only; if you run it through an AI assistant session, the token lands in that transcript, which isn't the secure channel below.

Send the printed `claude mcp add ...` line to the teammate over a **DM/secure channel** — never email, never a shared doc, never a commit. It contains a live bearer token that can read every company secret they're authorized for.

## 2. Teammate: one-time setup

Paste the exact line Jesse sends you into a terminal where Claude Code is installed:

```
claude mcp add --transport http mnemosyne https://project-mnemosyne.pages.dev/api/mcp --header "Authorization: Bearer mnk_<your-token>"
```

That's it — no repo clone, no local server, no config file to edit.

**Verify it worked:** in a Claude Code session, ask it to `recall` something (e.g. "recall what OnTheHash is") or `brief` a project. You should get real 4ward memory back. Your `tools/list` should show 7 tools: `recall`, `fetch`, `log_update`, `brief`, `get_secret`, `remember`, `update`.

**Using get_secret:** it takes a `secrets_vault` row id (a uuid), not a name — `recall`/`fetch` search the memory brain, not the vault table directly, so they won't surface a secret by itself. In practice the id comes from a sealed credentials doc (per the 4ward Sealed Credential standard, a doc like `docs/*-keys.md` references the live value as `{{SECRET ...}}get_secret('<uuid>')`) — `recall`/`fetch` that doc to get the pointer, then `get_secret` the uuid for the decrypted value. If you don't know which doc holds a given credential, ask Jesse once; there's no remote "list all secrets" tool by design. Every `get_secret` call is logged (who, when, which secret) — this is a real audit trail, not an honor system, so use it for real need, not curiosity.

## 3. Revoke or rotate

```
node --env-file=.env.local scripts/revoke-machine-token.mjs "<label>"              # kill the token only
node --env-file=.env.local scripts/revoke-machine-token.mjs "<label>" --deactivate # also lock the identity
```

One compromised token → one dead token. The service-role master key is never touched, never leaves Cloudflare.

## Team roster (per `docs/BOOTSTRAP.md`)

| Name | Email | Suggested label |
|---|---|---|
| Larry Golden Jr | larry@4wardmotions.com | `Larry` |
| Jesse Morgan | jmorgan@4wardmotions.com | has `exec-pro` (test token, 4 scopes, no vault) — provision a real full-parity `Jesse` token too if he wants one outside the local operator server |
| David Fagel | dave@4wardmotions.com | `Dave` |
| Bryan Hill | bryan@4wardmotions.com | `Bryan` |
| Brandon Tillman | brandon@4wardmotions.com | `Brandon` |
| Wayne Kuechler | wayne@4wardmotions.com | `Wayne` |
| Haile Hantal | haile@4wardmotions.com | `Haile` |

## Guardrails

- Never share one token across two people/devices — one label per person/device, so revoking one never affects another.
- Never paste a live `mnk_...` token into a repo, ticket, or shared doc.
- Only whoever holds the Mnemosyne `.env.local` service-role key (Jesse) can provision or revoke.
- This covers MCP tool access only. It does **not** create a dashboard login — that's the separate `scripts/provision-team.mjs` (email+password, already run for the 7-person roster).
- `get_secret` returns a decrypted plaintext value in the tool's response — treat that response the same as the secret itself (don't paste it into a shared doc, ticket, or another AI tool's chat that gets logged/shared). The vault read itself is always audited regardless of where the value ends up after.
- If a device is lost/compromised, revoke that person's token immediately (`scripts/revoke-machine-token.mjs`) — with `get_secret` in scope, a live token is now equivalent to that person's access to every secret they're authorized for, not just brain read/append.
