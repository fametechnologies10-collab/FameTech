'use client'

/**
 * /dashboard/sms — KFT SMS platform OVERVIEW.
 * Hero + mode badge, credit balance, 30-day quick stats (computed client-side
 * from the first page of campaigns), sending-identity strip, and navigation
 * cards to Records / Contacts / Credits / Business & Sender ID.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { useAuth } from '@/contexts/auth-context'
import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { SmsAcceptanceGate } from '@/components/sms/sms-acceptance-gate'
import { toast } from '@/lib/toast'
import {
    MessageSquare, ArrowLeft, Send, Coins, History, Users, Building2,
    AlertCircle, Ban, ChevronRight, Sparkles, RefreshCcw, Radio,
    Loader2, Clock, Gauge, Wallet, BadgeCheck, Code2,
} from 'lucide-react'

// ── Types (mirror /api/sms/account + /api/sms/campaigns payloads) ────────────

type PolicyOk   = { canSend: true; sender: string; senderSource: 'own' | 'pool' | 'platform'; filterProfile: string }
type PolicyDown = { canSend: false; reason: string; message: string }

interface AccountData {
    account: {
        id: string
        mode: 'platform' | 'business'
        status: 'active' | 'suspended'
        suspended_reason: string | null
        default_sender: string | null
        use_own_sender_for_confirmations: boolean
    }
    wallet: { credits: number; total_purchased: number; total_used: number }
    senders: Array<{ sender_text: string; status: string; is_default: boolean }>
    poolSenders: string[]
    caps: { max_recipients_per_send: number; sends_per_hour: number; recipients_per_day: number }
    policy: PolicyOk | PolicyDown
    businessProfile: null | {
        business_name: string
        status: 'draft' | 'under_review' | 'approved' | 'rejected'
        domain_link: string | null
        review_notes: string | null
    }
    ledger: Array<{ delta: number; balance_after: number | null; kind: string; reference: string | null; created_at: string }>
    bundles: Array<{ id: string; name: string; credits: number; price: number }>
}

interface CampaignRow {
    id: string
    status: string
    recipients_count: number
    credits_charged: number
    created_at: string
}

type Gate = 'loading' | 'ready' | 'disabled' | 'forbidden' | 'error'

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null | undefined): string {
    if (!iso) return '—'
    const d = new Date(iso)
    if (isNaN(d.getTime())) return '—'
    const sameYear = d.getFullYear() === new Date().getFullYear()
    return d.toLocaleDateString('en-GH', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })
        + ', ' + d.toLocaleTimeString('en-GH', { hour: '2-digit', minute: '2-digit' })
}

const BIZ_STATUS_CHIP: Record<string, { label: string; cls: string }> = {
    draft:        { label: 'Draft',        cls: 'bg-muted text-muted-foreground' },
    under_review: { label: 'Under review', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/25 dark:text-amber-400' },
    approved:     { label: 'Approved',     cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/25 dark:text-emerald-400' },
    rejected:     { label: 'Rejected',     cls: 'bg-red-100 text-red-700 dark:bg-red-900/25 dark:text-red-400' },
}

const SENDER_SOURCE_LABEL: Record<string, string> = {
    own:      'your approved sender ID',
    pool:     'shared sender pool',
    platform: 'platform default',
}

const LEDGER_KIND_LABEL: Record<string, string> = {
    purchase:     'Credit purchase',
    debit:        'Campaign send',
    refund:       'Refund',
    bonus:        'Bonus credits',
    admin_adjust: 'Admin adjustment',
}

// ── Component ─────────────────────────────────────────────────────────────────

/** Shared loading shell — shown both while the account fetch is in flight and
 *  while auth is still resolving (we need dbUser.id before mounting the gate). */
function SmsOverviewSkeleton() {
    return (
        <div className="space-y-5 pb-20 md:pb-6 max-w-2xl mx-auto">
            <div className="space-y-2">
                <Skeleton className="h-8 w-40" />
                <Skeleton className="h-4 w-64" />
            </div>
            <Skeleton className="h-44 w-full rounded-2xl" />
            <div className="grid grid-cols-3 gap-2">
                <Skeleton className="h-20 rounded-xl" />
                <Skeleton className="h-20 rounded-xl" />
                <Skeleton className="h-20 rounded-xl" />
            </div>
            <div className="grid grid-cols-2 gap-3">
                <Skeleton className="h-28 rounded-2xl" />
                <Skeleton className="h-28 rounded-2xl" />
                <Skeleton className="h-28 rounded-2xl" />
                <Skeleton className="h-28 rounded-2xl" />
            </div>
        </div>
    )
}

export default function SmsOverviewPage() {
    const { dbUser } = useAuth()
    const [gate, setGate] = useState<Gate>('loading')
    const [gateMessage, setGateMessage] = useState('')
    const [data, setData] = useState<AccountData | null>(null)
    const [campaigns, setCampaigns] = useState<CampaignRow[] | null>(null)
    const [refreshing, setRefreshing] = useState(false)
    const [useOwnSender, setUseOwnSender] = useState(false)
    const [savingOwnSenderToggle, setSavingOwnSenderToggle] = useState(false)

    const fetchAll = useCallback(async () => {
        try {
            const [accRes, campRes] = await Promise.all([
                fetch('/api/sms/account'),
                fetch('/api/sms/campaigns?page=0&pageSize=50'),
            ])
            const accJson = await accRes.json().catch(() => null)

            if (accRes.status === 503) {
                setGateMessage(accJson?.error || 'SMS is currently unavailable.')
                setGate('disabled')
                return
            }
            if (accRes.status === 403) {
                setGateMessage(accJson?.error || 'SMS is not available for your account.')
                setGate('forbidden')
                return
            }
            if (!accJson?.success) {
                setGateMessage(accJson?.error || 'Failed to load your SMS account.')
                setGate('error')
                return
            }
            const accountData = accJson.data as AccountData
            setData(accountData)
            setUseOwnSender(accountData.account.use_own_sender_for_confirmations)

            // Quick stats are best-effort — never block the page on them.
            const campJson = await campRes.json().catch(() => null)
            setCampaigns(campJson?.success ? (campJson.data.campaigns as CampaignRow[]) : [])

            setGate('ready')
        } catch (err) {
            console.error('[SMS Overview]', err)
            setGateMessage('Network error — check your connection and retry.')
            setGate('error')
        }
    }, [])

    useEffect(() => { fetchAll() }, [fetchAll])

    const handleRefresh = async () => {
        setRefreshing(true)
        await fetchAll()
        setRefreshing(false)
        toast.info('SMS overview refreshed')
    }

    // Own-sender-for-confirmations toggle — optimistic update, revert on
    // failure so the switch never lies about the saved state.
    const handleToggleOwnSender = async (next: boolean) => {
        const prev = useOwnSender
        setUseOwnSender(next)
        setSavingOwnSenderToggle(true)
        try {
            const res = await fetch('/api/sms/account', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ use_own_sender_for_confirmations: next }),
            })
            const json = await res.json().catch(() => null)
            if (res.ok && json?.success) {
                toast.success(next
                    ? 'Your order confirmations will now send from your sender ID'
                    : 'Order confirmations switched back to KINGFLEXY')
            } else {
                setUseOwnSender(prev)
                toast.error(json?.error || 'Could not update this setting')
            }
        } catch {
            setUseOwnSender(prev)
            toast.error('Could not update this setting')
        } finally {
            setSavingOwnSenderToggle(false)
        }
    }

    // Last-30-days quick stats from the first page of campaigns (kept simple:
    // blocked/cancelled sends charged nothing and are excluded).
    const stats30 = useMemo(() => {
        if (!campaigns) return null
        const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
        const recent = campaigns.filter(c =>
            new Date(c.created_at).getTime() >= cutoff
            && c.status !== 'blocked' && c.status !== 'cancelled')
        return {
            sends: recent.length,
            recipients: recent.reduce((s, c) => s + (c.recipients_count || 0), 0),
            credits: recent.reduce((s, c) => s + (c.credits_charged || 0), 0),
        }
    }, [campaigns])

    // ── Gated states ──────────────────────────────────────────────────────────

    if (gate === 'loading') {
        return <SmsOverviewSkeleton />
    }

    if (gate === 'disabled' || gate === 'forbidden') {
        return (
            <div className="max-w-md mx-auto text-center py-20 space-y-4 px-4">
                <div className="w-16 h-16 mx-auto rounded-full bg-muted flex items-center justify-center">
                    <MessageSquare className="w-7 h-7 text-muted-foreground" />
                </div>
                <div>
                    <h1 className="text-lg font-bold">
                        {gate === 'disabled' ? 'KFT SMS is coming soon' : 'SMS is not available for your account'}
                    </h1>
                    <p className="text-sm text-muted-foreground mt-1.5">
                        {gate === 'disabled'
                            ? 'The SMS platform is currently unavailable. Please check back later.'
                            : gateMessage}
                    </p>
                </div>
                <Link href="/dashboard">
                    <Button variant="outline" className="gap-2 h-10 mt-2">
                        <ArrowLeft className="w-4 h-4" /> Back to Dashboard
                    </Button>
                </Link>
            </div>
        )
    }

    if (gate === 'error' || !data) {
        return (
            <div className="max-w-md mx-auto text-center py-20 space-y-4 px-4">
                <div className="w-16 h-16 mx-auto rounded-full bg-red-100 dark:bg-red-950/30 flex items-center justify-center">
                    <AlertCircle className="w-7 h-7 text-red-500" />
                </div>
                <div>
                    <h1 className="text-lg font-bold">Could not load SMS Platform</h1>
                    <p className="text-sm text-muted-foreground mt-1.5">{gateMessage || 'Something went wrong.'}</p>
                </div>
                <Button onClick={() => { setGate('loading'); fetchAll() }} className="gap-2 h-10 bg-emerald-600 hover:bg-emerald-700 text-white">
                    <RefreshCcw className="w-4 h-4" /> Retry
                </Button>
            </div>
        )
    }

    // ── Ready ─────────────────────────────────────────────────────────────────

    // Auth may still be resolving even after the account data has loaded — the
    // acceptance gate is keyed by dbUser.id, so never mount it (or show real
    // content) until that id is known. Show the same shell used while loading.
    if (!dbUser?.id) {
        return <SmsOverviewSkeleton />
    }

    const { account, wallet, policy, businessProfile, caps, ledger, senders } = data
    const isBusiness = account.mode === 'business'
    const suspended = account.status === 'suspended'
    const bizChip = businessProfile ? (BIZ_STATUS_CHIP[businessProfile.status] ?? BIZ_STATUS_CHIP.draft) : null
    const hasApprovedSender = senders.some(s => s.status === 'approved')

    const navCards = [
        { href: '/dashboard/sms/records',  icon: History,   title: 'Records',  desc: 'Campaign history & delivery reports', chip: null as null | { label: string; cls: string } },
        { href: '/dashboard/sms/contacts', icon: Users,     title: 'Contacts', desc: 'Manage your recipient groups',         chip: null },
        { href: '/dashboard/sms/credits',  icon: Coins,     title: 'Credits',  desc: 'Buy bundles & view credit history',    chip: null },
        { href: '/dashboard/sms/business', icon: Building2, title: 'Business & Sender ID', desc: 'Own sender name & business verification', chip: bizChip },
        ...(isBusiness ? [{ href: '/dashboard/sms/api', icon: Code2, title: 'API & Docs', desc: 'Generate your SMS API key & view docs', chip: null as null | { label: string; cls: string } }] : []),
    ]

    return (
        <SmsAcceptanceGate userId={dbUser.id} product="kft">
        <div className="space-y-5 pb-20 md:pb-6 max-w-2xl mx-auto">

            {/* ── Header ── */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                    <Link href="/dashboard">
                        <Button variant="ghost" size="sm" className="w-fit gap-2 -ml-2 text-muted-foreground hover:text-emerald-600">
                            <ArrowLeft className="w-4 h-4" /> Back to Dashboard
                        </Button>
                    </Link>
                    <div className="flex items-center gap-2.5 flex-wrap mt-1">
                        <h1 className="text-xl font-bold flex items-center gap-2">
                            <MessageSquare className="w-5 h-5 text-emerald-600" /> SMS Platform
                        </h1>
                        {isBusiness ? (
                            <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-1 rounded-full bg-gradient-to-r from-violet-600 to-fuchsia-600 text-white shadow-sm shadow-fuchsia-500/25">
                                <Sparkles className="w-3 h-3" /> Business
                            </span>
                        ) : (
                            <span className="inline-flex items-center text-[11px] font-semibold px-2.5 py-1 rounded-full bg-muted text-muted-foreground border border-border">
                                Platform
                            </span>
                        )}
                    </div>
                    <p className="text-muted-foreground text-sm mt-0.5">Send bulk SMS to any Ghana number — pay per message.</p>
                </div>
                <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing} className="gap-1.5 w-fit shrink-0 h-10">
                    {refreshing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCcw className="w-3.5 h-3.5" />} Refresh
                </Button>
            </div>

            {/* ── Suspended banner ── */}
            {suspended && (
                <div className="flex items-start gap-3 p-4 rounded-2xl bg-red-50 dark:bg-red-950/25 border border-red-200 dark:border-red-900">
                    <Ban className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                    <div>
                        <p className="text-sm font-bold text-red-700 dark:text-red-400">Your SMS account is suspended</p>
                        <p className="text-xs text-red-600/90 dark:text-red-400/80 mt-0.5">
                            {account.suspended_reason || 'Contact support for more information.'}
                        </p>
                    </div>
                </div>
            )}

            {/* ── Policy banner (cannot send) ── */}
            {!suspended && policy.canSend === false && (
                <div className="flex items-start gap-3 p-4 rounded-2xl bg-amber-50 dark:bg-amber-900/15 border border-amber-200 dark:border-amber-800">
                    <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
                    <div>
                        <p className="text-sm font-bold text-amber-800 dark:text-amber-300">Sending is unavailable right now</p>
                        <p className="text-xs text-amber-700/90 dark:text-amber-400/80 mt-0.5">{policy.message}</p>
                    </div>
                </div>
            )}

            {/* ── Credit balance hero ── */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
                <Card className="rounded-2xl border-emerald-200 dark:border-emerald-900 bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-950/25 dark:to-teal-950/15 overflow-hidden">
                    <CardContent className="p-5 space-y-4">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <p className="text-[11px] font-semibold text-emerald-700/80 dark:text-emerald-400/80 uppercase tracking-wide flex items-center gap-1.5">
                                    <Wallet className="w-3.5 h-3.5" /> Credit balance
                                </p>
                                <p className="text-4xl font-bold tabular-nums mt-1.5">
                                    {wallet.credits.toLocaleString()}
                                    <span className="text-sm font-medium text-muted-foreground ml-1.5">credits</span>
                                </p>
                            </div>
                            <div className="w-11 h-11 rounded-xl bg-emerald-600/10 dark:bg-emerald-500/10 flex items-center justify-center shrink-0">
                                <Coins className="w-5 h-5 text-emerald-600" />
                            </div>
                        </div>

                        <div className="flex flex-col sm:flex-row gap-2">
                            {suspended || policy.canSend === false ? (
                                <Button disabled className="flex-1 h-11 bg-emerald-600 text-white font-semibold gap-2">
                                    <Send className="w-4 h-4" /> Send SMS
                                </Button>
                            ) : (
                                <Link href="/dashboard/sms/compose" className="flex-1">
                                    <Button className="w-full h-11 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold gap-2">
                                        <Send className="w-4 h-4" /> Send SMS
                                    </Button>
                                </Link>
                            )}
                            <Link href="/dashboard/sms/credits" className="flex-1">
                                <Button variant="outline" className="w-full h-11 font-semibold gap-2 border-emerald-300 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/30">
                                    <Coins className="w-4 h-4" /> Buy Credits
                                </Button>
                            </Link>
                        </div>
                        {/* Sending identity */}
                        {policy.canSend === true && (
                            <div className="flex items-center gap-2 rounded-xl bg-white/60 dark:bg-black/20 border border-emerald-200/70 dark:border-emerald-900/60 px-3 py-2.5">
                                <Radio className="w-4 h-4 text-emerald-600 shrink-0" />
                                <p className="text-xs text-muted-foreground min-w-0 truncate">
                                    Sending as <span className="font-mono font-bold text-foreground">{policy.sender}</span>
                                    <span className="hidden sm:inline"> · {SENDER_SOURCE_LABEL[policy.senderSource] ?? policy.senderSource}</span>
                                </p>
                            </div>
                        )}
                    </CardContent>
                </Card>
            </motion.div>

            {/* ── Own-sender-for-confirmations toggle (only once a sender is approved) ── */}
            {hasApprovedSender && (
                <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.03 }}>
                    <Card className="rounded-2xl border shadow-sm">
                        <CardContent className="p-4">
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0 flex items-start gap-2.5">
                                    <div className="w-9 h-9 rounded-lg bg-emerald-100 dark:bg-emerald-900/25 flex items-center justify-center shrink-0">
                                        <BadgeCheck className="w-[18px] h-[18px] text-emerald-600" />
                                    </div>
                                    <div className="min-w-0">
                                        <p className="text-sm font-bold">Use my sender ID for order confirmations</p>
                                        <p className="text-[11px] text-muted-foreground mt-0.5">
                                            Your data, airtime and results-checker purchase confirmations will arrive from your approved sender ID instead of KINGFLEXY.
                                        </p>
                                    </div>
                                </div>
                                <Switch
                                    checked={useOwnSender}
                                    onCheckedChange={handleToggleOwnSender}
                                    disabled={savingOwnSenderToggle}
                                    aria-label="Use my sender ID for order confirmations"
                                    className="shrink-0 mt-0.5"
                                />
                            </div>
                        </CardContent>
                    </Card>
                </motion.div>
            )}

            {/* ── 30-day quick stats ── */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.05 }}>
                <div className="grid grid-cols-3 gap-2">
                    {[
                        { label: 'Campaigns (30d)',  value: stats30 ? stats30.sends.toLocaleString() : '–' },
                        { label: 'Recipients (30d)', value: stats30 ? stats30.recipients.toLocaleString() : '–' },
                        { label: 'Credits used (30d)', value: stats30 ? stats30.credits.toLocaleString() : '–' },
                    ].map(s => (
                        <Card key={s.label} className="rounded-xl border shadow-sm">
                            <CardContent className="p-3">
                                <p className="text-[10px] sm:text-[11px] font-semibold text-muted-foreground truncate">{s.label}</p>
                                <p className="text-base sm:text-lg font-bold tabular-nums mt-0.5">{s.value}</p>
                            </CardContent>
                        </Card>
                    ))}
                </div>
            </motion.div>

            {/* ── Navigation cards ── */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.1 }}>
                <div className="grid grid-cols-2 gap-3">
                    {navCards.map(card => (
                        <Link key={card.href} href={card.href}>
                            <Card className="rounded-2xl h-full border shadow-sm transition-colors hover:border-emerald-300 dark:hover:border-emerald-800 hover:bg-muted/30 cursor-pointer">
                                <CardContent className="p-4 flex flex-col gap-2 min-h-[112px]">
                                    <div className="flex items-start justify-between">
                                        <div className="w-9 h-9 rounded-lg bg-emerald-100 dark:bg-emerald-900/25 flex items-center justify-center">
                                            <card.icon className="w-[18px] h-[18px] text-emerald-600" />
                                        </div>
                                        <ChevronRight className="w-4 h-4 text-muted-foreground/50" />
                                    </div>
                                    <div className="min-w-0">
                                        <p className="text-sm font-bold flex items-center gap-1.5 flex-wrap">
                                            {card.title}
                                            {card.chip && (
                                                <span className={cn('text-[10px] font-semibold px-1.5 py-0.5 rounded-full', card.chip.cls)}>
                                                    {card.chip.label}
                                                </span>
                                            )}
                                        </p>
                                        <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">{card.desc}</p>
                                    </div>
                                </CardContent>
                            </Card>
                        </Link>
                    ))}
                </div>
            </motion.div>

            {/* ── Account limits ── */}
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground px-1">
                <Gauge className="w-3.5 h-3.5 shrink-0" />
                <span>
                    Limits: <strong className="text-foreground">{caps.max_recipients_per_send.toLocaleString()}</strong> recipients/send ·{' '}
                    <strong className="text-foreground">{caps.sends_per_hour.toLocaleString()}</strong> sends/hour ·{' '}
                    <strong className="text-foreground">{caps.recipients_per_day.toLocaleString()}</strong> recipients/day
                </span>
            </div>

            {/* ── Recent credit activity ── */}
            <Card className="rounded-2xl overflow-hidden">
                <CardContent className="p-0">
                    <div className="px-4 py-3 border-b flex items-center justify-between">
                        <h3 className="text-sm font-semibold flex items-center gap-1.5">
                            <Clock className="w-4 h-4 text-emerald-500" /> Recent Credit Activity
                        </h3>
                        <Link href="/dashboard/sms/credits" className="text-[11px] font-semibold text-emerald-600 hover:text-emerald-700 inline-flex items-center min-h-[40px]">
                            View all →
                        </Link>
                    </div>
                    {ledger.length === 0 ? (
                        <p className="text-xs text-muted-foreground text-center py-8">No credit activity yet — buy your first bundle to get started.</p>
                    ) : (
                        <div className="divide-y">
                            {ledger.slice(0, 5).map((row, i) => (
                                <div key={`${row.created_at}-${i}`} className="px-4 py-2.5 flex items-center justify-between gap-3">
                                    <div className="min-w-0">
                                        <p className="text-xs font-medium truncate">{LEDGER_KIND_LABEL[row.kind] ?? row.kind}</p>
                                        <p className="text-[11px] text-muted-foreground mt-0.5">{fmtDate(row.created_at)}</p>
                                    </div>
                                    <div className="text-right shrink-0">
                                        <p className={cn('text-xs font-bold tabular-nums', row.delta >= 0 ? 'text-emerald-600' : 'text-red-500')}>
                                            {row.delta >= 0 ? '+' : ''}{row.delta.toLocaleString()}
                                        </p>
                                        {row.balance_after !== null && (
                                            <p className="text-[10px] text-muted-foreground tabular-nums">bal {row.balance_after.toLocaleString()}</p>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>

        </div>
        </SmsAcceptanceGate>
    )
}
