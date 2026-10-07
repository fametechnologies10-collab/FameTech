'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useAuth } from '@/contexts/auth-context'
import { supabase } from '@/lib/supabase'
import { formatCurrency } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
    ArrowLeft, Smartphone, CheckCircle2, Loader2, Copy, Check,
    Share2, RefreshCcw, Wand2, ArrowRight, ShoppingCart, TrendingUp, AlertCircle,
} from 'lucide-react'
import { toast } from '@/lib/toast'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'

// NEXT_PUBLIC_ vars inline at build time — keep this a const, not state.
const SHORTCODE = process.env.NEXT_PUBLIC_USSD_SHORTCODE ?? '*713*9939#'

interface UssdSales {
    count: number
    profit: number
}

export default function ShopUssdPage() {
    const { dbUser } = useAuth()

    const [loading, setLoading] = useState(true)

    // Shop profile fields (kept in local state so they update after activation/rotate/custom)
    const [shopId, setShopId] = useState<string | null>(null)
    const [shopName, setShopName] = useState<string>('')
    const [approvalStatus, setApprovalStatus] = useState<string>('')
    const [isActive, setIsActive] = useState(false)
    const [ussdCode, setUssdCode] = useState<string | null>(null)
    const [ussdActive, setUssdActive] = useState(false)

    // Activation
    const [activationFee, setActivationFee] = useState<number>(50)
    const [activating, setActivating] = useState(false)
    // Synchronous in-flight lock: `activating` only disables the button after a
    // re-render, so two rapid taps could otherwise both send a (paid) activation.
    const activatingRef = useRef(false)
    // Pay-source: activate from top-up wallet OR earned profit. Auto-selects
    // whichever covers the fee once balances load (profit preferred).
    const [walletBalance, setWalletBalance] = useState<number>(0)
    const [profitBalance, setProfitBalance] = useState<number>(0)
    const [paidFrom, setPaidFrom] = useState<'wallet' | 'profit'>('wallet')

    // Share kit copy state — keyed so each button shows its own "copied" tick
    const [copiedKey, setCopiedKey] = useState<string | null>(null)

    // Code management
    const [rotateOpen, setRotateOpen] = useState(false)
    const [rotating, setRotating] = useState(false)
    const [customCode, setCustomCode] = useState('')
    const [savingCustom, setSavingCustom] = useState(false)

    // USSD sales summary
    const [sales, setSales] = useState<UssdSales>({ count: 0, profit: 0 })

    // Client-side throttle shared by BOTH rotate + custom-code save, so a user
    // can't spam either action. Mirrors the per-user limit in middleware.ts.
    const codeAttemptsRef = useRef<number[]>([])
    const MAX_CODE_ATTEMPTS = 5          // per rolling minute, shared across rotate + custom
    const CODE_ATTEMPT_WINDOW_MS = 60_000
    function canAttemptCodeChange(): boolean {
        const now = Date.now()
        codeAttemptsRef.current = codeAttemptsRef.current.filter(t => now - t < CODE_ATTEMPT_WINDOW_MS)
        if (codeAttemptsRef.current.length >= MAX_CODE_ATTEMPTS) {
            toast.error('You\'re changing your code too often. Please wait a minute and try again.')
            return false
        }
        codeAttemptsRef.current.push(now)
        return true
    }

    useEffect(() => {
        if (!dbUser) return
        fetchShop()
    }, [dbUser])

    const fetchShop = async () => {
        try {
            const { data: shop } = await (supabase as any)
                .from('shop_profiles')
                .select('id, shop_name, ussd_code, ussd_active, approval_status, is_active')
                .eq('owner_id', dbUser!.id)
                .maybeSingle()

            if (shop) {
                setShopId(shop.id)
                setShopName(shop.shop_name ?? '')
                setApprovalStatus(shop.approval_status ?? '')
                setIsActive(!!shop.is_active)
                setUssdCode(shop.ussd_code ?? null)
                setUssdActive(!!shop.ussd_active)
            }

            // Activation fee + balances — non-critical, keep defaults on failure.
            try {
                const feeRes = await fetch('/api/shop/ussd-activate')
                if (feeRes.ok) {
                    const { fee, walletBalance: wb, profitBalance: pb } = await feeRes.json()
                    const feeVal = typeof fee === 'number' ? fee : 50
                    const wallet = typeof wb === 'number' ? wb : 0
                    const profit = typeof pb === 'number' ? pb : 0
                    setActivationFee(feeVal)
                    setWalletBalance(wallet)
                    setProfitBalance(profit)
                    // Auto-select whichever source covers the fee (profit first).
                    setPaidFrom(profit >= feeVal ? 'profit' : 'wallet')
                }
            } catch {
                // keep defaults
            }

            // USSD sales summary — only when a shop id exists.
            if (shop?.id) {
                await fetchSales(shop.id)
            }
        } catch (err) {
            console.error('[ShopUssd] Failed to load shop:', err)
        } finally {
            setLoading(false)
        }
    }

    const fetchSales = async (id: string) => {
        const [dataSettled, rcSettled] = await Promise.allSettled([
            (supabase as any)
                .from('shop_orders')
                .select('profit')
                .eq('shop_id', id)
                .eq('source', 'ussd'),
            (supabase as any)
                .from('results_checker_orders')
                .select('shop_markup, quantity')
                .eq('shop_id', id)
                .eq('source', 'ussd_shop')
                .neq('payment_status', 'pending_payment'),
        ])

        let count = 0
        let profit = 0

        if (dataSettled.status === 'fulfilled' && dataSettled.value?.data) {
            const rows = dataSettled.value.data as { profit: number }[]
            count += rows.length
            profit += rows.reduce((sum, r) => sum + (r.profit || 0), 0)
        }

        if (rcSettled.status === 'fulfilled' && rcSettled.value?.data) {
            const rows = rcSettled.value.data as { shop_markup: number; quantity: number }[]
            count += rows.length
            profit += rows.reduce((sum, r) => sum + (r.shop_markup || 0) * (r.quantity || 0), 0)
        }

        setSales({ count, profit })
    }

    const handleActivate = async () => {
        if (activatingRef.current) return
        activatingRef.current = true
        setActivating(true)
        try {
            const res = await fetch('/api/shop/ussd-activate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ paidFrom }),
            })
            const data = await res.json()
            if (res.ok) {
                setUssdCode(data.code)
                setUssdActive(true)
                toast.success(`USSD code activated: ${data.code}`)
            } else {
                toast.error(data.error ?? 'Activation failed')
            }
        } finally {
            activatingRef.current = false
            setActivating(false)
        }
    }

    const handleRotate = async () => {
        if (!canAttemptCodeChange()) return
        setRotating(true)
        try {
            const res = await fetch('/api/shop/ussd-code', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: 'rotate' }),
            })
            const data = await res.json()
            if (res.ok) {
                setUssdCode(data.code)
                toast.success(`New code: ${data.code}`)
                setRotateOpen(false)
            } else {
                toast.error(data.error ?? 'Could not rotate code')
            }
        } finally {
            setRotating(false)
        }
    }

    const handleSaveCustom = async () => {
        if (!canAttemptCodeChange()) return
        setSavingCustom(true)
        try {
            const res = await fetch('/api/shop/ussd-code', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: 'custom', code: customCode }),
            })
            const data = await res.json()
            if (res.ok) {
                setUssdCode(data.code)
                toast.success(`Code set to ${data.code}`)
                setCustomCode('')
            } else {
                toast.error(data.error ?? 'Could not set code')
            }
        } finally {
            setSavingCustom(false)
        }
    }

    const copy = async (key: string, text: string, message: string) => {
        await navigator.clipboard.writeText(text)
        setCopiedKey(key)
        toast.success(message)
        setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 2000)
    }

    const dialSteps = [
        `1. Dial ${SHORTCODE}`,
        `2. Enter shop code ${ussdCode ?? ''}`,
        '3. Choose Data Bundles or Results Checker',
        '4. Pay with Mobile Money',
    ]

    const shareMessage =
        `Buy data & WAEC checker from ${shopName || 'my shop'} on USSD 📱\n` +
        `Dial ${SHORTCODE}, enter shop code ${ussdCode ?? ''}, pick a service, pay with MoMo. Fast & easy!`

    if (loading) {
        return (
            <div className="flex items-center justify-center py-20">
                <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
        )
    }

    const shopApprovedActive = approvalStatus === 'approved' && isActive
    const hasShop = !!shopId
    const selectedBalance = paidFrom === 'profit' ? profitBalance : walletBalance
    const insufficientForActivation = selectedBalance < activationFee

    return (
        <div className="space-y-6 pb-20 md:pb-6">
            {/* ── Header ── */}
            <div className="flex items-center gap-2">
                <Link href="/dashboard/shop">
                    <Button variant="ghost" size="icon" className="h-8 w-8">
                        <ArrowLeft className="w-4 h-4" />
                    </Button>
                </Link>
                <div>
                    <h1 className="text-2xl font-bold flex items-center gap-2">
                        <Smartphone className="w-6 h-6 text-violet-600" />
                        USSD Storefront
                    </h1>
                    <p className="text-sm text-muted-foreground mt-0.5">
                        Let customers buy from your shop on any phone — no app, no internet.
                    </p>
                </div>
            </div>

            {/* ── Card 1: Status / Activation ── */}
            <div className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-zinc-950 p-5 space-y-4">
                <div className="flex items-center gap-2">
                    <Smartphone className="w-4 h-4 text-violet-600 dark:text-violet-400" />
                    <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">USSD Shop Code</h2>
                </div>

                {!hasShop ? (
                    <div className="flex items-start gap-3 rounded-xl bg-amber-50 dark:bg-amber-900/10 border border-amber-100 dark:border-amber-900/20 p-4">
                        <AlertCircle className="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                        <p className="text-sm text-amber-800 dark:text-amber-300">
                            You don&apos;t have a shop yet.{' '}
                            <Link href="/dashboard/shop/setup" className="font-semibold underline underline-offset-2">
                                Create your shop
                            </Link>{' '}
                            to unlock USSD.
                        </p>
                    </div>
                ) : !shopApprovedActive ? (
                    <div className="flex items-start gap-3 rounded-xl bg-amber-50 dark:bg-amber-900/10 border border-amber-100 dark:border-amber-900/20 p-4">
                        <AlertCircle className="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                        <p className="text-sm text-amber-800 dark:text-amber-300">
                            Your shop must be approved and active before you can activate USSD.
                        </p>
                    </div>
                ) : !ussdActive ? (
                    <div className="space-y-3">
                        <p className="text-sm text-muted-foreground">
                            Activate your USSD shop code so customers can buy from your shop directly on
                            USSD — no KiNG FLEXY account needed.
                        </p>
                        <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                            One-time fee:{' '}
                            <span className="text-violet-600 dark:text-violet-400">
                                GHS {activationFee.toFixed(2)}
                            </span>
                        </p>

                        {/* Pay-source selector — wallet (top-up) or profit (earnings) */}
                        <div>
                            <p className="text-xs font-medium text-muted-foreground mb-1.5">Pay from</p>
                            <div className="grid grid-cols-2 gap-2">
                                {([
                                    { key: 'wallet', label: 'Wallet', balance: walletBalance },
                                    { key: 'profit', label: 'Profit', balance: profitBalance },
                                ] as const).map((src) => {
                                    const active = paidFrom === src.key
                                    const enough = src.balance >= activationFee
                                    return (
                                        <button
                                            key={src.key}
                                            type="button"
                                            onClick={() => setPaidFrom(src.key)}
                                            aria-pressed={active}
                                            className={`rounded-xl border p-3 text-left transition-colors ${
                                                active
                                                    ? 'border-violet-500 bg-violet-50 dark:border-violet-500 dark:bg-violet-900/20'
                                                    : 'border-gray-200 dark:border-gray-800 hover:border-violet-300 dark:hover:border-violet-700'
                                            }`}
                                        >
                                            <div className="flex items-center justify-between">
                                                <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                                                    {src.label}
                                                </span>
                                                {active && (
                                                    <CheckCircle2 className="w-4 h-4 text-violet-600 dark:text-violet-400" />
                                                )}
                                            </div>
                                            <p className="text-xs mt-1 tabular-nums text-muted-foreground">
                                                {formatCurrency(src.balance)}
                                            </p>
                                            {!enough && (
                                                <p className="text-[11px] mt-0.5 text-amber-600 dark:text-amber-400">
                                                    Too low for the fee
                                                </p>
                                            )}
                                        </button>
                                    )
                                })}
                            </div>
                        </div>

                        <Button
                            onClick={handleActivate}
                            disabled={activating || insufficientForActivation}
                            className="bg-violet-600 hover:bg-violet-700 text-white gap-2"
                        >
                            {activating ? (
                                <>
                                    <Loader2 className="w-4 h-4 animate-spin" /> Activating…
                                </>
                            ) : (
                                <>Activate with {paidFrom === 'profit' ? 'Profit' : 'Wallet'} (GHS {activationFee.toFixed(2)})</>
                            )}
                        </Button>
                        {insufficientForActivation && (
                            <p className="text-xs text-amber-600 dark:text-amber-400">
                                Your {paidFrom} balance is too low. Switch source or top up your wallet.
                            </p>
                        )}
                    </div>
                ) : (
                    <div className="space-y-3">
                        <p className="text-xs text-muted-foreground">
                            Share this code with your customers so they can find your shop on USSD.
                        </p>
                        <div className="text-4xl font-mono font-bold tracking-widest text-violet-600 dark:text-violet-400">
                            {ussdCode}
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-sm text-gray-700 dark:text-gray-300">{SHORTCODE}</span>
                            <ArrowRight className="w-4 h-4 text-muted-foreground" />
                            <span className="font-mono text-sm font-semibold text-gray-900 dark:text-white">
                                {ussdCode}
                            </span>
                            <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                                <CheckCircle2 className="w-3 h-3" /> Active
                            </span>
                        </div>
                    </div>
                )}
            </div>

            {/* ── Card 2: Customer Share Kit ── */}
            {ussdActive && ussdCode && (
                <div className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-zinc-950 p-5 space-y-4">
                    <div className="flex items-center gap-2">
                        <Share2 className="w-4 h-4 text-violet-600 dark:text-violet-400" />
                        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                            Customer Share Kit
                        </h2>
                    </div>

                    <ol className="space-y-2">
                        {[
                            <>Dial <span className="font-mono font-semibold">{SHORTCODE}</span></>,
                            <>Enter shop code <span className="font-mono font-semibold">{ussdCode}</span></>,
                            <>Choose Data Bundles or Results Checker</>,
                            <>Pay with Mobile Money</>,
                        ].map((step, i) => (
                            <li key={i} className="flex items-start gap-3 text-sm text-gray-700 dark:text-gray-300">
                                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-violet-50 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400 text-xs font-bold flex items-center justify-center">
                                    {i + 1}
                                </span>
                                <span className="pt-0.5">{step}</span>
                            </li>
                        ))}
                    </ol>

                    <div className="flex flex-wrap gap-2 pt-1">
                        <Button
                            variant="outline"
                            size="sm"
                            className="gap-1.5"
                            onClick={() => copy('code', ussdCode, 'Shop code copied!')}
                        >
                            {copiedKey === 'code' ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
                            Copy code
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            className="gap-1.5"
                            onClick={() => copy('steps', dialSteps.join('\n'), 'Dial steps copied!')}
                        >
                            {copiedKey === 'steps' ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
                            Copy dial steps
                        </Button>
                        <Button
                            size="sm"
                            className="gap-1.5 bg-violet-600 hover:bg-violet-700 text-white"
                            onClick={() => copy('message', shareMessage, 'Share message copied!')}
                        >
                            {copiedKey === 'message' ? <Check className="w-3.5 h-3.5" /> : <Share2 className="w-3.5 h-3.5" />}
                            Copy share message
                        </Button>
                    </div>
                </div>
            )}

            {/* ── Card 3: Your Code / Management ── */}
            {ussdActive && ussdCode && (
                <div className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-zinc-950 p-5 space-y-5">
                    <div className="flex items-center gap-2">
                        <Wand2 className="w-4 h-4 text-violet-600 dark:text-violet-400" />
                        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Manage Your Code</h2>
                    </div>

                    {/* Rotate */}
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                        <div>
                            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Generate new code</p>
                            <p className="text-xs text-muted-foreground">
                                Swap to a fresh random code. The old one stops working immediately.
                            </p>
                        </div>
                        <Button
                            variant="outline"
                            size="sm"
                            className="gap-1.5 self-start sm:self-auto"
                            onClick={() => setRotateOpen(true)}
                        >
                            <RefreshCcw className="w-3.5 h-3.5" />
                            Generate new code
                        </Button>
                    </div>

                    <div className="border-t border-gray-100 dark:border-gray-800" />

                    {/* Custom */}
                    <div className="space-y-2">
                        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Set a custom code</p>
                        <div className="flex flex-col sm:flex-row gap-2">
                            <Input
                                value={customCode}
                                onChange={(e) => setCustomCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4))}
                                maxLength={4}
                                placeholder="HAKA"
                                aria-label="Custom USSD code"
                                className="font-mono uppercase tracking-widest sm:max-w-[160px]"
                            />
                            <Button
                                size="sm"
                                className="bg-violet-600 hover:bg-violet-700 text-white gap-1.5"
                                onClick={handleSaveCustom}
                                disabled={savingCustom || customCode.length !== 4}
                            >
                                {savingCustom ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save'}
                            </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            4 letters or numbers (A–Z, 0–9). Must be unique.
                        </p>
                    </div>
                </div>
            )}

            {/* ── Card 4: USSD Sales Summary ── */}
            {ussdActive && ussdCode && (
                <div className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-zinc-950 p-5 space-y-4">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <TrendingUp className="w-4 h-4 text-violet-600 dark:text-violet-400" />
                            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">USSD Sales</h2>
                        </div>
                        <Link
                            href="/dashboard/shop/orders"
                            className="text-xs font-semibold text-emerald-600 hover:text-emerald-700 flex items-center gap-1"
                        >
                            View all orders <ArrowRight className="w-3 h-3" />
                        </Link>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <div className="rounded-xl border border-gray-200 dark:border-gray-800 p-4">
                            <div className="flex items-center gap-1.5 mb-1">
                                <ShoppingCart className="w-3.5 h-3.5 text-violet-600 dark:text-violet-400" />
                                <p className="text-[11px] font-medium text-muted-foreground">USSD Orders</p>
                            </div>
                            <p className="text-lg font-bold tabular-nums text-gray-900 dark:text-white">{sales.count}</p>
                        </div>
                        <div className="rounded-xl border border-gray-200 dark:border-gray-800 p-4">
                            <div className="flex items-center gap-1.5 mb-1">
                                <TrendingUp className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                                <p className="text-[11px] font-medium text-muted-foreground">USSD Profit</p>
                            </div>
                            <p className="text-lg font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                                {formatCurrency(sales.profit)}
                            </p>
                        </div>
                    </div>
                </div>
            )}

            {/* ── Rotate confirm dialog ── */}
            <Dialog open={rotateOpen} onOpenChange={(o) => !rotating && setRotateOpen(o)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Generate a new code?</DialogTitle>
                        <DialogDescription>
                            Your current code{' '}
                            <span className="font-mono font-semibold text-foreground">{ussdCode}</span>{' '}
                            will stop working immediately. Customers must use the new code.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setRotateOpen(false)} disabled={rotating}>
                            Cancel
                        </Button>
                        <Button
                            className="bg-violet-600 hover:bg-violet-700 text-white"
                            onClick={handleRotate}
                            disabled={rotating}
                        >
                            {rotating ? (
                                <>
                                    <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Generating…
                                </>
                            ) : (
                                'Generate new code'
                            )}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
