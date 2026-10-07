'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useAuth } from '@/contexts/auth-context'
import { formatCurrency, cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
    Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Switch } from '@/components/ui/switch'
import { calculateSegments } from '@/lib/sms-segments'
import { prepareSmsMessage } from '@/lib/sms-message'
import { parsePhoneNumbersFromText, parsePhoneNumbersFromRows, type ParsedPhoneResult } from '@/lib/phone-import'
import { normalizeGhanaPhone } from '@/lib/phone-normalize'
import * as XLSX from 'xlsx'
import { SenderIdExplainer } from '@/components/sms/sender-id-explainer'
import { SmsAcceptanceGate } from '@/components/sms/sms-acceptance-gate'
import {
    MessageSquare, ArrowLeft, Loader2, Lock, Wallet, Coins,
    CheckCircle2, Check, AlertCircle, Send, Users, Plus, X, Zap,
    ShieldCheck, Clock, RefreshCcw, Gift, Trash2, BookTemplate,
    ChevronDown, Eye, EyeOff, Smartphone, Copy, CreditCard, BadgeCheck,
    Hourglass, Ban, Upload, FolderPlus, Pencil,
} from 'lucide-react'
import { toast } from '@/lib/toast'

// ── Types ────────────────────────────────────────────────────────────────────

interface SmsTemplate { id: string; name: string; body: string; created_at?: string }
interface SmsBundle   { id: string; name: string; credits: number; price: number }
type SmsLogSource     = 'manual' | 'auto_confirmation' | 'reconciliation'
interface SmsLog      { id: string; message: string; recipients_count: number; segments: number; credits_used: number; status: string; created_at: string; source?: SmsLogSource; delivered_count: number; undelivered_count: number; pending_count: number }
interface SmsUsageBreakdown { manual: number; auto_confirmation: number; reconciliation: number; total: number }

interface SmsStatus {
    enabled: boolean
    activationFee: number
    maxRecipientsPerSend: number
    activated: boolean
    bonusClaimed: boolean
    bonusCreditCount: number
    credits: number
    totalPurchased: number
    totalUsed: number
    bundles: SmsBundle[]
    recentLogs: SmsLog[]
    usageBreakdown: SmsUsageBreakdown
    profitBalance: number
    mainBalance: number
    shopName: string
    shopSlug: string
    shopPhone: string | null
    shopWhatsapp: string | null
    confirmationsEnabled: boolean
    hasApprovedSender: boolean
    adminTemplates: SmsTemplate[]
    shopTemplates: SmsTemplate[]
}

interface CustomerOption { id: string; phone: string; name: string | null }
interface SmsGroup { id: string; name: string; memberCount: number }
type PaySource = 'wallet' | 'profit'

type SenderStatus = 'under_review' | 'approved' | 'rejected' | 'revoked'
interface SenderRow {
    id: string
    sender: string
    status: SenderStatus
    isDefault: boolean
    requestedAt: string | null
    reviewedAt: string | null
    reason: string | null
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const GHANA_RE = /^(0\d{9}|233\d{9}|\+233\d{9})$/

function sanitizeText(v: string) {
    // Strip HTML tags and null bytes — text-only fields
    return v.replace(/<[^>]*>/g, '').replace(/\0/g, '').slice(0, 1000)
}

function insertAtCursor(
    ref: React.RefObject<HTMLTextAreaElement>,
    current: string,
    insert: string,
    setter: (v: string) => void,
) {
    const el = ref.current
    if (!el) { setter(current + insert); return }
    const start = el.selectionStart ?? current.length
    const end   = el.selectionEnd   ?? current.length
    const next  = current.slice(0, start) + insert + current.slice(end)
    setter(next)
    // Restore cursor after the inserted text
    requestAnimationFrame(() => {
        el.selectionStart = el.selectionEnd = start + insert.length
        el.focus()
    })
}

const PHONE_HEADER_ALIASES = ['phone', 'number', 'mobile', 'contact', 'tel']
const NAME_HEADER_ALIASES  = ['name', 'customer', 'full name', 'fullname']

// Header row is optional — if the first row looks like data (has a long
// digit run and no multi-letter word), treat every row as data using the
// first column as the phone and (if present) the second as the name.
function parseSheetRows(sheet: XLSX.WorkSheet): { phone: string; name?: string }[] {
    const raw: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })
    if (raw.length === 0) return []

    const first = raw[0].map(c => String(c).trim())
    const looksLikeHeader = first.some(c => /[a-zA-Z]{3,}/.test(c)) && !first.some(c => /\d{7,}/.test(c))

    let phoneIdx = 0
    let nameIdx = -1
    let dataRows = raw

    if (looksLikeHeader) {
        const headerLower = first.map(h => h.toLowerCase())
        const pIdx = headerLower.findIndex(h => PHONE_HEADER_ALIASES.includes(h))
        const nIdx = headerLower.findIndex(h => NAME_HEADER_ALIASES.includes(h))
        phoneIdx = pIdx >= 0 ? pIdx : 0
        nameIdx = nIdx
        dataRows = raw.slice(1)
    }

    return dataRows
        .map(r => ({
            phone: String(r[phoneIdx] ?? '').trim(),
            name: nameIdx >= 0 ? (String(r[nameIdx] ?? '').trim().slice(0, 100) || undefined) : undefined,
        }))
        .filter(r => r.phone.length > 0)
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ShopSmsPage() {
    const { dbUser } = useAuth()
    const [status, setStatus] = useState<SmsStatus | null>(null)
    const [customers, setCustomers] = useState<CustomerOption[]>([])
    const [loading, setLoading] = useState(true)
    const msgRef = useRef<HTMLTextAreaElement>(null)
    const fileInputRef = useRef<HTMLInputElement>(null)

    // ── Pay source
    const [paySource, setPaySource] = useState<PaySource>('profit')

    // ── Loading states
    const [activating, setActivating]       = useState(false)
    // Synchronous in-flight lock: `activating` only disables the button after a
    // re-render, so two rapid taps could otherwise both send a (paid) activation.
    const activatingRef                     = useRef(false)
    const [claimingBonus, setClaimingBonus] = useState(false)
    const [purchasingId, setPurchasingId]   = useState<string | null>(null)
    const [sending, setSending]             = useState(false)
    const [savingTemplate, setSavingTemplate] = useState(false)
    const [deletingTemplate, setDeletingTemplate] = useState<string | null>(null)

    // ── Dialogs
    const [buyModal, setBuyModal]     = useState<SmsBundle | null>(null)  // bundle to confirm
    const [sendModal, setSendModal]   = useState(false)
    const [tplModal, setTplModal]     = useState(false)  // add template dialog
    const [newTplName, setNewTplName] = useState('')
    const [newTplBody, setNewTplBody] = useState('')
    // In-app replacement for window.confirm() on every destructive action in
    // this page (group/template/sender-ID delete) — same visual language as
    // the rest of the UI instead of the browser's native confirm box.
    const [confirmState, setConfirmState] = useState<{
        title: string
        message: string
        confirmLabel: string
        onConfirm: () => void | Promise<void>
    } | null>(null)
    const [confirming, setConfirming] = useState(false)

    // ── Composer
    const [message, setMessage]             = useState('')
    const [selectedPhones, setSelectedPhones] = useState<Set<string>>(new Set())
    const [manualPhone, setManualPhone]     = useState('')
    const [manualPhones, setManualPhones]   = useState<string[]>([])
    const [importedPhones, setImportedPhones] = useState<string[]>([])
    const [groups, setGroups]                 = useState<SmsGroup[]>([])
    const [selectedGroupIds, setSelectedGroupIds]   = useState<Set<string>>(new Set())
    const [groupMembersCache, setGroupMembersCache] = useState<Record<string, string[]>>({})
    const [showGroups, setShowGroups]         = useState(false)
    const [importModal, setImportModal]       = useState<'paste' | 'upload' | null>(null)
    const [importText, setImportText]         = useState('')
    const [importReview, setImportReview]     = useState<ParsedPhoneResult | null>(null)
    const [importGroupName, setImportGroupName] = useState('')
    const [savingGroup, setSavingGroup]       = useState(false)
    const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null)
    const [renameValue, setRenameValue]         = useState('')
    const [renameSaving, setRenameSaving]       = useState(false)
    const [loadingGroupId, setLoadingGroupId]   = useState<string | null>(null)
    const [deletingGroupId, setDeletingGroupId] = useState<string | null>(null)
    const [showPicker, setShowPicker]       = useState(false)
    const [showPreview, setShowPreview]     = useState(true)
    const [showRules, setShowRules]         = useState(true)
    // Send failure reason (INSUFFICIENT_CREDITS, blocked content, rate limit…)
    // — kept visible inside the Send dialog, not just a toast that can be missed.
    const [sendError, setSendError]         = useState<string | null>(null)

    // ── Local copy of shop templates for optimistic updates
    const [shopTemplates, setShopTemplates] = useState<SmsTemplate[]>([])

    // ── Sender ID requests (Feature Wave 6 Task 2 REDESIGN: single active slot —
    // at most one `approved` sender per shop, and at most one `under_review`
    // request at a time. Requesting while approved is allowed: that's the
    // "replace my current sender" flow, and admin approval auto-revokes the old
    // one, so there is no client-side "set default" action any more.)
    const [senders, setSenders] = useState<SenderRow[]>([])
    const [senderSuggestions, setSenderSuggestions] = useState<string[]>([])
    const [senderInput, setSenderInput] = useState('')
    const [submittingSender, setSubmittingSender] = useState(false)
    const [deletingSenderId, setDeletingSenderId] = useState<string | null>(null)
    // Client validation AND server rejection reasons both land here — a toast
    // alone can be missed, so the exact reason also renders inline by the field.
    const [senderReqError, setSenderReqError] = useState<string | null>(null)

    // ── Automatic order-confirmation SMS opt-out. Mirrored from
    // `status.confirmationsEnabled` on every load so this page and the shop
    // overview (app/dashboard/shop/page.tsx, which hosts the same switch) can
    // never disagree. Held in its own state rather than read straight off
    // `status` so the switch can update optimistically without refetching.
    const [confirmEnabled, setConfirmEnabled]   = useState(true)
    const [savingConfirm, setSavingConfirm]     = useState(false)

    useEffect(() => {
        if (dbUser) fetchAll()
    }, [dbUser])

    const fetchAll = useCallback(async () => {
        try {
            const [statusRes, customersRes, senderRes, suggestionsRes, groupsRes] = await Promise.all([
                fetch('/api/shop/sms/status').then(r => r.json()),
                fetch('/api/shop/customers').then(r => r.json()),
                fetch('/api/shop/sms/sender-request').then(r => r.json()),
                // Purely cosmetic — a failure here must never break the page, so it
                // swallows its own error instead of rejecting the Promise.all.
                fetch('/api/shop/sms/sender-suggestions').then(r => r.json()).catch(() => ({ success: false })),
                fetch('/api/shop/sms/groups').then(r => r.json()).catch(() => ({ success: false })),
            ])
            if (statusRes.success) {
                setStatus(statusRes.data)
                setShopTemplates(statusRes.data.shopTemplates || [])
                // Same default-true convention as the server and the send paths.
                setConfirmEnabled(statusRes.data.confirmationsEnabled !== false)
            } else {
                toast.error(statusRes.error || 'Failed to load SMS status')
            }
            if (customersRes.success) setCustomers(customersRes.data.customers)
            if (senderRes.success) setSenders(senderRes.data.senders || [])
            if (suggestionsRes.success) setSenderSuggestions(suggestionsRes.data.suggestions || [])
            if (groupsRes.success) setGroups(groupsRes.data || [])
        } catch (err) {
            console.error('[ShopSMS]', err)
            toast.error('Failed to load SMS feature')
        } finally {
            setLoading(false)
        }
    }, [])

    // The ONLY thing that blocks a new request is an existing pending one — this
    // mirrors the server's single-pending guard exactly (POST
    // /api/shop/sms/sender-request). An approved sender does NOT block: asking
    // for a new one is how an owner replaces it.
    const pendingSender  = senders.find(s => s.status === 'under_review') ?? null
    const approvedSender = senders.find(s => s.status === 'approved') ?? null

    const handleSenderRequest = async () => {
        const sender = senderInput.trim()
        setSenderReqError(null)
        if (sender.length < 3 || sender.length > 11 || !/^[A-Za-z0-9 ]+$/.test(sender)) {
            const msg = 'Sender ID must be 3-11 characters — letters, numbers and spaces only'
            setSenderReqError(msg)
            toast.error(msg)
            return
        }
        setSubmittingSender(true)
        try {
            const res  = await fetch('/api/shop/sms/sender-request', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sender }),
            })
            const json = await res.json()
            if (!json.success) {
                const msg = json.error || 'Could not submit sender ID request'
                setSenderReqError(msg)
                toast.error(msg)
                return
            }
            toast.success('Sender ID request submitted for review!')
            setSenderInput('')
            await fetchAll()
        } catch (err: any) {
            const msg = err.message || 'Request failed'
            setSenderReqError(msg)
            toast.error(msg)
        } finally {
            setSubmittingSender(false)
        }
    }

    // Owner cleanup for terminal rows only (rejected/revoked) — the server
    // refuses anything else, so this button is never rendered for
    // under_review/approved rows.
    const handleDeleteSender = (senderId: string) => {
        const sender = senders.find(s => s.id === senderId)
        setConfirmState({
            title: 'Remove sender ID?',
            message: sender
                ? `Remove "${sender.sender}"? You'll need to request a new one if you want it back.`
                : 'Remove this sender ID? You\'ll need to request a new one if you want it back.',
            confirmLabel: 'Remove',
            onConfirm: () => doDeleteSender(senderId),
        })
    }

    const doDeleteSender = async (senderId: string) => {
        setDeletingSenderId(senderId)
        try {
            const res  = await fetch('/api/shop/sms/sender-request', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ senderId }),
            })
            const json = await res.json()
            if (!json.success) throw new Error(json.error)
            setSenders(prev => prev.filter(s => s.id !== senderId))
            toast.success('Sender ID removed')
        } catch (err: any) {
            toast.error(err.message || 'Could not delete sender ID')
        } finally {
            setDeletingSenderId(null)
        }
    }

    // ── Derived composer state
    // The compose textarea always stores raw tokens + whatever the owner types.
    // The preview is the EXACT text recipients receive: tokens substituted with
    // real shop values and undeliverable characters (emoji) stripped. It runs
    // through the same `prepareSmsMessage` helper the send route uses, so the
    // preview, the credit cost and the delivered SMS are always identical.
    const previewMessage = useMemo(() => {
        if (!message) return ''
        return prepareSmsMessage(message, {
            shopName:     status?.shopName,
            shopSlug:     status?.shopSlug,
            shopPhone:    status?.shopPhone,
            shopWhatsapp: status?.shopWhatsapp,
        })
    }, [message, status])

    // Billing follows the prepared text (what's actually delivered), so the cost
    // shown matches what the server charges — stripping emoji can lower it.
    const segInfo       = useMemo(() => calculateSegments(previewMessage), [previewMessage])
    const selectedGroupPhones = useMemo(() => {
        const set = new Set<string>()
        for (const id of selectedGroupIds) {
            for (const phone of (groupMembersCache[id] || [])) set.add(phone)
        }
        return set
    }, [selectedGroupIds, groupMembersCache])

    // Numbers come in from four sources in inconsistent formats (customers/
    // manual entries as 0XXXXXXXXX, imported/group numbers as 233XXXXXXXXX) —
    // normalize every number to the same canonical format before deduping, so
    // the same person's number from two sources doesn't count twice toward the
    // recipient count/credit estimate. Falls back to the raw value if
    // normalization fails so nothing silently disappears.
    const allRecipients = useMemo(
        () => [...new Set([
            ...[...selectedPhones].map(p => normalizeGhanaPhone(p) || p),
            ...manualPhones.map(p => normalizeGhanaPhone(p) || p),
            ...importedPhones.map(p => normalizeGhanaPhone(p) || p),
            ...[...selectedGroupPhones].map(p => normalizeGhanaPhone(p) || p),
        ])],
        [selectedPhones, manualPhones, importedPhones, selectedGroupPhones],
    )
    const creditsNeeded = segInfo.segments * allRecipients.length
    const overCap       = status ? allRecipients.length > status.maxRecipientsPerSend : false
    const insufficient  = status ? creditsNeeded > status.credits : false

    // wallet balance for current paySource
    const activeBalance = paySource === 'profit'
        ? (status?.profitBalance ?? 0)
        : (status?.mainBalance   ?? 0)

    // True when the composed message contains characters SMS can't deliver
    // (color emoji etc.) — surfaced as a hint so the owner knows they'll be removed.
    const messageHasEmoji = useMemo(
        () => /[\u{10000}-\u{10FFFF}\u200D\uFE0E\uFE0F\u20E3]/u.test(message),
        [message],
    )

    // ── Handlers ─────────────────────────────────────────────────────────────

    const handleActivate = async () => {
        if (!status || activatingRef.current) return
        activatingRef.current = true
        setActivating(true)
        try {
            const res  = await fetch('/api/shop/sms/activate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ paidFrom: paySource }),
            })
            const json = await res.json()
            if (!json.success) throw new Error(json.error)
            toast.success('SMS activated! Claim your free credits below.')
            await fetchAll()
        } catch (err: any) {
            toast.error(err.message || 'Activation failed')
        } finally {
            activatingRef.current = false
            setActivating(false)
        }
    }

    // Toggle the automatic order-confirmation SMS. Optimistic, reverting on
    // failure so the switch never lies about the saved state (same contract as
    // the copy of this control on the shop overview page). Talks to the
    // existing /api/shop/sms-settings route, which scopes its write to the
    // caller's own shop by owner_id.
    const handleToggleConfirm = async (next: boolean) => {
        const prev = confirmEnabled
        setConfirmEnabled(next)
        setSavingConfirm(true)
        try {
            const res = await fetch('/api/shop/sms-settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: next }),
            })
            const json = await res.json()
            if (!res.ok || !json.success) throw new Error(json.error || 'Failed to update setting')
            toast.success(next ? 'Order confirmations turned on' : 'Order confirmations turned off')
        } catch (err) {
            setConfirmEnabled(prev)
            toast.error(err instanceof Error ? err.message : 'Could not update setting')
        } finally {
            setSavingConfirm(false)
        }
    }

    const handleClaimBonus = async () => {
        setClaimingBonus(true)
        try {
            const res  = await fetch('/api/shop/sms/claim-bonus', { method: 'POST' })
            const json = await res.json()
            if (!json.success) throw new Error(json.error)
            toast.success(`${json.data.creditsAdded} free SMS credits added to your account!`)
            await fetchAll()
        } catch (err: any) {
            toast.error(err.message || 'Claim failed')
        } finally {
            setClaimingBonus(false)
        }
    }

    const handlePurchase = async (bundle: SmsBundle) => {
        setPurchasingId(bundle.id)
        setBuyModal(null)
        try {
            const res  = await fetch('/api/shop/sms/purchase', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ bundleId: bundle.id, paidFrom: paySource }),
            })
            const json = await res.json()
            if (!json.success) throw new Error(json.error)
            toast.success(`${bundle.credits} credits added!`)
            await fetchAll()
        } catch (err: any) {
            toast.error(err.message || 'Purchase failed')
        } finally {
            setPurchasingId(null)
        }
    }

    const handleSend = async () => {
        // Keep the confirm dialog open across the request — a failure reason
        // (INSUFFICIENT_CREDITS, blocked content, rate limit…) needs somewhere
        // visible to land; closing the dialog first would strand it in a toast.
        setSendError(null)
        setSending(true)
        try {
            const res  = await fetch('/api/shop/sms/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: message.trim(), recipients: allRecipients }),
            })
            const json = await res.json()
            if (!json.success) {
                const msg = json.error || 'Send failed'
                setSendError(msg)
                toast.error(msg)
                return
            }
            const { sent, failed, creditsUsed } = json.data
            toast.success(`Sent to ${sent} recipient(s)${failed > 0 ? `, ${failed} failed (refunded)` : ''} · ${creditsUsed} credits used`)
            setMessage('')
            clearAllRecipients()
            setSendModal(false)
            await fetchAll()
        } catch (err: any) {
            const msg = err.message || 'Send failed'
            setSendError(msg)
            toast.error(msg)
        } finally {
            setSending(false)
        }
    }

    const addManualPhone = () => {
        const cleaned = manualPhone.replace(/[\s\-+]/g, '')
        if (!GHANA_RE.test(cleaned)) {
            toast.error('Enter a valid Ghana number (e.g. 0244123456)')
            return
        }
        const norm = cleaned.startsWith('233') ? '0' + cleaned.slice(3) : cleaned
        if (!manualPhones.includes(norm)) setManualPhones(prev => [...prev, norm])
        setManualPhone('')
    }

    const clearAllRecipients = () => {
        setSelectedPhones(new Set())
        setManualPhones([])
        setImportedPhones([])
        setSelectedGroupIds(new Set())
    }

    const toggleCustomer = (phone: string) => {
        setSelectedPhones(prev => {
            const next = new Set(prev)
            next.has(phone) ? next.delete(phone) : next.add(phone)
            return next
        })
    }

    const toggleGroup = async (id: string) => {
        setSelectedGroupIds(prev => {
            const next = new Set(prev)
            next.has(id) ? next.delete(id) : next.add(id)
            return next
        })
        if (!groupMembersCache[id]) {
            setLoadingGroupId(id)
            try {
                const res  = await fetch(`/api/shop/sms/groups/${id}`)
                const json = await res.json()
                if (json.success) {
                    setGroupMembersCache(prev => ({ ...prev, [id]: json.data.members.map((m: any) => m.phone) }))
                } else {
                    toast.error(json.error || 'Failed to load group members')
                    setSelectedGroupIds(prev => {
                        const next = new Set(prev)
                        next.delete(id)
                        return next
                    })
                }
            } catch {
                toast.error('Failed to load group members')
                setSelectedGroupIds(prev => {
                    const next = new Set(prev)
                    next.delete(id)
                    return next
                })
            } finally {
                setLoadingGroupId(null)
            }
        }
    }

    const startRenameGroup = (group: SmsGroup) => {
        setRenamingGroupId(group.id)
        setRenameValue(group.name)
    }

    const commitRenameGroup = async () => {
        if (!renamingGroupId || renameSaving) return
        const name = renameValue.trim()
        if (!name) { toast.error('Group name cannot be empty'); return }
        setRenameSaving(true)
        try {
            const res  = await fetch(`/api/shop/sms/groups/${renamingGroupId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
            })
            const json = await res.json()
            if (!json.success) throw new Error(json.error)
            setGroups(prev => prev.map(g => (g.id === renamingGroupId ? { ...g, name } : g)))
            toast.success('Group renamed')
            setRenamingGroupId(null)
            setRenameValue('')
        } catch (err: any) {
            toast.error(err.message || 'Rename failed')
        } finally {
            setRenameSaving(false)
        }
    }

    const deleteGroup = (id: string) => {
        const group = groups.find(g => g.id === id)
        const label = group ? `"${group.name}"` : 'this group'
        const count = group ? group.memberCount : 0
        setConfirmState({
            title: 'Delete group?',
            message: `Delete ${label}? This removes all ${count} saved number(s). This can't be undone.`,
            confirmLabel: 'Delete',
            onConfirm: () => doDeleteGroup(id),
        })
    }

    const doDeleteGroup = async (id: string) => {
        setDeletingGroupId(id)
        try {
            const res  = await fetch(`/api/shop/sms/groups/${id}`, { method: 'DELETE' })
            const json = await res.json()
            if (!json.success) throw new Error(json.error)
            setGroups(prev => prev.filter(g => g.id !== id))
            setSelectedGroupIds(prev => {
                const next = new Set(prev)
                next.delete(id)
                return next
            })
            setGroupMembersCache(prev => {
                const next = { ...prev }
                delete next[id]
                return next
            })
            toast.success('Group deleted')
        } catch (err: any) {
            toast.error(err.message || 'Delete failed')
        } finally {
            setDeletingGroupId(null)
        }
    }

    const handleConfirmAction = async () => {
        if (!confirmState || confirming) return
        setConfirming(true)
        try {
            await confirmState.onConfirm()
        } finally {
            setConfirming(false)
            setConfirmState(null)
        }
    }

    const closeImportModal = () => {
        setImportModal(null)
        setImportText('')
        setImportReview(null)
        setImportGroupName('')
    }

    const runPasteReview = () => {
        if (importText.trim().length === 0) {
            toast.error('Paste at least one number first')
            return
        }
        setImportReview(parsePhoneNumbersFromText(importText))
    }

    const addReviewedToSend = () => {
        if (!importReview || importReview.valid.length === 0) return
        setImportedPhones(prev => [...new Set([...prev, ...importReview.valid.map(v => v.phone)])])
        toast.success(`Added ${importReview.valid.length} number(s) to this send`)
        closeImportModal()
    }

    const saveReviewedAsGroup = async () => {
        if (!importReview || importReview.valid.length === 0) return
        const name = importGroupName.trim()
        if (!name) { toast.error('Enter a group name'); return }
        setSavingGroup(true)
        try {
            // The server caps a group at 2000 members and truncates silently; trim
            // here too so an upload with 3001-5000 valid numbers (the client's row
            // cap is 5000) doesn't instead trip the POST schema's 3000-entry limit
            // and surface a raw Zod error.
            const numbers = importReview.valid.slice(0, 2000)
            const res  = await fetch('/api/shop/sms/groups', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, numbers }),
            })
            const json = await res.json()
            if (!json.success) throw new Error(json.error)
            toast.success(`Group "${name}" saved with ${json.data.memberCount} number(s)${json.data.truncated ? ' (some numbers were truncated to the 2000 limit)' : ''}`)
            setGroups(prev => [{ id: json.data.id, name: json.data.name, memberCount: json.data.memberCount }, ...prev])
            closeImportModal()
        } catch (err: any) {
            toast.error(err.message || 'Failed to save group')
        } finally {
            setSavingGroup(false)
        }
    }

    const handleFileUpload = async (file: File) => {
        if (file.size > 2 * 1024 * 1024) {
            toast.error('File is too large — max 2MB')
            closeImportModal()
            return
        }
        const ext = file.name.toLowerCase().split('.').pop()
        try {
            if (ext === 'txt') {
                const text = await file.text()
                setImportReview(parsePhoneNumbersFromText(text))
            } else if (ext === 'csv' || ext === 'xlsx') {
                let workbook: XLSX.WorkBook
                if (ext === 'csv') {
                    const text = await file.text()
                    workbook = XLSX.read(text, { type: 'string' })
                } else {
                    const buf = await file.arrayBuffer()
                    workbook = XLSX.read(buf, { type: 'array' })
                }
                const sheet = workbook.Sheets[workbook.SheetNames[0]]
                const rows = parseSheetRows(sheet)
                if (rows.length > 5000) {
                    toast.error('Too many rows — max 5000')
                    closeImportModal()
                    return
                }
                setImportReview(parsePhoneNumbersFromRows(rows))
            } else {
                toast.error('Unsupported file type — use .csv, .txt or .xlsx')
                closeImportModal()
            }
        } catch (err) {
            console.error('[ShopSMS] File parse error:', err)
            toast.error('Could not read this file')
            closeImportModal()
        }
    }

    // Apply template body as-is (tokens intact); preview will substitute real values.
    const applyTemplate = (body: string) => setMessage(sanitizeText(body))

    const handleSaveTemplate = async () => {
        const name = newTplName.trim()
        const body = newTplBody.trim()
        if (!name) { toast.error('Template name is required'); return }
        if (body.length < 3) { toast.error('Template body is too short'); return }
        setSavingTemplate(true)
        try {
            const res  = await fetch('/api/shop/sms/templates', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: sanitizeText(name).slice(0, 60), body: sanitizeText(body) }),
            })
            const json = await res.json()
            if (!json.success) throw new Error(json.error)
            setShopTemplates(prev => [json.data, ...prev])
            setNewTplName('')
            setNewTplBody('')
            setTplModal(false)
            toast.success('Template saved!')
        } catch (err: any) {
            toast.error(err.message || 'Save failed')
        } finally {
            setSavingTemplate(false)
        }
    }

    const handleDeleteTemplate = (id: string) => {
        const tpl = shopTemplates.find(t => t.id === id)
        setConfirmState({
            title: 'Delete template?',
            message: tpl ? `Delete "${tpl.name}"? This can't be undone.` : 'Delete this template? This can\'t be undone.',
            confirmLabel: 'Delete',
            onConfirm: () => doDeleteTemplate(id),
        })
    }

    const doDeleteTemplate = async (id: string) => {
        setDeletingTemplate(id)
        try {
            const res  = await fetch(`/api/shop/sms/templates?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
            const json = await res.json()
            if (!json.success) throw new Error(json.error)
            setShopTemplates(prev => prev.filter(t => t.id !== id))
            toast.success('Template deleted')
        } catch (err: any) {
            toast.error(err.message || 'Delete failed')
        } finally {
            setDeletingTemplate(null)
        }
    }

    const quickInsert = (text: string) => insertAtCursor(msgRef, message, text, setMessage)

    // ── Sub-components ────────────────────────────────────────────────────────

    const WalletCard = ({ label, amount, sub, color }: { label: string; amount: number; sub: string; color: string }) => (
        <Card className={cn('rounded-xl border shadow-sm', color)}>
            <CardContent className="p-2.5 sm:p-3">
                <p className="text-[10px] sm:text-[11px] font-semibold text-muted-foreground truncate">{label}</p>
                <p className="text-sm sm:text-base font-bold tabular-nums truncate mt-0.5">{sub === 'credits' ? amount.toLocaleString() : formatCurrency(amount)}</p>
                <p className="text-[10px] text-muted-foreground/60 mt-0.5 hidden sm:block">{sub}</p>
            </CardContent>
        </Card>
    )

    const PaySourceToggle = ({ showBalance = false }: { showBalance?: boolean }) => (
        <div className="flex p-1 bg-muted rounded-xl gap-1">
            {([
                { id: 'profit' as const, label: 'Profit Wallet', balance: status?.profitBalance ?? 0 },
                { id: 'wallet' as const, label: 'Main Wallet',   balance: status?.mainBalance   ?? 0 },
            ]).map(s => (
                <button
                    key={s.id}
                    type="button"
                    onClick={() => setPaySource(s.id)}
                    className={cn(
                        'flex-1 flex flex-col items-center justify-center gap-0 h-11 rounded-lg text-xs font-semibold transition-all px-2',
                        paySource === s.id ? 'bg-white dark:bg-card shadow-sm text-emerald-600' : 'text-muted-foreground hover:text-foreground',
                    )}
                >
                    <span className="flex items-center gap-1"><Wallet className="w-3 h-3" />{s.label}</span>
                    {showBalance && (
                        <span className={cn('text-[10px] tabular-nums', paySource === s.id ? 'text-emerald-600/80' : 'text-muted-foreground/60')}>
                            {formatCurrency(s.balance)}
                        </span>
                    )}
                </button>
            ))}
        </div>
    )

    // ── Render ────────────────────────────────────────────────────────────────

    if (loading) {
        return (
            <div className="flex items-center justify-center py-20">
                <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
        )
    }
    if (!status) {
        return (
            <div className="text-center py-20 text-muted-foreground text-sm">
                Failed to load SMS feature. <button className="text-emerald-600 underline" onClick={() => { setLoading(true); fetchAll() }}>Retry</button>
            </div>
        )
    }

    // Auth may still be resolving even after status has loaded — the
    // acceptance gate is keyed by dbUser.id, so never mount it (or show real
    // content) until that id is known. Show the same shell used while loading.
    if (!dbUser?.id) {
        return (
            <div className="flex items-center justify-center py-20">
                <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
        )
    }

    // Gate on the prepared text: a message that is only emoji becomes empty once
    // stripped, so it must not be sendable even though the raw box isn't empty.
    const canSend = !sending && allRecipients.length > 0 && previewMessage.trim().length >= 3 && !overCap && !insufficient

    return (
        <SmsAcceptanceGate userId={dbUser.id} product="shop">
        <div className="space-y-5 pb-20 md:pb-6 max-w-2xl lg:max-w-4xl xl:max-w-5xl mx-auto">

            {/* ── Header ── */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                    <Link href="/dashboard/shop">
                        <Button variant="ghost" size="sm" className="w-fit gap-2 -ml-2 text-muted-foreground hover:text-emerald-600">
                            <ArrowLeft className="w-4 h-4" /> Back to Shop Dashboard
                        </Button>
                    </Link>
                    <h1 className="text-xl font-bold flex items-center gap-2 mt-1">
                        <MessageSquare className="w-5 h-5 text-emerald-600" /> Customer SMS
                    </h1>
                    <p className="text-muted-foreground text-sm mt-0.5">Send promos and updates to your customers by SMS.</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => { setLoading(false); fetchAll() }} className="gap-1.5 w-fit shrink-0">
                    <RefreshCcw className="w-3.5 h-3.5" /> Refresh
                </Button>
            </div>

            {/* ── Wallet row ── */}
            <div className="grid grid-cols-3 gap-2 lg:gap-3 lg:max-w-xl">
                <WalletCard label="SMS Credits"    amount={status.credits}       sub="credits"         color="border-purple-200 dark:border-purple-900 bg-purple-50/50 dark:bg-purple-900/10" />
                <WalletCard label="Profit Wallet"  amount={status.profitBalance} sub="available"       color="border-emerald-200 dark:border-emerald-900 bg-emerald-50/50 dark:bg-emerald-900/10" />
                <WalletCard label="Main Wallet"    amount={status.mainBalance}   sub="available"       color="border-blue-200 dark:border-blue-900 bg-blue-50/50 dark:bg-blue-900/10" />
            </div>

            {/* ── Your Sender IDs (single active slot — see the state block above) ── */}
            <Card className="rounded-2xl">
                <CardContent className="p-4 sm:p-5 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                        <h3 className="text-sm font-semibold flex items-center gap-1.5">
                            <BadgeCheck className="w-4 h-4 text-emerald-500" /> Your Sender ID
                        </h3>
                        <span className={cn(
                            'text-[10px] font-black uppercase tracking-wide px-2 py-0.5 rounded-full shrink-0',
                            approvedSender ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                                : pendingSender ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                                : 'bg-muted text-muted-foreground',
                        )}>
                            {approvedSender ? 'Active' : pendingSender ? 'Under review' : 'Not set'}
                        </span>
                    </div>

                    {senders.length === 0 && <SenderIdExplainer variant="full" />}

                    {senders.length > 0 && (
                        <div className="space-y-2">
                            {senders.map(sd => (
                                <div
                                    key={sd.id}
                                    className={cn(
                                        'flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl border',
                                        sd.status === 'approved'
                                            ? 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800'
                                            : sd.status === 'under_review'
                                            ? 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800'
                                            : 'bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-900',
                                    )}
                                >
                                    <div className="flex items-center gap-2.5 min-w-0">
                                        {sd.status === 'approved' ? (
                                            <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
                                        ) : sd.status === 'under_review' ? (
                                            <Hourglass className="w-4 h-4 text-amber-600 flex-shrink-0" />
                                        ) : (
                                            <Ban className="w-4 h-4 text-red-600 flex-shrink-0" />
                                        )}
                                        <div className="min-w-0">
                                            <p className={cn(
                                                'text-sm font-bold font-mono truncate flex items-center gap-1.5',
                                                sd.status === 'approved' ? 'text-emerald-800 dark:text-emerald-300' :
                                                sd.status === 'under_review' ? 'text-amber-800 dark:text-amber-300' :
                                                'text-red-800 dark:text-red-400',
                                            )}>
                                                {sd.sender}
                                                {sd.isDefault && (
                                                    <span className="text-[9px] font-black uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-emerald-600 text-white shrink-0">
                                                        Default
                                                    </span>
                                                )}
                                            </p>
                                            <p className="text-[11px] text-muted-foreground/80">
                                                {sd.status === 'approved'
                                                    ? 'Used for your order confirmations.'
                                                    : sd.status === 'under_review'
                                                    ? 'Pending review by admin.'
                                                    : sd.status === 'rejected'
                                                    ? `Rejected${sd.reason ? `: ${sd.reason}` : ''} — you can request a different sender ID.`
                                                    : `Revoked${sd.reason ? `: ${sd.reason}` : ''} — you can request a new one.`}
                                            </p>
                                        </div>
                                    </div>
                                    {(sd.status === 'rejected' || sd.status === 'revoked') && (
                                        <Button
                                            size="sm" variant="outline"
                                            disabled={deletingSenderId === sd.id}
                                            onClick={() => handleDeleteSender(sd.id)}
                                            className="h-7 w-7 p-0 text-red-500 border-red-200 dark:border-red-900 hover:bg-red-50 dark:hover:bg-red-950/20 shrink-0"
                                            aria-label={`Remove sender ID ${sd.sender}`}
                                        >
                                            {deletingSenderId === sd.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                                        </Button>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}

                    {!pendingSender ? (
                        <div className="space-y-2 pt-1">
                            {approvedSender && (
                                <p className="text-[11px] text-muted-foreground/80 flex items-start gap-1">
                                    <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-px" />
                                    Requesting a new sender ID replaces <span className="font-mono font-semibold">{approvedSender.sender}</span> once it&apos;s approved.
                                </p>
                            )}
                            {/* Suggestions derived from the shop's own name — already
                                charset/blocklist/collision-checked server-side, so a
                                chip can never be a name that would be rejected. */}
                            {senderSuggestions.length > 0 && (
                                <div className="flex flex-wrap gap-1.5">
                                    <span className="text-[10px] font-semibold text-muted-foreground self-center">Suggestions:</span>
                                    {senderSuggestions.map(s => (
                                        <button
                                            key={s}
                                            type="button"
                                            onClick={() => { setSenderReqError(null); setSenderInput(s) }}
                                            className="text-[11px] font-mono font-medium px-2 py-0.5 rounded-full bg-muted hover:bg-emerald-100 dark:hover:bg-emerald-900/20 hover:text-emerald-700 transition-colors border border-transparent hover:border-emerald-200 dark:hover:border-emerald-800"
                                        >
                                            {s}
                                        </button>
                                    ))}
                                </div>
                            )}
                            <div className="flex gap-2">
                                <Input
                                    value={senderInput}
                                    onChange={e => { setSenderReqError(null); setSenderInput(e.target.value.slice(0, 11)) }}
                                    placeholder="e.g. KFT Shop"
                                    className="h-10 font-mono text-sm"
                                    maxLength={11}
                                    autoComplete="off"
                                />
                                <Button
                                    onClick={handleSenderRequest}
                                    disabled={submittingSender || senderInput.trim().length < 3 || !/^[A-Za-z0-9 ]*$/.test(senderInput)}
                                    className="h-10 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold gap-1.5 shrink-0"
                                >
                                    {submittingSender ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                                    {approvedSender ? 'Replace' : 'Request'}
                                </Button>
                            </div>
                            {/* Disabled-reason / server rejection — always visible near the field,
                                never just a toast that can be missed. */}
                            {senderReqError ? (
                                <p className="text-[11px] text-red-600 font-medium flex items-start gap-1">
                                    <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-px" /> {senderReqError}
                                </p>
                            ) : !/^[A-Za-z0-9 ]*$/.test(senderInput) ? (
                                <p className="text-[11px] text-red-600 font-medium flex items-start gap-1">
                                    <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-px" /> Only letters, numbers and spaces are allowed.
                                </p>
                            ) : senderInput.trim().length > 0 && senderInput.trim().length < 3 ? (
                                <p className="text-[11px] text-amber-600 font-medium flex items-start gap-1">
                                    <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-px" /> Enter at least 3 characters — {3 - senderInput.trim().length} more needed.
                                </p>
                            ) : (
                                <p className="text-[10px] text-muted-foreground/70">{senderInput.length}/11 characters · letters, numbers and spaces only.</p>
                            )}
                        </div>
                    ) : (
                        <p className="text-[11px] text-muted-foreground/70 flex items-start gap-1 pt-1">
                            <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-px" />
                            <span className="font-mono font-semibold">{pendingSender.sender}</span>&nbsp;is waiting for admin review — you can submit another once it&apos;s been reviewed.
                        </p>
                    )}
                </CardContent>
            </Card>

            {/* ── Feature disabled ── */}
            {!status.enabled && (
                <div className="text-center py-16 space-y-3">
                    <div className="w-14 h-14 mx-auto rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center">
                        <Lock className="w-6 h-6 text-gray-400" />
                    </div>
                    <p className="font-semibold">SMS is temporarily unavailable</p>
                    <p className="text-sm text-muted-foreground">The admin has disabled this feature. Check back later.</p>
                </div>
            )}

            {/* ── Not yet activated ── */}
            {status.enabled && !status.activated && (
                <div className="max-w-md mx-auto space-y-4">
                    <Card className="border shadow-sm rounded-2xl">
                        <CardContent className="p-6 space-y-4 text-center">
                            <div className="w-16 h-16 mx-auto rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
                                <Lock className="w-7 h-7 text-emerald-600" />
                            </div>
                            <div>
                                <h2 className="text-lg font-bold">Unlock Customer SMS</h2>
                                <p className="text-sm text-muted-foreground mt-1">One-time activation, then pay-as-you-go with SMS bundles.</p>
                            </div>

                            {/* Bonus promo */}
                            <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-left">
                                <Gift className="w-4 h-4 text-amber-600 flex-shrink-0" />
                                <p className="text-xs text-amber-800 dark:text-amber-300 font-medium">
                                    Activate now and get <strong>{status.bonusCreditCount} free SMS credits</strong> to get started!
                                </p>
                            </div>

                            <div className="space-y-2 text-left text-xs text-muted-foreground bg-muted/40 rounded-xl p-4">
                                <p className="flex gap-2"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0 mt-0.5" /> Bulk SMS to your entire customer list in one tap</p>
                                <p className="flex gap-2"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0 mt-0.5" /> Single SMS to any Ghana number</p>
                                <p className="flex gap-2"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0 mt-0.5" /> Live character &amp; cost counter — no surprises</p>
                                <p className="flex gap-2"><ShieldCheck className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0 mt-0.5" /> Failed messages are automatically refunded</p>
                            </div>

                            <div>
                                <p className="text-3xl font-bold text-emerald-600">{formatCurrency(status.activationFee)}</p>
                                <p className="text-xs text-muted-foreground">one-time activation fee</p>
                            </div>

                            <PaySourceToggle showBalance />

                            {/* Low balance warning */}
                            {activeBalance < status.activationFee && (
                                <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl p-3 text-left">
                                    <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                                    <span>
                                        {paySource === 'profit' ? 'Profit' : 'Main'} wallet balance ({formatCurrency(activeBalance)}) is below the activation fee.{' '}
                                        <Link href={paySource === 'profit' ? '/dashboard/shop/withdraw' : '/dashboard/wallet'} className="underline font-semibold">Top up →</Link>
                                    </span>
                                </div>
                            )}

                            <Button
                                onClick={handleActivate}
                                disabled={activating || activeBalance < status.activationFee}
                                className="w-full h-12 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold gap-2"
                            >
                                {activating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                                {activating ? 'Activating...' : `Activate for ${formatCurrency(status.activationFee)}`}
                            </Button>
                        </CardContent>
                    </Card>
                </div>
            )}

            {/* ── ACTIVATED ── */}
            {status.enabled && status.activated && (
                <div className="space-y-5">

                    {/* Welcome bonus claim banner */}
                    {!status.bonusClaimed && (
                        <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl bg-gradient-to-r from-amber-50 to-yellow-50 dark:from-amber-900/20 dark:to-yellow-900/20 border border-amber-200 dark:border-amber-800">
                            <div className="flex items-start gap-2.5">
                                <Gift className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
                                <div>
                                    <p className="text-sm font-bold text-amber-800 dark:text-amber-300">Claim your {status.bonusCreditCount} free SMS credits!</p>
                                    <p className="text-xs text-amber-600/80 dark:text-amber-400/80">Welcome bonus for activating the SMS feature.</p>
                                </div>
                            </div>
                            <Button
                                size="sm"
                                onClick={handleClaimBonus}
                                disabled={claimingBonus}
                                className="bg-amber-500 hover:bg-amber-600 text-white font-semibold gap-1.5 shrink-0 h-9"
                            >
                                {claimingBonus ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Gift className="w-3.5 h-3.5" />}
                                Claim
                            </Button>
                        </div>
                    )}

                    <Tabs defaultValue="send" className="w-full">
                        <TabsList className="w-full grid grid-cols-4 h-11 gap-1">
                            <TabsTrigger value="send" className="gap-1 text-[11px] sm:text-sm px-1.5 min-w-0">
                                <Send className="w-3.5 h-3.5 shrink-0" /> <span className="truncate">Send</span>
                            </TabsTrigger>
                            <TabsTrigger value="buy" className="gap-1 text-[11px] sm:text-sm px-1.5 min-w-0">
                                <Coins className="w-3.5 h-3.5 shrink-0" /> <span className="truncate">Buy</span>
                            </TabsTrigger>
                            <TabsTrigger value="templates" className="gap-1 text-[11px] sm:text-sm px-1.5 min-w-0">
                                <BookTemplate className="w-3.5 h-3.5 shrink-0" /> <span className="truncate">Templates</span>
                            </TabsTrigger>
                            <TabsTrigger value="history" className="gap-1 text-[11px] sm:text-sm px-1.5 min-w-0">
                                <Clock className="w-3.5 h-3.5 shrink-0" /> <span className="truncate">History</span>
                            </TabsTrigger>
                        </TabsList>

                        <TabsContent value="buy" className="space-y-5 mt-4">
                    {/* ── Buy Credits ── */}
                    <div className="space-y-2.5">
                        <div className="flex items-center justify-between">
                            <h3 className="text-sm font-semibold flex items-center gap-1.5">
                                <Coins className="w-4 h-4 text-emerald-500" /> Buy Credits
                            </h3>
                            <div className="w-60"><PaySourceToggle showBalance /></div>
                        </div>

                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2 sm:gap-3">
                            {status.bundles.map(b => {
                                const canAfford = activeBalance >= b.price
                                const perSms    = b.price / b.credits
                                return (
                                    <Card key={b.id} className={cn('rounded-xl border shadow-sm transition-all hover:shadow-md h-full', canAfford ? 'hover:border-emerald-200 dark:hover:border-emerald-900' : 'opacity-70')}>
                                        <CardContent className="p-2.5 sm:p-3 flex flex-col gap-1.5 sm:gap-2 h-full">
                                            <div>
                                                <p className="text-[9px] sm:text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Messages</p>
                                                <p className="text-sm sm:text-base font-bold tabular-nums leading-tight">
                                                    {b.credits.toLocaleString()}
                                                </p>
                                            </div>

                                            <div className="mt-auto">
                                                <p className="text-xs sm:text-sm font-bold text-emerald-600 tabular-nums leading-tight">
                                                    {formatCurrency(b.price)}
                                                </p>
                                                <p className="text-[8px] sm:text-[9px] text-muted-foreground leading-tight">
                                                    ≈ GHS {perSms.toFixed(3)}/SMS
                                                </p>
                                                {!canAfford && (
                                                    <p className="text-[8px] text-amber-600 font-medium leading-tight mt-0.5">
                                                        Need {formatCurrency(b.price - activeBalance)} more →{' '}
                                                        <Link href={paySource === 'profit' ? '/dashboard/shop/withdraw' : '/dashboard/wallet'} className="underline">Top up</Link>
                                                    </p>
                                                )}
                                            </div>

                                            <Button
                                                size="sm"
                                                onClick={() => setBuyModal(b)}
                                                disabled={purchasingId === b.id || !canAfford}
                                                className="w-full h-7 sm:h-8 text-[11px] sm:text-xs bg-emerald-600 hover:bg-emerald-700 text-white font-semibold gap-1 px-2"
                                            >
                                                {purchasingId === b.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                                                Buy
                                            </Button>
                                        </CardContent>
                                    </Card>
                                )
                            })}
                        </div>
                    </div>
                        </TabsContent>

                        <TabsContent value="send" className="space-y-5 mt-4">
                    {/* ── Sending rules / avoid scams ── */}
                    <Card className="rounded-2xl border-amber-200 dark:border-amber-900 bg-amber-50/40 dark:bg-amber-900/10">
                        <CardContent className="p-4 sm:p-5">
                            <button
                                type="button"
                                onClick={() => setShowRules(v => !v)}
                                className="w-full flex items-center justify-between gap-2"
                            >
                                <span className="text-sm font-semibold flex items-center gap-1.5 text-amber-800 dark:text-amber-300">
                                    <ShieldCheck className="w-4 h-4" /> Sending rules — avoid scam messages
                                </span>
                                <ChevronDown className={cn('w-4 h-4 text-amber-700 transition-transform', showRules && 'rotate-180')} />
                            </button>

                            {showRules && (
                                <div className="mt-3 space-y-3 text-xs">
                                    <p className="text-muted-foreground">
                                        To protect your customers, every message is checked automatically. These are <strong>not allowed</strong> and will be blocked:
                                    </p>
                                    <ul className="space-y-1.5">
                                        {[
                                            'Asking for OTP, PIN, password, or to "verify/confirm your account"',
                                            'Fake prizes, lottery or "you have won" messages',
                                            'Fake MoMo or bank payment / balance confirmation (receipt) messages',
                                            '"I sent money by mistake, please send it back" (reversal) tricks',
                                            'Links to other websites — only fametechgh.com and your own social pages (WhatsApp, Facebook, Instagram, X, Telegram) are allowed',
                                        ].map(rule => (
                                            <li key={rule} className="flex items-start gap-2">
                                                <X className="w-3.5 h-3.5 text-red-500 flex-shrink-0 mt-0.5" />
                                                <span className="text-muted-foreground">{rule}</span>
                                            </li>
                                        ))}
                                    </ul>
                                    <div className="flex items-start gap-2 pt-1">
                                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0 mt-0.5" />
                                        <span className="text-muted-foreground">
                                            <strong>Do</strong> promote your real bundles, prices and your shop link — that&apos;s what customers love.
                                        </span>
                                    </div>
                                    <div className="flex items-start gap-2 rounded-lg bg-amber-100/60 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 p-2.5">
                                        <AlertCircle className="w-3.5 h-3.5 text-amber-600 flex-shrink-0 mt-0.5" />
                                        <span className="text-amber-800 dark:text-amber-300">
                                            Blocked messages cost <strong>no credits</strong> and are reported to admin. Repeated scam attempts will <strong>disable your SMS feature</strong>.
                                        </span>
                                    </div>
                                </div>
                            )}
                        </CardContent>
                    </Card>

                    {/* ── Composer ── */}
                    <Card className="rounded-2xl">
                        <CardContent className="p-4 sm:p-5 space-y-4">
                            <h3 className="text-sm font-semibold flex items-center gap-1.5">
                                <Send className="w-4 h-4 text-emerald-500" /> Compose Message
                            </h3>

                            {/* Recipients */}
                            <div className="space-y-2">
                                <div className="flex items-center justify-between flex-wrap gap-2">
                                    <label className="text-xs font-semibold text-muted-foreground">
                                        Recipients ({allRecipients.length}{status.maxRecipientsPerSend ? ` / max ${status.maxRecipientsPerSend}` : ''})
                                    </label>
                                    <div className="flex gap-1.5 flex-wrap">
                                        <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={() => setShowPicker(p => !p)}>
                                            <Users className="w-3 h-3" /> {showPicker ? 'Hide' : 'My Customers'}
                                        </Button>
                                        <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={() => setImportModal('paste')}>
                                            <Plus className="w-3 h-3" /> Paste many
                                        </Button>
                                        <input
                                            ref={fileInputRef}
                                            type="file"
                                            accept=".csv,.txt,.xlsx"
                                            className="hidden"
                                            onChange={e => {
                                                const file = e.target.files?.[0]
                                                if (file) { setImportModal('upload'); handleFileUpload(file) }
                                                e.target.value = ''
                                            }}
                                        />
                                        <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={() => fileInputRef.current?.click()}>
                                            <Upload className="w-3 h-3" /> Upload file
                                        </Button>
                                        {groups.length > 0 && (
                                            <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={() => setShowGroups(g => !g)}>
                                                <BookTemplate className="w-3 h-3" /> {showGroups ? 'Hide' : 'Groups'} ({groups.length})
                                            </Button>
                                        )}
                                        {customers.length > 0 && (
                                            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setSelectedPhones(new Set(customers.map(c => c.phone)))}>
                                                Select all ({customers.length})
                                            </Button>
                                        )}
                                        {allRecipients.length > 0 && (
                                            <Button variant="outline" size="sm" className="h-7 text-xs text-red-500 hover:text-red-600 border-red-200 dark:border-red-900" onClick={clearAllRecipients}>
                                                <X className="w-3 h-3 mr-0.5" /> Clear all
                                            </Button>
                                        )}
                                    </div>
                                </div>

                                {showPicker && (
                                    <div className="max-h-44 overflow-y-auto rounded-xl border divide-y">
                                        {customers.length === 0 ? (
                                            <p className="text-xs text-muted-foreground text-center py-4">No customers yet — add numbers manually below.</p>
                                        ) : customers.map(c => (
                                            <button
                                                key={c.id}
                                                onClick={() => toggleCustomer(c.phone)}
                                                className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-muted/40"
                                            >
                                                <div>
                                                    <p className="text-xs font-semibold">{c.name || c.phone}</p>
                                                    <p className="text-[11px] text-muted-foreground font-mono">{c.phone}</p>
                                                </div>
                                                <div className={cn('w-4 h-4 rounded border-2 flex items-center justify-center', selectedPhones.has(c.phone) ? 'bg-emerald-500 border-emerald-500' : 'border-muted-foreground/30')}>
                                                    {selectedPhones.has(c.phone) && <Check className="w-2.5 h-2.5 text-white" />}
                                                </div>
                                            </button>
                                        ))}
                                    </div>
                                )}

                                {showGroups && (
                                    <div className="max-h-44 overflow-y-auto rounded-xl border divide-y">
                                        {groups.map(g => (
                                            <div key={g.id} className="flex items-center justify-between px-3 py-2">
                                                {renamingGroupId === g.id ? (
                                                    <div className="flex items-center gap-1.5 flex-1">
                                                        <Input
                                                            value={renameValue}
                                                            onChange={e => setRenameValue(e.target.value.slice(0, 60))}
                                                            onKeyDown={e => { if (e.key === 'Enter') commitRenameGroup() }}
                                                            className="h-7 text-xs"
                                                            disabled={renameSaving}
                                                            autoFocus
                                                        />
                                                        <Button size="sm" className="h-7 text-xs gap-1" onClick={commitRenameGroup} disabled={renameSaving}>
                                                            {renameSaving && <Loader2 className="w-3 h-3 animate-spin" />} Save
                                                        </Button>
                                                    </div>
                                                ) : (
                                                    <button
                                                        onClick={() => toggleGroup(g.id)}
                                                        disabled={loadingGroupId === g.id}
                                                        className="flex items-center justify-between flex-1 text-left disabled:opacity-60"
                                                    >
                                                        <div>
                                                            <p className="text-xs font-semibold">{g.name}</p>
                                                            <p className="text-[11px] text-muted-foreground">
                                                                {g.memberCount} number(s)
                                                                {status?.maxRecipientsPerSend && g.memberCount > status.maxRecipientsPerSend && (
                                                                    <span className="text-amber-600"> — exceeds your per-send limit</span>
                                                                )}
                                                            </p>
                                                        </div>
                                                        {loadingGroupId === g.id ? (
                                                            <Loader2 className="w-4 h-4 mr-2 animate-spin text-muted-foreground" />
                                                        ) : (
                                                            <div className={cn('w-4 h-4 rounded border-2 flex items-center justify-center mr-2', selectedGroupIds.has(g.id) ? 'bg-emerald-500 border-emerald-500' : 'border-muted-foreground/30')}>
                                                                {selectedGroupIds.has(g.id) && <Check className="w-2.5 h-2.5 text-white" />}
                                                            </div>
                                                        )}
                                                    </button>
                                                )}
                                                {renamingGroupId !== g.id && (
                                                    <div className="flex items-center gap-1 ml-2">
                                                        <button onClick={() => startRenameGroup(g)} title="Rename">
                                                            <Pencil className="w-3.5 h-3.5 text-muted-foreground hover:text-foreground" />
                                                        </button>
                                                        <button onClick={() => deleteGroup(g.id)} disabled={deletingGroupId === g.id} title="Delete">
                                                            {deletingGroupId === g.id
                                                                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                                : <Trash2 className="w-3.5 h-3.5 text-red-500 hover:text-red-600" />}
                                                        </button>
                                                    </div>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                )}

                                {/* Manual number input */}
                                <div className="flex gap-2">
                                    <Input
                                        value={manualPhone}
                                        onChange={e => setManualPhone(e.target.value.replace(/[^0-9+\s\-]/g, '').slice(0, 15))}
                                        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addManualPhone() } }}
                                        placeholder="Add any number, e.g. 0244123456"
                                        className="h-9 font-mono text-sm"
                                        maxLength={15}
                                        inputMode="tel"
                                        autoComplete="off"
                                    />
                                    <Button variant="outline" size="sm" className="h-9 gap-1" onClick={addManualPhone}>
                                        <Plus className="w-3.5 h-3.5" /> Add
                                    </Button>
                                </div>

                                {/* Phone tags */}
                                {(selectedPhones.size > 0 || manualPhones.length > 0 || importedPhones.length > 0 || selectedGroupIds.size > 0) && (
                                    <div className="flex flex-wrap gap-1.5">
                                        {[...selectedPhones].map(p => (
                                            <span key={p} className="inline-flex items-center gap-1 text-[11px] font-mono bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400 px-2 py-0.5 rounded-full">
                                                {p}<button onClick={() => toggleCustomer(p)} title="Remove"><X className="w-3 h-3" /></button>
                                            </span>
                                        ))}
                                        {manualPhones.map(p => (
                                            <span key={p} className="inline-flex items-center gap-1 text-[11px] font-mono bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400 px-2 py-0.5 rounded-full">
                                                {p}<button onClick={() => setManualPhones(prev => prev.filter(x => x !== p))} title="Remove"><X className="w-3 h-3" /></button>
                                            </span>
                                        ))}
                                        {importedPhones.map(p => (
                                            <span key={p} className="inline-flex items-center gap-1 text-[11px] font-mono bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400 px-2 py-0.5 rounded-full">
                                                {p}<button onClick={() => setImportedPhones(prev => prev.filter(x => x !== p))} title="Remove"><X className="w-3 h-3" /></button>
                                            </span>
                                        ))}
                                        {[...selectedGroupIds].map(id => {
                                            const g = groups.find(grp => grp.id === id)
                                            if (!g) return null
                                            return (
                                                <span key={id} className="inline-flex items-center gap-1 text-[11px] bg-purple-50 text-purple-700 dark:bg-purple-900/20 dark:text-purple-400 px-2 py-0.5 rounded-full">
                                                    {g.name} ({g.memberCount})<button onClick={() => toggleGroup(id)} title="Remove"><X className="w-3 h-3" /></button>
                                                </span>
                                            )
                                        })}
                                    </div>
                                )}

                                {overCap && (
                                    <p className="text-xs text-red-600 font-semibold flex items-center gap-1">
                                        <AlertCircle className="w-3 h-3" /> Too many recipients — max {status.maxRecipientsPerSend} per send.
                                    </p>
                                )}
                            </div>

                            {/* Message toolbar */}
                            <div className="space-y-1.5">
                                <div className="flex items-center justify-between flex-wrap gap-2">
                                    <label className="text-xs font-semibold text-muted-foreground">Message</label>
                                    <button
                                        type="button"
                                        onClick={() => setShowPreview(v => !v)}
                                        className="flex items-center gap-1 text-[11px] font-semibold text-emerald-600 hover:text-emerald-700"
                                    >
                                        {showPreview ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                                        {showPreview ? 'Hide' : 'Live'} Preview
                                    </button>
                                </div>

                                {/* Quick inserts — insert tokens; preview substitutes real values */}
                                <div className="flex flex-wrap gap-1.5">
                                    <span className="text-[10px] font-semibold text-muted-foreground self-center">Insert:</span>
                                    {[
                                        { label: 'Shop Name',  text: '{shop_name}',    show: true },
                                        { label: 'Shop Link',  text: '{shop_link}',    show: !!status.shopSlug },
                                        { label: 'Phone',      text: '{shop_phone}',   show: !!status.shopPhone },
                                        { label: 'WhatsApp',   text: '{shop_whatsapp}', show: !!(status.shopWhatsapp || status.shopPhone) },
                                        { label: 'Promo',      text: 'Limited offer! ', show: true },
                                        { label: 'Order now',  text: ' Order now: ',   show: true },
                                    ].filter(qi => qi.show).map(qi => (
                                        <button
                                            key={qi.label}
                                            type="button"
                                            onClick={() => quickInsert(qi.text)}
                                            className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-muted hover:bg-emerald-100 dark:hover:bg-emerald-900/20 hover:text-emerald-700 transition-colors border border-transparent hover:border-emerald-200 dark:hover:border-emerald-800"
                                        >
                                            {qi.label}
                                        </button>
                                    ))}
                                </div>

                                <Textarea
                                    ref={msgRef}
                                    value={message}
                                    onChange={e => setMessage(sanitizeText(e.target.value))}
                                    placeholder="e.g. Weekend promo! MTN 5GB now GHS 25 at {shop_name}. Order: {shop_link}"
                                    rows={4}
                                    maxLength={1000}
                                    className="resize-none"
                                />

                                {/* Emoji are stripped before sending — tell the owner why the preview differs */}
                                {messageHasEmoji && (
                                    <p className="flex items-start gap-1 text-[11px] font-medium text-amber-600">
                                        <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
                                        Emojis cannot be delivered over SMS and have been removed from the message your customers will receive (see preview below).
                                    </p>
                                )}

                                {/* Live preview */}
                                {showPreview && (
                                    <div className="rounded-xl border bg-muted/30 p-3">
                                        <div className="flex items-center gap-1.5 mb-2">
                                            <Smartphone className="w-3 h-3 text-muted-foreground" />
                                            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Recipient preview</p>
                                        </div>
                                        <div className="bg-white dark:bg-zinc-900 rounded-xl p-3 shadow-inner min-h-[52px] flex items-start">
                                            {previewMessage.trim() ? (
                                                <div className="inline-block bg-green-500 text-white text-xs px-2.5 py-2 rounded-2xl rounded-tl-sm max-w-[85%] whitespace-pre-wrap break-words leading-relaxed">
                                                    {previewMessage}
                                                </div>
                                            ) : (
                                                <p className="text-[11px] text-muted-foreground/50 italic self-center">Your message will appear here as you type…</p>
                                            )}
                                        </div>
                                    </div>
                                )}

                                {/* Stats bar */}
                                <div className="flex items-center justify-between text-[11px]">
                                    <span className={cn('font-medium', segInfo.encoding === 'unicode' ? 'text-amber-600' : 'text-muted-foreground')}>
                                        {segInfo.length} chars · {segInfo.segments} SMS
                                        {segInfo.encoding === 'unicode' && ' · emoji/special reduces limit to 70'}
                                    </span>
                                    <span className={cn('font-semibold', insufficient ? 'text-red-600' : 'text-emerald-600')}>
                                        {allRecipients.length > 0
                                            ? `${segInfo.segments} × ${allRecipients.length} = ${creditsNeeded} credits`
                                            : `${segInfo.segments} credit(s) per recipient`}
                                    </span>
                                </div>
                            </div>

                            {/* Save as template */}
                            {message.trim().length >= 3 && (
                                <button
                                    type="button"
                                    onClick={() => { setNewTplBody(message); setTplModal(true) }}
                                    className="flex items-center gap-1.5 text-[11px] font-semibold text-emerald-600 hover:text-emerald-700"
                                >
                                    <Copy className="w-3 h-3" /> Save as template
                                </button>
                            )}

                            {insufficient && (
                                <div className="flex gap-2 items-start p-3 rounded-xl bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-400">
                                    <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                                    <span>Not enough credits — this send needs {creditsNeeded} but you have {status.credits}. Buy a bundle from the <strong>Buy Credits</strong> tab.</span>
                                </div>
                            )}

                            <Button
                                onClick={() => { setSendError(null); setSendModal(true) }}
                                disabled={!canSend}
                                className="w-full h-11 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold gap-2"
                            >
                                {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                                {sending ? 'Sending...' : allRecipients.length > 0 ? `Review & Send to ${allRecipients.length} recipient(s)` : 'Send SMS'}
                            </Button>
                        </CardContent>
                    </Card>

                    {/* ── Automatic order confirmations ──
                        Placed BELOW the composer on purpose: this is a setting,
                        and the whole point of the tab layout is that sending is
                        the first thing an owner reaches. It lives here (rather
                        than only on the shop overview) because this is the page
                        showing the credit balance and the History tab's
                        "Auto-confirm" usage line — the cost and its off-switch
                        belong within reach of each other. */}
                    <Card className="rounded-2xl">
                        <CardContent className="p-4 sm:p-5">
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <h3 className="text-sm font-semibold flex items-center gap-1.5">
                                        <MessageSquare className="w-4 h-4 text-emerald-500" /> Automatic order confirmations
                                    </h3>
                                    <p className="text-xs text-muted-foreground mt-1">
                                        Text every customer automatically when their order completes.
                                        Each one costs <strong>1 credit</strong> from the balance above.
                                    </p>
                                </div>
                                <Switch
                                    checked={confirmEnabled}
                                    onCheckedChange={handleToggleConfirm}
                                    disabled={savingConfirm || !status.activated}
                                    aria-label="Send automatic order confirmation SMS to customers"
                                />
                            </div>

                            {/* Without an approved sender these are suppressed regardless of
                                the switch, so say so rather than letting the owner think
                                they are paying for texts that never go out. */}
                            {confirmEnabled && !status.hasApprovedSender && (
                                <div className="mt-3 flex items-start gap-2 p-2.5 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-xs text-amber-800 dark:text-amber-300">
                                    <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                                    <span>Waiting on an approved Sender ID — no confirmations are being sent yet, and no credits are being used for them.</span>
                                </div>
                            )}

                            {!confirmEnabled && (
                                <div className="mt-3 flex items-start gap-2 p-2.5 rounded-lg bg-muted/60 border text-xs text-muted-foreground">
                                    <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                                    <span>Customers won&apos;t get a text when their order completes. Your manual sends are unaffected.</span>
                                </div>
                            )}
                        </CardContent>
                    </Card>
                        </TabsContent>

                        <TabsContent value="templates" className="mt-4">
                    {/* ── Templates ── */}
                    <Card className="rounded-2xl">
                        <CardContent className="p-4 sm:p-5 space-y-3">
                            <div className="flex items-center justify-between">
                                <h3 className="text-sm font-semibold flex items-center gap-1.5">
                                    <BookTemplate className="w-4 h-4 text-emerald-500" /> Message Templates
                                </h3>
                                <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => setTplModal(true)}>
                                    <Plus className="w-3 h-3" /> New
                                </Button>
                            </div>

                            {/* Shop templates list */}
                            <div className="space-y-2">
                                {shopTemplates.length === 0 ? (
                                    <p className="text-xs text-muted-foreground text-center py-6">
                                        No templates yet. Click <strong>New</strong> to create your first one.
                                    </p>
                                ) : shopTemplates.map(t => (
                                    <div key={t.id} className="flex items-start gap-3 p-3 rounded-xl border bg-muted/20 hover:bg-muted/40 transition-colors">
                                        <div className="flex-1 min-w-0">
                                            <p className="text-xs font-semibold">{t.name}</p>
                                            <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">{t.body}</p>
                                        </div>
                                        <div className="flex gap-1.5 shrink-0">
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                className="h-7 text-xs px-2.5 gap-1 text-emerald-600 border-emerald-200 dark:border-emerald-800"
                                                onClick={() => applyTemplate(t.body)}
                                            >
                                                <Copy className="w-3 h-3" /> Use
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                className="h-7 w-7 p-0 text-red-500 border-red-200 dark:border-red-900 hover:bg-red-50 dark:hover:bg-red-950/20"
                                                onClick={() => handleDeleteTemplate(t.id)}
                                                disabled={deletingTemplate === t.id}
                                            >
                                                {deletingTemplate === t.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                                            </Button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </CardContent>
                    </Card>
                        </TabsContent>

                        <TabsContent value="history" className="mt-4">
                    {/* ── Recent sends ── */}
                    <Card className="rounded-2xl overflow-hidden">
                        <CardContent className="p-0">
                            <div className="px-4 py-3 border-b">
                                <h3 className="text-sm font-semibold flex items-center gap-1.5">
                                    <Clock className="w-4 h-4 text-emerald-500" /> Recent Sends
                                </h3>
                            </div>

                            {/* Usage breakdown — makes clear where credits actually went.
                                Automatic order-confirmation SMS silently consumes a share
                                of credits owners previously could not see. */}
                            <div className="px-4 py-2.5 border-b bg-muted/20 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
                                <span className="text-muted-foreground">Manual <strong className="text-foreground tabular-nums">{status.usageBreakdown.manual}</strong></span>
                                <span className="text-muted-foreground">Auto-confirm <strong className="text-foreground tabular-nums">{status.usageBreakdown.auto_confirmation}</strong></span>
                                <span className="text-muted-foreground">Adjustments <strong className="text-foreground tabular-nums">{status.usageBreakdown.reconciliation}</strong></span>
                                <span className="ml-auto font-semibold text-foreground">Total <span className="tabular-nums">{status.usageBreakdown.total}</span></span>
                            </div>

                            {status.recentLogs.length === 0 ? (
                                <p className="text-xs text-muted-foreground text-center py-8">No messages sent yet.</p>
                            ) : (
                                <div className="divide-y">
                                    {status.recentLogs.map(log => (
                                        <div key={log.id} className="px-4 py-3 flex items-start justify-between gap-3">
                                            <div className="min-w-0">
                                                <p className="text-xs font-medium truncate max-w-[240px] sm:max-w-md flex items-center gap-1.5">
                                                    {log.source === 'auto_confirmation' && (
                                                        <span className="text-[9px] font-black uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 shrink-0">Auto</span>
                                                    )}
                                                    {log.source === 'reconciliation' && (
                                                        <span className="text-[9px] font-black uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300 shrink-0">Adjustment</span>
                                                    )}
                                                    <span className="truncate">{log.message}</span>
                                                </p>
                                                <p className="text-[11px] text-muted-foreground mt-0.5">
                                                    {log.recipients_count} recipient(s) · {log.segments} SMS · {new Date(log.created_at).toLocaleString()}
                                                </p>
                                                {log.status !== 'blocked' && log.status !== 'failed' && (
                                                    <p className="text-[11px] mt-0.5 flex items-center gap-2">
                                                        {log.delivered_count > 0 && (
                                                            <span className="text-emerald-600 dark:text-emerald-400 font-medium">{log.delivered_count} delivered</span>
                                                        )}
                                                        {log.undelivered_count > 0 && (
                                                            <span className="text-red-600 dark:text-red-400 font-medium">{log.undelivered_count} undelivered</span>
                                                        )}
                                                        {log.pending_count > 0 && (
                                                            <span className="text-muted-foreground">{log.pending_count} pending</span>
                                                        )}
                                                        {log.delivered_count === 0 && log.undelivered_count === 0 && log.pending_count === 0 && (
                                                            <span className="text-muted-foreground italic">no delivery data (sent before tracking was enabled)</span>
                                                        )}
                                                    </p>
                                                )}
                                            </div>
                                            <div className="text-right flex-shrink-0">
                                                <span className={cn(
                                                    'text-[10px] font-semibold px-1.5 py-0.5 rounded-full',
                                                    log.status === 'sent'    ? 'bg-green-100 text-green-700 dark:bg-green-900/20 dark:text-green-400' :
                                                    log.status === 'partial' ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/20 dark:text-yellow-400' :
                                                                               'bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-400'
                                                )}>
                                                    {log.status}
                                                </span>
                                                <p className="text-[11px] font-semibold text-muted-foreground mt-0.5">−{log.credits_used} credits</p>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </CardContent>
                    </Card>
                        </TabsContent>
                    </Tabs>
                </div>
            )}

            {/* ── Shared in-app confirm dialog — replaces window.confirm() for every
                destructive action on this page (delete group/template/sender ID) ── */}
            <Dialog open={!!confirmState} onOpenChange={open => { if (!open && !confirming) setConfirmState(null) }}>
                <DialogContent className="max-w-sm" aria-describedby={undefined}>
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <AlertCircle className="w-4 h-4 text-red-500" /> {confirmState?.title}
                        </DialogTitle>
                    </DialogHeader>
                    <p className="text-sm text-muted-foreground">{confirmState?.message}</p>
                    <DialogFooter className="gap-2">
                        <Button variant="ghost" onClick={() => setConfirmState(null)} disabled={confirming}>Cancel</Button>
                        <Button
                            onClick={handleConfirmAction}
                            disabled={confirming}
                            className="bg-red-600 hover:bg-red-700 text-white gap-1.5"
                        >
                            {confirming ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                            {confirmState?.confirmLabel}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* ── Buy Credits Confirmation Modal ── */}
            <Dialog open={!!buyModal} onOpenChange={open => { if (!open) setBuyModal(null) }}>
                <DialogContent className="max-w-sm" aria-describedby={undefined}>
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <Coins className="w-4 h-4 text-emerald-600" /> Confirm Credit Purchase
                        </DialogTitle>
                    </DialogHeader>
                    {buyModal && (
                        <div className="space-y-4">
                            <div className="rounded-xl bg-muted/40 p-4 space-y-2.5 text-sm">
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">Bundle</span>
                                    <span className="font-semibold">{buyModal.name}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">SMS Credits</span>
                                    <span className="font-bold text-emerald-600">{buyModal.credits.toLocaleString()}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">Cost</span>
                                    <span className="font-bold">{formatCurrency(buyModal.price)}</span>
                                </div>
                                <div className="border-t pt-2 flex justify-between">
                                    <span className="text-muted-foreground">Paying from</span>
                                    <span className="font-semibold flex items-center gap-1">
                                        <CreditCard className="w-3 h-3" />
                                        {paySource === 'profit' ? 'Profit Wallet' : 'Main Wallet'}
                                    </span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">Wallet balance</span>
                                    <span className={cn('font-semibold tabular-nums', activeBalance < buyModal.price ? 'text-red-600' : 'text-emerald-600')}>
                                        {formatCurrency(activeBalance)}
                                    </span>
                                </div>
                            </div>
                            {activeBalance < buyModal.price && (
                                <p className="text-xs text-red-600 font-semibold flex items-center gap-1">
                                    <AlertCircle className="w-3 h-3" />
                                    Insufficient balance. Please top up your {paySource === 'profit' ? 'profit' : 'main'} wallet first.
                                </p>
                            )}
                        </div>
                    )}
                    <DialogFooter className="gap-2">
                        <Button variant="ghost" onClick={() => setBuyModal(null)}>Cancel</Button>
                        <Button
                            onClick={() => buyModal && handlePurchase(buyModal)}
                            disabled={!buyModal || activeBalance < buyModal.price || !!purchasingId}
                            className="bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5"
                        >
                            {purchasingId ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Coins className="w-3.5 h-3.5" />}
                            Confirm Purchase
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* ── Send Confirmation Modal ── */}
            <Dialog open={sendModal} onOpenChange={open => { if (!sending) { setSendModal(open); if (!open) setSendError(null) } }}>
                <DialogContent className="max-w-sm" aria-describedby={undefined}>
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <Send className="w-4 h-4 text-emerald-600" /> Confirm Send
                        </DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4">
                        {/* Message preview — tokens substituted so this matches what recipients receive */}
                        <div className="rounded-xl border bg-muted/30 p-3">
                            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">Message preview</p>
                            <p className="text-sm text-foreground whitespace-pre-wrap break-words line-clamp-5">{previewMessage}</p>
                        </div>
                        {/* Cost breakdown */}
                        <div className="rounded-xl bg-muted/40 p-4 space-y-2 text-sm">
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">Recipients</span>
                                <span className="font-semibold">{allRecipients.length}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">SMS per recipient</span>
                                <span className="font-semibold">{segInfo.segments}</span>
                            </div>
                            <div className="flex justify-between border-t pt-2">
                                <span className="text-muted-foreground">Total credits</span>
                                <span className="font-bold text-lg text-emerald-600">{creditsNeeded}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">Remaining after send</span>
                                <span className={cn('font-semibold tabular-nums', status ? status.credits - creditsNeeded < 5 ? 'text-amber-600' : 'text-foreground' : '')}>
                                    {status ? (status.credits - creditsNeeded).toLocaleString() : '–'} credits
                                </span>
                            </div>
                        </div>
                        {/* Send failure reason (INSUFFICIENT_CREDITS, blocked content, rate
                            limit…) — exact server message, always visible, not just a toast. */}
                        {sendError && (
                            <div className="flex items-start gap-2 p-3 rounded-xl bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-400">
                                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                                <span>{sendError}</span>
                            </div>
                        )}
                    </div>
                    <DialogFooter className="gap-2">
                        <Button variant="ghost" onClick={() => setSendModal(false)} disabled={sending}>Cancel</Button>
                        <Button
                            onClick={handleSend}
                            disabled={sending || insufficient}
                            className="bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5"
                        >
                            {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                            Send Now
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* ── Import Numbers (paste / upload) Modal ── */}
            <Dialog open={!!importModal} onOpenChange={open => { if (!open) closeImportModal() }}>
                <DialogContent className="max-w-sm" aria-describedby={undefined}>
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <Upload className="w-4 h-4 text-emerald-600" />
                            {importModal === 'paste' ? 'Paste Numbers' : 'Upload File'}
                        </DialogTitle>
                    </DialogHeader>

                    {!importReview && importModal === 'paste' && (
                        <div className="space-y-3">
                            <Textarea
                                value={importText}
                                onChange={e => setImportText(e.target.value.slice(0, 20000))}
                                placeholder={'Paste numbers — any mix of commas, spaces or new lines, e.g.\n0244123456, 0201234567\n0551234567'}
                                rows={6}
                                className="resize-none font-mono text-sm"
                            />
                            <Button onClick={runPasteReview} className="w-full bg-emerald-600 hover:bg-emerald-700 text-white">
                                Review Numbers
                            </Button>
                        </div>
                    )}

                    {!importReview && importModal === 'upload' && (
                        <p className="text-sm text-muted-foreground text-center py-6">Reading file…</p>
                    )}

                    {importReview && (
                        <div className="space-y-3">
                            <div className="flex gap-3 text-xs">
                                <span className="text-emerald-600 font-semibold">{importReview.valid.length} valid</span>
                                {importReview.duplicateCount > 0 && (
                                    <span className="text-muted-foreground">{importReview.duplicateCount} duplicate</span>
                                )}
                                {importReview.invalidCount > 0 && (
                                    <span className="text-red-500">{importReview.invalidCount} invalid</span>
                                )}
                            </div>
                            {importReview.invalid.length > 0 && (
                                <div className="max-h-20 overflow-y-auto rounded-lg border bg-muted/30 p-2">
                                    <p className="text-[10px] text-muted-foreground font-mono break-all">{importReview.invalid.join(', ')}</p>
                                </div>
                            )}
                            {importReview.valid.length > 0 && (
                                <div className="space-y-2">
                                    <Button onClick={addReviewedToSend} className="w-full bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5">
                                        <Plus className="w-3.5 h-3.5" /> Add {importReview.valid.length} to this send
                                    </Button>
                                    <div className="flex gap-2">
                                        <Input
                                            value={importGroupName}
                                            onChange={e => setImportGroupName(e.target.value.slice(0, 60))}
                                            placeholder="Group name (e.g. Weekend promo list)"
                                            maxLength={60}
                                        />
                                        <Button
                                            variant="outline"
                                            onClick={saveReviewedAsGroup}
                                            disabled={savingGroup || !importGroupName.trim()}
                                            className="gap-1.5 whitespace-nowrap"
                                        >
                                            {savingGroup ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FolderPlus className="w-3.5 h-3.5" />}
                                            Save as group
                                        </Button>
                                    </div>
                                </div>
                            )}
                            <Button variant="ghost" size="sm" onClick={() => setImportReview(null)} className="w-full">
                                Back
                            </Button>
                        </div>
                    )}

                    <DialogFooter className="gap-2">
                        <Button variant="ghost" onClick={closeImportModal}>Close</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* ── Add Template Modal ── */}
            <Dialog open={tplModal} onOpenChange={setTplModal}>
                <DialogContent className="max-w-sm" aria-describedby={undefined}>
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <BookTemplate className="w-4 h-4 text-emerald-600" /> Save as Template
                        </DialogTitle>
                    </DialogHeader>
                    <div className="space-y-3">
                        <div>
                            <label className="text-xs font-semibold text-muted-foreground block mb-1">Template Name</label>
                            <Input
                                value={newTplName}
                                onChange={e => setNewTplName(e.target.value.slice(0, 60))}
                                placeholder="e.g. Weekend Promo"
                                maxLength={60}
                                autoComplete="off"
                            />
                            <p className="text-[10px] text-muted-foreground/60 mt-0.5">{newTplName.length}/60</p>
                        </div>
                        <div>
                            <label className="text-xs font-semibold text-muted-foreground block mb-1">Message Body</label>
                            <Textarea
                                value={newTplBody}
                                onChange={e => setNewTplBody(e.target.value.slice(0, 1000))}
                                placeholder="Message content. Use {shop_name}, {shop_link}, {shop_phone} as placeholders."
                                rows={5}
                                maxLength={1000}
                                className="resize-none"
                            />
                            <p className="text-[10px] text-muted-foreground/60 mt-0.5">{newTplBody.length}/1000</p>
                        </div>
                        <p className="text-[11px] text-muted-foreground/70">
                            Use <code className="bg-muted px-1 rounded">{'{shop_name}'}</code>, <code className="bg-muted px-1 rounded">{'{shop_link}'}</code>, <code className="bg-muted px-1 rounded">{'{shop_phone}'}</code>, <code className="bg-muted px-1 rounded">{'{shop_whatsapp}'}</code> — these are replaced with your shop details when you apply the template.
                        </p>
                    </div>
                    <DialogFooter className="gap-2">
                        <Button variant="ghost" onClick={() => setTplModal(false)}>Cancel</Button>
                        <Button
                            onClick={handleSaveTemplate}
                            disabled={savingTemplate || !newTplName.trim() || newTplBody.trim().length < 3}
                            className="bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5"
                        >
                            {savingTemplate ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Copy className="w-3.5 h-3.5" />}
                            Save Template
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

        </div>
        </SmsAcceptanceGate>
    )
}
