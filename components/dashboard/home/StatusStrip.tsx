'use client'

import Link from 'next/link'
import type { DashboardSummary } from '@/lib/dashboard-summary'
import { ORDER_STATUSES, STATUS_CONFIG } from '@/lib/order-status'

const ORDERS_HREF = '/dashboard/my-orders'
const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ft-blue focus-visible:ring-offset-2 focus-visible:ring-offset-background'

export function StatusStrip({ counts }: { counts: DashboardSummary['counts'] }) {
  return (
    <div className="flex flex-col gap-2 sm:gap-3">
      <Link
        href={ORDERS_HREF}
        className={`flex min-h-[44px] items-center justify-between gap-2 rounded-xl border border-border bg-card p-2.5 ${FOCUS_RING}`}
      >
        <span className="text-sm text-muted-foreground truncate">Total orders</span>
        <span className="text-sm font-semibold tabular-nums">{counts.total}</span>
      </Link>

      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        {ORDER_STATUSES.map((status) => {
          const { Icon, label, cardBg, iconColor } = STATUS_CONFIG[status]
          return (
            <Link
              key={status}
              href={ORDERS_HREF}
              className={`flex min-h-[44px] min-w-0 flex-col gap-1.5 rounded-xl border border-border bg-card p-2.5 ${FOCUS_RING}`}
            >
              <span
                className={`flex h-7 w-7 items-center justify-center rounded-lg ${cardBg}`}
              >
                <Icon className={`h-4 w-4 ${iconColor}`} aria-hidden="true" />
              </span>
              <span className="text-lg sm:text-xl font-bold tabular-nums leading-none">
                {counts[status]}
              </span>
              <span className="text-[11px] text-muted-foreground truncate" title={label}>
                {label}
              </span>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
