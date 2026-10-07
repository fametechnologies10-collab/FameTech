'use client'

import { useState, useEffect } from 'react'
import {
    Sheet,
    SheetContent,
    SheetHeader,
    SheetTitle,
    SheetClose,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import {
    Copy,
    Check,
    X,
    Mail,
    Phone,
    Banknote,
    Clock,
    CheckCircle2,
    AlertCircle,
    XCircle,
    RotateCcw,
    Loader2,
    User,
    Store,
    Landmark,
    Smartphone,
} from 'lucide-react'
import type { WithdrawalRow } from './types'

// ─── helpers ────────────────────────────────────────────────────────────────

// Only pending and failed withdrawals are refundable.
// In-flight (moolre_pending / paystack_pending) and completed/reversed rows must
// never show the Reject & Refund button — the provider may still pay out.
const REFUNDABLE_STATUSES: WithdrawalRow['status'][] = ['pending', 'failed']

function statusLabel(status: WithdrawalRow['status']): string {
    const map: Record<WithdrawalRow['status'], string> = {
        pending: 'Pending',
        moolre_pending: 'Moolre Pending',
        paystack_pending: 'Paystack Pending',
        completed: 'Completed',
        failed: 'Failed',
        reversed: 'Reversed / Refunded',
    }
    return map[status] ?? status
}

function StatusDot({ status }: { status: WithdrawalRow['status'] }) {
    const cls = cn(
        'w-3 h-3 rounded-full flex-shrink-0 mt-0.5',
        status === 'completed' ? 'bg-emerald-500' :
        status === 'failed' || status === 'reversed' ? 'bg-red-500' :
        status === 'moolre_pending' || status === 'paystack_pending' ? 'bg-blue-500' :
        'bg-amber-500',
    )
    return <span className={cls} />
}

// ─── CopyButton ─────────────────────────────────────────────────────────────

function CopyButton({ value, label }: { value: string; label?: string }) {
    const [copied, setCopied] = useState(false)

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(value)
            setCopied(true)
            toast.success(label ? `Copied ${label}` : 'Copied')
            setTimeout(() => setCopied(false), 1500)
        } catch {
            toast.error('Could not copy — please copy manually')
        }
    }

    return (
        <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 hover:opacity-70 transition-opacity"
            title={`Copy ${label ?? value}`}
        >
            {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
    )
}

// ─── InfoRow ─────────────────────────────────────────────────────────────────

function InfoRow({
    label,
    children,
    className,
}: {
    label: string
    children: React.ReactNode
    className?: string
}) {
    return (
        <div className={cn('flex justify-between items-start gap-3 py-2', className)}>
            <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground flex-shrink-0">
                {label}
            </span>
            <span className="text-sm font-medium text-right break-all">{children}</span>
        </div>
    )
}

// ─── Timeline ────────────────────────────────────────────────────────────────

interface TimelineStep {
    icon: React.ReactNode
    label: string
    time: string | null
    detail?: string | null
    active: boolean
    variant: 'done' | 'active' | 'pending' | 'error'
}

function Timeline({ steps }: { steps: TimelineStep[] }) {
    return (
        <ol className="space-y-0">
            {steps.map((step, i) => (
                <li key={i} className="flex gap-3">
                    {/* spine */}
                    <div className="flex flex-col items-center">
                        <div
                            className={cn(
                                'w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 border-2',
                                step.variant === 'done' ? 'bg-emerald-500 border-emerald-500 text-white' :
                                step.variant === 'active' ? 'bg-blue-500 border-blue-500 text-white' :
                                step.variant === 'error' ? 'bg-red-500 border-red-500 text-white' :
                                'bg-muted border-border text-muted-foreground',
                            )}
                        >
                            <span className="w-3.5 h-3.5 [&>svg]:w-3.5 [&>svg]:h-3.5">{step.icon}</span>
                        </div>
                        {i < steps.length - 1 && (
                            <div
                                className={cn(
                                    'w-0.5 flex-1 min-h-[20px]',
                                    step.variant === 'done' ? 'bg-emerald-300 dark:bg-emerald-700' : 'bg-border',
                                )}
                            />
                        )}
                    </div>
                    {/* content */}
                    <div className="pb-5 flex-1 min-w-0">
                        <p
                            className={cn(
                                'text-sm font-semibold',
                                step.variant === 'pending' ? 'text-muted-foreground' : '',
                            )}
                        >
                            {step.label}
                        </p>
                        {step.time && (
                            <p className="text-[11px] text-muted-foreground mt-0.5">{step.time}</p>
                        )}
                        {step.detail && (
                            <p className="text-[11px] text-muted-foreground mt-0.5 break-all">{step.detail}</p>
                        )}
                    </div>
                </li>
            ))}
        </ol>
    )
}

// ─── Main component ──────────────────────────────────────────────────────────

export interface WithdrawalDetailSheetProps {
    row: WithdrawalRow | null
    open: boolean
    onOpenChange: (o: boolean) => void
    processOne: (
        id: string,
        action: 'paystack' | 'manual' | 'refund',
        note?: string,
    ) => Promise<any>
}

export function WithdrawalDetailSheet({
    row,
    open,
    onOpenChange,
    processOne,
}: WithdrawalDetailSheetProps) {
    const [showRefundConfirm, setShowRefundConfirm] = useState(false)
    const [refundReason, setRefundReason] = useState('')
    const [refunding, setRefunding] = useState(false)

    // Reset local state when row changes
    useEffect(() => {
        if (row) {
            setShowRefundConfirm(false)
            setRefundReason('')
            setRefunding(false)
        }
    }, [row?.id])

    if (!row) {
        return (
            <Sheet open={open} onOpenChange={onOpenChange}>
                <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto" />
            </Sheet>
        )
    }

    const isBank = row.payment_type === 'bank'
    const accountDest = row.momo_number ?? row.account_number ?? ''
    const canRefund = REFUNDABLE_STATUSES.includes(row.status)

    // ── Timeline steps ──
    const timelineSteps: TimelineStep[] = []

    // Step 1: Requested
    timelineSteps.push({
        icon: <Clock />,
        label: 'Withdrawal Requested',
        time: formatDate(row.created_at),
        detail: row.description ?? null,
        active: true,
        variant: 'done',
    })

    // Step 2: Submitted to provider
    const isSubmitted =
        row.status === 'moolre_pending' ||
        row.status === 'paystack_pending' ||
        row.status === 'completed' ||
        row.status === 'failed' ||
        row.status === 'reversed'
    const submittedProvider = row.payout_provider
        ? row.payout_provider.charAt(0).toUpperCase() + row.payout_provider.slice(1)
        : null

    timelineSteps.push({
        icon: <Banknote />,
        label: isSubmitted
            ? `Submitted to ${submittedProvider ?? 'Provider'}`
            : 'Awaiting Submission',
        time: isSubmitted && row.processed_at ? formatDate(row.processed_at) : null,
        detail: row.processed_by ? `Admin: ${row.processed_by}` : null,
        active: isSubmitted,
        variant: isSubmitted ? 'done' : 'pending',
    })

    // Step 3: Final state
    if (row.status === 'completed') {
        timelineSteps.push({
            icon: <CheckCircle2 />,
            label: 'Payment Completed',
            time: row.processed_at ? formatDate(row.processed_at) : null,
            detail: null,
            active: true,
            variant: 'done',
        })
    } else if (row.status === 'failed') {
        timelineSteps.push({
            icon: <XCircle />,
            label: 'Payment Failed',
            time: row.processed_at ? formatDate(row.processed_at) : null,
            detail: row.failure_reason ?? null,
            active: true,
            variant: 'error',
        })
    } else if (row.status === 'reversed') {
        timelineSteps.push({
            icon: <RotateCcw />,
            label: 'Reversed / Refunded',
            time: row.processed_at ? formatDate(row.processed_at) : null,
            detail: row.failure_reason ?? null,
            active: true,
            variant: 'error',
        })
    } else if (row.status === 'moolre_pending' || row.status === 'paystack_pending') {
        timelineSteps.push({
            icon: <Loader2 />,
            label: 'Awaiting Network Confirmation',
            time: null,
            detail: 'Cron will resolve once provider responds.',
            active: false,
            variant: 'active',
        })
    } else {
        // pending
        timelineSteps.push({
            icon: <AlertCircle />,
            label: 'Not Yet Processed',
            time: null,
            detail: null,
            active: false,
            variant: 'pending',
        })
    }

    // ── Refund handler ──
    const handleRefund = async () => {
        if (refunding) return // double-fire guard
        if (!refundReason.trim()) {
            toast.error('A reason is required before refunding.')
            return
        }
        setRefunding(true)
        try {
            const result = await processOne(row.id, 'refund', refundReason.trim())
            if (result?.skipped) {
                toast.info('Already processing — please wait')
                setRefunding(false)
                return
            }
            toast.success('Withdrawal rejected and wallet refunded.')
            onOpenChange(false)
        } catch (e: any) {
            toast.error(e?.message ?? 'Refund failed')
            setRefunding(false)
        }
    }

    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent
                side="right"
                hideCloseButton
                className="w-full sm:max-w-lg flex flex-col overflow-hidden p-0"
            >
                {/* ── Header ── */}
                <div className="flex items-center justify-between px-5 py-4 border-b bg-muted/30 flex-shrink-0">
                    <SheetHeader className="flex-1 min-w-0">
                        <SheetTitle className="flex items-center gap-2 truncate">
                            <Banknote className="w-5 h-5 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
                            Withdrawal Detail
                        </SheetTitle>
                        <p className="text-xs text-muted-foreground font-mono truncate">{row.id}</p>
                    </SheetHeader>
                    <SheetClose asChild>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="w-9 h-9 rounded-full flex-shrink-0 ml-2"
                        >
                            <X className="w-4 h-4" />
                            <span className="sr-only">Close</span>
                        </Button>
                    </SheetClose>
                </div>

                {/* ── Scrollable body ── */}
                <div className="flex-1 overflow-y-auto px-5 py-4 space-y-6">

                    {/* ── Amount block ── */}
                    <div className="rounded-xl border p-4 bg-gradient-to-br from-emerald-50 to-emerald-100/50 dark:from-emerald-950/30 dark:to-emerald-900/10 border-emerald-200 dark:border-emerald-800/40">
                        <p className="text-[11px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
                            Net Payout
                        </p>
                        <p className="text-4xl font-black text-emerald-700 dark:text-emerald-400 tabular-nums mt-1">
                            {formatCurrency(row.net_amount ?? 0)}
                        </p>
                        <p className="text-xs text-emerald-600/70 dark:text-emerald-500/60 mt-1">
                            Gross {formatCurrency(row.amount)} · Fee {formatCurrency(row.fee ?? 0)}
                            {row.paystack_fee ? ` · Paystack ${formatCurrency(row.paystack_fee)}` : ''}
                        </p>
                    </div>

                    {/* ── Status badge ── */}
                    <div className="flex items-center gap-2">
                        <StatusDot status={row.status} />
                        <span className={cn(
                            'text-xs font-bold px-2.5 py-1 rounded-full uppercase tracking-wider',
                            row.status === 'completed'
                                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                                : row.status === 'failed' || row.status === 'reversed'
                                ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                                : row.status === 'moolre_pending' || row.status === 'paystack_pending'
                                ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                                : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
                        )}>
                            {statusLabel(row.status)}
                        </span>
                        {row.payout_provider && (
                            <span className="text-[11px] text-muted-foreground">
                                via {row.payout_provider}
                            </span>
                        )}
                    </div>

                    {/* ── Account block ── */}
                    <section>
                        <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-2">
                            {isBank ? 'Bank Account' : 'MoMo Account'}
                        </p>
                        <div className="rounded-xl border divide-y bg-background">
                            <InfoRow label="Account name">
                                <span className={cn(row.name_unverified && 'text-amber-600 dark:text-amber-400')}>
                                    {row.account_name ?? '—'}
                                    {row.name_unverified && (
                                        <span className="ml-1.5 text-[10px] font-bold uppercase bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 px-1.5 py-0.5 rounded">
                                            Unverified
                                        </span>
                                    )}
                                </span>
                            </InfoRow>
                            <InfoRow label={isBank ? 'Account no.' : 'MoMo number'}>
                                <span className="flex items-center gap-1.5 justify-end font-mono">
                                    {accountDest || '—'}
                                    {accountDest && <CopyButton value={accountDest} label={isBank ? 'account number' : 'MoMo number'} />}
                                </span>
                            </InfoRow>
                            {isBank && (
                                <>
                                    <InfoRow label="Bank">{row.bank_name ?? '—'}</InfoRow>
                                    {row.branch && <InfoRow label="Branch">{row.branch}</InfoRow>}
                                </>
                            )}
                            {!isBank && row.network && (
                                <InfoRow label="Network">
                                    <span className="flex items-center gap-1">
                                        <Smartphone className="w-3 h-3" />
                                        {row.network}
                                    </span>
                                </InfoRow>
                            )}
                            <InfoRow label="Type">
                                <span className="flex items-center gap-1">
                                    {isBank ? <Landmark className="w-3 h-3" /> : <Smartphone className="w-3 h-3" />}
                                    {isBank ? 'Bank Transfer' : 'MoMo'}
                                </span>
                            </InfoRow>
                        </div>
                    </section>

                    {/* ── Provider references ── */}
                    {(row.moolre_transaction_id || row.paystack_transfer_code || row.paystack_transfer_reference) && (
                        <section>
                            <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-2">
                                Provider References
                            </p>
                            <div className="rounded-xl border divide-y bg-background">
                                {row.moolre_transaction_id && (
                                    <InfoRow label="Moolre ID">
                                        <span className="flex items-center gap-1.5 justify-end font-mono text-xs">
                                            {row.moolre_transaction_id}
                                            <CopyButton value={row.moolre_transaction_id} label="Moolre ID" />
                                        </span>
                                    </InfoRow>
                                )}
                                {row.paystack_transfer_code && (
                                    <InfoRow label="Paystack Code">
                                        <span className="flex items-center gap-1.5 justify-end font-mono text-xs">
                                            {row.paystack_transfer_code}
                                            <CopyButton value={row.paystack_transfer_code} label="Paystack transfer code" />
                                        </span>
                                    </InfoRow>
                                )}
                                {row.paystack_transfer_reference && (
                                    <InfoRow label="Paystack Ref">
                                        <span className="flex items-center gap-1.5 justify-end font-mono text-xs">
                                            {row.paystack_transfer_reference}
                                            <CopyButton value={row.paystack_transfer_reference} label="Paystack reference" />
                                        </span>
                                    </InfoRow>
                                )}
                                {row.paystack_transfer_status && (
                                    <InfoRow label="PS Transfer Status">
                                        <span className="font-mono text-xs">{row.paystack_transfer_status}</span>
                                    </InfoRow>
                                )}
                            </div>
                        </section>
                    )}

                    {/* ── Balance snapshot ──
                        balance_snapshot stores the wallet balance AFTER the deduction
                        (RPC: v_new_balance = current - amount). "Balance at Request" is
                        what the owner HAD when requesting = snapshot + gross amount. */}
                    {row.balance_snapshot != null && (
                        <section>
                            <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-2">
                                Balance at Request
                            </p>
                            <div className="rounded-xl border bg-background px-4 py-2">
                                <p className="text-sm font-bold tabular-nums">
                                    {formatCurrency((row.balance_snapshot ?? 0) + (row.amount ?? 0))}
                                </p>
                                <p className="text-[11px] text-muted-foreground tabular-nums mt-0.5">
                                    Remaining after payout: {formatCurrency(row.balance_snapshot ?? 0)}
                                </p>
                            </div>
                        </section>
                    )}

                    {/* ── Failure reason ── */}
                    {row.failure_reason && (
                        <div className="rounded-xl border border-red-200 dark:border-red-800/40 bg-red-50 dark:bg-red-950/20 p-4">
                            <p className="text-[11px] font-bold uppercase tracking-wider text-red-600 dark:text-red-400 mb-1">
                                Failure Reason
                            </p>
                            <p className="text-sm text-red-700 dark:text-red-300">{row.failure_reason}</p>
                        </div>
                    )}

                    {/* ── Shop owner ── */}
                    <section>
                        <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-2">
                            Shop Owner
                        </p>
                        <div className="rounded-xl border divide-y bg-background">
                            <InfoRow label="Shop">
                                <span className="flex items-center gap-1">
                                    <Store className="w-3 h-3 flex-shrink-0" />
                                    {row.shop.shop_name}
                                </span>
                            </InfoRow>
                            <InfoRow label="Name">
                                <span className="flex items-center gap-1">
                                    <User className="w-3 h-3 flex-shrink-0" />
                                    {row.shop.owner_name}
                                </span>
                            </InfoRow>
                            <InfoRow label="Email">
                                <span className="flex items-center gap-1.5 justify-end">
                                    <a
                                        href={`mailto:${row.shop.owner_email}`}
                                        className="text-emerald-600 dark:text-emerald-400 hover:underline flex items-center gap-1"
                                    >
                                        <Mail className="w-3 h-3 flex-shrink-0" />
                                        {row.shop.owner_email}
                                    </a>
                                </span>
                            </InfoRow>
                            <InfoRow label="Phone">
                                <span className="flex items-center gap-1.5 justify-end">
                                    <Phone className="w-3 h-3 flex-shrink-0" />
                                    {row.shop.owner_phone}
                                    {row.shop.owner_phone && (
                                        <CopyButton value={row.shop.owner_phone} label="phone" />
                                    )}
                                </span>
                            </InfoRow>
                        </div>
                    </section>

                    {/* ── Status timeline ── */}
                    <section>
                        <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-3">
                            Status Timeline
                        </p>
                        <Timeline steps={timelineSteps} />
                    </section>

                    {/* ── Reject & Refund ── */}
                    {canRefund && (
                        <section className="pb-4">
                            {!showRefundConfirm ? (
                                <Button
                                    variant="outline"
                                    className="w-full border-red-300 dark:border-red-700 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 font-bold"
                                    onClick={() => setShowRefundConfirm(true)}
                                >
                                    <XCircle className="w-4 h-4 mr-2" />
                                    Reject &amp; Refund to Wallet
                                </Button>
                            ) : (
                                <div className="rounded-xl border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950/20 p-4 space-y-3">
                                    <div className="flex items-start gap-2">
                                        <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
                                        <p className="text-sm font-semibold text-red-700 dark:text-red-300">
                                            Confirm rejection &amp; refund
                                        </p>
                                    </div>
                                    <p className="text-xs text-red-600 dark:text-red-400">
                                        This will mark the withdrawal as reversed and return{' '}
                                        <strong>{formatCurrency(row.amount)}</strong> to the shop wallet.
                                        A reason is required.
                                    </p>
                                    <textarea
                                        value={refundReason}
                                        onChange={e => setRefundReason(e.target.value)}
                                        placeholder="Reason for rejection (required)…"
                                        rows={3}
                                        disabled={refunding}
                                        className={cn(
                                            'w-full rounded-lg border bg-background px-3 py-2 text-sm',
                                            'placeholder:text-muted-foreground resize-none',
                                            'focus:outline-none focus:ring-2 focus:ring-red-400 dark:focus:ring-red-600',
                                            'disabled:opacity-50',
                                            !refundReason.trim() && 'border-red-300 dark:border-red-700',
                                        )}
                                    />
                                    <div className="flex gap-2">
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="flex-1"
                                            disabled={refunding}
                                            onClick={() => {
                                                setShowRefundConfirm(false)
                                                setRefundReason('')
                                            }}
                                        >
                                            Cancel
                                        </Button>
                                        <Button
                                            size="sm"
                                            disabled={refunding || !refundReason.trim()}
                                            onClick={handleRefund}
                                            className="flex-1 bg-red-600 hover:bg-red-700 text-white font-bold gap-1.5"
                                        >
                                            {refunding
                                                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                : <XCircle className="w-3.5 h-3.5" />}
                                            {refunding ? 'Refunding…' : 'Confirm Refund'}
                                        </Button>
                                    </div>
                                </div>
                            )}
                        </section>
                    )}
                </div>
            </SheetContent>
        </Sheet>
    )
}
