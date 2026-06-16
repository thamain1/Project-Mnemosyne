// Mnemosyne — Sales Factory C4.1: contract DRAFT generation (CF Pages Function).
//
// Generates a governed MOU/SOW draft. The governance boundary lives in functions/_lib/contract-templates.ts:
//   - CONSTANTS (legal boilerplate, logo, 4ward party + signature) are pasted verbatim — model never touches.
//   - {{fill}} slots are deterministic field substitution (parties, refs, dates, fees, milestone table).
//   - {{draft::key}} slots are the ONLY model-written content — deal-specific narrative drafted from the
//     caller's brief and grounded on the closest SAME-TYPE exemplar already in the brain (search_docs).
// Returns { markdown, title, doc_type, sources, warnings } — NO persistence (C4.2 adds that behind its own
// migration/RPC review). The .md drops into the deal's contracts/ folder and renders to a branded PDF via the
// existing _build_pdfs.py (the established, repeatable render pipeline). Drafts are an assisted-drafting aid
// for review — never auto-final, never auto-sent. Fails CLOSED (JWT -> active member before any work).
//
// Server-side env (context.env, NOT VITE_): SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY (already set).
// Deferred (pre-broad-rollout): per-user rate limiting; persistence + audit of generated drafts (C4.2).

import { createClient } from '@supabase/supabase-js'
import { DOC_TYPES, SLOTS, TITLES, skeletonFor, type DocType, type SlotSpec } from '../_lib/contract-templates'

const EMBED_MODEL = 'gemini-embedding-001'
const GEN_MODEL = 'gemini-2.5-flash'
const DIMS = 768
const MAX_BRIEF_LEN = 5000        // per-slot brief / fill value cap (specs also cap per slot)
const MAX_TOTAL_INPUT = 20000     // total caller input cap across all fields
const EXEMPLAR_DOCS = 2
const MAX_EXEMPLAR_CHARS = 9000   // grounding excerpt cap (style only)

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

async function embedQuery(text: string, apiKey: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent`
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 15000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ content: { parts: [{ text }] }, taskType: 'RETRIEVAL_QUERY', outputDimensionality: DIMS }),
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`embed ${res.status}`)
    const v = (await res.json())?.embedding?.values
    if (!Array.isArray(v) || v.length !== DIMS || !v.every((x: unknown) => Number.isFinite(x))) throw new Error('bad embedding')
    const norm = Math.sqrt(v.reduce((s: number, x: number) => s + x * x, 0))
    if (!(norm > 0)) throw new Error('zero norm')
    return '[' + v.map((x: number) => x / norm).join(',') + ']'
  } finally { clearTimeout(timer) }
}

async function generate(prompt: string, apiKey: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEN_MODEL}:generateContent`
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 45000)
  try {
    // No responseSchema (avoids the gemini-2.5-flash structured-output truncation gotcha); delimited plain text.
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 8192 },
      }),
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`generate ${res.status}`)
    const data = await res.json()
    const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text ?? '').join('').trim()
    if (!text) throw new Error('empty generation')
    return text
  } finally { clearTimeout(timer) }
}

const GOVERNANCE = [
  'You are drafting designated sections of a contract for 4ward Motion Solutions, Inc. ("4ward").',
  'Output ONLY the requested sections, each wrapped EXACTLY in its delimiters: a line "<<<SLOT key>>>", the',
  'section content as markdown, then a line "<<<ENDSLOT>>>". Emit one block per requested slot, nothing else.',
  'House rules (mandatory):',
  '- Refer to the service provider as "4ward". The client is "Client".',
  '- Do NOT name specific third-party vendors or product brands. Use functional categories only',
  '  (e.g. "a managed database platform", "a transactional email provider", "a payment processor").',
  '- Do NOT include any AI-disclosure, AI-usage, or "built with AI" language anywhere.',
  '- Do NOT invent fees, dollar amounts, dates, party names, deadlines, or counts. Use ONLY what the brief',
  '  provides. Where a specific is needed but not given, write a [bracketed placeholder] for later completion.',
  '- Professional contract prose in a clear, plain-English style. Follow each section\'s requested format',
  '  (bulleted list / numbered list / lettered list / table) exactly.',
  '- Stay within the scope of the brief; do not add unrelated obligations, warranties, or legal terms',
  '  (those live in the fixed contract sections you are NOT writing).',
].join('\n')

export const onRequestPost = async (context: any): Promise<Response> => {
  const env = context.env || {}
  const SUPABASE_URL = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const ANON = env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY
  const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY
  const GEMINI = env.GEMINI_API_KEY
  if (!SUPABASE_URL || !ANON || !SERVICE || !GEMINI) return json({ error: 'server misconfigured' }, 500)

  // ---- strict args ----
  let payload: any
  try { payload = await context.request.json() } catch { return json({ error: 'invalid JSON body' }, 400) }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return json({ error: 'body must be an object' }, 400)
  for (const key of Object.keys(payload)) if (key !== 'doc_type' && key !== 'fields' && key !== 'ground') return json({ error: `unexpected field "${key}"` }, 400)
  const docType = payload.doc_type as DocType
  if (!DOC_TYPES.includes(docType)) return json({ error: `"doc_type" must be one of ${DOC_TYPES.join(', ')}` }, 400)
  if (typeof payload.fields !== 'object' || payload.fields === null || Array.isArray(payload.fields)) return json({ error: '"fields" must be an object' }, 400)
  const ground = payload.ground === undefined ? true : payload.ground
  if (typeof ground !== 'boolean') return json({ error: '"ground" must be a boolean' }, 400)

  const specs = SLOTS[docType]
  const specByKey = new Map<string, SlotSpec>(specs.map((s) => [s.key, s]))
  const fields = payload.fields as Record<string, unknown>

  // reject unknown field keys (additionalProperties:false over the slot set)
  for (const k of Object.keys(fields)) {
    if (!specByKey.has(k)) return json({ error: `unexpected field "${k}" for ${docType}` }, 400)
    if (typeof fields[k] !== 'string') return json({ error: `field "${k}" must be a string` }, 400)
  }
  // size bounds
  let total = 0
  for (const [k, v] of Object.entries(fields)) {
    const s = specByKey.get(k)!
    const val = (v as string)
    if (val.length > Math.min(s.max, MAX_BRIEF_LEN)) return json({ error: `field "${k}" exceeds ${Math.min(s.max, MAX_BRIEF_LEN)} chars` }, 400)
    total += val.length
  }
  if (total > MAX_TOTAL_INPUT) return json({ error: `total input exceeds ${MAX_TOTAL_INPUT} chars` }, 400)
  // required slots present + non-empty
  for (const s of specs) {
    const provided = typeof fields[s.key] === 'string' ? (fields[s.key] as string).trim() : ''
    if (s.required && !provided) return json({ error: `missing required field "${s.key}" (${s.label})` }, 400)
  }

  // ---- authz: valid JWT -> active member (fail closed) ----
  const authz = context.request.headers.get('authorization') || ''
  const token = authz.toLowerCase().startsWith('bearer ') ? authz.slice(7).trim() : ''
  if (!token) return json({ error: 'unauthorized' }, 401)
  const anon = createClient(SUPABASE_URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: userData, error: userErr } = await anon.auth.getUser(token)
  const uid = userData?.user?.id
  if (userErr || !uid) return json({ error: 'unauthorized' }, 401)
  const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: member, error: mErr } = await admin
    .from('team_members').select('id').eq('id', uid).eq('active', true).maybeSingle()
  if (mErr || !member) return json({ error: 'forbidden' }, 403)

  // ---- optional grounding: closest SAME-TYPE exemplar (style only) ----
  const sources: any[] = []
  let exemplar = ''
  if (ground) {
    try {
      const projectName = typeof fields.project_name === 'string' ? fields.project_name : ''
      const vec = await embedQuery(`${docType} ${projectName} ${typeof fields.overview === 'string' ? fields.overview : ''}`.slice(0, 1500), GEMINI)
      const { data: hits } = await admin.rpc('search_docs', { query_embedding: vec, match_count: 6 })
      const sameType = (hits ?? []).filter((h: any) => h.doc_type === docType).slice(0, EXEMPLAR_DOCS)
      if (sameType.length) {
        const { data: docs } = await admin.from('documents').select('id, title, extracted_text').in('id', sameType.map((h: any) => h.id))
        const byId = new Map((docs ?? []).map((d: any) => [d.id, d]))
        let used = 0
        for (const h of sameType) {
          const d: any = byId.get(h.id); if (!d) continue
          const block = `--- ${d.title} ---\n${(d.extracted_text ?? '').slice(0, 6000)}\n`
          if (used + block.length > MAX_EXEMPLAR_CHARS) break
          exemplar += block; used += block.length
          sources.push({ id: h.id, title: h.title, doc_type: h.doc_type, similarity: h.similarity })
        }
      }
    } catch { /* grounding is best-effort; generation proceeds without it */ }
  }

  // ---- build the draft-slot generation request ----
  const draftSpecs = specs.filter((s) => s.kind === 'draft')
  const toDraft = draftSpecs.filter((s) => typeof fields[s.key] === 'string' && (fields[s.key] as string).trim())
  const warnings: string[] = []
  const drafted = new Map<string, string>()

  if (toDraft.length) {
    const parts: string[] = [GOVERNANCE]
    if (exemplar) parts.push(`\n=== STYLE EXEMPLAR (a prior ${docType.toUpperCase()} — match its tone/structure ONLY; do NOT copy its specific names, figures, or scope) ===\n${exemplar}`)
    parts.push(`\n=== SECTIONS TO DRAFT (${docType.toUpperCase()}) ===`)
    for (const s of toDraft) {
      parts.push(`\n<<<SLOT ${s.key}>>> — ${s.label}\nRequired format: ${s.help}\nBrief from the user: ${(fields[s.key] as string).trim()}`)
    }
    parts.push('\nNow output each section, wrapped in its <<<SLOT key>>> / <<<ENDSLOT>>> delimiters, in the order listed above. Output nothing outside the delimiters.')
    let genText: string
    try { genText = await generate(parts.join('\n'), GEMINI) } catch { return json({ error: 'generation failed' }, 502) }
    const re = /<<<SLOT\s+([a-z_]+)>>>([\s\S]*?)<<<ENDSLOT>>>/g
    let m: RegExpExecArray | null
    while ((m = re.exec(genText)) !== null) {
      if (specByKey.get(m[1])?.kind === 'draft') drafted.set(m[1], m[2].trim())
    }
  }

  // ---- assemble: constants verbatim, fills substituted, drafts inserted ----
  let md = skeletonFor(docType)
  // draft slots first (so a draft's own text can't accidentally collide with fill markers)
  for (const s of draftSpecs) {
    const marker = `{{draft::${s.key}}}`
    let val = drafted.get(s.key)
    if (val === undefined) {
      const brief = typeof fields[s.key] === 'string' ? (fields[s.key] as string).trim() : ''
      if (brief) { val = `[TO DRAFT — ${brief}]`; warnings.push(`Section "${s.key}" was not returned by the model; brief inserted as a placeholder.`) }
      else if (s.default !== undefined) { val = s.default }
      else { val = `[${s.label} — to be completed]`; if (s.required) warnings.push(`Required section "${s.key}" is empty.`) }
    }
    md = md.split(marker).join(val)
  }
  // fill slots
  for (const s of specs) {
    if (s.kind !== 'fill') continue
    const marker = `{{${s.key}}}`
    const raw = typeof fields[s.key] === 'string' ? (fields[s.key] as string).trim() : ''
    const val = raw || s.default || `[${s.label}]`
    md = md.split(marker).join(val)
  }

  // safety: no unfilled markers should remain
  const leftover = md.match(/\{\{[^}]+\}\}/g)
  if (leftover && leftover.length) warnings.push(`Unfilled markers remained: ${[...new Set(leftover)].join(', ')}`)

  return json({ doc_type: docType, title: TITLES[docType], markdown: md, sources, warnings })
}
// (Only onRequestPost is exported, so CF Pages auto-returns 405 for any non-POST method.)
