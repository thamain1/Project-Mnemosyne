import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

type Row = {
  full_name: string
  email: string | null
  title: string | null
  role: string
  can_code: boolean
  active: boolean
}

export default function Team() {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    supabase
      .from('team_members')
      .select('full_name, email, title, role, can_code, active')
      .order('role', { ascending: true })
      .order('full_name', { ascending: true })
      .then(({ data, error }) => {
        if (error) setErr(error.message)
        else setRows((data ?? []) as Row[])
        setLoading(false)
      })
  }, [])

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Team</h2>
        <p className="text-xs text-slate-500">{loading ? 'Loading…' : `${rows.length} members`} · 4ward Motion Solutions</p>
      </div>

      {err && <p className="text-sm text-red-400">{err}</p>}

      <div className="divide-y divide-slate-800 rounded-lg border border-slate-800 overflow-hidden">
        {rows.map((r) => (
          <div key={r.email ?? r.full_name} className="px-4 py-3 flex items-center gap-3">
            <div className="min-w-0">
              <span className="block text-sm font-medium truncate">{r.full_name}</span>
              <span className="block text-xs text-slate-500 truncate">
                {r.title ?? '—'} · {r.email}
              </span>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-2 text-[10px] uppercase tracking-wide">
              {r.role === 'admin' && <span className="rounded bg-blue-500/15 text-blue-300 px-1.5 py-0.5">admin</span>}
              {r.can_code && <span className="rounded bg-emerald-500/15 text-emerald-300 px-1.5 py-0.5">can_code</span>}
              {!r.active && <span className="rounded bg-red-500/15 text-red-300 px-1.5 py-0.5">inactive</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
