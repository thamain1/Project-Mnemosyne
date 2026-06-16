import { useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'

const MIN_LEN = 10

// Forced on first login (user_metadata.must_change_password). Clears the flag on success.
export default function ChangePassword() {
  const { signOut } = useAuth()
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (pw.length < MIN_LEN) return setError(`Password must be at least ${MIN_LEN} characters.`)
    if (pw !== pw2) return setError('Passwords do not match.')
    setBusy(true)
    const { error } = await supabase.auth.updateUser({
      password: pw,
      data: { must_change_password: false },
    })
    setBusy(false)
    if (error) return setError(error.message)
    // onAuthStateChange (USER_UPDATED) refreshes the session → app advances to the dashboard.
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-8">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-5">
        <div className="text-center space-y-2">
          <h1 className="text-xl font-bold tracking-tight">Set a new password</h1>
          <p className="text-sm text-slate-400">First sign-in — please replace your temporary password.</p>
        </div>
        <div className="space-y-3">
          <input
            type="password"
            required
            autoComplete="new-password"
            placeholder={`New password (min ${MIN_LEN} chars)`}
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <input
            type="password"
            required
            autoComplete="new-password"
            placeholder="Confirm new password"
            value={pw2}
            onChange={(e) => setPw2(e.target.value)}
            className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 px-3 py-2 text-sm font-medium transition"
        >
          {busy ? 'Saving…' : 'Set password & continue'}
        </button>
        <button type="button" onClick={signOut} className="w-full text-center text-xs text-slate-500 hover:text-slate-300">
          Sign out
        </button>
      </form>
    </div>
  )
}
