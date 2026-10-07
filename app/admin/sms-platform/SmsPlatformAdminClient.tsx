'use client'

/**
 * KFT SMS — admin console for the user SMS platform.
 *
 * Single endpoint: /api/admin/sms-platform
 *   GET  → review queues, sender requests, flagged campaigns, accounts,
 *          revenue rollup, platform settings
 *   POST → review_business / sender_action / set_account_status /
 *          set_business_hold / dismiss_flag / update_settings
 *
 * Optimistic-free by design: every action re-fetches the whole payload.
 */

import { useEffect, useMemo, useState } from 'react'
import { formatCurrency, cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
    Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
    MessageSquare, Loader2, RefreshCcw, Save, Coins, Wallet, Flag, Ban, ShieldCheck,
    Check, Copy, ExternalLink, Building2, XCircle, CheckCircle2, Send, ShieldAlert,
    Search, Users, Settings2, ChevronDown, ChevronRight, AlertTriangle,
    Plus, X, Radio, Inbox, KeyRound, Timer, Rocket, Package, Pencil, Layers, Trash2,
} from 'lucide-react'
import { toast } from '@/lib/toast'
import { DEFAULT_SMS_CAPS, type SmsModeCaps, type SmsBundle, type SmsBundleMode } from '@/lib/sms-platform-types'

// ─── API payload types ───────────────────────────────────────────────────────

/** Supabase embeds can arrive as object OR single-element array — normalize. */
type Rel<T> = T | T[] | null | undefined
function rel<T>(v: Rel<T>): T | null {
    if (!v) return null
    return Array.isArray(v) ? (v[0] ?? null) : v
}

interface BusinessProfile {
    id: string
    account_id: string
    business_name: string
    description: string | null
    domain_link: string | null
    ghana_card_number_masked: string | null
    contact_whatsapp_number: string | null
    status: 'under_review' | 'approved' | 'rejected' | 'revoked'
    review_notes: string | null
    whatsapp_verified: boolean
    whatsapp_verification_note: string | null
    created_at: string
    sms_accounts: Rel<{ id: string; user_id: string; mode: string; status: string; business_on_hold: boolean }>
}

interface SenderRequest {
    id: string
    account_id: string
    sender_text: string
    status: 'under_review' | 'submitted_to_hubtel' | 'approved' | 'rejected' | 'revoked'
    hubtel_reference: string | null
    rejection_reason: string | null
    requested_at: string
    approved_at: string | null
    sms_accounts: Rel<{ user_id: string }>
}

interface FlaggedCampaign {
    id: string
    account_id: string
    sender_used: string | null
    mode_at_send: 'platform' | 'business'
    message: string
    recipients_count: number
    status: string
    flag_reason: string | null
    flag_severity: 'fraud' | 'info' | null
    created_at: string
    sms_accounts: Rel<{ user_id: string }>
}

interface RecentCampaign {
    id: string
    account_id: string
    sender_used: string | null
    mode_at_send: 'platform' | 'business'
    message: string
    recipients_count: number
    status: string
    flagged: boolean
    flag_reason: string | null
    flag_severity: 'fraud' | 'info' | null
    created_at: string
    sms_accounts: Rel<{ user_id: string }>
}

interface AccountRow {
    id: string
    user_id: string
    mode: 'platform' | 'business'
    status: 'active' | 'suspended'
    suspended_reason: string | null
    default_sender: string | null
    business_on_hold: boolean
    created_at: string
    sms_wallets: Rel<{ credits: number; total_purchased: number; total_used: number }>
    smsApiKey: { id: string; status: 'pending' | 'active' | 'revoked'; rateLimitOverride: number | null } | null
}

interface AdminData {
    businessProfiles: BusinessProfile[]
    senderRequests: SenderRequest[]
    flaggedCampaigns: FlaggedCampaign[]
    recentCampaigns: RecentCampaign[]
    accounts: AccountRow[]
    revenue: { totalRevenue: number; creditsSold: number; purchases: number }
    settings: Record<string, unknown>
    bundles: SmsBundle[]
}

// ─── Settings parsing (defensive — admin_settings.value is raw JSONB) ────────

type CapsForm = Record<'max_recipients_per_send' | 'sends_per_hour' | 'recipients_per_day', string>

const capsToForm = (raw: unknown, mode: 'platform' | 'business'): CapsForm => {
    const d = DEFAULT_SMS_CAPS[mode]
    const m = raw && typeof raw === 'object' ? (raw as any)[mode] : null
    const pick = (k: keyof SmsModeCaps) => {
        const n = Number(m?.[k])
        return String(Number.isFinite(n) && n > 0 ? Math.floor(n) : d[k])
    }
    return {
        max_recipients_per_send: pick('max_recipients_per_send'),
        sends_per_hour: pick('sends_per_hour'),
        recipients_per_day: pick('recipients_per_day'),
    }
}

const toIntOr = (v: unknown, dflt: number) => {
    const n = Number(typeof v === 'string' ? v.replace(/"/g, '') : v)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt
}

// ─── Small display helpers ───────────────────────────────────────────────────

const ROLES = ['customer', 'agent', 'dealer', 'admin', 'sub-admin'] as const
const POOL_SENDER_RE = /^[A-Za-z0-9 ]{3,11}$/

const shortId = (id: string) => id.slice(0, 8)
const fmtDate = (iso: string) => new Date(iso).toLocaleString()

const SENDER_STATUS_META: Record<SenderRequest['status'], { label: string; variant: 'warning' | 'processing' | 'success' | 'failed' | 'secondary' }> = {
    under_review: { label: 'Under Review', variant: 'warning' },
    submitted_to_hubtel: { label: 'At Hubtel', variant: 'processing' },
    approved: { label: 'Approved', variant: 'success' },
    rejected: { label: 'Rejected', variant: 'failed' },
    revoked: { label: 'Revoked', variant: 'secondary' },
}

/** Message-monitoring status badge — mirrors sms_campaigns' CHECK constraint
 *  (queued/processing/completed/partial/failed/blocked/cancelled). */
const CAMPAIGN_STATUS_META: Record<string, 'warning' | 'processing' | 'completed' | 'failed' | 'secondary'> = {
    queued: 'warning',
    processing: 'processing',
    completed: 'completed',
    partial: 'warning',
    failed: 'failed',
    blocked: 'failed',
    cancelled: 'secondary',
}

const BUNDLE_MODE_META: Record<SmsBundleMode, { label: string; variant: 'secondary' | 'processing' | 'success' }> = {
    platform: { label: 'Platform', variant: 'secondary' },
    business: { label: 'Business', variant: 'processing' },
    both: { label: 'Platform + Business', variant: 'success' },
}
const BUNDLE_MODES: SmsBundleMode[] = ['platform', 'business', 'both']

const emptyBundleForm = (nextSortOrder = 0) => ({
    id: null as string | null,
    name: '',
    credits: '',
    price: '',
    is_active: true,
    sort_order: String(nextSortOrder),
    mode: 'platform' as SmsBundleMode,
})

// ─── Confirmation dialog state machine ───────────────────────────────────────

type DialogState =
    | { kind: 'toggle_feature'; next: boolean }
    | { kind: 'review_business'; profile: BusinessProfile; decision: 'approved' | 'rejected' | 'revoked' }
    | { kind: 'sender'; sender: SenderRequest; op: 'submit_to_hubtel' | 'approve' | 'reject' | 'revoke' }
    | { kind: 'account'; account: AccountRow; suspend: boolean }
    | { kind: 'business_hold'; accountId: string; businessName: string; hold: boolean }
    | null

export default function SmsPlatformAdminClient() {
    const [data, setData] = useState<AdminData | null>(null)
    const [loading, setLoading] = useState(true)
    // Real server error text for the "Failed to load" screen (not just a
    // toast that can be missed) + any per-section warnings from a degraded
    // (but still 200) GET response — surfaced inline instead of silently
    // rendering empty sections.
    const [loadError, setLoadError] = useState<string | null>(null)
    const [warnings, setWarnings] = useState<string[]>([])

    // Parsed feature flag (header switch reads this, not the raw settings map)
    const [featureEnabled, setFeatureEnabled] = useState(false)

    // Settings tab form state (seeded from GET)
    const [poolSenders, setPoolSenders] = useState<string[]>([])
    const [poolInput, setPoolInput] = useState('')
    const [allowedRoles, setAllowedRoles] = useState<string[]>([])
    const [platformCaps, setPlatformCaps] = useState<CapsForm>(capsToForm(null, 'platform'))
    const [businessCaps, setBusinessCaps] = useState<CapsForm>(capsToForm(null, 'business'))
    const [blockedKeywords, setBlockedKeywords] = useState('')
    const [businessBlockedKeywords, setBusinessBlockedKeywords] = useState('')
    const [businessFlaggedKeywords, setBusinessFlaggedKeywords] = useState('')
    const [businessAllowedDomains, setBusinessAllowedDomains] = useState('')
    const [autosuspendThreshold, setAutosuspendThreshold] = useState('5')
    const [flagReviewThreshold, setFlagReviewThreshold] = useState('10')
    const [smsRateLimitPerMin, setSmsRateLimitPerMin] = useState('30')
    const [savingSection, setSavingSection] = useState<string | null>(null)

    // Confirmation dialog + its inputs
    const [dialog, setDialog] = useState<DialogState>(null)
    const [dialogBusy, setDialogBusy] = useState(false)
    const [dNotes, setDNotes] = useState('')
    const [dHubtelRef, setDHubtelRef] = useState('')
    const [dWhatsappVerified, setDWhatsappVerified] = useState(false)

    // Inline (non-dialog) action in flight — flag dismiss, doc-url load
    const [actioningId, setActioningId] = useState<string | null>(null)

    const [showApproved, setShowApproved] = useState(false)
    const [showRejected, setShowRejected] = useState(false)
    const [showRevoked, setShowRevoked] = useState(false)

    // Flagged tab
    const [severityFilter, setSeverityFilter] = useState<'all' | 'fraud' | 'info'>('all')
    const [expandedFlags, setExpandedFlags] = useState<Set<string>>(new Set())

    // Messages tab — read-only monitoring mirror of every user's sends
    // (not just flagged ones). Simple client-side text filter only.
    const [messageFilter, setMessageFilter] = useState('')
    const [expandedMessages, setExpandedMessages] = useState<Set<string>>(new Set())

    // Accounts tab
    const [accountSearch, setAccountSearch] = useState('')

    // Bundles tab: add/edit form (id === null → create) + save-in-flight flag
    const [bundleForm, setBundleForm] = useState(emptyBundleForm())
    const [savingBundle, setSavingBundle] = useState(false)
    const [deletingBundleId, setDeletingBundleId] = useState<string | null>(null)
    const [confirmDeleteBundleId, setConfirmDeleteBundleId] = useState<string | null>(null)

    useEffect(() => { fetchData() }, []) // eslint-disable-line react-hooks/exhaustive-deps

    const fetchData = async () => {
        setLoadError(null)
        try {
            const [res, bundlesRes] = await Promise.all([
                fetch('/api/admin/sms-platform'),
                fetch('/api/admin/sms-platform/bundles'),
            ])
            const json = await res.json()
            if (!json.success) throw new Error(json.error || 'Failed to load SMS platform data')

            let bundles: SmsBundle[] = []
            let bundleWarnings: string[] = []
            const bundlesJson = await bundlesRes.json()
            if (bundlesJson.success) {
                bundles = bundlesJson.data?.bundles || []
                bundleWarnings = bundlesJson.data?.warnings || []
            } else {
                toast.error(bundlesJson.error || 'Failed to load bundles')
            }

            const d: AdminData = { ...json.data, bundles }
            setData(d)
            setWarnings([...(json.data?.warnings || []), ...bundleWarnings])

            // Seed settings forms from the raw JSONB values (defensive parse)
            const s = d.settings || {}
            setFeatureEnabled(s['user_sms_enabled'] === true || s['user_sms_enabled'] === 'true')
            setPoolSenders(Array.isArray(s['user_sms_default_senders'])
                ? (s['user_sms_default_senders'] as unknown[]).map(String)
                : [])
            setAllowedRoles(Array.isArray(s['user_sms_allowed_roles'])
                ? (s['user_sms_allowed_roles'] as unknown[]).map(String)
                : ['customer', 'agent', 'dealer', 'admin'])
            setPlatformCaps(capsToForm(s['user_sms_caps'], 'platform'))
            setBusinessCaps(capsToForm(s['user_sms_caps'], 'business'))
            setBlockedKeywords(typeof s['user_sms_blocked_keywords'] === 'string' ? s['user_sms_blocked_keywords'] : '')
            setBusinessBlockedKeywords(typeof s['user_sms_business_blocked_keywords'] === 'string' ? s['user_sms_business_blocked_keywords'] : '')
            setBusinessFlaggedKeywords(typeof s['user_sms_business_flagged_keywords'] === 'string' ? s['user_sms_business_flagged_keywords'] : '')
            setBusinessAllowedDomains(typeof s['user_sms_business_allowed_domains'] === 'string' ? s['user_sms_business_allowed_domains'] : '')
            setAutosuspendThreshold(String(toIntOr(s['user_sms_autosuspend_threshold'], 5)))
            setFlagReviewThreshold(String(toIntOr(s['user_sms_flag_review_threshold'], 10)))
            setSmsRateLimitPerMin(String(toIntOr((s['api_rate_limits'] as any)?.sms, 30)))
        } catch (err: any) {
            const msg = err.message || 'Failed to load SMS platform data'
            setLoadError(msg)
            toast.error(msg)
        } finally {
            setLoading(false)
        }
    }

    // ── Shared POST runner (refetch after every mutation — no optimism) ──────
    const post = async (payload: Record<string, unknown>) => {
        const res = await fetch('/api/admin/sms-platform', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        })
        const json = await res.json()
        if (!json.success) throw new Error(json.error || 'Action failed')
        return json
    }

    const runInline = async (id: string, payload: Record<string, unknown>, okMsg: string) => {
        setActioningId(id)
        try {
            await post(payload)
            toast.success(okMsg)
            await fetchData()
        } catch (err: any) {
            toast.error(err.message || 'Action failed')
        } finally {
            setActioningId(null)
        }
    }

    const copyText = async (text: string, label = 'Copied to clipboard') => {
        try {
            await navigator.clipboard.writeText(text)
            toast.success(label)
        } catch {
            toast.error('Copy failed')
        }
    }

    // ── Dialog helpers ───────────────────────────────────────────────────────
    const openDialog = (d: NonNullable<DialogState>) => {
        setDNotes('')
        setDHubtelRef('')
        setDWhatsappVerified(false)
        setDialog(d)
    }

    const confirmDialog = async () => {
        if (!dialog) return
        let payload: Record<string, unknown>
        let okMsg: string

        switch (dialog.kind) {
            case 'toggle_feature':
                payload = { action: 'update_settings', enabled: dialog.next }
                okMsg = dialog.next ? 'KFT SMS platform enabled' : 'KFT SMS platform disabled'
                break
            case 'review_business':
                if ((dialog.decision === 'rejected' || dialog.decision === 'revoked') && !dNotes.trim()) {
                    toast.error(`${dialog.decision === 'revoked' ? 'Revocation' : 'Rejection'} notes are required`)
                    return
                }
                if (dialog.decision === 'approved' && !dWhatsappVerified) {
                    toast.error('Confirm documents were verified via WhatsApp before approving')
                    return
                }
                payload = {
                    action: 'review_business',
                    profileId: dialog.profile.id,
                    decision: dialog.decision,
                    ...(dNotes.trim() ? { notes: dNotes.trim() } : {}),
                    ...(dialog.decision === 'approved' ? { whatsappVerified: dWhatsappVerified, whatsappVerificationNote: dNotes.trim() || undefined } : {}),
                }
                okMsg = dialog.decision === 'approved'
                    ? `${dialog.profile.business_name} approved — user is now in business mode`
                    : dialog.decision === 'revoked'
                        ? `${dialog.profile.business_name} revoked — user reverted to platform mode`
                        : `${dialog.profile.business_name} rejected — user reverted to platform mode`
                break
            case 'sender': {
                if ((dialog.op === 'reject' || dialog.op === 'revoke') && !dNotes.trim()) {
                    toast.error('A reason is required')
                    return
                }
                payload = {
                    action: 'sender_action',
                    senderId: dialog.sender.id,
                    op: dialog.op,
                    ...(dialog.op === 'approve' && dHubtelRef.trim() ? { hubtelReference: dHubtelRef.trim() } : {}),
                    ...((dialog.op === 'reject' || dialog.op === 'revoke') && dNotes.trim() ? { reason: dNotes.trim() } : {}),
                }
                const verbs: Record<string, string> = {
                    submit_to_hubtel: 'submitted to Hubtel',
                    approve: 'approved',
                    reject: 'rejected',
                    revoke: 'revoked',
                }
                okMsg = `Sender "${dialog.sender.sender_text}" ${verbs[dialog.op]}`
                break
            }
            case 'account':
                payload = {
                    action: 'set_account_status',
                    accountId: dialog.account.id,
                    suspended: dialog.suspend,
                    ...(dialog.suspend && dNotes.trim() ? { reason: dNotes.trim() } : {}),
                }
                okMsg = dialog.suspend ? 'Account suspended' : 'Account re-activated'
                break
            case 'business_hold':
                payload = {
                    action: 'set_business_hold',
                    accountId: dialog.accountId,
                    hold: dialog.hold,
                    ...(dialog.hold && dNotes.trim() ? { reason: dNotes.trim() } : {}),
                }
                okMsg = dialog.hold
                    ? `${dialog.businessName} — business mode put on hold`
                    : `${dialog.businessName} — business mode released`
                break
        }

        setDialogBusy(true)
        try {
            await post(payload)
            toast.success(okMsg)
            setDialog(null)
            await fetchData()
        } catch (err: any) {
            toast.error(err.message || 'Action failed')
        } finally {
            setDialogBusy(false)
        }
    }

    // ── Settings section saves (each posts ONLY its own keys) ────────────────
    const saveSection = async (section: string, payload: Record<string, unknown>, okMsg: string) => {
        setSavingSection(section)
        try {
            await post({ action: 'update_settings', ...payload })
            toast.success(okMsg)
            await fetchData()
        } catch (err: any) {
            toast.error(err.message || 'Failed to save')
        } finally {
            setSavingSection(null)
        }
    }

    const addPoolSender = () => {
        const v = poolInput.trim()
        if (!POOL_SENDER_RE.test(v)) {
            toast.error('Sender must be 3–11 characters — letters, numbers and spaces only')
            return
        }
        if (poolSenders.some(p => p.toLowerCase() === v.toLowerCase())) {
            toast.info('Already in the pool')
            return
        }
        if (poolSenders.length >= 20) {
            toast.error('Pool is limited to 20 senders')
            return
        }
        setPoolSenders(prev => [...prev, v])
        setPoolInput('')
    }

    const saveCaps = () => {
        const parse = (form: CapsForm, label: string): SmsModeCaps | null => {
            const out: Partial<SmsModeCaps> = {}
            for (const k of ['max_recipients_per_send', 'sends_per_hour', 'recipients_per_day'] as const) {
                const n = parseInt(form[k], 10)
                if (!Number.isFinite(n) || n <= 0) {
                    toast.error(`${label}: every cap must be a positive whole number`)
                    return null
                }
                out[k] = n
            }
            return out as SmsModeCaps
        }
        const platform = parse(platformCaps, 'Platform caps')
        if (!platform) return
        const business = parse(businessCaps, 'Business caps')
        if (!business) return
        saveSection('caps', { caps: { platform, business } }, 'Sending caps saved')
    }

    const saveThresholds = () => {
        const auto = parseInt(autosuspendThreshold, 10)
        const review = parseInt(flagReviewThreshold, 10)
        if (!Number.isFinite(auto) || auto < 1 || auto > 100) {
            toast.error('Auto-suspend threshold must be between 1 and 100')
            return
        }
        if (!Number.isFinite(review) || review < 1 || review > 500) {
            toast.error('Flag-review threshold must be between 1 and 500')
            return
        }
        saveSection('thresholds', { autosuspendThreshold: auto, flagReviewThreshold: review }, 'Thresholds saved')
    }

    const saveSmsRateLimit = () => {
        const n = parseInt(smsRateLimitPerMin, 10)
        if (!Number.isFinite(n) || n < 1 || n > 10000) {
            toast.error('SMS API rate limit must be between 1 and 10,000')
            return
        }
        saveSection('rateLimit', { smsRateLimitPerMin: n }, 'SMS API rate limit saved')
    }

    // ── Bundles tab: add/edit form + PUT submit (dedicated bundles route) ────
    const startEditBundle = (b: SmsBundle) => {
        setBundleForm({
            id: b.id,
            name: b.name,
            credits: String(b.credits),
            price: String(b.price),
            is_active: b.is_active,
            sort_order: String(b.sort_order),
            mode: b.mode,
        })
    }

    const cancelBundleForm = () => setBundleForm(emptyBundleForm((data?.bundles.length || 0)))

    const submitBundle = async () => {
        const name = bundleForm.name.trim()
        if (name.length < 2) {
            toast.error('Bundle name must be at least 2 characters')
            return
        }
        const credits = parseInt(bundleForm.credits, 10)
        if (!Number.isFinite(credits) || credits <= 0) {
            toast.error('Credits must be a positive whole number')
            return
        }
        const price = parseFloat(bundleForm.price)
        if (!Number.isFinite(price) || price <= 0) {
            toast.error('Price must be a positive number')
            return
        }
        const sortOrder = parseInt(bundleForm.sort_order, 10)

        setSavingBundle(true)
        try {
            const res = await fetch('/api/admin/sms-platform/bundles', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...(bundleForm.id ? { id: bundleForm.id } : {}),
                    name,
                    credits,
                    price,
                    is_active: bundleForm.is_active,
                    sort_order: Number.isFinite(sortOrder) && sortOrder >= 0 ? sortOrder : 0,
                    mode: bundleForm.mode,
                }),
            })
            const json = await res.json()
            if (!json.success) throw new Error(json.error || 'Failed to save bundle')
            toast.success(bundleForm.id ? `"${name}" bundle updated` : `"${name}" bundle created`)
            setBundleForm(emptyBundleForm((data?.bundles.length || 0) + 1))
            await fetchData()
        } catch (err: any) {
            toast.error(err.message || 'Failed to save bundle')
        } finally {
            setSavingBundle(false)
        }
    }

    const toggleBundleActive = async (b: SmsBundle) => {
        setSavingBundle(true)
        try {
            const res = await fetch('/api/admin/sms-platform/bundles', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: b.id,
                    name: b.name,
                    credits: b.credits,
                    price: b.price,
                    is_active: !b.is_active,
                    sort_order: b.sort_order,
                    mode: b.mode,
                }),
            })
            const json = await res.json()
            if (!json.success) throw new Error(json.error || 'Failed to update bundle')
            toast.success(b.is_active ? `"${b.name}" deactivated` : `"${b.name}" activated`)
            await fetchData()
        } catch (err: any) {
            toast.error(err.message || 'Failed to update bundle')
        } finally {
            setSavingBundle(false)
        }
    }

    const deleteBundle = async (b: SmsBundle) => {
        setDeletingBundleId(b.id)
        try {
            const res = await fetch('/api/admin/sms-platform/bundles', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: b.id }),
            })
            const json = await res.json()
            if (!json.success) throw new Error(json.error || 'Failed to delete bundle')
            toast.success(json.data?.deactivated ? (json.message || `"${b.name}" deactivated — it has purchase history`) : `"${b.name}" deleted`)
            setConfirmDeleteBundleId(null)
            if (bundleForm.id === b.id) cancelBundleForm()
            await fetchData()
        } catch (err: any) {
            toast.error(err.message || 'Failed to delete bundle')
        } finally {
            setDeletingBundleId(null)
        }
    }

    // ── Derived views ────────────────────────────────────────────────────────
    const pendingBusiness = useMemo(
        () => (data?.businessProfiles || []).filter(p => p.status === 'under_review'),
        [data])
    const approvedBusiness = useMemo(
        () => (data?.businessProfiles || []).filter(p => p.status === 'approved'),
        [data])
    const rejectedBusiness = useMemo(
        () => (data?.businessProfiles || []).filter(p => p.status === 'rejected'),
        [data])
    const revokedBusiness = useMemo(
        () => (data?.businessProfiles || []).filter(p => p.status === 'revoked'),
        [data])
    const pendingSenders = useMemo(
        () => (data?.senderRequests || []).filter(s => s.status === 'under_review' || s.status === 'submitted_to_hubtel'),
        [data])
    const fraudFlags = useMemo(
        () => (data?.flaggedCampaigns || []).filter(f => f.flag_severity === 'fraud'),
        [data])
    const visibleFlags = useMemo(
        () => (data?.flaggedCampaigns || []).filter(f => severityFilter === 'all' || f.flag_severity === severityFilter),
        [data, severityFilter])
    const filteredMessages = useMemo(() => {
        const q = messageFilter.trim().toLowerCase()
        const rows = data?.recentCampaigns || []
        if (!q) return rows
        return rows.filter(m => {
            const acc = rel(m.sms_accounts)
            return (m.sender_used || '').toLowerCase().includes(q) ||
                m.message.toLowerCase().includes(q) ||
                m.status.toLowerCase().includes(q) ||
                (acc?.user_id || '').toLowerCase().includes(q)
        })
    }, [data, messageFilter])
    const filteredAccounts = useMemo(() => {
        const q = accountSearch.trim().toLowerCase()
        const rows = data?.accounts || []
        if (!q) return rows
        return rows.filter(a =>
            a.user_id.toLowerCase().includes(q) ||
            (a.default_sender || '').toLowerCase().includes(q) ||
            a.mode.includes(q) ||
            a.status.includes(q))
    }, [data, accountSearch])
    const bundlesByMode = useMemo(() => {
        const bundles = data?.bundles || []
        const grouped: Record<SmsBundleMode, SmsBundle[]> = { platform: [], business: [], both: [] }
        for (const b of bundles) grouped[b.mode].push(b)
        return grouped
    }, [data])

    // ── Loading skeleton ─────────────────────────────────────────────────────
    if (loading) {
        return (
            <div className="space-y-6 p-4 md:p-6 max-w-6xl mx-auto">
                <div className="flex items-center justify-between gap-3">
                    <div className="space-y-2">
                        <Skeleton className="h-6 w-52" />
                        <Skeleton className="h-4 w-80 max-w-full" />
                    </div>
                    <Skeleton className="h-9 w-40" />
                </div>
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2.5">
                    {Array.from({ length: 6 }).map((_, i) => (
                        <Skeleton key={i} className="h-[74px] rounded-xl" />
                    ))}
                </div>
                <Skeleton className="h-10 w-full max-w-2xl rounded-lg" />
                <div className="space-y-3">
                    <Skeleton className="h-40 rounded-2xl" />
                    <Skeleton className="h-40 rounded-2xl" />
                </div>
            </div>
        )
    }

    if (!data) {
        return (
            <div className="flex flex-col items-center justify-center gap-3 py-20 px-4 text-center">
                <AlertTriangle className="w-8 h-8 text-rose-500" />
                <p className="text-sm font-semibold text-rose-600 dark:text-rose-400">Failed to load SMS Platform admin data</p>
                {loadError && <p className="text-xs text-muted-foreground max-w-md">{loadError}</p>}
                <Button variant="outline" size="sm" onClick={fetchData} className="gap-1.5">
                    <RefreshCcw className="w-3.5 h-3.5" /> Retry
                </Button>
            </div>
        )
    }

    return (
        <div className="space-y-6 p-4 md:p-6 max-w-6xl mx-auto">
            {/* ── Header + master switch ─────────────────────────────────── */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                    <h1 className="text-xl font-bold flex items-center gap-2">
                        <MessageSquare className="w-5 h-5 text-emerald-600" />
                        KFT SMS Platform
                        <Badge variant={featureEnabled ? 'success' : 'failed'} className="text-[10px]">
                            {featureEnabled ? 'LIVE' : 'OFF'}
                        </Badge>
                    </h1>
                    <p className="text-muted-foreground text-sm mt-0.5">
                        KYC reviews, sender IDs, fraud flags, accounts and policy for user SMS.
                    </p>
                </div>
                <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2 px-3 py-2 rounded-xl border">
                        <span className="text-xs font-semibold text-muted-foreground">Master switch</span>
                        <Switch
                            checked={featureEnabled}
                            onCheckedChange={(next) => openDialog({ kind: 'toggle_feature', next })}
                            className="data-[state=checked]:bg-emerald-600"
                        />
                    </div>
                    <Button variant="outline" size="sm" onClick={fetchData} className="gap-1.5">
                        <RefreshCcw className="w-3.5 h-3.5" /> Refresh
                    </Button>
                </div>
            </div>

            {/* ── Degraded-section warnings — a sub-query failed but the rest
                 of the page still loaded; never let that be silent. ───── */}
            {warnings.length > 0 && (
                <div className="flex items-start gap-2 px-4 py-2.5 rounded-xl border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400 text-xs">
                    <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                    <div>
                        <p className="font-semibold">Some sections failed to load — the rest of the page is still live</p>
                        <ul className="list-disc list-inside mt-0.5 space-y-0.5">
                            {warnings.map((w, i) => <li key={i}>{w}</li>)}
                        </ul>
                    </div>
                </div>
            )}

            {/* ── Launch control — the obvious on/off (owner-requested) ───── */}
            {featureEnabled ? (
                <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 text-sm font-semibold">
                    <span className="relative flex h-2.5 w-2.5">
                        <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-60 animate-ping" />
                        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
                    </span>
                    Live — customers can buy credits and send SMS.
                </div>
            ) : (
                <Card className="rounded-2xl border-2 border-amber-300 dark:border-amber-800 bg-gradient-to-br from-amber-50 to-emerald-50 dark:from-amber-950/30 dark:to-emerald-950/20 shadow-sm">
                    <CardContent className="p-5 flex flex-col sm:flex-row sm:items-center gap-4">
                        <div className="flex items-start gap-3 min-w-0 flex-1">
                            <div className="w-11 h-11 rounded-xl bg-amber-100 dark:bg-amber-900/40 flex items-center justify-center flex-shrink-0">
                                <Rocket className="w-5 h-5 text-amber-600 dark:text-amber-400" />
                            </div>
                            <div className="min-w-0">
                                <p className="text-base font-bold">SMS Platform is OFF</p>
                                <p className="text-sm text-muted-foreground mt-0.5">
                                    Customers can&apos;t send SMS yet. Flip this on to go live.
                                </p>
                            </div>
                        </div>
                        <Button
                            size="lg"
                            onClick={() => openDialog({ kind: 'toggle_feature', next: true })}
                            className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold flex-shrink-0 w-full sm:w-auto"
                        >
                            <Rocket className="w-4 h-4" /> Turn On SMS Platform
                        </Button>
                    </CardContent>
                </Card>
            )}

            {/* ── Revenue + queue counts ─────────────────────────────────── */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2.5">
                {[
                    { label: 'Total Revenue', value: formatCurrency(data.revenue.totalRevenue), icon: Wallet, color: 'text-emerald-600' },
                    { label: 'Credits Sold', value: data.revenue.creditsSold.toLocaleString(), icon: Coins, color: 'text-blue-600' },
                    { label: 'Purchases', value: data.revenue.purchases.toLocaleString(), icon: MessageSquare, color: 'text-purple-600' },
                    { label: 'Pending Reviews', value: String(pendingBusiness.length), icon: Building2, color: pendingBusiness.length ? 'text-amber-600' : 'text-muted-foreground' },
                    { label: 'Pending Senders', value: String(pendingSenders.length), icon: Radio, color: pendingSenders.length ? 'text-amber-600' : 'text-muted-foreground' },
                    { label: 'Fraud Flags', value: String(fraudFlags.length), icon: ShieldAlert, color: fraudFlags.length ? 'text-red-600' : 'text-muted-foreground' },
                ].map(({ label, value, icon: Icon, color }) => (
                    <Card key={label} className="border shadow-sm rounded-xl">
                        <CardContent className="p-3.5">
                            <div className="flex items-center gap-1.5 mb-1">
                                <Icon className={cn('w-3.5 h-3.5', color)} />
                                <p className="text-[11px] text-muted-foreground font-medium truncate">{label}</p>
                            </div>
                            <p className="text-base font-bold tabular-nums truncate">{value}</p>
                        </CardContent>
                    </Card>
                ))}
            </div>

            {/* ── Tabs ───────────────────────────────────────────────────── */}
            <Tabs defaultValue="business">
                <div className="overflow-x-auto -mx-1 px-1">
                    <TabsList className="w-max">
                        <TabsTrigger value="business" className="gap-1.5 text-xs">
                            <Building2 className="w-3.5 h-3.5" /> Business Reviews
                            {pendingBusiness.length > 0 && (
                                <span className="text-[10px] font-bold px-1.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
                                    {pendingBusiness.length}
                                </span>
                            )}
                        </TabsTrigger>
                        <TabsTrigger value="senders" className="gap-1.5 text-xs">
                            <Radio className="w-3.5 h-3.5" /> Sender IDs
                            {pendingSenders.length > 0 && (
                                <span className="text-[10px] font-bold px-1.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
                                    {pendingSenders.length}
                                </span>
                            )}
                        </TabsTrigger>
                        <TabsTrigger value="flagged" className="gap-1.5 text-xs">
                            <Flag className="w-3.5 h-3.5" /> Flagged
                            {data.flaggedCampaigns.length > 0 && (
                                <span className="text-[10px] font-bold px-1.5 rounded-full bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400">
                                    {data.flaggedCampaigns.length}
                                </span>
                            )}
                        </TabsTrigger>
                        <TabsTrigger value="messages" className="gap-1.5 text-xs">
                            <Inbox className="w-3.5 h-3.5" /> Messages
                            {(data.recentCampaigns?.length || 0) > 0 && (
                                <span className="text-[10px] font-bold px-1.5 rounded-full bg-muted text-muted-foreground">
                                    {data.recentCampaigns.length}
                                </span>
                            )}
                        </TabsTrigger>
                        <TabsTrigger value="accounts" className="gap-1.5 text-xs">
                            <Users className="w-3.5 h-3.5" /> Accounts
                        </TabsTrigger>
                        <TabsTrigger value="bundles" className="gap-1.5 text-xs">
                            <Package className="w-3.5 h-3.5" /> Bundles
                            {(data.bundles?.length || 0) > 0 && (
                                <span className="text-[10px] font-bold px-1.5 rounded-full bg-muted text-muted-foreground">
                                    {data.bundles.length}
                                </span>
                            )}
                        </TabsTrigger>
                        <TabsTrigger value="settings" className="gap-1.5 text-xs">
                            <Settings2 className="w-3.5 h-3.5" /> Settings
                        </TabsTrigger>
                    </TabsList>
                </div>

                {/* ══ TAB 1 — Business Reviews ═══════════════════════════════ */}
                <TabsContent value="business" className="space-y-4 mt-4">
                    {pendingBusiness.length === 0 ? (
                        <EmptyState icon={Building2} text="No business registrations awaiting review." />
                    ) : (
                        pendingBusiness.map(p => {
                            const acc = rel(p.sms_accounts)
                            return (
                                <Card key={p.id} className="rounded-2xl">
                                    <CardContent className="p-5 space-y-3">
                                        <div className="flex flex-wrap items-start justify-between gap-2">
                                            <div className="min-w-0">
                                                <p className="text-sm font-bold flex items-center gap-2">
                                                    <Building2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
                                                    {p.business_name}
                                                    <Badge variant="warning" className="text-[10px]">Under Review</Badge>
                                                </p>
                                                <p className="text-[11px] text-muted-foreground mt-0.5">
                                                    User <button className="font-mono underline-offset-2 hover:underline" onClick={() => copyText(acc?.user_id || '')}>{acc ? shortId(acc.user_id) : '—'}</button>
                                                    {' '}· submitted {fmtDate(p.created_at)}
                                                    {acc && <> · current mode <strong>{acc.mode}</strong></>}
                                                </p>
                                            </div>
                                            {p.domain_link && (
                                                <a
                                                    href={p.domain_link}
                                                    target="_blank" rel="noopener noreferrer"
                                                    className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 hover:underline"
                                                >
                                                    <ExternalLink className="w-3 h-3" /> {p.domain_link}
                                                </a>
                                            )}
                                        </div>

                                        {p.description && (
                                            <p className="text-xs text-muted-foreground break-words border-l-2 border-muted pl-3">
                                                {p.description}
                                            </p>
                                        )}

                                        <div className="flex flex-wrap items-center gap-2 text-xs">
                                            {p.ghana_card_number_masked && (
                                                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-muted font-mono">
                                                    <KeyRound className="w-3 h-3 text-muted-foreground" /> {p.ghana_card_number_masked}
                                                </span>
                                            )}
                                            {p.contact_whatsapp_number && (
                                                <a
                                                    href={`https://wa.me/${p.contact_whatsapp_number}`}
                                                    target="_blank" rel="noopener noreferrer"
                                                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-emerald-200 dark:border-emerald-900 text-emerald-700 dark:text-emerald-400 font-semibold hover:bg-emerald-50 dark:hover:bg-emerald-950/40 transition-colors"
                                                >
                                                    <MessageSquare className="w-3 h-3" /> Chat {p.contact_whatsapp_number} <ExternalLink className="w-2.5 h-2.5" />
                                                </a>
                                            )}
                                        </div>

                                        <div className="flex flex-wrap gap-2 pt-1">
                                            <Button
                                                size="sm"
                                                onClick={() => openDialog({ kind: 'review_business', profile: p, decision: 'approved' })}
                                                className="h-8 text-xs gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold"
                                            >
                                                <CheckCircle2 className="w-3.5 h-3.5" /> Approve
                                            </Button>
                                            <Button
                                                size="sm" variant="outline"
                                                onClick={() => openDialog({ kind: 'review_business', profile: p, decision: 'rejected' })}
                                                className="h-8 text-xs gap-1.5 text-red-600 border-red-200 dark:border-red-900 hover:bg-red-50 dark:hover:bg-red-950/40"
                                            >
                                                <XCircle className="w-3.5 h-3.5" /> Reject
                                            </Button>
                                        </div>
                                    </CardContent>
                                </Card>
                            )
                        })
                    )}

                    {/* Previously decided — collapsed */}
                    <CollapsedProfiles
                        title={`Previously approved (${approvedBusiness.length})`}
                        open={showApproved}
                        onToggle={() => setShowApproved(v => !v)}
                        profiles={approvedBusiness}
                        badge={<Badge variant="success" className="text-[10px]">Approved</Badge>}
                        onOpenHoldDialog={(accountId, businessName, hold) => openDialog({ kind: 'business_hold', accountId, businessName, hold })}
                        onOpenRevokeDialog={(profile) => openDialog({ kind: 'review_business', profile, decision: 'revoked' })}
                    />
                    <CollapsedProfiles
                        title={`Previously rejected (${rejectedBusiness.length})`}
                        open={showRejected}
                        onToggle={() => setShowRejected(v => !v)}
                        profiles={rejectedBusiness}
                        badge={<Badge variant="failed" className="text-[10px]">Rejected</Badge>}
                    />
                    <CollapsedProfiles
                        title={`Previously revoked (${revokedBusiness.length})`}
                        open={showRevoked}
                        onToggle={() => setShowRevoked(v => !v)}
                        profiles={revokedBusiness}
                        badge={<Badge variant="failed" className="text-[10px]">Revoked</Badge>}
                    />
                </TabsContent>

                {/* ══ TAB 2 — Sender IDs ═════════════════════════════════════ */}
                <TabsContent value="senders" className="space-y-4 mt-4">
                    {data.senderRequests.length === 0 ? (
                        <EmptyState icon={Radio} text="No sender ID requests yet." />
                    ) : (
                        (['under_review', 'submitted_to_hubtel', 'approved', 'rejected', 'revoked'] as const).map(status => {
                            const group = data.senderRequests.filter(s => s.status === status)
                            if (group.length === 0) return null
                            const meta = SENDER_STATUS_META[status]
                            return (
                                <Card key={status} className="rounded-2xl overflow-hidden">
                                    <CardContent className="p-0">
                                        <div className="px-4 py-3 border-b flex items-center gap-2">
                                            <h2 className="text-sm font-bold">{meta.label}</h2>
                                            <Badge variant={meta.variant} className="text-[10px]">{group.length}</Badge>
                                        </div>
                                        <div className="divide-y">
                                            {group.map(s => {
                                                const acc = rel(s.sms_accounts)
                                                return (
                                                    <div key={s.id} className="px-4 py-3 flex flex-wrap items-center justify-between gap-2">
                                                        <div className="min-w-0">
                                                            <p className="text-sm font-bold font-mono flex items-center gap-1.5">
                                                                {s.sender_text}
                                                                <button
                                                                    onClick={() => copyText(s.sender_text, `"${s.sender_text}" copied`)}
                                                                    className="text-muted-foreground hover:text-foreground transition-colors"
                                                                    title="Copy sender text"
                                                                >
                                                                    <Copy className="w-3 h-3" />
                                                                </button>
                                                            </p>
                                                            <p className="text-[11px] text-muted-foreground">
                                                                User <button className="font-mono underline-offset-2 hover:underline" onClick={() => copyText(acc?.user_id || '')}>{acc ? shortId(acc.user_id) : '—'}</button>
                                                                {' '}· requested {fmtDate(s.requested_at)}
                                                                {s.approved_at && <> · approved {fmtDate(s.approved_at)}</>}
                                                                {s.hubtel_reference && <> · Hubtel ref <span className="font-mono">{s.hubtel_reference}</span></>}
                                                            </p>
                                                            {s.rejection_reason && (
                                                                <p className="text-[11px] text-red-500 mt-0.5">{s.rejection_reason}</p>
                                                            )}
                                                        </div>
                                                        <div className="flex flex-wrap gap-1.5">
                                                            {status === 'under_review' && (
                                                                <Button
                                                                    size="sm" variant="outline"
                                                                    onClick={() => openDialog({ kind: 'sender', sender: s, op: 'submit_to_hubtel' })}
                                                                    className="h-7 text-[11px] gap-1 text-blue-600 border-blue-200 dark:border-blue-900"
                                                                >
                                                                    <Send className="w-3 h-3" /> Submit to Hubtel
                                                                </Button>
                                                            )}
                                                            {(status === 'under_review' || status === 'submitted_to_hubtel') && (
                                                                <>
                                                                    <Button
                                                                        size="sm"
                                                                        onClick={() => openDialog({ kind: 'sender', sender: s, op: 'approve' })}
                                                                        className="h-7 text-[11px] gap-1 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold"
                                                                    >
                                                                        <CheckCircle2 className="w-3 h-3" /> Approve
                                                                    </Button>
                                                                    <Button
                                                                        size="sm" variant="outline"
                                                                        onClick={() => openDialog({ kind: 'sender', sender: s, op: 'reject' })}
                                                                        className="h-7 text-[11px] gap-1 text-red-600 border-red-200 dark:border-red-900"
                                                                    >
                                                                        <XCircle className="w-3 h-3" /> Reject
                                                                    </Button>
                                                                </>
                                                            )}
                                                            {status === 'approved' && (
                                                                <Button
                                                                    size="sm" variant="outline"
                                                                    onClick={() => openDialog({ kind: 'sender', sender: s, op: 'revoke' })}
                                                                    className="h-7 text-[11px] gap-1 text-red-600 border-red-200 dark:border-red-900"
                                                                >
                                                                    <Ban className="w-3 h-3" /> Revoke
                                                                </Button>
                                                            )}
                                                        </div>
                                                    </div>
                                                )
                                            })}
                                        </div>
                                    </CardContent>
                                </Card>
                            )
                        })
                    )}
                </TabsContent>

                {/* ══ TAB 3 — Flagged campaigns ══════════════════════════════ */}
                <TabsContent value="flagged" className="space-y-4 mt-4">
                    <div className="flex items-center gap-1.5">
                        {(['all', 'fraud', 'info'] as const).map(sev => (
                            <button
                                key={sev}
                                onClick={() => setSeverityFilter(sev)}
                                className={cn(
                                    'px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors capitalize',
                                    severityFilter === sev
                                        ? sev === 'fraud'
                                            ? 'bg-red-600 text-white border-red-600'
                                            : 'bg-foreground text-background border-foreground'
                                        : 'bg-muted text-muted-foreground border-transparent hover:text-foreground'
                                )}
                            >
                                {sev === 'all' ? `All (${data.flaggedCampaigns.length})`
                                    : sev === 'fraud' ? `Fraud (${fraudFlags.length})`
                                        : `Info (${data.flaggedCampaigns.length - fraudFlags.length})`}
                            </button>
                        ))}
                    </div>

                    {visibleFlags.length === 0 ? (
                        <EmptyState icon={ShieldCheck} text="Nothing flagged — all clear." />
                    ) : (
                        <Card className="rounded-2xl overflow-hidden">
                            <CardContent className="p-0">
                                <div className="divide-y">
                                    {visibleFlags.map(f => {
                                        const acc = rel(f.sms_accounts)
                                        const expanded = expandedFlags.has(f.id)
                                        const long = f.message.length > 160
                                        const busy = actioningId === f.id
                                        return (
                                            <div key={f.id} className="px-4 py-3 space-y-1.5">
                                                <div className="flex flex-wrap items-center gap-1.5">
                                                    <Badge variant={f.flag_severity === 'fraud' ? 'failed' : 'secondary'} className="text-[10px] uppercase">
                                                        {f.flag_severity || 'info'}
                                                    </Badge>
                                                    <Badge variant={f.mode_at_send === 'business' ? 'processing' : 'outline'} className="text-[10px]">
                                                        {f.mode_at_send} mode
                                                    </Badge>
                                                    {f.sender_used && (
                                                        <span className="text-[11px] font-mono font-semibold">{f.sender_used}</span>
                                                    )}
                                                    <span className="text-[10px] text-muted-foreground/70 ml-auto">
                                                        {f.recipients_count} recipient(s) · {f.status} · {fmtDate(f.created_at)}
                                                    </span>
                                                </div>
                                                <p className="text-[11px] text-muted-foreground">
                                                    User <button className="font-mono underline-offset-2 hover:underline" onClick={() => copyText(acc?.user_id || '')}>{acc ? shortId(acc.user_id) : '—'}</button>
                                                </p>
                                                <div className="text-xs bg-muted/60 rounded-lg p-2.5 break-words whitespace-pre-wrap">
                                                    {expanded || !long ? f.message : `${f.message.slice(0, 160)}…`}
                                                    {long && (
                                                        <button
                                                            onClick={() => setExpandedFlags(prev => {
                                                                const next = new Set(prev)
                                                                if (next.has(f.id)) next.delete(f.id); else next.add(f.id)
                                                                return next
                                                            })}
                                                            className="ml-1.5 text-blue-600 font-semibold hover:underline"
                                                        >
                                                            {expanded ? 'Show less' : 'Show full message'}
                                                        </button>
                                                    )}
                                                </div>
                                                {f.flag_reason && (
                                                    <p className="text-[11px] text-red-500 font-medium flex items-center gap-1">
                                                        <AlertTriangle className="w-3 h-3 flex-shrink-0" /> {f.flag_reason}
                                                    </p>
                                                )}
                                                <div className="pt-1">
                                                    <Button
                                                        size="sm" variant="outline"
                                                        disabled={busy}
                                                        onClick={() => runInline(f.id, { action: 'dismiss_flag', campaignId: f.id }, 'Flag dismissed')}
                                                        className="h-7 text-[11px] gap-1 text-muted-foreground"
                                                    >
                                                        {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                                                        Dismiss flag
                                                    </Button>
                                                </div>
                                            </div>
                                        )
                                    })}
                                </div>
                            </CardContent>
                        </Card>
                    )}
                </TabsContent>

                {/* ══ TAB — Messages (full monitoring, read-only) ════════════ */}
                <TabsContent value="messages" className="space-y-4 mt-4">
                    <div className="relative max-w-sm">
                        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            placeholder="Search sender, message, user, status…"
                            value={messageFilter}
                            onChange={e => setMessageFilter(e.target.value)}
                            className="h-9 pl-9"
                        />
                    </div>

                    {filteredMessages.length === 0 ? (
                        <EmptyState icon={Inbox} text={messageFilter ? 'No messages match that search.' : 'No messages sent yet.'} />
                    ) : (
                        <Card className="rounded-2xl overflow-hidden">
                            <CardContent className="p-0">
                                <div className="divide-y">
                                    {filteredMessages.map(m => {
                                        const acc = rel(m.sms_accounts)
                                        const long = m.message.length > 160
                                        const expanded = expandedMessages.has(m.id)
                                        return (
                                            <div key={m.id} className="px-4 py-3 space-y-1.5">
                                                <div className="flex flex-wrap items-center gap-1.5">
                                                    {m.sender_used && (
                                                        <span className="text-[11px] font-mono font-semibold">{m.sender_used}</span>
                                                    )}
                                                    <Badge variant={m.mode_at_send === 'business' ? 'processing' : 'outline'} className="text-[10px]">
                                                        {m.mode_at_send} mode
                                                    </Badge>
                                                    <Badge variant={CAMPAIGN_STATUS_META[m.status] ?? 'secondary'} className="text-[10px] capitalize">
                                                        {m.status}
                                                    </Badge>
                                                    {m.flagged && (
                                                        <Badge variant="failed" className="text-[10px] uppercase">
                                                            Flagged{m.flag_severity ? ` · ${m.flag_severity}` : ''}
                                                        </Badge>
                                                    )}
                                                    <span className="text-[10px] text-muted-foreground/70 ml-auto">
                                                        {m.recipients_count} recipient(s) · {fmtDate(m.created_at)}
                                                    </span>
                                                </div>
                                                <p className="text-[11px] text-muted-foreground">
                                                    User <button className="font-mono underline-offset-2 hover:underline" onClick={() => copyText(acc?.user_id || '')}>{acc ? shortId(acc.user_id) : '—'}</button>
                                                </p>
                                                <div className="text-xs bg-muted/60 rounded-lg p-2.5 break-words whitespace-pre-wrap">
                                                    {expanded || !long ? m.message : `${m.message.slice(0, 160)}…`}
                                                    {long && (
                                                        <button
                                                            onClick={() => setExpandedMessages(prev => {
                                                                const next = new Set(prev)
                                                                if (next.has(m.id)) next.delete(m.id); else next.add(m.id)
                                                                return next
                                                            })}
                                                            className="ml-1.5 text-blue-600 font-semibold hover:underline"
                                                        >
                                                            {expanded ? 'Show less' : 'Show full message'}
                                                        </button>
                                                    )}
                                                </div>
                                                {m.flag_reason && (
                                                    <p className="text-[11px] text-red-500 font-medium flex items-center gap-1">
                                                        <AlertTriangle className="w-3 h-3 flex-shrink-0" /> {m.flag_reason}
                                                    </p>
                                                )}
                                            </div>
                                        )
                                    })}
                                </div>
                            </CardContent>
                        </Card>
                    )}
                </TabsContent>

                {/* ══ TAB 4 — Accounts ═══════════════════════════════════════ */}
                <TabsContent value="accounts" className="space-y-4 mt-4">
                    <div className="relative max-w-sm">
                        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            placeholder="Search by user ID, sender, mode, status…"
                            value={accountSearch}
                            onChange={e => setAccountSearch(e.target.value)}
                            className="h-9 pl-9"
                        />
                    </div>

                    {filteredAccounts.length === 0 ? (
                        <EmptyState icon={Users} text={accountSearch ? 'No accounts match that search.' : 'No SMS accounts yet.'} />
                    ) : (
                        <Card className="rounded-2xl overflow-hidden">
                            <CardContent className="p-0">
                                <div className="overflow-x-auto">
                                    <table className="w-full text-sm">
                                        <thead>
                                            <tr className="border-b text-[11px] text-muted-foreground">
                                                <th className="text-left font-semibold px-4 py-2.5">User</th>
                                                <th className="text-left font-semibold px-3 py-2.5">Mode</th>
                                                <th className="text-left font-semibold px-3 py-2.5">Status</th>
                                                <th className="text-right font-semibold px-3 py-2.5">Credits</th>
                                                <th className="text-left font-semibold px-3 py-2.5">Default sender</th>
                                                <th className="text-left font-semibold px-3 py-2.5">Joined</th>
                                                <th className="text-left font-semibold px-3 py-2.5">SMS API Key</th>
                                                <th className="text-right font-semibold px-4 py-2.5">Actions</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y">
                                            {filteredAccounts.map(a => {
                                                const w = rel(a.sms_wallets)
                                                return (
                                                    <tr key={a.id}>
                                                        <td className="px-4 py-2.5">
                                                            <button
                                                                onClick={() => copyText(a.user_id, 'User ID copied')}
                                                                className="font-mono text-xs inline-flex items-center gap-1 hover:text-foreground text-muted-foreground transition-colors"
                                                                title={a.user_id}
                                                            >
                                                                {shortId(a.user_id)} <Copy className="w-2.5 h-2.5" />
                                                            </button>
                                                        </td>
                                                        <td className="px-3 py-2.5">
                                                            <div className="flex items-center gap-1">
                                                                <Badge variant={a.mode === 'business' ? 'processing' : 'secondary'} className="text-[10px]">
                                                                    {a.mode}
                                                                </Badge>
                                                                {a.business_on_hold && (
                                                                    <Badge variant="failed" className="text-[10px]" title="Business mode held — enforced as platform">
                                                                        Held
                                                                    </Badge>
                                                                )}
                                                            </div>
                                                        </td>
                                                        <td className="px-3 py-2.5">
                                                            <Badge variant={a.status === 'active' ? 'success' : 'failed'} className="text-[10px]" title={a.suspended_reason || undefined}>
                                                                {a.status}
                                                            </Badge>
                                                        </td>
                                                        <td className="px-3 py-2.5 text-right tabular-nums">
                                                            <span className="font-bold">{w?.credits ?? 0}</span>
                                                            <span className="text-[10px] text-muted-foreground block">
                                                                {w?.total_purchased ?? 0} bought · {w?.total_used ?? 0} used
                                                            </span>
                                                        </td>
                                                        <td className="px-3 py-2.5 font-mono text-xs">{a.default_sender || '—'}</td>
                                                        <td className="px-3 py-2.5 text-xs text-muted-foreground whitespace-nowrap">
                                                            {new Date(a.created_at).toLocaleDateString()}
                                                        </td>
                                                        <td className="px-3 py-2.5">
                                                            {a.smsApiKey ? (
                                                                <div className="flex flex-col gap-1">
                                                                    <Badge variant={a.smsApiKey.status === 'active' ? 'success' : a.smsApiKey.status === 'revoked' ? 'failed' : 'secondary'} className="text-[10px] w-fit">
                                                                        {a.smsApiKey.status}
                                                                    </Badge>
                                                                    <SmsRateLimitEditor
                                                                        userId={a.user_id}
                                                                        current={a.smsApiKey.rateLimitOverride}
                                                                        onSaved={fetchData}
                                                                        post={post}
                                                                    />
                                                                </div>
                                                            ) : (
                                                                <span className="text-xs text-muted-foreground">—</span>
                                                            )}
                                                        </td>
                                                        <td className="px-4 py-2.5 text-right">
                                                            <Button
                                                                size="sm" variant="outline"
                                                                onClick={() => openDialog({ kind: 'account', account: a, suspend: a.status === 'active' })}
                                                                className={cn('h-7 text-[11px] gap-1',
                                                                    a.status === 'active'
                                                                        ? 'text-red-600 border-red-200 dark:border-red-900'
                                                                        : 'text-emerald-600 border-emerald-200 dark:border-emerald-800')}
                                                            >
                                                                {a.status === 'active'
                                                                    ? <><Ban className="w-3 h-3" /> Suspend</>
                                                                    : <><ShieldCheck className="w-3 h-3" /> Unsuspend</>}
                                                            </Button>
                                                        </td>
                                                    </tr>
                                                )
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                            </CardContent>
                        </Card>
                    )}
                </TabsContent>

                {/* ══ TAB 5 — Bundles (KFT credit tiers, mode-aware) ═════════ */}
                <TabsContent value="bundles" className="space-y-4 mt-4">
                    <div className="grid lg:grid-cols-[1fr_360px] gap-4 items-start">
                        <div className="space-y-4">
                            {data.bundles.length === 0 ? (
                                <EmptyState icon={Package} text="No KFT bundles yet — add the first one." />
                            ) : (
                                BUNDLE_MODES.map(mode => {
                                    const group = bundlesByMode[mode]
                                    if (group.length === 0) return null
                                    const meta = BUNDLE_MODE_META[mode]
                                    return (
                                        <Card key={mode} className="rounded-2xl overflow-hidden">
                                            <CardContent className="p-0">
                                                <div className="px-4 py-3 border-b flex items-center gap-2">
                                                    <Layers className="w-3.5 h-3.5 text-muted-foreground" />
                                                    <h2 className="text-sm font-bold">{meta.label}</h2>
                                                    <Badge variant={meta.variant} className="text-[10px]">{group.length}</Badge>
                                                </div>
                                                <div className="divide-y">
                                                    {group.map(b => (
                                                        <div key={b.id} className="px-4 py-3 flex flex-wrap items-center justify-between gap-2">
                                                            <div className="min-w-0">
                                                                <p className="text-sm font-bold flex items-center gap-2">
                                                                    {b.name}
                                                                    <Badge variant={b.is_active ? 'success' : 'secondary'} className="text-[10px]">
                                                                        {b.is_active ? 'Active' : 'Inactive'}
                                                                    </Badge>
                                                                </p>
                                                                <p className="text-[11px] text-muted-foreground">
                                                                    {b.credits.toLocaleString()} credits · {formatCurrency(b.price)} · sort {b.sort_order}
                                                                </p>
                                                            </div>
                                                            <div className="flex flex-wrap gap-1.5">
                                                                <Button
                                                                    size="sm" variant="outline"
                                                                    disabled={savingBundle}
                                                                    onClick={() => startEditBundle(b)}
                                                                    className="h-7 text-[11px] gap-1"
                                                                >
                                                                    <Pencil className="w-3 h-3" /> Edit
                                                                </Button>
                                                                <Button
                                                                    size="sm" variant="outline"
                                                                    disabled={savingBundle}
                                                                    onClick={() => toggleBundleActive(b)}
                                                                    className={cn('h-7 text-[11px] gap-1', b.is_active ? 'text-red-600 border-red-200 dark:border-red-900' : 'text-emerald-600 border-emerald-200 dark:border-emerald-800')}
                                                                >
                                                                    {b.is_active ? <><Ban className="w-3 h-3" /> Deactivate</> : <><CheckCircle2 className="w-3 h-3" /> Activate</>}
                                                                </Button>
                                                                <Button
                                                                    size="sm" variant="outline"
                                                                    disabled={deletingBundleId === b.id}
                                                                    onClick={() => setConfirmDeleteBundleId(b.id)}
                                                                    className="h-7 text-[11px] gap-1 text-red-600 border-red-200 dark:border-red-900"
                                                                >
                                                                    {deletingBundleId === b.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                                                                    Delete
                                                                </Button>
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            </CardContent>
                                        </Card>
                                    )
                                })
                            )}
                        </div>

                        {/* Add / edit form */}
                        <Card className="rounded-2xl lg:sticky lg:top-4">
                            <CardContent className="p-5 space-y-3">
                                <div className="flex items-center justify-between">
                                    <h2 className="text-sm font-bold flex items-center gap-1.5">
                                        <Package className="w-4 h-4 text-emerald-600" />
                                        {bundleForm.id ? 'Edit KFT Bundle' : 'New KFT Bundle'}
                                    </h2>
                                    {bundleForm.id && (
                                        <button
                                            onClick={cancelBundleForm}
                                            className="text-[11px] font-semibold text-muted-foreground hover:text-foreground transition-colors"
                                        >
                                            Cancel edit
                                        </button>
                                    )}
                                </div>
                                <p className="text-[11px] text-muted-foreground">
                                    Mode controls where this tier is offered: Platform-only, Business-only, or both.
                                </p>

                                <div>
                                    <label className="text-xs font-semibold text-muted-foreground">Mode</label>
                                    <div className="grid grid-cols-3 gap-1.5 mt-1.5">
                                        {BUNDLE_MODES.map(mode => (
                                            <button
                                                key={mode}
                                                type="button"
                                                onClick={() => setBundleForm(prev => ({ ...prev, mode }))}
                                                className={cn(
                                                    'px-2 py-1.5 rounded-lg text-[11px] font-semibold border transition-colors',
                                                    bundleForm.mode === mode
                                                        ? 'bg-emerald-600 text-white border-emerald-600'
                                                        : 'bg-muted text-muted-foreground border-transparent hover:text-foreground'
                                                )}
                                            >
                                                {mode === 'both' ? 'Platform + Business' : mode.charAt(0).toUpperCase() + mode.slice(1)}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                <div>
                                    <label className="text-xs font-semibold text-muted-foreground">Name</label>
                                    <Input
                                        placeholder="e.g. KFT Starter Pack"
                                        value={bundleForm.name}
                                        maxLength={50}
                                        onChange={e => setBundleForm(prev => ({ ...prev, name: e.target.value }))}
                                        className="mt-1 h-9"
                                    />
                                </div>

                                <div className="grid grid-cols-2 gap-2">
                                    <div>
                                        <label className="text-xs font-semibold text-muted-foreground">Credits</label>
                                        <Input
                                            type="number" min="1"
                                            placeholder="e.g. 500"
                                            value={bundleForm.credits}
                                            onChange={e => setBundleForm(prev => ({ ...prev, credits: e.target.value }))}
                                            className="mt-1 h-9"
                                        />
                                    </div>
                                    <div>
                                        <label className="text-xs font-semibold text-muted-foreground">Price (GHS)</label>
                                        <Input
                                            type="number" min="0.01" step="0.01"
                                            placeholder="e.g. 25.00"
                                            value={bundleForm.price}
                                            onChange={e => setBundleForm(prev => ({ ...prev, price: e.target.value }))}
                                            className="mt-1 h-9"
                                        />
                                    </div>
                                </div>

                                <div>
                                    <label className="text-xs font-semibold text-muted-foreground">Sort order</label>
                                    <Input
                                        type="number" min="0" max="100"
                                        value={bundleForm.sort_order}
                                        onChange={e => setBundleForm(prev => ({ ...prev, sort_order: e.target.value }))}
                                        className="mt-1 h-9"
                                    />
                                </div>

                                <label className="flex items-center gap-2.5 text-sm cursor-pointer pt-1">
                                    <Checkbox
                                        checked={bundleForm.is_active}
                                        onCheckedChange={(checked) => setBundleForm(prev => ({ ...prev, is_active: checked === true }))}
                                    />
                                    <span className="font-medium">Active — visible to customers</span>
                                </label>

                                <SaveButton
                                    saving={savingBundle}
                                    onClick={submitBundle}
                                    label={bundleForm.id ? 'Save Changes' : 'Create Bundle'}
                                />
                            </CardContent>
                        </Card>
                    </div>
                </TabsContent>

                {/* ══ TAB 6 — Settings ═══════════════════════════════════════ */}
                <TabsContent value="settings" className="space-y-4 mt-4">
                    <div className="grid lg:grid-cols-2 gap-4">
                        {/* Pool senders */}
                        <Card className="rounded-2xl">
                            <CardContent className="p-5 space-y-3">
                                <h2 className="text-sm font-bold flex items-center gap-1.5">
                                    <Radio className="w-4 h-4 text-blue-500" /> Sender ID Pool
                                </h2>
                                <p className="text-[11px] text-muted-foreground">
                                    Shared sender IDs any approved business can send under (before they get their own). Users pick one from their dashboard.
                                </p>
                                <div className="flex flex-wrap gap-1.5">
                                    {poolSenders.length === 0 && (
                                        <p className="text-[11px] text-amber-600 dark:text-amber-400 flex items-center gap-1">
                                            <AlertTriangle className="w-3 h-3" /> Empty pool — business users without an approved sender cannot send.
                                        </p>
                                    )}
                                    {poolSenders.map(p => (
                                        <span key={p} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-muted text-xs font-mono font-semibold">
                                            {p}
                                            <button
                                                onClick={() => setPoolSenders(prev => prev.filter(x => x !== p))}
                                                className="text-muted-foreground hover:text-red-500 transition-colors"
                                                title={`Remove ${p}`}
                                            >
                                                <X className="w-3 h-3" />
                                            </button>
                                        </span>
                                    ))}
                                </div>
                                <div className="flex gap-2">
                                    <Input
                                        placeholder="e.g. KFG ALERT"
                                        value={poolInput}
                                        maxLength={11}
                                        onChange={e => setPoolInput(e.target.value)}
                                        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addPoolSender() } }}
                                        className="h-9 font-mono"
                                    />
                                    <Button size="sm" variant="outline" onClick={addPoolSender} className="h-9 gap-1 flex-shrink-0">
                                        <Plus className="w-3.5 h-3.5" /> Add
                                    </Button>
                                </div>
                                <SaveButton
                                    saving={savingSection === 'pool'}
                                    onClick={() => saveSection('pool', { poolSenders }, 'Sender pool saved')}
                                    label="Save Pool"
                                />
                            </CardContent>
                        </Card>

                        {/* Allowed roles */}
                        <Card className="rounded-2xl">
                            <CardContent className="p-5 space-y-3">
                                <h2 className="text-sm font-bold flex items-center gap-1.5">
                                    <Users className="w-4 h-4 text-purple-500" /> Allowed Roles
                                </h2>
                                <p className="text-[11px] text-muted-foreground">
                                    Only these account types can open an SMS account and send campaigns.
                                </p>
                                <div className="space-y-2">
                                    {ROLES.map(role => (
                                        <label key={role} className="flex items-center gap-2.5 text-sm cursor-pointer">
                                            <Checkbox
                                                checked={allowedRoles.includes(role)}
                                                onCheckedChange={(checked) => setAllowedRoles(prev =>
                                                    checked === true
                                                        ? [...prev.filter(r => r !== role), role]
                                                        : prev.filter(r => r !== role))}
                                            />
                                            <span className="capitalize font-medium">{role}</span>
                                        </label>
                                    ))}
                                </div>
                                {allowedRoles.length === 0 && (
                                    <p className="text-[11px] text-amber-600 dark:text-amber-400 flex items-center gap-1">
                                        <AlertTriangle className="w-3 h-3" /> Nobody will be able to use KFT SMS.
                                    </p>
                                )}
                                <SaveButton
                                    saving={savingSection === 'roles'}
                                    onClick={() => saveSection('roles', { allowedRoles }, 'Allowed roles saved')}
                                    label="Save Roles"
                                />
                            </CardContent>
                        </Card>
                    </div>

                    {/* Sending caps */}
                    <Card className="rounded-2xl">
                        <CardContent className="p-5 space-y-4">
                            <h2 className="text-sm font-bold flex items-center gap-1.5">
                                <ShieldCheck className="w-4 h-4 text-emerald-600" /> Sending Caps
                            </h2>
                            <div className="grid md:grid-cols-2 gap-4">
                                {([
                                    { title: 'Platform mode', form: platformCaps, set: setPlatformCaps },
                                    { title: 'Business mode', form: businessCaps, set: setBusinessCaps },
                                ] as const).map(({ title, form, set }) => (
                                    <div key={title} className="rounded-xl border p-4 space-y-3">
                                        <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">{title}</p>
                                        {([
                                            { key: 'max_recipients_per_send', label: 'Max recipients per send' },
                                            { key: 'sends_per_hour', label: 'Sends per hour' },
                                            { key: 'recipients_per_day', label: 'Recipients per day' },
                                        ] as const).map(({ key, label }) => (
                                            <div key={key}>
                                                <label className="text-xs font-semibold text-muted-foreground">{label}</label>
                                                <Input
                                                    type="number" min="1"
                                                    value={form[key]}
                                                    onChange={e => set(prev => ({ ...prev, [key]: e.target.value }))}
                                                    className="mt-1 h-9"
                                                />
                                            </div>
                                        ))}
                                    </div>
                                ))}
                            </div>
                            <SaveButton
                                saving={savingSection === 'caps'}
                                onClick={saveCaps}
                                label="Save Caps"
                            />
                        </CardContent>
                    </Card>

                    <div className="grid lg:grid-cols-2 gap-4">
                        {/* Blocked keywords */}
                        <Card className="rounded-2xl">
                            <CardContent className="p-5 space-y-3">
                                <h2 className="text-sm font-bold flex items-center gap-1.5">
                                    <Ban className="w-4 h-4 text-red-500" /> Blocked Keywords
                                </h2>
                                <p className="text-[11px] text-muted-foreground">
                                    Comma-separated. Any message that contains one of these is blocked and flagged. Shared with the shop SMS keyword list.
                                </p>
                                <Textarea
                                    value={blockedKeywords}
                                    onChange={e => setBlockedKeywords(e.target.value)}
                                    placeholder="e.g. you have won, send your pin, momo reversal"
                                    rows={4}
                                />
                                <SaveButton
                                    saving={savingSection === 'keywords'}
                                    onClick={() => saveSection('keywords', { blockedKeywords }, 'Blocked keywords saved')}
                                    label="Save Keywords"
                                />
                            </CardContent>
                        </Card>

                        {/* Moderation thresholds */}
                        <Card className="rounded-2xl">
                            <CardContent className="p-5 space-y-3">
                                <h2 className="text-sm font-bold flex items-center gap-1.5">
                                    <ShieldAlert className="w-4 h-4 text-amber-500" /> Moderation Thresholds
                                </h2>
                                <div>
                                    <label className="text-xs font-semibold text-muted-foreground">Auto-suspend after N fraud flags</label>
                                    <p className="text-[10px] text-muted-foreground/70">An account is suspended automatically once it accumulates this many fraud flags. 1–100.</p>
                                    <Input
                                        type="number" min="1" max="100"
                                        value={autosuspendThreshold}
                                        onChange={e => setAutosuspendThreshold(e.target.value)}
                                        className="mt-1 h-9"
                                    />
                                </div>
                                <div>
                                    <label className="text-xs font-semibold text-muted-foreground">Flag-review threshold</label>
                                    <p className="text-[10px] text-muted-foreground/70">Flags before an account&apos;s campaigns are held for manual review. 1–500.</p>
                                    <Input
                                        type="number" min="1" max="500"
                                        value={flagReviewThreshold}
                                        onChange={e => setFlagReviewThreshold(e.target.value)}
                                        className="mt-1 h-9"
                                    />
                                </div>
                                <SaveButton
                                    saving={savingSection === 'thresholds'}
                                    onClick={saveThresholds}
                                    label="Save Thresholds"
                                />
                            </CardContent>
                        </Card>

                        {/* SMS developer-API rate limit */}
                        <Card className="rounded-2xl">
                            <CardContent className="p-5 space-y-3">
                                <h2 className="text-sm font-bold flex items-center gap-1.5">
                                    <Timer className="w-4 h-4 text-sky-500" /> SMS API Rate Limit
                                </h2>
                                <div>
                                    <label className="text-xs font-semibold text-muted-foreground">Requests per minute (default)</label>
                                    <p className="text-[10px] text-muted-foreground/70">Applies to POST /sms/send throughput only (the sms rate-limit bucket) — other SMS read endpoints (senders, balance, messages, campaigns) share a separate, fixed platform limit. Unless a per-account override is set below in Accounts. 1–10,000.</p>
                                    <Input
                                        type="number" min="1" max="10000"
                                        value={smsRateLimitPerMin}
                                        onChange={e => setSmsRateLimitPerMin(e.target.value)}
                                        className="mt-1 h-9"
                                    />
                                </div>
                                <SaveButton
                                    saving={savingSection === 'rateLimit'}
                                    onClick={saveSmsRateLimit}
                                    label="Save Rate Limit"
                                />
                            </CardContent>
                        </Card>
                    </div>

                    {/* Business mode fraud lists — separate two-tier model from the platform blocklist above */}
                    <Card className="rounded-2xl">
                        <CardContent className="p-5 space-y-4">
                            <div>
                                <h2 className="text-sm font-bold flex items-center gap-1.5">
                                    <ShieldAlert className="w-4 h-4 text-purple-500" /> Business mode (KFT SMS)
                                </h2>
                                <p className="text-[11px] text-muted-foreground mt-1">
                                    Platform mode above is a strict list — any match blocks the message. Business mode is looser: the blocked list still
                                    blocks, but the flagged list only marks a message for manual review (it still gets delivered), and allowed domains are
                                    exempted from the link-hazard flag — this applies in business mode only.
                                </p>
                            </div>

                            <div>
                                <label className="text-xs font-semibold text-muted-foreground">Business blocked keywords</label>
                                <p className="text-[10px] text-muted-foreground/70 mb-1.5">Comma-separated. Matches block the message and flag the campaign, same as the platform list.</p>
                                <Textarea
                                    value={businessBlockedKeywords}
                                    onChange={e => setBusinessBlockedKeywords(e.target.value)}
                                    placeholder="e.g. you have won, send your pin, momo reversal"
                                    rows={3}
                                />
                            </div>

                            <div>
                                <label className="text-xs font-semibold text-muted-foreground">Business flagged keywords</label>
                                <p className="text-[10px] text-muted-foreground/70 mb-1.5">Comma-separated. Matches only flag the campaign for review — the message still sends.</p>
                                <Textarea
                                    value={businessFlaggedKeywords}
                                    onChange={e => setBusinessFlaggedKeywords(e.target.value)}
                                    placeholder="e.g. investment, guaranteed returns, act now"
                                    rows={3}
                                />
                            </div>

                            <div>
                                <label className="text-xs font-semibold text-muted-foreground">Business allowed domains</label>
                                <p className="text-[10px] text-muted-foreground/70 mb-1.5">
                                    Comma-separated. Business mode already allows links to normal domains without flagging — this list has no effect
                                    on those. Generic URL shorteners (bit.ly, tinyurl.com, etc.) are always flagged for review in business mode and
                                    cannot be allowlisted here.
                                </p>
                                <Textarea
                                    value={businessAllowedDomains}
                                    onChange={e => setBusinessAllowedDomains(e.target.value)}
                                    placeholder="e.g. kingflexygh.com, ourbrand.com"
                                    rows={3}
                                />
                            </div>

                            <SaveButton
                                saving={savingSection === 'business-fraud-lists'}
                                onClick={() => saveSection('business-fraud-lists', {
                                    businessBlockedKeywords,
                                    businessFlaggedKeywords,
                                    businessAllowedDomains,
                                }, 'Business fraud lists saved')}
                                label="Save Business Lists"
                            />
                        </CardContent>
                    </Card>
                </TabsContent>
            </Tabs>

            {/* ── Confirmation dialog (all destructive/confirm actions) ────── */}
            <Dialog open={dialog !== null} onOpenChange={(open) => { if (!open && !dialogBusy) setDialog(null) }}>
                <DialogContent className="max-w-md">
                    {dialog?.kind === 'toggle_feature' && (
                        <>
                            <DialogHeader>
                                <DialogTitle>{dialog.next ? 'Enable KFT SMS platform?' : 'Disable KFT SMS platform?'}</DialogTitle>
                                <DialogDescription>
                                    {dialog.next
                                        ? 'Users in allowed roles will immediately be able to buy credits and send campaigns.'
                                        : 'ALL user SMS sending stops immediately — queued campaigns will not dispatch until re-enabled.'}
                                </DialogDescription>
                            </DialogHeader>
                        </>
                    )}

                    {dialog?.kind === 'review_business' && (
                        <>
                            <DialogHeader>
                                <DialogTitle>
                                    {dialog.decision === 'approved' ? 'Approve' : dialog.decision === 'revoked' ? 'Revoke' : 'Reject'} “{dialog.profile.business_name}”?
                                </DialogTitle>
                                <DialogDescription>
                                    {dialog.decision === 'approved'
                                        ? 'The user flips to BUSINESS mode: relaxed content filtering, link freedom and sender ID options unlock immediately.'
                                        : 'The user reverts to PLATFORM mode and all their queued campaigns are cancelled and refunded. They can resubmit at any time.'}
                                </DialogDescription>
                            </DialogHeader>
                            {dialog.decision === 'approved' && (
                                <label className="flex items-start gap-2.5 rounded-xl border p-3 cursor-pointer">
                                    <Checkbox
                                        checked={dWhatsappVerified}
                                        onCheckedChange={v => setDWhatsappVerified(v === true)}
                                        className="mt-0.5"
                                    />
                                    <span className="text-xs">
                                        <span className="font-semibold">I verified this business&apos;s Ghana Card and registration documents over WhatsApp.</span>
                                        <span className="block text-muted-foreground mt-0.5">Required before approving.</span>
                                    </span>
                                </label>
                            )}
                            <div>
                                <label className="text-xs font-semibold text-muted-foreground">
                                    {dialog.decision === 'approved' ? 'Verification note' : 'Review notes'} {(dialog.decision === 'rejected' || dialog.decision === 'revoked') ? <span className="text-red-500">(required — shared with the user)</span> : '(optional)'}
                                </label>
                                <Textarea
                                    value={dNotes}
                                    onChange={e => setDNotes(e.target.value)}
                                    placeholder={
                                        dialog.decision === 'rejected' ? 'e.g. Ghana Card does not match the business name'
                                        : dialog.decision === 'revoked' ? 'e.g. Business certificate turned out to be forged'
                                        : 'e.g. Ghana Card + cert photo both clear, name matches'
                                    }
                                    rows={3}
                                    className="mt-1.5"
                                />
                            </div>
                        </>
                    )}

                    {dialog?.kind === 'sender' && (
                        <>
                            <DialogHeader>
                                <DialogTitle>
                                    {dialog.op === 'submit_to_hubtel' && `Submit "${dialog.sender.sender_text}" to Hubtel?`}
                                    {dialog.op === 'approve' && `Approve sender "${dialog.sender.sender_text}"?`}
                                    {dialog.op === 'reject' && `Reject sender "${dialog.sender.sender_text}"?`}
                                    {dialog.op === 'revoke' && `Revoke sender "${dialog.sender.sender_text}"?`}
                                </DialogTitle>
                                <DialogDescription>
                                    {dialog.op === 'submit_to_hubtel' && 'Mark this request as raised with Hubtel. Do this after registering the sender ID on the Hubtel portal.'}
                                    {dialog.op === 'approve' && `Approving activates Business mode for this account and makes "${dialog.sender.sender_text}" their active sender ID.`}
                                    {dialog.op === 'reject' && 'The user keeps sending with the pool/platform sender. Your reason is shared with the user.'}
                                    {dialog.op === 'revoke' && 'The user immediately loses this sender and falls back to a pool sender — if the pool is empty, their business sends will be refused. Your reason is shared with the user.'}
                                </DialogDescription>
                            </DialogHeader>
                            {dialog.op === 'approve' && (
                                <div>
                                    <label className="text-xs font-semibold text-muted-foreground">Hubtel reference (optional)</label>
                                    <Input
                                        value={dHubtelRef}
                                        onChange={e => setDHubtelRef(e.target.value)}
                                        placeholder="e.g. HTL-SND-12345"
                                        maxLength={120}
                                        className="mt-1.5 h-9 font-mono"
                                    />
                                </div>
                            )}
                            {(dialog.op === 'reject' || dialog.op === 'revoke') && (
                                <div>
                                    <label className="text-xs font-semibold text-muted-foreground">
                                        Reason <span className="text-red-500">(required — shared with the user)</span>
                                    </label>
                                    <Textarea
                                        value={dNotes}
                                        onChange={e => setDNotes(e.target.value)}
                                        placeholder={dialog.op === 'revoke' ? 'e.g. Sender used for content that violates our terms' : 'e.g. Sender name impersonates a bank'}
                                        rows={3}
                                        className="mt-1.5"
                                    />
                                </div>
                            )}
                        </>
                    )}

                    {dialog?.kind === 'account' && (
                        <>
                            <DialogHeader>
                                <DialogTitle>
                                    {dialog.suspend ? 'Suspend this SMS account?' : 'Re-activate this SMS account?'}
                                </DialogTitle>
                                <DialogDescription>
                                    {dialog.suspend
                                        ? `User ${shortId(dialog.account.user_id)} will be blocked from sending and all their queued campaigns are cancelled and refunded.`
                                        : `User ${shortId(dialog.account.user_id)} will be able to send SMS again immediately.`}
                                </DialogDescription>
                            </DialogHeader>
                            {dialog.suspend && (
                                <div>
                                    <label className="text-xs font-semibold text-muted-foreground">Reason (optional — shared with the user)</label>
                                    <Textarea
                                        value={dNotes}
                                        onChange={e => setDNotes(e.target.value)}
                                        placeholder="e.g. Repeated fraud-flagged campaigns"
                                        rows={3}
                                        className="mt-1.5"
                                    />
                                </div>
                            )}
                        </>
                    )}

                    {dialog?.kind === 'business_hold' && (
                        <>
                            <DialogHeader>
                                <DialogTitle>
                                    {dialog.hold ? `Hold "${dialog.businessName}"'s business mode?` : `Release "${dialog.businessName}"'s business mode?`}
                                </DialogTitle>
                                <DialogDescription>
                                    {dialog.hold
                                        ? 'The account is enforced as PLATFORM mode immediately — strict content filtering, platform sender only. Their own sender ID and business filtering are unavailable until released. Queued campaigns under their own sender are cancelled and refunded.'
                                        : 'Business mode is restored immediately — their own sender ID and telco-only filtering are usable again.'}
                                </DialogDescription>
                            </DialogHeader>
                            {dialog.hold && (
                                <div>
                                    <label className="text-xs font-semibold text-muted-foreground">Reason (optional — shared with the user)</label>
                                    <Textarea
                                        value={dNotes}
                                        onChange={e => setDNotes(e.target.value)}
                                        placeholder="e.g. Business certificate never provided after grace period"
                                        rows={3}
                                        className="mt-1.5"
                                    />
                                </div>
                            )}
                        </>
                    )}

                    <DialogFooter className="gap-2">
                        <Button variant="outline" disabled={dialogBusy} onClick={() => setDialog(null)}>
                            Cancel
                        </Button>
                        <Button
                            disabled={dialogBusy || (dialog?.kind === 'review_business' && dialog.decision === 'approved' && !dWhatsappVerified)}
                            onClick={confirmDialog}
                            className={cn(
                                'gap-1.5 font-semibold text-white',
                                dialog && isDestructive(dialog)
                                    ? 'bg-red-600 hover:bg-red-700'
                                    : 'bg-emerald-600 hover:bg-emerald-700'
                            )}
                        >
                            {dialogBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                            Confirm
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* ── Delete-bundle confirmation (standalone — separate from the
                 dialog state machine above, which is keyed to admin
                 review/toggle actions). ─────────────────────────────────── */}
            <Dialog open={confirmDeleteBundleId !== null} onOpenChange={(open) => { if (!open && !deletingBundleId) setConfirmDeleteBundleId(null) }}>
                <DialogContent className="max-w-md">
                    {(() => {
                        const target = data?.bundles.find(b => b.id === confirmDeleteBundleId)
                        if (!target) return null
                        return (
                            <>
                                <DialogHeader>
                                    <DialogTitle>Delete “{target.name}”?</DialogTitle>
                                    <DialogDescription>
                                        If this tier has ever been purchased, it will be <strong>deactivated instead</strong> (hidden
                                        from customers, purchase history and revenue totals kept) rather than removed.
                                    </DialogDescription>
                                </DialogHeader>
                                <DialogFooter className="gap-2">
                                    <Button variant="outline" disabled={!!deletingBundleId} onClick={() => setConfirmDeleteBundleId(null)}>
                                        Cancel
                                    </Button>
                                    <Button
                                        disabled={!!deletingBundleId}
                                        onClick={() => deleteBundle(target)}
                                        className="gap-1.5 font-semibold text-white bg-red-600 hover:bg-red-700"
                                    >
                                        {deletingBundleId === target.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                                        Confirm delete
                                    </Button>
                                </DialogFooter>
                            </>
                        )
                    })()}
                </DialogContent>
            </Dialog>
        </div>
    )
}

// ─── Presentational helpers ──────────────────────────────────────────────────

function isDestructive(d: NonNullable<DialogState>): boolean {
    switch (d.kind) {
        case 'toggle_feature': return !d.next
        case 'review_business': return d.decision === 'rejected' || d.decision === 'revoked'
        case 'sender': return d.op === 'reject' || d.op === 'revoke'
        case 'account': return d.suspend
        case 'business_hold': return d.hold
    }
}

function EmptyState({ icon: Icon, text }: { icon: typeof Inbox; text: string }) {
    return (
        <Card className="rounded-2xl">
            <CardContent className="py-12 flex flex-col items-center gap-2 text-center">
                <Icon className="w-8 h-8 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">{text}</p>
            </CardContent>
        </Card>
    )
}

function SaveButton({ saving, onClick, label }: { saving: boolean; onClick: () => void; label: string }) {
    return (
        <Button
            onClick={onClick}
            disabled={saving}
            className="w-full gap-2 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold"
        >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {label}
        </Button>
    )
}

function SmsRateLimitEditor({
    userId, current, onSaved, post,
}: {
    userId: string
    current: number | null
    onSaved: () => void
    post: (payload: Record<string, unknown>) => Promise<any>
}) {
    const [editing, setEditing] = useState(false)
    const [value, setValue] = useState(current !== null ? String(current) : '')
    const [saving, setSaving] = useState(false)

    const save = async () => {
        const trimmed = value.trim()
        const n = trimmed === '' ? null : parseInt(trimmed, 10)
        if (n !== null && (!Number.isFinite(n) || n < 1 || n > 10000)) {
            toast.error('Override must be between 1 and 10,000 (or blank to clear)')
            return
        }
        setSaving(true)
        try {
            await post({ action: 'set_account_sms_rate_limit', userId, limitPerMin: n })
            toast.success(n === null ? 'Override cleared — using default' : 'Override saved')
            setEditing(false)
            onSaved()
        } catch (err: any) {
            toast.error(err.message || 'Failed to save')
        } finally {
            setSaving(false)
        }
    }

    if (!editing) {
        return (
            <button
                onClick={() => { setValue(current !== null ? String(current) : ''); setEditing(true) }}
                className="text-[10px] text-muted-foreground hover:text-foreground underline underline-offset-2 w-fit"
            >
                {current !== null ? `Custom: ${current}/min` : 'Default (edit)'}
            </button>
        )
    }
    return (
        <div className="flex items-center gap-1">
            <Input
                type="number" min="1" max="10000" placeholder="default"
                value={value}
                onChange={e => setValue(e.target.value)}
                className="h-6 w-16 text-[10px] px-1.5"
            />
            <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[10px]" onClick={save} disabled={saving}>
                {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Save'}
            </Button>
            <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[10px]" onClick={() => setEditing(false)} disabled={saving}>
                Cancel
            </Button>
        </div>
    )
}

function CollapsedProfiles({
    title, open, onToggle, profiles, badge, onOpenHoldDialog, onOpenRevokeDialog,
}: {
    title: string
    open: boolean
    onToggle: () => void
    profiles: BusinessProfile[]
    badge: React.ReactNode
    /** Present only for the approved list; renders a Hold/Release button per row. */
    onOpenHoldDialog?: (accountId: string, businessName: string, hold: boolean) => void
    /** Present only for the approved list; opens the revoke confirmation dialog. */
    onOpenRevokeDialog?: (profile: BusinessProfile) => void
}) {
    if (profiles.length === 0) return null
    return (
        <Card className="rounded-2xl overflow-hidden">
            <CardContent className="p-0">
                <button
                    onClick={onToggle}
                    className="w-full px-4 py-3 flex items-center justify-between text-sm font-bold hover:bg-muted/50 transition-colors"
                >
                    <span className="flex items-center gap-2">
                        {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        {title}
                    </span>
                </button>
                {open && (
                    <div className="divide-y border-t">
                        {profiles.map(p => {
                            const acc = rel(p.sms_accounts)
                            const held = acc?.business_on_hold ?? false
                            return (
                                <div key={p.id} className="px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-sm">
                                    <div className="min-w-0">
                                        <p className="font-semibold truncate flex items-center gap-2">
                                            {p.business_name} {badge}
                                            {held && <Badge variant="failed" className="text-[10px]">On Hold</Badge>}
                                        </p>
                                        <p className="text-[11px] text-muted-foreground">
                                            User {acc ? shortId(acc.user_id) : '—'} · {fmtDate(p.created_at)}
                                            {p.review_notes && <> · <span className="italic">“{p.review_notes}”</span></>}
                                            {p.whatsapp_verification_note && <> · <span className="italic">WhatsApp: “{p.whatsapp_verification_note}”</span></>}
                                        </p>
                                    </div>
                                    <div className="flex items-center gap-2 flex-shrink-0">
                                        {onOpenHoldDialog && acc && (
                                            <Button
                                                size="sm" variant="outline"
                                                onClick={() => onOpenHoldDialog(acc.id, p.business_name, !held)}
                                                className={cn('h-7 text-[11px] gap-1',
                                                    held
                                                        ? 'text-emerald-600 border-emerald-200 dark:border-emerald-800'
                                                        : 'text-red-600 border-red-200 dark:border-red-900')}
                                            >
                                                {held ? <><ShieldCheck className="w-3 h-3" /> Release</> : <><Ban className="w-3 h-3" /> Hold</>}
                                            </Button>
                                        )}
                                        {onOpenRevokeDialog && (
                                            <Button
                                                size="sm" variant="outline"
                                                onClick={() => onOpenRevokeDialog(p)}
                                                className="h-7 text-[11px] gap-1 text-red-600 border-red-200 dark:border-red-900"
                                            >
                                                <Ban className="w-3 h-3" /> Revoke
                                            </Button>
                                        )}
                                    </div>
                                </div>
                            )
                        })}
                    </div>
                )}
            </CardContent>
        </Card>
    )
}
