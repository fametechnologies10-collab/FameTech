'use client'

import React, { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { Package, Wallet, AlertTriangle, Loader2, ArrowRight, RefreshCw, History, CheckCircle, Copy, Wifi, Sparkles, X } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { supabase } from '@/lib/supabase'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogClose, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { format, parseISO } from 'date-fns'
import { isDefinitiveOutcome, isValidPurchaseSuccess } from '@/lib/standard-bundles-logic'

// ─── Types ────────────────────────────────────────────────────────────────────
type TabId = 'MTN' | 'Telecel' | 'AT' | 'Broadband'
type Kind = 'standard' | 'special' | 'broadband'

interface CatalogBundle {
    value: string; pack_id: string | null; size: string; family: string; family_label: string
    kind: 'standard' | 'special'; original_price: number; price: number; discount_pct: number
}
interface Catalog {
    network: string; enabled: boolean; stale: boolean
    families: { family: string; family_label: string }[]
    bundles: CatalogBundle[]
    broadband: { enabled: boolean; min: number; max: number } | null
}
interface HistoryOrder {
    id: string; reference_code: string; status: string; network: string; kind: string
    bundle_label: string; beneficiary_phone: string; total_paid: number
    created_at: string; completed_at: string | null
}
interface PlacedOrder {
    id: string; reference_code: string; status: string; network: string; kind: string
    beneficiary_phone: string; bundle_label: string; total_paid: number; new_balance?: number
}
// What the confirm sheet is buying.
interface Selection {
    kind: Kind; network: 'MTN' | 'Telecel' | 'AT'; label: string; price: number
    value?: string; packId?: string; amount?: number
}

const TABS: { id: TabId; label: string }[] = [
    { id: 'MTN', label: 'MTN' },
    { id: 'Telecel', label: 'Telecel' },
    { id: 'AT', label: 'AirtelTigo' },
    { id: 'Broadband', label: 'Broadband' },
]
const PHONE_RE = /^0\d{9}$/

/** crypto.randomUUID() is unavailable on insecure origins / very old browsers. */
function newIdempotencyKey(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
    })
}

const money = (n: number) => `GHS ${n.toFixed(2)}`

// ─── Status badge ─────────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: string }) {
    const s = status === 'completed' ? { t: 'Delivered', c: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-900' }
        : status === 'failed' ? { t: 'Failed', c: 'bg-red-100 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-400 dark:border-red-900' }
        : status === 'refunded' ? { t: 'Refunded', c: 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700' }
        : { t: 'Processing', c: 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-400 dark:border-blue-900' }
    return <span className={cn('inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border shrink-0', s.c)}>{s.t}</span>
}

// ─── Bundle card ──────────────────────────────────────────────────────────────
function BundleCard({ b, onSelect }: { b: CatalogBundle; onSelect: () => void }) {
    const discounted = b.discount_pct > 0 && b.price < b.original_price
    return (
        <button
            type="button"
            onClick={onSelect}
            aria-label={`${b.size}, ${money(b.price)}`}
            className="flex flex-col items-start gap-1 p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-emerald-500/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 transition-colors text-left min-w-0"
        >
            <span className="text-sm font-semibold text-slate-900 dark:text-white truncate w-full">{b.size}</span>
            <span className="text-base font-semibold text-emerald-600 dark:text-emerald-400 tabular-nums">{money(b.price)}</span>
            {discounted && (
                <span className="text-xs text-slate-400 line-through tabular-nums">{money(b.original_price)}</span>
            )}
        </button>
    )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function StandardBundlesPage() {
    const { dbUser } = useAuth()
    const [view, setView] = useState<'buy' | 'history'>('buy')
    const [tab, setTab] = useState<TabId>('MTN')

    const [walletBalance, setWalletBalance] = useState<number | null>(null)
    const [catalogs, setCatalogs] = useState<Partial<Record<'MTN' | 'Telecel' | 'AT', Catalog>>>({})
    const [loading, setLoading] = useState(false)
    const [catalogError, setCatalogError] = useState<string | null>(null)

    const [orders, setOrders] = useState<HistoryOrder[]>([])
    const [historyLoading, setHistoryLoading] = useState(false)
    const [historyError, setHistoryError] = useState(false)

    // Broadband form
    const [bbPhone, setBbPhone] = useState('')
    const [bbAmount, setBbAmount] = useState('')

    // Purchase sheet
    const [selection, setSelection] = useState<Selection | null>(null)
    const [phone, setPhone] = useState('')
    const [isSubmitting, setIsSubmitting] = useState(false)
    const submitLockRef = useRef(false)
    // One key per purchase ATTEMPT: reused when the same purchase is retried after a network
    // failure, dropped as soon as the server has answered.
    const attemptRef = useRef<{ signature: string; key: string } | null>(null)
    const phoneInputRef = useRef<HTMLInputElement>(null)
    const [placed, setPlaced] = useState<PlacedOrder | null>(null)
    // True while a failed attempt may still have created an order: the key is retained and the
    // sheet is locked to retrying the SAME purchase (or closing, which clears the key).
    const [ambiguous, setAmbiguous] = useState(false)

    const netKey = tab === 'Broadband' ? 'Telecel' : tab
    const catalog = catalogs[netKey]

    const loadWallet = useCallback(async () => {
        if (!dbUser) return
        try {
            const { data } = await supabase.from('wallets').select('balance').eq('user_id', dbUser.id).single()
            if (data) setWalletBalance(Number((data as any).balance) || 0)
        } catch { /* balance stays as-is */ }
    }, [dbUser])

    useEffect(() => { loadWallet() }, [loadWallet])

    const loadCatalog = useCallback(async (net: 'MTN' | 'Telecel' | 'AT') => {
        setLoading(true)
        setCatalogError(null)
        try {
            const res = await fetch(`/api/standard-bundles/catalog?network=${net}`)
            const json = await res.json().catch(() => null)
            if (!res.ok || !json?.success) {
                setCatalogError(json?.error || 'Bundles are temporarily unavailable. Please try again shortly.')
                return
            }
            setCatalogs(prev => ({ ...prev, [net]: json.data as Catalog }))
        } catch {
            setCatalogError('Connection problem. Please check your internet and try again.')
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => {
        if (view === 'buy' && !catalogs[netKey]) loadCatalog(netKey)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [view, netKey, loadCatalog])

    const loadHistory = useCallback(async () => {
        setHistoryLoading(true)
        setHistoryError(false)
        try {
            const res = await fetch('/api/standard-bundles/history')
            const json = await res.json().catch(() => null)
            if (res.ok && json?.success) setOrders(json.data.orders || [])
            else setHistoryError(true)
        } catch {
            setHistoryError(true)
        } finally {
            setHistoryLoading(false)
        }
    }, [])

    useEffect(() => { if (view === 'history') loadHistory() }, [view, loadHistory])

    const openSheet = (sel: Selection, prefill = '') => {
        setPhone(prefill)
        setSelection(sel)
        // Focus within the click gesture chain (iOS drops the keyboard after setTimeout).
        requestAnimationFrame(() => { requestAnimationFrame(() => { phoneInputRef.current?.focus() }) })
    }

    const phoneValid = PHONE_RE.test(phone)
    const price = selection?.price ?? 0
    const enoughBalance = walletBalance !== null && walletBalance >= price
    const canPay = !!selection && phoneValid && enoughBalance && !isSubmitting

    const handlePay = async () => {
        if (!selection || !canPay || submitLockRef.current) return
        submitLockRef.current = true
        setIsSubmitting(true)
        const signature = [selection.kind, selection.network, phone, selection.value ?? '', selection.packId ?? '', selection.amount ?? ''].join('|')
        if (!attemptRef.current || attemptRef.current.signature !== signature) {
            attemptRef.current = { signature, key: newIdempotencyKey() }
        }
        const idempotencyKey = attemptRef.current.key
        try {
            const res = await fetch('/api/standard-bundles/purchase', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    kind: selection.kind, network: selection.network, beneficiaryPhone: phone,
                    value: selection.value, packId: selection.packId, amount: selection.amount,
                    idempotencyKey,
                }),
            })
            const json = await res.json().catch(() => null)
            if (!(res.ok && isValidPurchaseSuccess(json))) {
                if (!res.ok && isDefinitiveOutcome(res.status, json !== null)) {
                    // Definitive answer, nothing charged: the next tap is a new purchase.
                    attemptRef.current = null
                    setAmbiguous(false)
                    toast.error(json?.error || 'We could not place your order. Please try again.')
                } else {
                    // Ambiguous (5xx, gateway error, throttling, malformed 200): the order may exist. Keep the key.
                    setAmbiguous(true)
                    toast.error('Your order may have gone through. Please check Order history before trying again.')
                }
                return
            }
            // Valid success body: only now is it safe to drop the key.
            const order = json.data.order as PlacedOrder
            if (typeof order.new_balance === 'number') setWalletBalance(order.new_balance)
            else loadWallet()
            setPlaced(order)
            setSelection(null)
            setBbPhone(''); setBbAmount('')
            loadHistory()
        } catch {
            // Network/parse failure: the order MAY exist. Keep the key so a retry returns it, not a second charge.
            setAmbiguous(true)
            toast.error('Your order may have gone through. Please check Order history before trying again.')
        } finally {
            submitLockRef.current = false
            setIsSubmitting(false)
        }
    }

    const copyRef = (code: string) => {
        navigator.clipboard?.writeText(code).then(() => toast.success('Reference copied')).catch(() => {})
    }

    // ── Buy view pieces ──
    const renderBundles = () => {
        if (loading && !catalog) {
            return (
                <div className="grid grid-cols-2 gap-2" aria-busy="true" aria-label="Loading bundles">
                    {Array.from({ length: 6 }).map((_, i) => (
                        <div key={i} className="h-[78px] rounded-xl bg-slate-100 dark:bg-slate-800/60 animate-pulse" />
                    ))}
                </div>
            )
        }
        if (catalogError && !catalog) {
            return (
                <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 text-center space-y-3" role="alert">
                    <AlertTriangle className="w-6 h-6 text-amber-500 mx-auto" />
                    <p className="text-sm text-slate-700 dark:text-slate-300">{catalogError}</p>
                    <Button variant="outline" className="rounded-xl" onClick={() => loadCatalog(netKey)}>
                        <RefreshCw className="w-4 h-4 mr-2" /> Try again
                    </Button>
                </div>
            )
        }
        if (!catalog) return null

        if (!catalog.enabled) {
            return (
                <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 text-center">
                    <Package className="w-6 h-6 text-slate-400 mx-auto mb-2" />
                    <p className="text-sm font-medium text-slate-800 dark:text-slate-200">{tab} bundles are paused for now</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">Please check back later or try another network.</p>
                </div>
            )
        }

        const standard = catalog.bundles.filter(b => b.kind === 'standard')
        const special = catalog.bundles.filter(b => b.kind === 'special')
        const pick = (b: CatalogBundle) => openSheet(
            b.kind === 'special'
                ? { kind: 'special', network: netKey, label: `${b.size} ${b.family_label}`.trim(), price: b.price, packId: b.pack_id ?? undefined }
                : { kind: 'standard', network: netKey, label: `${b.size} ${b.family_label}`.trim(), price: b.price, value: b.value },
        )
        const families = catalog.families.filter(f => standard.some(b => b.family === f.family))

        if (standard.length === 0 && special.length === 0) {
            return <p className="text-sm text-center text-slate-500 dark:text-slate-400 py-8">No bundles are listed for {tab} right now.</p>
        }

        return (
            <div className="space-y-5">
                {catalog.stale && (
                    <p className="text-xs text-slate-400 px-1">Prices may be slightly out of date.</p>
                )}
                {families.map(f => (
                    <section key={f.family} aria-label={f.family_label}>
                        <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-200 mb-2 px-1">{f.family_label}</h2>
                        <div className="grid grid-cols-2 gap-2">
                            {standard.filter(b => b.family === f.family).map(b => (
                                <BundleCard key={b.value} b={b} onSelect={() => pick(b)} />
                            ))}
                        </div>
                    </section>
                ))}
                {special.length > 0 && (
                    <section aria-label="Special bundles">
                        <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-200 mb-2 px-1 flex items-center gap-1.5">
                            <Sparkles className="w-4 h-4 text-amber-500" /> Special bundles
                        </h2>
                        <div className="grid grid-cols-2 gap-2">
                            {special.map(b => (
                                <BundleCard key={b.pack_id ?? b.value} b={b} onSelect={() => pick(b)} />
                            ))}
                        </div>
                    </section>
                )}
            </div>
        )
    }

    const renderBroadband = () => {
        if (loading && !catalog) return <div className="h-40 rounded-2xl bg-slate-100 dark:bg-slate-800/60 animate-pulse" aria-busy="true" />
        if (catalogError && !catalog) return renderBundles()
        const bb = catalog?.broadband
        if (!catalog || !bb || !bb.enabled) {
            return (
                <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 text-center">
                    <Wifi className="w-6 h-6 text-slate-400 mx-auto mb-2" />
                    <p className="text-sm font-medium text-slate-800 dark:text-slate-200">Broadband top-up is paused for now</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">Please check back later.</p>
                </div>
            )
        }
        const amt = Number(bbAmount)
        const amtValid = bbAmount.trim() !== '' && Number.isFinite(amt) && amt >= bb.min && amt <= bb.max && Math.round(amt * 100) === amt * 100
        const bbOk = PHONE_RE.test(bbPhone) && amtValid
        return (
            <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-4">
                <p className="text-xs text-slate-500 dark:text-slate-400">Top up a Telecel Broadband line from your wallet.</p>
                <div>
                    <Label htmlFor="bb-phone" className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5 block">Broadband number</Label>
                    <Input id="bb-phone" inputMode="numeric" autoComplete="off" maxLength={10} placeholder="0XXXXXXXXX"
                        value={bbPhone} onChange={e => setBbPhone(e.target.value.replace(/\D/g, ''))} className="rounded-xl h-11" />
                </div>
                <div>
                    <Label htmlFor="bb-amount" className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5 block">Amount (GHS)</Label>
                    <Input id="bb-amount" inputMode="decimal" autoComplete="off" placeholder={`${bb.min} to ${bb.max}`}
                        value={bbAmount} onChange={e => setBbAmount(e.target.value.replace(/[^0-9.]/g, ''))} className="rounded-xl h-11" />
                    <p className={cn('text-xs mt-1.5', bbAmount && !amtValid ? 'text-red-500' : 'text-slate-400')}>
                        Enter between {money(bb.min)} and {money(bb.max)}.
                    </p>
                </div>
                <Button className="w-full h-12 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-semibold" disabled={!bbOk}
                    onClick={() => openSheet({ kind: 'broadband', network: 'Telecel', label: 'Telecel Broadband top-up', price: amt, amount: amt }, bbPhone)}>
                    Continue <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
            </div>
        )
    }

    return (
        <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">
            <div className="min-w-0">
                <h1 className="text-lg font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                    <Package className="w-5 h-5 text-emerald-500 shrink-0" /> Standard bundles
                </h1>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Buy data bundles for any network from your wallet</p>
            </div>

            <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-sm">
                <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400"><Wallet className="w-3.5 h-3.5 shrink-0" /> Wallet balance</div>
                <div className="text-2xl font-semibold text-slate-900 dark:text-white tabular-nums truncate mt-0.5">
                    {walletBalance !== null ? money(walletBalance) : 'GHS —'}
                </div>
            </div>

            <div className="flex bg-slate-100 dark:bg-slate-800/60 rounded-xl p-1 gap-1" role="tablist" aria-label="Section">
                {(['buy', 'history'] as const).map(v => (
                    <button key={v} role="tab" aria-selected={view === v} onClick={() => setView(v)}
                        className={cn('flex-1 py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2',
                            view === v ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200')}>
                        {v === 'buy' ? <Package className="w-4 h-4" /> : <History className="w-4 h-4" />}
                        {v === 'buy' ? 'Buy' : 'History'}
                    </button>
                ))}
            </div>

            {view === 'buy' && (
                <div className="space-y-4 animate-in fade-in duration-200">
                    <div className="grid grid-cols-4 gap-1.5" role="tablist" aria-label="Network">
                        {TABS.map(t => (
                            <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
                                className={cn('py-2.5 px-1 rounded-xl border text-xs sm:text-sm font-medium transition-colors truncate',
                                    tab === t.id
                                        ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-500/60 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400'
                                        : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-700')}>
                                {t.label}
                            </button>
                        ))}
                    </div>
                    {tab === 'Broadband' ? renderBroadband() : renderBundles()}
                </div>
            )}

            {view === 'history' && (
                <div className="space-y-2 animate-in fade-in duration-200">
                    {historyLoading && orders.length === 0 ? (
                        Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-[68px] rounded-xl bg-slate-100 dark:bg-slate-800/60 animate-pulse" />)
                    ) : historyError ? (
                        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 text-center space-y-3" role="alert">
                            <p className="text-sm text-slate-700 dark:text-slate-300">We could not load your orders.</p>
                            <Button variant="outline" className="rounded-xl" onClick={loadHistory}><RefreshCw className="w-4 h-4 mr-2" /> Try again</Button>
                        </div>
                    ) : orders.length === 0 ? (
                        <p className="text-sm text-center text-slate-500 dark:text-slate-400 py-10">No orders yet. Your bundle purchases will show up here.</p>
                    ) : orders.map(o => (
                        <div key={o.id} className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3 space-y-1.5">
                            <div className="flex items-start justify-between gap-2">
                                <p className="text-sm font-medium text-slate-900 dark:text-white truncate min-w-0">{o.bundle_label}</p>
                                <StatusBadge status={o.status} />
                            </div>
                            <div className="flex items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
                                <span className="truncate">{o.network === 'TelecelBroadband' ? 'Telecel Broadband' : o.network} · {o.beneficiary_phone}</span>
                                <span className="font-medium text-slate-700 dark:text-slate-300 tabular-nums shrink-0">{money(o.total_paid)}</span>
                            </div>
                            <div className="flex items-center justify-between gap-2 text-xs text-slate-400">
                                <span className="font-mono truncate">{o.reference_code}</span>
                                <span className="shrink-0">{format(parseISO(o.created_at), 'd MMM, h:mm a')}</span>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* ── Confirm bottom sheet ── */}
            <Dialog open={!!selection} onOpenChange={o => { if (!o && !isSubmitting) { setSelection(null); attemptRef.current = null; setAmbiguous(false) } }}>
                <DialogContent
                    hideCloseButton
                    className="top-auto bottom-0 translate-y-0 max-w-lg rounded-b-none sm:top-1/2 sm:bottom-auto sm:-translate-y-1/2 sm:rounded-b-2xl p-5 gap-4 max-h-[92dvh] overflow-y-auto"
                >
                    <div className="relative flex items-center justify-center h-9">
                        <div className="w-10 h-1 rounded-full bg-slate-300 dark:bg-slate-700" aria-hidden="true" />
                        <DialogClose aria-label="Close" disabled={isSubmitting}
                            className="absolute right-0 w-9 h-9 rounded-full flex items-center justify-center bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700">
                            <X className="w-4 h-4" />
                        </DialogClose>
                    </div>
                    <div className="min-w-0">
                        <DialogTitle className="text-base font-semibold text-slate-900 dark:text-white">Confirm purchase</DialogTitle>
                        <DialogDescription className="text-xs text-slate-500 dark:text-slate-400">Review the details, then pay from your wallet.</DialogDescription>
                    </div>
                    {selection && (
                        <>
                            <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3 space-y-2">
                                <div className="flex justify-between gap-3 text-sm"><span className="text-slate-500 dark:text-slate-400">Bundle</span><span className="font-medium text-slate-900 dark:text-white truncate">{selection.label}</span></div>
                                <div className="flex justify-between gap-3 text-sm"><span className="text-slate-500 dark:text-slate-400">Network</span><span className="font-medium text-slate-900 dark:text-white">{selection.kind === 'broadband' ? 'Telecel Broadband' : selection.network}</span></div>
                                <div className="flex justify-between gap-3 text-sm border-t border-slate-100 dark:border-slate-800 pt-2"><span className="font-medium text-slate-700 dark:text-slate-300">Total</span><span className="font-semibold text-slate-900 dark:text-white tabular-nums">{money(selection.price)}</span></div>
                            </div>
                            <div>
                                <Label htmlFor="sb-phone" className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5 block">
                                    {selection.kind === 'broadband' ? 'Broadband number' : 'Recipient number'}
                                </Label>
                                <Input id="sb-phone" ref={phoneInputRef} inputMode="numeric" autoComplete="off" maxLength={10} placeholder="0XXXXXXXXX"
                                    value={phone} onChange={e => setPhone(e.target.value.replace(/\D/g, ''))} disabled={isSubmitting || ambiguous}
                                    aria-invalid={phone.length === 10 && !phoneValid} className="rounded-xl h-11" />
                                {phone.length > 0 && !phoneValid && (
                                    <p className="text-xs text-red-500 mt-1.5" role="alert">Enter 10 digits starting with 0.</p>
                                )}
                            </div>
                            {ambiguous && (
                                <p className="text-xs text-amber-600 dark:text-amber-500" role="status">Your last attempt may have gone through. Check Order history first. You can retry the same purchase below, or close this sheet.</p>
                            )}
                            {!enoughBalance && walletBalance !== null ? (
                                <div className="rounded-xl bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 p-3 flex items-start gap-3" role="alert">
                                    <AlertTriangle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                                    <div className="min-w-0">
                                        <p className="text-sm font-medium text-red-700 dark:text-red-400">Insufficient balance</p>
                                        <p className="text-xs text-red-500 dark:text-red-400/80">You need {money(selection.price)} but have {money(walletBalance)}.</p>
                                        <Link href="/dashboard/wallet" className="text-xs font-semibold text-red-700 dark:text-red-300 underline mt-1 inline-block">Top up wallet</Link>
                                    </div>
                                </div>
                            ) : (
                                <Button className="w-full h-12 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-semibold" disabled={!canPay} onClick={handlePay}>
                                    {isSubmitting
                                        ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Processing…</>
                                        : <>Pay {money(selection.price)} from wallet</>}
                                </Button>
                            )}
                            {walletBalance !== null && (
                                <p className="text-xs text-center text-slate-400">Wallet balance: {money(walletBalance)}</p>
                            )}
                        </>
                    )}
                </DialogContent>
            </Dialog>

            {/* ── Success ── */}
            <Dialog open={!!placed} onOpenChange={o => { if (!o) setPlaced(null) }}>
                <DialogContent className="max-w-sm p-5">
                    {placed && (
                        <div className="space-y-4">
                            <div className="flex items-center gap-3">
                                <div className="w-11 h-11 rounded-full border bg-emerald-50 border-emerald-200 dark:bg-emerald-950/30 dark:border-emerald-900 flex items-center justify-center shrink-0">
                                    <CheckCircle className="w-6 h-6 text-emerald-500" />
                                </div>
                                <div className="min-w-0 pr-10">
                                    <DialogTitle className="text-base font-semibold text-slate-900 dark:text-white truncate">Order placed</DialogTitle>
                                    <DialogDescription className="text-xs text-slate-500 dark:text-slate-400">Your bundle is being delivered.</DialogDescription>
                                </div>
                            </div>
                            <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3 space-y-2">
                                <div className="flex justify-between gap-3 text-sm"><span className="text-slate-500 dark:text-slate-400">Bundle</span><span className="font-medium text-slate-900 dark:text-white truncate">{placed.bundle_label}</span></div>
                                <div className="flex justify-between gap-3 text-sm"><span className="text-slate-500 dark:text-slate-400">Recipient</span><span className="font-medium text-slate-900 dark:text-white">{placed.beneficiary_phone}</span></div>
                                <div className="flex justify-between gap-3 text-sm border-t border-slate-100 dark:border-slate-800 pt-2"><span className="text-slate-500 dark:text-slate-400">You paid</span><span className="font-semibold text-slate-900 dark:text-white tabular-nums">{money(placed.total_paid)}</span></div>
                            </div>
                            <button type="button" onClick={() => copyRef(placed.reference_code)}
                                className="w-full flex items-center justify-between gap-3 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60 rounded-xl px-3 py-2.5 min-w-0">
                                <div className="text-left min-w-0">
                                    <p className="text-xs text-slate-400">Reference code</p>
                                    <p className="font-mono font-medium text-slate-800 dark:text-slate-200 text-sm truncate">{placed.reference_code}</p>
                                </div>
                                <Copy className="w-4 h-4 shrink-0 text-slate-400" />
                            </button>
                            <div className="flex gap-2">
                                <Button variant="outline" className="flex-1 rounded-xl h-10" onClick={() => setPlaced(null)}>Buy more</Button>
                                <Button className="flex-1 rounded-xl h-10 bg-emerald-600 hover:bg-emerald-700 text-white" onClick={() => { setPlaced(null); setView('history') }}>History</Button>
                            </div>
                        </div>
                    )}
                </DialogContent>
            </Dialog>
        </div>
    )
}
