'use client'

import { useState } from 'react'
import Link from 'next/link'
import { sparkHeights, type DashboardSummary } from '@/lib/dashboard-summary'
import { formatCurrency } from '@/lib/utils'

type Window = '7d' | '30d'

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ft-blue focus-visible:ring-offset-2 focus-visible:ring-offset-background'
const BUY_HREF = '/dashboard/data-packages'
const WINDOWS: { id: Window; label: string }[] = [
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
]

function safe(n: unknown): number {
  const v = Number(n)
  return Number.isFinite(v) ? v : 0
}

export function SpendInsights({ spend }: { spend: DashboardSummary['spend'] }) {
  const [win, setWin] = useState<Window>('7d')

  const total7 = safe(spend.total7)
  const total30 = safe(spend.total30)
  const days = Array.from({ length: 7 }, (_, i) => safe(spend.last7?.[i]))
  const heights = sparkHeights(days, 40)
  const total = win === '7d' ? total7 : total30
  const hasTop = typeof spend.top_network === 'string' && spend.top_network.length > 0
  const empty = total30 === 0

  return (
    <section className="bg-card border border-border rounded-xl p-3 sm:p-4 flex flex-col gap-2 sm:gap-3">
      <div className="flex items-center justify-between gap-2 sm:gap-3">
        <h2 className="text-base font-semibold text-foreground truncate">Spending</h2>
        {!empty && (
          <div role="tablist" aria-label="Spending period" className="flex shrink-0 gap-1">
            {WINDOWS.map((w) => {
              const active = win === w.id
              return (
                <button
                  key={w.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setWin(w.id)}
                  className={`min-h-11 sm:min-h-9 rounded-lg px-3 text-sm font-medium ${FOCUS_RING} ${
                    active ? 'bg-ft-blue text-white' : 'bg-muted text-foreground'
                  }`}
                >
                  {w.label}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {empty ? (
        <div className="flex flex-col items-start gap-2 sm:gap-3">
          <p className="text-sm text-muted-foreground">No purchases yet.</p>
          <Link
            href={BUY_HREF}
            className={`inline-flex h-11 items-center justify-center rounded-xl bg-ft-blue px-4 text-sm font-semibold text-white hover:bg-ft-blue/90 ${FOCUS_RING}`}
          >
            Buy data
          </Link>
        </div>
      ) : (
        <>
          <div className="min-w-0">
            <p className="text-xl sm:text-2xl font-bold tabular-nums truncate" title={formatCurrency(total)}>
              {formatCurrency(total)}
            </p>
            <p className="text-sm text-muted-foreground">
              {win === '7d' ? 'Last 7 days' : 'Last 30 days'}
            </p>
          </div>

          <div className="flex flex-col gap-1">
            <div aria-hidden="true" className="flex h-10 items-end gap-1">
              {days.map((amount, i) => (
                <div
                  key={i}
                  title={formatCurrency(amount)}
                  className={`flex-1 rounded-sm ${heights[i] > 0 ? 'bg-ft-blue' : 'bg-muted'}`}
                  style={{ height: heights[i] > 0 ? heights[i] : 2 }}
                />
              ))}
            </div>
            <p className="sr-only">{`You spent ${formatCurrency(total7)} in the last 7 days.`}</p>
            <p aria-hidden="true" className="text-xs text-muted-foreground">
              Last 7 days
            </p>
          </div>

          {hasTop && (
            <p className="text-sm text-muted-foreground truncate" title={`Top network: ${spend.top_network}`}>
              Top network: <span className="text-foreground font-medium">{spend.top_network}</span>
            </p>
          )}
        </>
      )}
    </section>
  )
}
