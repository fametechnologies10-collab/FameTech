'use client'

import Link from 'next/link'
import { useReducedMotion } from 'framer-motion'
import { isLowBalance } from '@/lib/dashboard-summary'
import { useCountUp } from '@/hooks/use-count-up'

const TOP_UP_HREF = '/dashboard/wallet'
const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ft-blue focus-visible:ring-offset-2 focus-visible:ring-offset-background'

export function WalletHero({ balance }: { balance: number | null }) {
  const reduceMotion = useReducedMotion()
  // Hooks stay unconditional; under reduced motion the animation is skipped (target 0, duration 0).
  const animated = useCountUp(reduceMotion ? 0 : (balance ?? 0), reduceMotion ? 0 : 700, 2)
  const loading = balance === null
  // First frame of useCountUp is the bare string '0': show the real balance instead.
  const shown =
    balance === null
      ? '—'
      : reduceMotion || animated === '0'
        ? balance.toFixed(2)
        : animated

  return (
    <section
      id="wallet-card"
      className="bg-card border border-border rounded-xl p-3 sm:p-4 flex flex-col gap-2 sm:gap-3"
    >
      <div className="flex flex-col gap-2 sm:gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">Wallet balance</p>
          <p className="flex items-baseline gap-2 min-w-0">
            <span className="text-sm font-medium text-muted-foreground">GHS</span>
            <span
              className="text-2xl sm:text-3xl font-bold tabular-nums truncate"
              aria-busy={loading}
            >
              {loading ? '—' : shown}
            </span>
          </p>
        </div>
        <Link
          href={TOP_UP_HREF}
          className={`inline-flex h-11 items-center justify-center rounded-xl bg-ft-blue px-5 text-sm font-semibold text-white hover:bg-ft-blue/90 sm:shrink-0 ${FOCUS_RING}`}
        >
          Top up
        </Link>
      </div>

      {isLowBalance(balance) && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-amber-50 p-2 text-sm text-amber-800 dark:bg-amber-900/20 dark:text-amber-200"
        >
          <span>Your balance is low. Top up to keep buying.</span>
          <Link
            href={TOP_UP_HREF}
            className={`inline-flex min-h-11 items-center font-semibold underline underline-offset-2 rounded-sm ${FOCUS_RING}`}
          >
            Top up
          </Link>
        </div>
      )}
    </section>
  )
}
