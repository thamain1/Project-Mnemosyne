import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

type Row = {
  id: string
  actor_id: string | null
  action: string
  entity_type: string | null
  entity_id: string | null
  detail: Record<string, unknown> | null
  created_at: string
}

export default function Activity() {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    supabase
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

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Activity</h2>
        <p className="text-xs text-slate-500">{loading ? 'Loading…' : `${rows.length} recent events`} · who-did-what audit feed</p>
      </div>

      {err && <p className="text-sm text-red-400">{err}</p>}

      {!loading && rows.length === 0 && (
        <div className="rounded-lg border border-dashed border-slate-800 px-4 py-10 text-center">
          <p className="text-sm text-slate-400">No activity yet.</p>
          <p className="text-xs text-slate-600 mt-1">Memory writes, secret reads, and updates will appear here.</p>
        </div>
      )}

      {rows.length > 0 && (
        <div className="divide-y divide-slate-800 rounded-lg border border-slate-800 overflow-hidden">
          {rows.map((r) => (
            <div key={r.id} className="px-4 py-3 flex items-start gap-3">
              <code className="mt-0.5 shrink-0 rounded bg-slate-800 px-1.5 py-0.5 text-[11px] text-blue-300">{r.action}</code>
              <div className="min-w-0 text-sm">
                <span className="text-slate-300">
                  {r.entity_type ?? '—'}
                  {r.entity_id ? <span className="text-slate-500"> · {r.entity_id.slice(0, 8)}</span> : null}
                </span>
                {r.detail && Object.keys(r.detail).length > 0 && (
                  <span className="block text-xs text-slate-500 truncate">{JSON.stringify(r.detail)}</span>
                )}
              </div>
              <span className="ml-auto shrink-0 text-xs text-slate-600">{new Date(r.created_at).toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
