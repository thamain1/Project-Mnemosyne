import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'

type Row = {
  id: string
  actor_id: string | null
  action: string
  entity_type: string | null
  entity_id: string | null
  detail: Record<string, unknown> | null
  created_at: string
}

// P5-TELEMETRY (thread 0025): last-7-days usage rollup, read from usage_events (migration 0024).
// bytes_in/bytes_out are an honest PROXY metric (chars ≈ tokens/4) — never presented as exact tokens.
type UsageRow = {
  actor_id: string | null
  tool: string
  input_tokens: number | null
  output_tokens: number | null
  bytes_in: number | null
  bytes_out: number | null
}
type Member = { id: string; full_name: string }

// Action presets for the composer (free-form still allowed via the RPC's namespaced-token rule).
const ACTIONS = [
  { value: 'work.note', label: 'Work note' },
  { value: 'project.update', label: 'Project update' },
  { value: 'deal.update', label: 'Deal update' },
  { value: 'ops.note', label: 'Ops note' },
]

export default function Activity() {
  const { session, member, user } = useAuth()
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  // usage rollup (P5-TELEMETRY)
  const [usage, setUsage] = useState<UsageRow[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [usageErr, setUsageErr] = useState<string | null>(null)

  // composer state
  const [note, setNote] = useState('')
  const [action, setAction] = useState('work.note')
  const [posting, setPosting] = useState(false)
  const [postErr, setPostErr] = useState<string | null>(null)

  const load = useCallback(() => {
    return supabase
      .from('activity_log')
      .select('id, actor_id, action, entity_type, entity_id, detail, created_at')
      .order('created_at', { ascending: false })
      .limit(200)
      .then(({ data, error }) => {
        if (error) setErr(error.message)
        else setRows((data ?? []) as Row[])
        setLoading(false)
      })
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    Promise.all([
      supabase.from('usage_events').select('actor_id, tool, input_tokens, output_tokens, bytes_in, bytes_out').gte('created_at', since).limit(5000),
      supabase.from('team_members').select('id, full_name'),
    ]).then(([u, m]) => {
      if (u.error) setUsageErr(u.error.message)
      else setUsage((u.data ?? []) as UsageRow[])
      if (!m.error) setMembers((m.data ?? []) as Member[])
    })
  }, [])

  const usageByTool = useMemo(() => {
    const map = new Map<string, { calls: number; inputTokens: number; outputTokens: number; bytes: number }>()
    for (const r of usage) {
      const e = map.get(r.tool) ?? { calls: 0, inputTokens: 0, outputTokens: 0, bytes: 0 }
      e.calls += 1
      e.inputTokens += r.input_tokens ?? 0
      e.outputTokens += r.output_tokens ?? 0
      e.bytes += (r.bytes_in ?? 0) + (r.bytes_out ?? 0)
      map.set(r.tool, e)
    }
    return [...map.entries()].sort((a, b) => b[1].calls - a[1].calls)
  }, [usage])

  const usageByActor = useMemo(() => {
    const nameOf = new Map(members.map((m) => [m.id, m.full_name]))
    const map = new Map<string, number>()
    for (const r of usage) {
      const key = r.actor_id ? (nameOf.get(r.actor_id) ?? r.actor_id.slice(0, 8)) : '(unattributed)'
      map.set(key, (map.get(key) ?? 0) + 1)
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
  }, [usage, members])

  async function post(e: FormEvent) {
    e.preventDefault()
    const n = note.trim()
    if (!n) return
    setPosting(true); setPostErr(null)
    try {
      const res = await fetch('/api/log-update', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${session?.access_token ?? ''}` },
        body: JSON.stringify({ note: n, action }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || `post failed (${res.status})`)
      setNote('')
      await load()
    } catch (e: any) { setPostErr(e?.message ?? 'post failed') }
    finally { setPosting(false) }
  }

  const me = member?.full_name ?? user?.email ?? 'you'

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Activity</h2>
        <p className="text-xs text-slate-500">{loading ? 'Loading…' : `${rows.length} recent events`} · who-did-what audit feed</p>
      </div>

      {/* Composer — post a note to the feed (first dashboard write path) */}
      <form onSubmit={post} className="rounded-lg border border-slate-800 bg-slate-900/40 p-3 space-y-2">
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={1000}
          rows={2}
          placeholder={`What are you working on, ${me}? Post an update to the team feed…`}
          className="w-full resize-y rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <div className="flex items-center gap-2">
          <select value={action} onChange={(e) => setAction(e.target.value)}
            className="rounded-lg bg-slate-900 border border-slate-700 px-2 py-1.5 text-sm text-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500">
            {ACTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
          </select>
          <span className="text-xs text-slate-600">{note.length}/1000 · no secrets — posts are team-visible</span>
          <button type="submit" disabled={posting || !note.trim()}
            className="ml-auto rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 px-4 py-1.5 text-sm font-medium transition">
            {posting ? 'Posting…' : 'Post'}
          </button>
        </div>
        {postErr && <p className="text-sm text-red-400">{postErr}</p>}
      </form>

      {/* Usage card (P5-TELEMETRY, thread 0025) — last 7 days, per-tool + per-actor rollup */}
      <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3 space-y-2">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-semibold text-slate-200">Usage — last 7 days</h3>
          <span className="text-[11px] text-slate-600">bytes = payload proxy, not exact tokens</span>
        </div>
        {usageErr && <p className="text-sm text-red-400">{usageErr}</p>}
        {!usageErr && usage.length === 0 && <p className="text-xs text-slate-500">No usage recorded yet.</p>}
        {usage.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2">
            <table className="w-full text-xs">
              <thead className="text-slate-500"><tr><th className="text-left font-normal pb-1">Tool</th><th className="text-right font-normal pb-1">Calls</th><th className="text-right font-normal pb-1">Tokens</th><th className="text-right font-normal pb-1">Bytes</th></tr></thead>
              <tbody className="text-slate-300">
                {usageByTool.map(([tool, s]) => (
                  <tr key={tool} className="border-t border-slate-800">
                    <td className="py-1 pr-2 truncate">{tool}</td>
                    <td className="py-1 text-right">{s.calls}</td>
                    <td className="py-1 text-right">{s.inputTokens + s.outputTokens || '—'}</td>
                    <td className="py-1 text-right">{s.bytes.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <table className="w-full text-xs">
              <thead className="text-slate-500"><tr><th className="text-left font-normal pb-1">Top actors</th><th className="text-right font-normal pb-1">Calls</th></tr></thead>
              <tbody className="text-slate-300">
                {usageByActor.map(([who, calls]) => (
                  <tr key={who} className="border-t border-slate-800">
                    <td className="py-1 pr-2 truncate">{who}</td>
                    <td className="py-1 text-right">{calls}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {err && <p className="text-sm text-red-400">{err}</p>}

      {!loading && rows.length === 0 && !err && (
        <div className="rounded-lg border border-dashed border-slate-800 px-4 py-10 text-center">
          <p className="text-sm text-slate-400">No activity yet.</p>
          <p className="text-xs text-slate-600 mt-1">Memory writes, secret reads, and updates will appear here.</p>
        </div>
      )}

      {rows.length > 0 && (
        <div className="divide-y divide-slate-800 rounded-lg border border-slate-800 overflow-hidden">
          {rows.map((r) => {
            const noteText = r.detail && typeof (r.detail as any).note === 'string' ? (r.detail as any).note as string : null
            return (
              <div key={r.id} className="px-4 py-3 flex items-start gap-3">
                <code className="mt-0.5 shrink-0 rounded bg-slate-800 px-1.5 py-0.5 text-[11px] text-blue-300">{r.action}</code>
                <div className="min-w-0 text-sm">
                  {noteText ? (
                    <span className="block text-slate-200 whitespace-pre-wrap break-words">{noteText}</span>
                  ) : (
                    <span className="text-slate-300">
                      {r.entity_type ?? '—'}
                      {r.entity_id ? <span className="text-slate-500"> · {r.entity_id.slice(0, 8)}</span> : null}
                    </span>
                  )}
                  {!noteText && r.detail && Object.keys(r.detail).length > 0 && (
                    <span className="block text-xs text-slate-500 truncate">{JSON.stringify(r.detail)}</span>
                  )}
                </div>
                <span className="ml-auto shrink-0 text-xs text-slate-600">{new Date(r.created_at).toLocaleString()}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
