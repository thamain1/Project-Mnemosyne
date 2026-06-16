import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'

type Entry = {
  name: string
  title: string | null
  kind: string
  source_path: string | null
  updated_at: string
}

const KIND_COLORS: Record<string, string> = {
  project: 'bg-blue-500/15 text-blue-300',
  reference: 'bg-emerald-500/15 text-emerald-300',
  feedback: 'bg-amber-500/15 text-amber-300',
  user: 'bg-violet-500/15 text-violet-300',
}

export default function Memories() {
  const [rows, setRows] = useState<Entry[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [openName, setOpenName] = useState<string | null>(null)
  const [body, setBody] = useState<string>('')
  const [bodyLoading, setBodyLoading] = useState(false)

  useEffect(() => {
    supabase
      .from('memory_entries')
      .select('name, title, kind, source_path, updated_at')
      .order('updated_at', { ascending: false })
      .then(({ data, error }) => {
        if (error) setErr(error.message)
        else setRows((data ?? []) as Entry[])
        setLoading(false)
      })
  }, [])

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return rows
    return rows.filter(
      (r) => r.name.toLowerCase().includes(s) || (r.title ?? '').toLowerCase().includes(s),
    )
  }, [rows, q])

  async function openEntry(name: string) {
    setOpenName(name)
    setBody('')
    setBodyLoading(true)
    const { data, error } = await supabase.from('memory_entries').select('body').eq('name', name).maybeSingle()
    setBody(error ? `Error: ${error.message}` : ((data?.body as string) ?? ''))
    setBodyLoading(false)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Memories</h2>
          <p className="text-xs text-slate-500">
            {loading ? 'Loading…' : `${filtered.length} of ${rows.length}`} · text filter (semantic search coming
            soon)
          </p>
        </div>
        <input
          placeholder="Filter by name or title…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="w-64 rounded-lg bg-slate-900 border border-slate-700 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {err && <p className="text-sm text-red-400">{err}</p>}

      <div className="divide-y divide-slate-800 rounded-lg border border-slate-800 overflow-hidden">
        {filtered.map((r) => (
          <button
            key={r.name}
            onClick={() => openEntry(r.name)}
            className="w-full text-left px-4 py-3 hover:bg-slate-900/60 transition flex items-start gap-3"
          >
            <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${KIND_COLORS[r.kind] ?? 'bg-slate-700 text-slate-300'}`}>
              {r.kind}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium truncate">{r.title || r.name}</span>
              <span className="block text-xs text-slate-500 truncate">
                {r.name} · {r.source_path} · {new Date(r.updated_at).toLocaleDateString()}
              </span>
            </span>
          </button>
        ))}
        {!loading && filtered.length === 0 && <p className="px-4 py-6 text-sm text-slate-500">No matches.</p>}
      </div>

      {openName && (
        <div className="fixed inset-0 z-20 flex" onClick={() => setOpenName(null)}>
          <div className="ml-auto h-full w-full max-w-xl bg-slate-900 border-l border-slate-800 shadow-2xl overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-3 mb-3">
              <h3 className="font-semibold">{openName}</h3>
              <button onClick={() => setOpenName(null)} className="text-slate-500 hover:text-slate-200 text-sm">
                Close
              </button>
            </div>
            {bodyLoading ? (
              <p className="text-sm text-slate-500">Loading…</p>
            ) : (
              <pre className="whitespace-pre-wrap break-words text-sm text-slate-300 font-mono leading-relaxed">{body}</pre>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
