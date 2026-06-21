// Mnemosyne — memory-mirror sanitize (TOKEN-GOVERNANCE §19). Pure except the injected vaultFn.
// Turns sealed local content into a mirror-safe projection: each LIVE {{SECRET …}}value{{/SECRET}}
// is vaulted and replaced with a {{VAULTED … → get_secret('id')}} pointer. Local content is never
// mutated here — sanitize() takes a string and returns a new string.

const SEAL_RE = /\{\{SECRET\s+([^}]*?)\}\}([\s\S]*?)\{\{\/SECRET\}\}/g
const CRED_NAME_RE = /(^|\/)(supabase\.md|.*-keys\.md|.*credentials.*|secrets.*\.md|.*\.secrets\.md|.*-creds\.md)$/i
const MARKER = '<!-- CREDENTIALS-FILE -->'
const DENY_MARKER = 'CREDENTIALS-FILE: do-not-mirror'

function parseAttrs(s) {
  const o = {}
  for (const m of s.matchAll(/([a-z_]+)=([^\s}]+)/gi)) o[m[1].toLowerCase()] = m[2]
  return o
}

// A seal is LIVE (gets vaulted) only when service= is a clean token. Placeholders used in docs
// (service=<s>, …) are NOT live, so the standard's own examples never get treated as secrets.
export function findSeals(content) {
  const out = []
  const g = new RegExp(SEAL_RE.source, 'g')
  let m
  while ((m = g.exec(content)) !== null) {
    const attrs = parseAttrs(m[1])
    const live = /^[a-z0-9_-]+$/i.test(attrs.service || '')
    out.push({ full: m[0], attrs, value: m[2], index: m.index, live })
  }
  return out
}

export const isCredentialFile = (sourcePath, content) =>
  content.includes(MARKER) || CRED_NAME_RE.test(sourcePath)
export const isDenylisted = (content) => content.includes(DENY_MARKER)

// Vault every live seal (right-to-left so indices stay valid) and replace with a pointer.
// vaultFn(value, attrs) -> Promise<id>. Returns { sanitized, vaulted[], skipped[] }.
export async function sanitize(content, { vaultFn }) {
  const seals = findSeals(content)
  let out = content
  const vaulted = [], skipped = []
  for (const s of seals.slice().sort((a, b) => b.index - a.index)) {
    if (!s.live) { skipped.push(s); continue }
    const id = await vaultFn(s.value, s.attrs)
    const ptr = `{{VAULTED service=${s.attrs.service}${s.attrs.env ? ` env=${s.attrs.env}` : ''} → get_secret('${id}')}}`
    out = out.slice(0, s.index) + ptr + out.slice(s.index + s.full.length)
    vaulted.push({ service: s.attrs.service, env: s.attrs.env, sensitivity: s.attrs.sensitivity || 'restricted', id })
  }
  return { sanitized: out, vaulted, skipped }
}
