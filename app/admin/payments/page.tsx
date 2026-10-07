'use client'
import { useCallback, useEffect, useState } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { StatCards } from './_components/stat-cards'
import { ReferenceLookup } from './_components/reference-lookup'
import { PaymentsTable } from './_components/payments-table'
import { PaystackReconcile } from './_components/paystack-reconcile'
import { toast } from 'sonner'
import type { StatsResponse, PendingRow, PaymentSource } from './types'

const SOURCES: { key: PaymentSource | 'all'; label: string }[] = [
  { key: 'all', label: 'All' }, { key: 'main', label: 'Main' },
  { key: 'shop', label: 'Shop' }, { key: 'results_checker', label: 'Results-Checker' },
]
const RANGES = [ { key: 'today', label: 'Today' }, { key: '7d', label: '7 days' }, { key: '30d', label: '30 days' }, { key: 'all', label: 'All' } ]

export default function AdminPaymentsPage() {
  const [range, setRange] = useState('today')
  const [source, setSource] = useState<PaymentSource | 'all'>('all')
  const [stats, setStats] = useState<StatsResponse | null>(null)
  const [rows, setRows] = useState<PendingRow[]>([])
  const [loadingRows, setLoadingRows] = useState(true)
  const [q, setQ] = useState('')

  const loadStats = useCallback(async () => {
    const res = await fetch(`/api/admin/payments/stats?range=${range}`)
    const json = await res.json()
    if (json.success) setStats(json.data)
  }, [range])

  const loadRows = useCallback(async () => {
    setLoadingRows(true)
    const res = await fetch(`/api/admin/payments/pending?source=${source}&q=${encodeURIComponent(q)}`)
    const json = await res.json()
    if (json.success) setRows(json.data)
    setLoadingRows(false)
  }, [source, q])

  useEffect(() => { loadStats() }, [loadStats])
  useEffect(() => { const t = setTimeout(loadRows, 250); return () => clearTimeout(t) }, [loadRows])

  const refreshAll = useCallback(() => { loadStats(); loadRows() }, [loadStats, loadRows])

  const [running, setRunning] = useState(false)
  const runCheck = useCallback(async () => {
    setRunning(true)
    try {
      const res = await fetch('/api/admin/payments/run-check', { method: 'POST' })
      const json = await res.json()
      if (json.success) {
        const d = json.data
        toast.success(`Checked ${d.processed} — settled ${d.verified}, failed ${d.failed}, aged-out ${d.agedOut}, still pending ${d.stillPending}`)
        refreshAll()
      } else {
        toast.error(json.error || 'Run failed')
      }
    } catch {
      toast.error('Run failed')
    } finally {
      setRunning(false)
    }
  }, [refreshAll])

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold">Payments Center</h1>
          <p className="text-muted-foreground text-sm">Track & resolve Paystack payments — without the dashboard.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            {RANGES.map(r => (
              <button key={r.key} onClick={() => setRange(r.key)}
                className={`text-xs px-3 py-1.5 rounded-md border ${range === r.key ? 'bg-primary text-primary-foreground' : 'bg-background'}`}>{r.label}</button>
            ))}
          </div>
          <button onClick={runCheck} disabled={running}
            className="text-xs px-3 py-1.5 rounded-md border bg-background hover:bg-muted disabled:opacity-50">
            {running ? 'Checking…' : 'Run pending check'}
          </button>
        </div>
      </div>

      <div className="flex gap-1 flex-wrap">
        {SOURCES.map(s => (
          <button key={s.key} onClick={() => setSource(s.key)}
            className={`text-xs px-3 py-1.5 rounded-md border ${source === s.key ? 'bg-primary text-primary-foreground' : 'bg-background'}`}>{s.label}</button>
        ))}
      </div>

      <StatCards stats={stats} source={source} />
      <ReferenceLookup onResolved={refreshAll} />

      <Tabs defaultValue="pending">
        <TabsList>
          <TabsTrigger value="pending">Pending queue</TabsTrigger>
          <TabsTrigger value="reconcile">Paystack reconciliation</TabsTrigger>
        </TabsList>
        <TabsContent value="pending">
          <Card>
            <CardContent className="p-3 space-y-3">
              <Input placeholder="Search reference or phone/email…" value={q} onChange={e => setQ(e.target.value)} className="md:w-96" />
              <PaymentsTable rows={rows} loading={loadingRows} onChanged={refreshAll} />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="reconcile">
          <Card><CardContent className="p-3"><PaystackReconcile /></CardContent></Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
