'use client'
import { useState } from 'react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { formatCurrency } from '@/lib/utils'
import type { ReconRow, ReconState } from '../types'
import { SOURCE_LABEL } from '../types'

const STATE_BADGE: Record<ReconState, { label: string; cls: string }> = {
  reconciled:     { label: '✅ Reconciled',      cls: 'text-green-600' },
  paid_unsettled: { label: '⚠ Paid, not settled', cls: 'text-amber-600' },
  mismatch:       { label: '🚩 Mismatch',        cls: 'text-red-600' },
  in_flight:      { label: '⏳ In flight',        cls: 'text-blue-600' },
  failed:         { label: '❌ Failed',           cls: 'text-muted-foreground' },
  unknown:        { label: '— Unknown',          cls: 'text-muted-foreground' },
}

export function PaystackReconcile() {
  const today = new Date().toISOString().slice(0, 10)
  const [from, setFrom] = useState(today)
  const [to, setTo] = useState(today)
  const [loading, setLoading] = useState(false)
  const [rows, setRows] = useState<ReconRow[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [meta, setMeta] = useState<{ total?: number; pageCount?: number } | null>(null)

  const pull = async () => {
    setLoading(true)
    try {
      const qs = new URLSearchParams({ from, to, status: 'success', page: '1' })
      const res = await fetch(`/api/admin/payments/paystack-list?${qs.toString()}`)
      const json = await res.json()
      if (json.success) { setRows(json.data); setMeta(json.meta || null) }
      else toast.error(json.error || 'Pull failed')
    } catch { toast.error('Pull failed') } finally { setLoading(false) }
  }

  const reconcile = async (r: ReconRow, idx: number) => {
    setBusy(String(idx))
    try {
      const res = await fetch('/api/admin/payments/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference: r.reference }),
      })
      const json = await res.json()
      if (json.success && json.data?.processed) {
        toast.success('Reconciled ✅')
        setRows(prev => prev.map((x, i) => i === idx ? { ...x, reconState: 'reconciled', dbState: 'processed' } : x))
      } else toast.error(json.error || 'Could not reconcile')
    } catch { toast.error('Reconcile failed') } finally { setBusy(null) }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div><label className="text-xs text-muted-foreground">From</label><Input type="date" value={from} onChange={e => setFrom(e.target.value)} /></div>
        <div><label className="text-xs text-muted-foreground">To</label><Input type="date" value={to} onChange={e => setTo(e.target.value)} /></div>
        <Button onClick={pull} disabled={loading}>{loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <><RefreshCw className="w-4 h-4 mr-1" /> Pull from Paystack</>}</Button>
      </div>
      {meta && meta.total != null && meta.total > rows.length && (
        <p className="text-xs text-amber-600">
          Showing the first {rows.length} of {meta.total} transactions for this range — narrow the date range to see the rest.
        </p>
      )}
      {rows.length > 0 && (
        <Table>
          <TableHeader><TableRow>
            <TableHead>Reference</TableHead><TableHead>Source</TableHead><TableHead>Customer</TableHead>
            <TableHead>Amount</TableHead><TableHead>State</TableHead><TableHead className="text-right">Action</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {rows.map((r, i) => {
              const badge = STATE_BADGE[r.reconState] ?? STATE_BADGE.unknown
              return (
                <TableRow key={`${r.reference}:${i}`}>
                  <TableCell className="font-mono text-xs">{r.reference}</TableCell>
                  <TableCell><Badge variant="outline">{SOURCE_LABEL[r.source]}</Badge></TableCell>
                  <TableCell className="text-sm">{r.customer}</TableCell>
                  <TableCell>{formatCurrency(r.amount)}</TableCell>
                  <TableCell><span className={`text-xs ${badge.cls}`}>{badge.label}</span></TableCell>
                  <TableCell className="text-right">
                    {r.reconState === 'paid_unsettled' && (
                      <Button size="sm" disabled={busy === String(i)} onClick={() => reconcile(r, i)}>
                        {busy === String(i) ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Reconcile'}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
