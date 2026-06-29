// Mnemosyne — Document Factory (thread 0023), Phase B: safe markdown → branded HTML render core.
//
// Turns a document's markdown into the branded 4ward HTML the PDF renderer prints. SECURITY POSTURE
// (Aegis gates 2 + 3): member/model-supplied markdown is HOSTILE INPUT.
//   - markdown-it with `html: false` → NO raw-HTML path at all (tags are escaped, never rendered).
//   - `linkify: false` + strict `validateLink` → only http/https/mailto/relative links; javascript:/data:/
//     file:/unknown schemes blocked.
//   - The few places that legitimately need HTML structure (centered logo, signature grid) are NOT raw HTML
//     in the markdown — they are TRUSTED BLOCK TOKENS (`{{block:NAME ...}}`) from a strict ALLOW-LIST,
//     expanded by THIS module's own trusted templates. Unknown tokens are escaped to literal text (harmless).
//     Token parameter VALUES are HTML-escaped and only ever placed as TEXT CONTENT — never as HTML attributes
//     (Aegis: "do not allow user-supplied token parameters to become HTML attributes").
//
// PDF generation is the endpoint's job (Cloudflare Browser Rendering); this module is pure + keyless-testable.

import MarkdownIt from 'markdown-it'
import { wrapBrandedHtml } from './brand-template'
import { LOGO_DATA_URI } from './brand-logo'

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

// markdown-it: no raw HTML, no autolink. Strict link scheme validation.
const md = new MarkdownIt({ html: false, linkify: false, breaks: false, typographer: false })
md.validateLink = (url: string): boolean => {
  const u = String(url).trim()
  if (/^(javascript|vbscript|data|file):/i.test(u)) return false   // explicit deny
  if (/^(https?:|mailto:)/i.test(u)) return true                   // explicit allow
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) return true                 // no scheme → relative/anchor, allow
  return false                                                     // any other scheme → block
}

// ── Trusted block tokens ──────────────────────────────────────────────────────────────────────────────────
// Strict allow-list. Each builder returns trusted HTML; param values are escaped + placed only as text.
const FOURWARD_SIGNATURE_HTML =
  `<div class="signature-block">` +
  `<p class="signature-party"><strong>4ward Motion Solutions, Inc.</strong></p>` +
  `<p><span class="signature-label">By:</span><span class="signature-line"></span></p>` +
  `<p><span class="signature-label">Name:</span>Jesse Morgan</p>` +
  `<p><span class="signature-label">Title:</span>Co-Founder and CTO</p>` +
  `<p><span class="signature-label">Date:</span><span class="date-line"></span></p>` +
  `</div>`

function clientSignatureHtml(params: Record<string, string>): string {
  const entity = escapeHtml(params.entity || '[Client]')
  const name = escapeHtml(params.name || '')
  const title = escapeHtml(params.title || '')
  return `<div class="signature-block">` +
    `<p class="signature-party"><strong>${entity}</strong></p>` +
    `<p><span class="signature-label">By:</span><span class="signature-line"></span></p>` +
    `<p><span class="signature-label">Name:</span>${name}</p>` +
    `<p><span class="signature-label">Title:</span>${title}</p>` +
    `<p><span class="signature-label">Date:</span><span class="date-line"></span></p>` +
    `</div>`
}

// allow-list: token name → builder(params) → trusted HTML
const TRUSTED_BLOCKS: Record<string, (p: Record<string, string>) => string> = {
  logo: () => `<div class="logo"><img src="${LOGO_DATA_URI}" alt="4ward Motion" /></div>`,
  signature: (p) => `<div class="signature-grid">${FOURWARD_SIGNATURE_HTML}${clientSignatureHtml(p)}</div>`,
}

// Parse the inner of a `{{block:...}}` token → { name, params }. Format: `name | key=value | key=value`.
// Values may contain spaces/commas/periods but not `|` or `}` (the token terminates at the first `}}`).
function parseToken(inner: string): { name: string; params: Record<string, string> } {
  const segs = inner.split('|').map((s) => s.trim())
  const name = (segs.shift() || '').toLowerCase()
  const params: Record<string, string> = {}
  for (const seg of segs) {
    const eq = seg.indexOf('=')
    if (eq > 0) params[seg.slice(0, eq).trim().toLowerCase()] = seg.slice(eq + 1).trim()
  }
  return { name, params }
}

// Non-greedy inner up to the first `}}`, so a stray `}}` in a value just truncates → malformed → escaped.
const BLOCK_RE = /\{\{block:([^}]*?)\}\}/g

// Render hostile markdown to a branded <body> fragment. Splits on trusted-block tokens so block HTML lands at
// the top level (not wrapped in <p>); each non-token segment is rendered by markdown-it (html:false); each
// token is expanded from the allow-list, or — if unknown/malformed — escaped to literal text (harmless).
export function renderMarkdownToBody(markdown: string): string {
  let out = ''
  let last = 0
  let m: RegExpExecArray | null
  BLOCK_RE.lastIndex = 0
  while ((m = BLOCK_RE.exec(markdown)) !== null) {
    const text = markdown.slice(last, m.index)
    if (text) out += md.render(text)
    const { name, params } = parseToken(m[1])
    const builder = TRUSTED_BLOCKS[name]
    out += builder ? builder(params) : escapeHtml(m[0])   // unknown token → harmless literal
    last = m.index + m[0].length
  }
  const tail = markdown.slice(last)
  if (tail) out += md.render(tail)
  return out
}

// Full branded document HTML (what Browser Rendering prints). title is escaped by wrapBrandedHtml.
export function renderDocumentHtml(opts: { title: string; markdown: string }): string {
  return wrapBrandedHtml({ title: opts.title, bodyHtml: renderMarkdownToBody(opts.markdown) })
}
