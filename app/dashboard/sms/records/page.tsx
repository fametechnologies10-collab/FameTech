'use client'

/**
 * /dashboard/sms/records — KFT SMS campaign records list.
 * Moolre/mNotify-style history: status filter pills, color-coded status chips,
 * message preview, recipients/credits/date meta, source icon (dashboard vs API),
 * pagination, row click → detail, and cancel (with Dialog confirm — never
 * native confirm) on queued campaigns only.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
    Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { toast } from '@/lib/toast'
import {
    History, ArrowLeft, RefreshCcw, Loader2, ChevronRight, ChevronLeft,
    LayoutDashboard, Code2, XCircle, AlertCircle, Send, Flag, CalendarClock,
} from 'lucide-react'

// ── Types ────────────────────────────────────────────────────────────────────

type CampaignStatus = 'queued' | 'processing' | 'completed' | 'partial' | 'failed' | 'blocked' | 'cancelled'

interface Campaign {
    id: string
    sender_used: string | null
    mode_at_send: 'platform' | 'business'
    message: string
    recipients_count: number
    segments: number
    credits_charged: number
    status: CampaignStatus
    flagged: boolean
    scheduled_at: string | null
    source: 'dashboard' | 'api'
    created_at: string
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null | undefined): string {
    if (!iso) return '—'
    const d = new Date(iso)
    if (isNaN(d.getTime())) return '—'
    const sameYear = d.getFullYear() === new Date().getFullYear()
    return d.toLocaleDateString('en-GH', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })
        + ', ' + d.toLocaleTimeString('en-GH', { hour: '2-digit', minute: '2-digit' })
}

interface ChipStyle { label: string; cls: string; pulse?: boolean }

const CAMPAIGN_CHIP: Record<string, ChipStyle> = {
    queued:     { label: 'Queued',     cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/25 dark:text-blue-400', pulse: true },
    processing: { label: 'Processing', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/25 dark:text-blue-400', pulse: true },
    completed:  { label: 'Completed',  cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/25 dark:text-emerald-400' },
    partial:    { label: 'Partial',    cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/25 dark:text-amber-400' },
    failed:     { label: 'Failed',     cls: 'bg-red-100 text-red-700 dark:bg-red-900/25 dark:text-red-400' },
    blocked:    { label: 'Blocked',    cls: 'bg-red-100 text-red-700 dark:bg-red-900/25 dark:text-red-400' },
    cancelled:  { label: 'Cancelled',  cls: 'bg-muted text-muted-foreground' },
}

function StatusChip({ status }: { status: string }) {
    const chip = CAMPAIGN_CHIP[status] ?? { label: status, cls: 'bg-muted text-muted-foreground' }
    return (
        <span className={cn('inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap', chip.cls)}>
            {chip.pulse && <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />}
            {chip.label}
        </span>
    )
}

const FILTERS: Array<{ value: string; label: string }> = [
    { value: '',           label: 'All' },
    { value: 'queued',     label: 'Queued' },
    { value: 'processing', label: 'Processing' },
    { value: 'completed',  label: 'Completed' },
    { value: 'partial',    label: 'Partial' },
    { value: 'failed',     label: 'Failed' },
    { value: 'blocked',    label: 'Blocked' },
    { value: 'cancelled',  label: 'Cancelled' },
]

const PAGE_SIZE = 20

// ── Component ─────────────────────────────────────────────────────────────────

export default function SmsRecordsPage() {
    const router = useRouter()

    const [campaigns, setCampaigns] = useState<Campaign[] | null>(null)
    const [total, setTotal] = useState(0)
    const [page, setPage] = useState(0)
    const [statusFilter, setStatusFilter] = useState('')
    const [fetching, setFetching] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const [cancelTarget, setCancelTarget] = useState<Campaign | null>(null)
    const [cancelling, setCancelling] = useState(false)
    const [cancelError, setCancelError] = useState<string | null>(null)

    const fetchCampaigns = useCallback(async () => {
        setFetching(true)
        setError(null)
        try {
            const qs = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) })
            if (statusFilter) qs.set('status', statusFilter)
            const res = await fetch(`/api/sms/campaigns?${qs.toString()}`)
            const json = await res.json().catch(() => null)
            if (!json?.success) throw new Error(json?.error || 'Failed to load campaign records')
            setCampaigns(json.data.campaigns as Campaign[])
            setTotal(json.data.total ?? 0)
        } catch (err: any) {
            console.error('[SMS Records]', err)
            setError(err?.message || 'Failed to load campaign records')
        } finally {
            setFetching(false)
        }
    }, [page, statusFilter])

    useEffect(() => { fetchCampaigns() }, [fetchCampaigns])

    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

    const changeFilter = (value: string) => {
        setStatusFilter(value)
        setPage(0)
    }

    const handleCancel = async () => {
        if (!cancelTarget) return
        setCancelling(true)
        setCancelError(null)
        try {
            const res = await fetch(`/api/sms/campaigns/${cancelTarget.id}`, { method: 'DELETE' })
            const json = await res.json().catch(() => null)
            if (!json?.success) throw new Error(json?.error || 'Could not cancel campaign')
            toast.success(`Campaign cancelled — ${(json.data?.refunded_credits ?? 0).toLocaleString()} credit(s) refunded`)
            setCancelTarget(null)
            await fetchCampaigns()
        } catch (err: any) {
            const msg = err?.message || 'Could not cancel campaign'
            setCancelError(msg)
            toast.error(msg)
        } finally {
            setCancelling(false)
        }
    }

    const initialLoading = campaigns === null && fetching

    return (
        <div className="space-y-4 pb-20 md:pb-6 max-w-2xl mx-auto">

            {/* ── Header ── */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                    <Link href="/dashboard/sms">
                        <Button variant="ghost" size="sm" className="w-fit gap-2 -ml-2 text-muted-foreground hover:text-emerald-600">
                            <ArrowLeft className="w-4 h-4" /> SMS Platform
                        </Button>
                    </Link>
                    <h1 className="text-xl font-bold flex items-center gap-2 mt-1">
                        <History className="w-5 h-5 text-emerald-600" /> Campaign Records
                    </h1>
                    <p className="text-muted-foreground text-sm mt-0.5">Every send, its cost and delivery outcome.</p>
                </div>
                <Button variant="outline" size="sm" onClick={fetchCampaigns} disabled={fetching} className="gap-1.5 w-fit shrink-0 h-10">
                    {fetching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCcw className="w-3.5 h-3.5" />} Refresh
                </Button>
            </div>

            {/* ── Status filter pills ── */}
            <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
                {FILTERS.map(f => (
                    <button
                        key={f.value}
                        type="button"
                        onClick={() => changeFilter(f.value)}
                        className={cn(
                            'h-10 px-3.5 rounded-full text-xs font-semibold whitespace-nowrap transition-colors border shrink-0',
                            statusFilter === f.value
                                ? 'bg-emerald-600 text-white border-emerald-600 shadow-sm'
                                : 'bg-background text-muted-foreground border-border hover:text-foreground hover:bg-muted/60',
                        )}
                    >
                        {f.label}
                    </button>
                ))}
            </div>

            {/* ── Body ── */}
            {initialLoading ? (
                <div className="space-y-2.5">
                    {Array.from({ length: 5 }).map((_, i) => (
                        <Skeleton key={i} className="h-24 w-full rounded-2xl" />
                    ))}
                </div>
            ) : error ? (
                <div className="text-center py-16 space-y-3">
                    <AlertCircle className="w-8 h-8 text-red-500 mx-auto" />
                    <p className="text-sm text-muted-foreground">{error}</p>
                    <Button variant="outline" onClick={fetchCampaigns} className="gap-2 h-10">
                        <RefreshCcw className="w-4 h-4" /> Retry
                    </Button>
                </div>
            ) : !campaigns || campaigns.length === 0 ? (
                <div className="text-center py-16 space-y-3">
                    <div className="w-14 h-14 mx-auto rounded-full bg-muted flex items-center justify-center">
                        <History className="w-6 h-6 text-muted-foreground" />
                    </div>
                    <p className="font-semibold text-sm">
                        {statusFilter ? `No ${statusFilter} campaigns` : 'No campaigns yet'}
                    </p>
                    <p className="text-xs text-muted-foreground">
                        {statusFilter ? 'Try a different filter.' : 'Your sent campaigns will appear here.'}
                    </p>
                    {!statusFilter && (
                        <Link href="/dashboard/sms/compose">
                            <Button className="gap-2 h-10 bg-emerald-600 hover:bg-emerald-700 text-white mt-1">
                                <Send className="w-4 h-4" /> Send your first SMS
                            </Button>
                        </Link>
                    )}
                </div>
            ) : (
                <div className={cn('space-y-2.5 transition-opacity', fetching && 'opacity-60 pointer-events-none')}>
                    {campaigns.map(c => {
                        const SourceIcon = c.source === 'api' ? Code2 : LayoutDashboard
                        return (
                            <Card
                                key={c.id}
                                role="button"
                                tabIndex={0}
                                onClick={() => router.push(`/dashboard/sms/records/${c.id}`)}
                                onKeyDown={e => { if (e.key === 'Enter') router.push(`/dashboard/sms/records/${c.id}`) }}
                                className="rounded-2xl border shadow-sm cursor-pointer transition-colors hover:border-emerald-300 dark:hover:border-emerald-800 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                                <CardContent className="p-4">
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-1.5 flex-wrap">
                                                <StatusChip status={c.status} />
                                                {c.flagged && (
                                                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/25 dark:text-amber-400">
                                                        <Flag className="w-2.5 h-2.5" /> Flagged
                                                    </span>
                                                )}
                                                {c.scheduled_at && c.status === 'queued' && (
                                                    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-muted-foreground">
                                                        <CalendarClock className="w-3 h-3" /> {fmtDate(c.scheduled_at)}
                                                    </span>
                                                )}
                                            </div>
                                            <p className="text-xs font-medium mt-1.5 line-clamp-2 break-words">{c.message}</p>
                                            <p className="text-[11px] text-muted-foreground mt-1.5 tabular-nums">
                                                {c.recipients_count.toLocaleString()} recipient{c.recipients_count === 1 ? '' : 's'}
                                                {' · '}{c.segments} SMS
                                                {' · '}{c.credits_charged.toLocaleString()} credit{c.credits_charged === 1 ? '' : 's'}
                                                {' · '}{fmtDate(c.created_at)}
                                            </p>
                                        </div>
                                        <div className="flex flex-col items-end gap-2 shrink-0">
                                            <span
                                                className="inline-flex items-center gap-1 text-[10px] font-medium text-muted-foreground"
                                                title={c.source === 'api' ? 'Sent via developer API' : 'Sent from dashboard'}
                                            >
                                                <SourceIcon className="w-3.5 h-3.5" />
                                                {c.source === 'api' ? 'API' : 'Dashboard'}
                                            </span>
                                            <ChevronRight className="w-4 h-4 text-muted-foreground/50" />
                                        </div>
                                    </div>

                                    {c.status === 'queued' && (
                                        <div className="mt-3 pt-3 border-t flex justify-end">
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                className="h-10 text-xs gap-1.5 text-red-500 hover:text-red-600 border-red-200 dark:border-red-900 hover:bg-red-50 dark:hover:bg-red-950/20"
                                                onClick={e => { e.stopPropagation(); setCancelError(null); setCancelTarget(c) }}
                                            >
                                                <XCircle className="w-3.5 h-3.5" /> Cancel campaign
                                            </Button>
                                        </div>
                                    )}
                                </CardContent>
                            </Card>
                        )
                    })}
                </div>
            )}

            {/* ── Pagination ── */}
            {!initialLoading && !error && total > PAGE_SIZE && (
                <div className="flex items-center justify-between pt-1">
                    <Button
                        variant="outline"
                        size="sm"
                        className="h-10 gap-1.5"
                        disabled={page === 0 || fetching}
                        onClick={() => setPage(p => Math.max(0, p - 1))}
                    >
                        <ChevronLeft className="w-4 h-4" /> Prev
                    </Button>
                    <span className="text-xs text-muted-foreground tabular-nums">
                        Page {page + 1} of {totalPages} · {total.toLocaleString()} campaigns
                    </span>
                    <Button
                        variant="outline"
                        size="sm"
                        className="h-10 gap-1.5"
                        disabled={page + 1 >= totalPages || fetching}
                        onClick={() => setPage(p => p + 1)}
                    >
                        Next <ChevronRight className="w-4 h-4" />
                    </Button>
                </div>
            )}

            {/* ── Cancel confirmation dialog ── */}
            <Dialog open={!!cancelTarget} onOpenChange={open => { if (!open && !cancelling) { setCancelTarget(null); setCancelError(null) } }}>
                <DialogContent className="max-w-sm" aria-describedby={undefined}>
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <XCircle className="w-4 h-4 text-red-500" /> Cancel this campaign?
                        </DialogTitle>
                    </DialogHeader>
                    {cancelTarget && (
                        <div className="space-y-3">
                            <div className="rounded-xl border bg-muted/30 p-3">
                                <p className="text-xs text-foreground line-clamp-3 break-words">{cancelTarget.message}</p>
                            </div>
                            <div className="rounded-xl bg-muted/40 p-4 space-y-2 text-sm">
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">Recipients</span>
                                    <span className="font-semibold tabular-nums">{cancelTarget.recipients_count.toLocaleString()}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">Credits to refund</span>
                                    <span className="font-bold text-emerald-600 tabular-nums">{cancelTarget.credits_charged.toLocaleString()}</span>
                                </div>
                                {cancelTarget.scheduled_at && (
                                    <div className="flex justify-between">
                                        <span className="text-muted-foreground">Scheduled for</span>
                                        <span className="font-semibold">{fmtDate(cancelTarget.scheduled_at)}</span>
                                    </div>
                                )}
                            </div>
                            <p className="text-[11px] text-muted-foreground">
                                Cancelling stops the send before dispatch and refunds all charged credits. This cannot be undone.
                            </p>
                            {cancelError && (
                                <p className="text-[11px] text-red-600 font-medium flex items-start gap-1">
                                    <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-px" /> {cancelError}
                                </p>
                            )}
                        </div>
                    )}
                    <DialogFooter className="gap-2">
                        <Button variant="ghost" className="h-10" onClick={() => setCancelTarget(null)} disabled={cancelling}>
                            Keep campaign
                        </Button>
                        <Button
                            variant="destructive"
                            className="h-10 gap-1.5"
                            onClick={handleCancel}
                            disabled={cancelling}
                        >
                            {cancelling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <XCircle className="w-3.5 h-3.5" />}
                            {cancelling ? 'Cancelling…' : 'Cancel & refund'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

        </div>
    )
}
