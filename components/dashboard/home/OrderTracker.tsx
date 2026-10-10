'use client'

import Link from 'next/link'
import { trackerStep, type DashboardSummary } from '@/lib/dashboard-summary'
import { STATUS_CONFIG, type OrderStatus } from '@/lib/order-status'

const ORDERS_HREF = '/dashboard/my-orders'
const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ft-blue focus-visible:ring-offset-2 focus-visible:ring-offset-background'
const STEPS = ['Paid', 'Queued', 'Processing', 'Delivered'] as const

export function OrderTracker({
  order,
}: {
  order: NonNullable<DashboardSummary['active_order']> | null
}) {
  if (!order) return null

  const config = STATUS_CONFIG[order.status as OrderStatus] as
    | (typeof STATUS_CONFIG)[OrderStatus]
    | undefined
  const statusLabel = config?.label ?? order.status
  const current = trackerStep(order.status)
  const title = `${order.network} ${order.size}`.trim()
  const Icon = config?.Icon

  return (
    <Link
      href={ORDERS_HREF}
      aria-live="polite"
      className={`block min-h-[44px] bg-card border border-border rounded-xl p-3 sm:p-4 ${FOCUS_RING}`}
    >
      <span className="sr-only">{`Order for ${title}: ${statusLabel}.`}</span>
      <div className="flex items-center justify-between gap-2 sm:gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold truncate" title={title}>
            {title}
          </p>
          {order.phone_masked ? (
            <p className="text-xs text-muted-foreground tabular-nums truncate">
              {order.phone_masked}
            </p>
          ) : null}
        </div>
        <span
          className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
            config?.badge ?? 'bg-muted text-muted-foreground'
          }`}
        >
          {Icon ? <Icon className="w-3.5 h-3.5" aria-hidden="true" /> : null}
          {statusLabel}
        </span>
      </div>

      <ol className="mt-3 grid grid-cols-4 gap-2 sm:gap-3" aria-hidden="true">
        {STEPS.map((label, i) => (
          <li key={label} className="min-w-0">
            <div
              className={`h-1.5 rounded-full ${
                i <= current ? 'bg-ft-blue' : 'bg-muted'
              } ${i === current && current < 3 ? 'motion-safe:animate-pulse' : ''}`}
            />
            <p className="mt-1.5 text-center text-[10px] sm:text-xs text-muted-foreground truncate" title={label}>
              {label}
            </p>
          </li>
        ))}
      </ol>
    </Link>
  )
}
