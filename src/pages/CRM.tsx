import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'

type Client = { id: string; name: string; notes: string | null }
type Deal = { id: string; client_id: string | null; title: string; stage: string; amount: number | null; currency: string; owner_id: string | null; notes: string | null }
type Member = { id: string; full_name: string }
type DocRow = { id: string; title: string; doc_type: string; deal_id: string | null }
type Contact = { id: string; client_id: string | null; name: string; email: string | null; role: string | null }
type ActRow = { id: string; action: string; actor_id: string | null; detail: any; created_at: string }

const STAGES = ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'] as const
const STAGE_LABEL: Record<string, string> = { lead: 'Lead', qualified: 'Qualified', proposal: 'Proposal', negotiation: 'Negotiation', won: 'Won', lost: 'Lost' }
const STAGE_COLOR: Record<string, string> = {
  lead: 'border-slate-700', qualified: 'border-sky-800', proposal: 'border-violet-800',
  negotiation: 'border-amber-800', won: 'border-emerald-800', lost: 'border-rose-900',
}
const fmtMoney = (a: number | null, c: string) => a == null ? '' : new Intl.NumberFormat('en-US', { style: 'currency', currency: c || 'USD', maximumFractionDigits: 0 }).format(a)

export default function CRM() {
  const { session } = useAuth()
  const [clients, setClients] = useState<Client[]>([])
  const [deals, setDeals] = useState<Deal[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [docs, setDocs] = useState<DocRow[]>([])
  const [contacts, setContacts] = useState<Contact[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [dealModal, setDealModal] = useState<Partial<Deal> | null>(null)
  const [clientModal, setClientModal] = useState<Partial<Client> | null>(null)
  const [contactModal, setContactModal] = useState<Partial<Contact> | null>(null)
  const [detail, setDetail] = useState<Deal | null>(null)
  const [acts, setActs] = useState<ActRow[]>([])
  const [note, setNote] = useState('')

  const token = session?.access_token ?? ''
  const post = useCallback(async (path: string, body: any) => {
    const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data?.error || `${path} failed (${res.status})`)
    return data
  }, [token])

  const load = useCallback(async () => {
    // documents.deal_id is added by migration 0015; select defensively so the CRM tab works pre-migration too.
    let docData: any[] | null
    let docErr: { message: string } | null
    const withDeal = await supabase.from('documents').select('id, title, doc_type, deal_id').order('created_at', { ascending: false })
    if (withDeal.error) {
      const fb = await supabase.from('documents').select('id, title, doc_type').order('created_at', { ascending: false })
      docData = (fb.data ?? []).map((r: any) => ({ ...r, deal_id: null }))
      docErr = fb.error
    } else { docData = withDeal.data; docErr = null }

    const [c, d, m, ct] = await Promise.all([
      supabase.from('clients').select('id, name, notes').order('name'),
      supabase.from('deals').select('id, client_id, title, stage, amount, currency, owner_id, notes').order('created_at', { ascending: false }),
      supabase.from('team_members').select('id, full_name').eq('active', true).order('full_name'),
      supabase.from('contacts').select('id, client_id, name, email, role').order('name'),
    ])
    const e = c.error || d.error || m.error || ct.error || docErr
    if (e) setErr(e.message)
    else { setClients((c.data ?? []) as Client[]); setDeals((d.data ?? []) as Deal[]); setMembers((m.data ?? []) as Member[]); setContacts((ct.data ?? []) as Contact[]); setDocs((docData ?? []) as DocRow[]) }
    setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])

  const clientName = (id: string | null) => clients.find((c) => c.id === id)?.name ?? '—'
  const memberName = (id: string | null) => members.find((m) => m.id === id)?.full_name ?? '—'
  const byStage = useMemo(() => {
    const m = new Map<string, Deal[]>(STAGES.map((s) => [s, []]))
    for (const d of deals) (m.get(d.stage) ?? m.get('lead')!).push(d)
    return m
  }, [deals])
  const pipelineValue = useMemo(() => deals.filter((d) => d.stage !== 'lost').reduce((s, d) => s + (d.amount ?? 0), 0), [deals])

  async function moveStage(d: Deal, stage: string) {
    if (stage === d.stage) return
    setBusy(true); setErr(null)
    try { await post('/api/upsert-deal', { id: d.id, title: d.title, stage, client_id: d.client_id, owner_id: d.owner_id, amount: d.amount, currency: d.currency, notes: d.notes }); await load() }
    catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  async function saveDeal(e: FormEvent) {
    e.preventDefault(); if (!dealModal) return
    setBusy(true); setErr(null)
    try {
      const p: any = { title: dealModal.title, stage: dealModal.stage || 'lead' }
      if (dealModal.id) p.id = dealModal.id
      p.client_id = dealModal.client_id || null
      p.owner_id = dealModal.owner_id || null
      p.amount = dealModal.amount === undefined || (dealModal.amount as any) === '' ? null : Number(dealModal.amount)
      if (dealModal.currency) p.currency = dealModal.currency
      p.notes = dealModal.notes || null
      await post('/api/upsert-deal', p); setDealModal(null); await load()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  async function saveClient(e: FormEvent) {
    e.preventDefault(); if (!clientModal) return
    setBusy(true); setErr(null)
    try {
      const p: any = { name: clientModal.name }
      if (clientModal.id) p.id = clientModal.id
      p.notes = clientModal.notes || null
      await post('/api/upsert-client', p); setClientModal(null); await load()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  async function link(documentId: string, dealId: string | null) {
    setBusy(true); setErr(null)
    try { await post('/api/link-document', { document_id: documentId, deal_id: dealId }); await load() }
    catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  async function saveContact(e: FormEvent) {
    e.preventDefault(); if (!contactModal) return
    setBusy(true); setErr(null)
    try {
      const p: any = { name: contactModal.name }
      if (contactModal.id) p.id = contactModal.id
      if (contactModal.client_id) p.client_id = contactModal.client_id
      p.email = contactModal.email || null
      p.role = contactModal.role || null
      await post('/api/upsert-contact', p); setContactModal(null); await load()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  // per-deal activity: read the team-readable activity_log for this deal; add notes via /api/log-update
  const loadActs = useCallback(async (dealId: string) => {
    setActs([])
    const { data } = await supabase.from('activity_log').select('id, action, actor_id, detail, created_at')
      .eq('entity_type', 'deals').eq('entity_id', dealId).order('created_at', { ascending: false }).limit(50)
    setActs((data ?? []) as ActRow[])
  }, [])
  function openDetail(d: Deal) { setDetail(d); setNote(''); loadActs(d.id) }
  async function addNote(e: FormEvent) {
    e.preventDefault(); if (!detail) return
    const n = note.trim(); if (!n) return
    setBusy(true); setErr(null)
    try { await post('/api/log-update', { note: n, action: 'deal.note', entity_type: 'deals', entity_id: detail.id }); setNote(''); await loadActs(detail.id) }
    catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  const detailDocs = detail ? docs.filter((d) => d.deal_id === detail.id) : []
  const attachable = detail ? docs.filter((d) => d.deal_id !== detail.id) : []
  const detailContacts = detail ? contacts.filter((c) => c.client_id && c.client_id === detail.client_id) : []
  const modalClientContacts = clientModal?.id ? contacts.filter((c) => c.client_id === clientModal.id) : []

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h2 className="text-lg font-semibold">CRM</h2>
          <p className="text-xs text-slate-500">
            {loading ? 'Loading…' : `${deals.length} deal${deals.length === 1 ? '' : 's'} · ${clients.length} client${clients.length === 1 ? '' : 's'} · open pipeline ${fmtMoney(pipelineValue, 'USD')}`}
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          <button onClick={() => setClientModal({})} className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:text-slate-100">+ Client</button>
          <button onClick={() => setDealModal({ stage: 'lead', currency: 'USD' })} className="rounded-lg bg-blue-600 hover:bg-blue-500 px-3 py-1.5 text-sm font-medium transition">+ Deal</button>
        </div>
      </div>

      {err && <p className="text-sm text-red-400">{err}</p>}

      {/* pipeline board */}
      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
        {STAGES.map((s) => {
          const col = byStage.get(s) ?? []
          const val = col.reduce((sum, d) => sum + (d.amount ?? 0), 0)
          return (
            <div key={s} className={`rounded-lg border ${STAGE_COLOR[s]} bg-slate-900/40 p-2 min-h-[120px]`}>
              <div className="flex items-center justify-between px-1 pb-2">
                <span className="text-xs font-medium text-slate-300">{STAGE_LABEL[s]}</span>
                <span className="text-[10px] text-slate-500">{col.length}{val ? ` · ${fmtMoney(val, 'USD')}` : ''}</span>
              </div>
              <div className="space-y-2">
                {col.map((d) => (
                  <div key={d.id} className="rounded-md border border-slate-800 bg-slate-900 p-2 text-left">
                    <button onClick={() => openDetail(d)} className="block w-full text-left">
                      <span className="block text-sm font-medium line-clamp-2">{d.title}</span>
                      <span className="block text-xs text-slate-500">{clientName(d.client_id)}</span>
                      {d.amount != null && <span className="block text-xs text-emerald-400">{fmtMoney(d.amount, d.currency)}</span>}
                    </button>
                    <select value={d.stage} disabled={busy} onChange={(e) => moveStage(d, e.target.value)}
                      className="mt-1.5 w-full rounded bg-slate-800 border border-slate-700 px-1 py-0.5 text-[11px] text-slate-300 focus:outline-none">
                      {STAGES.map((x) => <option key={x} value={x}>{STAGE_LABEL[x]}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {/* clients */}
      <div>
        <h3 className="text-sm font-medium mb-2">Clients</h3>
        {clients.length === 0 ? <p className="text-sm text-slate-500">No clients yet.</p> : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {clients.map((c) => (
              <button key={c.id} onClick={() => setClientModal(c)} className="text-left rounded-lg border border-slate-800 bg-slate-900/40 hover:border-slate-700 p-3">
                <span className="block text-sm font-medium">{c.name}</span>
                <span className="block text-xs text-slate-500">{deals.filter((d) => d.client_id === c.id).length} deal(s)</span>
                {c.notes && <span className="block text-xs text-slate-600 line-clamp-2 mt-1">{c.notes}</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* deal modal */}
      {dealModal && (
        <Modal title={dealModal.id ? 'Edit deal' : 'New deal'} onClose={() => setDealModal(null)}>
          <form onSubmit={saveDeal} className="space-y-3">
            <Input label="Title *" value={dealModal.title ?? ''} onChange={(v) => setDealModal({ ...dealModal, title: v })} required />
            <div className="grid grid-cols-2 gap-3">
              <Select label="Stage" value={dealModal.stage ?? 'lead'} onChange={(v) => setDealModal({ ...dealModal, stage: v })} options={STAGES.map((s) => ({ value: s, label: STAGE_LABEL[s] }))} />
              <Select label="Client" value={dealModal.client_id ?? ''} onChange={(v) => setDealModal({ ...dealModal, client_id: v || null })} options={[{ value: '', label: '— none —' }, ...clients.map((c) => ({ value: c.id, label: c.name }))]} />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Input label="Amount" type="number" value={dealModal.amount == null ? '' : String(dealModal.amount)} onChange={(v) => setDealModal({ ...dealModal, amount: v === '' ? undefined : (Number(v) as any) })} />
              <Input label="Currency" value={dealModal.currency ?? 'USD'} onChange={(v) => setDealModal({ ...dealModal, currency: v })} />
              <Select label="Owner" value={dealModal.owner_id ?? ''} onChange={(v) => setDealModal({ ...dealModal, owner_id: v || null })} options={[{ value: '', label: '— none —' }, ...members.map((m) => ({ value: m.id, label: m.full_name }))]} />
            </div>
            <Textarea label="Notes" value={dealModal.notes ?? ''} onChange={(v) => setDealModal({ ...dealModal, notes: v })} />
            <ModalActions busy={busy} onCancel={() => setDealModal(null)} />
          </form>
        </Modal>
      )}

      {/* client modal */}
      {clientModal && (
        <Modal title={clientModal.id ? 'Edit client' : 'New client'} onClose={() => setClientModal(null)}>
          <form onSubmit={saveClient} className="space-y-3">
            <Input label="Name *" value={clientModal.name ?? ''} onChange={(v) => setClientModal({ ...clientModal, name: v })} required />
            <Textarea label="Notes" value={clientModal.notes ?? ''} onChange={(v) => setClientModal({ ...clientModal, notes: v })} />
            <ModalActions busy={busy} onCancel={() => setClientModal(null)} />
          </form>
          {clientModal.id && (
            <div className="border-t border-slate-800 mt-4 pt-3">
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-xs font-medium text-slate-400">Contacts</h4>
                <button onClick={() => setContactModal({ client_id: clientModal.id })} className="text-xs text-blue-400 hover:text-blue-300">+ Add contact</button>
              </div>
              {modalClientContacts.length === 0 ? <p className="text-xs text-slate-600">No contacts yet.</p> : (
                <ul className="space-y-1">
                  {modalClientContacts.map((ct) => (
                    <li key={ct.id} className="flex items-center gap-2 text-xs">
                      <span className="text-slate-300">{ct.name}</span>
                      {ct.role && <span className="text-slate-500">· {ct.role}</span>}
                      {ct.email && <span className="text-slate-500 truncate">· {ct.email}</span>}
                      <button onClick={() => setContactModal(ct)} className="ml-auto text-slate-500 hover:text-slate-200">edit</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Modal>
      )}

      {/* deal detail (with document linkage) */}
      {detail && (
        <Modal title={detail.title} onClose={() => setDetail(null)}>
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-slate-400">
              <span>Stage: <span className="text-slate-200">{STAGE_LABEL[detail.stage]}</span></span>
              <span>Client: <span className="text-slate-200">{clientName(detail.client_id)}</span></span>
              {detail.amount != null && <span>Value: <span className="text-emerald-400">{fmtMoney(detail.amount, detail.currency)}</span></span>}
              <span>Owner: <span className="text-slate-200">{memberName(detail.owner_id)}</span></span>
            </div>
            {detail.notes && <p className="text-slate-300 whitespace-pre-wrap">{detail.notes}</p>}
            <div className="flex gap-2">
              <button onClick={() => { setDealModal(detail); setDetail(null) }} className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:text-slate-100">Edit deal</button>
            </div>

            <div className="border-t border-slate-800 pt-3">
              <h4 className="text-xs font-medium text-slate-400 mb-2">Linked documents</h4>
              {detailDocs.length === 0 ? <p className="text-xs text-slate-600">None linked yet.</p> : (
                <ul className="space-y-1">
                  {detailDocs.map((d) => (
                    <li key={d.id} className="flex items-center gap-2 text-xs">
                      <span className="rounded bg-slate-800 px-1.5 py-0.5 uppercase text-[10px] text-slate-400">{d.doc_type}</span>
                      <span className="truncate text-slate-300">{d.title}</span>
                      <button onClick={() => link(d.id, null)} disabled={busy} className="ml-auto text-slate-500 hover:text-rose-400">detach</button>
                    </li>
                  ))}
                </ul>
              )}
              {attachable.length > 0 && (
                <div className="mt-2">
                  <select disabled={busy} value="" onChange={(e) => e.target.value && link(e.target.value, detail.id)}
                    className="w-full rounded bg-slate-900 border border-slate-700 px-2 py-1.5 text-xs text-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500">
                    <option value="">+ Attach a document…</option>
                    {attachable.map((d) => <option key={d.id} value={d.id}>{d.doc_type.toUpperCase()} · {d.title}{d.deal_id ? ' (moves from another deal)' : ''}</option>)}
                  </select>
                </div>
              )}
            </div>

            {/* client contacts (read-only quick view) */}
            <div className="border-t border-slate-800 pt-3">
              <h4 className="text-xs font-medium text-slate-400 mb-2">Client contacts</h4>
              {detailContacts.length === 0 ? <p className="text-xs text-slate-600">No contacts on this client.</p> : (
                <ul className="space-y-1">
                  {detailContacts.map((ct) => (
                    <li key={ct.id} className="text-xs text-slate-300">
                      {ct.name}{ct.role && <span className="text-slate-500"> · {ct.role}</span>}{ct.email && <span className="text-slate-500"> · {ct.email}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* per-deal activity */}
            <div className="border-t border-slate-800 pt-3">
              <h4 className="text-xs font-medium text-slate-400 mb-2">Activity</h4>
              <form onSubmit={addNote} className="flex items-start gap-2 mb-2">
                <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={1000}
                  placeholder="Add a note to this deal…"
                  className="flex-1 resize-y rounded-lg bg-slate-900 border border-slate-700 px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" />
                <button type="submit" disabled={busy || !note.trim()} className="rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 px-3 py-1.5 text-xs font-medium transition">Post</button>
              </form>
              {acts.length === 0 ? <p className="text-xs text-slate-600">No activity yet.</p> : (
                <ul className="space-y-1.5">
                  {acts.map((a) => (
                    <li key={a.id} className="text-xs">
                      {a.detail?.note
                        ? <span className="text-slate-300 whitespace-pre-wrap break-words">{a.detail.note}</span>
                        : <><code className="rounded bg-slate-800 px-1 py-0.5 text-[10px] text-blue-300">{a.action}</code> <span className="text-slate-500">{a.detail && Object.keys(a.detail).length ? JSON.stringify(a.detail) : ''}</span></>}
                      <span className="block text-[10px] text-slate-600">{memberName(a.actor_id)} · {new Date(a.created_at).toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </Modal>
      )}

      {/* contact modal */}
      {contactModal && (
        <Modal title={contactModal.id ? 'Edit contact' : 'New contact'} onClose={() => setContactModal(null)}>
          <form onSubmit={saveContact} className="space-y-3">
            <Input label="Name *" value={contactModal.name ?? ''} onChange={(v) => setContactModal({ ...contactModal, name: v })} required />
            <div className="grid grid-cols-2 gap-3">
              <Input label="Email" value={contactModal.email ?? ''} onChange={(v) => setContactModal({ ...contactModal, email: v })} />
              <Input label="Role" value={contactModal.role ?? ''} onChange={(v) => setContactModal({ ...contactModal, role: v })} />
            </div>
            <ModalActions busy={busy} onCancel={() => setContactModal(null)} />
          </form>
        </Modal>
      )}
    </div>
  )
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-lg max-h-[85vh] overflow-y-auto bg-slate-900 border border-slate-800 rounded-xl shadow-2xl p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold">{title}</h3>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-sm">Close</button>
        </div>
        {children}
      </div>
    </div>
  )
}
function Input({ label, value, onChange, type = 'text', required }: { label: string; value: string; onChange: (v: string) => void; type?: string; required?: boolean }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-slate-400">{label}</span>
      <input type={type} value={value} required={required} onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
    </label>
  )
}
function Textarea({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-slate-400">{label}</span>
      <textarea value={value} rows={3} onChange={(e) => onChange(e.target.value)}
        className="w-full resize-y rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
    </label>
  )
}
function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-slate-400">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  )
}
function ModalActions({ busy, onCancel }: { busy: boolean; onCancel: () => void }) {
  return (
    <div className="flex justify-end gap-2 pt-1">
      <button type="button" onClick={onCancel} className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-400 hover:text-slate-100">Cancel</button>
      <button type="submit" disabled={busy} className="rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 px-4 py-1.5 text-sm font-medium transition">{busy ? 'Saving…' : 'Save'}</button>
    </div>
  )
}
