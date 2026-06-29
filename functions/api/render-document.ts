// Mnemosyne — Document Factory (thread 0023), Phase B: server-side render endpoint.
//
// POST { doc_type, title?, markdown, audience? } -> application/pdf (branded 4ward layout).
// Pipeline: requireMember (JWT -> active member, fail closed) -> strict args -> governance gate
// (scanByPolicy, by catalog category + audience; refuse 422 if not clean) -> renderDocumentHtml
// (markdown-it html:false + trusted tokens) -> Cloudflare Browser Rendering REST API -> PDF.
//
// WHY THE REST API (not the puppeteer binding): Cloudflare Pages Functions CANNOT bind Browser Rendering —
// the `browser` binding is Workers-only (Pages supports only a subset of bindings). These endpoints are Pages
// Functions, so we call the Browser Rendering REST /pdf endpoint with an API token instead. Same product, no
// binding required, and the lockdown is cleaner.
//
// STATELESS: no persistence, no audit row (Aegis gate 6 — audit enters in Phase D with persistence).
// Actor is the verified JWT member; never caller-supplied.
//
// BROWSER LOCKDOWN (Aegis gate 3): `allowRequestPattern: ["^data:"]` — the ONLY requests permitted during
// render are inline data: URIs (the base64 logo). Every external request (http/https/file/font/etc.) is
// structurally blocked. The HTML itself references nothing external (logo inlined, system fonts, no scripts,
// markdown rendered with html:false), so there is no external surface to begin with; the allow-list is the
// belt-and-suspenders proof.
//
// INFRA PREREQ (server-side env on the CF Pages project, NOT VITE_):
//   - CF_ACCOUNT_ID            — Cloudflare account id.
//   - CF_BROWSER_RENDERING_TOKEN — API token with the "Browser Rendering: Edit" permission.
// Until both are set the endpoint returns 503 cleanly (deploy-safe before they exist).

import { requireMember, parseStrict, json } from '../_lib/member-auth'
import { renderDocumentHtml } from '../_lib/render-core'
import { docTypeById } from '../_lib/brand-template'
import { scanByPolicy, policyFor } from '../_lib/contract-scan'

const MAX_TITLE_LEN = 300
const MAX_MARKDOWN_LEN = 200_000   // generous outer bound for a long document

export const onRequestPost = async (context: any): Promise<Response> => {
  // ---- auth (fail closed) ----
  const auth = await requireMember(context)
  if (!auth.ok) return auth.res

  // ---- strict args ----
  const parsed = await parseStrict(context, ['doc_type', 'title', 'markdown', 'audience'])
  if (!parsed.ok) return parsed.res
  const body = parsed.body

  const spec = docTypeById(typeof body.doc_type === 'string' ? body.doc_type : '')
  if (!spec) return json({ error: '"doc_type" must be a known document type' }, 400)
  if (typeof body.markdown !== 'string' || !body.markdown.trim()) return json({ error: '"markdown" must be a non-empty string' }, 400)
  if (body.markdown.length > MAX_MARKDOWN_LEN) return json({ error: `"markdown" exceeds ${MAX_MARKDOWN_LEN} chars` }, 400)
  let title = spec.renderTitle
  if (body.title !== undefined) {
    if (typeof body.title !== 'string' || !body.title.trim()) return json({ error: '"title" must be a non-empty string' }, 400)
    if (body.title.length > MAX_TITLE_LEN) return json({ error: `"title" exceeds ${MAX_TITLE_LEN} chars` }, 400)
    title = body.title.trim()
  }
  let audience: 'client' | 'internal' = 'client'
  if (body.audience !== undefined) {
    if (body.audience !== 'client' && body.audience !== 'internal') return json({ error: '"audience" must be "client" or "internal"' }, 400)
    audience = body.audience
  }

  // ---- governance gate (before render) ----
  const policy = policyFor(spec.category, audience)
  const scan = scanByPolicy(body.markdown, policy)
  if (!scan.clean) return json({ error: 'prohibited content', policy, hits: scan.hits }, 422)

  // ---- render to branded HTML (safe: html:false + trusted tokens) ----
  const html = renderDocumentHtml({ title, markdown: body.markdown })

  // ---- Browser Rendering REST API → PDF (locked down) ----
  const env = context.env || {}
  const ACCOUNT = env.CF_ACCOUNT_ID
  const TOKEN = env.CF_BROWSER_RENDERING_TOKEN
  if (!ACCOUNT || !TOKEN) return json({ error: 'render backend unavailable (CF Browser Rendering not configured)' }, 503)

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 45000)
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/browser-rendering/pdf`, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      // allow ONLY inline data: requests (the logo); everything external is blocked → no remote load possible.
      body: JSON.stringify({ html, allowRequestPattern: ['^data:'] }),
      signal: ctrl.signal,
    })
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200)
      return json({ error: 'render failed', status: res.status, detail }, 502)
    }
    const pdf = await res.arrayBuffer()
    return new Response(pdf, {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `inline; filename="${spec.id}.pdf"`,
      },
    })
  } catch (e: any) {
    return json({ error: 'render failed', detail: String(e?.message ?? e).slice(0, 200) }, 502)
  } finally {
    clearTimeout(timer)
  }
}
// (Only onRequestPost is exported, so CF Pages auto-returns 405 for any non-POST method.)
