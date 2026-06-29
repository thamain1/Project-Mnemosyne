// Mnemosyne — keyless tests for the Phase B render pipeline + governance policy-split (thread 0023).
// Bundles the TS modules with the in-repo esbuild (no extra dep), imports, asserts. Covers Aegis's gate list:
// raw-HTML stripped, javascript:/unsafe schemes blocked, trusted-block expansion, unknown tokens inert,
// param escaping (no attribute injection), wrapper integration, governance policy matrix.
//   node functions/_lib/render-core.test.mjs
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

async function load(rel) {
  const entry = fileURLToPath(new URL(rel, import.meta.url))
  const res = await build({ entryPoints: [entry], bundle: true, format: 'esm', write: false, logLevel: 'error' })
  return import('data:text/javascript;base64,' + Buffer.from(res.outputFiles[0].text).toString('base64'))
}
const { renderMarkdownToBody, renderDocumentHtml, escapeHtml } = await load('./render-core.ts')
const { scanByPolicy, policyFor, scanContract } = await load('./contract-scan.ts')

let pass = 0, fail = 0
const ck = (n, c) => { c ? pass++ : fail++; console.log((c ? '  ok   ' : '  FAIL ') + n) }

// ── hostile markdown: raw HTML must be escaped, never rendered ──
{
  const body = renderMarkdownToBody('Hello <script>alert(1)</script> and <img src=x onerror=alert(1)>')
  ck('raw <script> escaped not rendered', !body.includes('<script>') && body.includes('&lt;script&gt;'))
  ck('raw <img onerror> escaped', !body.includes('<img src=x onerror') && body.includes('&lt;img'))
  const h = renderMarkdownToBody('# Heading\n\nText **bold**')
  ck('legit markdown still renders', h.includes('<h1>') && h.includes('<strong>bold</strong>'))
}

// ── link scheme safety ──
{
  const js = renderMarkdownToBody('[click](javascript:alert(1))')
  ck('javascript: link neutralized', !js.includes('href="javascript:'))
  const data = renderMarkdownToBody('[x](data:text/html,<script>1</script>)')
  ck('data: link blocked', !data.includes('href="data:'))
  const file = renderMarkdownToBody('[x](file:///etc/passwd)')
  ck('file: link blocked', !file.includes('href="file:'))
  const http = renderMarkdownToBody('[ok](https://4wardmotions.com)')
  ck('https link allowed', http.includes('href="https://4wardmotions.com"'))
  const mail = renderMarkdownToBody('[m](mailto:jmorgan@4wardmotions.com)')
  ck('mailto link allowed', mail.includes('href="mailto:jmorgan@4wardmotions.com"'))
}

// ── trusted block tokens ──
{
  const logo = renderMarkdownToBody('{{block:logo}}')
  ck('logo token → img with data URI', logo.includes('<div class="logo"><img src="data:image/png;base64,') && logo.includes('alt="4ward Motion"'))

  const sig = renderMarkdownToBody('{{block:signature | entity=Acme, Inc. | name=Jane Doe | title=CEO}}')
  ck('signature token → grid w/ both parties', sig.includes('class="signature-grid"') && sig.includes('Jesse Morgan') && sig.includes('Co-Founder and CTO'))
  ck('signature injects client params as text', sig.includes('<strong>Acme, Inc.</strong>') && sig.includes('Jane Doe') && sig.includes('CEO'))

  const sigDefault = renderMarkdownToBody('{{block:signature}}')
  ck('signature defaults client entity', sigDefault.includes('[Client]'))
}

// ── unknown / malformed tokens are inert (escaped literal, no HTML) ──
{
  const unk = renderMarkdownToBody('{{block:evil onload=alert(1)}}')
  ck('unknown token produces NO html', !unk.includes('<') || (!unk.includes('onload=alert') ))
  ck('unknown token escaped to literal text', unk.includes('{{block:evil') === false ? unk.includes('&#39;') || unk.includes('block:evil') : true)
  const unk2 = renderMarkdownToBody('{{block:script}}')
  ck('unknown token name not expanded', !unk2.includes('<script'))
}

// ── param values cannot break out into tags/attributes (XSS attempt) ──
{
  const xss = renderMarkdownToBody('{{block:signature | entity=<img src=x onerror=alert(1)> | name="><script>alert(1)</script> | title=ok}}')
  ck('param XSS escaped, no live img', !xss.includes('<img src=x onerror'))
  ck('param XSS escaped, no live script', !xss.includes('<script>alert(1)'))
  ck('param XSS rendered as escaped text', xss.includes('&lt;img src=x onerror') && xss.includes('&lt;script&gt;'))
  ck('signature structure still intact', xss.includes('class="signature-grid"') && xss.includes('Jesse Morgan'))
}

// ── full document wrapper integration ──
{
  const html = renderDocumentHtml({ title: 'GIAV MOU', markdown: '{{block:logo}}\n\n# MOU\n\nBody text.\n\n{{block:signature | entity=GIAV | name=Beth | title=Founder}}' })
  ck('wrapper: doctype + title', html.startsWith('<!doctype html>') && html.includes('<title>GIAV MOU</title>'))
  ck('wrapper: CSS embedded', html.includes('@page { size: Letter'))
  ck('wrapper: logo + heading + signature present', html.includes('class="logo"') && html.includes('<h1>MOU</h1>') && html.includes('class="signature-grid"'))
}

// ── governance policy matrix ──
{
  // secret + marker blocked in EVERY policy
  for (const p of ['contract', 'marketing-client', 'marketing-internal']) {
    ck(`[${p}] secret blocked`, !scanByPolicy('key sk_live_' + 'a'.repeat(20), p).clean)
    ck(`[${p}] leftover marker blocked`, !scanByPolicy('text {{client_entity}} more', p).clean)
  }
  // brand: blocked for contract + marketing-client, allowed for marketing-internal
  ck('[contract] vendor brand blocked', !scanByPolicy('built on Supabase', 'contract').clean)
  ck('[marketing-client] vendor brand blocked', !scanByPolicy('built on Supabase', 'marketing-client').clean)
  ck('[marketing-internal] vendor brand ALLOWED', scanByPolicy('built on Supabase', 'marketing-internal').clean)
  // ai-disclosure: blocked for contract, allowed for marketing
  ck('[contract] ai-disclosure blocked', !scanByPolicy('This contract was AI-generated', 'contract').clean)
  ck('[marketing-client] ai-disclosure allowed', scanByPolicy('This brief was AI-generated', 'marketing-client').clean)
  // clean doc passes everywhere
  ck('[contract] clean doc passes', scanByPolicy('A managed database platform powers it.', 'contract').clean)
  // policyFor mapping
  ck('policyFor contract→contract', policyFor('contract', 'client') === 'contract' && policyFor('contract', 'internal') === 'contract')
  ck('policyFor marketing+internal', policyFor('marketing', 'internal') === 'marketing-internal')
  ck('policyFor marketing+client', policyFor('marketing', 'client') === 'marketing-client')
  // backward-compat scanContract = strict-equivalent
  ck('scanContract still strict (brand)', !scanContract('uses Stripe').clean)
}

// ── template migration: skeletons use trusted tokens, NOT raw HTML ──
{
  const { MOU_SKELETON, SOW_SKELETON, skeletonFor } = await load('./contract-templates.ts')
  ck('MOU uses {{block:logo}}', MOU_SKELETON.includes('{{block:logo}}'))
  ck('MOU uses {{block:signature', MOU_SKELETON.includes('{{block:signature'))
  ck('MOU has NO raw signature-grid HTML', !MOU_SKELETON.includes('<div class="signature-grid"'))
  ck('MOU has NO raw logo <img>', !MOU_SKELETON.includes('<img src="./4ward'))
  ck('SOW uses {{block:logo}}', SOW_SKELETON.includes('{{block:logo}}'))
  // integration: substitute the signature token's nested fills (as generate-contract would), then render
  const filled = skeletonFor('mou')
    .split('{{client_entity}}').join('Acme, Inc.')
    .split('{{client_signatory_name}}').join('Jane Doe')
    .split('{{client_signatory_title}}').join('CEO')
  const body = renderMarkdownToBody(filled)
  ck('rendered MOU: logo div present', body.includes('<div class="logo"><img src="data:image/png'))
  ck('rendered MOU: signature grid present', body.includes('class="signature-grid"') && body.includes('Jesse Morgan'))
  ck('rendered MOU: client party rendered as text', body.includes('<strong>Acme, Inc.</strong>') && body.includes('Jane Doe'))
  ck('rendered MOU: no leftover {{block literal', !body.includes('{{block:'))
  ck('rendered MOU: no escaped raw signature html', !body.includes('&lt;div class=&quot;signature-grid'))
}

// ── marker check: trusted block tokens are NOT leftover markers, but real fills ARE ──
{
  ck('block token alone is governance-clean', scanByPolicy('{{block:signature | entity=Acme}}', 'contract').clean)
  ck('unresolved fill flagged as marker', !scanByPolicy('Party: {{client_entity}} signs here', 'contract').clean)
  ck('marker hit category is marker', scanContract('x {{client_entity}} y').hits.some((h) => h.category === 'marker'))
  ck('block token not a marker hit', !scanContract('{{block:logo}}').hits.some((h) => h.category === 'marker'))
  // a fill missed INSIDE a block token is still caught
  ck('missed fill inside block token still flagged', !scanByPolicy('{{block:signature | entity={{client_entity}}}}', 'contract').clean)
}

console.log(`[render-core-test] pass=${pass} fail=${fail}`)
if (fail) process.exitCode = 1
