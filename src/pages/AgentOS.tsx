// Mnemosyne — Agent OS (WORK-ORDER-AGENT-OS-UI.md Part 1). The conductor board for external agent
// clients (first: IntelliService-ISB's dispatch/contract agents). Structure per docs/agenticos.PNG —
// conductor header + one column per registered client — rendered in the house design language, not a
// pixel clone. Every number derives from live rows (the ISB truth standard applies here too).
//
// Data paths:
//   clients   → list_agent_clients() definer fn (0032) — safe columns only, token_hash unreachable
//   events    → activity_log rows with action like 'agent.%' (team RLS read, same as Activity)
//   memories  → memory_entries tagged client:<slug> (team RLS read, same as Memories)

import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'

type AgentClient = {
  client_slug: string
  display_name: string
  is_active: boolean
  created_at: string
  last_used_at: string | null
}

type AgentEvent = {
  id: string
  action: string
  detail: Record<string, unknown> | null
  created_at: string
}

type AgentMemory = {
  name: string
  title: string | null
  kind: string
  tags: string[] | null
  created_at: string
}

// Event-type chip colors (WO Part 1 §2 — the legend row, in the spirit of the reference's
// manual/skill/routine/agent tags).
const EVENT_STYLE: Record<string, { label: string; cls: string }> = {
  dispatch_rejected: { label: 'dispatch rejected', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  dispatch_override: { label: 'dispatch override', cls: 'bg-purple-500/15 text-purple-300 border-purple-500/30' },
  contract_won:      { label: 'contract won',      cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  contract_lost:     { label: 'contract lost',     cls: 'bg-red-500/15 text-red-300 border-red-500/30' },
  contract_dismissed:{ label: 'contract dismissed',cls: 'bg-slate-500/15 text-slate-300 border-slate-500/30' },
  note:              { label: 'note',              cls: 'bg-blue-500/15 text-blue-300 border-blue-500/30' },
}
const FALLBACK_STYLE = { label: 'event', cls: 'bg-slate-500/15 text-slate-300 border-slate-500/30' }

const LIVE_WINDOW_MS = 10 * 60 * 1000 // live = used within 10 minutes (WO Part 1 §2)
const FEED_PAGE = 8

function relTime(iso: string): string {
  // clamp at 0: server-stamped rows can sit a few seconds ahead of the local clock,
  // which rendered "-60s ago" in the walk (2026-07-06)
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function eventType(e: AgentEvent): string {
  // action is 'agent.<event_type>' (0031's invariant)
  return e.action.startsWith('agent.') ? e.action.slice('agent.'.length) : e.action
}

function eventSlug(e: AgentEvent): string | null {
  const s = e.detail?.['client_slug']
  return typeof s === 'string' ? s : null
}

export default function AgentOS() {
  const [clients, setClients] = useState<AgentClient[]>([])
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [memories, setMemories] = useState<AgentMemory[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [feedLimit, setFeedLimit] = useState<Record<string, number>>({})

  useEffect(() => {
    Promise.all([
      supabase.rpc('list_agent_clients'),
      supabase
        .from('activity_log')
        .select('id, action, detail, created_at')
        .like('action', 'agent.%')
        .order('created_at', { ascending: false })
        .limit(500),
      // client-tagged memories: tags is text[]; any 'client:*' tag marks an agent-learned entry.
      // PostgREST array operators need exact values (no prefix match), and the client list arrives
      // in the same Promise.all — so fetch recent entries and filter for the client: namespace
      // in-memory. Bounded at 500 recent rows; revisit if agent memories ever dwarf that.
      supabase
        .from('memory_entries')
        .select('name, title, kind, tags, created_at')
        .order('created_at', { ascending: false })
        .limit(500),
    ]).then(([c, e, m]) => {
      if (c.error) setErr(c.error.message)
      else setClients((c.data ?? []) as AgentClient[])
      if (e.error) setErr((prev) => prev ?? e.error!.message)
      else setEvents((e.data ?? []) as AgentEvent[])
      if (m.error) setErr((prev) => prev ?? m.error!.message)
      else setMemories(((m.data ?? []) as AgentMemory[]).filter((r) => (r.tags ?? []).some((t) => t.startsWith('client:'))))
      setLoading(false)
    })
  }, [])

  const now = Date.now()

  const bySlug = useMemo(() => {
    const map = new Map<string, { events: AgentEvent[]; memories: AgentMemory[] }>()
    for (const c of clients) map.set(c.client_slug, { events: [], memories: [] })
    for (const e of events) {
      const slug = eventSlug(e)
      if (slug && map.has(slug)) map.get(slug)!.events.push(e)
    }
    for (const m of memories) {
      for (const t of m.tags ?? []) {
        if (t.startsWith('client:')) {
          const slug = t.slice('client:'.length)
          if (map.has(slug)) map.get(slug)!.memories.push(m)
        }
      }
    }
    return map
  }, [clients, events, memories])

  const weekAgo = now - 7 * 24 * 60 * 60 * 1000
  // Header aggregates count only events attributable to a REGISTERED client — orphaned rows
  // (e.g. a deleted disposable test client's smoke events) stay in the Activity audit feed but
  // would make this strip disagree with the per-client columns (walk finding, 2026-07-06).
  const registeredEvents = useMemo(
    () => events.filter((e) => { const s = eventSlug(e); return !!s && clients.some((c) => c.client_slug === s) }),
    [events, clients]
  )
  const eventsLast7d = registeredEvents.filter((e) => new Date(e.created_at).getTime() >= weekAgo).length
  const lastEvent = registeredEvents[0] ?? null

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Agent OS</h2>
        <p className="text-xs text-slate-500">
          External agent clients — recall in, distilled outcomes out. Mnemosyne is the conductor.
        </p>
      </div>

      {err && <p className="text-sm text-red-400">{err}</p>}

      {/* Conductor header band — system status strip, all live aggregates (WO Part 1 §1) */}
      <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3">
        <div className="flex items-center gap-3">
          <img src="/mnemosyne-logo.png" alt="" className="w-7 h-7 rounded-md" />
          <div>
            <p className="text-sm font-semibold text-slate-200">Mnemosyne · conductor</p>
            <p className="text-[11px] text-slate-500">agent-context (recall) · agent-outcome (learn)</p>
          </div>
          <div className="ml-auto flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-400">
            <span><span className="text-slate-200 font-medium">{clients.length}</span> client{clients.length === 1 ? '' : 's'}</span>
            <span><span className="text-slate-200 font-medium">{eventsLast7d}</span> events · 7d</span>
            <span><span className="text-slate-200 font-medium">{memories.length}</span> learned memories</span>
            <span>last event: <span className="text-slate-200 font-medium">{lastEvent ? relTime(lastEvent.created_at) : '—'}</span></span>
          </div>
        </div>
      </div>

      {/* Legend (the reference's tag legend, for our event types) */}
      <div className="flex flex-wrap gap-2 text-[10px]">
        {Object.entries(EVENT_STYLE).map(([k, v]) => (
          <span key={k} className={`rounded border px-1.5 py-0.5 ${v.cls}`}>{v.label}</span>
        ))}
      </div>

      {loading && <p className="text-sm text-slate-500">Loading…</p>}

      {!loading && clients.length === 0 && !err && (
        <div className="rounded-lg border border-dashed border-slate-800 px-4 py-10 text-center">
          <p className="text-sm text-slate-400">No agent clients registered.</p>
          <p className="text-xs text-slate-600 mt-1">Provision one with scripts/provision-agent-client.mjs — it appears here immediately.</p>
        </div>
      )}

      {/* One column per client (WO Part 1 §2) — grid holds 1–6 cleanly */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {clients.map((c) => {
          const data = bySlug.get(c.client_slug) ?? { events: [], memories: [] }
          const live = !!c.last_used_at && now - new Date(c.last_used_at).getTime() < LIVE_WINDOW_MS
          const status = !c.is_active ? { label: 'inactive', cls: 'bg-slate-700 text-slate-400' }
            : live ? { label: 'live', cls: 'bg-emerald-500/20 text-emerald-300' }
            : { label: 'idle', cls: 'bg-slate-500/20 text-slate-300' }
          const calls7d = data.events.filter((e) => new Date(e.created_at).getTime() >= weekAgo).length
          const limit = feedLimit[c.client_slug] ?? FEED_PAGE
          return (
            <div key={c.client_slug} className="rounded-lg border border-slate-800 bg-slate-900/40 overflow-hidden">
              {/* Client card */}
              <div className="p-3 border-b border-slate-800">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-slate-200 truncate">{c.display_name}</p>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${status.cls}`}>
                    {status.label === 'live' && <span className="mr-1 inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />}
                    {status.label}
                  </span>
                </div>
                <code className="text-[10px] text-slate-500">{c.client_slug}</code>
                <div className="mt-2 flex gap-4 text-[11px] text-slate-400">
                  <span><span className="text-slate-200">{calls7d}</span> events · 7d</span>
                  <span><span className="text-slate-200">{data.memories.length}</span> memories</span>
                  <span>last: <span className="text-slate-200">{c.last_used_at ? relTime(c.last_used_at) : 'never'}</span></span>
                </div>
              </div>

              {/* Event feed */}
              <div className="p-3 border-b border-slate-800">
                <p className="text-[11px] font-medium text-slate-500 uppercase tracking-wide mb-2">Events</p>
                {data.events.length === 0 && <p className="text-xs text-slate-600">No events yet.</p>}
                <div className="space-y-2">
                  {data.events.slice(0, limit).map((e) => {
                    const t = eventType(e)
                    const style = EVENT_STYLE[t] ?? FALLBACK_STYLE
                    const summary = typeof e.detail?.['summary'] === 'string' ? (e.detail!['summary'] as string) : null
                    return (
                      <div key={e.id} className="text-xs">
                        <div className="flex items-center gap-2">
                          <span className={`rounded border px-1.5 py-0.5 text-[10px] shrink-0 ${style.cls}`}>{style.label}</span>
                          <span className="ml-auto text-[10px] text-slate-600 shrink-0">{relTime(e.created_at)}</span>
                        </div>
                        {summary && <p className="mt-1 text-slate-300 break-words">{summary}</p>}
                      </div>
                    )
                  })}
                </div>
                {data.events.length > limit && (
                  <button
                    onClick={() => setFeedLimit((f) => ({ ...f, [c.client_slug]: limit + FEED_PAGE }))}
                    className="mt-2 text-[11px] text-blue-400 hover:text-blue-300"
                  >
                    Show more ({data.events.length - limit} older)
                  </button>
                )}
              </div>

              {/* Learned memories */}
              <div className="p-3">
                <p className="text-[11px] font-medium text-slate-500 uppercase tracking-wide mb-2">Learned memories</p>
                {data.memories.length === 0 && <p className="text-xs text-slate-600">Nothing learned yet.</p>}
                <div className="space-y-1.5">
                  {data.memories.slice(0, 6).map((m) => (
                    <div key={m.name} className="flex items-center gap-2 text-xs">
                      <span className="truncate text-slate-300">{m.title ?? m.name}</span>
                      <span className="shrink-0 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">{m.kind}</span>
                      <span className="ml-auto shrink-0 text-[10px] text-slate-600">{relTime(m.created_at)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
