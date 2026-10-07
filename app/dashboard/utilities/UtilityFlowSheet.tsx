'use client'

/**
 * UtilityFlowSheet — the single reusable bottom-sheet purchase flow for every
 * utility biller (ECG / Ghana Water / DSTV / GOtv / StarTimes).
 *
 * Steps: account → verify → amount → confirm → success.
 * The verification card ("Paying for: THOMAS ANANE") is the trust centerpiece:
 * no payment ever proceeds without either a fresh lookup (normal path) or the
 * explicit ECG manual-meter consent (the one sanctioned exception).
 *
 * Idempotency contract: ONE client_reference (crypto.randomUUID) is generated
 * per flow instance (sheet open) and reused VERBATIM on every retry so the
 * server replay guard can dedupe a timed-out create. It is regenerated only
 * when a new flow starts (the sheet opens again).
 */

import { useEffect, useRef, useState, type RefObject } from 'react'
import Link from 'next/link'
import {
    AlertTriangle, ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronRight,
    Copy, Loader2, MessageSquareText, Pencil, Phone, RefreshCw, ShieldCheck, Wallet, X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
    Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle,
} from '@/components/ui/dialog'
import { UTILITY_BILLERS, type UtilityBiller } from '@/lib/hubtel-utility/billers'
import { BILLER_UI } from './biller-ui'
import { UtilityBillerLogo } from '@/components/utility-biller-logo'
import { SavedAccountsGrid } from './SavedAccountsGrid'
import type { UtilityConfig, UtilityLookupInfo, UtilityLookupMeter, UtilitySavedAccount } from './types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Display-normalize a stored phone (233XXXXXXXXX → 0XXXXXXXXX). */
export function toLocalPhone(phone: string | null | undefined): string {
    if (!phone) return ''
    const digits = phone.replace(/\D/g, '')
    if (digits.startsWith('233') && digits.length === 12) return '0' + digits.slice(3)
    return digits.slice(0, 10)
}

const isValidLocalPhone = (p: string) => /^0\d{9}$/.test(p)

const QUICK_AMOUNTS = [10, 20, 50, 100]

type FlowStep = 'account' | 'verify' | 'amount' | 'confirm' | 'success'

interface UtilityFlowSheetProps {
    biller: UtilityBiller | null
    open: boolean
    onClose: () => void
    config: UtilityConfig
    walletBalance: number | null
    /** Logged-in user's own phone (users.phone_number) — prefills ECG/GW. */
    userPhone: string
    /** Full saved-accounts list — filtered down to `biller` internally. Tapping a card
     * in the resulting grid prefills step 1 and auto-runs a fresh lookup, replacing the
     * old page-level "My Accounts" row (see SavedAccountsGrid's header comment). */
    savedAccounts: UtilitySavedAccount[]
    /** Called after a successful rename/remove in the saved-accounts grid so the page refetches. */
    onSavedAccountsChanged: () => void
    /** Ref owned by the page so focus can start inside the tap gesture (double rAF). */
    accountInputRef: RefObject<HTMLInputElement>
    /** Fired once a payment is accepted — page refreshes balance/history/saved. */
    onPurchased: (newBalance: number | null) => void
}

interface SuccessData {
    reference: string
    alreadyProcessed: boolean
}

export function UtilityFlowSheet({
    biller, open, onClose, config, walletBalance, userPhone, savedAccounts, onSavedAccountsChanged, accountInputRef, onPurchased,
}: UtilityFlowSheetProps) {
    const def = biller ? UTILITY_BILLERS[biller] : null
    const ui = biller ? BILLER_UI[biller] : null

    const [step, setStep] = useState<FlowStep>('account')
    const [phone, setPhone] = useState('')
    const [account, setAccount] = useState('')

    // ECG manual-meter path
    const [ecgManual, setEcgManual] = useState(false)
    const [ecgConsent, setEcgConsent] = useState(false)

    const [lookupLoading, setLookupLoading] = useState(false)
    const [lookupError, setLookupError] = useState<string | null>(null)
    const [info, setInfo] = useState<UtilityLookupInfo | null>(null)
    const [selectedMeter, setSelectedMeter] = useState<UtilityLookupMeter | null>(null)
    /** Saved account_number to highlight in the ECG meter picker after a My Accounts tap. */
    const [savedMeterHint, setSavedMeterHint] = useState<string | null>(null)

    const [amount, setAmount] = useState('')
    const [submitting, setSubmitting] = useState(false)
    const [submitError, setSubmitError] = useState<string | null>(null)
    const [duplicateError, setDuplicateError] = useState(false)
    const [success, setSuccess] = useState<SuccessData | null>(null)
    const [copied, setCopied] = useState(false)

    // One idempotency key per flow instance — reused verbatim on retries.
    const clientRefRef = useRef<string>('')
    /**
     * Snapshot of the last submission: the ref + the identity tuple it was bound
     * to. If the user edits the payment (biller/account/amount) after a failed
     * or timed-out submit, the replay reference MUST be regenerated — otherwise
     * the server replay guard would return the FIRST order as already_processed
     * for a DIFFERENT bill. An identical tuple reuses the ref verbatim so true
     * retries stay idempotent. Also the source of truth for the success screen
     * (render what was actually charged, never live edited state).
     */
    const lastSubmittedRef = useRef<{ ref: string; biller: UtilityBiller; account: string; amount: number } | null>(null)

    const manualMeterRef = useRef<HTMLInputElement | null>(null)

    // ── Flow-instance reset: runs when the sheet OPENS (new flow = new UUID) ──
    useEffect(() => {
        if (!open || !biller) return
        clientRefRef.current = crypto.randomUUID()
        lastSubmittedRef.current = null
        setStep('account')
        setEcgManual(false)
        setEcgConsent(false)
        setLookupLoading(false)
        setLookupError(null)
        setInfo(null)
        setSelectedMeter(null)
        setSavedMeterHint(null)
        setAmount('')
        setSubmitting(false)
        setSubmitError(null)
        setDuplicateError(false)
        setSuccess(null)
        setCopied(false)

        const phoneDefault = toLocalPhone(userPhone)
        setPhone(phoneDefault)
        setAccount('')
        // Intentionally keyed on open/biller only: userPhone is captured at open time.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, biller])

    /**
     * Applies a saved account tapped from SavedAccountsGrid (step 1) — prefills the
     * form and immediately runs a FRESH lookup, exactly like the old page-level
     * "My Accounts" tap did before opening the sheet. Saved data is a shortcut,
     * never a verification bypass.
     */
    function applySavedAccount(acc: UtilitySavedAccount) {
        const phoneDefault = toLocalPhone(acc.destination_phone || userPhone)
        setPhone(phoneDefault)
        if (biller === 'ecg') {
            setSavedMeterHint(acc.account_number)
            setAccount('')
            if (isValidLocalPhone(phoneDefault)) {
                runLookup({ account: phoneDefault, phone: phoneDefault })
            }
        } else {
            setAccount(acc.account_number)
            runLookup({ account: acc.account_number, phone: phoneDefault })
        }
    }

    // ── Lookup ────────────────────────────────────────────────────────────────
    async function runLookup(params: { account: string; phone: string }) {
        if (!biller) return
        setLookupLoading(true)
        setLookupError(null)
        setInfo(null)
        setSelectedMeter(null)
        try {
            const body: Record<string, string> = { biller, account: params.account }
            if (biller === 'ecg' || biller === 'ghana_water') body.phone = params.phone
            const res = await fetch('/api/utilities/lookup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            })
            const data = await res.json().catch(() => null)
            if (data?.success && data.data) {
                setInfo(data.data as UtilityLookupInfo)
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
        if (!def) return
        if (biller === 'ecg') {
            if (!isValidLocalPhone(phone)) return
            runLookup({ account: phone, phone })
        } else if (biller === 'ghana_water') {
            if (!account.trim() || !isValidLocalPhone(phone)) return
            runLookup({ account: account.trim(), phone })
        } else {
            if (!account.trim()) return
            runLookup({ account: account.trim(), phone: '' })
        }
    }

    // ── Derived values ───────────────────────────────────────────────────────
    const { minAmount, maxAmount } = config
    const parsedAmount = parseFloat(amount) || 0
    const amountValid = parsedAmount >= minAmount && parsedAmount <= maxAmount
    const hasEnoughBalance = walletBalance !== null && parsedAmount > 0 && walletBalance >= parsedAmount
    const balanceAfter = walletBalance !== null ? walletBalance - parsedAmount : null

    const isEcgManualPath = biller === 'ecg' && ecgManual && !selectedMeter
    const consentSatisfied = !isEcgManualPath || ecgConsent

    /** The verified display name for the account being paid (null on ECG manual path). */
    const verifiedName = biller === 'ecg'
        ? (selectedMeter?.name ?? null)
        : (info?.accountName ?? null)

    /** The account number the payment targets. */
    const payAccount = biller === 'ecg'
        ? (selectedMeter?.meterNumber ?? account.trim())
        : (info?.accountNumber || account.trim())

    /** Positive amount due (ECG = meter outstanding), used for amount prefill. */
    const amountDue = biller === 'ecg'
        ? (selectedMeter && selectedMeter.outstanding > 0 ? selectedMeter.outstanding : null)
        : (info && typeof info.amountDue === 'number' && info.amountDue > 0 ? info.amountDue : null)

    const goToAmount = (prefillDue: number | null) => {
        if (prefillDue && prefillDue > 0) {
            setAmount(String(Math.min(prefillDue, maxAmount).toFixed(2)))
        }
        setStep('amount')
    }

    // ── Create (Pay) ─────────────────────────────────────────────────────────
    const handlePay = async () => {
        if (!biller || !def || submitting) return
        if (!amountValid || !hasEnoughBalance || !consentSatisfied) return

        // Bind the replay reference to THIS submission's identity tuple: if the
        // details changed since the last submit (e.g. failed submit → user went
        // back and edited account/amount), mint a fresh reference so the server
        // can never replay the earlier order for the edited bill. Same tuple =
        // same reference (a genuine retry stays idempotent).
        const prev = lastSubmittedRef.current
        if (prev && (prev.biller !== biller || prev.account !== payAccount || prev.amount !== parsedAmount)) {
            clientRefRef.current = crypto.randomUUID()
        }
        lastSubmittedRef.current = { ref: clientRefRef.current, biller, account: payAccount, amount: parsedAmount }

        setSubmitting(true)
        setSubmitError(null)
        setDuplicateError(false)
        try {
            const body: Record<string, unknown> = {
                biller,
                account: payAccount,
                amount: parsedAmount,
                client_reference: clientRefRef.current, // reused verbatim on retry
            }
            if (biller === 'ecg' || biller === 'ghana_water') body.phone = phone
            if (verifiedName) body.accountName = verifiedName
            if (info && !isEcgManualPath) body.lookupSnapshot = info

            const res = await fetch('/api/utilities/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            })
            const data = await res.json().catch(() => null)

            if (data?.success && data.data) {
                setSuccess({
                    reference: data.data.reference,
                    alreadyProcessed: data.data.already_processed === true,
                })
                setStep('success')
                onPurchased(typeof data.data.new_balance === 'number' ? data.data.new_balance : null)
                return
            }
            if (res.status === 409 && data?.isDuplicate) {
                setDuplicateError(true)
                return
            }
            setSubmitError(data?.error || 'Payment could not be processed — please try again.')
        } catch {
            setSubmitError('Connection problem — your money is safe. Tap Pay again to retry.')
        } finally {
            setSubmitting(false)
        }
    }

    const copyReference = () => {
        if (!success) return
        navigator.clipboard.writeText(success.reference)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }

    if (!biller || !def || !ui) return null

    // What was ACTUALLY charged — the success screen renders this snapshot, not
    // live state (which the user may have edited after a replayed submission).
    const submitted = lastSubmittedRef.current

    const billerSavedAccounts = savedAccounts.filter((a) => a.biller === biller)

    // ─────────────────────────────────────────────────────────────────────────
    return (
        <Dialog open={open} onOpenChange={(o) => { if (!o && !submitting) onClose() }}>
            <DialogContent
                hideCloseButton
                className="!fixed !left-0 !right-0 !bottom-0 !top-auto !translate-x-0 !translate-y-0 w-full max-w-full rounded-t-[2rem] rounded-b-none p-0 gap-0 shadow-2xl border-x-0 border-b-0 max-h-[92dvh] overflow-y-auto overscroll-contain"
                aria-describedby={undefined}
                onOpenAutoFocus={(e) => e.preventDefault()}
                onInteractOutside={(e) => { if (submitting) e.preventDefault() }}
            >
                <DialogDescription className="sr-only">Pay a {def.label} bill</DialogDescription>

                {/* Drag handle + close */}
                <div className="relative flex items-center justify-center pt-3 pb-1">
                    <div className="w-9 h-1 rounded-full bg-gray-200 dark:bg-zinc-700" />
                    <DialogClose
                        disabled={submitting}
                        className="absolute right-3 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-muted flex items-center justify-center text-muted-foreground hover:bg-muted/80 active:scale-95 transition-all disabled:pointer-events-none disabled:opacity-40"
                    >
                        <X className="w-4 h-4" />
                        <span className="sr-only">Close</span>
                    </DialogClose>
                </div>

                {/* Biller header */}
                <div className="flex items-center gap-3 px-5 pt-1 pb-3">
                    <UtilityBillerLogo biller={biller} FallbackIcon={ui.Icon} badgeClassName={ui.badge} size={40} />
                    <div className="min-w-0">
                        <DialogTitle className="text-base font-bold leading-tight truncate">{def.label}</DialogTitle>
                        <p className="text-xs text-muted-foreground truncate">
                            {step === 'success' ? 'Payment received' : `Pay with your wallet · GHS ${minAmount.toFixed(0)}–${maxAmount.toFixed(0)}`}
                        </p>
                    </div>
                </div>

                <div className="px-5 pb-[calc(env(safe-area-inset-bottom,0px)+2rem)] space-y-4">

                    {/* ══ STEP 1 — ACCOUNT ══════════════════════════════════════════ */}
                    {step === 'account' && (
                        <div className="space-y-4 animate-in fade-in duration-200">
                            {/* Saved accounts for THIS biller — hidden entirely when empty */}
                            {billerSavedAccounts.length > 0 && (
                                <div className="space-y-2">
                                    <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
                                        Saved accounts
                                    </p>
                                    <SavedAccountsGrid
                                        accounts={billerSavedAccounts}
                                        onPay={applySavedAccount}
                                        onChanged={onSavedAccountsChanged}
                                    />
                                    <p className="text-xs text-muted-foreground pt-1">Or add a new account below</p>
                                </div>
                            )}

                            {/* ECG: phone-first "find my meters" */}
                            {biller === 'ecg' ? (
                                <>
                                    <div className="space-y-1.5">
                                        <Label htmlFor="util-phone" className="text-sm font-medium">ECG phone number</Label>
                                        <div className="relative">
                                            <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                                            <Input
                                                ref={accountInputRef}
                                                id="util-phone"
                                                type="tel"
                                                inputMode="numeric"
                                                placeholder="0XXXXXXXXX"
                                                maxLength={10}
                                                value={phone}
                                                onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
                                                className="pl-9 rounded-xl h-11 font-mono"
                                            />
                                        </div>
                                        <p className="text-xs text-muted-foreground">We list the meters registered to this phone.</p>
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

                                    {/* Manual meter entry — the consent-gated exception */}
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
                                                <Label htmlFor="util-manual-meter" className="text-sm font-medium">Meter number</Label>
                                                <Input
                                                    ref={manualMeterRef}
                                                    id="util-manual-meter"
                                                    type="text"
                                                    inputMode="numeric"
                                                    placeholder="Meter number"
                                                    maxLength={30}
                                                    value={account}
                                                    onChange={(e) => setAccount(e.target.value)}
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
                                                        ecgConsent
                                                            ? 'bg-amber-500 border-amber-500 text-white'
                                                            : 'border-slate-300 dark:border-slate-600'
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
                                        <Label htmlFor="util-account" className="text-sm font-medium">{def.accountLabel}</Label>
                                        <Input
                                            ref={accountInputRef}
                                            id="util-account"
                                            type="text"
                                            inputMode="numeric"
                                            placeholder={def.accountLabel}
                                            maxLength={30}
                                            value={account}
                                            onChange={(e) => setAccount(e.target.value)}
                                            className="rounded-xl h-11 font-mono"
                                        />
                                    </div>

                                    {biller === 'ghana_water' && (
                                        <div className="space-y-1.5">
                                            <Label htmlFor="util-phone" className="text-sm font-medium">Phone number</Label>
                                            <div className="relative">
                                                <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                                                <Input
                                                    id="util-phone"
                                                    type="tel"
                                                    inputMode="numeric"
                                                    placeholder="0XXXXXXXXX"
                                                    maxLength={10}
                                                    value={phone}
                                                    onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
                                                    className="pl-9 rounded-xl h-11 font-mono"
                                                />
                                            </div>
                                            <p className="text-xs text-muted-foreground">Ghana Water needs your phone to verify the meter.</p>
                                        </div>
                                    )}

                                    <Button
                                        className="w-full h-11 rounded-xl font-semibold"
                                        disabled={
                                            lookupLoading ||
                                            !account.trim() ||
                                            (biller === 'ghana_water' && !isValidLocalPhone(phone))
                                        }
                                        onClick={handleLookupClick}
                                    >
                                        {lookupLoading
                                            ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Verifying…</>
                                            : <>Verify account <ArrowRight className="w-4 h-4 ml-1.5" /></>}
                                    </Button>
                                </>
                            )}

                            {/* Lookup failure — inline, retry, never proceed unverified */}
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

                    {/* ══ STEP 2 — VERIFY (the trust centerpiece) ═══════════════════ */}
                    {step === 'verify' && info && (
                        <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
                            {biller === 'ecg' ? (
                                /* ECG: meter picker */
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
                                            {info.meters.map((m) => {
                                                const isSaved = savedMeterHint !== null && m.meterNumber === savedMeterHint
                                                return (
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
                                                        className={cn(
                                                            'flex flex-col items-start gap-2 rounded-xl border p-3 text-left transition-colors',
                                                            isSaved
                                                                ? 'border-amber-400/70 bg-amber-50/60 dark:bg-amber-950/20 dark:border-amber-700'
                                                                : 'border-border bg-card hover:border-slate-300 dark:hover:border-slate-600'
                                                        )}
                                                    >
                                                        <div className="flex items-center gap-1.5 w-full">
                                                            <UtilityBillerLogo biller={biller} FallbackIcon={ui.Icon} badgeClassName={ui.badge} size={28} rounded="lg" />
                                                            {isSaved && <span className="text-[9px] font-semibold text-amber-600 dark:text-amber-400 ml-auto shrink-0">Saved</span>}
                                                        </div>
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
                                                )
                                            })}
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
                                /* Non-ECG: verification hero card */
                                <>
                                    <div className={cn(
                                        'rounded-2xl border border-border bg-card p-4 shadow-sm ring-1',
                                        ui.ring
                                    )}>
                                        <div className="flex items-center gap-2 mb-3">
                                            <div className={cn('w-8 h-8 rounded-full flex items-center justify-center shrink-0', ui.badge)}>
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

                                    <Button
                                        className="w-full h-11 rounded-xl font-semibold"
                                        onClick={() => goToAmount(amountDue)}
                                    >
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

                    {/* ══ STEP 3 — AMOUNT ═══════════════════════════════════════════ */}
                    {step === 'amount' && (
                        <div className="space-y-4 animate-in fade-in duration-200">
                            {/* Compact verified summary / manual notice */}
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
                                <Label htmlFor="util-amount" className="text-sm font-medium flex items-center gap-2 flex-wrap">
                                    Amount (GHS)
                                    <span className="text-xs font-normal text-muted-foreground">Min {minAmount} · Max {maxAmount}</span>
                                </Label>
                                <div className="relative">
                                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">GHS</span>
                                    <Input
                                        id="util-amount"
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

                            {walletBalance !== null && (
                                <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
                                    <span className="flex items-center gap-1.5">
                                        <Wallet className="w-3.5 h-3.5" /> Wallet: <span className="font-semibold text-foreground tabular-nums">GHS {walletBalance.toFixed(2)}</span>
                                    </span>
                                    {parsedAmount > 0 && hasEnoughBalance && balanceAfter !== null && (
                                        <span>
                                            Balance after payment: <span className="font-semibold text-green-600 dark:text-green-400 tabular-nums">GHS {balanceAfter.toFixed(2)}</span>
                                        </span>
                                    )}
                                </div>
                            )}

                            {parsedAmount > 0 && amountValid && !hasEnoughBalance && walletBalance !== null ? (
                                <div className="space-y-2.5">
                                    <div className="rounded-xl bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 p-3.5 flex items-start gap-2.5">
                                        <AlertTriangle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                                        <p className="text-sm text-red-700 dark:text-red-400">
                                            Insufficient balance — you need GHS {parsedAmount.toFixed(2)} but have GHS {walletBalance.toFixed(2)}.
                                        </p>
                                    </div>
                                    <Link href="/dashboard/wallet" className="block w-full" onClick={onClose}>
                                        <Button className="w-full h-11 rounded-xl font-semibold">
                                            Top up wallet <ArrowRight className="w-4 h-4 ml-1.5" />
                                        </Button>
                                    </Link>
                                </div>
                            ) : (
                                <Button
                                    className="w-full h-11 rounded-xl font-semibold"
                                    disabled={!amountValid || !hasEnoughBalance}
                                    onClick={() => setStep('confirm')}
                                >
                                    Review payment <ArrowRight className="w-4 h-4 ml-1.5" />
                                </Button>
                            )}

                            <button
                                type="button"
                                onClick={() => setStep(isEcgManualPath ? 'account' : 'verify')}
                                className="w-full text-sm text-muted-foreground hover:text-foreground text-center inline-flex items-center justify-center gap-1.5"
                            >
                                <ArrowLeft className="w-3.5 h-3.5" /> Back
                            </button>
                        </div>
                    )}

                    {/* ══ STEP 4 — CONFIRM ══════════════════════════════════════════ */}
                    {step === 'confirm' && (
                        <div className="space-y-4 animate-in fade-in duration-200">
                            <div className="rounded-xl border border-border overflow-hidden">
                                <div className="px-4 py-2.5 border-b border-border bg-muted/40">
                                    <p className="text-sm font-medium">Confirm payment</p>
                                </div>
                                <div className="p-4 space-y-2.5 text-sm">
                                    <div className="flex justify-between gap-3"><span className="text-muted-foreground">Biller</span><span className="font-medium truncate">{def.label}</span></div>
                                    <div className="flex justify-between gap-3">
                                        <span className="text-muted-foreground">Paying for</span>
                                        <span className={cn('font-semibold truncate', verifiedName ? '' : 'text-amber-600 dark:text-amber-400')}>
                                            {verifiedName || 'Unverified meter'}
                                        </span>
                                    </div>
                                    <div className="flex justify-between gap-3"><span className="text-muted-foreground">{def.accountLabel}</span><span className="font-mono font-medium truncate">{payAccount}</span></div>
                                    {(biller === 'ecg' || biller === 'ghana_water') && (
                                        <div className="flex justify-between gap-3"><span className="text-muted-foreground">Phone</span><span className="font-mono font-medium">{phone}</span></div>
                                    )}
                                    <div className="flex justify-between gap-3"><span className="text-muted-foreground">Amount</span><span className="font-semibold tabular-nums">GHS {parsedAmount.toFixed(2)}</span></div>
                                    {walletBalance !== null && (
                                        <div className="flex justify-between gap-3 border-t border-border pt-2.5 mt-1">
                                            <span className="text-muted-foreground">Wallet after payment</span>
                                            <span className="font-semibold tabular-nums">GHS {(walletBalance - parsedAmount).toFixed(2)}</span>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {isEcgManualPath && (
                                <p className="text-xs text-amber-600 dark:text-amber-400 flex items-start gap-1.5">
                                    <Check className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                                    You agreed: ECG will link meter {account.trim()} to {phone}.
                                </p>
                            )}

                            {duplicateError && (
                                <div className="rounded-xl bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900 p-3.5 flex items-start gap-2.5">
                                    <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                                    <p className="text-sm text-amber-700 dark:text-amber-400">
                                        You just paid this bill — check Recent Payments before paying again.
                                    </p>
                                </div>
                            )}
                            {submitError && (
                                <div className="rounded-xl bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 p-3.5 flex items-start gap-2.5">
                                    <AlertTriangle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                                    <p className="text-sm text-red-700 dark:text-red-400">{submitError}</p>
                                </div>
                            )}

                            <Button
                                className="w-full h-12 rounded-xl font-semibold text-sm"
                                disabled={submitting || !amountValid || !hasEnoughBalance || !consentSatisfied}
                                onClick={handlePay}
                            >
                                {submitting
                                    ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Processing…</>
                                    : <>Pay GHS {parsedAmount.toFixed(2)}</>}
                            </Button>

                            <button
                                type="button"
                                disabled={submitting}
                                onClick={() => setStep('amount')}
                                className="w-full text-sm text-muted-foreground hover:text-foreground text-center inline-flex items-center justify-center gap-1.5 disabled:opacity-40"
                            >
                                <ArrowLeft className="w-3.5 h-3.5" /> Change amount
                            </button>
                        </div>
                    )}

                    {/* ══ STEP 5 — SUCCESS ══════════════════════════════════════════ */}
                    {step === 'success' && success && (
                        <div className="space-y-4 animate-in fade-in zoom-in-95 duration-300">
                            <div className="flex flex-col items-center gap-2 pt-2">
                                <div className="w-14 h-14 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                                    <CheckCircle2 className="w-7 h-7 text-green-600" />
                                </div>
                                <p className="text-lg font-bold">
                                    {success.alreadyProcessed ? 'Already paid' : 'Payment received'}
                                </p>
                                <p className="text-xs text-muted-foreground text-center">
                                    Processing — usually under a minute. Track it in Recent Payments.
                                </p>
                            </div>

                            <div className="rounded-xl border border-border p-3.5 space-y-2.5 text-sm">
                                <div className="flex justify-between gap-3"><span className="text-muted-foreground">Biller</span><span className="font-medium truncate">{def.label}</span></div>
                                {verifiedName && (
                                    <div className="flex justify-between gap-3"><span className="text-muted-foreground">Paying for</span><span className="font-semibold truncate">{verifiedName}</span></div>
                                )}
                                <div className="flex justify-between gap-3"><span className="text-muted-foreground">{def.accountLabel}</span><span className="font-mono font-medium truncate">{submitted?.account ?? payAccount}</span></div>
                                <div className="flex justify-between gap-3"><span className="text-muted-foreground">Amount</span><span className="font-semibold tabular-nums">GHS {(submitted?.amount ?? parsedAmount).toFixed(2)}</span></div>
                            </div>

                            <button
                                type="button"
                                onClick={copyReference}
                                className="w-full flex items-center justify-between gap-3 border border-border hover:bg-muted/50 rounded-xl px-3.5 py-2.5 transition-colors group min-w-0"
                            >
                                <div className="text-left min-w-0">
                                    <p className="text-xs text-muted-foreground">Reference code</p>
                                    <p className="font-mono font-medium text-sm truncate">{success.reference}</p>
                                </div>
                                <Copy className={cn('w-4 h-4 shrink-0 transition-colors', copied ? 'text-green-500' : 'text-muted-foreground group-hover:text-foreground')} />
                            </button>

                            {biller === 'ecg' && (
                                <p className="text-xs text-muted-foreground flex items-start gap-1.5">
                                    <MessageSquareText className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                                    Your token will arrive by SMS from ECG.
                                </p>
                            )}

                            <Button className="w-full h-11 rounded-xl font-semibold" onClick={onClose}>
                                Done
                            </Button>
                        </div>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    )
}
