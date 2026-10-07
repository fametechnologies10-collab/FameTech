'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatDate, normalizeWhatsAppNumber, cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select'
import {
    Loader2, RefreshCw, Search, X, Calendar, Filter, MessageSquare,
    Send, Phone, Mail, Lock, Inbox, Archive, Info, Check, CheckCheck,
} from 'lucide-react'
import { toast } from '@/lib/toast'
import { resolveSupplier, SUPPLIER_META } from '@/lib/order-supplier'
import { getMessageTickState } from '@/lib/support-ticks'

function SupplierBadge({ order }: { order: { fulfillment_method?: string | null; status?: string | null; download_batch_id?: string | null } | null | undefined }) {
    if (!order) return <span className="text-muted-foreground text-xs">—</span>
    const tag = resolveSupplier(null, order.download_batch_id, order.fulfillment_method, order.status)
    const meta = SUPPLIER_META[tag ?? 'na']
    return <Badge variant="outline" className={cn('text-[10px] py-0 h-5 font-normal', meta.badgeClass)}>{meta.label}</Badge>
}

function MessageTick({ state }: { state: 'sent' | 'delivered' | 'read' }) {
    if (state === 'sent') return <Check className="w-3.5 h-3.5 shrink-0" />
    return <CheckCheck className={cn('w-3.5 h-3.5 shrink-0', state === 'read' && 'text-sky-300')} />
}

function PresenceBadge({ active }: { active: boolean | null }) {
    if (active === null) return null
    return (
        <span className={cn(
            'inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full',
            active
                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
        )}>
            <span className={cn('w-1.5 h-1.5 rounded-full', active ? 'bg-emerald-500' : 'bg-amber-500')} />
            {active ? 'Support active now' : 'Support away'}
        </span>
    )
}

// ─── Support threads (new system) ────────────────────────────────────────────

interface AdminThread {
    id: string
    user_id: string
    order_id: string | null
    subject: string
    category: string
    phone_number: string
    whatsapp_number: string
    status: 'open' | 'closed'
    closed_at?: string | null
    last_message_at: string
    created_at: string
    users?: { first_name: string | null; last_name: string | null; email: string; phone_number: string } | null
    orders?: {
        reference_code: string
        network: string
        size: string
        status: string | null
        price?: number
        phone_number?: string
        created_at?: string
        fulfillment_method?: string | null
        download_batch_id?: string | null
    } | null
    last_message?: { body: string; sender_role: string; created_at: string } | null
    unread_count?: number
}

interface AdminMessage {
    id: string
    thread_id: string
    sender_role: 'user' | 'admin'
    body: string
    created_at: string
    delivered_at?: string | null
    read_at?: string | null
}

type ThreadStatusFilter = 'all' | 'open' | 'closed'

function ThreadsConsole() {
    const [threads, setThreads] = useState<AdminThread[]>([])
    const [loading, setLoading] = useState(true)
    const [refreshing, setRefreshing] = useState(false)
    const [statusFilter, setStatusFilter] = useState<ThreadStatusFilter>('open')
    const [days, setDays] = useState('30')
    const [search, setSearch] = useState('')

    // Drawer
    const [activeThread, setActiveThread] = useState<AdminThread | null>(null)
    const [messages, setMessages] = useState<AdminMessage[]>([])
    const [loadingDrawer, setLoadingDrawer] = useState(false)
    const [reply, setReply] = useState('')
    const [replying, setReplying] = useState(false)
    const [showClose, setShowClose] = useState(false)
    const [closingNote, setClosingNote] = useState('')
    const [closing, setClosing] = useState(false)
    const [showOrderDetails, setShowOrderDetails] = useState(false)

    const scrollRef = useRef<HTMLDivElement>(null)
    const activeIdRef = useRef<string | null>(null)
    useEffect(() => { activeIdRef.current = activeThread?.id ?? null }, [activeThread?.id])

    const fetchThreads = useCallback(async (isRefresh = false) => {
        if (isRefresh) setRefreshing(true)
        try {
            const res = await fetch(`/api/admin/support/threads?status=${statusFilter}&days=${days}`)
            const json = await res.json()
            if (!res.ok || !json.success) throw new Error(json.error || 'Failed to fetch threads')
            setThreads(json.data || [])
            if (isRefresh) toast.success('Threads refreshed')
        } catch (error: any) {
            console.error('Error fetching threads:', error)
            toast.error(error?.message || 'Failed to load support threads')
        } finally {
            setLoading(false)
            setRefreshing(false)
        }
    }, [statusFilter, days])

    useEffect(() => { fetchThreads() }, [fetchThreads])

    // Admins can't receive RLS-scoped realtime here — poll lightly instead.
    // EGRESS: this runs for as long as the page is open. Each tick is a full
    // round-trip through middleware (session verify + admin role check) before
    // the query even runs, so the list poll is deliberately slow — the drawer
    // poll below covers the conversation an admin is actually reading.
    useEffect(() => {
        const interval = setInterval(() => fetchThreads(), 180_000)
        return () => clearInterval(interval)
    }, [fetchThreads])

    const openDrawer = async (thread: AdminThread) => {
        setActiveThread(thread)
        setMessages([])
        setReply('')
        setShowClose(false)
        setClosingNote('')
        setShowOrderDetails(false)
        setLoadingDrawer(true)
        try {
            const res = await fetch(`/api/admin/support/threads/${thread.id}`)
            const json = await res.json()
            if (!res.ok || !json.success) throw new Error(json.error || 'Failed to load thread')
            setActiveThread(json.data.thread)
            setMessages(json.data.messages)
            // Mark user messages read — fire and forget, then clear the list badge.
            fetch(`/api/admin/support/threads/${thread.id}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'read' }),
            }).catch(() => { })
            setThreads(prev => prev.map(t => t.id === thread.id ? { ...t, unread_count: 0 } : t))
        } catch (error: any) {
            toast.error(error?.message || 'Failed to load thread')
            setActiveThread(null)
        } finally {
            setLoadingDrawer(false)
        }
    }

    // Poll the open conversation for new user messages.
    useEffect(() => {
        if (!activeThread?.id) return
        const interval = setInterval(async () => {
            const id = activeIdRef.current
            if (!id) return
            try {
                const res = await fetch(`/api/admin/support/threads/${id}`)
                const json = await res.json()
                if (res.ok && json.success && activeIdRef.current === id) {
                    setMessages(json.data.messages)
                }
            } catch { /* transient */ }
        }, 30_000)
        return () => clearInterval(interval)
    }, [activeThread?.id])

    useEffect(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }, [messages.length, activeThread?.id])

    const handleReply = async () => {
        const text = reply.trim()
        if (!text || !activeThread || replying) return
        setReplying(true)
        try {
            const res = await fetch(`/api/admin/support/threads/${activeThread.id}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'reply', message: text }),
            })
            const json = await res.json()
            if (!res.ok || !json.success) throw new Error(json.error || 'Failed to send reply')
            setReply('')
            const sent = json.data.message as AdminMessage
            setMessages(prev => prev.some(m => m.id === sent.id) ? prev : [...prev, sent])
        } catch (error: any) {
            toast.error(error?.message || 'Failed to send reply')
        } finally {
            setReplying(false)
        }
    }

    const handleClose = async () => {
        if (!activeThread || closing) return
        setClosing(true)
        try {
            const res = await fetch(`/api/admin/support/threads/${activeThread.id}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'close', closing_note: closingNote.trim() || undefined }),
            })
            const json = await res.json()
            if (!res.ok || !json.success) throw new Error(json.error || 'Failed to close thread')
            toast.success('Complaint closed')
            setShowClose(false)
            setActiveThread(prev => prev ? { ...prev, status: 'closed' } : prev)
            setThreads(prev => prev.map(t => t.id === activeThread.id ? { ...t, status: 'closed' } : t))
        } catch (error: any) {
            toast.error(error?.message || 'Failed to close thread')
        } finally {
            setClosing(false)
        }
    }

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase()
        if (!q) return threads
        return threads.filter(t => {
            const name = `${t.users?.first_name ?? ''} ${t.users?.last_name ?? ''}`.toLowerCase()
            return name.includes(q)
                || (t.users?.email ?? '').toLowerCase().includes(q)
                || t.subject.toLowerCase().includes(q)
                || (t.orders?.reference_code ?? '').toLowerCase().includes(q)
                || t.phone_number.includes(q)
        })
    }, [threads, search])

    const openCount = threads.filter(t => t.status === 'open').length
    const unreadTotal = threads.reduce((sum, t) => sum + (t.unread_count || 0), 0)

    if (loading) {
        return (
            <div className="flex items-center justify-center py-24">
                <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
        )
    }

    return (
        <div className="space-y-4">
            {/* Mini stats */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <Card>
                    <CardContent className="p-4">
                        <p className="text-xl font-semibold">{openCount}</p>
                        <p className="text-xs text-muted-foreground">Open complaints</p>
                    </CardContent>
                </Card>
                <Card>
                    <CardContent className="p-4">
                        <p className="text-xl font-semibold">{unreadTotal}</p>
                        <p className="text-xs text-muted-foreground">Unread messages</p>
                    </CardContent>
                </Card>
                <Card className="hidden sm:block">
                    <CardContent className="p-4">
                        <p className="text-xl font-semibold">{threads.length}</p>
                        <p className="text-xs text-muted-foreground">In view</p>
                    </CardContent>
                </Card>
            </div>

            {/* Filters */}
            <div className="space-y-3">
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                    <Input
                        placeholder="Search by name, email, subject, phone, or order ref…"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        className="pl-9 pr-9"
                    />
                    {search && (
                        <button
                            onClick={() => setSearch('')}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    )}
                </div>
                <div className="flex flex-wrap gap-2 items-center">
                    <Select value={statusFilter} onValueChange={v => setStatusFilter(v as ThreadStatusFilter)}>
                        <SelectTrigger className="w-[130px] h-9 text-sm">
                            <Filter className="w-3.5 h-3.5 mr-1.5 text-muted-foreground" />
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="open">Open</SelectItem>
                            <SelectItem value="closed">Closed</SelectItem>
                            <SelectItem value="all">All</SelectItem>
                        </SelectContent>
                    </Select>
                    <Select value={days} onValueChange={setDays}>
                        <SelectTrigger className="w-[140px] h-9 text-sm">
                            <Calendar className="w-3.5 h-3.5 mr-1.5 text-muted-foreground" />
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="7">Last 7 days</SelectItem>
                            <SelectItem value="30">Last 30 days</SelectItem>
                            <SelectItem value="90">Last 90 days</SelectItem>
                        </SelectContent>
                    </Select>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => fetchThreads(true)}
                        disabled={refreshing}
                        className="h-9 gap-2"
                    >
                        <RefreshCw className={cn('w-4 h-4', refreshing && 'animate-spin')} />
                        Refresh
                    </Button>
                    <span className="text-xs text-muted-foreground ml-auto">
                        {filtered.length} of {threads.length} thread{threads.length !== 1 ? 's' : ''}
                    </span>
                </div>
            </div>

            {/* Thread rows */}
            {filtered.length === 0 ? (
                <Card className="p-12 text-center">
                    <Inbox className="w-10 h-10 mx-auto text-muted-foreground/40 mb-3" />
                    <p className="text-sm text-muted-foreground">No support threads found</p>
                </Card>
            ) : (
                <div className="space-y-2">
                    {filtered.map(thread => (
                        <button
                            key={thread.id}
                            onClick={() => openDrawer(thread)}
                            className="w-full text-left rounded-xl border p-3.5 transition-colors hover:border-primary/40 bg-card"
                        >
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <div className="flex items-center gap-2">
                                        <p className="text-sm font-medium truncate">{thread.subject}</p>
                                        {(thread.unread_count || 0) > 0 && (
                                            <span className="shrink-0 min-w-5 h-5 px-1.5 rounded-full bg-primary text-primary-foreground text-[10px] font-semibold flex items-center justify-center">
                                                {thread.unread_count}
                                            </span>
                                        )}
                                    </div>
                                    <p className="text-xs text-muted-foreground mt-0.5 truncate">
                                        {thread.users?.first_name} {thread.users?.last_name} · {thread.users?.email}
                                    </p>
                                    {thread.last_message && (
                                        <p className="text-xs text-muted-foreground mt-1.5 line-clamp-1">
                                            <span className="font-medium">{thread.last_message.sender_role === 'admin' ? 'You: ' : ''}</span>
                                            {thread.last_message.body}
                                        </p>
                                    )}
                                </div>
                                <div className="shrink-0 flex flex-col items-end gap-1.5">
                                    <Badge variant={thread.status === 'open' ? 'processing' : 'completed'} className="text-[10px] py-0 h-5">
                                        {thread.status}
                                    </Badge>
                                    <span className="text-[11px] text-muted-foreground whitespace-nowrap">
                                        {formatDate(thread.last_message_at)}
                                    </span>
                                    {thread.orders?.reference_code && (
                                        <span className="text-[10px] font-mono text-muted-foreground">{thread.orders.reference_code}</span>
                                    )}
                                </div>
                            </div>
                        </button>
                    ))}
                </div>
            )}

            {/* Conversation drawer */}
            <Dialog open={!!activeThread} onOpenChange={open => { if (!open) setActiveThread(null) }}>
                <DialogContent className="max-w-2xl w-[calc(100vw-2rem)] sm:w-full max-h-[90vh] flex flex-col p-0 gap-0">
                    {activeThread && (
                        <>
                            <DialogHeader className="px-4 sm:px-6 pt-5 pb-3 border-b space-y-1.5">
                                <div className="flex items-center justify-between gap-3 pr-8">
                                    <DialogTitle className="text-base truncate">{activeThread.subject}</DialogTitle>
                                    <Badge variant={activeThread.status === 'open' ? 'processing' : 'completed'}>
                                        {activeThread.status}
                                    </Badge>
                                </div>
                                <DialogDescription asChild>
                                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                                        <span>
                                            {activeThread.users?.first_name} {activeThread.users?.last_name} · {activeThread.users?.email}
                                        </span>
                                        <a
                                            href={`tel:${activeThread.phone_number}`}
                                            className="inline-flex items-center gap-1 text-primary hover:underline"
                                        >
                                            <Phone className="w-3 h-3" /> {activeThread.phone_number}
                                        </a>
                                        <a
                                            href={`https://wa.me/${normalizeWhatsAppNumber(activeThread.whatsapp_number)}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="inline-flex items-center gap-1 text-primary hover:underline"
                                        >
                                            <MessageSquare className="w-3 h-3" /> WhatsApp
                                        </a>
                                        {activeThread.users?.email && (
                                            <a
                                                href={`mailto:${activeThread.users.email}`}
                                                className="inline-flex items-center gap-1 text-primary hover:underline"
                                            >
                                                <Mail className="w-3 h-3" /> Email
                                            </a>
                                        )}
                                    </div>
                                </DialogDescription>
                                {activeThread.orders && (
                                    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground bg-muted/50 rounded-lg px-3 py-2">
                                        <span className="truncate">
                                            Linked order <span className="font-mono">{activeThread.orders.reference_code}</span>
                                            {' · '}{activeThread.orders.network} {activeThread.orders.size}
                                            {' · '}<span className="capitalize">{activeThread.orders.status ?? 'unknown'}</span>
                                        </span>
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => setShowOrderDetails(true)}
                                            className="h-6 px-2 gap-1 text-[11px] shrink-0"
                                        >
                                            <Info className="w-3 h-3" /> View Details
                                        </Button>
                                    </div>
                                )}
                            </DialogHeader>

                            {/* Messages */}
                            <div ref={scrollRef} className="flex-1 min-h-[240px] overflow-y-auto p-4 space-y-3 bg-gradient-to-b from-muted/10 to-muted/30">
                                {loadingDrawer ? (
                                    <div className="flex justify-center py-10">
                                        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                                    </div>
                                ) : (
                                    messages.map(msg => (
                                        <div key={msg.id} className={cn('flex', msg.sender_role === 'admin' ? 'justify-end' : 'justify-start')}>
                                            <div className={cn(
                                                'max-w-[85%] sm:max-w-[70%] rounded-2xl px-3.5 py-2.5 text-sm shadow-sm transition-colors',
                                                msg.sender_role === 'admin'
                                                    ? 'bg-primary text-primary-foreground rounded-br-md'
                                                    : 'bg-background border rounded-bl-md'
                                            )}>
                                                <p className="whitespace-pre-wrap break-words">{msg.body}</p>
                                                <p className={cn(
                                                    'text-[10px] mt-1 text-right flex items-center justify-end gap-1',
                                                    msg.sender_role === 'admin' ? 'text-primary-foreground/70' : 'text-muted-foreground'
                                                )}>
                                                    {formatDate(msg.created_at)}
                                                    {msg.sender_role === 'admin' && <MessageTick state={getMessageTickState({ delivered_at: msg.delivered_at ?? null, read_at: msg.read_at ?? null })} />}
                                                </p>
                                            </div>
                                        </div>
                                    ))
                                )}
                            </div>

                            {/* Composer / close */}
                            {activeThread.status === 'open' ? (
                                showClose ? (
                                    <div className="p-4 border-t space-y-3">
                                        <p className="text-sm font-medium">Close this complaint?</p>
                                        <Textarea
                                            value={closingNote}
                                            onChange={e => setClosingNote(e.target.value)}
                                            placeholder="Optional closing note sent to the user…"
                                            rows={2}
                                            maxLength={1000}
                                        />
                                        <div className="flex justify-end gap-2">
                                            <Button variant="outline" size="sm" onClick={() => setShowClose(false)} disabled={closing}>
                                                Cancel
                                            </Button>
                                            <Button size="sm" onClick={handleClose} disabled={closing}>
                                                {closing ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Lock className="w-3.5 h-3.5 mr-1.5" />}
                                                Close Complaint
                                            </Button>
                                        </div>
                                    </div>
                                ) : (
                                    <form
                                        onSubmit={e => { e.preventDefault(); handleReply() }}
                                        className="p-3 border-t flex items-center gap-2"
                                    >
                                        <Button
                                            type="button"
                                            variant="outline"
                                            size="sm"
                                            onClick={() => setShowClose(true)}
                                            className="gap-1.5 shrink-0"
                                        >
                                            <Lock className="w-3.5 h-3.5" /> Close
                                        </Button>
                                        <Input
                                            value={reply}
                                            onChange={e => setReply(e.target.value)}
                                            placeholder="Reply to the user…"
                                            maxLength={1000}
                                            className="flex-1 rounded-full bg-muted/50 border-transparent focus-visible:bg-background"
                                        />
                                        <Button type="submit" size="icon" className="rounded-full shrink-0" disabled={!reply.trim() || replying} aria-label="Send reply">
                                            {replying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                                        </Button>
                                    </form>
                                )
                            ) : (
                                <div className="p-3 border-t bg-muted/30">
                                    <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                                        <Lock className="w-3.5 h-3.5" /> Closed {activeThread.closed_at ? formatDate(activeThread.closed_at) : ''}
                                    </p>
                                </div>
                            )}
                        </>
                    )}
                </DialogContent>
            </Dialog>

            {/* Order details — admin-only, surfaces what a legacy complaint already
                showed (beneficiary/date/supplier) for the thread-based flow too. */}
            <Dialog open={showOrderDetails} onOpenChange={setShowOrderDetails}>
                <DialogContent className="max-w-md w-[calc(100vw-2rem)] sm:w-full">
                    <DialogHeader>
                        <DialogTitle>Order Details</DialogTitle>
                        <DialogDescription>For resolving this complaint against the right order and supplier.</DialogDescription>
                    </DialogHeader>
                    {activeThread?.orders && (
                        <div className="space-y-3 text-sm">
                            <div className="flex justify-between items-center py-2 border-b">
                                <span className="text-muted-foreground">Order reference</span>
                                <span className="font-mono">{activeThread.orders.reference_code}</span>
                            </div>
                            <div className="flex justify-between items-center py-2 border-b">
                                <span className="text-muted-foreground">Beneficiary number</span>
                                <span className="font-mono">{activeThread.orders.phone_number ?? '—'}</span>
                            </div>
                            <div className="flex justify-between items-center py-2 border-b">
                                <span className="text-muted-foreground">Package</span>
                                <span className="capitalize">{activeThread.orders.network} {activeThread.orders.size}</span>
                            </div>
                            <div className="flex justify-between items-center py-2 border-b">
                                <span className="text-muted-foreground">Order placed</span>
                                <span>{activeThread.orders.created_at ? formatDate(activeThread.orders.created_at) : '—'}</span>
                            </div>
                            <div className="flex justify-between items-center py-2">
                                <span className="text-muted-foreground">Supplier</span>
                                <SupplierBadge order={activeThread.orders} />
                            </div>
                        </div>
                    )}
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setShowOrderDetails(false)}>Close</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}

// ─── Legacy order complaints (read-only resolution flow) ─────────────────────

type DatePreset = 'all' | 'today' | 'yesterday' | 'week' | 'month' | 'custom'
type StatusFilter = 'all' | 'pending' | 'in_review' | 'resolved' | 'rejected'

function getPresetRange(preset: DatePreset): { from: Date | null; to: Date | null } {
    const now = new Date()
    const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
    const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999)

    switch (preset) {
        case 'today':
            return { from: startOfDay(now), to: endOfDay(now) }
        case 'yesterday': {
            const y = new Date(now); y.setDate(y.getDate() - 1)
            return { from: startOfDay(y), to: endOfDay(y) }
        }
        case 'week': {
            const w = new Date(now); w.setDate(w.getDate() - 7)
            return { from: startOfDay(w), to: endOfDay(now) }
        }
        case 'month': {
            const m = new Date(now); m.setMonth(m.getMonth() - 1)
            return { from: startOfDay(m), to: endOfDay(now) }
        }
        default:
            return { from: null, to: null }
    }
}

function LegacyComplaints() {
    const [complaints, setComplaints] = useState<any[]>([])
    const [loading, setLoading] = useState(true)
    const [refreshing, setRefreshing] = useState(false)
    const [selectedComplaint, setSelectedComplaint] = useState<any>(null)
    const [resolutionNotes, setResolutionNotes] = useState('')
    const [isResolving, setIsResolving] = useState(false)

    // Filters
    const [search, setSearch] = useState('')
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
    const [datePreset, setDatePreset] = useState<DatePreset>('all')
    const [customFrom, setCustomFrom] = useState('')
    const [customTo, setCustomTo] = useState('')

    useEffect(() => {
        fetchComplaints()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const fetchComplaints = async (isRefresh = false) => {
        if (isRefresh) setRefreshing(true)
        else setLoading(true)
        try {
            const response = await fetch('/api/admin/complaints?days=30')
            if (!response.ok) throw new Error('Failed to fetch complaints')
            const data = await response.json()
            setComplaints(data || [])
            if (isRefresh) toast.success('Complaints refreshed')
        } catch (error) {
            console.error('Error fetching complaints:', error)
            toast.error('Failed to load complaints')
        } finally {
            setLoading(false)
            setRefreshing(false)
        }
    }

    const handleResolve = async (status: 'resolved' | 'rejected') => {
        if (!selectedComplaint) return

        setIsResolving(true)
        try {
            const response = await fetch('/api/admin/complaints/resolve', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: selectedComplaint.id,
                    status,
                    resolution_notes: resolutionNotes,
                })
            })

            if (!response.ok) {
                const error = await response.json()
                throw new Error(error.error || 'Failed to update complaint')
            }

            setComplaints(complaints.map(c =>
                c.id === selectedComplaint.id
                    ? { ...c, status, resolution_notes: resolutionNotes, updated_at: new Date().toISOString() }
                    : c
            ))

            toast.success(`Complaint marked as ${status}`)
            setSelectedComplaint(null)
            setResolutionNotes('')
        } catch (error: any) {
            console.error('Failed to update complaint:', error)
            toast.error(error?.message || 'Failed to update complaint')
        } finally {
            setIsResolving(false)
        }
    }

    const filteredComplaints = useMemo(() => {
        let result = [...complaints]

        // Search filter
        const q = search.trim().toLowerCase()
        if (q) {
            result = result.filter(c => {
                const userName = `${c.users?.first_name ?? ''} ${c.users?.last_name ?? ''}`.toLowerCase()
                const email = (c.users?.email ?? '').toLowerCase()
                const ref = (c.orders?.reference_code ?? '').toLowerCase()
                const title = (c.title ?? '').toLowerCase()
                return userName.includes(q) || email.includes(q) || ref.includes(q) || title.includes(q)
            })
        }

        // Status filter
        if (statusFilter !== 'all') {
            result = result.filter(c => c.status === statusFilter)
        }

        // Date filter
        let dateFrom: Date | null = null
        let dateTo: Date | null = null

        if (datePreset === 'custom') {
            if (customFrom) dateFrom = new Date(customFrom)
            if (customTo) {
                dateTo = new Date(customTo)
                dateTo.setHours(23, 59, 59, 999)
            }
        } else if (datePreset !== 'all') {
            const range = getPresetRange(datePreset)
            dateFrom = range.from
            dateTo = range.to
        }

        if (dateFrom || dateTo) {
            result = result.filter(c => {
                const d = new Date(c.created_at)
                if (dateFrom && d < dateFrom) return false
                if (dateTo && d > dateTo) return false
                return true
            })
        }

        return result
    }, [complaints, search, statusFilter, datePreset, customFrom, customTo])

    const clearFilters = () => {
        setSearch('')
        setStatusFilter('all')
        setDatePreset('all')
        setCustomFrom('')
        setCustomTo('')
    }

    const hasActiveFilters = search || statusFilter !== 'all' || datePreset !== 'all'

    const getStatusBadge = (status: string) => {
        const variants: Record<string, 'pending' | 'processing' | 'completed' | 'failed'> = {
            pending: 'pending',
            in_review: 'processing',
            resolved: 'completed',
            rejected: 'failed',
        }
        return <Badge variant={variants[status] ?? 'pending'}>{status.replace('_', ' ')}</Badge>
    }

    const statusCounts = useMemo(() => {
        const counts: Record<string, number> = { all: complaints.length, pending: 0, in_review: 0, resolved: 0, rejected: 0 }
        complaints.forEach(c => { if (counts[c.status] !== undefined) counts[c.status]++ })
        return counts
    }, [complaints])

    if (loading) {
        return (
            <div className="flex items-center justify-center py-24">
                <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
        )
    }

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                    Order complaints filed before the support-threads system. Kept for 30 days.
                </p>
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => fetchComplaints(true)}
                    disabled={refreshing}
                    className="gap-2 shrink-0"
                >
                    <RefreshCw className={cn('w-4 h-4', refreshing && 'animate-spin')} />
                    Refresh
                </Button>
            </div>

            {/* Filters */}
            <div className="space-y-3">
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                    <Input
                        placeholder="Search by name, email, order ref, or issue..."
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        className="pl-9 pr-9"
                    />
                    {search && (
                        <button
                            onClick={() => setSearch('')}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    )}
                </div>

                <div className="flex flex-wrap gap-2 items-center">
                    <Select value={statusFilter} onValueChange={v => setStatusFilter(v as StatusFilter)}>
                        <SelectTrigger className="w-[150px] h-9 text-sm">
                            <Filter className="w-3.5 h-3.5 mr-1.5 text-muted-foreground" />
                            <SelectValue placeholder="Status" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All Status <span className="text-muted-foreground">({statusCounts.all})</span></SelectItem>
                            <SelectItem value="pending">Pending <span className="text-muted-foreground">({statusCounts.pending})</span></SelectItem>
                            <SelectItem value="in_review">In Review <span className="text-muted-foreground">({statusCounts.in_review})</span></SelectItem>
                            <SelectItem value="resolved">Resolved <span className="text-muted-foreground">({statusCounts.resolved})</span></SelectItem>
                            <SelectItem value="rejected">Rejected <span className="text-muted-foreground">({statusCounts.rejected})</span></SelectItem>
                        </SelectContent>
                    </Select>

                    <Select value={datePreset} onValueChange={v => setDatePreset(v as DatePreset)}>
                        <SelectTrigger className="w-[140px] h-9 text-sm">
                            <Calendar className="w-3.5 h-3.5 mr-1.5 text-muted-foreground" />
                            <SelectValue placeholder="Date" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">Last 30 Days</SelectItem>
                            <SelectItem value="today">Today</SelectItem>
                            <SelectItem value="yesterday">Yesterday</SelectItem>
                            <SelectItem value="week">Last 7 Days</SelectItem>
                            <SelectItem value="custom">Custom Range</SelectItem>
                        </SelectContent>
                    </Select>

                    {hasActiveFilters && (
                        <Button variant="ghost" size="sm" onClick={clearFilters} className="h-9 text-muted-foreground hover:text-foreground gap-1.5">
                            <X className="w-3.5 h-3.5" />
                            Clear
                        </Button>
                    )}

                    <span className="text-xs text-muted-foreground ml-auto">
                        {filteredComplaints.length} of {complaints.length} complaint{complaints.length !== 1 ? 's' : ''}
                    </span>
                </div>

                {datePreset === 'custom' && (
                    <div className="flex flex-wrap gap-2 items-center">
                        <div className="flex items-center gap-2">
                            <label className="text-xs text-muted-foreground whitespace-nowrap">From</label>
                            <Input
                                type="date"
                                value={customFrom}
                                onChange={e => setCustomFrom(e.target.value)}
                                className="h-9 text-sm w-auto"
                            />
                        </div>
                        <div className="flex items-center gap-2">
                            <label className="text-xs text-muted-foreground whitespace-nowrap">To</label>
                            <Input
                                type="date"
                                value={customTo}
                                onChange={e => setCustomTo(e.target.value)}
                                className="h-9 text-sm w-auto"
                            />
                        </div>
                    </div>
                )}
            </div>

            {/* Desktop Table */}
            <div className="hidden md:block">
                <Card>
                    <CardContent className="p-0">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>User</TableHead>
                                    <TableHead>Order Ref</TableHead>
                                    <TableHead>Order Date</TableHead>
                                    <TableHead>Beneficiary</TableHead>
                                    <TableHead>Package</TableHead>
                                    <TableHead>Supplier</TableHead>
                                    <TableHead>Issue</TableHead>
                                    <TableHead>Status</TableHead>
                                    <TableHead>Filed</TableHead>
                                    <TableHead className="text-right">Actions</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {filteredComplaints.length === 0 ? (
                                    <TableRow>
                                        <TableCell colSpan={10} className="text-center py-12 text-muted-foreground">
                                            {hasActiveFilters ? (
                                                <div className="space-y-1">
                                                    <p>No complaints match your filters.</p>
                                                    <button onClick={clearFilters} className="text-sm text-primary underline underline-offset-4">
                                                        Clear filters
                                                    </button>
                                                </div>
                                            ) : 'No complaints found'}
                                        </TableCell>
                                    </TableRow>
                                ) : (
                                    filteredComplaints.map((complaint) => (
                                        <TableRow key={complaint.id}>
                                            <TableCell>
                                                <div className="flex flex-col">
                                                    <span className="font-medium">{complaint.users?.first_name} {complaint.users?.last_name}</span>
                                                    <span className="text-xs text-muted-foreground">{complaint.users?.email}</span>
                                                    {complaint.orders?.shop_name && (
                                                        <Badge variant="outline" className="mt-1 w-fit bg-emerald-50 text-emerald-700 border-emerald-200 text-[10px] py-0 px-1.5 h-auto">
                                                            Shop: {complaint.orders.shop_name}
                                                        </Badge>
                                                    )}
                                                </div>
                                            </TableCell>
                                            <TableCell className="font-mono text-sm">
                                                {complaint.orders?.reference_code}
                                            </TableCell>
                                            <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                                                {complaint.orders?.created_at ? formatDate(complaint.orders.created_at) : '-'}
                                            </TableCell>
                                            <TableCell>
                                                <span className="font-mono text-sm">{complaint.orders?.phone_number}</span>
                                            </TableCell>
                                            <TableCell>
                                                <div className="flex flex-col">
                                                    <span className="font-medium capitalize">{complaint.orders?.network}</span>
                                                    <span className="text-xs text-muted-foreground">{complaint.orders?.size}</span>
                                                </div>
                                            </TableCell>
                                            <TableCell><SupplierBadge order={complaint.orders} /></TableCell>
                                            <TableCell className="max-w-[180px] truncate">{complaint.title}</TableCell>
                                            <TableCell>{getStatusBadge(complaint.status)}</TableCell>
                                            <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                                                {formatDate(complaint.created_at)}
                                            </TableCell>
                                            <TableCell className="text-right">
                                                <Button variant="outline" size="sm" onClick={() => setSelectedComplaint(complaint)}>
                                                    View
                                                </Button>
                                            </TableCell>
                                        </TableRow>
                                    ))
                                )}
                            </TableBody>
                        </Table>
                    </CardContent>
                </Card>
            </div>

            {/* Mobile Cards */}
            <div className="grid grid-cols-1 gap-3 md:hidden">
                {filteredComplaints.length === 0 ? (
                    <div className="py-12 text-center text-muted-foreground">
                        {hasActiveFilters ? (
                            <div className="space-y-2">
                                <p className="text-sm">No complaints match your filters.</p>
                                <button onClick={clearFilters} className="text-sm text-primary underline underline-offset-4">
                                    Clear filters
                                </button>
                            </div>
                        ) : (
                            <p className="text-sm">No complaints found</p>
                        )}
                    </div>
                ) : (
                    filteredComplaints.map((complaint) => (
                        <Card key={complaint.id} className="overflow-hidden">
                            <CardContent className="p-4 space-y-3">
                                <div className="flex items-start justify-between gap-2">
                                    <div>
                                        <span className="font-medium text-sm">{complaint.users?.first_name} {complaint.users?.last_name}</span>
                                        <span className="text-xs text-muted-foreground block">{complaint.users?.email}</span>
                                        {complaint.orders?.shop_name && (
                                            <Badge variant="outline" className="mt-1 bg-emerald-50 text-emerald-700 border-emerald-200 text-[10px]">
                                                Shop: {complaint.orders.shop_name}
                                            </Badge>
                                        )}
                                    </div>
                                    {getStatusBadge(complaint.status)}
                                </div>

                                <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm bg-muted/40 p-3 rounded-lg">
                                    <div className="col-span-2">
                                        <span className="text-muted-foreground text-xs block">Order Ref</span>
                                        <span className="font-mono text-xs">{complaint.orders?.reference_code ?? '—'}</span>
                                        {complaint.orders?.created_at && (
                                            <span className="text-xs text-muted-foreground block">{formatDate(complaint.orders.created_at)}</span>
                                        )}
                                    </div>
                                    <div>
                                        <span className="text-muted-foreground text-xs block">Beneficiary</span>
                                        <span className="font-mono text-xs">{complaint.orders?.phone_number ?? '—'}</span>
                                    </div>
                                    <div>
                                        <span className="text-muted-foreground text-xs block">Package</span>
                                        <span className="text-xs capitalize">{complaint.orders?.network} {complaint.orders?.size}</span>
                                    </div>
                                    <div>
                                        <span className="text-muted-foreground text-xs block">Supplier</span>
                                        <SupplierBadge order={complaint.orders} />
                                    </div>
                                </div>

                                <div>
                                    <p className="text-sm font-medium leading-snug">{complaint.title}</p>
                                    <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{complaint.description}</p>
                                </div>

                                <div className="flex items-center justify-between pt-2 border-t">
                                    <span className="text-xs text-muted-foreground">{formatDate(complaint.created_at)}</span>
                                    <Button size="sm" variant="outline" onClick={() => setSelectedComplaint(complaint)}>
                                        View Details
                                    </Button>
                                </div>
                            </CardContent>
                        </Card>
                    ))
                )}
            </div>

            {/* Detail/Resolution Dialog */}
            <Dialog open={!!selectedComplaint} onOpenChange={() => { setSelectedComplaint(null); setResolutionNotes('') }}>
                <DialogContent className="max-w-lg w-[calc(100vw-2rem)] sm:w-full">
                    <DialogHeader>
                        <DialogTitle>Complaint Details</DialogTitle>
                        <DialogDescription asChild>
                            <div>
                                <span>Order: {selectedComplaint?.orders?.reference_code ?? '—'}</span>
                                {selectedComplaint?.orders?.shop_name && (
                                    <span className="block text-emerald-600 font-semibold mt-1">
                                        Reseller Shop: {selectedComplaint.orders.shop_name}
                                    </span>
                                )}
                            </div>
                        </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-4 py-2">
                        <div className="flex items-center gap-2 flex-wrap">
                            {getStatusBadge(selectedComplaint?.status ?? 'pending')}
                            <span className="text-xs text-muted-foreground">{selectedComplaint ? formatDate(selectedComplaint.created_at) : ''}</span>
                        </div>

                        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm bg-muted/40 p-3 rounded-lg">
                            <div>
                                <span className="text-muted-foreground text-xs block">Beneficiary</span>
                                <span className="font-mono text-xs">{selectedComplaint?.orders?.phone_number ?? '—'}</span>
                            </div>
                            <div>
                                <span className="text-muted-foreground text-xs block">Order placed</span>
                                <span className="text-xs">{selectedComplaint?.orders?.created_at ? formatDate(selectedComplaint.orders.created_at) : '—'}</span>
                            </div>
                            <div>
                                <span className="text-muted-foreground text-xs block">Supplier</span>
                                <SupplierBadge order={selectedComplaint?.orders} />
                            </div>
                        </div>

                        <div className="p-3 bg-muted rounded-lg">
                            <h4 className="font-semibold text-sm mb-1">{selectedComplaint?.title}</h4>
                            <p className="text-sm text-muted-foreground">{selectedComplaint?.description}</p>
                        </div>

                        {selectedComplaint?.status === 'pending' || selectedComplaint?.status === 'in_review' ? (
                            <div className="space-y-2">
                                <label className="text-sm font-medium">Resolution Notes</label>
                                <Textarea
                                    placeholder="Explain the resolution or rejection reason..."
                                    value={resolutionNotes}
                                    onChange={(e) => setResolutionNotes(e.target.value)}
                                    rows={4}
                                />
                            </div>
                        ) : (
                            <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
                                <h4 className="font-semibold text-sm mb-1">Resolution</h4>
                                <p className="text-sm">{selectedComplaint?.resolution_notes}</p>
                            </div>
                        )}
                    </div>

                    <DialogFooter className="gap-2 sm:gap-0">
                        {(selectedComplaint?.status === 'pending' || selectedComplaint?.status === 'in_review') ? (
                            <>
                                <Button variant="outline" onClick={() => handleResolve('rejected')} disabled={isResolving}>
                                    {isResolving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                                    Reject
                                </Button>
                                <Button onClick={() => handleResolve('resolved')} disabled={isResolving}>
                                    {isResolving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                                    Mark Resolved
                                </Button>
                            </>
                        ) : (
                            <Button variant="outline" onClick={() => { setSelectedComplaint(null); setResolutionNotes('') }}>
                                Close
                            </Button>
                        )}
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}

// ─── Page shell ───────────────────────────────────────────────────────────────

export default function AdminSupportComplaintsPage() {
    const [tab, setTab] = useState<'threads' | 'legacy'>('threads')

    return (
        <div className="space-y-4 sm:space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                    <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Support &amp; Complaints</h1>
                    <p className="text-sm text-muted-foreground">Chat with users, resolve issues, and close complaints</p>
                </div>
                <div className="inline-flex rounded-lg border p-0.5 self-start sm:self-auto">
                    <button
                        onClick={() => setTab('threads')}
                        className={cn(
                            'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors',
                            tab === 'threads' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                        )}
                    >
                        <MessageSquare className="w-3.5 h-3.5" /> Threads
                    </button>
                    <button
                        onClick={() => setTab('legacy')}
                        className={cn(
                            'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors',
                            tab === 'legacy' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                        )}
                    >
                        <Archive className="w-3.5 h-3.5" /> Legacy
                    </button>
                </div>
            </div>

            {tab === 'threads' ? <ThreadsConsole /> : <LegacyComplaints />}
        </div>
    )
}
