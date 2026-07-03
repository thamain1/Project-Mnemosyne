// Mnemosyne — thread 0032 UI rider 2: a compact "System Vitals" strip in the header. First sliver of
// the future V.A.U.L.T. vitals rail (Mission-Control unit, deferred) — built entirely from data that
// already flows: usage_events (member-readable since thread 0025's grant fix) aggregated client-side,
// exactly like the Activity tab's usage card, plus an active-machine-token count. machine_tokens itself
// is service-role-only (migration 0026: RLS on, `revoke all from anon, authenticated`, no member SELECT
// policy at all) and MUST stay that way — the count comes from /api/vitals (requireMember() + service
// role), never a direct table read, so this rider does not loosen that table's exposure.

import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'

type Vitals = { calls: number; tokens: number; bytes: number; activeMachines: number | null }

const fmtCompact = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n))

export default function VitalsStrip() {
  const { session } = useAuth()
  const [v, setV] = useState<Vitals>({ calls: 0, tokens: 0, bytes: 0, activeMachines: null })

  useEffect(() => {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    ;(async () => {
      const { data, error } = await supabase
        .from('usage_events')
        .select('input_tokens, output_tokens, bytes_in, bytes_out')
        .gte('created_at', since)
        .limit(5000)
      if (!error) {
        const rows = data ?? []
        const calls = rows.length
        const tokens = rows.reduce((s, r: any) => s + (r.input_tokens ?? 0) + (r.output_tokens ?? 0), 0)
        const bytes = rows.reduce((s, r: any) => s + (r.bytes_in ?? 0) + (r.bytes_out ?? 0), 0)
        setV((prev) => ({ ...prev, calls, tokens, bytes }))
      }
      try {
        const res = await fetch('/api/vitals', { headers: { authorization: `Bearer ${session?.access_token ?? ''}` } })
        if (res.ok) {
          const j = await res.json().catch(() => null)
          if (typeof j?.activeMachines === 'number') setV((prev) => ({ ...prev, activeMachines: j.activeMachines }))
        }
      } catch { /* best-effort — vitals must never block the dashboard */ }
    })()
  }, [session])

  return (
    <div className="hidden md:flex items-center gap-1.5 text-[11px] text-slate-500 whitespace-nowrap">
      <span title="MCP + endpoint calls, last 7 days (usage_events)">{v.calls} calls/7d</span>
      <span aria-hidden className="text-slate-700">·</span>
      <span title="provider tokens, last 7 days — embed-only calls report null and are excluded">{v.tokens.toLocaleString()} tok</span>
      <span aria-hidden className="text-slate-700">·</span>
      <span title="request+response payload bytes, last 7 days — an honest proxy metric, not exact tokens">{fmtCompact(v.bytes)}B</span>
      {v.activeMachines !== null && (
        <>
          <span aria-hidden className="text-slate-700">·</span>
          <span title="active (non-revoked, non-expired) hosted-MCP machine tokens">{v.activeMachines} machine{v.activeMachines === 1 ? '' : 's'}</span>
        </>
      )}
    </div>
  )
}
