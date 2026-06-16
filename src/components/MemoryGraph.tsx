// Mnemosyne — Unit B++: force-graph layout for Memories. Replaces the flat first-layer with a constellation:
// nodes = memory entries clustered by project/topic, colored by kind; hub nodes per project/topic; edges from
// entry→hub, [[links]] between entries, and code-snippet/applies-to → other projects' hubs (surfaces the
// cross-project code library). Click an entry → the existing detail modal. Rendered via react-force-graph-2d
// (canvas). Read-only; derives everything from data already loaded (no schema, no new fetch).

import { useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph2D from 'react-force-graph-2d'
import { entryGroupKey, groupLabel } from '../lib/memoryGroups'

type Entry = { name: string; title: string | null; kind: string; tags?: string[] | null; links?: string[] | null }

const KIND_NODE: Record<string, string> = {
  project: '#60a5fa',   // blue
  reference: '#34d399', // emerald
  feedback: '#fbbf24',  // amber
  user: '#a78bfa',      // violet
}
const HUB_COLOR = '#64748b'      // slate-500
const LINK_COLOR: Record<string, string> = {
  hub: 'rgba(100,116,139,0.25)',      // entry → its cluster hub (faint slate)
  link: 'rgba(96,165,250,0.45)',      // [[links]] between entries (blue)
  applies: 'rgba(52,211,153,0.5)',    // code reuse → another project's hub (emerald)
}

function appliesTo(tags: string[] | null | undefined): string[] {
  return (tags ?? []).filter((t) => t.startsWith('applies-to:')).map((t) => t.slice('applies-to:'.length)).filter(Boolean)
}

export default function MemoryGraph({ rows, onOpen }: { rows: Entry[]; onOpen: (name: string) => void }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const fgRef = useRef<any>(null)
  const [width, setWidth] = useState(800)

  useEffect(() => {
    if (!wrapRef.current) return
    const ro = new ResizeObserver((entries) => { for (const e of entries) setWidth(e.contentRect.width) })
    ro.observe(wrapRef.current)
    return () => ro.disconnect()
  }, [])

  const data = useMemo(() => {
    const names = new Set(rows.map((r) => r.name))
    const nodes: any[] = []
    const links: any[] = []
    const hubs = new Set<string>()
    const addHub = (key: string) => { if (!hubs.has(key)) { hubs.add(key); nodes.push({ id: `hub:${key}`, label: groupLabel(key), isHub: true, color: HUB_COLOR }) } }

    for (const r of rows) {
      const key = entryGroupKey(r)
      addHub(key)
      const snippet = (r.tags ?? []).includes('code-snippet')
      nodes.push({ id: r.name, label: r.title || r.name, kind: r.kind, snippet, color: KIND_NODE[r.kind] ?? '#94a3b8' })
      links.push({ source: r.name, target: `hub:${key}`, kind: 'hub' })
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
  }, [rows])

  useEffect(() => {
    const t = setTimeout(() => { try { fgRef.current?.zoomToFit(400, 50) } catch { /* noop */ } }, 600)
    return () => clearTimeout(t)
  }, [data])

  return (
    <div ref={wrapRef} className="rounded-lg border border-slate-800 bg-slate-950 overflow-hidden">
      <ForceGraph2D
        ref={fgRef}
        graphData={data}
        width={width}
        height={560}
        backgroundColor="#020617"
        cooldownTicks={120}
        nodeLabel={(n: any) => (n.isHub ? `${n.label} (group)` : `${n.label} · ${n.kind}`)}
        linkColor={(l: any) => LINK_COLOR[l.kind] ?? LINK_COLOR.hub}
        linkWidth={(l: any) => (l.kind === 'link' || l.kind === 'applies' ? 1 : 0.5)}
        onNodeClick={(n: any) => { if (!n.isHub) onOpen(n.id); else { fgRef.current?.centerAt(n.x, n.y, 500); fgRef.current?.zoom(3, 500) } }}
        nodeCanvasObject={(n: any, ctx: CanvasRenderingContext2D, scale: number) => {
          const r = n.isHub ? 5.5 : 3.5
          ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 2 * Math.PI)
          ctx.fillStyle = n.color; ctx.fill()
          if (n.snippet) { ctx.strokeStyle = '#6ee7b7'; ctx.lineWidth = 1.2; ctx.stroke() }
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
        <span className="ml-auto">click a node to open · scroll to zoom · drag to pan</span>
      </div>
    </div>
  )
}

function Dot({ c }: { c: string }) {
  return <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: c }} />
}
