'use client'

import { Loader2, X, Landmark, CreditCard } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatCurrency, cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import type { WithdrawalRow } from './types'

// Moolre payouts retired 2026-09-26 — Paystack (MoMo) + manual only.
const SUCCESS_STATUSES = new Set(['completed', 'paystack_pending'])

interface BulkActionBarProps {
  selectedIds: string[]
  rows: WithdrawalRow[]
  onClear(): void
  processBulk: (
    ids: string[],
    action: 'paystack' | 'manual',
    note?: string,
  ) => Promise<any>
  busy: boolean
}

export function BulkActionBar({
  selectedIds,
  rows,
  onClear,
  processBulk,
  busy,
}: BulkActionBarProps) {
  if (selectedIds.length === 0) return null

  // Build lookup map for O(1) access
  const rowMap = new Map(rows.map((r) => [r.id, r]))
  const selectedRows = selectedIds.map((id) => rowMap.get(id)).filter(Boolean) as WithdrawalRow[]

  const total = selectedRows.reduce((sum, r) => sum + (r.net_amount ?? 0), 0)
  const hasBank = selectedRows.some((r) => r.payment_type === 'bank')

  const handle = async (action: 'paystack' | 'manual') => {
    try {
      const res = await processBulk(selectedIds, action)

      if (res?.skipped) {
        toast.info('Already processing — please wait')
        return
      }

      const results: Array<{ transactionId?: string; status?: string; error?: string }> =
        res?.results ?? []

      const successes = results.filter(
        (r) => SUCCESS_STATUSES.has(r.status ?? '') && !r.error,
      ).length
      const failures = results.filter(
        (r) => !SUCCESS_STATUSES.has(r.status ?? '') || r.error,
      ).length

      if (failures === 0) {
        toast.success(`${successes} paid/queued successfully`)
      } else if (successes === 0) {
        toast.error(`All ${failures} payouts failed`)
      } else {
        toast.info(`${successes} paid/queued, ${failures} failed`)
      }

      onClear()
    } catch (e: any) {
      toast.error(e?.message ?? 'Bulk payout failed')
    }
  }

  return (
    <div
      className={cn(
        'fixed bottom-4 left-1/2 -translate-x-1/2 z-50',
        'w-[calc(100%-2rem)] max-w-3xl',
        'flex flex-wrap items-center gap-3',
        'rounded-xl shadow-lg border',
        'bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-700',
        'px-4 py-3',
      )}
    >
      {/* Selection summary */}
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <button
          onClick={onClear}
          aria-label="Clear selection"
          className="flex-shrink-0 rounded-full w-6 h-6 flex items-center justify-center text-muted-foreground hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
        <span className="text-sm font-semibold whitespace-nowrap">
          {selectedIds.length} selected
        </span>
        <span className="text-xs text-muted-foreground hidden sm:inline">·</span>
        <span className="text-sm font-bold text-emerald-600 dark:text-emerald-400 whitespace-nowrap hidden sm:inline">
          Total payout {formatCurrency(total)}
        </span>
      </div>

      {/* Total on mobile (below summary row) */}
      <div className="w-full sm:hidden text-xs text-muted-foreground -mt-1 pl-8">
        Total payout{' '}
        <span className="font-bold text-emerald-600 dark:text-emerald-400">
          {formatCurrency(total)}
        </span>
      </div>

      {/* Action buttons */}
      <div className="flex flex-wrap gap-2">
        <div className="relative group">
          <Button
            size="sm"
            disabled={busy || hasBank}
            onClick={() => handle('paystack')}
            className={cn(
              'font-bold gap-1.5 rounded-lg',
              hasBank
                ? 'bg-zinc-200 dark:bg-zinc-700 text-zinc-400 dark:text-zinc-500 cursor-not-allowed'
                : 'bg-indigo-600 hover:bg-indigo-700 text-white',
            )}
          >
            {busy ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <CreditCard className="w-3.5 h-3.5" />
            )}
            Pay all via Paystack
            {hasBank && (
              <span className="ml-1 text-[10px] font-normal opacity-70">(MoMo only)</span>
            )}
          </Button>
          {hasBank && (
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 rounded-lg bg-zinc-800 dark:bg-zinc-700 text-white text-xs whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-50">
              Paystack supports MoMo only — selection includes bank accounts
            </div>
          )}
        </div>

        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => handle('manual')}
          className="font-bold gap-1.5 rounded-lg border-zinc-300 dark:border-zinc-600"
        >
          {busy ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Landmark className="w-3.5 h-3.5" />
          )}
          Mark all paid manually
        </Button>
      </div>
    </div>
  )
}
