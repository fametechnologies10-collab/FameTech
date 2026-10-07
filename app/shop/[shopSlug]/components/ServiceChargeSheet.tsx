'use client'
import { useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Loader2, Smartphone, CheckCircle2, AlertTriangle, X, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { NetworkIcon } from '@/components/network-icon'
import { styleFor } from './NetworkSelectorCard'
import { useChargePolling } from './useChargePolling'
import { StorefrontTermsGate } from './StorefrontTermsGate'
import { storefrontNeedsAccept, recordStorefrontAccept, getStoredStorefrontVersion } from '@/lib/storefront-terms'
import type { CurrentTerms } from '@/lib/terms'

const MOMO_PREFIX: Record<string, 'MTN' | 'Telecel' | 'AT'> = {
    '024': 'MTN', '025': 'MTN', '053': 'MTN', '054': 'MTN', '055': 'MTN', '059': 'MTN',
    '020': 'Telecel', '050': 'Telecel',
    '026': 'AT', '027': 'AT', '056': 'AT', '057': 'AT',
}
const PROVIDERS: Array<{ id: 'MTN' | 'Telecel' | 'AT'; label: string; dot: string }> = [
    { id: 'MTN', label: 'MTN', dot: 'bg-amber-400' },
    { id: 'Telecel', label: 'Telecel', dot: 'bg-red-600' },
    { id: 'AT', label: 'AirtelTigo', dot: 'bg-blue-600' },
]

// Normalize a Ghana number to local 0XXXXXXXXX form (converts a 233 prefix), capped to 10 digits.
function toLocalMomo(v: string): string {
    const d = (v || '').replace(/\D/g, '')
    return (d.startsWith('233') ? '0' + d.slice(3) : d).slice(0, 10)
}

/**
 * Service-agnostic descriptor. Each storefront product (data / airtime / mashup / RC)
 * injects only what differs; the proven charge → OTP → poll → success machine is shared.
 */
export interface ChargeDescriptor {
    title: string                 // header line, e.g. "MTN · 5GB"
    network?: string              // colored header style via styleFor(); omit for non-network products (RC)
    amountLabel: string           // right-side header amount, e.g. formatCurrency(total)
    chargeUrl: string             // e.g. '/api/shop/charge' or '/api/shop/results-checker/charge'
    statusUrl: string             // matching status endpoint for polling
    beneficiary: { label: string; hint: string } | null  // null = no separate recipient (charge the MoMo number directly)
    // Pre-fills the MoMo field when the recipient was already collected upstream (e.g. airtime/
    // mashup's own recipient-number field) — stays editable, it's just a starting guess that the
    // payer and recipient are the same line. Ignored when `beneficiary` is set (that flow already
    // has its own "use this number for MoMo" carry-forward).
    initialMomoPhone?: string
    email: { hint: string } | null   // null = hide the email field (recipient/email already captured upstream)
    successText: (ctx: { beneficiary: string; momoPhone: string }) => string
    // Shown when payment is confirmed but the product is NOT yet delivered (backorder /
    // delayed fulfilment). Never reveals secrets. Defaults to a generic "being processed" line.
    receivedText?: (ctx: { beneficiary: string; momoPhone: string }) => string
    buildBody: (ctx: { beneficiary: string; momoPhone: string; provider: 'MTN' | 'Telecel' | 'AT'; email?: string }) => Record<string, unknown>
    onPaid?: (reference: string) => void   // fired once on confirmed+FULFILLED payment (RC uses it to reveal vouchers)
}

type Step = 'form' | 'charging' | 'otp' | 'pending' | 'received' | 'success' | 'failed'

export function ServiceChargeSheet({
    open, onClose, descriptor, brandName,
}: {
    open: boolean
    onClose: () => void
    descriptor: ChargeDescriptor | null
    brandName: string
}) {
    const [step, setStep] = useState<Step>('form')
    // Beneficiary = the number that RECEIVES the product (data/airtime/voucher SMS).
    const [beneficiaryPhone, setBeneficiaryPhone] = useState('')
    // MoMo number = the wallet that gets CHARGED.
    const [momoPhone, setMomoPhone] = useState('')
    const [provider, setProvider] = useState<'MTN' | 'Telecel' | 'AT' | ''>('')
    const [autoDetected, setAutoDetected] = useState(false)
    const [useSameForMomo, setUseSameForMomo] = useState(true)
    const [email, setEmail] = useState('')
    const [reference, setReference] = useState('')
    const [displayText, setDisplayText] = useState('')
    const [otp, setOtp] = useState('')
    const [total, setTotal] = useState<number | null>(null)
    const [failedMessage, setFailedMessage] = useState('')
    // Guest terms gate (storefront buyers aren't logged in).
    const [showTermsGate, setShowTermsGate] = useState(false)
    const [storefrontTerms, setStorefrontTerms] = useState<CurrentTerms | null>(null)

    const hasBeneficiary = !!descriptor?.beneficiary
    // Reference is needed inside the (memoized) poll callbacks — a ref avoids stale closures.
    const refForPaid = useRef('')

    const { start, stop, iHavePaid, pollCount, checking, PATIENT_POLLS } = useChargePolling(
        () => { setStep('success'); if (refForPaid.current) descriptor?.onPaid?.(refForPaid.current) },
        () => setStep('failed'),
        descriptor?.statusUrl,
        // Payment confirmed but not yet fulfilled — surface a holding screen and KEEP polling.
        // Deliberately does NOT call descriptor.onPaid (which would reveal not-yet-existing vouchers).
        () => setStep(prev => (prev === 'success' ? prev : 'received')),
    )

    useEffect(() => {
        if (open) {
            setStep('form'); setBeneficiaryPhone('')
            // Carried forward from the recipient collected upstream (still fully editable) when
            // this flow has no separate beneficiary field of its own.
            setMomoPhone(!descriptor?.beneficiary ? toLocalMomo(descriptor?.initialMomoPhone || '') : '')
            setProvider(''); setAutoDetected(false)
            setUseSameForMomo(!!descriptor?.beneficiary); setEmail('')
            setReference(''); refForPaid.current = ''; setOtp(''); setDisplayText(''); setTotal(null); setFailedMessage(''); setShowTermsGate(false)
        } else stop()
    }, [open, descriptor, stop])

    // Keep the MoMo number synced to the beneficiary while the "use same number" box is ticked.
    useEffect(() => {
        if (useSameForMomo && hasBeneficiary) setMomoPhone(toLocalMomo(beneficiaryPhone))
    }, [useSameForMomo, hasBeneficiary, beneficiaryPhone])

    // Auto-detect the MoMo network from the number being charged.
    useEffect(() => {
        if (momoPhone.length >= 3) {
            const found = MOMO_PREFIX[momoPhone.slice(0, 3)]
            if (found) { setProvider(found); setAutoDetected(true) } else setAutoDetected(false)
        } else setAutoDetected(false)
    }, [momoPhone])

    const style = descriptor?.network ? styleFor(descriptor.network) : null

    const toggleSameForMomo = () => {
        if (useSameForMomo) { setUseSameForMomo(false); setMomoPhone('') }
        else { setUseSameForMomo(true); setMomoPhone(toLocalMomo(beneficiaryPhone)) }
    }

    const authorize = async () => {
        if (!descriptor) return

        // Guest terms gate — block the first charge until the current agreement is accepted.
        let terms = storefrontTerms
        if (!terms) {
            try {
                const r = await fetch('/api/terms/current')
                const j = await r.json()
                if (j?.success) { terms = j.data as CurrentTerms; setStorefrontTerms(terms) }
            } catch { /* terms unavailable — fail open rather than block a sale */ }
        }
        if (terms && storefrontNeedsAccept(terms.minAcceptableVersion)) {
            setShowTermsGate(true)
            return
        }
        if (!terms && !getStoredStorefrontVersion()) {
            // Couldn't load the current terms and this guest has never accepted — block
            // rather than fail open (a blocked /api/terms/current must not bypass consent).
            toast.error('Could not load Terms & Conditions. Please refresh and try again.')
            return
        }

        const beneficiary = hasBeneficiary ? beneficiaryPhone.replace(/\s+/g, '') : momoPhone
        if (hasBeneficiary && !/^(0\d{9}|233\d{9})$/.test(beneficiary)) {
            toast.error(`Enter the ${descriptor.beneficiary!.label.toLowerCase()}`)
            return
        }
        if (!/^0[0-9]{9}$/.test(momoPhone)) {
            toast.error('Enter a valid Mobile Money number (e.g. 0241234567)')
            return
        }
        if (!provider) {
            toast.error('Select your mobile money network')
            return
        }
        if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
            toast.error('Enter a valid email or leave it blank')
            return
        }

        setStep('charging')
        try {
            const res = await fetch(descriptor.chargeUrl, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(descriptor.buildBody({ beneficiary, momoPhone, provider, email: email.trim() || undefined })),
            })
            const data = await res.json().catch(() => ({}))
            if (!res.ok) {
                if (data.needsManualSelection) { setProvider(''); setAutoDetected(false); setStep('form'); toast.error('Select your MoMo network.'); return }
                throw new Error(data.error || `Payment service error (HTTP ${res.status})`)
            }
            setReference(data.reference); refForPaid.current = data.reference; setDisplayText(data.display_text || '')
            if (typeof data.total === 'number') setTotal(data.total)
            if (data.status === 'send_otp') setStep('otp')
            else if (data.status === 'success') { setStep('pending'); start(data.reference) }
            else if (data.status === 'failed') throw new Error(data.display_text || 'Payment could not be processed')
            else { setStep('pending'); start(data.reference) }
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : 'Payment failed'
            toast.error(msg); setFailedMessage(msg); setStep('failed')
        }
    }

    const submitOtp = async () => {
        if (!otp.trim()) { toast.error('Enter the OTP'); return }
        setStep('charging')
        try {
            // The OTP route accepts both SHOP- and RC- references, so it is shared across services.
            const res = await fetch('/api/shop/charge/submit-otp', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reference, otp }),
            })
            const data = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(data.error || `OTP submission failed (HTTP ${res.status})`)
            setDisplayText(data.display_text || '')
            if (typeof data.total === 'number') setTotal(data.total)
            // Hubtel's pre-charge verification replays the charge under a NEW reference
            // (the transient UTLV- verify-reference is never the thing that gets polled) —
            // Paystack's own submit-otp response never includes `reference`, so this stays
            // a no-op there and keeps polling the original charge-time reference.
            const pollRef = data.reference || reference
            if (data.reference && data.reference !== reference) { setReference(data.reference); refForPaid.current = data.reference }
            if (data.status === 'success') { setStep('pending'); start(pollRef) }
            else if (data.status === 'send_otp') { setOtp(''); setStep('otp'); toast.info(data.display_text || 'Re-enter OTP') }
            else if (data.status === 'failed') throw new Error(data.display_text || 'Payment failed')
            else { setStep('pending'); start(pollRef) }
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : 'OTP failed'
            toast.error(msg); setFailedMessage(msg); setStep('failed')
        }
    }

    const beneficiaryDisplay = hasBeneficiary ? beneficiaryPhone.replace(/\s+/g, '') : momoPhone

    if (!descriptor) return null

    return (
        <>
        <Dialog open={open} onOpenChange={(o) => { if (!o && (step === 'form' || step === 'success' || step === 'received' || step === 'failed')) onClose() }}>
            <DialogContent
                hideCloseButton
                aria-describedby={undefined}
                onInteractOutside={(e) => { if (step !== 'form' && step !== 'success' && step !== 'received' && step !== 'failed') e.preventDefault() }}
                onEscapeKeyDown={(e) => { if (step !== 'form' && step !== 'success' && step !== 'received' && step !== 'failed') e.preventDefault() }}
                className="!fixed !left-0 !right-0 !bottom-0 !top-auto !translate-x-0 !translate-y-0 w-full max-w-full sm:max-w-md sm:mx-auto rounded-t-[2rem] rounded-b-none p-0 gap-0 shadow-2xl border-x-0 border-b-0 max-h-[92dvh] overflow-y-auto overscroll-contain"
            >
                <DialogTitle className="sr-only">{descriptor.title}</DialogTitle>
                <div className="relative flex items-center justify-center pt-3 pb-1">
                    <div className="w-9 h-1 rounded-full bg-gray-200 dark:bg-zinc-700" />
                    {(step === 'form' || step === 'success' || step === 'received' || step === 'failed') && (
                        <button onClick={onClose} className="absolute right-3 w-9 h-9 rounded-full bg-muted flex items-center justify-center" aria-label="Close">
                            <X className="w-4 h-4" />
                        </button>
                    )}
                </div>

                <div className={cn('mx-4 mt-2 rounded-2xl px-4 py-3 flex items-center justify-between', style?.cardBg || 'bg-emerald-600')}>
                    <div className="flex items-center gap-2">
                        {descriptor.network && <div className="p-1.5 bg-white/20 rounded-full"><NetworkIcon network={descriptor.network} size={22} /></div>}
                        <span className={cn('font-black text-lg', style?.isMTN ? 'text-black' : 'text-white')}>{descriptor.title}</span>
                    </div>
                    <span className={cn('font-bold', style?.isMTN ? 'text-black' : 'text-white')}>{descriptor.amountLabel}</span>
                </div>

                <div className="px-5 pb-10 pt-4 space-y-4">
                    {step === 'form' && (
                        <>
                            {/* 1. Beneficiary number — the line that RECEIVES the product (required, first) */}
                            {hasBeneficiary && (
                                <>
                                    <div>
                                        <label className="text-sm font-semibold text-foreground">
                                            {descriptor.beneficiary!.label} <span className="font-normal text-muted-foreground">{descriptor.beneficiary!.hint}</span>
                                        </label>
                                        <input
                                            inputMode="numeric" placeholder="0241234567" value={beneficiaryPhone}
                                            onChange={(e) => setBeneficiaryPhone(e.target.value.replace(/[^\d]/g, '').slice(0, 12))}
                                            className="mt-2 w-full h-12 px-4 rounded-full border border-border bg-background text-base font-semibold text-foreground"
                                        />
                                    </div>

                                    <button
                                        type="button"
                                        onClick={toggleSameForMomo}
                                        className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
                                    >
                                        <span className={cn(
                                            'w-4 h-4 rounded border-2 flex items-center justify-center transition-colors shrink-0',
                                            useSameForMomo ? 'border-foreground bg-foreground' : 'border-border'
                                        )}>
                                            {useSameForMomo && <Check className="w-3 h-3 text-background" />}
                                        </span>
                                        Use this number for Mobile Money payment
                                    </button>
                                </>
                            )}

                            {/* 2. MoMo number — the wallet that gets charged */}
                            <div>
                                <label className="text-sm font-semibold text-foreground">
                                    Mobile Money number <span className="font-normal text-muted-foreground">(to pay)</span>
                                </label>
                                <input
                                    inputMode="numeric" placeholder="0241234567" value={momoPhone}
                                    onChange={(e) => setMomoPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
                                    disabled={useSameForMomo && hasBeneficiary}
                                    className={cn(
                                        'mt-2 w-full h-12 px-4 rounded-full border border-border bg-background text-base font-semibold text-foreground',
                                        useSameForMomo && hasBeneficiary && 'opacity-60 cursor-not-allowed'
                                    )}
                                />
                            </div>

                            {/* Network (auto-detected from the MoMo number; tap to override) */}
                            <div>
                                <label className="text-sm font-semibold text-foreground">
                                    Network {autoDetected && provider && <span className="ml-2 text-xs text-green-600 font-medium">Auto-detected</span>}
                                </label>
                                <div className="mt-2 grid grid-cols-3 gap-2">
                                    {PROVIDERS.map(p => (
                                        <button key={p.id} onClick={() => { setProvider(p.id); setAutoDetected(false) }}
                                            className={cn('flex items-center justify-center gap-1.5 h-11 rounded-xl border-2 text-sm font-semibold transition-colors',
                                                provider === p.id ? 'border-foreground bg-muted' : 'border-border')}>
                                            <span className={cn('w-2.5 h-2.5 rounded-full', p.dot)} /> {p.label}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Email (only when this service collects it in the sheet — e.g. data) */}
                            {descriptor.email && (
                                <div>
                                    <label className="text-sm font-semibold text-foreground">
                                        Email <span className="font-normal text-muted-foreground">{descriptor.email.hint}</span>
                                    </label>
                                    <input
                                        type="email" inputMode="email" placeholder="you@example.com" value={email}
                                        onChange={(e) => setEmail(e.target.value)}
                                        className="mt-2 w-full h-12 px-4 rounded-full border border-border bg-background text-base text-foreground"
                                    />
                                </div>
                            )}

                            <button onClick={authorize}
                                className="w-full py-3 rounded-full bg-green-600 hover:bg-green-700 text-white font-bold text-base flex items-center justify-center gap-2">
                                <Smartphone className="w-5 h-5" /> Proceed to payment
                            </button>
                            <p className="text-xs text-center text-muted-foreground">A small payment fee applies. Confirm the exact total on your phone.</p>
                        </>
                    )}

                    {step === 'charging' && (
                        <div className="flex flex-col items-center py-10 gap-3"><Loader2 className="w-10 h-10 animate-spin text-green-600" /><p className="font-semibold text-foreground">Starting payment…</p></div>
                    )}

                    {step === 'otp' && (
                        <div className="space-y-4">
                            <p className="text-sm font-medium text-center text-foreground">{displayText || 'Enter the OTP sent to your phone'}</p>
                            <input placeholder="Enter OTP" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} maxLength={6}
                                className="w-full h-12 text-center text-xl font-mono tracking-widest rounded-xl border border-border bg-background text-foreground" />
                            <button onClick={submitOtp} disabled={!otp} className="w-full h-12 rounded-full bg-green-600 text-white font-bold">Submit OTP</button>
                            <button onClick={() => { stop(); setStep('form') }} className="w-full text-xs text-muted-foreground hover:underline">Cancel</button>
                        </div>
                    )}

                    {step === 'pending' && (
                        <div className="flex flex-col items-center py-6 gap-4 text-center">
                            <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center"><Smartphone className="w-8 h-8 text-green-600" /></div>
                            <div className="space-y-1">
                                <p className="font-bold text-lg text-foreground">
                                    {total != null ? `Approve GHS ${total.toFixed(2)} on your phone` : 'Approve on your phone'}
                                </p>
                                <p className="text-sm text-muted-foreground">Enter your MoMo PIN on the prompt sent to <span className="font-semibold text-foreground">{momoPhone}</span>, then tap below.</p>
                            </div>
                            <button onClick={async () => { const o = await iHavePaid(refForPaid.current); if (o === 'pending') toast.info("Not received yet — approve the prompt, then tap again.") }}
                                disabled={checking} className="w-full h-12 rounded-full bg-green-600 text-white font-bold flex items-center justify-center gap-2">
                                {checking ? <><Loader2 className="w-5 h-5 animate-spin" /> Checking…</> : <><CheckCircle2 className="w-5 h-5" /> I&apos;ve paid — check now</>}
                            </button>
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                <Loader2 className="w-4 h-4 animate-spin" />
                                <span>{pollCount >= PATIENT_POLLS ? 'Taking longer than usual — once you approve, you\'ll be credited automatically.' : 'Waiting for approval…'}</span>
                            </div>
                            <button onClick={() => { stop(); onClose() }} className="text-xs text-muted-foreground hover:underline">Close</button>
                        </div>
                    )}

                    {step === 'received' && (
                        <div className="flex flex-col items-center py-8 gap-4 text-center">
                            <div className="w-16 h-16 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center"><CheckCircle2 className="w-9 h-9 text-amber-600" /></div>
                            <div>
                                <p className="font-black text-xl text-foreground">Payment received</p>
                                <p className="text-sm text-muted-foreground mt-1">
                                    {descriptor.receivedText
                                        ? descriptor.receivedText({ beneficiary: beneficiaryDisplay, momoPhone })
                                        : "We've received your payment and are processing your order. You'll be notified as soon as it's delivered."}
                                </p>
                            </div>
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                <Loader2 className="w-4 h-4 animate-spin" /><span>Finishing delivery…</span>
                            </div>
                            <button onClick={onClose} className="w-full h-12 rounded-full bg-foreground text-background font-bold">Done</button>
                        </div>
                    )}

                    {step === 'success' && (
                        <div className="flex flex-col items-center py-8 gap-4 text-center">
                            <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center"><CheckCircle2 className="w-9 h-9 text-green-600" /></div>
                            <div>
                                <p className="font-black text-xl text-foreground">Payment successful!</p>
                                <p className="text-sm text-muted-foreground mt-1">{descriptor.successText({ beneficiary: beneficiaryDisplay, momoPhone })}</p>
                            </div>
                            <button onClick={onClose} className="w-full h-12 rounded-full bg-foreground text-background font-bold">Done</button>
                        </div>
                    )}

                    {step === 'failed' && (
                        <div className="flex flex-col items-center py-8 gap-4 text-center">
                            <AlertTriangle className="w-10 h-10 text-red-500" />
                            <p className="font-semibold text-foreground">Payment could not be completed</p>
                            {failedMessage && <p className="text-sm text-muted-foreground">{failedMessage}</p>}
                            <button onClick={() => setStep('form')} className="px-5 h-11 rounded-full border border-border font-semibold">Try Again</button>
                        </div>
                    )}
                </div>
            </DialogContent>
        </Dialog>
        <StorefrontTermsGate
            open={showTermsGate}
            terms={storefrontTerms}
            brandName={brandName}
            onAccept={() => { if (storefrontTerms) recordStorefrontAccept(storefrontTerms.version); setShowTermsGate(false); void authorize() }}
            onCancel={() => setShowTermsGate(false)}
        />
        </>
    )
}
