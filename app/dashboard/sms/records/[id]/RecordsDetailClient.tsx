'use client'

/**
 * Campaign delivery drill-down (KFT SMS).
 * Summary card (full message, sender, cost, status) + delivery rollup stat
 * tiles with delivery-rate %, a per-recipient table with status filter and
 * pagination, and a client-side CSV export (all pages, capped at 2000 rows).
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/lib/toast'
import {
    ArrowLeft, RefreshCcw, Loader2, ChevronLeft, ChevronRight, AlertCircle,
    Download, Radio, Flag, LayoutDashboard, Code2, CalendarClock, Users,
    MessageSquareText, Inbox,
} from 'lucide-react'

// ── Types ────────────────────────────────────────────────────────────────────

type MessageStatus = 'queued' | 'sent' | 'delivered' | 'undelivered' | 'failed' | 'expired' | 'rejected'

interface Campaign {
    id: string
    sender_used: string | null
    mode_at_send: 'platform' | 'business'
    message: string
    recipients_count: number
    segments: number
    credits_charged: number
    status: string
    flagged: boolean
    scheduled_at: string | null
    source: 'dashboard' | 'api'
    created_at: string
}

interface MessageRow {
    recipient: string
    status: MessageStatus
    status_detail: string | null
    network_id: string | null
    status_updated_at: string | null
}

interface DetailData {
    campaign: Campaign
    rollup: Partial<Record<MessageStatus, number>>
    messages: MessageRow[]
    totalMessages: number
    page: number
    pageSize: number
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

const MESSAGE_CHIP: Record<string, ChipStyle> = {
    delivered:   { label: 'Delivered',   cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/25 dark:text-emerald-400' },
    sent:        { label: 'Sent',        cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/25 dark:text-blue-400' },
    queued:      { label: 'Queued',      cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/25 dark:text-blue-400', pulse: true },
    undelivered: { label: 'Undelivered', cls: 'bg-red-100 text-red-700 dark:bg-red-900/25 dark:text-red-400' },
    failed:      { label: 'Failed',      cls: 'bg-red-100 text-red-700 dark:bg-red-900/25 dark:text-red-400' },
    expired:     { label: 'Expired',     cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/25 dark:text-amber-400' },
    rejected:    { label: 'Rejected',    cls: 'bg-red-100 text-red-700 dark:bg-red-900/25 dark:text-red-400' },
}

function Chip({ status, map }: { status: string; map: Record<string, ChipStyle> }) {
    const chip = map[status] ?? { label: status, cls: 'bg-muted text-muted-foreground' }
    return (
        <span className={cn('inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap', chip.cls)}>
            {chip.pulse && <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />}
            {chip.label}
        </span>
    )
}

const MSG_FILTERS: Array<{ value: string; label: string }> = [
    { value: '',            label: 'All' },
    { value: 'delivered',   label: 'Delivered' },
    { value: 'sent',        label: 'Sent' },
    { value: 'queued',      label: 'Queued' },
    { value: 'undelivered', label: 'Undelivered' },
    { value: 'failed',      label: 'Failed' },
    { value: 'expired',     label: 'Expired' },
    { value: 'rejected',    label: 'Rejected' },
]

function csvEscape(v: string): string {
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v
}

const PAGE_SIZE = 50
const EXPORT_CAP = 2000
const EXPORT_PAGE_SIZE = 100 // route max

// ── Component ─────────────────────────────────────────────────────────────────

export default function RecordsDetailClient({ campaignId }: { campaignId: string }) {
    const [data, setData] = useState<DetailData | null>(null)
    const [fetching, setFetching] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [page, setPage] = useState(0)
    const [statusFilter, setStatusFilter] = useState('')
    const [exporting, setExporting] = useState(false)

    const fetchDetail = useCallback(async () => {
        setFetching(true)
        setError(null)
        try {
            const qs = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) })
            if (statusFilter) qs.set('status', statusFilter)
            const res = await fetch(`/api/sms/campaigns/${encodeURIComponent(campaignId)}?${qs.toString()}`)
            const json = await res.json().catch(() => null)
            if (res.status === 404) throw new Error('Campaign not found')
            if (!json?.success) throw new Error(json?.error || 'Failed to load campaign')
            setData(json.data as DetailData)
        } catch (err: any) {
            console.error('[SMS Record Detail]', err)
            setError(err?.message || 'Failed to load campaign')
        } finally {
            setFetching(false)
        }
    }, [campaignId, page, statusFilter])

    useEffect(() => { fetchDetail() }, [fetchDetail])

    const changeFilter = (value: string) => {
        setStatusFilter(value)
        setPage(0)
    }

    // ── CSV export: fetch all pages (unfiltered) up to the cap, build a blob ──
    const handleExport = async () => {
        setExporting(true)
        try {
            const rows: string[][] = [['recipient', 'status', 'detail', 'updated_at']]
            let p = 0
            for (;;) {
                const res = await fetch(`/api/sms/campaigns/${encodeURIComponent(campaignId)}?page=${p}&pageSize=${EXPORT_PAGE_SIZE}`)
                const json = await res.json().catch(() => null)
                if (!json?.success) throw new Error(json?.error || 'Export failed while fetching recipients')
                const msgs: MessageRow[] = json.data.messages ?? []
                for (const m of msgs) {
                    if (rows.length - 1 >= EXPORT_CAP) break
                    rows.push([m.recipient, m.status, m.status_detail ?? '', m.status_updated_at ?? ''])
                }
                const totalMessages: number = json.data.totalMessages ?? 0
                p++
                if (rows.length - 1 >= EXPORT_CAP || msgs.length < EXPORT_PAGE_SIZE || p * EXPORT_PAGE_SIZE >= totalMessages) break
            }
            if (rows.length <= 1) {
                toast.info('No recipients to export yet')
                return
            }
            const csv = rows.map(r => r.map(csvEscape).join(',')).join('\r\n')
            // BOM so Excel opens the file as UTF-8
            const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' })
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = `sms-campaign-${campaignId.slice(0, 8)}-recipients.csv`
            document.body.appendChild(a)
            a.click()
            a.remove()
            URL.revokeObjectURL(url)
            toast.success(`Exported ${(rows.length - 1).toLocaleString()} recipient(s) to CSV`)
        } catch (err: any) {
            toast.error(err?.message || 'CSV export failed')
        } finally {
            setExporting(false)
        }
    }

    // ── Loading / error states ────────────────────────────────────────────────

    if (data === null && fetching) {
        return (
            <div className="space-y-4 pb-20 md:pb-6 max-w-2xl mx-auto">
                <Skeleton className="h-8 w-44" />
                <Skeleton className="h-48 w-full rounded-2xl" />
                <div className="grid grid-cols-3 gap-2">
                    {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-xl" />)}
                </div>
                <Skeleton className="h-64 w-full rounded-2xl" />
            </div>
        )
    }

    if (error && !data) {
        return (
            <div className="max-w-md mx-auto text-center py-20 space-y-4 px-4">
                <AlertCircle className="w-8 h-8 text-red-500 mx-auto" />
                <p className="text-sm text-muted-foreground">{error}</p>
                <div className="flex items-center justify-center gap-2">
                    <Link href="/dashboard/sms/records">
                        <Button variant="outline" className="gap-2 h-10">
                            <ArrowLeft className="w-4 h-4" /> Back to Records
                        </Button>
                    </Link>
                    <Button onClick={fetchDetail} className="gap-2 h-10 bg-emerald-600 hover:bg-emerald-700 text-white">
                        <RefreshCcw className="w-4 h-4" /> Retry
                    </Button>
                </div>
            </div>
        )
    }

    if (!data) return null

    const { campaign, rollup, messages, totalMessages } = data
    const totalPages = Math.max(1, Math.ceil(totalMessages / PAGE_SIZE))
    const delivered = rollup.delivered ?? 0
    const deliveryRate = campaign.recipients_count > 0
        ? Math.round((delivered / campaign.recipients_count) * 100)
        : 0
    const SourceIcon = campaign.source === 'api' ? Code2 : LayoutDashboard

    const tiles: Array<{ label: string; value: number; cls: string }> = [
        { label: 'Delivered',   value: rollup.delivered ?? 0,   cls: 'text-emerald-600' },
        { label: 'Sent',        value: rollup.sent ?? 0,        cls: 'text-blue-600 dark:text-blue-400' },
        { label: 'Queued',      value: rollup.queued ?? 0,      cls: 'text-muted-foreground' },
        { label: 'Undelivered', value: rollup.undelivered ?? 0, cls: 'text-red-500' },
        { label: 'Failed',      value: rollup.failed ?? 0,      cls: 'text-red-500' },
    ]
    if ((rollup.expired ?? 0) > 0)  tiles.push({ label: 'Expired',  value: rollup.expired ?? 0,  cls: 'text-amber-600' })
    if ((rollup.rejected ?? 0) > 0) tiles.push({ label: 'Rejected', value: rollup.rejected ?? 0, cls: 'text-red-500' })

    return (
        <div className="space-y-4 pb-20 md:pb-6 max-w-2xl mx-auto">

            {/* ── Header ── */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                    <Link href="/dashboard/sms/records">
                        <Button variant="ghost" size="sm" className="w-fit gap-2 -ml-2 text-muted-foreground hover:text-emerald-600">
                            <ArrowLeft className="w-4 h-4" /> Campaign Records
                        </Button>
                    </Link>
                    <h1 className="text-xl font-bold flex items-center gap-2 mt-1">
                        <MessageSquareText className="w-5 h-5 text-emerald-600" /> Delivery Report
                    </h1>
                    <p className="text-muted-foreground text-xs mt-0.5 font-mono">#{campaign.id.slice(0, 8)}</p>
                </div>
                <div className="flex gap-2 shrink-0">
                    <Button variant="outline" size="sm" onClick={fetchDetail} disabled={fetching} className="gap-1.5 h-10">
                        {fetching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCcw className="w-3.5 h-3.5" />} Refresh
                    </Button>
                    <Button
                        size="sm"
                        onClick={handleExport}
                        disabled={exporting || totalMessages === 0}
                        className="gap-1.5 h-10 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold"
                    >
                        {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                        {exporting ? 'Exporting…' : 'Export CSV'}
                    </Button>
                </div>
            </div>

            {/* ── Summary card ── */}
            <Card className="rounded-2xl">
                <CardContent className="p-4 sm:p-5 space-y-4">
                    <div className="flex items-center gap-1.5 flex-wrap">
                        <Chip status={campaign.status} map={CAMPAIGN_CHIP} />
                        {campaign.flagged && (
                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/25 dark:text-amber-400">
                                <Flag className="w-2.5 h-2.5" /> Flagged for review
                            </span>
                        )}
                        <span className="inline-flex items-center gap-1 text-[10px] font-medium text-muted-foreground ml-auto" title={campaign.source === 'api' ? 'Sent via developer API' : 'Sent from dashboard'}>
                            <SourceIcon className="w-3.5 h-3.5" /> {campaign.source === 'api' ? 'API' : 'Dashboard'}
                        </span>
                    </div>

                    {/* Full message */}
                    <div className="rounded-xl border bg-muted/30 p-3">
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">Message</p>
                        <p className="text-sm whitespace-pre-wrap break-words leading-relaxed">{campaign.message}</p>
                    </div>

                    {/* Meta grid */}
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3 text-xs">
                        <div>
                            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Sender</p>
                            <p className="font-mono font-bold mt-0.5 flex items-center gap-1">
                                <Radio className="w-3 h-3 text-emerald-600" /> {campaign.sender_used || '—'}
                            </p>
                        </div>
                        <div>
                            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Recipients</p>
                            <p className="font-bold mt-0.5 tabular-nums flex items-center gap-1">
                                <Users className="w-3 h-3 text-muted-foreground" /> {campaign.recipients_count.toLocaleString()}
                            </p>
                        </div>
                        <div>
                            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Cost</p>
                            <p className="font-bold mt-0.5 tabular-nums">
                                {campaign.credits_charged.toLocaleString()} credit{campaign.credits_charged === 1 ? '' : 's'}
                                <span className="text-muted-foreground font-medium"> · {campaign.segments} SMS each</span>
                            </p>
                        </div>
                        <div>
                            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Mode</p>
                            <p className="font-semibold mt-0.5 capitalize">{campaign.mode_at_send}</p>
                        </div>
                        <div>
                            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Created</p>
                            <p className="font-semibold mt-0.5">{fmtDate(campaign.created_at)}</p>
                        </div>
                        {campaign.scheduled_at && (
                            <div>
                                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Scheduled</p>
                                <p className="font-semibold mt-0.5 flex items-center gap-1">
                                    <CalendarClock className="w-3 h-3 text-muted-foreground" /> {fmtDate(campaign.scheduled_at)}
                                </p>
                            </div>
                        )}
                    </div>
                </CardContent>
            </Card>

            {/* ── Delivery rollup tiles ── */}
            <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
                <Card className="rounded-xl border-emerald-200 dark:border-emerald-900 bg-emerald-50/50 dark:bg-emerald-900/10 shadow-sm">
                    <CardContent className="p-3">
                        <p className="text-[10px] font-semibold text-muted-foreground truncate">Delivery rate</p>
                        <p className="text-lg font-bold tabular-nums text-emerald-600 mt-0.5">{deliveryRate}%</p>
                    </CardContent>
                </Card>
                {tiles.map(t => (
                    <Card key={t.label} className="rounded-xl border shadow-sm">
                        <CardContent className="p-3">
                            <p className="text-[10px] font-semibold text-muted-foreground truncate">{t.label}</p>
                            <p className={cn('text-lg font-bold tabular-nums mt-0.5', t.value > 0 ? t.cls : 'text-muted-foreground/50')}>
                                {t.value.toLocaleString()}
                            </p>
                        </CardContent>
                    </Card>
                ))}
            </div>

            {/* ── Per-recipient table ── */}
            <Card className="rounded-2xl overflow-hidden">
                <CardContent className="p-0">
                    <div className="px-4 py-3 border-b space-y-2.5">
                        <div className="flex items-center justify-between">
                            <h3 className="text-sm font-semibold flex items-center gap-1.5">
                                <Inbox className="w-4 h-4 text-emerald-500" /> Recipients
                            </h3>
                            <span className="text-[11px] text-muted-foreground tabular-nums">
                                {totalMessages.toLocaleString()} {statusFilter ? statusFilter : 'total'}
                            </span>
                        </div>
                        <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
                            {MSG_FILTERS.map(f => (
                                <button
                                    key={f.value}
                                    type="button"
                                    onClick={() => changeFilter(f.value)}
                                    className={cn(
                                        'h-10 px-3 rounded-full text-[11px] font-semibold whitespace-nowrap transition-colors border shrink-0',
                                        statusFilter === f.value
                                            ? 'bg-emerald-600 text-white border-emerald-600 shadow-sm'
                                            : 'bg-background text-muted-foreground border-border hover:text-foreground hover:bg-muted/60',
                                    )}
                                >
                                    {f.label}
                                </button>
                            ))}
                        </div>
                    </div>

                    {messages.length === 0 ? (
                        <p className="text-xs text-muted-foreground text-center py-10">
                            {statusFilter ? `No ${statusFilter} recipients.` : 'No recipient rows yet.'}
                        </p>
                    ) : (
                        <div className={cn('divide-y transition-opacity', fetching && 'opacity-60 pointer-events-none')}>
                            {messages.map((m, i) => (
                                <div key={`${m.recipient}-${i}`} className="px-4 py-3 flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <p className="text-xs font-mono font-semibold">{m.recipient}</p>
                                        {m.status_detail && (
                                            <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-1 break-all">{m.status_detail}</p>
                                        )}
                                    </div>
                                    <div className="text-right shrink-0">
                                        <Chip status={m.status} map={MESSAGE_CHIP} />
                                        <p className="text-[10px] text-muted-foreground mt-1">{fmtDate(m.status_updated_at)}</p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Pagination */}
                    {totalMessages > PAGE_SIZE && (
                        <div className="flex items-center justify-between px-4 py-3 border-t">
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
                                Page {page + 1} of {totalPages}
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
                </CardContent>
            </Card>

        </div>
    )
}
