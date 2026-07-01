# Mnemosyne

The shared "second brain" for **4ward Motion Solutions, Inc.** — a durable, access-controlled
knowledge + operations platform that connects every team member to the company's code, contracts
(SOWs/MOUs), credentials, deals, and active work, recallable on demand from any authorized user.

**Why it exists:** today the company's institutional memory lives in one person's local files and
head (single point of failure). Mnemosyne moves that brain into a backed-up, multiplayer system
so the company survives the loss of any individual and every partner can actually *connect and work*.

See [`docs/VISION.md`](docs/VISION.md) for the full architecture, phasing, and decisions. Current
build status and open items live in [`docs/threads/0024-build-improvement-roadmap.md`](docs/threads/0024-build-improvement-roadmap.md).

> Status: **live in production** — https://project-mnemosyne.pages.dev (Cloudflare Pages, deploys
> on push to `main`). Stack: Vite + React + TS + Supabase (Postgres + pgvector + Storage) +
> Cloudflare Pages Functions. Migrations 0001–0022 applied. The **Document Factory** (draft →
> governed brand/secret scan → branded PDF → versioned private Storage → signed download,
> CRM-attachable) is live end-to-end. A local single-operator MCP server (`mcp/`) exposes 6 tools
> — `recall`, `fetch`, `remember`, `update`, `log_update`, `get_secret` — to Claude Code sessions.
>
> The team refers to Claude on this project as **Atlas** (design/planning) and to Codex as
> **Aegis** (QA/QC gate) — see [`docs/VISION.md`](docs/VISION.md) for the working model.
