# 0020 — Unit B++: Memories force-graph layout

**Status:** 🟢 **Built — frontend-only, read-only.** Awaiting Aegis awareness check (new dependency) +
Jesse push. · **Owner:** Atlas · **Opened:** 2026-06-16

**Topic:** Jesse asked to replace the Memories page's flat card "first layer" (called it boring/inefficient)
with a **node/force-graph constellation** — keep the existing detail modal on node-select. The memory corpus
is already a graph (`[[links]]` + `tags`/`applies-to:`), so a graph is the natural first layer.

**Decisions (Jesse):** library = **react-force-graph-2d** (turnkey canvas component); edges = **hubs + links +
applies-to** (a hub node per project/topic; entries link to their hub; `[[links]]` between entries;
code-snippet/`applies-to:` → other projects' hubs to surface the cross-project code library).

---

### Atlas — 2026-06-16 (Unit B++ for awareness)

**Scope:** purely a **read-only frontend visualization**. No migration, no endpoint, no RLS/boundary change,
no new secret. It derives the graph entirely from data the Memories page already loads under the existing
team-readable RLS select.

**Changes:**
- **New dep `react-force-graph-2d@1.29.1`** (published 2026-02-04 — past the 14-day window; Jesse explicitly
  chose it). Canvas-based (the 2D build; not the three.js 3D variant). **Audit note:** `npm audit` shows 2
  high-severity advisories, both in the **pre-existing `vite`/`esbuild` dev toolchain** (dev-server SSRF), NOT
  in react-force-graph or its tree, and not introduced by this install. Did **not** run `audit fix --force`
  (it would bump Vite to v8 — an unrelated breaking change).
- **`src/components/MemoryGraph.tsx`** — builds `{nodes, links}` from the loaded entries: entry nodes colored
  by `kind`, one hub node per `entryGroupKey` (project/topic), edges entry→hub + `[[links]]` (only when the
  target entry is in view) + `applies-to:` → that project's hub. Click an entry node → the **existing detail
  modal** (`openEntry`); click a hub → zoom to it. Legend + snippet ring for `code-snippet`.
- **`src/pages/Memories.tsx`** — adds a **Graph ⇄ Cards** view toggle (browse mode); **graph is the default**,
  cards retained. Semantic-search results stay as ranked cards. Added `links` to the entry select (defensive
  fallback chain unchanged).
- **Code-split:** `MemoryGraph` is `lazy()`-loaded → the ~192 KB graph chunk (gzip 63) loads only when the
  graph view opens; the main bundle stays ~413 KB (unchanged from before this unit).

**Verified:** `npm run build` green (`tsc -b` + vite; chunk-size warning resolved by the code-split); `dist/`
leak scan clean (no service-role/secret/access-token markers).

**For Aegis (awareness, not a blocking gate — no new server surface):**
1. New client dependency `react-force-graph-2d` — anything beyond the pre-existing vite/esbuild dev-only
   advisories worth flagging? (It's client-only canvas rendering; no network/secret access.)
2. Confirm there's no data-exposure delta: the graph shows the same fields the cards already showed (name,
   title, kind, tags, links) under the same RLS read — no bodies, no new columns.

### Aegis — (awaiting)
<!-- Aegis: pull, then append any notes here. -->
