'use client'

/**
 * UtilityFlowSheet — the storefront's guest utility-bill purchase flow (ECG / Ghana Water /
 * DSTV / GOtv / StarTimes). Structural sibling of app/dashboard/utilities/UtilityFlowSheet.tsx
 * (same verification-first trust centerpiece: no payment proceeds without either a fresh
 * lookup or the explicit ECG manual-meter consent).
 *
 * This sheet owns ONLY account verification + amount entry. Once the guest taps Pay, it hands
 * a built ChargeDescriptor up to the parent (StorefrontUtilitiesTab -> ShopStorefront, which
 * owns the single shared <ServiceChargeSheet> instance) and closes itself — payment itself runs
 * through the SAME in-app OTP+poll experience every other storefront product uses
 * (app/shop/[shopSlug]/components/ServiceChargeSheet.tsx), never a redirect. The dual-rail
 * choice (Hubtel Direct Pay vs Paystack) lives entirely server-side in
 * app/api/shop/utility/charge/route.ts — this component neither knows nor cares which provider
 * is behind the toggle.
 *
 * A phone number is collected for EVERY biller, not just ECG/Ghana Water: computeShopCheckout
 * (lib/shop-checkout.ts) requires a top-level `guestPhone` for all order types — for DSTV/GOtv/
 * StarTimes it is never used as the biller "destination" (payDestination: 'account'), only as
 * the storefront contact number and the synthetic receipt email.
 */

import { useEffect, useRef, useState, type RefObject } from 'react'
import {
    AlertTriangle, ArrowLeft, ArrowRight, Check, ChevronRight,
    Loader2, Mail, Pencil, Phone, RefreshCw, ShieldCheck, X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { UTILITY_BILLERS, type UtilityBiller } from '@/lib/hubtel-utility/billers'
import { UTILITY_BILLER_META } from './UtilityBillerMeta'
import type { ChargeDescriptor } from './ServiceChargeSheet'
import { UtilityBillerLogo } from '@/components/utility-biller-logo'

const isValidLocalPhone = (p: string) => /^0\d{9}$/.test(p)
const QUICK_AMOUNTS = [10, 20, 50, 100]

type FlowStep = 'account' | 'verify' | 'amount'

interface LookupMeter { name: string; meterNumber: string; outstanding: number }
interface LookupInfo {
    accountName: string | null
    accountNumber: string | null
    amountDue: number | null
    bouquet: string | null
    meters: LookupMeter[]
}

interface Props {
    biller: UtilityBiller | null
    open: boolean
    onClose: () => void
    shopSlug: string
    minAmount: number
    maxAmount: number
    /** Ref owned by the parent so focus can start inside the tap gesture (double rAF). */
    accountInputRef: RefObject<HTMLInputElement>
    /** Fired when the guest taps Pay with a valid amount — the parent opens the shared
     * ServiceChargeSheet with this descriptor; this sheet closes itself right after. */
    onProceedToPayment: (descriptor: ChargeDescriptor) => void
}

export function UtilityFlowSheet({ biller, open, onClose, shopSlug, minAmount, maxAmount, accountInputRef, onProceedToPayment }: Props) {
    const def = biller ? UTILITY_BILLERS[biller] : null
    const meta = biller ? UTILITY_BILLER_META[biller] : null

    const [step, setStep] = useState<FlowStep>('account')
    const [phone, setPhone] = useState('')
    const [account, setAccount] = useState('')

    // ECG manual-meter path (the one sanctioned exception to a fresh lookup)
    const [ecgManual, setEcgManual] = useState(false)
    const [ecgConsent, setEcgConsent] = useState(false)

    const [lookupLoading, setLookupLoading] = useState(false)
    const [lookupError, setLookupError] = useState<string | null>(null)
    const [info, setInfo] = useState<LookupInfo | null>(null)
    const [selectedMeter, setSelectedMeter] = useState<LookupMeter | null>(null)

    const [amount, setAmount] = useState('')
    const [email, setEmail] = useState('')

    const manualMeterRef = useRef<HTMLInputElement | null>(null)

    // ── Flow-instance reset: runs when the sheet OPENS (new biller/open = fresh flow) ──
    useEffect(() => {
        if (!open || !biller) return
        setStep('account')
        setPhone('')
        setAccount('')
        setEcgManual(false)
        setEcgConsent(false)
        setLookupLoading(false)
        setLookupError(null)
        setInfo(null)
        setSelectedMeter(null)
        setAmount('')
        setEmail('')
    }, [open, biller])

    // ── Lookup ────────────────────────────────────────────────────────────────
    async function runLookup(params: { account: string; phone: string }) {
        if (!biller) return
        setLookupLoading(true)
        setLookupError(null)
        setInfo(null)
        setSelectedMeter(null)
        try {
            const res = await fetch('/api/shop/utility/lookup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ shopSlug, biller, account: params.account, phone: params.phone }),
            })
            const data = await res.json().catch(() => null)
            if (data?.success && data.data) {
                setInfo(data.data as LookupInfo)
                setStep('verify')
            } else {
                setLookupError(data?.error || 'Could not verify this account — please try again.')
            }
        } catch {
            setLookupError('Connection problem — check your internet and try again.')
        } finally {
            setLookupLoading(false)
        }
    }

    const handleLookupClick = () => {
        if (!def || !biller) return
        if (biller === 'ecg') {
            if (!isValidLocalPhone(phone)) return
            runLookup({ account: phone, phone })
        } else {
            if (!account.trim() || !isValidLocalPhone(phone)) return
            runLookup({ account: account.trim(), phone })
        }
    }

    // ── Derived values ───────────────────────────────────────────────────────
    const parsedAmount = parseFloat(amount) || 0
    const amountValid = parsedAmount >= minAmount && parsedAmount <= maxAmount

    const isEcgManualPath = biller === 'ecg' && ecgManual && !selectedMeter
    const consentSatisfied = !isEcgManualPath || ecgConsent

    const verifiedName = biller === 'ecg' ? (selectedMeter?.name ?? null) : (info?.accountName ?? null)
    const payAccount = biller === 'ecg' ? (selectedMeter?.meterNumber ?? account.trim()) : (info?.accountNumber || account.trim())
    const amountDue = biller === 'ecg'
        ? (selectedMeter && selectedMeter.outstanding > 0 ? selectedMeter.outstanding : null)
        : (info && typeof info.amountDue === 'number' && info.amountDue > 0 ? info.amountDue : null)

    const goToAmount = (prefillDue: number | null) => {
        if (prefillDue && prefillDue > 0) setAmount(String(Math.min(prefillDue, maxAmount).toFixed(2)))
        setStep('amount')
    }

    // ── Pay — hands off to the shared in-app charge sheet ───────────────────
    // Builds the ChargeDescriptor and lets the parent open <ServiceChargeSheet>. The actual
    // charge call, OTP, polling, and success/failure UI all live there — same experience as
    // every other storefront product, regardless of which provider the server-side toggle
    // picks (app/api/shop/utility/charge/route.ts).
    const handlePay = () => {
        if (!biller || !def) return
        if (!amountValid || !isValidLocalPhone(phone) || !consentSatisfied) return

        const trimmedEmail = email.trim()
        const descriptor: ChargeDescriptor = {
            title: def.label,
            amountLabel: `GHS ${parsedAmount.toFixed(2)}`,
            chargeUrl: '/api/shop/utility/charge',
            statusUrl: '/api/shop/utility/charge/status',
            beneficiary: null, // the biller account/meter was already collected above
            email: null, // already collected in this sheet's own amount step, sent via buildBody
            successText: () => `Your ${def.label} payment was successful.`,
            receivedText: () => "We've received your payment and are completing your bill payment.",
            buildBody: ({ momoPhone, provider }) => {
                const body: Record<string, unknown> = {
                    shopSlug, biller, account: payAccount, phone, amount: parsedAmount,
                    momoNumber: momoPhone, momoProvider: provider,
                }
                if (trimmedEmail) body.email = trimmedEmail
                if (verifiedName) body.accountName = verifiedName
                if (info && !isEcgManualPath) body.lookupSnapshot = info
                return body
            },
        }
        onProceedToPayment(descriptor)
        onClose()
    }

    if (!biller || !def || !meta) return null

    return (
        <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
            <DialogContent
                hideCloseButton
                className="!fixed !left-0 !right-0 !bottom-0 !top-auto !translate-x-0 !translate-y-0 w-full max-w-full rounded-t-[2rem] rounded-b-none p-0 gap-0 shadow-2xl border-x-0 border-b-0 max-h-[92dvh] overflow-y-auto overscroll-contain"
                aria-describedby={undefined}
                onOpenAutoFocus={(e) => e.preventDefault()}
            >
                <DialogDescription className="sr-only">Pay a {def.label} bill</DialogDescription>

                {/* Drag handle + close */}
                <div className="relative flex items-center justify-center pt-3 pb-1">
                    <div className="w-9 h-1 rounded-full bg-gray-200 dark:bg-zinc-700" />
                    <DialogClose
                        className="absolute right-3 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-muted flex items-center justify-center text-muted-foreground hover:bg-muted/80 active:scale-95 transition-all disabled:pointer-events-none disabled:opacity-40"
                    >
                        <X className="w-4 h-4" />
                        <span className="sr-only">Close</span>
                    </DialogClose>
                </div>

                {/* Biller header */}
                <div className="flex items-center gap-3 px-5 pt-1 pb-3">
                    <UtilityBillerLogo biller={biller} FallbackIcon={meta.Icon} badgeClassName={meta.badge} size={40} />
                    <div className="min-w-0">
                        <DialogTitle className="text-base font-bold leading-tight truncate">{def.label}</DialogTitle>
                        <p className="text-xs text-muted-foreground truncate">
                            GHS {minAmount.toFixed(0)}–{maxAmount.toFixed(0)} · Secure checkout
                        </p>
                    </div>
                </div>

                <div className="px-5 pb-[calc(env(safe-area-inset-bottom,0px)+2rem)] space-y-4">
                    <>
                            {/* ══ STEP 1 — ACCOUNT ══════════════════════════════════════ */}
                            {step === 'account' && (
                                <div className="space-y-4 animate-in fade-in duration-200">
                                    {biller === 'ecg' ? (
                                        <>
                                            <div className="space-y-1.5">
                                                <Label htmlFor="sf-util-phone" className="text-sm font-medium">ECG phone number</Label>
                                                <div className="relative">
                                                    <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                                                    <Input
                                                        ref={accountInputRef}
                                                        id="sf-util-phone"
                                                        type="tel"
                                                        inputMode="numeric"
                                                        placeholder="0XXXXXXXXX"
                                                        maxLength={10}
                                                        value={phone}
                                                        onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
                                                        className="pl-9 rounded-xl h-11 font-mono"
                                                    />
                                                </div>
                                                <p className="text-xs text-muted-foreground">We list the meters registered to this phone, and use it to reach you about this payment.</p>
                                            </div>

                                            {!ecgManual && (
                                                <Button
                                                    className="w-full h-11 rounded-xl font-semibold"
                                                    disabled={!isValidLocalPhone(phone) || lookupLoading}
                                                    onClick={handleLookupClick}
                                                >
                                                    {lookupLoading
                                                        ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Finding meters…</>
                                                        : <>Find my meters <ArrowRight className="w-4 h-4 ml-1.5" /></>}
                                                </Button>
                                            )}

                                            <button
                                                type="button"
                                                onClick={() => {
                                                    const next = !ecgManual
                                                    setEcgManual(next)
                                                    if (!next) setEcgConsent(false)
                                                    if (next) {
                                                        requestAnimationFrame(() => {
                                                            requestAnimationFrame(() => { manualMeterRef.current?.focus() })
                                                        })
                                                    }
                                                }}
                                                className="w-full flex items-center justify-between text-sm text-muted-foreground hover:text-foreground transition-colors py-1"
                                            >
                                                <span className="flex items-center gap-1.5">
                                                    <Pencil className="w-3.5 h-3.5" /> Enter meter number manually
                                                </span>
                                                <ChevronRight className={cn('w-4 h-4 transition-transform', ecgManual && 'rotate-90')} />
                                            </button>

                                            {ecgManual && (
                                                <div className="space-y-3 rounded-xl border border-border p-3.5 animate-in fade-in duration-200">
                                                    <div className="space-y-1.5">
                                                        <Label htmlFor="sf-util-manual-meter" className="text-sm font-medium">Meter number</Label>
                                                        <Input
                                                            ref={manualMeterRef}
                                                            id="sf-util-manual-meter"
                                                            type="text"
                                                            inputMode="numeric"
                                                            placeholder="Meter number"
                                                            maxLength={30}
                                                            value={account}
                                                            onChange={(e) => {
                                                                // Consent is granted for a SPECIFIC meter — any edit
                                                                // (including via amount-step Back → change meter)
                                                                // invalidates it, forcing a fresh tick before Pay.
                                                                if (e.target.value !== account) setEcgConsent(false)
                                                                setAccount(e.target.value)
                                                            }}
                                                            className="rounded-xl h-11 font-mono"
                                                        />
                                                    </div>
                                                    <button
                                                        type="button"
                                                        role="checkbox"
                                                        aria-checked={ecgConsent}
                                                        onClick={() => setEcgConsent(!ecgConsent)}
                                                        className="w-full flex items-start gap-3 text-left select-none"
                                                    >
                                                        <span
                                                            aria-hidden
                                                            className={cn(
                                                                'mt-0.5 w-5 h-5 rounded-md border flex items-center justify-center shrink-0 transition-colors',
                                                                ecgConsent ? 'bg-amber-500 border-amber-500 text-white' : 'border-slate-300 dark:border-slate-600'
                                                            )}
                                                        >
                                                            {ecgConsent && <Check className="w-3.5 h-3.5" />}
                                                        </span>
                                                        <span className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                                                            ECG will link this meter to <span className="font-semibold">{phone || 'your phone'}</span>. I understand.
                                                        </span>
                                                    </button>
                                                    <Button
                                                        className="w-full h-11 rounded-xl font-semibold"
                                                        disabled={!account.trim() || !ecgConsent || !isValidLocalPhone(phone)}
                                                        onClick={() => { setSelectedMeter(null); setInfo(null); goToAmount(null) }}
                                                    >
                                                        Continue with this meter <ArrowRight className="w-4 h-4 ml-1.5" />
                                                    </Button>
                                                </div>
                                            )}
                                        </>
                                    ) : (
                                        <>
                                            <div className="space-y-1.5">
                                                <Label htmlFor="sf-util-account" className="text-sm font-medium">{def.accountLabel}</Label>
                                                <Input
                                                    ref={accountInputRef}
                                                    id="sf-util-account"
                                                    type="text"
                                                    inputMode="numeric"
                                                    placeholder={def.accountLabel}
                                                    maxLength={30}
                                                    value={account}
                                                    onChange={(e) => setAccount(e.target.value)}
                                                    className="rounded-xl h-11 font-mono"
                                                />
                                            </div>

                                            <div className="space-y-1.5">
                                                <Label htmlFor="sf-util-phone" className="text-sm font-medium">Phone number</Label>
                                                <div className="relative">
                                                    <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                                                    <Input
                                                        id="sf-util-phone"
                                                        type="tel"
                                                        inputMode="numeric"
                                                        placeholder="0XXXXXXXXX"
                                                        maxLength={10}
                                                        value={phone}
                                                        onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
                                                        className="pl-9 rounded-xl h-11 font-mono"
                                                    />
                                                </div>
                                                <p className="text-xs text-muted-foreground">
                                                    {biller === 'ghana_water'
                                                        ? 'Ghana Water needs your phone to verify the meter.'
                                                        : "We'll use this number to reach you about this payment."}
                                                </p>
                                            </div>

                                            <Button
                                                className="w-full h-11 rounded-xl font-semibold"
                                                disabled={lookupLoading || !account.trim() || !isValidLocalPhone(phone)}
                                                onClick={handleLookupClick}
                                            >
                                                {lookupLoading
                                                    ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Verifying…</>
                                                    : <>Verify account <ArrowRight className="w-4 h-4 ml-1.5" /></>}
                                            </Button>
                                        </>
                                    )}

                                    {lookupError && (
                                        <div className="rounded-xl bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 p-3.5 flex items-start gap-2.5">
                                            <AlertTriangle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                                            <div className="min-w-0 flex-1">
                                                <p className="text-sm text-red-700 dark:text-red-400">{lookupError}</p>
                                                <button
                                                    type="button"
                                                    onClick={handleLookupClick}
                                                    className="mt-1 text-xs font-semibold text-red-600 dark:text-red-400 hover:underline inline-flex items-center gap-1"
                                                >
                                                    <RefreshCw className="w-3 h-3" /> Try again
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* ══ STEP 2 — VERIFY (the trust centerpiece) ═══════════════ */}
                            {step === 'verify' && info && (
                                <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
                                    {biller === 'ecg' ? (
                                        <>
                                            <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
                                                {info.meters.length > 0
                                                    ? `Select your meter — ${info.meters.length} linked to ${phone}`
                                                    : 'No meters found'}
                                            </p>
                                            {info.meters.length === 0 ? (
                                                <div className="rounded-xl border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/20 p-4">
                                                    <p className="text-sm text-amber-700 dark:text-amber-400">
                                                        No meters are registered to this phone yet. You can enter your meter number manually below.
                                                    </p>
                                                </div>
                                            ) : (
                                                <div className={cn(
                                                    'grid gap-2.5',
                                                    info.meters.length === 1 ? 'grid-cols-1' : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4'
                                                )}>
                                                    {info.meters.map((m) => (
                                                        <button
                                                            key={m.meterNumber}
                                                            type="button"
                                                            title={m.name || 'Meter'}
                                                            onClick={() => {
                                                                setSelectedMeter(m)
                                                                setAccount(m.meterNumber)
                                                                setEcgManual(false)
                                                                setEcgConsent(false)
                                                                goToAmount(m.outstanding > 0 ? m.outstanding : null)
                                                            }}
                                                            className="flex flex-col items-start gap-2 rounded-xl border border-border bg-card p-3 text-left transition-colors hover:border-slate-300 dark:hover:border-slate-600"
                                                        >
                                                            <UtilityBillerLogo biller={biller} FallbackIcon={meta.Icon} badgeClassName={meta.badge} size={28} rounded="lg" />
                                                            <div className="min-w-0 w-full">
                                                                <p className="text-sm font-semibold truncate">{m.name || 'Meter'}</p>
                                                                <p className="text-xs text-muted-foreground font-mono truncate">{m.meterNumber}</p>
                                                            </div>
                                                            {m.outstanding > 0 ? (
                                                                <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400 tabular-nums">
                                                                    Owes GHS {m.outstanding.toFixed(2)}
                                                                </span>
                                                            ) : m.outstanding < 0 ? (
                                                                <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-400 tabular-nums">
                                                                    Credit GHS {Math.abs(m.outstanding).toFixed(2)}
                                                                </span>
                                                            ) : (
                                                                <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                                                                    No balance due
                                                                </span>
                                                            )}
                                                        </button>
                                                    ))}
                                                </div>
                                            )}
                                            <div className="flex items-center justify-between pt-1">
                                                <button
                                                    type="button"
                                                    onClick={() => { setStep('account'); setInfo(null); setSelectedMeter(null) }}
                                                    className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5"
                                                >
                                                    <ArrowLeft className="w-3.5 h-3.5" /> Change phone
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => { setStep('account'); setInfo(null); setSelectedMeter(null); setEcgManual(true) }}
                                                    className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5"
                                                >
                                                    <Pencil className="w-3.5 h-3.5" /> Enter meter manually
                                                </button>
                                            </div>
                                        </>
                                    ) : (
                                        <>
                                            <div className={cn('rounded-2xl border border-border bg-card p-4 shadow-sm ring-1', meta.ring)}>
                                                <div className="flex items-center gap-2 mb-3">
                                                    <div className={cn('w-8 h-8 rounded-full flex items-center justify-center shrink-0', meta.badge)}>
                                                        <ShieldCheck className="w-4 h-4" />
                                                    </div>
                                                    <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">Verified account</p>
                                                </div>
                                                <div className="grid grid-cols-2 gap-2">
                                                    <div className="rounded-xl border border-border bg-background/60 p-3 col-span-2">
                                                        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Name</p>
                                                        <p className="mt-0.5 text-sm font-bold text-foreground break-words">{info.accountName || 'Name unavailable'}</p>
                                                    </div>
                                                    <div className="rounded-xl border border-border bg-background/60 p-3">
                                                        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{def.accountLabel}</p>
                                                        <p className="mt-0.5 text-sm font-bold text-foreground font-mono truncate">{info.accountNumber || account.trim()}</p>
                                                    </div>
                                                    {typeof info.amountDue === 'number' && info.amountDue > 0 && (
                                                        <div className="rounded-xl border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/20 p-3">
                                                            <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">Amount due</p>
                                                            <p className="mt-0.5 text-sm font-bold text-amber-700 dark:text-amber-400 tabular-nums">GHS {info.amountDue.toFixed(2)}</p>
                                                        </div>
                                                    )}
                                                    {typeof info.amountDue === 'number' && info.amountDue < 0 && (
                                                        <div className="rounded-xl border border-green-200 dark:border-green-900 bg-green-50 dark:bg-green-950/20 p-3">
                                                            <p className="text-[10px] font-semibold uppercase tracking-wide text-green-700 dark:text-green-400">Account credit</p>
                                                            <p className="mt-0.5 text-sm font-bold text-green-700 dark:text-green-400 tabular-nums">GHS {Math.abs(info.amountDue).toFixed(2)}</p>
                                                        </div>
                                                    )}
                                                    {biller === 'startimes' && info.bouquet && (
                                                        <div className="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/20 p-3">
                                                            <p className="text-[10px] font-semibold uppercase tracking-wide text-red-700 dark:text-red-400">Bouquet</p>
                                                            <p className="mt-0.5 text-sm font-bold text-red-700 dark:text-red-400 truncate">{info.bouquet}</p>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>

                                            <Button className="w-full h-11 rounded-xl font-semibold" onClick={() => goToAmount(amountDue)}>
                                                Continue <ArrowRight className="w-4 h-4 ml-1.5" />
                                            </Button>
                                            <button
                                                type="button"
                                                onClick={() => { setStep('account'); setInfo(null) }}
                                                className="w-full text-sm text-muted-foreground hover:text-foreground text-center"
                                            >
                                                Not you? Change account
                                            </button>
                                        </>
                                    )}
                                </div>
                            )}

                            {/* ══ STEP 3 — AMOUNT + confirm + Pay ════════════════════════ */}
                            {step === 'amount' && (
                                <div className="space-y-4 animate-in fade-in duration-200">
                                    {isEcgManualPath ? (
                                        <div className="rounded-xl border border-amber-200 dark:border-amber-900 bg-amber-50/70 dark:bg-amber-950/20 p-3 flex items-start gap-2.5">
                                            <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                                            <p className="text-xs text-amber-700 dark:text-amber-400 leading-relaxed">
                                                Unverified meter <span className="font-mono font-semibold">{account.trim()}</span> — ECG will link it to {phone}.
                                            </p>
                                        </div>
                                    ) : (
                                        <button
                                            type="button"
                                            onClick={() => setStep('verify')}
                                            className="w-full flex items-center gap-2.5 rounded-xl border border-border bg-card p-3 text-left hover:border-slate-300 dark:hover:border-slate-600 transition-colors"
                                        >
                                            <div className="w-8 h-8 rounded-full bg-green-100 dark:bg-green-950/40 flex items-center justify-center shrink-0">
                                                <ShieldCheck className="w-4 h-4 text-green-600 dark:text-green-400" />
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <p className="text-sm font-semibold truncate">{verifiedName || 'Verified account'}</p>
                                                <p className="text-xs text-muted-foreground font-mono truncate">{payAccount}</p>
                                            </div>
                                            <span className="text-xs text-muted-foreground shrink-0">Change</span>
                                        </button>
                                    )}

                                    <div className="space-y-1.5">
                                        <Label htmlFor="sf-util-amount" className="text-sm font-medium flex items-center gap-2 flex-wrap">
                                            Amount (GHS)
                                            <span className="text-xs font-normal text-muted-foreground">Min {minAmount} · Max {maxAmount}</span>
                                        </Label>
                                        <div className="relative">
                                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">GHS</span>
                                            <Input
                                                id="sf-util-amount"
                                                type="number"
                                                inputMode="decimal"
                                                placeholder="0.00"
                                                min={minAmount}
                                                max={maxAmount}
                                                step="0.01"
                                                value={amount}
                                                onChange={(e) => setAmount(e.target.value)}
                                                className="pl-12 rounded-xl h-11 tabular-nums text-base font-semibold"
                                            />
                                        </div>
                                    </div>

                                    <div className="flex gap-2 flex-wrap">
                                        {QUICK_AMOUNTS.filter((q) => q >= minAmount && q <= maxAmount).map((q) => (
                                            <button
                                                key={q}
                                                type="button"
                                                onClick={() => setAmount(String(q))}
                                                className={cn(
                                                    'px-3.5 py-1.5 rounded-lg text-sm font-medium border transition-colors tabular-nums',
                                                    parseFloat(amount) === q
                                                        ? 'bg-foreground border-foreground text-background'
                                                        : 'bg-card border-border text-foreground hover:border-slate-300 dark:hover:border-slate-600'
                                                )}
                                            >
                                                {q}
                                            </button>
                                        ))}
                                        {amountDue !== null && (
                                            <button
                                                type="button"
                                                onClick={() => setAmount(String(Math.min(amountDue, maxAmount).toFixed(2)))}
                                                className="px-3.5 py-1.5 rounded-lg text-sm font-medium border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400 tabular-nums"
                                            >
                                                Due: {Math.min(amountDue, maxAmount).toFixed(2)}
                                            </button>
                                        )}
                                    </div>

                                    {parsedAmount > 0 && !amountValid && (
                                        <p className="text-xs text-red-500">
                                            {parsedAmount < minAmount
                                                ? `Minimum amount is GHS ${minAmount.toFixed(2)}`
                                                : `Maximum amount is GHS ${maxAmount.toFixed(2)}`}
                                        </p>
                                    )}

                                    <div className="space-y-1.5">
                                        <Label htmlFor="sf-util-email" className="text-sm font-medium">Email (optional)</Label>
                                        <div className="relative">
                                            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                                            <Input
                                                id="sf-util-email"
                                                type="email"
                                                placeholder="Email (optional)"
                                                value={email}
                                                onChange={(e) => setEmail(e.target.value)}
                                                className="pl-9 rounded-xl h-11"
                                            />
                                        </div>
                                    </div>

                                    <Button
                                        className="w-full h-12 rounded-xl font-semibold text-sm"
                                        disabled={!amountValid || !isValidLocalPhone(phone) || !consentSatisfied}
                                        onClick={handlePay}
                                    >
                                        Pay GHS {parsedAmount.toFixed(2)}
                                    </Button>

                                    <button
                                        type="button"
                                        onClick={() => setStep(isEcgManualPath ? 'account' : 'verify')}
                                        className="w-full text-sm text-muted-foreground hover:text-foreground text-center inline-flex items-center justify-center gap-1.5 disabled:opacity-40"
                                    >
                                        <ArrowLeft className="w-3.5 h-3.5" /> Back
                                    </button>
                                </div>
                            )}
                        </>
                </div>
            </DialogContent>
        </Dialog>
    )
}
