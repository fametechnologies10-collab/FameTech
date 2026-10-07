'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { supabase } from '@/lib/supabase'
import { formatDate, normalizeWhatsAppNumber, cn } from '@/lib/utils'
import { getSupportContacts, SupportContacts } from '@/app/actions/support'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
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
    MessageSquare, Loader2, Send, ArrowLeft, Plus, Phone, Mail,
    ChevronDown, CheckCircle2, XCircle, Headphones, Lock,
    Bell, X, ExternalLink,
} from 'lucide-react'
import { WhatsAppIcon } from '@/components/icons/whatsapp-icon'
import { toast } from '@/lib/toast'
import { Complaint } from '@/types/supabase'
import { usePushNotifications } from '@/hooks/usePushNotifications'

interface SupportThread {
    id: string
    user_id: string
    order_id: string | null
    subject: string
    category: 'order' | 'payment' | 'account' | 'other'
    status: 'open' | 'closed'
    last_message_at: string
    created_at: string
}

interface SupportMessage {
    id: string
    thread_id: string
    sender_role: 'user' | 'admin'
    body: string
    read_by_user_at: string | null
    created_at: string
}

const GH_PHONE_RE = /^(0|\+233)[2-9][0-9]{8}$/

function PresenceBadge({ active }: { active: boolean | null }) {
    if (active === null) return null
    return (
        <span className={cn(
            'inline-flex items-center gap-1.5 text-[10px] font-medium px-1.5 py-0.5 rounded-full',
            active
                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
        )}>
            <span className={cn('w-1.5 h-1.5 rounded-full', active ? 'bg-emerald-500' : 'bg-amber-500')} />
            {active ? 'Support active now' : 'Support away'}
        </span>
    )
}

const CATEGORY_LABELS: Record<SupportThread['category'], string> = {
    order: 'Order issue',
    payment: 'Payment',
    account: 'Account',
    other: 'Other',
}

export default function SupportComplaintsPage() {
    const { dbUser } = useAuth()

    const [contacts, setContacts] = useState<SupportContacts | null>(null)
    const [threads, setThreads] = useState<SupportThread[]>([])
    const [unreadByThread, setUnreadByThread] = useState<Record<string, number>>({})
    const [loadingThreads, setLoadingThreads] = useState(true)
    const [selectedThread, setSelectedThread] = useState<SupportThread | null>(null)
    const [messages, setMessages] = useState<SupportMessage[]>([])
    const [loadingMessages, setLoadingMessages] = useState(false)
    const [composer, setComposer] = useState('')
    const [sending, setSending] = useState(false)

    // New-complaint dialog
    const [showNew, setShowNew] = useState(false)
    const [subject, setSubject] = useState('')
    const [category, setCategory] = useState<SupportThread['category']>('other')
    const [firstMessage, setFirstMessage] = useState('')
    const [phone, setPhone] = useState('')
    const [whatsapp, setWhatsapp] = useState('')
    const [submitting, setSubmitting] = useState(false)

    // Legacy order complaints (read-only history)
    const [legacy, setLegacy] = useState<Complaint[]>([])
    const [showLegacy, setShowLegacy] = useState(false)

    // Support "active now" badge — heartbeat-based, not real presence (see
    // lib/admin-presence.ts). Polled lightly; never blocks the chat UI.
    const [supportActive, setSupportActive] = useState<boolean | null>(null)
    useEffect(() => {
        let cancelled = false
        const poll = async () => {
            try {
                const res = await fetch('/api/support/presence')
                const json = await res.json()
                if (!cancelled && res.ok && json.success) setSupportActive(json.data.active)
            } catch { /* transient — keep last known state */ }
        }
        poll()
        const interval = setInterval(poll, 45_000)
        return () => { cancelled = true; clearInterval(interval) }
    }, [])

    // Contextual push prompt — admin replies land as web push, so nudge users
    // who start a chat without notifications enabled. Dismissal lasts the session.
    const { permission, isSupported, isSubscribing, requestPermission } = usePushNotifications()
    const [pushPromptDismissed, setPushPromptDismissed] = useState(true)
    useEffect(() => {
        try {
            setPushPromptDismissed(sessionStorage.getItem('support-push-prompt-dismissed') === '1')
        } catch { setPushPromptDismissed(false) }
    }, [])
    const dismissPushPrompt = () => {
        setPushPromptDismissed(true)
        try { sessionStorage.setItem('support-push-prompt-dismissed', '1') } catch { /* private mode */ }
    }
    const showPushPrompt = isSupported && permission === 'default' && !pushPromptDismissed

    const scrollRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        getSupportContacts().then(setContacts).catch(() => setContacts(null))
    }, [])

    useEffect(() => {
        if (dbUser?.phone_number) setPhone(prev => prev || (dbUser as any).phone_number)
    }, [dbUser])

    const fetchThreads = useCallback(async () => {
        if (!dbUser?.id) return
        try {
            const [{ data: threadRows }, { data: unreadRows }] = await Promise.all([
                (supabase as any)
                    .from('support_threads')
                    .select('*')
                    .order('last_message_at', { ascending: false }),
                (supabase as any)
                    .from('support_messages')
                    .select('thread_id')
                    .eq('sender_role', 'admin')
                    .is('read_by_user_at', null),
            ])
            setThreads(threadRows || [])
            const unread: Record<string, number> = {}
            for (const row of unreadRows || []) {
                unread[row.thread_id] = (unread[row.thread_id] || 0) + 1
            }
            setUnreadByThread(unread)
        } catch (error) {
            console.error('Error fetching support threads:', error)
        } finally {
            setLoadingThreads(false)
        }
    }, [dbUser?.id])

    const fetchLegacy = useCallback(async () => {
        if (!dbUser?.id) return
        try {
            const { data } = await (supabase
                .from('complaints')
                .select('*, orders (reference_code, network, size)')
                .eq('user_id', dbUser.id)
                .order('created_at', { ascending: false }) as any)
            setLegacy(data || [])
        } catch (error) {
            console.error('Error fetching legacy complaints:', error)
        }
    }, [dbUser?.id])

    useEffect(() => {
        fetchThreads()
        fetchLegacy()
    }, [fetchThreads, fetchLegacy])

    // Ref mirrors so the realtime callback sees current state without resubscribing.
    const selectedThreadIdRef = useRef<string | null>(null)
    useEffect(() => { selectedThreadIdRef.current = selectedThread?.id ?? null }, [selectedThread?.id])
    const threadIdsRef = useRef<Set<string>>(new Set())
    useEffect(() => { threadIdsRef.current = new Set(threads.map(t => t.id)) }, [threads])

    // Live updates: new messages in my threads + thread status changes.
    // RLS scopes both subscriptions to rows this user may SELECT.
    useEffect(() => {
        if (!dbUser?.id) return
        const channel = supabase
            .channel(`support-${dbUser.id}`)
            .on('postgres_changes' as any,
                { event: 'INSERT', schema: 'public', table: 'support_messages' },
                (payload: any) => {
                    const msg = payload.new as SupportMessage
                    if (!msg?.thread_id) return
                    // RLS already scopes broadcasts to this user's threads; this
                    // client-side guard is defense-in-depth against upstream regressions.
                    if (!threadIdsRef.current.has(msg.thread_id)) return
                    setMessages(prev =>
                        msg.thread_id === selectedThreadIdRef.current && !prev.some(m => m.id === msg.id)
                            ? [...prev, msg]
                            : prev
                    )
                    if (msg.sender_role === 'admin' && msg.thread_id !== selectedThreadIdRef.current) {
                        setUnreadByThread(prev => ({ ...prev, [msg.thread_id]: (prev[msg.thread_id] || 0) + 1 }))
                    }
                    // Realtime delivery to an open client counts as "delivered" —
                    // the grey double-tick admin sees, independent of "read".
                    if (msg.sender_role === 'admin') {
                        (supabase as any)
                            .from('support_messages')
                            .update({ delivered_to_user_at: new Date().toISOString() })
                            .eq('id', msg.id)
                            .then(() => {})
                    }
                    setThreads(prev => {
                        const next = prev.map(t => t.id === msg.thread_id ? { ...t, last_message_at: msg.created_at } : t)
                        return next.sort((a, b) => +new Date(b.last_message_at) - +new Date(a.last_message_at))
                    })
                })
            .on('postgres_changes' as any,
                { event: 'UPDATE', schema: 'public', table: 'support_threads', filter: `user_id=eq.${dbUser.id}` },
                (payload: any) => {
                    const updated = payload.new as SupportThread
                    if (!updated?.id) return
                    setThreads(prev => prev.map(t => t.id === updated.id ? { ...t, ...updated } : t))
                    setSelectedThread(prev => prev?.id === updated.id ? { ...prev, ...updated } : prev)
                })
            .subscribe()
        return () => { supabase.removeChannel(channel) }
    }, [dbUser?.id])

    const openThread = async (thread: SupportThread) => {
        setSelectedThread(thread)
        setLoadingMessages(true)
        setMessages([])
        try {
            // Explicit column list — read_by_admin_at (admin read-receipts) is not
            // part of the user-facing contract, so don't ship it to the browser.
            const { data } = await (supabase as any)
                .from('support_messages')
                .select('id, thread_id, sender_role, body, read_by_user_at, created_at')
                .eq('thread_id', thread.id)
                .order('created_at', { ascending: true })
            setMessages(data || [])
            // Mark admin messages delivered + read (column-level grant allows only
            // the two user-direction columns).
            const now = new Date().toISOString()
            await (supabase as any)
                .from('support_messages')
                .update({ read_by_user_at: now, delivered_to_user_at: now })
                .eq('thread_id', thread.id)
                .eq('sender_role', 'admin')
                .is('read_by_user_at', null)
            setUnreadByThread(prev => ({ ...prev, [thread.id]: 0 }))
        } catch (error) {
            console.error('Error loading messages:', error)
        } finally {
            setLoadingMessages(false)
        }
    }

    useEffect(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }, [messages.length, selectedThread?.id])

    const handleSend = async () => {
        const text = composer.trim()
        if (!text || !selectedThread || sending) return
        setSending(true)
        try {
            const res = await fetch(`/api/support/threads/${selectedThread.id}/messages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: text }),
            })
            const json = await res.json()
            if (!res.ok || !json.success) throw new Error(json.error || 'Failed to send message')
            setComposer('')
            const sent = json.data.message as SupportMessage
            setMessages(prev => prev.some(m => m.id === sent.id) ? prev : [...prev, sent])
        } catch (error: any) {
            toast.error(error?.message || 'Failed to send message')
        } finally {
            setSending(false)
        }
    }

    const resetNewForm = () => {
        setSubject('')
        setCategory('other')
        setFirstMessage('')
        setWhatsapp('')
        setPhone((dbUser as any)?.phone_number || '')
    }

    const handleCreate = async () => {
        if (submitting) return
        if (subject.trim().length < 3) { toast.error('Please enter a short subject'); return }
        if (firstMessage.trim().length < 5) { toast.error('Please describe your issue'); return }
        if (!GH_PHONE_RE.test(phone.trim())) { toast.error('Enter a valid Ghanaian phone number'); return }
        if (!GH_PHONE_RE.test(whatsapp.trim())) { toast.error('Enter a valid WhatsApp number'); return }
        setSubmitting(true)
        try {
            const res = await fetch('/api/support/threads', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    subject: subject.trim(),
                    category,
                    message: firstMessage.trim(),
                    phone_number: phone.trim(),
                    whatsapp_number: whatsapp.trim(),
                }),
            })
            const json = await res.json()
            if (!res.ok || !json.success) throw new Error(json.error || 'Failed to open complaint')
            toast.success('Complaint submitted — our team will reply here')
            setShowNew(false)
            resetNewForm()
            const thread = json.data.thread as SupportThread
            setThreads(prev => [thread, ...prev])
            openThread(thread)
        } catch (error: any) {
            toast.error(error?.message || 'Failed to open complaint')
        } finally {
            setSubmitting(false)
        }
    }

    const waLink = (num: string) => `https://wa.me/${normalizeWhatsAppNumber(num)}`

    const contactCards = useMemo(() => {
        if (!contacts) return []
        const cards: { label: string; hint: string; href: string; icon: any }[] = []
        if (contacts.phone) cards.push({ label: 'Call Support', hint: contacts.phone, href: `tel:${contacts.phone}`, icon: Phone })
        if (contacts.email) cards.push({ label: 'Email Support', hint: contacts.email, href: `mailto:${contacts.email}`, icon: Mail })
        return cards
    }, [contacts])

    // WhatsApp surfaces get first-class branded treatment — they are the
    // primary support channel for most users.
    const whatsappLinks = useMemo(() => {
        if (!contacts) return []
        const links: { label: string; sub: string; href: string }[] = []
        if (contacts.communityLink) links.push({
            label: 'WhatsApp Community',
            sub: 'Connect with other users & resellers',
            href: contacts.communityLink,
        })
        if (contacts.groupLink) links.push({
            label: 'Official Group',
            sub: 'Ask questions & get help from the group',
            href: contacts.groupLink,
        })
        if (contacts.channelLink) links.push({
            label: 'Updates Channel',
            sub: 'Announcements, offers & new services',
            href: contacts.channelLink,
        })
        return links
    }, [contacts])

    const openCount = threads.filter(t => t.status === 'open').length

    // Suspended users are deliberately allowed on this page (layout gate exempts
    // it) so they can appeal — give them context instead of a dead end.
    const isSuspendedUser = (dbUser as any)?.status === 'suspended'

    if (loadingThreads) {
        return (
            <div className="flex items-center justify-center py-20">
                <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
        )
    }

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex items-start justify-between gap-3">
                <div>
                    <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Support &amp; Complaints</h1>
                    <p className="text-sm text-muted-foreground mt-0.5">
                        Reach our team directly, or open a complaint and chat with us here.
                    </p>
                </div>
                <Button onClick={() => setShowNew(true)} className="gap-1.5 shrink-0">
                    <Plus className="w-4 h-4" /> <span className="hidden sm:inline">New Complaint</span><span className="sm:hidden">New</span>
                </Button>
            </div>

            {/* Suspension appeal notice */}
            {isSuspendedUser && (
                <div className="rounded-xl border border-amber-300/60 bg-amber-50 dark:bg-amber-900/15 dark:border-amber-700/40 px-4 py-3">
                    <p className="text-sm font-medium text-amber-800 dark:text-amber-300">Your account is suspended</p>
                    <p className="text-xs text-amber-700/90 dark:text-amber-400/90 mt-0.5">
                        You can still use this page — open a complaint below to appeal your suspension, or reach us on WhatsApp.
                    </p>
                </div>
            )}

            {/* Contact hub */}
            {(contacts?.whatsapp || contactCards.length > 0 || whatsappLinks.length > 0) && (
                <div className="space-y-3">
                    {/* WhatsApp Support — the primary channel, prominently branded */}
                    {contacts?.whatsapp && (
                        <a href={waLink(contacts.whatsapp)} target="_blank" rel="noopener noreferrer" className="block">
                            <Card className="border-[#25D366]/40 bg-[#25D366]/5 dark:bg-[#25D366]/10 transition-all hover:border-[#25D366]/70 hover:shadow-md">
                                <CardContent className="p-4 sm:p-5 flex items-center gap-4">
                                    <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-2xl bg-[#25D366] flex items-center justify-center shrink-0 shadow-sm">
                                        <WhatsAppIcon className="w-7 h-7 sm:w-8 sm:h-8 text-white" />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <p className="text-sm sm:text-base font-semibold">WhatsApp Support</p>
                                        <p className="text-xs sm:text-sm text-muted-foreground">
                                            Chat with our support team directly on WhatsApp — the fastest way to reach us.
                                        </p>
                                    </div>
                                    <ExternalLink className="w-4 h-4 text-muted-foreground shrink-0" />
                                </CardContent>
                            </Card>
                        </a>
                    )}

                    {/* Call / Email */}
                    {contactCards.length > 0 && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            {contactCards.map(card => (
                                <a key={card.label} href={card.href} target="_blank" rel="noopener noreferrer">
                                    <Card className="h-full transition-colors hover:border-primary/40">
                                        <CardContent className="p-4 flex items-center gap-3">
                                            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                                                <card.icon className="w-5 h-5 text-primary" />
                                            </div>
                                            <div className="min-w-0">
                                                <p className="text-sm font-medium">{card.label}</p>
                                                <p className="text-xs text-muted-foreground truncate">{card.hint}</p>
                                            </div>
                                        </CardContent>
                                    </Card>
                                </a>
                            ))}
                        </div>
                    )}

                    {/* WhatsApp community, group & channel — branded cards with context */}
                    {whatsappLinks.length > 0 && (
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                            {whatsappLinks.map(link => (
                                <a key={link.label} href={link.href} target="_blank" rel="noopener noreferrer">
                                    <Card className="h-full transition-colors hover:border-[#25D366]/60">
                                        <CardContent className="p-4 flex items-start gap-3">
                                            <div className="w-9 h-9 rounded-xl bg-[#25D366]/15 flex items-center justify-center shrink-0">
                                                <WhatsAppIcon className="w-5 h-5 text-[#25D366]" />
                                            </div>
                                            <div className="min-w-0">
                                                <p className="text-sm font-medium">{link.label}</p>
                                                <p className="text-[11px] text-muted-foreground leading-snug mt-0.5">{link.sub}</p>
                                            </div>
                                        </CardContent>
                                    </Card>
                                </a>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* Threads + chat */}
            <div className="grid grid-cols-1 md:grid-cols-[minmax(260px,340px)_1fr] gap-4">
                {/* Thread list */}
                <div className={cn('space-y-2', selectedThread && 'hidden md:block')}>
                    <div className="flex items-center justify-between px-1">
                        <p className="text-sm font-medium">My Complaints</p>
                        {openCount > 0 && (
                            <span className="text-xs text-muted-foreground">{openCount} open</span>
                        )}
                    </div>
                    {threads.length === 0 ? (
                        <Card className="p-8 text-center">
                            <Headphones className="w-10 h-10 mx-auto text-muted-foreground/40 mb-3" />
                            <p className="text-sm text-muted-foreground">No complaints yet</p>
                            <p className="text-xs text-muted-foreground mt-1">
                                Open one and our team will reply right here.
                            </p>
                        </Card>
                    ) : (
                        threads.map(thread => (
                            <button
                                key={thread.id}
                                onClick={() => openThread(thread)}
                                className={cn(
                                    'w-full text-left rounded-xl border p-3 transition-colors hover:border-primary/40',
                                    selectedThread?.id === thread.id && 'border-primary/60 bg-muted/40'
                                )}
                            >
                                <div className="flex items-center justify-between gap-2">
                                    <p className="text-sm font-medium truncate">{thread.subject}</p>
                                    {(unreadByThread[thread.id] || 0) > 0 && (
                                        <span className="shrink-0 min-w-5 h-5 px-1.5 rounded-full bg-primary text-primary-foreground text-[10px] font-semibold flex items-center justify-center">
                                            {unreadByThread[thread.id]}
                                        </span>
                                    )}
                                </div>
                                <div className="flex items-center gap-2 mt-1.5">
                                    <Badge variant={thread.status === 'open' ? 'processing' : 'completed'} className="text-[10px] py-0 h-5">
                                        {thread.status}
                                    </Badge>
                                    <span className="text-[11px] text-muted-foreground">{CATEGORY_LABELS[thread.category]}</span>
                                    <span className="text-[11px] text-muted-foreground ml-auto">{formatDate(thread.last_message_at)}</span>
                                </div>
                            </button>
                        ))
                    )}
                </div>

                {/* Chat pane */}
                <div className={cn(!selectedThread && 'hidden md:block')}>
                    {!selectedThread ? (
                        <Card className="h-full min-h-[320px] flex items-center justify-center">
                            <div className="text-center px-6">
                                <MessageSquare className="w-10 h-10 mx-auto text-muted-foreground/40 mb-3" />
                                <p className="text-sm text-muted-foreground">Select a complaint to view the conversation</p>
                            </div>
                        </Card>
                    ) : (
                        <Card className="flex flex-col h-[520px] max-h-[70vh] overflow-hidden">
                            {/* Chat header */}
                            <div className="px-4 py-3 border-b flex items-center gap-3 bg-gradient-to-r from-background to-muted/30">
                                <button
                                    onClick={() => setSelectedThread(null)}
                                    className="md:hidden p-1.5 -ml-1.5 rounded-md hover:bg-muted"
                                    aria-label="Back to complaints"
                                >
                                    <ArrowLeft className="w-4 h-4" />
                                </button>
                                <div className="min-w-0 flex-1">
                                    <p className="text-sm font-medium truncate">{selectedThread.subject}</p>
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <p className="text-[11px] text-muted-foreground">
                                            {CATEGORY_LABELS[selectedThread.category]} · opened {formatDate(selectedThread.created_at)}
                                        </p>
                                        {selectedThread.status === 'open' && <PresenceBadge active={supportActive} />}
                                    </div>
                                </div>
                                <Badge variant={selectedThread.status === 'open' ? 'processing' : 'completed'}>
                                    {selectedThread.status}
                                </Badge>
                            </div>

                            {/* Messages */}
                            <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3 bg-gradient-to-b from-muted/10 to-muted/30">
                                {loadingMessages ? (
                                    <div className="flex justify-center py-10">
                                        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                                    </div>
                                ) : (
                                    messages.map(msg => (
                                        <div key={msg.id} className={cn('flex', msg.sender_role === 'user' ? 'justify-end' : 'justify-start')}>
                                            <div className={cn(
                                                'max-w-[85%] sm:max-w-[70%] rounded-2xl px-3.5 py-2.5 text-sm shadow-sm transition-colors',
                                                msg.sender_role === 'user'
                                                    ? 'bg-primary text-primary-foreground rounded-br-md'
                                                    : 'bg-background border rounded-bl-md'
                                            )}>
                                                <p className="whitespace-pre-wrap break-words">{msg.body}</p>
                                                <p className={cn(
                                                    'text-[10px] mt-1 text-right',
                                                    msg.sender_role === 'user' ? 'text-primary-foreground/70' : 'text-muted-foreground'
                                                )}>
                                                    {formatDate(msg.created_at)}
                                                </p>
                                            </div>
                                        </div>
                                    ))
                                )}
                            </div>

                            {/* Contextual push prompt — shown while chatting without notifications */}
                            {selectedThread.status === 'open' && showPushPrompt && (
                                <div className="px-3 py-2.5 border-t bg-primary/5 flex items-center gap-2.5">
                                    <Bell className="w-4 h-4 text-primary shrink-0" />
                                    <p className="text-xs text-muted-foreground flex-1 min-w-0">
                                        Get notified the moment support replies — even when you close this page.
                                    </p>
                                    <Button
                                        size="sm"
                                        onClick={() => requestPermission()}
                                        disabled={isSubscribing}
                                        className="h-7 px-2.5 text-xs shrink-0"
                                    >
                                        {isSubscribing ? 'Enabling…' : 'Enable'}
                                    </Button>
                                    <button
                                        onClick={dismissPushPrompt}
                                        aria-label="Dismiss notification prompt"
                                        className="p-1 rounded-md text-muted-foreground hover:text-foreground shrink-0"
                                    >
                                        <X className="w-3.5 h-3.5" />
                                    </button>
                                </div>
                            )}
                            {selectedThread.status === 'open' && isSupported && permission === 'denied' && !pushPromptDismissed && (
                                <div className="px-3 py-1.5 border-t">
                                    <p className="text-[11px] text-muted-foreground">
                                        Notifications are blocked — enable them in your browser settings to hear back instantly.
                                    </p>
                                </div>
                            )}

                            {/* Composer / closed notice */}
                            {selectedThread.status === 'open' ? (
                                <form
                                    onSubmit={e => { e.preventDefault(); handleSend() }}
                                    className="p-3 border-t flex items-center gap-2"
                                >
                                    <Input
                                        value={composer}
                                        onChange={e => setComposer(e.target.value)}
                                        placeholder="Type a message…"
                                        maxLength={1000}
                                        className="flex-1 rounded-full bg-muted/50 border-transparent focus-visible:bg-background"
                                    />
                                    <Button type="submit" size="icon" className="rounded-full shrink-0" disabled={!composer.trim() || sending} aria-label="Send message">
                                        {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                                    </Button>
                                </form>
                            ) : (
                                <div className="p-3 border-t flex items-center justify-between gap-3 bg-muted/30">
                                    <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                                        <Lock className="w-3.5 h-3.5" /> This complaint is closed.
                                    </p>
                                    <Button size="sm" variant="outline" onClick={() => setShowNew(true)} className="gap-1">
                                        <Plus className="w-3.5 h-3.5" /> New Complaint
                                    </Button>
                                </div>
                            )}
                        </Card>
                    )}
                </div>
            </div>

            {/* Legacy order complaints */}
            {legacy.length > 0 && (
                <div className="border rounded-xl">
                    <button
                        onClick={() => setShowLegacy(v => !v)}
                        className="w-full flex items-center justify-between px-4 py-3 text-sm text-muted-foreground hover:text-foreground"
                    >
                        <span>Past order complaints ({legacy.length})</span>
                        <ChevronDown className={cn('w-4 h-4 transition-transform', showLegacy && 'rotate-180')} />
                    </button>
                    {showLegacy && (
                        <div className="px-4 pb-4 space-y-3">
                            <p className="text-xs text-muted-foreground">
                                Order complaints filed before the new support system. They are kept for 30 days.
                            </p>
                            {legacy.map(c => (
                                <div key={c.id} className="rounded-lg border p-3">
                                    <div className="flex items-start justify-between gap-2">
                                        <div className="min-w-0">
                                            <p className="text-sm font-medium truncate">{c.title}</p>
                                            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{c.description}</p>
                                        </div>
                                        <div className="flex items-center gap-1.5 shrink-0">
                                            {c.status === 'resolved' ? (
                                                <CheckCircle2 className="w-4 h-4 text-green-600" />
                                            ) : c.status === 'rejected' ? (
                                                <XCircle className="w-4 h-4 text-red-600" />
                                            ) : null}
                                            <span className="text-xs text-muted-foreground capitalize">{(c.status ?? 'pending').replace('_', ' ')}</span>
                                        </div>
                                    </div>
                                    {c.resolution_notes && (
                                        <p className="text-xs text-muted-foreground mt-2 p-2 rounded bg-muted/50">
                                            {c.resolution_notes}
                                        </p>
                                    )}
                                    <p className="text-[11px] text-muted-foreground mt-2">{formatDate(c.created_at ?? '')}</p>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* New complaint dialog */}
            <Dialog open={showNew} onOpenChange={open => { setShowNew(open); if (!open) resetNewForm() }}>
                <DialogContent className="max-w-md w-[calc(100vw-2rem)] sm:w-full max-h-[85vh] overflow-y-auto">
                    <DialogHeader>
                        <DialogTitle>New Complaint</DialogTitle>
                        <DialogDescription>
                            Our team replies here in the chat. For order issues, you can also file directly from My Orders.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-1">
                        <div className="space-y-1.5">
                            <label className="text-sm font-medium">Subject</label>
                            <Input
                                value={subject}
                                onChange={e => setSubject(e.target.value)}
                                placeholder="Short summary of the issue"
                                maxLength={200}
                            />
                        </div>
                        <div className="space-y-1.5">
                            <label className="text-sm font-medium">Category</label>
                            <Select value={category} onValueChange={v => setCategory(v as SupportThread['category'])}>
                                <SelectTrigger>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="order">Order issue</SelectItem>
                                    <SelectItem value="payment">Payment</SelectItem>
                                    <SelectItem value="account">Account</SelectItem>
                                    <SelectItem value="other">Other</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-1.5">
                            <label className="text-sm font-medium">Describe the issue</label>
                            <Textarea
                                value={firstMessage}
                                onChange={e => setFirstMessage(e.target.value)}
                                placeholder="Tell us what happened…"
                                rows={4}
                                maxLength={5000}
                            />
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div className="space-y-1.5">
                                <label className="text-sm font-medium">Phone number</label>
                                <Input
                                    value={phone}
                                    onChange={e => setPhone(e.target.value)}
                                    placeholder="0241234567"
                                    inputMode="tel"
                                />
                            </div>
                            <div className="space-y-1.5">
                                <label className="text-sm font-medium">WhatsApp number</label>
                                <Input
                                    value={whatsapp}
                                    onChange={e => setWhatsapp(e.target.value)}
                                    placeholder="0241234567"
                                    inputMode="tel"
                                />
                            </div>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            We may reach you on WhatsApp or by phone if we need more details.
                        </p>
                    </div>
                    <DialogFooter className="gap-2 sm:gap-0">
                        <Button variant="outline" onClick={() => setShowNew(false)} disabled={submitting}>
                            Cancel
                        </Button>
                        <Button onClick={handleCreate} disabled={submitting}>
                            {submitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                            Submit Complaint
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
