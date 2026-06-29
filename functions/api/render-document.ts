// Mnemosyne — Document Factory (thread 0023), Phase B: server-side render endpoint.
//
// POST { doc_type, title?, markdown, audience? } -> application/pdf (branded 4ward layout).
// Pipeline: requireMember (JWT -> active member, fail closed) -> strict args -> governance gate
// (scanByPolicy, by catalog category + audience; refuse 422 if not clean) -> renderDocumentHtml
// (markdown-it html:false + trusted tokens) -> Cloudflare Browser Rendering -> PDF.
//
// STATELESS: no persistence, no audit row (Aegis gate 6 — audit enters in Phase D with persistence).
// Actor is the verified JWT member; never caller-supplied.
//
// BROWSER-RENDERING LOCKDOWN (Aegis gate 3):
//   - page.setContent (no URL navigation), JavaScript DISABLED.
//   - request interception ABORTS every request that isn't a data: URI — the HTML references nothing external
//     (logo inlined as data:, system fonts, no scripts), so nothing external can load; interception is the
//     defense-in-depth proof. Aborted-external count is returned in a debug header for the live smoke.
//
// INFRA PREREQ: requires the Browser Rendering binding `BROWSER` on the CF Pages project
// (Dashboard → Settings → Functions → Bindings → Browser Rendering, name "BROWSER"; Workers Paid).
// Until that binding exists, the endpoint returns 503 (cleanly), so deploy is safe before it's enabled.

import puppeteer from '@cloudflare/puppeteer'
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

  // ---- Browser Rendering → PDF (locked down) ----
  const BROWSER = (context.env || {}).BROWSER
  if (!BROWSER) return json({ error: 'render backend unavailable (BROWSER binding not configured)' }, 503)

  let browser: any
  let blockedExternal = 0
  try {
    browser = await puppeteer.launch(BROWSER)
    const page = await browser.newPage()
    await page.setJavaScriptEnabled(false)
    await page.setRequestInterception(true)
    page.on('request', (req: any) => {
      const url = String(req.url() || '')
      // allow only inline data: URIs (the logo); abort anything external (http/https/file/etc.)
      if (url.startsWith('data:')) { req.continue(); return }
      blockedExternal++
      req.abort()
    })
    await page.setContent(html, { waitUntil: 'load' })
    const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true })
    return new Response(pdf, {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `inline; filename="${spec.id}.pdf"`,
        'x-render-blocked-external': String(blockedExternal),
      },
    })
  } catch (e: any) {
    return json({ error: 'render failed', detail: String(e?.message ?? e).slice(0, 200) }, 502)
  } finally {
    if (browser) { try { await browser.close() } catch { /* ignore */ } }
  }
}
// (Only onRequestPost is exported, so CF Pages auto-returns 405 for any non-POST method.)
