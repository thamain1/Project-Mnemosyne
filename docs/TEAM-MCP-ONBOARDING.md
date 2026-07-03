# Team MCP Onboarding — connect to the Mnemosyne shared brain

Hosted MCP is LIVE (thread `0027`, signed off `0031`, 2026-07-02): `https://project-mnemosyne.pages.dev/api/mcp`.
Zero install, zero shared master key — each teammate gets one revocable token and one setup line.

Two roles: **Jesse (operator)** mints tokens; **the teammate** pastes one command. That's the entire process.

---

## 1. Jesse: provision a token (once per person/device)

```
cd C:\Dev\Project-Mnemosyne
node --env-file=.env.local scripts/provision-machine.mjs "<label>" --scopes recall,fetch,log_update,brief
```

- `<label>` — the person's name, e.g. `"Larry"` or `"larry-laptop"` if they'll have more than one device. Idempotent — re-running the same label updates scopes instead of duplicating.
- Scopes: `recall,fetch,log_update,brief` is the recommended full read/append set for a human teammate (same as Jesse's own `exec-pro` grant). `get_secret` and `remember`/`update` are **not exposed remotely at all** — vault access and durable-memory writes stay local-operator-only, so there's no scope that leaks either.
- The script prints the plaintext token **exactly once** (never stored, never recoverable — only its SHA-256 hash lives in the DB) plus the ready-to-paste client command. Copy both immediately.

Send the printed `claude mcp add ...` line to the teammate over a **DM/secure channel** — never email, never a shared doc, never a commit. It contains a live bearer token.

## 2. Teammate: one-time setup

Paste the exact line Jesse sends you into a terminal where Claude Code is installed:

```
claude mcp add --transport http mnemosyne https://project-mnemosyne.pages.dev/api/mcp --header "Authorization: Bearer mnk_<your-token>"
```

That's it — no repo clone, no local server, no config file to edit.

**Verify it worked:** in a Claude Code session, ask it to `recall` something (e.g. "recall what OnTheHash is") or `brief` a project. You should get real 4ward memory back. Your `tools/list` should show exactly 4 tools: `recall`, `fetch`, `log_update`, `brief` — no `get_secret`, no `remember`.

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
| Jesse Morgan | jmorgan@4wardmotions.com | already has `exec-pro` |
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
