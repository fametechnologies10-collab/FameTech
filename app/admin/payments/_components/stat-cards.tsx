'use client'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatCurrency } from '@/lib/utils'
import type { StatsResponse, PaymentSource } from '../types'
import { SOURCE_LABEL } from '../types'

function agg(stats: StatsResponse, source: PaymentSource | 'all') {
  const keys: PaymentSource[] = source === 'all' ? ['main', 'shop', 'results_checker'] : [source]
  return keys.reduce((acc, k) => {
    const s = stats[k]
    acc.completedAmount += s.completed_amount
    acc.completedCount += s.completed_count
    acc.pendingCount += s.pending_count
    acc.pendingAmount += s.pending_amount
    acc.failedCount += s.failed_count
    return acc
  }, { completedAmount: 0, completedCount: 0, pendingCount: 0, pendingAmount: 0, failedCount: 0 })
}

export function StatCards({ stats, source }: { stats: StatsResponse | null; source: PaymentSource | 'all' }) {
  if (!stats) return <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">{[0,1,2,3].map(i => <Card key={i} className="h-24 animate-pulse" />)}</div>
  const a = agg(stats, source)
  const total = a.completedCount + a.failedCount
  const successRate = total > 0 ? ((a.completedCount / total) * 100).toFixed(1) : '—'
  const cards = [
    { title: 'Completed', value: formatCurrency(a.completedAmount), sub: `${a.completedCount} payments` },
    { title: 'Pending', value: String(a.pendingCount), sub: formatCurrency(a.pendingAmount) },
    { title: 'Failed', value: String(a.failedCount), sub: 'payments' },
    { title: 'Success rate', value: successRate === '—' ? '—' : `${successRate}%`, sub: source === 'all' ? 'All sources' : SOURCE_LABEL[source] },
  ]
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {cards.map(c => (
        <Card key={c.title}>
          <CardHeader className="pb-1"><CardTitle className="text-xs font-medium text-muted-foreground">{c.title}</CardTitle></CardHeader>
          <CardContent><div className="text-xl font-bold">{c.value}</div><div className="text-xs text-muted-foreground">{c.sub}</div></CardContent>
        </Card>
      ))}
    </div>
  )
}
