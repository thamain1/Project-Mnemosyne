import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'

// A team member's public profile row (RLS-gated read of public.team_members).
export type Member = {
  id: string
  full_name: string
  email: string | null
  title: string | null
  role: 'admin' | 'member' | 'client_read'
  can_code: boolean
  active: boolean
}

type AuthState = {
  session: Session | null
  user: User | null
  member: Member | null
  loading: boolean
  // true until the user clears their first-login forced password change
  mustChangePassword: boolean
  signOut: () => Promise<void>
  refreshMember: () => Promise<void>
}

const AuthContext = createContext<AuthState | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [member, setMember] = useState<Member | null>(null)
  const [loading, setLoading] = useState(true)

  // Load the caller's team_members row (RLS: a member can read the roster, incl. self).
  async function loadMember(uid: string | undefined) {
    if (!uid) {
      setMember(null)
      return
    }
    const { data, error } = await supabase
      .from('team_members')
      .select('id, full_name, email, title, role, can_code, active')
      .eq('id', uid)
      .maybeSingle()
    setMember(error ? null : (data as Member | null))
  }

  useEffect(() => {
    let active = true
    supabase.auth.getSession().then(async ({ data }) => {
      if (!active) return
      setSession(data.session)
      await loadMember(data.session?.user.id)
      if (active) setLoading(false)
    })

    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, sess) => {
      setSession(sess)
      await loadMember(sess?.user.id)
    })

    return () => {
      active = false
      sub.subscription.unsubscribe()
    }
  }, [])

  const user = session?.user ?? null
  // Server-set flag at provisioning; cleared by the ChangePassword flow via updateUser.
  const mustChangePassword = user?.user_metadata?.must_change_password === true

  const value: AuthState = {
    session,
    user,
    member,
    loading,
    mustChangePassword,
    signOut: async () => {
      await supabase.auth.signOut()
    },
    refreshMember: async () => loadMember(user?.id),
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>')
  return ctx
}
