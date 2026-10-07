'use client'

import { useEffect, useState } from 'react'
import { formatCurrency, cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
    MessageSquare, Loader2, Save, Coins, Zap, Flag, Plus,
    RefreshCcw, CheckCircle2, XCircle, Wallet, Ban, ShieldCheck, Check, Link2, Sparkles, Tag, Clock, AlertTriangle,
    Pencil, Trash2, Star,
} from 'lucide-react'
import { toast } from '@/lib/toast'
import { SUGGESTED_SCAM_KEYWORDS } from '@/lib/sms-content-filter'

interface Bundle {
    id: string
    name: string
    credits: number
    price: number
    is_active: boolean
    sort_order: number
}

interface FlaggedLog {
    id: string
    shop_id: string
    message: string
    recipients_count: number
    status: string
    flag_reason: string | null
    created_at: string
    delivered_count: number
    undelivered_count: number
    pending_count: number
    shop_profiles?: { shop_name: string } | null
}

interface ShopWalletRow {
    shop_id: string
    credits: number
    total_purchased: number
    total_used: number
    shop_profiles?: { shop_name: string } | null
}

interface SenderRequestRow {
    id: string
    shop_id: string
    sender_text: string
    status: 'under_review' | 'approved'
    is_default: boolean
    requested_at?: string | null
    reviewed_at?: string | null
    reason?: string | null
    shop_profiles?: { shop_name: string; owner_id: string } | null
}

interface AdminData {
    settings: Record<string, string>
    bundles: Bundle[]
    revenue: {
        activationCount: number
        activationTotal: number
        purchaseCount: number
        purchaseTotal: number
        creditsSold: number
    }
    flagged: FlaggedLog[]
    shopWallets: ShopWalletRow[]
    suspendedShopIds: string[]
    pendingSenderRequests: SenderRequestRow[]
    approvedSenders: SenderRequestRow[]
    warnings?: string[]
}

export default function ShopSmsAdminClient() {
    const [data, setData] = useState<AdminData | null>(null)
    const [loading, setLoading] = useState(true)
    // Real server error text for the "Failed to load" screen (not just a
    // toast that can be missed) — so an owner report of "internal errors"
    // always maps to a concrete, on-screen message plus a way to retry.
    const [loadError, setLoadError] = useState<string | null>(null)
    const [savingSettings, setSavingSettings] = useState(false)
    const [savingBundle, setSavingBundle] = useState<string | null>(null)
    const [deletingBundleId, setDeletingBundleId] = useState<string | null>(null)
    const [confirmDeleteBundleId, setConfirmDeleteBundleId] = useState<string | null>(null)

    // Settings form
    const [enabled, setEnabled] = useState(true)
    const [activationFee, setActivationFee] = useState('50')
    const [maxRecipients, setMaxRecipients] = useState('100')
    const [sendsPerHour, setSendsPerHour] = useState('10')
    const [recipientsPerDay, setRecipientsPerDay] = useState('500')
    const [blockedKeywords, setBlockedKeywords] = useState('')
    const [allowedDomains, setAllowedDomains] = useState('')

    // Moderation action in-flight (logId or shopId)
    const [actioningId, setActioningId] = useState<string | null>(null)

    // Optional reject/revoke reason, keyed by shop id
    const [senderReasonById, setSenderReasonById] = useState<Record<string, string>>({})

    // Bundle add/edit form (id === null → create)
    const emptyBundleForm = (nextSortOrder = 0) => ({
        id: null as string | null,
        name: '',
        credits: '',
        price: '',
        sort_order: String(nextSortOrder),
        is_active: true,
    })
    const [bundleForm, setBundleForm] = useState(emptyBundleForm())

    useEffect(() => { fetchData() }, [])

    const fetchData = async () => {
        setLoadError(null)
        try {
            const res = await fetch('/api/admin/shop-sms')
            const json = await res.json()
            if (!json.success) throw new Error(json.error || 'Failed to load shop SMS admin data')
            setData(json.data)
            const s = json.data.settings
            setEnabled(s['sms_feature_enabled'] !== 'false')
            setActivationFee(s['sms_activation_fee'] || '50')
            setMaxRecipients(s['sms_max_recipients_per_send'] || '100')
            setSendsPerHour(s['sms_sends_per_hour'] || '10')
            setRecipientsPerDay(s['sms_recipients_per_day'] || '500')
            setBlockedKeywords(s['sms_blocked_keywords'] || '')
            setAllowedDomains(s['sms_allowed_link_domains'] || '')
        } catch (err: any) {
            const msg = err.message || 'Failed to load shop SMS admin data'
            setLoadError(msg)
            toast.error(msg)
        } finally {
            setLoading(false)
        }
    }

    const saveSettings = async () => {
        setSavingSettings(true)
        try {
            const res = await fetch('/api/admin/shop-sms', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sms_feature_enabled: enabled ? 'true' : 'false',
                    sms_activation_fee: activationFee,
                    sms_max_recipients_per_send: maxRecipients,
                    sms_sends_per_hour: sendsPerHour,
                    sms_recipients_per_day: recipientsPerDay,
                    sms_blocked_keywords: blockedKeywords,
                    sms_allowed_link_domains: allowedDomains,
                }),
            })
            const json = await res.json()
            if (!json.success) throw new Error(json.error)
            toast.success('Settings saved')
        } catch (err: any) {
            toast.error(err.message || 'Failed to save settings')
        } finally {
            setSavingSettings(false)
        }
    }

    const saveBundle = async (bundle: Partial<Bundle> & { name: string; credits: number; price: number }) => {
        setSavingBundle(bundle.id || 'new')
        try {
            const res = await fetch('/api/admin/shop-sms', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(bundle),
            })
            const json = await res.json()
            if (!json.success) throw new Error(json.error)
            toast.success(bundle.id ? 'Bundle updated' : 'Bundle created')
            setBundleForm(emptyBundleForm((data?.bundles.length || 0) + (bundle.id ? 0 : 1)))
            await fetchData()
        } catch (err: any) {
            toast.error(err.message || 'Failed to save bundle')
        } finally {
            setSavingBundle(null)
        }
    }

    const startEditBundle = (b: Bundle) => {
        setBundleForm({
            id: b.id,
            name: b.name,
            credits: String(b.credits),
            price: String(b.price),
            sort_order: String(b.sort_order),
            is_active: b.is_active,
        })
    }

    const cancelBundleForm = () => {
        setBundleForm(emptyBundleForm(data?.bundles.length || 0))
        setConfirmDeleteBundleId(null)
    }

    const submitBundleForm = () => {
        const name = bundleForm.name.trim()
        if (name.length < 2) { toast.error('Bundle name must be at least 2 characters'); return }
        const credits = parseInt(bundleForm.credits, 10)
        if (!credits || credits <= 0) { toast.error('Enter a valid credit amount'); return }
        const price = parseFloat(bundleForm.price)
        if (!price || price <= 0) { toast.error('Enter a valid price'); return }
        const sortOrder = parseInt(bundleForm.sort_order, 10)
        saveBundle({
            ...(bundleForm.id ? { id: bundleForm.id } : {}),
            name,
            credits,
            price,
            is_active: bundleForm.is_active,
            sort_order: Number.isFinite(sortOrder) ? sortOrder : 0,
        })
    }

    const deleteBundle = async (id: string) => {
        setDeletingBundleId(id)
        try {
            const res = await fetch('/api/admin/shop-sms', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id }),
            })
            const json = await res.json()
            if (!json.success) throw new Error(json.error)
            toast.success(json.data?.deactivated ? (json.message || 'Bundle deactivated — it has purchase history') : 'Bundle deleted')
            setConfirmDeleteBundleId(null)
            if (bundleForm.id === id) cancelBundleForm()
            await fetchData()
        } catch (err: any) {
            toast.error(err.message || 'Failed to delete bundle')
        } finally {
            setDeletingBundleId(null)
        }
    }

    // Append a suggested scam keyword to the CONTAINS blocklist (dedup).
    const addSuggestedKeyword = (kw: string) => {
        const existing = blockedKeywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean)
        if (existing.includes(kw.toLowerCase())) {
            toast.info('Already in the list')
            return
        }
        setBlockedKeywords(prev => {
            const trimmed = prev.trim()
            return trimmed ? `${trimmed.replace(/,\s*$/, '')}, ${kw}` : kw
        })
        toast.success(`Added "${kw}" — remember to Save Settings`)
    }

    // Moderation: dismiss a flag, or toggle a shop's SMS suspension.
    const runAction = async (id: string, payload: Record<string, unknown>, okMsg: string) => {
        setActioningId(id)
        try {
            const res = await fetch('/api/admin/shop-sms', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            })
            const json = await res.json()
            if (!json.success) throw new Error(json.error)
            toast.success(okMsg)
            await fetchData()
        } catch (err: any) {
            toast.error(err.message || 'Action failed')
        } finally {
            setActioningId(null)
        }
    }

    const dismissFlag = (logId: string) =>
        runAction(logId, { action: 'dismiss_flag', logId }, 'Flag dismissed')

    const toggleSuspend = (shopId: string, suspended: boolean) =>
        runAction(shopId, { action: 'set_shop_sms_suspended', shopId, suspended },
            suspended ? "Shop's SMS disabled" : "Shop's SMS re-enabled")

    const reviewSender = (senderId: string, decision: 'approved' | 'rejected' | 'revoked') => {
        const reason = senderReasonById[senderId]?.trim() || undefined
        runAction(senderId, { action: 'review_shop_sender', senderId, decision, reason },
            decision === 'approved' ? 'Sender ID approved' : decision === 'rejected' ? 'Sender ID rejected' : 'Sender ID revoked')
    }

    const suspendedSet = new Set(data?.suspendedShopIds || [])

    if (loading) {
        return (
            <div className="flex items-center justify-center py-20">
                <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
        )
    }

    if (!data) {
        return (
            <div className="flex flex-col items-center justify-center gap-3 py-20 px-4 text-center">
                <AlertTriangle className="w-8 h-8 text-rose-500" />
                <p className="text-sm font-semibold text-rose-600 dark:text-rose-400">Failed to load Shop SMS admin data</p>
                {loadError && <p className="text-xs text-muted-foreground max-w-md">{loadError}</p>}
                <Button variant="outline" size="sm" onClick={fetchData} className="gap-1.5">
                    <RefreshCcw className="w-3.5 h-3.5" /> Retry
                </Button>
            </div>
        )
    }

    return (
        <div className="space-y-6 p-4 md:p-6 max-w-6xl mx-auto">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-xl font-bold flex items-center gap-2">
                        <MessageSquare className="w-5 h-5 text-emerald-600" />
                        Shop SMS Management
                    </h1>
                    <p className="text-muted-foreground text-sm mt-0.5">
                        Activation fee, bundle tiers, sending limits and revenue from shop owner SMS.
                    </p>
                </div>
                <Button variant="outline" size="sm" onClick={fetchData} className="gap-1.5">
                    <RefreshCcw className="w-3.5 h-3.5" /> Refresh
                </Button>
            </div>

            {/* ── Degraded-section warnings — a sub-query failed but the rest
                 of the page still loaded; never let that be silent. ───── */}
            {!!data.warnings?.length && (
                <div className="flex items-start gap-2 px-4 py-2.5 rounded-xl border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400 text-xs">
                    <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                    <div>
                        <p className="font-semibold">Some sections failed to load — the rest of the page is still live</p>
                        <ul className="list-disc list-inside mt-0.5 space-y-0.5">
                            {data.warnings.map((w, i) => <li key={i}>{w}</li>)}
                        </ul>
                    </div>
                </div>
            )}

            {/* Revenue overview */}
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-2.5">
                {[
                    { label: 'Activations', value: String(data.revenue.activationCount), icon: Zap, color: 'text-emerald-600' },
                    { label: 'Activation Revenue', value: formatCurrency(data.revenue.activationTotal), icon: Wallet, color: 'text-emerald-600' },
                    { label: 'Bundles Sold', value: String(data.revenue.purchaseCount), icon: Coins, color: 'text-blue-600' },
                    { label: 'Bundle Revenue', value: formatCurrency(data.revenue.purchaseTotal), icon: Wallet, color: 'text-blue-600' },
                    { label: 'Credits Sold', value: String(data.revenue.creditsSold), icon: MessageSquare, color: 'text-purple-600' },
                ].map(({ label, value, icon: Icon, color }) => (
                    <Card key={label} className="border shadow-sm rounded-xl">
                        <CardContent className="p-3.5">
                            <div className="flex items-center gap-1.5 mb-1">
                                <Icon className={cn('w-3.5 h-3.5', color)} />
                                <p className="text-[11px] text-muted-foreground font-medium">{label}</p>
                            </div>
                            <p className="text-base font-bold tabular-nums truncate">{value}</p>
                        </CardContent>
                    </Card>
                ))}
            </div>

            <div className="grid lg:grid-cols-2 gap-5">
                {/* Settings */}
                <Card className="rounded-2xl">
                    <CardContent className="p-5 space-y-4">
                        <h2 className="text-sm font-bold">Feature Settings</h2>

                        <div className="flex items-center justify-between p-3 rounded-xl border">
                            <div>
                                <p className="text-sm font-semibold">SMS Feature</p>
                                <p className="text-xs text-muted-foreground">Master switch for all shop owners</p>
                            </div>
                            <button
                                onClick={() => setEnabled(e => !e)}
                                className={cn(
                                    'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors',
                                    enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'
                                )}
                            >
                                {enabled ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                                {enabled ? 'Enabled' : 'Disabled'}
                            </button>
                        </div>

                        {[
                            { label: 'Activation fee (GHS)', value: activationFee, set: setActivationFee },
                            { label: 'Max recipients per send', value: maxRecipients, set: setMaxRecipients },
                            { label: 'Sends per hour (per shop)', value: sendsPerHour, set: setSendsPerHour },
                            { label: 'Recipients per day (per shop)', value: recipientsPerDay, set: setRecipientsPerDay },
                        ].map(f => (
                            <div key={f.label}>
                                <label className="text-xs font-semibold text-muted-foreground">{f.label}</label>
                                <Input
                                    type="number" min="0"
                                    value={f.value}
                                    onChange={e => f.set(e.target.value)}
                                    className="mt-1 h-9"
                                />
                            </div>
                        ))}

                        <div>
                            <label className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
                                <Ban className="w-3.5 h-3.5 text-red-500" /> Block &amp; flag if message CONTAINS
                            </label>
                            <p className="text-[11px] text-muted-foreground/70 mt-0.5">
                                Comma-separated words/phrases. Any message whose text <strong>contains</strong> one of
                                these (partial, case-insensitive) is <strong>blocked and flagged</strong> for review.
                            </p>
                            <Textarea
                                value={blockedKeywords}
                                onChange={e => setBlockedKeywords(e.target.value)}
                                placeholder="e.g. you have won, send your pin, momo reversal"
                                rows={2}
                                className="mt-1.5"
                            />
                            {/* Suggested keywords — click to add */}
                            <div className="mt-2">
                                <p className="text-[10px] font-semibold text-muted-foreground/70 flex items-center gap-1 mb-1">
                                    <Sparkles className="w-3 h-3 text-amber-500" /> Suggested — tap to add
                                </p>
                                <div className="flex flex-wrap gap-1">
                                    {SUGGESTED_SCAM_KEYWORDS.map(kw => {
                                        const already = blockedKeywords.split(',').map(k => k.trim().toLowerCase()).includes(kw.toLowerCase())
                                        return (
                                            <button
                                                key={kw}
                                                type="button"
                                                onClick={() => addSuggestedKeyword(kw)}
                                                disabled={already}
                                                className={cn(
                                                    'text-[10px] px-2 py-0.5 rounded-full border transition-colors',
                                                    already
                                                        ? 'bg-emerald-50 text-emerald-600 border-emerald-200 cursor-default dark:bg-emerald-900/20'
                                                        : 'bg-muted hover:bg-red-50 hover:text-red-600 hover:border-red-200 border-transparent'
                                                )}
                                            >
                                                {already ? <Check className="w-2.5 h-2.5 inline mr-0.5" /> : <Plus className="w-2.5 h-2.5 inline mr-0.5" />}
                                                {kw}
                                            </button>
                                        )
                                    })}
                                </div>
                            </div>
                        </div>

                        <div>
                            <label className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
                                <Link2 className="w-3.5 h-3.5 text-blue-500" /> Extra allowed link domains
                            </label>
                            <p className="text-[11px] text-muted-foreground/70 mt-0.5">
                                Comma-separated. <strong>In addition to</strong> KiNG FLEXY + WhatsApp/Facebook/Instagram/X/Telegram
                                (always allowed). Add e.g. <code className="bg-muted px-1 rounded">tiktok.com, youtube.com</code>.
                                Every other external link is blocked.
                            </p>
                            <Textarea
                                value={allowedDomains}
                                onChange={e => setAllowedDomains(e.target.value)}
                                placeholder="e.g. tiktok.com, youtube.com"
                                rows={2}
                                className="mt-1.5"
                            />
                        </div>

                        <Button onClick={saveSettings} disabled={savingSettings} className="w-full gap-2 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold">
                            {savingSettings ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                            Save Settings
                        </Button>
                    </CardContent>
                </Card>

                {/* Bundle tiers */}
                <Card className="rounded-2xl">
                    <CardContent className="p-5 space-y-4">
                        <h2 className="text-sm font-bold">Bundle Tiers</h2>

                        <div className="space-y-2">
                            {data.bundles.map(b => (
                                <div key={b.id} className="p-3 rounded-xl border space-y-2">
                                    <div className="flex items-center justify-between gap-2">
                                        <div className="min-w-0">
                                            <p className="text-sm font-semibold truncate">{b.name}</p>
                                            <p className="text-xs text-muted-foreground">{b.credits} credits · {formatCurrency(b.price)} · sort {b.sort_order}</p>
                                        </div>
                                        <div className="flex flex-wrap gap-1.5 shrink-0">
                                            <Button
                                                size="sm" variant="outline"
                                                disabled={savingBundle === b.id}
                                                onClick={() => startEditBundle(b)}
                                                className="h-8 text-xs gap-1"
                                            >
                                                <Pencil className="w-3 h-3" /> Edit
                                            </Button>
                                            <Button
                                                size="sm" variant="outline"
                                                disabled={savingBundle === b.id}
                                                onClick={() => saveBundle({ ...b, is_active: !b.is_active })}
                                                className={cn('h-8 text-xs gap-1', b.is_active ? 'text-emerald-600' : 'text-red-500')}
                                            >
                                                {savingBundle === b.id ? <Loader2 className="w-3 h-3 animate-spin" /> : b.is_active ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
                                                {b.is_active ? 'Active' : 'Inactive'}
                                            </Button>
                                            <Button
                                                size="sm" variant="outline"
                                                disabled={deletingBundleId === b.id}
                                                onClick={() => setConfirmDeleteBundleId(id => id === b.id ? null : b.id)}
                                                className="h-8 text-xs gap-1 text-red-600 border-red-200 dark:border-red-900"
                                            >
                                                {deletingBundleId === b.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                                                Delete
                                            </Button>
                                        </div>
                                    </div>

                                    {confirmDeleteBundleId === b.id && (
                                        <div className="rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/20 p-3 space-y-2">
                                            <p className="text-xs text-red-700 dark:text-red-400">
                                                Delete <strong>{b.name}</strong>? If this tier has ever been purchased, it will be
                                                <strong> deactivated instead</strong> (hidden from shops, purchase history kept) rather than removed.
                                            </p>
                                            <div className="flex items-center justify-end gap-2">
                                                <Button size="sm" variant="ghost" onClick={() => setConfirmDeleteBundleId(null)} disabled={deletingBundleId === b.id}>Cancel</Button>
                                                <Button size="sm" variant="destructive" onClick={() => deleteBundle(b.id)} disabled={deletingBundleId === b.id}>
                                                    {deletingBundleId === b.id ? 'Deleting…' : 'Confirm delete'}
                                                </Button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>

                        <div className="border-t pt-4 space-y-2">
                            <div className="flex items-center justify-between">
                                <p className="text-xs font-semibold text-muted-foreground">{bundleForm.id ? 'Edit tier' : 'Add new tier'}</p>
                                {bundleForm.id && (
                                    <button
                                        onClick={cancelBundleForm}
                                        className="text-[11px] font-semibold text-muted-foreground hover:text-foreground transition-colors"
                                    >
                                        Cancel edit
                                    </button>
                                )}
                            </div>
                            <div className="grid grid-cols-3 gap-2">
                                <Input placeholder="Name" value={bundleForm.name} onChange={e => setBundleForm(p => ({ ...p, name: e.target.value }))} className="h-9" maxLength={50} />
                                <Input placeholder="Credits" type="number" min="1" value={bundleForm.credits} onChange={e => setBundleForm(p => ({ ...p, credits: e.target.value }))} className="h-9" />
                                <Input placeholder="Price GHS" type="number" min="0.01" step="0.01" value={bundleForm.price} onChange={e => setBundleForm(p => ({ ...p, price: e.target.value }))} className="h-9" />
                            </div>
                            <div className="grid grid-cols-2 gap-2 items-center">
                                <Input placeholder="Sort order" type="number" min="0" max="100" value={bundleForm.sort_order} onChange={e => setBundleForm(p => ({ ...p, sort_order: e.target.value }))} className="h-9" />
                                <label className="flex items-center gap-2 text-xs font-medium cursor-pointer">
                                    <input type="checkbox" checked={bundleForm.is_active} onChange={e => setBundleForm(p => ({ ...p, is_active: e.target.checked }))} className="w-3.5 h-3.5" />
                                    Active
                                </label>
                            </div>
                            <Button
                                size="sm"
                                disabled={savingBundle === (bundleForm.id || 'new') || !bundleForm.name || !bundleForm.credits || !bundleForm.price}
                                onClick={submitBundleForm}
                                className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold"
                            >
                                {savingBundle === (bundleForm.id || 'new') ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : bundleForm.id ? <Save className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
                                {bundleForm.id ? 'Save Changes' : 'Add Tier'}
                            </Button>
                        </div>
                    </CardContent>
                </Card>
            </div>

            {/* Shop balances */}
            <Card className="rounded-2xl overflow-hidden">
                <CardContent className="p-0">
                    <div className="px-4 py-3 border-b">
                        <h2 className="text-sm font-bold flex items-center gap-1.5">
                            <Coins className="w-4 h-4 text-blue-500" /> Shop Credit Balances ({data.shopWallets.length})
                        </h2>
                    </div>
                    {data.shopWallets.length === 0 ? (
                        <p className="text-xs text-muted-foreground text-center py-8">No shops have activated SMS yet.</p>
                    ) : (
                        <div className="divide-y max-h-72 overflow-y-auto">
                            {data.shopWallets.map(w => (
                                <div key={w.shop_id} className="px-4 py-2.5 flex items-center justify-between text-sm">
                                    <span className="font-medium truncate">{w.shop_profiles?.shop_name || w.shop_id.slice(0, 8)}</span>
                                    <span className="text-xs text-muted-foreground tabular-nums">
                                        <strong className="text-foreground">{w.credits}</strong> left · {w.total_purchased} bought · {w.total_used} used
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* Sender ID requests */}
            <Card className="rounded-2xl overflow-hidden">
                <CardContent className="p-0">
                    <div className="px-4 py-3 border-b">
                        <h2 className="text-sm font-bold flex items-center gap-1.5">
                            <Tag className="w-4 h-4 text-amber-500" /> Sender ID Requests ({data.pendingSenderRequests.length})
                        </h2>
                        <p className="text-[11px] text-muted-foreground mt-0.5">
                            Shops asking to send order confirmations under their own brand name instead of KFT.
                        </p>
                    </div>

                    {data.pendingSenderRequests.length === 0 ? (
                        <p className="text-xs text-muted-foreground text-center py-8">No pending sender ID requests.</p>
                    ) : (
                        <div className="divide-y max-h-96 overflow-y-auto">
                            {data.pendingSenderRequests.map(r => {
                                const busy = actioningId === r.id
                                return (
                                    <div key={r.id} className="px-4 py-3 space-y-1.5">
                                        <div className="flex items-center justify-between gap-2">
                                            <p className="text-xs font-semibold truncate">{r.shop_profiles?.shop_name || r.shop_id.slice(0, 8)}</p>
                                            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 whitespace-nowrap">
                                                UNDER REVIEW
                                            </span>
                                        </div>
                                        <p className="text-sm font-bold tracking-wide">&ldquo;{r.sender_text}&rdquo;</p>
                                        {r.requested_at && (
                                            <p className="text-[10px] text-muted-foreground/70 flex items-center gap-1">
                                                <Clock className="w-3 h-3" /> Requested {new Date(r.requested_at).toLocaleString()}
                                            </p>
                                        )}
                                        <Input
                                            placeholder="Reason (optional, shown to shop if rejected)"
                                            value={senderReasonById[r.id] || ''}
                                            onChange={e => setSenderReasonById(p => ({ ...p, [r.id]: e.target.value }))}
                                            className="h-8 text-xs mt-1"
                                        />
                                        <div className="flex flex-wrap gap-1.5 pt-1">
                                            <Button
                                                size="sm" variant="outline"
                                                disabled={busy}
                                                onClick={() => reviewSender(r.id, 'approved')}
                                                className="h-7 text-[11px] gap-1 text-emerald-600 border-emerald-200 dark:border-emerald-800"
                                            >
                                                {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
                                                Approve
                                            </Button>
                                            <Button
                                                size="sm" variant="outline"
                                                disabled={busy}
                                                onClick={() => reviewSender(r.id, 'rejected')}
                                                className="h-7 text-[11px] gap-1 text-red-600 border-red-200 dark:border-red-900"
                                            >
                                                {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <XCircle className="w-3 h-3" />}
                                                Reject
                                            </Button>
                                        </div>
                                    </div>
                                )
                            })}
                        </div>
                    )}

                    <div className="px-4 py-3 border-t border-b bg-muted/30">
                        <h3 className="text-xs font-bold flex items-center gap-1.5">
                            <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" /> Approved Senders ({data.approvedSenders.length})
                        </h3>
                        <p className="text-[11px] text-muted-foreground mt-0.5">
                            A shop may hold several approved senders — the <Star className="w-3 h-3 inline text-amber-500" /> one is its
                            current default (used for order confirmations); the owner picks the default from their dashboard.
                        </p>
                    </div>
                    {data.approvedSenders.length === 0 ? (
                        <p className="text-xs text-muted-foreground text-center py-6">No shop has an approved sender ID yet.</p>
                    ) : (
                        <div className="divide-y max-h-72 overflow-y-auto">
                            {data.approvedSenders.map(r => {
                                const busy = actioningId === r.id
                                return (
                                    <div key={r.id} className="px-4 py-2.5 flex items-center justify-between gap-2 text-sm">
                                        <div className="min-w-0">
                                            <p className="font-medium truncate flex items-center gap-1.5">
                                                {r.shop_profiles?.shop_name || r.shop_id.slice(0, 8)}
                                                {r.is_default && <Star className="w-3 h-3 text-amber-500 fill-amber-500 shrink-0" />}
                                            </p>
                                            <p className="text-xs text-muted-foreground">&ldquo;{r.sender_text}&rdquo;{r.is_default ? ' · default' : ''}</p>
                                        </div>
                                        <Button
                                            size="sm" variant="outline"
                                            disabled={busy}
                                            onClick={() => reviewSender(r.id, 'revoked')}
                                            className="h-7 text-[11px] gap-1 text-red-600 border-red-200 dark:border-red-900 shrink-0"
                                        >
                                            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Ban className="w-3 h-3" />}
                                            Revoke
                                        </Button>
                                    </div>
                                )
                            })}
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* Flagged messages */}
            <Card className="rounded-2xl overflow-hidden">
                <CardContent className="p-0">
                    <div className="px-4 py-3 border-b">
                        <h2 className="text-sm font-bold flex items-center gap-1.5">
                            <Flag className="w-4 h-4 text-red-500" /> Flagged Messages ({data.flagged.length})
                        </h2>
                    </div>
                    {data.flagged.length === 0 ? (
                        <p className="text-xs text-muted-foreground text-center py-8">Nothing flagged — all clear.</p>
                    ) : (
                        <div className="divide-y max-h-96 overflow-y-auto">
                            {data.flagged.map(f => {
                                const isSuspended = suspendedSet.has(f.shop_id)
                                const busy = actioningId === f.id || actioningId === f.shop_id
                                return (
                                <div key={f.id} className="px-4 py-3 space-y-1.5">
                                    <div className="flex items-center justify-between gap-2">
                                        <p className="text-xs font-semibold flex items-center gap-1.5">
                                            {f.shop_profiles?.shop_name || 'Unknown shop'}
                                            {isSuspended && (
                                                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 dark:bg-red-900/30">
                                                    SMS DISABLED
                                                </span>
                                            )}
                                        </p>
                                        <span className={cn(
                                            'text-[10px] font-bold px-1.5 py-0.5 rounded-full',
                                            f.status === 'blocked' ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-700'
                                        )}>
                                            {f.status === 'blocked' ? 'BLOCKED' : 'FLAGGED'}
                                        </span>
                                    </div>
                                    <p className="text-xs text-muted-foreground break-words">{f.message}</p>
                                    <p className="text-[11px] text-red-500 font-medium">{f.flag_reason}</p>
                                    <p className="text-[10px] text-muted-foreground/70">
                                        {f.recipients_count} recipient(s) · {new Date(f.created_at).toLocaleString()}
                                    </p>
                                    <p className="text-[11px] mt-0.5 flex items-center gap-2">
                                        {f.delivered_count > 0 && <span className="text-emerald-600 dark:text-emerald-400 font-medium">{f.delivered_count} delivered</span>}
                                        {f.undelivered_count > 0 && <span className="text-red-600 dark:text-red-400 font-medium">{f.undelivered_count} undelivered</span>}
                                        {f.pending_count > 0 && <span className="text-muted-foreground">{f.pending_count} pending</span>}
                                    </p>
                                    <div className="flex flex-wrap gap-1.5 pt-1">
                                        <Button
                                            size="sm" variant="outline"
                                            disabled={busy}
                                            onClick={() => dismissFlag(f.id)}
                                            className="h-7 text-[11px] gap-1 text-muted-foreground"
                                        >
                                            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                                            Dismiss flag
                                        </Button>
                                        <Button
                                            size="sm" variant="outline"
                                            disabled={busy}
                                            onClick={() => toggleSuspend(f.shop_id, !isSuspended)}
                                            className={cn('h-7 text-[11px] gap-1',
                                                isSuspended
                                                    ? 'text-emerald-600 border-emerald-200 dark:border-emerald-800'
                                                    : 'text-red-600 border-red-200 dark:border-red-900')}
                                        >
                                            {busy ? <Loader2 className="w-3 h-3 animate-spin" />
                                                : isSuspended ? <ShieldCheck className="w-3 h-3" /> : <Ban className="w-3 h-3" />}
                                            {isSuspended ? "Re-enable shop's SMS" : "Disable this shop's SMS"}
                                        </Button>
                                    </div>
                                </div>
                                )
                            })}
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    )
}
