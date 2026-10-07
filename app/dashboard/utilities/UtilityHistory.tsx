'use client'

/**
 * UtilityHistory — Recent Payments list with a per-order 3-step mini timeline:
 * Paid → Sending to {biller} → Delivered.
 *
 *  - completed          → 3/3 all green
 *  - pending/processing → 2/3 with an animated middle step
 *  - failed / refunded  → distinct terminal styling (red X / purple refund)
 *
 * Status chip colors come from lib/order-status.ts — the single source of truth.
 */

import { Check, Loader2, ReceiptText, RefreshCw, WifiOff, X } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { cn } from '@/lib/utils'
import { getStatusBadgeClass, getStatusLabel } from '@/lib/order-status'
import { UTILITY_BILLERS } from '@/lib/hubtel-utility/billers'
import { BILLER_UI } from './biller-ui'
import { UtilityBillerLogo } from '@/components/utility-biller-logo'
import type { UtilityOrderRow } from './types'

/** Short biller name for the timeline's middle step ("Sending to ECG"). */
function shortBillerName(biller: UtilityOrderRow['biller']): string {
    switch (biller) {
        case 'ecg': return 'ECG'
        case 'ghana_water': return 'Ghana Water'
        case 'startimes': return 'StarTimes'
        default: return UTILITY_BILLERS[biller]?.label ?? biller
    }
}

type StepState = 'done' | 'active' | 'idle' | 'failed' | 'refunded'

function stepStates(status: string): [StepState, StepState, StepState] {
    switch (status) {
        case 'completed': return ['done', 'done', 'done']
        case 'failed': return ['done', 'failed', 'idle']
        case 'refunded': return ['done', 'refunded', 'idle']
        default: return ['done', 'active', 'idle'] // pending / processing
    }
}

function StepDot({ state }: { state: StepState }) {
    if (state === 'done') {
        return (
            <span className="w-4 h-4 rounded-full bg-green-500 flex items-center justify-center shrink-0">
                <Check className="w-2.5 h-2.5 text-white" strokeWidth={3} />
            </span>
        )
    }
    if (state === 'active') {
        return (
            <span className="w-4 h-4 rounded-full bg-blue-100 dark:bg-blue-950/60 flex items-center justify-center shrink-0">
                <Loader2 className="w-2.5 h-2.5 text-blue-600 dark:text-blue-400 animate-spin" />
            </span>
        )
    }
    if (state === 'failed') {
        return (
            <span className="w-4 h-4 rounded-full bg-red-500 flex items-center justify-center shrink-0">
                <X className="w-2.5 h-2.5 text-white" strokeWidth={3} />
            </span>
        )
    }
    if (state === 'refunded') {
        return (
            <span className="w-4 h-4 rounded-full bg-purple-500 flex items-center justify-center shrink-0">
                <RefreshCw className="w-2.5 h-2.5 text-white" strokeWidth={3} />
            </span>
        )
    }
    return <span className="w-4 h-4 rounded-full border-2 border-slate-200 dark:border-slate-700 shrink-0" />
}

function MiniTimeline({ order }: { order: UtilityOrderRow }) {
    const [s1, s2, s3] = stepStates(order.status)
    const steps: Array<{ label: string; state: StepState }> = [
        { label: 'Paid', state: s1 },
        {
            label: order.status === 'refunded' ? 'Refunded to wallet' : `Sending to ${shortBillerName(order.biller)}`,
            state: s2,
        },
        { label: 'Delivered', state: s3 },
    ]
    return (
        <div className="flex items-center gap-1.5 mt-2.5">
            {steps.map((step, i) => (
                <div key={step.label} className="flex items-center gap-1.5 min-w-0">
                    {i > 0 && (
                        <span
                            className={cn(
                                'h-0.5 w-4 sm:w-6 rounded-full shrink-0',
                                step.state === 'done' || step.state === 'active' || step.state === 'failed' || step.state === 'refunded'
                                    ? 'bg-slate-300 dark:bg-slate-600'
                                    : 'bg-slate-200 dark:bg-slate-800'
                            )}
                        />
                    )}
                    <StepDot state={step.state} />
                    <span
                        className={cn(
                            'text-[10px] leading-none truncate',
                            step.state === 'done' && 'text-green-600 dark:text-green-400 font-medium',
                            step.state === 'active' && 'text-blue-600 dark:text-blue-400 font-medium animate-pulse',
                            step.state === 'failed' && 'text-red-600 dark:text-red-400 font-medium',
                            step.state === 'refunded' && 'text-purple-600 dark:text-purple-400 font-medium',
                            step.state === 'idle' && 'text-slate-400 dark:text-slate-500'
                        )}
                    >
                        {step.label}
                    </span>
                </div>
            ))}
        </div>
    )
}

interface UtilityHistoryProps {
    orders: UtilityOrderRow[]
    loading: boolean
    error: boolean
    onRetry: () => void
}

export function UtilityHistory({ orders, loading, error, onRetry }: UtilityHistoryProps) {
    if (loading) {
        return (
            <div className="space-y-2.5">
                {[0, 1, 2].map((i) => (
                    <div key={i} className="rounded-2xl border border-border bg-card p-4 animate-pulse">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-xl bg-muted" />
                            <div className="flex-1 space-y-2">
                                <div className="h-3.5 w-2/5 rounded bg-muted" />
                                <div className="h-3 w-3/5 rounded bg-muted" />
                            </div>
                            <div className="h-5 w-16 rounded-full bg-muted" />
                        </div>
                    </div>
                ))}
            </div>
        )
    }

    if (error) {
        return (
            <div className="rounded-2xl border border-border bg-card p-6 flex flex-col items-center gap-3 text-center">
                <WifiOff className="w-8 h-8 text-muted-foreground/50" />
                <p className="text-sm text-muted-foreground">Could not load your payments.</p>
                <button
                    type="button"
                    onClick={onRetry}
                    className="text-sm font-semibold text-foreground hover:underline inline-flex items-center gap-1.5"
                >
                    <RefreshCw className="w-3.5 h-3.5" /> Try again
                </button>
            </div>
        )
    }

    if (orders.length === 0) {
        return (
            <div className="rounded-2xl border border-dashed border-border p-8 flex flex-col items-center gap-2.5 text-center">
                <ReceiptText className="w-8 h-8 text-muted-foreground/40" />
                <p className="text-sm font-medium text-foreground">No bills paid yet</p>
                <p className="text-xs text-muted-foreground max-w-[240px]">
                    Your ECG, water and TV payments will appear here with live delivery status.
                </p>
            </div>
        )
    }

    return (
        <div className="space-y-2.5">
            {orders.map((order) => {
                const ui = BILLER_UI[order.biller]
                return (
                    <div key={order.id} className="rounded-2xl border border-border bg-card p-4 shadow-sm">
                        <div className="flex items-center gap-3">
                            {ui ? (
                                <UtilityBillerLogo biller={order.biller} FallbackIcon={ui.Icon} badgeClassName={ui.badge} size={40} />
                            ) : (
                                <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 bg-muted text-muted-foreground">
                                    <ReceiptText className="w-5 h-5" />
                                </div>
                            )}
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-semibold truncate">
                                    {order.account_name || shortBillerName(order.biller)}
                                </p>
                                <p className="text-xs text-muted-foreground truncate">
                                    <span className="font-mono">{order.account_number}</span>
                                    {' · '}
                                    {formatDistanceToNow(new Date(order.created_at), { addSuffix: true })}
                                </p>
                            </div>
                            <div className="shrink-0 flex flex-col items-end gap-1">
                                <span className="text-sm font-bold tabular-nums">GHS {Number(order.amount).toFixed(2)}</span>
                                <span className={cn('inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium', getStatusBadgeClass(order.status))}>
                                    {getStatusLabel(order.status)}
                                </span>
                            </div>
                        </div>
                        <MiniTimeline order={order} />
                    </div>
                )
            })}
        </div>
    )
}
