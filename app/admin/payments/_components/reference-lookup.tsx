'use client'
import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Search, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { formatCurrency } from '@/lib/utils'

export function ReferenceLookup({ onResolved }: { onResolved?: () => void }) {
  const [ref, setRef] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<Record<string, any> | null>(null)

  const lookup = async () => {
    const reference = ref.trim()
    if (!reference) return
    setLoading(true); setResult(null)
    try {
      const res = await fetch('/api/admin/payments/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference }),
      })
      const json = await res.json()
      setResult(json.data || { error: json.error })
      if (json.success && json.data?.processed) {
        toast.success(json.data.alreadyProcessed ? 'Already settled — no change' : 'Payment reconciled & settled')
        onResolved?.()
      } else if (json.success && json.data?.paystackStatus !== 'success') {
        toast.message(`Paystack status: ${json.data.paystackStatus || 'unknown'} — nothing to settle`)
      } else if (!json.success) {
        toast.error(json.error || 'Lookup failed')
      }
    } catch {
      toast.error('Lookup failed')
    } finally { setLoading(false) }
  }

  return (
    <Card>
      <CardContent className="p-3 space-y-3">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input value={ref} onChange={e => setRef(e.target.value)} placeholder="Paste a payment reference to look up & resolve…"
              className="pl-9 font-mono text-sm" onKeyDown={e => e.key === 'Enter' && lookup()} />
          </div>
          <Button onClick={lookup} disabled={loading}>{loading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Look up'}</Button>
        </div>
        {result && (
          <div className="text-sm rounded-md border p-3 bg-muted/30">
            {result.error ? <span className="text-red-600">{result.error}</span> : (
              <div className="flex flex-wrap gap-x-6 gap-y-1">
                <span><b>Source:</b> {result.source}</span>
                <span><b>Paystack:</b> {result.paystackStatus || '—'}</span>
                <span><b>Amount:</b> {result.amount != null ? formatCurrency(result.amount) : '—'}</span>
                <span><b>Settled:</b> {result.processed ? (result.alreadyProcessed ? 'already' : 'yes ✅') : 'no'}</span>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
