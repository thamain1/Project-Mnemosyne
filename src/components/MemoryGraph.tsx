// Mnemosyne — Unit B++: force-graph layout for Memories. Replaces the flat first-layer with a constellation:
// nodes = memory entries clustered by project/topic, colored by kind; hub nodes per project/topic; edges from
// entry→hub, [[links]] between entries, and code-snippet/applies-to → other projects' hubs (surfaces the
// cross-project code library). Click an entry → the existing detail modal. Rendered via react-force-graph-2d
// (canvas). Read-only; derives everything from data already loaded (no schema, no new fetch).
//
// Thread 0032 UI rider 1: continuous idle motion (never fully sleeps) + directed link particles on
// hover/selection + smooth zoom-to-node on click, PLUS bridge edges (memory→client, memory→deal) as new
// edge/node types with distinct colors — the CRM linkage from P2-BRIDGE (migration 0027) makes the
// cloud structurally richer, which is the actual "alive" effect, not just the animation tuning alone.

import { useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph2D from 'react-force-graph-2d'
import { entryGroupKey, groupLabel } from '../lib/memoryGroups'

type Entry = {
  name: string; title: string | null; kind: string; tags?: string[] | null; links?: string[] | null
  client_id?: string | null; deal_id?: string | null
}

const KIND_NODE: Record<string, string> = {
  project: '#60a5fa',   // blue
  reference: '#34d399', // emerald
  feedback: '#fbbf24',  // amber
  user: '#a78bfa',      // violet
}
const HUB_COLOR = '#64748b'      // slate-500
const CLIENT_COLOR = '#f472b6'   // pink-400 — bridge target: CRM client
const DEAL_COLOR = '#fb923c'     // orange-400 — bridge target: CRM deal
const AGENT_COLOR = '#22d3ee'    // cyan-400 — agent-learned memory (client:* tag, Agent OS era):
                                 // "the brain is learning from the field" gets its own color
const LINK_COLOR: Record<string, string> = {
  hub: 'rgba(100,116,139,0.25)',      // entry → its cluster hub (faint slate)
  link: 'rgba(96,165,250,0.45)',      // [[links]] between entries (blue)
  applies: 'rgba(52,211,153,0.5)',    // code reuse → another project's hub (emerald)
  client: 'rgba(244,114,182,0.55)',   // memory → linked CRM client (pink) — P2-BRIDGE
  deal: 'rgba(251,146,60,0.55)',      // memory → linked CRM deal (orange) — P2-BRIDGE
}

function appliesTo(tags: string[] | null | undefined): string[] {
  return (tags ?? []).filter((t) => t.startsWith('applies-to:')).map((t) => t.slice('applies-to:'.length)).filter(Boolean)
}

export default function MemoryGraph({
  rows, onOpen, clientNames, dealNames,
}: {
  rows: Entry[]
  onOpen: (name: string) => void
  clientNames?: Record<string, string>
  dealNames?: Record<string, string>
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const fgRef = useRef<any>(null)
  const [width, setWidth] = useState(800)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    if (!wrapRef.current) return
    const ro = new ResizeObserver((entries) => { for (const e of entries) setWidth(e.contentRect.width) })
    ro.observe(wrapRef.current)
    return () => ro.disconnect()
  }, [])

  const hasBridge = useMemo(() => rows.some((r) => r.client_id || r.deal_id), [rows])

  const data = useMemo(() => {
    const names = new Set(rows.map((r) => r.name))
    const nodes: any[] = []
    const links: any[] = []
    const hubs = new Set<string>()
    const addHub = (key: string) => { if (!hubs.has(key)) { hubs.add(key); nodes.push({ id: `hub:${key}`, label: groupLabel(key), isHub: true, color: HUB_COLOR }) } }
    const bridgeNodes = new Set<string>()
    const addBridge = (id: string, label: string, color: string) => { if (!bridgeNodes.has(id)) { bridgeNodes.add(id); nodes.push({ id, label, isHub: true, color }) } }

    for (const r of rows) {
      const key = entryGroupKey(r)
      addHub(key)
      const snippet = (r.tags ?? []).includes('code-snippet')
      const agentSourced = (r.tags ?? []).some((t) => t.startsWith('client:'))
      nodes.push({ id: r.name, label: r.title || r.name, kind: r.kind, snippet, color: agentSourced ? AGENT_COLOR : (KIND_NODE[r.kind] ?? '#94a3b8') })
      links.push({ source: r.name, target: `hub:${key}`, kind: 'hub' })
      if (r.client_id) {
        const cid = `client:${r.client_id}`
        addBridge(cid, clientNames?.[r.client_id] ?? 'Client', CLIENT_COLOR)
        links.push({ source: r.name, target: cid, kind: 'client' })
      }
      if (r.deal_id) {
        const did = `deal:${r.deal_id}`
        addBridge(did, dealNames?.[r.deal_id] ?? 'Deal', DEAL_COLOR)
        links.push({ source: r.name, target: did, kind: 'deal' })
      }
    }
    // [[links]] between entries (only when the target entry is in view)
    const seen = new Set<string>()
    for (const r of rows) {
      for (const l of r.links ?? []) {
        if (names.has(l) && l !== r.name) {
          const k = r.name < l ? `${r.name}|${l}` : `${l}|${r.name}`
          if (!seen.has(k)) { seen.add(k); links.push({ source: r.name, target: l, kind: 'link' }) }
        }
      }
    }
    // applies-to: cross-project reuse → that project's hub (create the hub if needed)
    for (const r of rows) {
      for (const proj of appliesTo(r.tags)) {
        addHub(proj)
        links.push({ source: r.name, target: `hub:${proj}`, kind: 'applies' })
      }
    }
    return { nodes, links }
  }, [rows, clientNames, dealNames])

  useEffect(() => {
    // Gentle center gravity (2026-07-03, current.png finding): nodes with no links have nothing
    // tethering them against charge repulsion, so they fly to the frame edges — inflating the
    // bounding box until zoomToFit renders the connected core as a tiny knot in an empty field.
    // A weak pull toward the origin (classic forceX/forceY-style gravity, hand-rolled so we don't
    // import the transitive d3-force dep) keeps singletons hovering as a loose cloud around the
    // core — which is also just closer to the node-cloud concept art.
    const fg = fgRef.current
    if (fg) {
      const gravity = (strength: number) => {
        let ns: any[] = []
        const f = (alpha: number) => { for (const n of ns) { n.vx += (0 - n.x) * strength * alpha; n.vy += (0 - n.y) * strength * alpha } }
        f.initialize = (nodes: any[]) => { ns = nodes }
        return f
      }
      try { fg.d3Force('gravity', gravity(0.06)); fg.d3ReheatSimulation?.() } catch { /* noop */ }
    }
    // fit once early (rough), then again after the simulation has settled — the early fit alone
    // framed a still-expanding layout and left most nodes off-camera once the physics spread them
    // out (Jesse-reported header.png finding, 2026-07-03).
    const t1 = setTimeout(() => { try { fgRef.current?.zoomToFit(400, 50) } catch { /* noop */ } }, 600)
    const t2 = setTimeout(() => { try { fgRef.current?.zoomToFit(600, 60) } catch { /* noop */ } }, 5200)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [data])

  function focusNode(n: any) {
    setSelectedId(n.id)
    try { fgRef.current?.centerAt(n.x, n.y, 600); fgRef.current?.zoom(n.isHub ? 3 : 4, 600) } catch { /* noop */ }
  }

  return (
    <div ref={wrapRef} className="rounded-lg border border-slate-800 bg-slate-950 overflow-hidden">
      <ForceGraph2D
        ref={fgRef}
        graphData={data}
        width={width}
        height={560}
        backgroundColor="#020617"
        // idle motion, BOUNDED (2026-07-03 fix): the original cooldownTime={Infinity} never let the
        // physics settle, so nodes kept spreading past the one-time zoomToFit and drifted off-camera.
        // Low alpha decay still gives ~10-15s of graceful drift, then the engine sleeps; the "alive"
        // cue persists via link particles (rendered every frame, independent of the physics engine)
        // and the settled layout stays framed.
        d3AlphaDecay={0.012}
        d3VelocityDecay={0.28}
        cooldownTime={15000}
        onEngineStop={() => { try { fgRef.current?.zoomToFit(600, 60) } catch { /* noop */ } }}
        nodeLabel={(n: any) => (n.isHub ? `${n.label} (group)` : `${n.label} · ${n.kind}`)}
        linkColor={(l: any) => LINK_COLOR[l.kind] ?? LINK_COLOR.hub}
        linkWidth={(l: any) => (l.kind === 'link' || l.kind === 'applies' || l.kind === 'client' || l.kind === 'deal' ? 1 : 0.5)}
        // directed link particles flow on hover/selection only — a static graph would be noisy with
        // particles everywhere; this makes the "alive" cue purposeful (draws the eye to what you're
        // looking at) rather than decorative.
        linkDirectionalParticles={(l: any) => {
          const id = hoverId ?? selectedId
          if (!id) return 0
          return l.source?.id === id || l.target?.id === id || l.source === id || l.target === id ? 3 : 0
        }}
        linkDirectionalParticleWidth={1.6}
        linkDirectionalParticleSpeed={0.006}
        onNodeHover={(n: any) => setHoverId(n ? n.id : null)}
        onNodeClick={(n: any) => { focusNode(n); if (!n.isHub) onOpen(n.id) }}
        nodeCanvasObject={(n: any, ctx: CanvasRenderingContext2D, scale: number) => {
          // "Alive at rest" breathing (WORK-ORDER-AGENT-OS-UI.md Part 2): a RENDER-layer micro-
          // oscillation — the physics stays settled (the 0032 bounded-cooldown fix is untouched;
          // n.x/n.y never move), only the drawn radius and a soft glow pulse on a slow per-node
          // phase. Visual-only, so click targets (nodePointerAreaPaint) stay exactly where the
          // node is, and zoomToFit's frame never re-inflates.
          const phase = (n.__phase ??= Math.random() * Math.PI * 2)
          const breathe = 1 + 0.10 * Math.sin(Date.now() / 1400 + phase)
          const r = (n.isHub ? 5.5 : 3.5) * breathe
          const glow = 0.18 + 0.10 * Math.sin(Date.now() / 1400 + phase)
          ctx.beginPath(); ctx.arc(n.x, n.y, r + 2.2, 0, 2 * Math.PI)
          ctx.fillStyle = hexToRgba(n.color, glow); ctx.fill()
          ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 2 * Math.PI)
          ctx.fillStyle = n.color; ctx.fill()
          if (n.snippet) { ctx.strokeStyle = '#6ee7b7'; ctx.lineWidth = 1.2; ctx.stroke() }
          if (n.id === selectedId) { ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 1.5; ctx.stroke() }
          if (n.isHub || scale > 2.4) {
            ctx.font = `${n.isHub ? 7 : 5}px Inter, system-ui, sans-serif`
            ctx.fillStyle = n.isHub ? '#e2e8f0' : '#94a3b8'
            ctx.textAlign = 'center'; ctx.textBaseline = 'top'
            ctx.fillText(String(n.label).slice(0, 30), n.x, n.y + r + 1)
          }
        }}
        nodePointerAreaPaint={(n: any, color: string, ctx: CanvasRenderingContext2D) => {
          ctx.fillStyle = color; ctx.beginPath(); ctx.arc(n.x, n.y, (n.isHub ? 5.5 : 3.5) + 2, 0, 2 * Math.PI); ctx.fill()
        }}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-[10px] text-slate-500 border-t border-slate-800">
        <span className="flex items-center gap-1"><Dot c="#64748b" /> project/topic hub</span>
        <span className="flex items-center gap-1"><Dot c="#60a5fa" /> project</span>
        <span className="flex items-center gap-1"><Dot c="#34d399" /> reference</span>
        <span className="flex items-center gap-1"><Dot c="#fbbf24" /> feedback</span>
        <span className="flex items-center gap-1"><Dot c="#a78bfa" /> user</span>
        <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-full border border-emerald-300" /> code snippet</span>
        <span className="flex items-center gap-1"><Dot c={AGENT_COLOR} /> agent-learned</span>
        {hasBridge && <span className="flex items-center gap-1"><Dot c={CLIENT_COLOR} /> CRM client</span>}
        {hasBridge && <span className="flex items-center gap-1"><Dot c={DEAL_COLOR} /> CRM deal</span>}
        <span className="ml-auto">click a node to open + zoom · hover to trace links · scroll to zoom · drag to pan</span>
      </div>
    </div>
  )
}

function Dot({ c }: { c: string }) {
  return <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: c }} />
}

// Breathing-glow helper: node colors are hex (#rrggbb) — soft halo needs them at low alpha.
function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return `rgba(148,163,184,${alpha})`
  const v = parseInt(m[1], 16)
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${alpha})`
}
