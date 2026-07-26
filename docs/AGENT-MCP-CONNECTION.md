# Agent MCP Connection — DeepThought

How to connect the **DeepThought** AI agent to the Mnemosyne shared brain over the hosted MCP
endpoint. Companion to `docs/TEAM-MCP-ONBOARDING.md` (that one is for human co-owners; this one is
for a non-human agent identity, which gets a different trust posture — see Guardrails).

Two roles: **Jesse (operator)** mints the token; **DeepThought's operator** pastes one line.

---

## 1. Jesse: mint the token

```
cd C:\Dev\Project-Mnemosyne
node --env-file=.env.local scripts/provision-machine.mjs "DeepThought" --scopes recall,fetch,log_update,brief,get_secret,remember,update,revert,client_brief,client_360 --admin
```

- Reads `VITE_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` from `.env.local`. Nothing to look up or
  paste — the service-role key never appears on screen.
- Idempotent on the label: re-running `"DeepThought"` updates its scopes instead of creating a
  second identity.
- Prints the plaintext token **exactly once**. Only its SHA-256 hash is stored
  (`provision-machine.mjs:70`), so it is not recoverable afterwards — a lost token means minting a
  new one.
- **Run this in a real terminal, never inside a chat/agent session.** The token prints to stdout; an
  AI session puts it in a transcript, which is not the secure handoff channel.

`--admin` sets `team_members.role='admin'`, which is what opens `get_secret`'s admin/restricted
sensitivity gate (migration 0010). Omit it for an agent that should reach only `team`-tier secrets.

---

## 2. Key handoff

> **FILL IN LOCALLY — DO NOT COMMIT A LIVE TOKEN TO THIS FILE.**
> `*-keys.md` is gitignored (`.gitignore:48`); `docs/AGENT-MCP-CONNECTION.md` is **not**. Put the
> live value in `docs/agent-keys.md` (auto-ignored, seal it per the Sealed Credential standard) and
> leave the placeholder below intact in the committed copy.

| Field | Value |
|---|---|
| Agent label | `DeepThought` |
| Token | `mnk_<PASTE-TOKEN-HERE>` |
| Minted on | `<YYYY-MM-DD>` |
| Minted by | `<operator>` |
| Scopes | recall, fetch, log_update, brief, get_secret, remember, update, revert, client_brief, client_360 |
| Role | `admin` |
| Expires | `<none — revoke manually>` |
| Delivered to | `<who / which channel>` |

Send the token over a **DM or other secure channel** — never email, never a shared doc, never a
commit. With `get_secret` + `--admin` in scope it is equivalent to full company vault access.

---

## 3. DeepThought: connect

| | |
|---|---|
| URL | `https://project-mnemosyne.pages.dev/api/mcp` |
| Transport | Streamable HTTP, stateless, POST only |
| Protocol version | `2025-06-18` |
| Auth | `Authorization: Bearer mnk_...` |
| Server info | `mnemosyne` v1.0.0 |

**Claude Code / any MCP CLI client:**

```
claude mcp add --transport http mnemosyne https://project-mnemosyne.pages.dev/api/mcp --header "Authorization: Bearer mnk_<token>"
```

**Raw HTTP** (non-MCP client) — every header below is enforced pre-auth:

```
POST https://project-mnemosyne.pages.dev/api/mcp
Authorization: Bearer mnk_<token>
Content-Type: application/json
Accept: application/json, text/event-stream
MCP-Protocol-Version: 2025-06-18
```

Standard JSON-RPC 2.0 from there: `initialize` → `tools/list` → `tools/call`.

---

## 4. Tool surface

Ten tools live. `tools/list` is scope-filtered, so DeepThought sees exactly what its token grants
(P5-AGENT-DIET).

| Tool | Scope | Rate limit | Notes |
|---|---|---|---|
| `recall` | `recall` | 30/min | hybrid vector + FTS; `k` 1-20, default 8 |
| `fetch` | `fetch` | 20/min | by slug; `max_chars` default 8000; `heading` scoping |
| `brief` | `brief` | 10/min | one-call project orientation, ~16K cap |
| `log_update` | `log_update` | 30/min | append to activity log |
| `remember` | `remember` | 10/min | create new entry |
| `update` | `update` | 10/min | revise existing entry |
| `revert` | `revert` | 6/min | restore an entry to a prior version |
| `get_secret` | `get_secret` | 15/min | vault read, audited |
| `client_360` | `client_360` | 15/min | full CRM client grounding read |
| `client_brief` | `client_brief` | **6/hour** | persists prospect research |

`revert` shipped with thread 0037 Unit L (migration `0034`, applied 2026-07-26). It restores a
memory to a prior `version_no`, refuses secret-contaminated history, uses the same optimistic
concurrency as `update`, and appends new history rather than rewriting it.

---

## 5. Operating rules for DeepThought

Hand these to the agent verbatim. Each one is a hard rejection, not a soft failure.

- **`log_update.action` must start with `agent.` or `work.`** Machine actors are restricted at
  `functions/api/mcp.ts:375` and anything else is a 403 at the access-control tier, not a tool
  error. Use `agent.note`, `work.commit`.
- **`update` requires `expected_updated_at`** — the ISO timestamp the entry showed when you
  `fetch`ed it. Optimistic concurrency is mandatory, so read-before-write is structurally forced.
  There is no blind-write path. `change_reason` is additionally required for canonical entries.
- **`get_secret` takes a `secrets_vault` uuid, not a name.** There is deliberately no list-all tool.
  The uuid comes from a sealed credentials doc: `recall`/`fetch` the doc, read its
  `get_secret('<uuid>')` pointer, then call. Every read is audited as `secret.read` attributed to
  DeepThought. The response contains decrypted plaintext — never log it, never echo it into another
  tool's context.
- **`remember` and `update` refuse secret-bearing content** at ingress. Secrets belong in the vault,
  never embedded in a memory body.
- **`client_brief` never auto-creates a client.** Unknown or ambiguous names return a structured
  error rather than a guess. Resolve or create the client in the CRM tab first.
- **No browser-hosted clients.** Any `Origin` header is 403 pre-auth (including `https://claude.ai`),
  and any non-POST method is 405 with `Allow: POST, GET`. This is a deliberate v1 scope decision
  (thread 0029 item 4), not a gap. DeepThought must run CLI or server-side.
- **64KB request body cap**, 413 beyond it.

---

## 6. Verify the connection

1. `tools/list` → expect exactly 10 tool names.
2. `brief` with `project: "Mnemosyne"` → should return real project state.
3. Operator-side attribution check: `activity_log` rows should show `source='mcp'` with the actor
   resolving to the `DeepThought` machine row.

---

## 7. Revoke

```
node --env-file=.env.local scripts/revoke-machine-token.mjs "DeepThought"              # kill the token
node --env-file=.env.local scripts/revoke-machine-token.mjs "DeepThought" --deactivate # also lock the identity
```

One compromised token → one dead token. No other identity is affected and the service-role key is
never touched, never leaves Cloudflare.

---

## Guardrails

- This is a **non-human agent identity**. The 2026-07-04 ownership-parity decision that granted full
  scopes to the 7 co-owners was reasoned from their legal signing authority over the company. That
  reasoning does not transfer to an agent. `--admin` + `get_secret` here is a deliberate operator
  override, not the default posture — `docs/TEAM-MCP-ONBOARDING.md:22` explicitly reserves
  `role='member'` for non-owner agent and build-machine tokens.
- With that grant, DeepThought can read every `admin`/`restricted` tier secret in the vault, returned
  as decrypted plaintext into its context. If DeepThought's conversations are logged, synced, or
  reviewed anywhere outside your control, treat every secret it touches as disclosed. Revocation is
  the only mitigation.
- Never share one token across two agents or devices — one label each, so revoking one never
  affects another.
- Never paste a live `mnk_...` token into a repo, ticket, or shared doc. See §2.
- Only whoever holds `.env.local` (Jesse) can provision or revoke.
- This grants MCP tool access only. It does **not** create a dashboard login — that is the separate
  `scripts/provision-team.mjs` path.
