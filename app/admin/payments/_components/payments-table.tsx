'use client'
import { useState } from 'react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { formatCurrency } from '@/lib/utils'
import type { PendingRow } from '../types'
import { SOURCE_LABEL } from '../types'

export function PaymentsTable({ rows, loading, onChanged }: { rows: PendingRow[]; loading: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)

  const verify = async (r: PendingRow) => {
    setBusy(r.reference + ':verify')
    try {
      const res = await fetch('/api/admin/payments/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference: r.reference }),
      })
      const json = await res.json()
      if (json.success && json.data?.processed) { toast.success(json.data.alreadyProcessed ? 'Already settled' : 'Settled ✅'); onChanged() }
      else toast.message(json.data?.paystackStatus ? `Paystack: ${json.data.paystackStatus}` : (json.error || 'Nothing to settle'))
    } catch { toast.error('Verify failed') } finally { setBusy(null) }
  }

  const retry = async (r: PendingRow) => {
    setBusy(r.reference + ':retry')
    try {
      const res = await fetch('/api/admin/payments/retry-fulfillment', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: r.source, orderId: r.orderId, reference: r.reference }),
      })
      const json = await res.json()
      if (json.success) { toast.success(json.message || 'Retry dispatched'); onChanged() }
      else toast.error(json.error || 'Retry failed')
    } catch { toast.error('Retry failed') } finally { setBusy(null) }
  }

  if (loading) return <div className="p-8 text-center text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin inline" /> Loading…</div>
  if (!rows.length) return <div className="p-8 text-center text-muted-foreground">No pending payments 🎉</div>

  return (
    <Table>
      <TableHeader><TableRow>
        <TableHead>Reference</TableHead><TableHead>Source</TableHead><TableHead>Customer</TableHead>
        <TableHead>Amount</TableHead><TableHead>Status</TableHead><TableHead>Date</TableHead><TableHead className="text-right">Actions</TableHead>
      </TableRow></TableHeader>
      <TableBody>
        {rows.map(r => (
          <TableRow key={`${r.source}:${r.reference}`}>
            <TableCell className="font-mono text-xs">{r.reference}</TableCell>
            <TableCell><Badge variant="outline">{SOURCE_LABEL[r.source]}</Badge></TableCell>
            <TableCell className="text-sm">{r.customer}</TableCell>
            <TableCell>{formatCurrency(r.amount)}</TableCell>
            <TableCell><span className="text-amber-600 text-xs capitalize">{r.status}</span></TableCell>
            <TableCell className="text-xs text-muted-foreground">{new Date(r.createdAt).toLocaleString()}</TableCell>
            <TableCell className="text-right space-x-2">
              <Button size="sm" variant="secondary" disabled={busy === r.reference + ':verify'} onClick={() => verify(r)}>
                {busy === r.reference + ':verify' ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Verify'}
              </Button>
              {r.source === 'shop' && (
                <Button size="sm" variant="outline" disabled={busy === r.reference + ':retry'} onClick={() => retry(r)}>
                  {busy === r.reference + ':retry' ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Retry'}
                </Button>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
