import { useState } from 'react'
import { useAuth } from './auth/AuthProvider'
import Login from './pages/Login'
import ChangePassword from './pages/ChangePassword'
import AppShell, { type Tab } from './components/AppShell'
import Memories from './pages/Memories'
import Documents from './pages/Documents'
import Generate from './pages/Generate'
import Create from './pages/Create'
import CRM from './pages/CRM'
import Activity from './pages/Activity'
import Team from './pages/Team'

export default function App() {
  const { session, loading, mustChangePassword } = useAuth()
  const [tab, setTab] = useState<Tab>('memories')

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-500 flex items-center justify-center text-sm">
        Loading…
      </div>
    )
  }

  if (!session) return <Login />
  if (mustChangePassword) return <ChangePassword />

  return (
    <AppShell tab={tab} onTab={setTab}>
      {tab === 'memories' && <Memories />}
      {tab === 'documents' && <Documents />}
      {tab === 'generate' && <Generate />}
      {tab === 'create' && <Create />}
      {tab === 'crm' && <CRM />}
      {tab === 'activity' && <Activity />}
      {tab === 'team' && <Team />}
    </AppShell>
  )
}
