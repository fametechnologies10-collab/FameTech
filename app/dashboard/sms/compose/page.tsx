'use client'

/**
 * KFT SMS — Campaign Composer (/dashboard/sms/compose)
 *
 * Premium composer for the user SMS platform: sender identity card,
 * 3-source recipient builder (manual paste / contact groups / CSV upload),
 * live GSM-7 vs Unicode segment counter, phone-style preview, scheduling,
 * confirm dialog and a success/queued screen.
 *
 * Contact groups are read via the RLS-scoped browser client (owner policies);
 * the send itself goes through POST /api/sms/campaigns which re-validates
 * everything server-side.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { motion, AnimatePresence } from 'framer-motion'
import { useAuth } from '@/contexts/auth-context'
import { supabase } from '@/lib/supabase'
import { cn } from '@/lib/utils'
import { calculateSegments } from '@/lib/sms-segments'
import { stripUndeliverableChars } from '@/lib/sms-message'
import { SmsAcceptanceGate } from '@/components/sms/sms-acceptance-gate'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
    Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import {
    Sheet, SheetContent, SheetHeader, SheetTitle, SheetClose,
} from '@/components/ui/sheet'
import {
    ArrowLeft, Send, Loader2, AlertCircle, CheckCircle2, X, Users,
    Smartphone, Coins, CalendarClock, ShieldAlert, ShieldCheck, BadgeCheck,
    Upload, FileText, ClipboardList, RefreshCcw, Megaphone, ChevronRight,
    Sparkles, Trash2, LayoutTemplate, BookmarkPlus, Search, Store,
} from 'lucide-react'
import { toast } from '@/lib/toast'

// ── Types ────────────────────────────────────────────────────────────────────

interface SenderRow { id?: string; sender_text: string; status: string; is_default?: boolean }
interface SmsCaps { max_recipients_per_send: number; sends_per_hour: number; recipients_per_day: number }

interface AccountData {
    account: {
        id: string
        mode: 'platform' | 'business'
        status: string
        suspended_reason?: string | null
        default_sender: string | null
    }
    wallet: { credits: number }
    senders: SenderRow[]
    poolSenders: string[]
    caps: SmsCaps
    policy: { canSend: boolean; sender?: string; senderSource?: string; message?: string; reason?: string }
}

interface GroupOption { id: string; name: string; count: number }

interface CampaignResult {
    id: string
    status: string
    recipients: number
    segments: number
    credits_charged: number
    sender: string
    sent?: number
    failed?: number
    balance?: number
}

interface Callout { kind: 'blocked' | 'credits' | 'suspended' | 'rate'; message: string }

interface CsvSummary { name: string; total: number; valid: number; invalid: number; dupes: number }

interface TemplateRow { id: string; name: string; body: string; created_at: string }

type RecipientTab = 'manual' | 'groups' | 'csv' | 'customers'

interface MyCustomer { id: string; phone: string; name: string | null }

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Ghana phone normalizer — mirrors the server's normalizeGhanaPhone.
 *  Accepts 0XXXXXXXXX or 233XXXXXXXXX (spaces/dashes/+ tolerated),
 *  returns canonical 233XXXXXXXXX or null. The server re-validates. */
function normalizeGhanaPhone(raw: string): string | null {
    let n = raw.replace(/[\s\-+()]/g, '')
    if (!/^\d+$/.test(n)) return null
    if (n.startsWith('0') && n.length === 10) n = '233' + n.slice(1)
    if (n.startsWith('233') && n.length === 12) return n
    return null
}

function sanitizeText(v: string) {
    return v.replace(/<[^>]*>/g, '').replace(/\0/g, '').slice(0, 1000)
}

/** Minimal CSV line parser that copes with quoted cells. */
function parseCsvLine(line: string): string[] {
    const out: string[] = []
    let cur = ''
    let inQ = false
    for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (inQ) {
            if (ch === '"') {
                if (line[i + 1] === '"') { cur += '"'; i++ } else inQ = false
            } else cur += ch
        } else if (ch === '"') {
            inQ = true
        } else if (ch === ',') {
            out.push(cur); cur = ''
        } else cur += ch
    }
    out.push(cur)
    return out.map(s => s.trim())
}

const PHONE_COL_RE = /^(phone|phone[_ ]?number|number|mobile|msisdn|recipient|tel)s?$/i

function toLocalInputValue(d: Date): string {
    const pad = (x: number) => String(x).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// ── Component ────────────────────────────────────────────────────────────────

export default function SmsComposePage() {
    const { dbUser } = useAuth()

    // Account / policy
    const [data, setData]           = useState<AccountData | null>(null)
    const [loading, setLoading]     = useState(true)
    const [loadError, setLoadError] = useState<string | null>(null)

    // Sender (business mode pick)
    const [sender, setSender] = useState<string>('')

    // Recipients
    const [tab, setTab]                       = useState<RecipientTab>('manual')
    const [manualText, setManualText]         = useState('')
    const [groups, setGroups]                 = useState<GroupOption[]>([])
    const [groupsLoading, setGroupsLoading]   = useState(true)
    const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set())
    const [loadingGroupId, setLoadingGroupId] = useState<string | null>(null)
    const groupNumbersRef                     = useRef<Record<string, string[]>>({})
    const [, forceGroupTick]                  = useState(0) // re-render after cache fill
    const [csvNumbers, setCsvNumbers]         = useState<string[]>([])
    const [csvSummary, setCsvSummary]         = useState<CsvSummary | null>(null)
    const csvInputRef                         = useRef<HTMLInputElement>(null)

    // "My Customers" — this user's own shop customer list (if they have a
    // shop). Independent + non-blocking load, same as templates: a failure
    // here must never block the rest of the composer.
    const [myCustomers, setMyCustomers]                 = useState<MyCustomer[]>([])
    const [myCustomersLoading, setMyCustomersLoading]   = useState(true)
    const [myCustomersError, setMyCustomersError]       = useState<string | null>(null)
    const [selectedCustomerPhones, setSelectedCustomerPhones] = useState<Set<string>>(new Set())
    const [customerSearch, setCustomerSearch]           = useState('')

    // Message + schedule
    const [message, setMessage]       = useState('')
    const [showPreview, setShowPreview] = useState(true)
    const [scheduleOn, setScheduleOn] = useState(false)
    const [scheduleAt, setScheduleAt] = useState('')
    const scheduleRef                 = useRef<HTMLInputElement>(null)

    // Templates
    const [templates, setTemplates]             = useState<TemplateRow[]>([])
    const [templatesLoading, setTemplatesLoading] = useState(false)
    const [templatesOpen, setTemplatesOpen]     = useState(false)
    const [saveOpen, setSaveOpen]               = useState(false)
    const [templateName, setTemplateName]       = useState('')
    const [savingTemplate, setSavingTemplate]   = useState(false)
    const [pendingTemplate, setPendingTemplate] = useState<TemplateRow | null>(null)
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
    const [deletingId, setDeletingId]           = useState<string | null>(null)
    const templateNameRef                       = useRef<HTMLInputElement>(null)

    // Submit lifecycle
    const [confirmOpen, setConfirmOpen] = useState(false)
    const [sending, setSending]         = useState(false)
    const [callout, setCallout]         = useState<Callout | null>(null)
    const [result, setResult]           = useState<CampaignResult | null>(null)

    // ── Data loading ─────────────────────────────────────────────────────────

    const fetchAccount = useCallback(async () => {
        try {
            const res  = await fetch('/api/sms/account')
            const json = await res.json().catch(() => null)
            if (!json?.success) {
                setLoadError(json?.error || 'Failed to load your SMS account')
                return null
            }
            setLoadError(null)
            setData(json.data as AccountData)
            return json.data as AccountData
        } catch {
            setLoadError('Network error — check your connection and retry')
            return null
        }
    }, [])

    const fetchGroups = useCallback(async (accountId: string) => {
        setGroupsLoading(true)
        try {
            const { data: rows, error } = await (supabase as any)
                .from('sms_contact_groups')
                .select('id, name, sms_group_contacts(count)')
                .eq('account_id', accountId)
                .order('created_at', { ascending: false })
            if (error) throw error
            setGroups((rows ?? []).map((g: any) => ({
                id: g.id,
                name: g.name,
                count: g.sms_group_contacts?.[0]?.count ?? 0,
            })))
        } catch (err) {
            console.error('[SMS Compose] groups load:', err)
            toast.error('Could not load your contact groups')
        } finally {
            setGroupsLoading(false)
        }
    }, [])

    const fetchTemplates = useCallback(async () => {
        setTemplatesLoading(true)
        try {
            const res  = await fetch('/api/sms/templates')
            const json = await res.json().catch(() => null)
            if (json?.success) setTemplates((json.data?.templates ?? []) as TemplateRow[])
        } catch {
            /* templates are optional — never block the composer */
        } finally {
            setTemplatesLoading(false)
        }
    }, [])

    const fetchMyCustomers = useCallback(async () => {
        setMyCustomersLoading(true)
        setMyCustomersError(null)
        try {
            const res  = await fetch('/api/sms/my-customers')
            const json = await res.json().catch(() => null)
            if (!json?.success) {
                setMyCustomersError(json?.error || 'Failed to load your customers')
                return
            }
            setMyCustomers((json.data?.customers ?? []) as MyCustomer[])
        } catch {
            setMyCustomersError('Network error — check your connection and retry')
        } finally {
            setMyCustomersLoading(false)
        }
    }, [])

    useEffect(() => {
        if (!dbUser) return
        let cancelled = false
        ;(async () => {
            setLoading(true)
            const acc = await fetchAccount()
            if (!cancelled && acc) await fetchGroups(acc.account.id)
            if (!cancelled) setLoading(false)
        })()
        fetchTemplates()   // independent + non-blocking
        fetchMyCustomers() // independent + non-blocking
        return () => { cancelled = true }
    }, [dbUser, fetchAccount, fetchGroups, fetchTemplates, fetchMyCustomers])

    // ── Derived state ────────────────────────────────────────────────────────

    // Billing + preview run on the exact deliverable text (emoji stripped),
    // matching what the server charges for.
    const preview = useMemo(() => stripUndeliverableChars(message.trim()), [message])
    const segInfo = useMemo(() => calculateSegments(preview), [preview])
    // Astral code points (emoji) + variation selectors / ZWJ / keycap marks —
    // same set the server strips before delivery.
    const messageHasEmoji = useMemo(() => {
        for (const ch of message) {
            const cp = ch.codePointAt(0) ?? 0
            if (cp > 0xFFFF || cp === 0x200D || cp === 0xFE0E || cp === 0xFE0F || cp === 0x20E3) return true
        }
        return false
    }, [message])

    const manualParsed = useMemo(() => {
        const tokens = manualText.split(/[\s,;]+/).map(t => t.trim()).filter(Boolean)
        const valid = new Set<string>()
        const invalid = new Set<string>()
        for (const t of tokens) {
            const n = normalizeGhanaPhone(t)
            if (n) valid.add(n)
            else invalid.add(t)
        }
        return { valid: [...valid], invalid: [...invalid] }
    }, [manualText])

    const groupRecipients = useMemo(() => {
        const out: string[] = []
        selectedGroups.forEach(id => {
            const nums = groupNumbersRef.current[id]
            if (nums) out.push(...nums)
        })
        return out
        // loadingGroupId + forceGroupTick re-render keeps this fresh after fetches
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedGroups, loadingGroupId])

    // Customer phones come back from the server in whatever shape shop
    // checkout stored them (typically 0XXXXXXXXX) — normalize to the same
    // canonical 233XXXXXXXXX shape as every other recipient source so the
    // cross-tab dedupe in allRecipients actually catches duplicates.
    const myCustomersNormalized = useMemo(() => {
        const out: Array<MyCustomer & { normPhone: string }> = []
        for (const c of myCustomers) {
            const n = normalizeGhanaPhone(c.phone)
            if (n) out.push({ ...c, normPhone: n })
        }
        return out
    }, [myCustomers])

    const filteredMyCustomers = useMemo(() => {
        const q = customerSearch.trim().toLowerCase()
        if (!q) return myCustomersNormalized
        return myCustomersNormalized.filter(c =>
            c.phone.toLowerCase().includes(q) || (c.name || '').toLowerCase().includes(q))
    }, [myCustomersNormalized, customerSearch])

    const myCustomerRecipients = useMemo(() => [...selectedCustomerPhones], [selectedCustomerPhones])

    const allRecipients = useMemo(
        () => [...new Set([...manualParsed.valid, ...groupRecipients, ...csvNumbers, ...myCustomerRecipients])],
        [manualParsed.valid, groupRecipients, csvNumbers, myCustomerRecipients],
    )

    const caps          = data?.caps
    const walletCredits = data?.wallet.credits ?? 0
    const creditsNeeded = segInfo.segments * allRecipients.length
    const overCap       = caps ? allRecipients.length > caps.max_recipients_per_send : false
    const insufficient  = allRecipients.length > 0 && creditsNeeded > walletCredits
    const suspended     = data?.account.status === 'suspended'
    const policyBlocked = data ? !data.policy.canSend : false

    // Approved senders belonging to this account — merged server-side
    // (KFT sms_sender_ids ∪ the owner's approved shop sender). Business mode
    // also merges the admin pool; platform mode (feature-wave7) never gets
    // the pool — only the fixed platform sender + the account's own.
    const senderOptions = useMemo(() => {
        if (!data) return [] as { value: string; own: boolean }[]
        const opts: { value: string; own: boolean }[] = []
        const seen = new Set<string>()
        for (const s of data.senders) {
            if (s.status !== 'approved') continue
            const k = s.sender_text.trim().toLowerCase()
            if (seen.has(k)) continue
            seen.add(k)
            opts.push({ value: s.sender_text, own: true })
        }
        if (data.account.mode === 'business') {
            for (const p of data.poolSenders) {
                const k = p.trim().toLowerCase()
                if (seen.has(k)) continue
                seen.add(k)
                opts.push({ value: p, own: false })
            }
        }
        return opts
    }, [data])

    // The fixed platform sender — resolvable from the server's default-path
    // policy (no requestedSender) even when the account can't currently send.
    const platformSenderValue = data?.policy.sender || data?.account.default_sender || 'KINGFLEXY'

    // Initialise the sender pick once the account arrives. Business mode:
    // only ever selects an approved own sender or a pool sender — never an
    // unapproved one — and preselects the account/policy default when valid.
    // Platform mode (feature-wave7): defaults to the platform sender; the
    // user may explicitly switch to one of their own approved senders.
    useEffect(() => {
        if (!data) return
        if (data.account.mode === 'business') {
            setSender(prev => {
                if (prev && senderOptions.some(o => o.value === prev)) return prev // keep a valid pick
                const match = (v?: string | null) =>
                    v ? senderOptions.find(o => o.value.toLowerCase() === v.trim().toLowerCase())?.value : undefined
                return match(data.account.default_sender) || match(data.policy.sender) || senderOptions[0]?.value || ''
            })
        } else {
            setSender(prev => {
                const validValues = [platformSenderValue, ...senderOptions.map(o => o.value)]
                if (prev && validValues.some(v => v.toLowerCase() === prev.trim().toLowerCase())) return prev
                return platformSenderValue
            })
        }
    }, [data, senderOptions, platformSenderValue])

    const effectiveSender = sender || data?.policy.sender || data?.account.default_sender || 'KiNG FLEXY'

    const scheduleMin = toLocalInputValue(new Date(Date.now() + 2 * 60_000))
    const scheduleMax = toLocalInputValue(new Date(Date.now() + 30 * 86_400_000))

    const canReview = !!data && !loading && !sending && !suspended && !policyBlocked
        && allRecipients.length > 0 && preview.length >= 3
        && !overCap && !insufficient
        && (!scheduleOn || !!scheduleAt)

    // The platform master switch is a distinct, expected condition (not an
    // account-specific problem) — give it its own KFT-branded headline
    // instead of the generic "no sender" copy. Prefer the structured reason
    // code from the server; fall back to matching the message text so this
    // still works if the reason field is ever missing.
    const platformDisabled = policyBlocked && (
        data?.policy.reason === 'FEATURE_DISABLED'
        || (data?.policy.message || '').toLowerCase().includes('currently disabled')
    )

    // Single small explanation shown directly under the greyed Send button —
    // the button must never be mutely disabled with nothing nearby to tell
    // the user why. Only meaningful once account data has loaded and we're
    // not already mid-send (the spinner explains that state on its own).
    const blockReason = useMemo(() => {
        if (!data || sending) return null
        if (suspended) return 'Blocked — your SMS account is suspended.'
        if (policyBlocked) {
            return platformDisabled
                ? "Blocked — KFT SMS is not live yet. You'll be able to send once the admin switches it on."
                : (data.policy.message || 'Blocked — no sender ID is available for your account yet.')
        }
        if (allRecipients.length === 0) return 'Add at least one recipient to enable sending.'
        if (preview.length < 3) return 'Write a message (at least 3 characters) to enable sending.'
        if (overCap && caps) return `Remove ${(allRecipients.length - caps.max_recipients_per_send).toLocaleString()} recipient(s) — over your plan's limit.`
        if (insufficient) return 'Not enough SMS credits for this send.'
        if (scheduleOn && !scheduleAt) return 'Pick a schedule date and time.'
        return null
    }, [data, sending, suspended, policyBlocked, platformDisabled, allRecipients.length, preview.length, overCap, insufficient, scheduleOn, scheduleAt, caps])

    // ── Handlers ─────────────────────────────────────────────────────────────

    const toggleGroup = async (g: GroupOption) => {
        if (selectedGroups.has(g.id)) {
            setSelectedGroups(prev => {
                const next = new Set(prev)
                next.delete(g.id)
                return next
            })
            return
        }
        if (!groupNumbersRef.current[g.id]) {
            setLoadingGroupId(g.id)
            try {
                const nums: string[] = []
                for (let page = 0; page < 20; page++) {
                    const { data: rows, error } = await (supabase as any)
                        .from('sms_group_contacts')
                        .select('phone_number')
                        .eq('group_id', g.id)
                        .range(page * 1000, page * 1000 + 999)
                    if (error) throw error
                    for (const r of rows ?? []) {
                        const n = normalizeGhanaPhone(String(r.phone_number))
                        if (n) nums.push(n)
                    }
                    if ((rows ?? []).length < 1000) break
                }
                groupNumbersRef.current[g.id] = nums
                forceGroupTick(t => t + 1)
            } catch (err) {
                console.error('[SMS Compose] group members load:', err)
                toast.error(`Could not load "${g.name}" members`)
                setLoadingGroupId(null)
                return
            }
            setLoadingGroupId(null)
        }
        setSelectedGroups(prev => new Set(prev).add(g.id))
    }

    const handleCsvFile = async (file: File) => {
        try {
            const text  = await file.text()
            const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0)
            if (lines.length === 0) { toast.error('That file is empty'); return }

            const header = parseCsvLine(lines[0])
            let phoneCol = header.findIndex(h => PHONE_COL_RE.test(h))
            let startRow = 1
            if (phoneCol === -1) {
                phoneCol = 0
                // No named phone column — first row is data unless it clearly isn't a number
                startRow = normalizeGhanaPhone(header[0] ?? '') ? 0 : 1
            }

            const seen = new Set<string>()
            let invalid = 0
            let dupes = 0
            for (let i = startRow; i < lines.length; i++) {
                const cells = parseCsvLine(lines[i])
                const n = normalizeGhanaPhone(cells[phoneCol] ?? '')
                if (!n) { invalid++; continue }
                if (seen.has(n)) { dupes++; continue }
                seen.add(n)
            }

            setCsvNumbers([...seen])
            setCsvSummary({ name: file.name, total: lines.length - startRow, valid: seen.size, invalid, dupes })
            if (seen.size === 0) toast.warning('No valid Ghana numbers found in that file')
            else toast.success(`${seen.size} number(s) imported from ${file.name}`)
        } catch {
            toast.error('Could not read that file')
        } finally {
            if (csvInputRef.current) csvInputRef.current.value = ''
        }
    }

    const clearCsv = () => { setCsvNumbers([]); setCsvSummary(null) }

    const clearAllRecipients = () => {
        setManualText('')
        setSelectedGroups(new Set())
        clearCsv()
        setSelectedCustomerPhones(new Set())
    }

    const toggleCustomerPhone = (phone: string) => {
        setSelectedCustomerPhones(prev => {
            const next = new Set(prev)
            next.has(phone) ? next.delete(phone) : next.add(phone)
            return next
        })
    }

    const selectAllMyCustomers = () => {
        setSelectedCustomerPhones(new Set(filteredMyCustomers.map(c => c.normPhone)))
    }

    const handleScheduleToggle = (on: boolean) => {
        setScheduleOn(on)
        if (on) {
            if (!scheduleAt) setScheduleAt(toLocalInputValue(new Date(Date.now() + 10 * 60_000)))
            // iOS: keep focus inside the gesture chain — double rAF, never setTimeout
            requestAnimationFrame(() => {
                requestAnimationFrame(() => { scheduleRef.current?.focus() })
            })
        }
    }

    const buildScheduledAt = (): { ok: true; iso: string | null } | { ok: false; error: string } => {
        if (!scheduleOn || !scheduleAt) return { ok: true, iso: null }
        const t = new Date(scheduleAt)
        if (isNaN(t.getTime())) return { ok: false, error: 'Pick a valid date and time' }
        if (t.getTime() < Date.now() + 2 * 60_000) return { ok: false, error: 'Schedule at least 2 minutes from now' }
        if (t.getTime() > Date.now() + 30 * 86_400_000) return { ok: false, error: 'Schedule must be within the next 30 days' }
        return { ok: true, iso: t.toISOString() }
    }

    const openConfirm = () => {
        const sched = buildScheduledAt()
        if (!sched.ok) { toast.error(sched.error); return }
        setConfirmOpen(true)
    }

    const handleSend = async () => {
        if (!data) return
        const sched = buildScheduledAt()
        if (!sched.ok) { toast.error(sched.error); return }
        setConfirmOpen(false)
        setSending(true)
        setCallout(null)
        try {
            const res = await fetch('/api/sms/campaigns', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: preview,
                    recipients: allRecipients,
                    ...(sender ? { sender } : {}),
                    ...(sched.iso ? { scheduledAt: sched.iso } : {}),
                }),
            })
            const json = await res.json().catch(() => null)
            if (!res.ok || !json?.success) {
                const msg = json?.error || 'Send failed — please try again'
                if (json?.blocked)           setCallout({ kind: 'blocked', message: msg })
                else if (res.status === 402) setCallout({ kind: 'credits', message: msg })
                else if (res.status === 403) setCallout({ kind: 'suspended', message: msg })
                else if (res.status === 429) setCallout({ kind: 'rate', message: msg })
                else toast.error(msg)
                return
            }
            setResult(json.data as CampaignResult)
        } catch {
            toast.error('Network error — please try again')
        } finally {
            setSending(false)
        }
    }

    const resetComposer = async () => {
        setResult(null)
        setCallout(null)
        setMessage('')
        clearAllRecipients()
        setScheduleOn(false)
        setScheduleAt('')
        setConfirmOpen(false)
        await fetchAccount() // refresh wallet balance
    }

    // ── Templates ────────────────────────────────────────────────────────────

    const openTemplates = () => {
        setTemplatesOpen(true)
        void fetchTemplates() // refresh silently; existing list stays visible
    }

    const applyTemplate = (t: TemplateRow) => {
        setMessage(sanitizeText(t.body))
        setPendingTemplate(null)
        setTemplatesOpen(false)
    }

    // Loading a template replaces the textarea — confirm first if there's content.
    const pickTemplate = (t: TemplateRow) => {
        if (message.trim().length > 0) setPendingTemplate(t)
        else applyTemplate(t)
    }

    const openSaveTemplate = () => {
        if (preview.length < 3) return
        setTemplateName('')
        setSaveOpen(true)
        // iOS: keep focus inside the gesture chain — double rAF, never setTimeout
        requestAnimationFrame(() => {
            requestAnimationFrame(() => { templateNameRef.current?.focus() })
        })
    }

    const saveTemplate = async () => {
        const name = templateName.trim()
        if (name.length < 1) { toast.error('Give your template a name'); return }
        if (preview.length < 3) { toast.error('Message is too short to save'); return }
        setSavingTemplate(true)
        try {
            const res = await fetch('/api/sms/templates', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: name.slice(0, 60), body: preview }),
            })
            const json = await res.json().catch(() => null)
            if (res.status === 409) { toast.error(json?.error || 'Template limit reached (30)'); return }
            if (!res.ok || !json?.success) { toast.error(json?.error || 'Could not save template'); return }
            setTemplates(prev => [json.data.template as TemplateRow, ...prev])
            setSaveOpen(false)
            setTemplateName('')
            toast.success('Template saved')
        } catch {
            toast.error('Network error — could not save template')
        } finally {
            setSavingTemplate(false)
        }
    }

    const deleteTemplate = async (id: string) => {
        setDeletingId(id)
        try {
            const res  = await fetch(`/api/sms/templates?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
            const json = await res.json().catch(() => null)
            if (!res.ok || !json?.success) { toast.error(json?.error || 'Could not delete template'); return }
            setTemplates(prev => prev.filter(t => t.id !== id))
            toast.success('Template deleted')
        } catch {
            toast.error('Network error — could not delete template')
        } finally {
            setDeletingId(null)
            setConfirmDeleteId(null)
        }
    }

    // ── Loading / error shells ───────────────────────────────────────────────

    if (loading) {
        return (
            <div className="space-y-5 pb-20 md:pb-6 max-w-2xl mx-auto">
                <div className="space-y-2">
                    <Skeleton className="h-8 w-40" />
                    <Skeleton className="h-5 w-64" />
                </div>
                <Skeleton className="h-20 w-full rounded-2xl" />
                <Skeleton className="h-56 w-full rounded-2xl" />
                <Skeleton className="h-64 w-full rounded-2xl" />
                <Skeleton className="h-24 w-full rounded-2xl" />
            </div>
        )
    }

    if (loadError || !data) {
        return (
            <div className="max-w-md mx-auto text-center py-20 space-y-3">
                <div className="w-14 h-14 mx-auto rounded-full bg-red-50 dark:bg-red-950/30 flex items-center justify-center">
                    <AlertCircle className="w-6 h-6 text-red-500" />
                </div>
                <p className="font-semibold">Could not load KFT SMS</p>
                <p className="text-sm text-muted-foreground">{loadError || 'Something went wrong.'}</p>
                <Button
                    variant="outline"
                    className="h-10 gap-2"
                    onClick={async () => { setLoading(true); const acc = await fetchAccount(); if (acc) await fetchGroups(acc.account.id); setLoading(false) }}
                >
                    <RefreshCcw className="w-4 h-4" /> Retry
                </Button>
            </div>
        )
    }

    // Auth may still be resolving even after account data has loaded — the
    // acceptance gate is keyed by dbUser.id, so never mount it (or show real
    // content) until that id is known. Show the same shell used while loading.
    if (!dbUser?.id) {
        return (
            <div className="space-y-5 pb-20 md:pb-6 max-w-2xl mx-auto">
                <div className="space-y-2">
                    <Skeleton className="h-8 w-40" />
                    <Skeleton className="h-5 w-64" />
                </div>
                <Skeleton className="h-20 w-full rounded-2xl" />
                <Skeleton className="h-56 w-full rounded-2xl" />
                <Skeleton className="h-64 w-full rounded-2xl" />
                <Skeleton className="h-24 w-full rounded-2xl" />
            </div>
        )
    }

    // ── Success screen ───────────────────────────────────────────────────────

    if (result) {
        const scheduled = result.status === 'queued' && scheduleOn && !!scheduleAt
        const headline = scheduled ? 'Campaign scheduled'
            : result.status === 'queued' ? 'Campaign queued'
            : result.status === 'completed' ? 'Campaign sent'
            : result.status === 'partial' ? 'Campaign partially sent'
            : result.status === 'failed' ? 'Campaign failed'
            : 'Campaign processing'
        const sub = scheduled
            ? `Your message goes out ${new Date(scheduleAt).toLocaleString()} to ${result.recipients.toLocaleString()} recipient(s).`
            : result.status === 'queued'
                ? `Your message is queued and will be dispatched shortly to ${result.recipients.toLocaleString()} recipient(s).`
                : `Delivery report is being compiled for ${result.recipients.toLocaleString()} recipient(s).`
        return (
            <SmsAcceptanceGate userId={dbUser.id} product="kft">
            <div className="max-w-md mx-auto pb-20 md:pb-6">
                <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
                    <Card className="rounded-2xl border shadow-sm overflow-hidden">
                        <div className={cn(
                            'h-1.5 w-full',
                            result.status === 'failed' ? 'bg-red-500'
                                : result.status === 'partial' ? 'bg-amber-500'
                                : 'bg-emerald-500',
                        )} />
                        <CardContent className="p-6 space-y-5 text-center">
                            <div className={cn(
                                'w-16 h-16 mx-auto rounded-full flex items-center justify-center',
                                result.status === 'failed'
                                    ? 'bg-red-50 dark:bg-red-950/30'
                                    : scheduled || result.status === 'queued'
                                        ? 'bg-blue-50 dark:bg-blue-950/30'
                                        : 'bg-emerald-50 dark:bg-emerald-950/30',
                            )}>
                                {scheduled || result.status === 'queued'
                                    ? <CalendarClock className="w-8 h-8 text-blue-600" />
                                    : result.status === 'failed'
                                        ? <AlertCircle className="w-8 h-8 text-red-500" />
                                        : <CheckCircle2 className="w-8 h-8 text-emerald-600" />}
                            </div>
                            <div>
                                <h2 className="text-lg font-bold">{headline}</h2>
                                <p className="text-sm text-muted-foreground mt-1">{sub}</p>
                            </div>

                            <div className="rounded-xl bg-muted/40 p-4 grid grid-cols-2 gap-3 text-left text-sm">
                                <div>
                                    <p className="text-[11px] text-muted-foreground">Recipients</p>
                                    <p className="font-bold tabular-nums">{result.recipients.toLocaleString()}</p>
                                </div>
                                <div>
                                    <p className="text-[11px] text-muted-foreground">Sender</p>
                                    <p className="font-bold truncate">{result.sender}</p>
                                </div>
                                <div>
                                    <p className="text-[11px] text-muted-foreground">SMS per recipient</p>
                                    <p className="font-bold tabular-nums">{result.segments}</p>
                                </div>
                                <div>
                                    <p className="text-[11px] text-muted-foreground">Credits charged</p>
                                    <p className="font-bold tabular-nums text-emerald-600">{result.credits_charged.toLocaleString()}</p>
                                </div>
                                {typeof result.sent === 'number' && (
                                    <div>
                                        <p className="text-[11px] text-muted-foreground">Accepted by network</p>
                                        <p className="font-bold tabular-nums text-emerald-600">{result.sent.toLocaleString()}</p>
                                    </div>
                                )}
                                {typeof result.failed === 'number' && result.failed > 0 && (
                                    <div>
                                        <p className="text-[11px] text-muted-foreground">Failed (auto-refunded)</p>
                                        <p className="font-bold tabular-nums text-red-500">{result.failed.toLocaleString()}</p>
                                    </div>
                                )}
                                {typeof result.balance === 'number' && (
                                    <div>
                                        <p className="text-[11px] text-muted-foreground">Credits left</p>
                                        <p className="font-bold tabular-nums">{result.balance.toLocaleString()}</p>
                                    </div>
                                )}
                            </div>

                            <div className="space-y-2">
                                <Link href={`/dashboard/sms/records/${result.id}`} className="block">
                                    <Button className="w-full h-11 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold gap-2">
                                        View delivery report <ChevronRight className="w-4 h-4" />
                                    </Button>
                                </Link>
                                <Button variant="outline" className="w-full h-11 gap-2" onClick={resetComposer}>
                                    <Megaphone className="w-4 h-4" /> Compose another campaign
                                </Button>
                                <Link href="/dashboard/sms" className="block">
                                    <Button variant="ghost" className="w-full h-10 text-muted-foreground">Back to KFT SMS</Button>
                                </Link>
                            </div>
                        </CardContent>
                    </Card>
                </motion.div>
            </div>
            </SmsAcceptanceGate>
        )
    }

    // ── Composer ─────────────────────────────────────────────────────────────

    return (
        <SmsAcceptanceGate userId={dbUser.id} product="kft">
        <div className="space-y-5 pb-20 md:pb-6 max-w-2xl mx-auto">

            {/* Header */}
            <div className="flex items-start justify-between gap-2">
                <div>
                    <Link href="/dashboard/sms">
                        <Button variant="ghost" size="sm" className="w-fit gap-2 -ml-2 text-muted-foreground hover:text-emerald-600">
                            <ArrowLeft className="w-4 h-4" /> KFT SMS
                        </Button>
                    </Link>
                    <h1 className="text-xl font-bold flex items-center gap-2 mt-1">
                        <Megaphone className="w-5 h-5 text-emerald-600" /> Compose Campaign
                    </h1>
                </div>
                <Link href="/dashboard/sms/credits" className="shrink-0">
                    <div className="flex items-center gap-1.5 px-3 h-10 rounded-xl border border-purple-200 dark:border-purple-900 bg-purple-50/60 dark:bg-purple-900/10 hover:border-purple-300 transition-colors">
                        <Coins className="w-4 h-4 text-purple-600" />
                        <span className="text-sm font-bold tabular-nums">{walletCredits.toLocaleString()}</span>
                        <span className="text-[10px] text-muted-foreground hidden sm:inline">credits</span>
                    </div>
                </Link>
            </div>

            {/* Suspended / policy blocked */}
            {suspended && (
                <div className="flex items-start gap-2.5 p-4 rounded-2xl bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900">
                    <ShieldAlert className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
                    <div className="text-xs text-red-700 dark:text-red-400">
                        <p className="font-bold">Your SMS account is suspended</p>
                        <p className="mt-0.5">{data.account.suspended_reason || 'Contact support to restore sending.'}</p>
                    </div>
                </div>
            )}
            {!suspended && policyBlocked && (
                <div className="flex items-start gap-2.5 p-4 rounded-2xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
                    <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                    <div className="text-xs text-amber-800 dark:text-amber-300">
                        <p className="font-bold">{platformDisabled ? 'KFT SMS is not live yet' : 'Sending is unavailable right now'}</p>
                        <p className="mt-0.5">
                            {platformDisabled
                                ? "The platform is currently switched off by the admin. You'll be able to send once it launches."
                                : (data.policy.message || 'No sender ID is available for your account yet.')}
                        </p>
                    </div>
                </div>
            )}

            {/* ── Sender identity ── */}
            <Card className="rounded-2xl">
                <CardContent className="p-4 sm:p-5 space-y-3">
                    <div className="flex items-center justify-between">
                        <h3 className="text-sm font-semibold flex items-center gap-1.5">
                            <BadgeCheck className="w-4 h-4 text-emerald-500" /> Sending as
                        </h3>
                        <span className={cn(
                            'text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full',
                            data.account.mode === 'business'
                                ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                                : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
                        )}>
                            {data.account.mode === 'business' ? 'Business' : 'Platform'}
                        </span>
                    </div>

                    {data.account.mode === 'business' ? (
                        senderOptions.length > 0 ? (
                            <Select value={sender} onValueChange={setSender}>
                                <SelectTrigger className="h-11 font-semibold">
                                    <SelectValue placeholder="Choose a sender ID" />
                                </SelectTrigger>
                                <SelectContent>
                                    {senderOptions.map(o => (
                                        <SelectItem key={o.value} value={o.value}>
                                            <span className="flex items-center gap-2">
                                                {o.value}
                                                <span className="text-[10px] text-muted-foreground">{o.own ? 'your sender ID' : 'shared pool'}</span>
                                            </span>
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        ) : (
                            <p className="text-xs text-muted-foreground">
                                No approved sender ID yet — your messages will use the platform default once one is approved.
                            </p>
                        )
                    ) : senderOptions.length > 0 ? (
                        // Platform mode (feature-wave7): platform sender + any of the
                        // account's own approved senders (KFT or shop).
                        <Select value={sender} onValueChange={setSender}>
                            <SelectTrigger className="h-11 font-semibold">
                                <SelectValue placeholder="Choose a sender ID" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value={platformSenderValue}>
                                    <span className="flex items-center gap-2">
                                        {platformSenderValue}
                                        <span className="text-[10px] text-muted-foreground">platform default</span>
                                    </span>
                                </SelectItem>
                                {senderOptions.map(o => (
                                    <SelectItem key={o.value} value={o.value}>
                                        <span className="flex items-center gap-2">
                                            {o.value}
                                            <span className="text-[10px] text-muted-foreground">your sender ID</span>
                                        </span>
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    ) : (
                        <div className="flex items-center gap-2.5">
                            <span className="inline-flex items-center gap-1.5 px-3 h-10 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 text-sm font-bold text-emerald-700 dark:text-emerald-400">
                                <ShieldCheck className="w-4 h-4" /> {effectiveSender}
                            </span>
                            <p className="text-[11px] text-muted-foreground flex-1">
                                Fixed platform sender — request your own Sender ID to send under your own name.
                            </p>
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* ── Recipients ── */}
            <Card className="rounded-2xl">
                <CardContent className="p-4 sm:p-5 space-y-4">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                        <h3 className="text-sm font-semibold flex items-center gap-1.5">
                            <Users className="w-4 h-4 text-emerald-500" /> Recipients
                        </h3>
                        {allRecipients.length > 0 && (
                            <Button
                                variant="outline" size="sm"
                                className="h-9 text-xs text-red-500 hover:text-red-600 border-red-200 dark:border-red-900 gap-1"
                                onClick={clearAllRecipients}
                            >
                                <X className="w-3 h-3" /> Clear all
                            </Button>
                        )}
                    </div>

                    <Tabs value={tab} onValueChange={v => setTab(v as RecipientTab)}>
                        <TabsList className="w-full grid grid-cols-4 h-11">
                            <TabsTrigger value="manual" className="gap-1.5 text-xs sm:text-sm">
                                <ClipboardList className="w-3.5 h-3.5" /> Paste
                                {manualParsed.valid.length > 0 && <span className="tabular-nums text-[10px] font-bold text-emerald-600">({manualParsed.valid.length})</span>}
                            </TabsTrigger>
                            <TabsTrigger value="groups" className="gap-1.5 text-xs sm:text-sm">
                                <Users className="w-3.5 h-3.5" /> Groups
                                {selectedGroups.size > 0 && <span className="tabular-nums text-[10px] font-bold text-emerald-600">({selectedGroups.size})</span>}
                            </TabsTrigger>
                            <TabsTrigger value="customers" className="gap-1.5 text-xs sm:text-sm">
                                <Store className="w-3.5 h-3.5" /> Mine
                                {selectedCustomerPhones.size > 0 && <span className="tabular-nums text-[10px] font-bold text-emerald-600">({selectedCustomerPhones.size})</span>}
                            </TabsTrigger>
                            <TabsTrigger value="csv" className="gap-1.5 text-xs sm:text-sm">
                                <FileText className="w-3.5 h-3.5" /> CSV
                                {csvNumbers.length > 0 && <span className="tabular-nums text-[10px] font-bold text-emerald-600">({csvNumbers.length})</span>}
                            </TabsTrigger>
                        </TabsList>

                        {/* Manual paste */}
                        <TabsContent value="manual" className="space-y-2 mt-3">
                            <Textarea
                                value={manualText}
                                onChange={e => setManualText(e.target.value)}
                                placeholder={'Paste numbers separated by commas, spaces or new lines\ne.g. 0244123456, 0551234567\n233209876543'}
                                rows={4}
                                className="resize-none font-mono text-sm"
                                inputMode="tel"
                                autoComplete="off"
                            />
                            {(manualParsed.valid.length > 0 || manualParsed.invalid.length > 0) && (
                                <div className="flex items-center gap-3 text-[11px] font-medium">
                                    <span className="flex items-center gap-1 text-emerald-600">
                                        <CheckCircle2 className="w-3 h-3" /> {manualParsed.valid.length} valid
                                    </span>
                                    {manualParsed.invalid.length > 0 && (
                                        <span className="flex items-center gap-1 text-red-500" title={manualParsed.invalid.slice(0, 10).join(', ')}>
                                            <AlertCircle className="w-3 h-3" /> {manualParsed.invalid.length} invalid (e.g. {manualParsed.invalid[0]})
                                        </span>
                                    )}
                                </div>
                            )}
                            <p className="text-[11px] text-muted-foreground">Ghana numbers only · duplicates removed automatically.</p>
                        </TabsContent>

                        {/* Groups */}
                        <TabsContent value="groups" className="space-y-2 mt-3">
                            {groupsLoading ? (
                                <div className="space-y-2">
                                    <Skeleton className="h-12 w-full rounded-xl" />
                                    <Skeleton className="h-12 w-full rounded-xl" />
                                </div>
                            ) : groups.length === 0 ? (
                                <div className="text-center py-6 space-y-2">
                                    <div className="w-11 h-11 mx-auto rounded-full bg-muted flex items-center justify-center">
                                        <Users className="w-5 h-5 text-muted-foreground" />
                                    </div>
                                    <p className="text-xs text-muted-foreground">You have no contact groups yet.</p>
                                    <Link href="/dashboard/sms/contacts">
                                        <Button variant="outline" size="sm" className="h-10 text-xs gap-1.5 mt-1">
                                            <Users className="w-3.5 h-3.5" /> Create a contact group
                                        </Button>
                                    </Link>
                                </div>
                            ) : (
                                <>
                                    <div className="max-h-56 overflow-y-auto rounded-xl border divide-y">
                                        {groups.map(g => {
                                            const checked = selectedGroups.has(g.id)
                                            const busy = loadingGroupId === g.id
                                            return (
                                                <button
                                                    key={g.id}
                                                    type="button"
                                                    onClick={() => toggleGroup(g)}
                                                    disabled={busy}
                                                    className="w-full min-h-[48px] flex items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-muted/40 disabled:opacity-60"
                                                >
                                                    <div className="min-w-0">
                                                        <p className="text-xs font-semibold truncate">{g.name}</p>
                                                        <p className="text-[11px] text-muted-foreground">{g.count.toLocaleString()} contact(s)</p>
                                                    </div>
                                                    {busy ? (
                                                        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground shrink-0" />
                                                    ) : (
                                                        <div className={cn(
                                                            'w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-colors',
                                                            checked ? 'bg-emerald-500 border-emerald-500' : 'border-muted-foreground/30',
                                                        )}>
                                                            {checked && <CheckCircle2 className="w-3.5 h-3.5 text-white" />}
                                                        </div>
                                                    )}
                                                </button>
                                            )
                                        })}
                                    </div>
                                    <div className="flex items-center justify-between">
                                        <p className="text-[11px] text-muted-foreground">
                                            {selectedGroups.size > 0
                                                ? `${groupRecipients.length.toLocaleString()} number(s) from ${selectedGroups.size} group(s)`
                                                : 'Tick groups to add their members'}
                                        </p>
                                        <Link href="/dashboard/sms/contacts" className="text-[11px] font-semibold text-emerald-600 hover:text-emerald-700">
                                            Manage groups →
                                        </Link>
                                    </div>
                                </>
                            )}
                        </TabsContent>

                        {/* My Customers — this user's own shop customer list */}
                        <TabsContent value="customers" className="space-y-2 mt-3">
                            {myCustomersLoading ? (
                                <div className="space-y-2">
                                    <Skeleton className="h-12 w-full rounded-xl" />
                                    <Skeleton className="h-12 w-full rounded-xl" />
                                </div>
                            ) : myCustomersError ? (
                                <div className="text-center py-6 space-y-2">
                                    <AlertCircle className="w-6 h-6 mx-auto text-red-500" />
                                    <p className="text-xs text-red-600">{myCustomersError}</p>
                                    <Button variant="outline" size="sm" className="h-9 text-xs gap-1.5" onClick={fetchMyCustomers}>
                                        <RefreshCcw className="w-3.5 h-3.5" /> Retry
                                    </Button>
                                </div>
                            ) : myCustomersNormalized.length === 0 ? (
                                <div className="text-center py-6 space-y-2">
                                    <div className="w-11 h-11 mx-auto rounded-full bg-muted flex items-center justify-center">
                                        <Store className="w-5 h-5 text-muted-foreground" />
                                    </div>
                                    <p className="text-xs text-muted-foreground">No customers yet — customers from your shop orders appear here.</p>
                                </div>
                            ) : (
                                <>
                                    <div className="flex items-center gap-2">
                                        <div className="relative flex-1">
                                            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                                            <Input
                                                value={customerSearch}
                                                onChange={e => setCustomerSearch(e.target.value)}
                                                placeholder="Search name or phone..."
                                                className="h-9 pl-8 text-xs"
                                            />
                                        </div>
                                        <Button variant="outline" size="sm" className="h-9 text-xs shrink-0" onClick={selectAllMyCustomers}>
                                            Select all ({filteredMyCustomers.length})
                                        </Button>
                                    </div>
                                    <div className="max-h-56 overflow-y-auto rounded-xl border divide-y">
                                        {filteredMyCustomers.length === 0 ? (
                                            <p className="text-xs text-muted-foreground text-center py-4">No customers match your search.</p>
                                        ) : filteredMyCustomers.map(c => {
                                            const checked = selectedCustomerPhones.has(c.normPhone)
                                            return (
                                                <button
                                                    key={c.id}
                                                    type="button"
                                                    onClick={() => toggleCustomerPhone(c.normPhone)}
                                                    className="w-full min-h-[48px] flex items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-muted/40"
                                                >
                                                    <div className="min-w-0">
                                                        <p className="text-xs font-semibold truncate">{c.name || c.phone}</p>
                                                        <p className="text-[11px] text-muted-foreground font-mono">{c.phone}</p>
                                                    </div>
                                                    <div className={cn(
                                                        'w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-colors',
                                                        checked ? 'bg-emerald-500 border-emerald-500' : 'border-muted-foreground/30',
                                                    )}>
                                                        {checked && <CheckCircle2 className="w-3.5 h-3.5 text-white" />}
                                                    </div>
                                                </button>
                                            )
                                        })}
                                    </div>
                                    <p className="text-[11px] text-muted-foreground">
                                        {selectedCustomerPhones.size > 0
                                            ? `${selectedCustomerPhones.size.toLocaleString()} customer(s) selected`
                                            : 'Tap customers to add them as recipients'}
                                    </p>
                                </>
                            )}
                        </TabsContent>

                        {/* CSV upload */}
                        <TabsContent value="csv" className="space-y-2 mt-3">
                            <input
                                ref={csvInputRef}
                                type="file"
                                accept=".csv,text/csv,text/plain"
                                className="hidden"
                                onChange={e => { const f = e.target.files?.[0]; if (f) handleCsvFile(f) }}
                            />
                            <button
                                type="button"
                                onClick={() => csvInputRef.current?.click()}
                                className="w-full rounded-xl border-2 border-dashed border-muted-foreground/25 hover:border-emerald-400 dark:hover:border-emerald-700 transition-colors p-6 flex flex-col items-center gap-2"
                            >
                                <div className="w-11 h-11 rounded-full bg-emerald-50 dark:bg-emerald-900/20 flex items-center justify-center">
                                    <Upload className="w-5 h-5 text-emerald-600" />
                                </div>
                                <p className="text-xs font-semibold">Tap to upload a CSV file</p>
                                <p className="text-[11px] text-muted-foreground">
                                    First column, or a column named <code className="bg-muted px-1 rounded">phone</code>, is used.
                                </p>
                            </button>

                            {csvSummary && (
                                <div className="rounded-xl border bg-muted/30 p-3 space-y-1.5">
                                    <div className="flex items-center justify-between gap-2">
                                        <p className="text-xs font-semibold flex items-center gap-1.5 min-w-0">
                                            <FileText className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                                            <span className="truncate">{csvSummary.name}</span>
                                        </p>
                                        <Button
                                            variant="ghost" size="sm"
                                            className="h-9 w-9 p-0 text-red-500 hover:text-red-600 shrink-0"
                                            onClick={clearCsv}
                                            title="Remove imported file"
                                        >
                                            <Trash2 className="w-3.5 h-3.5" />
                                        </Button>
                                    </div>
                                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] font-medium">
                                        <span className="text-muted-foreground">{csvSummary.total} row(s)</span>
                                        <span className="text-emerald-600">{csvSummary.valid} valid</span>
                                        {csvSummary.invalid > 0 && <span className="text-red-500">{csvSummary.invalid} invalid</span>}
                                        {csvSummary.dupes > 0 && <span className="text-amber-600">{csvSummary.dupes} duplicate(s) removed</span>}
                                    </div>
                                </div>
                            )}
                        </TabsContent>
                    </Tabs>

                    {/* Merged summary + cap meter */}
                    {caps && (
                        <div className="space-y-1.5 pt-1">
                            <div className="flex items-center justify-between text-[11px] font-medium">
                                <span className={cn(overCap ? 'text-red-600 font-bold' : 'text-muted-foreground')}>
                                    {allRecipients.length.toLocaleString()} / {caps.max_recipients_per_send.toLocaleString()} recipients (unique)
                                </span>
                                {overCap && (
                                    <span className="text-red-600 font-bold flex items-center gap-1">
                                        <AlertCircle className="w-3 h-3" /> Over the limit
                                    </span>
                                )}
                            </div>
                            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                                <div
                                    className={cn(
                                        'h-full rounded-full transition-all',
                                        overCap ? 'bg-red-500' : allRecipients.length > caps.max_recipients_per_send * 0.8 ? 'bg-amber-500' : 'bg-emerald-500',
                                    )}
                                    style={{ width: `${Math.min(100, (allRecipients.length / Math.max(1, caps.max_recipients_per_send)) * 100)}%` }}
                                />
                            </div>
                            {overCap && (
                                <p className="text-[11px] text-red-600">
                                    Remove {(allRecipients.length - caps.max_recipients_per_send).toLocaleString()} recipient(s) — your plan allows {caps.max_recipients_per_send.toLocaleString()} per send.
                                </p>
                            )}
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* ── Message ── */}
            <Card className="rounded-2xl">
                <CardContent className="p-4 sm:p-5 space-y-3">
                    <div className="flex items-center justify-between">
                        <h3 className="text-sm font-semibold flex items-center gap-1.5">
                            <Send className="w-4 h-4 text-emerald-500" /> Message
                        </h3>
                        <button
                            type="button"
                            onClick={() => setShowPreview(v => !v)}
                            className="min-h-[40px] px-2 flex items-center gap-1 text-[11px] font-semibold text-emerald-600 hover:text-emerald-700"
                        >
                            <Smartphone className="w-3 h-3" /> {showPreview ? 'Hide' : 'Show'} preview
                        </button>
                    </div>

                    {/* Template toolbar */}
                    <div className="flex items-center gap-2">
                        <Button
                            type="button" variant="outline" size="sm"
                            onClick={openTemplates}
                            className="h-10 flex-1 justify-center gap-1.5 text-xs sm:text-sm"
                        >
                            <LayoutTemplate className="w-4 h-4" /> Templates
                            {!templatesLoading && templates.length > 0 && (
                                <span className="tabular-nums text-[11px] font-bold text-emerald-600">({templates.length})</span>
                            )}
                        </Button>
                        <Button
                            type="button" variant="outline" size="sm"
                            onClick={openSaveTemplate}
                            disabled={preview.length < 3}
                            className="h-10 flex-1 justify-center gap-1.5 text-xs sm:text-sm text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-900 disabled:opacity-40"
                        >
                            <BookmarkPlus className="w-4 h-4" /> Save template
                        </Button>
                    </div>

                    <Textarea
                        value={message}
                        onChange={e => setMessage(sanitizeText(e.target.value))}
                        placeholder="e.g. Hot deal this weekend! MTN 10GB for GHS 45. Reply STOP to opt out."
                        rows={5}
                        maxLength={1000}
                        className="resize-none"
                    />

                    {messageHasEmoji && (
                        <p className="flex items-start gap-1 text-[11px] font-medium text-amber-600">
                            <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
                            Emojis cannot be delivered over SMS — they are removed from the message your recipients receive (see preview).
                        </p>
                    )}

                    {/* Stats bar */}
                    <div className="flex items-center justify-between flex-wrap gap-1 text-[11px]">
                        <span className="font-medium text-muted-foreground">
                            {segInfo.length} chars · {segInfo.remaining} left in segment
                        </span>
                        <span className="flex items-center gap-1.5">
                            <span className={cn(
                                'px-1.5 py-0.5 rounded-full font-bold text-[10px]',
                                segInfo.encoding === 'unicode'
                                    ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                                    : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
                            )}>
                                {segInfo.encoding === 'unicode' ? `Unicode · ${segInfo.singleLimit}/seg` : `GSM-7 · ${segInfo.singleLimit}/seg`}
                            </span>
                            <span className="font-bold text-foreground tabular-nums">{segInfo.segments} SMS</span>
                        </span>
                    </div>

                    {/* Phone-style preview */}
                    <AnimatePresence initial={false}>
                        {showPreview && (
                            <motion.div
                                initial={{ opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: 'auto' }}
                                exit={{ opacity: 0, height: 0 }}
                                transition={{ duration: 0.2 }}
                                className="overflow-hidden"
                            >
                                <div className="rounded-xl border bg-muted/30 p-3">
                                    <div className="bg-white dark:bg-zinc-900 rounded-xl px-3 pt-2 pb-3 shadow-inner">
                                        <p className="text-center text-[10px] font-bold text-muted-foreground tracking-wide mb-2">
                                            {effectiveSender}
                                        </p>
                                        {preview ? (
                                            <div className="inline-block bg-zinc-100 dark:bg-zinc-800 text-foreground text-xs px-3 py-2 rounded-2xl rounded-tl-sm max-w-[85%] whitespace-pre-wrap break-words leading-relaxed">
                                                {preview}
                                            </div>
                                        ) : (
                                            <p className="text-[11px] text-muted-foreground/50 italic text-center py-2">
                                                Your message will appear here as you type…
                                            </p>
                                        )}
                                    </div>
                                </div>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </CardContent>
            </Card>

            {/* ── Schedule ── */}
            <Card className="rounded-2xl">
                <CardContent className="p-4 sm:p-5 space-y-3">
                    <div className="flex items-center justify-between gap-3">
                        <div className="flex items-start gap-2.5">
                            <CalendarClock className="w-4 h-4 text-emerald-500 mt-0.5" />
                            <div>
                                <p className="text-sm font-semibold">Send later</p>
                                <p className="text-[11px] text-muted-foreground">Schedule between 2 minutes and 30 days from now.</p>
                            </div>
                        </div>
                        <Switch checked={scheduleOn} onCheckedChange={handleScheduleToggle} aria-label="Send later" />
                    </div>
                    <AnimatePresence initial={false}>
                        {scheduleOn && (
                            <motion.div
                                initial={{ opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: 'auto' }}
                                exit={{ opacity: 0, height: 0 }}
                                transition={{ duration: 0.2 }}
                                className="overflow-hidden"
                            >
                                <Input
                                    ref={scheduleRef}
                                    type="datetime-local"
                                    value={scheduleAt}
                                    min={scheduleMin}
                                    max={scheduleMax}
                                    onChange={e => setScheduleAt(e.target.value)}
                                    className="h-11"
                                />
                            </motion.div>
                        )}
                    </AnimatePresence>
                </CardContent>
            </Card>

            {/* ── Cost summary ── */}
            <Card className={cn(
                'rounded-2xl border transition-colors',
                insufficient
                    ? 'border-red-200 dark:border-red-900 bg-red-50/40 dark:bg-red-950/10'
                    : 'border-emerald-200 dark:border-emerald-900 bg-emerald-50/40 dark:bg-emerald-900/10',
            )}>
                <CardContent className="p-4 sm:p-5 space-y-3">
                    <div className="grid grid-cols-3 gap-2 text-center">
                        <div>
                            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Recipients</p>
                            <p className="text-lg font-bold tabular-nums">{allRecipients.length.toLocaleString()}</p>
                        </div>
                        <div>
                            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">SMS each</p>
                            <p className="text-lg font-bold tabular-nums">{segInfo.segments}</p>
                        </div>
                        <div>
                            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Total credits</p>
                            <p className={cn('text-lg font-bold tabular-nums', insufficient ? 'text-red-600' : 'text-emerald-600')}>
                                {creditsNeeded.toLocaleString()}
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center justify-between border-t pt-2.5 text-[11px]">
                        <span className="text-muted-foreground flex items-center gap-1">
                            <Coins className="w-3 h-3" /> Wallet: <strong className="text-foreground tabular-nums">{walletCredits.toLocaleString()}</strong> credits
                        </span>
                        {allRecipients.length > 0 && !insufficient && (
                            <span className="text-muted-foreground">
                                {(walletCredits - creditsNeeded).toLocaleString()} left after send
                            </span>
                        )}
                    </div>
                    {insufficient && (
                        <div className="flex items-start gap-2 p-3 rounded-xl bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-400">
                            <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                            <span>
                                You need <strong>{(creditsNeeded - walletCredits).toLocaleString()}</strong> more credit(s) for this send.{' '}
                                <Link href="/dashboard/sms/credits" className="underline font-bold">Buy credits →</Link>
                            </span>
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* ── Error callouts from the API ── */}
            {callout && (
                <div className={cn(
                    'flex items-start gap-2.5 p-4 rounded-2xl border text-xs',
                    callout.kind === 'blocked'
                        ? 'bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-900 text-red-700 dark:text-red-400'
                        : 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300',
                )}>
                    {callout.kind === 'blocked'
                        ? <ShieldAlert className="w-4 h-4 flex-shrink-0 mt-0.5" />
                        : <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />}
                    <div className="space-y-1">
                        <p className="font-bold">
                            {callout.kind === 'blocked' ? 'Message blocked by our content policy'
                                : callout.kind === 'credits' ? 'Not enough SMS credits'
                                : callout.kind === 'suspended' ? 'Account suspended'
                                : 'Rate limit reached'}
                        </p>
                        <p>{callout.message}</p>
                        {callout.kind === 'blocked' && (
                            <p className="text-muted-foreground">
                                Remove anything that looks like OTP/PIN requests, prizes, fake payment receipts or outside links, then try again. No credits were charged.
                            </p>
                        )}
                        {callout.kind === 'credits' && (
                            <Link href="/dashboard/sms/credits">
                                <Button size="sm" className="h-10 mt-1 bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5">
                                    <Coins className="w-3.5 h-3.5" /> Buy Credits
                                </Button>
                            </Link>
                        )}
                    </div>
                </div>
            )}

            {/* ── Submit ── */}
            <div className="space-y-1.5">
                <Button
                    onClick={openConfirm}
                    disabled={!canReview}
                    className="w-full h-14 bg-emerald-600 hover:bg-emerald-700 text-white text-base font-bold gap-2 shadow-lg shadow-emerald-600/20 disabled:shadow-none"
                >
                    {sending
                        ? <><Loader2 className="w-4 h-4 animate-spin" /> Sending…</>
                        : scheduleOn
                            ? <><CalendarClock className="w-4 h-4" /> Review &amp; Schedule{allRecipients.length > 0 ? ` (${allRecipients.length.toLocaleString()})` : ''}</>
                            : <><Send className="w-4 h-4" /> Review &amp; Send{allRecipients.length > 0 ? ` to ${allRecipients.length.toLocaleString()} recipient(s)` : ''}</>}
                </Button>
                {!canReview && data && blockReason && (
                    <p className="text-center text-[11px] text-muted-foreground">{blockReason}</p>
                )}
            </div>

            {/* ── Confirm dialog ── */}
            <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
                <DialogContent className="max-w-sm" aria-describedby={undefined}>
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            {scheduleOn ? <CalendarClock className="w-4 h-4 text-emerald-600" /> : <Send className="w-4 h-4 text-emerald-600" />}
                            {scheduleOn ? 'Confirm Schedule' : 'Confirm Send'}
                        </DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4">
                        <div className="rounded-xl border bg-muted/30 p-3">
                            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                                From {effectiveSender}
                            </p>
                            <p className="text-sm whitespace-pre-wrap break-words line-clamp-5">{preview}</p>
                        </div>
                        <div className="rounded-xl bg-muted/40 p-4 space-y-2 text-sm">
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">Recipients</span>
                                <span className="font-semibold tabular-nums">{allRecipients.length.toLocaleString()}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">SMS per recipient</span>
                                <span className="font-semibold tabular-nums">{segInfo.segments}</span>
                            </div>
                            {scheduleOn && scheduleAt && (
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">Goes out</span>
                                    <span className="font-semibold">{new Date(scheduleAt).toLocaleString()}</span>
                                </div>
                            )}
                            <div className="flex justify-between border-t pt-2">
                                <span className="text-muted-foreground">Total credits</span>
                                <span className="font-bold text-lg text-emerald-600 tabular-nums">{creditsNeeded.toLocaleString()}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">Remaining after</span>
                                <span className={cn('font-semibold tabular-nums', walletCredits - creditsNeeded < 5 ? 'text-amber-600' : 'text-foreground')}>
                                    {(walletCredits - creditsNeeded).toLocaleString()} credits
                                </span>
                            </div>
                        </div>
                        <p className="text-[11px] text-muted-foreground flex items-start gap-1.5">
                            <Sparkles className="w-3 h-3 mt-0.5 flex-shrink-0 text-emerald-500" />
                            Failed deliveries are refunded automatically to your credit wallet.
                        </p>
                    </div>
                    <DialogFooter className="gap-2">
                        <Button variant="ghost" className="h-10" onClick={() => setConfirmOpen(false)}>Cancel</Button>
                        <Button
                            onClick={handleSend}
                            disabled={sending || insufficient}
                            className="h-10 bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5"
                        >
                            {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : scheduleOn ? <CalendarClock className="w-3.5 h-3.5" /> : <Send className="w-3.5 h-3.5" />}
                            {scheduleOn ? 'Schedule' : 'Send Now'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* ── Templates sheet ── */}
            <Sheet open={templatesOpen} onOpenChange={setTemplatesOpen}>
                <SheetContent
                    side="bottom"
                    hideCloseButton
                    aria-describedby={undefined}
                    className="rounded-t-2xl p-0 gap-0 flex flex-col max-h-[85vh]"
                >
                    {/* Drag handle + close */}
                    <div className="relative flex items-center justify-center pt-3 pb-2 shrink-0">
                        <div className="w-10 h-1 rounded-full bg-muted-foreground/25" />
                        <SheetClose className="absolute right-3 top-1.5 w-9 h-9 rounded-full flex items-center justify-center text-muted-foreground hover:bg-muted">
                            <X className="w-4 h-4" />
                            <span className="sr-only">Close</span>
                        </SheetClose>
                    </div>
                    <SheetHeader className="px-4 pb-3 shrink-0">
                        <SheetTitle className="text-base flex items-center gap-2">
                            <LayoutTemplate className="w-4 h-4 text-emerald-600" /> Saved templates
                        </SheetTitle>
                    </SheetHeader>
                    <div className="flex-1 overflow-y-auto px-4 pb-8 space-y-2">
                        {templatesLoading && templates.length === 0 ? (
                            <div className="space-y-2">
                                <Skeleton className="h-16 w-full rounded-xl" />
                                <Skeleton className="h-16 w-full rounded-xl" />
                            </div>
                        ) : templates.length === 0 ? (
                            <div className="text-center py-10 space-y-3">
                                <div className="w-14 h-14 mx-auto rounded-full bg-muted flex items-center justify-center">
                                    <LayoutTemplate className="w-6 h-6 text-muted-foreground" />
                                </div>
                                <div>
                                    <p className="text-sm font-semibold">No templates yet</p>
                                    <p className="text-xs text-muted-foreground mt-1">
                                        Write a message, then tap <span className="font-semibold text-foreground">Save template</span> to reuse it any time.
                                    </p>
                                </div>
                            </div>
                        ) : (
                            templates.map(t => (
                                <div key={t.id} className="rounded-xl border p-3 flex items-start gap-2">
                                    <button
                                        type="button"
                                        onClick={() => pickTemplate(t)}
                                        className="flex-1 min-w-0 text-left min-h-[44px]"
                                    >
                                        <p className="text-sm font-semibold truncate">{t.name}</p>
                                        <p className="text-[11px] text-muted-foreground line-clamp-2 whitespace-pre-wrap break-words mt-0.5">{t.body}</p>
                                    </button>
                                    <Button
                                        variant="ghost" size="sm"
                                        onClick={() => setConfirmDeleteId(t.id)}
                                        className="h-9 w-9 p-0 text-red-500 hover:text-red-600 shrink-0"
                                        title="Delete template"
                                    >
                                        <Trash2 className="w-4 h-4" />
                                    </Button>
                                </div>
                            ))
                        )}
                    </div>
                </SheetContent>
            </Sheet>

            {/* ── Save as template dialog ── */}
            <Dialog open={saveOpen} onOpenChange={o => { setSaveOpen(o); if (!o) setTemplateName('') }}>
                <DialogContent className="max-w-sm" aria-describedby={undefined}>
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <BookmarkPlus className="w-4 h-4 text-emerald-600" /> Save as template
                        </DialogTitle>
                    </DialogHeader>
                    <div className="space-y-3">
                        <Input
                            ref={templateNameRef}
                            value={templateName}
                            onChange={e => setTemplateName(e.target.value.slice(0, 60))}
                            onKeyDown={e => { if (e.key === 'Enter') saveTemplate() }}
                            maxLength={60}
                            placeholder="Template name (e.g. Weekend promo)"
                            className="h-11"
                        />
                        <div className="rounded-xl border bg-muted/30 p-3">
                            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">Message</p>
                            <p className="text-xs whitespace-pre-wrap break-words line-clamp-4">{preview}</p>
                        </div>
                    </div>
                    <DialogFooter className="gap-2">
                        <Button variant="ghost" className="h-10" onClick={() => setSaveOpen(false)}>Cancel</Button>
                        <Button
                            onClick={saveTemplate}
                            disabled={savingTemplate || templateName.trim().length < 1 || preview.length < 3}
                            className="h-10 bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5"
                        >
                            {savingTemplate ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <BookmarkPlus className="w-3.5 h-3.5" />}
                            Save
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* ── Replace-message confirm ── */}
            <Dialog open={!!pendingTemplate} onOpenChange={o => { if (!o) setPendingTemplate(null) }}>
                <DialogContent className="max-w-sm" aria-describedby={undefined}>
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <RefreshCcw className="w-4 h-4 text-amber-500" /> Replace message?
                        </DialogTitle>
                    </DialogHeader>
                    <p className="text-sm text-muted-foreground">
                        Your current message will be replaced with{' '}
                        <strong className="text-foreground">{pendingTemplate?.name}</strong>. This cannot be undone.
                    </p>
                    <DialogFooter className="gap-2">
                        <Button variant="ghost" className="h-10" onClick={() => setPendingTemplate(null)}>Keep mine</Button>
                        <Button
                            onClick={() => { if (pendingTemplate) applyTemplate(pendingTemplate) }}
                            className="h-10 bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5"
                        >
                            <RefreshCcw className="w-3.5 h-3.5" /> Replace
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* ── Delete-template confirm ── */}
            <Dialog open={!!confirmDeleteId} onOpenChange={o => { if (!o) setConfirmDeleteId(null) }}>
                <DialogContent className="max-w-sm" aria-describedby={undefined}>
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <Trash2 className="w-4 h-4 text-red-500" /> Delete template?
                        </DialogTitle>
                    </DialogHeader>
                    <p className="text-sm text-muted-foreground">This template will be permanently removed. This cannot be undone.</p>
                    <DialogFooter className="gap-2">
                        <Button variant="ghost" className="h-10" onClick={() => setConfirmDeleteId(null)}>Cancel</Button>
                        <Button
                            onClick={() => { if (confirmDeleteId) deleteTemplate(confirmDeleteId) }}
                            disabled={!!deletingId}
                            className="h-10 bg-red-600 hover:bg-red-700 text-white gap-1.5"
                        >
                            {deletingId ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                            Delete
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
        </SmsAcceptanceGate>
    )
}
