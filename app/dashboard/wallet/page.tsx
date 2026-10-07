'use client'

import { useEffect, useState, useCallback, useRef, Suspense } from 'react'
import { useAuth } from '@/contexts/auth-context'

import { supabase } from '@/lib/supabase'
import { formatCurrency, formatDate, calculatePaystackFee } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
    Wallet,
    Plus,
    ArrowDownLeft,
    Smartphone,
    Loader2,
    TrendingUp,
    TrendingDown,
    AlertTriangle,
    Copy,
    Check,
    CheckCircle2,
    Zap,
    AlertCircle,
} from 'lucide-react'
import { toast } from '@/lib/toast'
import { WalletTransaction } from '@/types/supabase'


const QUICK_AMOUNTS = [50, 100, 200, 500]
// Background poll never gives up; after PATIENT_POLLS cycles (~1 min) the copy
// switches to a reassuring "tap I've paid / you'll be credited automatically".
const PATIENT_POLLS = 6

// Wrap fetch with an abort-based timeout so a dead socket surfaces an error
// instead of hanging the (non-dismissible) payment modal forever on a transient
// 'charging'/'verifying' state. On timeout the promise rejects with a friendly
// message; the existing catch blocks turn that into a "Try Again" / keep-waiting.
async function fetchWithTimeout(input: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        return await fetch(input, { ...init, signal: controller.signal })
    } catch (err) {
        if (controller.signal.aborted) {
            throw new Error('Request timed out. Please check your connection and try again.')
        }
        throw err
    } finally {
        clearTimeout(timer)
    }
}

const GHANA_NETWORK_MAP: Record<string, string> = {
    '024': 'MTN', '025': 'MTN', '053': 'MTN', '054': 'MTN', '055': 'MTN', '059': 'MTN',
    '020': 'VOD', '050': 'VOD',
    '026': 'ATL', '027': 'ATL', '056': 'ATL', '057': 'ATL',
}

// ── Network badge styling ──────────────────────────────────────
const NETWORK_BADGE: Record<string, { bg: string; text: string; border: string; label: string }> = {
    'MTN Mobile Money': { bg: 'bg-yellow-400', text: 'text-yellow-950', border: 'border-yellow-500', label: 'MTN' },
    'MTN': { bg: 'bg-yellow-400', text: 'text-yellow-950', border: 'border-yellow-500', label: 'MTN' },
    'Telecel Cash': { bg: 'bg-red-600', text: 'text-white', border: 'border-red-700', label: 'Telecel' },
    'Telecel': { bg: 'bg-red-600', text: 'text-white', border: 'border-red-700', label: 'Telecel' },
    'AirtelTigo Money': { bg: 'bg-blue-600', text: 'text-white', border: 'border-blue-700', label: 'AirtelTigo' },
    'AirtelTigo': { bg: 'bg-blue-600', text: 'text-white', border: 'border-blue-700', label: 'AirtelTigo' },
    'Unknown': { bg: 'bg-gray-400', text: 'text-white', border: 'border-gray-500', label: 'Unknown' },
}

interface MomoPaymentAccount { network: string; number: string }
interface ClaimSuccessData {
    amount: number
    fee_percent: number
    fee_amount: number
    net_amount: number
    new_balance: number
    transaction_id: string
}

function WalletContent() {
    const { dbUser, isAdmin } = useAuth()
    const [walletBalance, setWalletBalance] = useState(0)
    const [totalCredited, setTotalCredited] = useState(0)
    const [totalDebited, setTotalDebited] = useState(0)
    const [transactions, setTransactions] = useState<WalletTransaction[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [paystackFeePercent, setPaystackFeePercent] = useState(1.95)
    const [minTopup, setMinTopup] = useState(5)
    const [maxTopup, setMaxTopup] = useState(5000)

    // ── MoMo Claim state ──────────────────────────────────────
    const [momoEnabled, setMomoEnabled] = useState(true)
    const [momoAccounts, setMomoAccounts] = useState<MomoPaymentAccount[]>([])
    const [momoAccountName, setMomoAccountName] = useState('Felix Boahen')
    const [momoMinClaimable, setMomoMinClaimable] = useState(1)
    const [momoMaxClaimable, setMomoMaxClaimable] = useState(50000)
    const [txnIdInput, setTxnIdInput] = useState('')
    const [claimStep, setClaimStep] = useState<'input' | 'claiming'>('input')
    // ── Reference Code state ──────────────────────────────────
    const [userRef, setUserRef] = useState<{ code: string; is_active: boolean } | null>(null)
    const [refLoading, setRefLoading] = useState(true)
    const [refGenerating, setRefGenerating] = useState(false)
    const [refCopied, setRefCopied] = useState(false)
    const [isSuccessModalOpen, setIsSuccessModalOpen] = useState(false)
    const [successClaimData, setSuccessClaimData] = useState<ClaimSuccessData | null>(null)
    // Frontend rate limiting: 3 attempts per 30s
    const [claimAttempts, setClaimAttempts] = useState(0)
    const [claimCooldownUntil, setClaimCooldownUntil] = useState(0)
    const [cooldownSeconds, setCooldownSeconds] = useState(0)
    // Copied state per account
    const [copiedIndex, setCopiedIndex] = useState<number | null>(null)
    // Concurrency guard for claim button (VULN-06 fix)
    const claimInFlight = useRef(false)

    // ── Top Up (Charge API) state ─────────────────────────────
    const [topUpAmount, setTopUpAmount] = useState('')
    const [momoPhone, setMomoPhone] = useState('')
    const [selectedNetwork, setSelectedNetwork] = useState('')
    const [autoDetected, setAutoDetected] = useState(false)
    const [chargeStep, setChargeStep] = useState<'idle' | 'charging' | 'otp_required' | 'pending' | 'verifying' | 'failed'>('idle')
    const [chargeReference, setChargeReference] = useState('')
    const [chargeDisplayText, setChargeDisplayText] = useState('')
    const [otpValue, setOtpValue] = useState('')
    const [pollCount, setPollCount] = useState(0)
    const [checkingPaid, setCheckingPaid] = useState(false)
    const checkingPaidRef = useRef(false)
    const pollTimerRef = useRef<NodeJS.Timeout | null>(null)

    const fee = topUpAmount ? calculatePaystackFee(parseFloat(topUpAmount) || 0, paystackFeePercent) : 0
    const totalAmount = topUpAmount ? (parseFloat(topUpAmount) || 0) + fee : 0

    // ── Network auto-detection ────────────────────────────────
    useEffect(() => {
        if (momoPhone.length >= 3) {
            const found = GHANA_NETWORK_MAP[momoPhone.slice(0, 3)]
            if (found) {
                setSelectedNetwork(found)
                setAutoDetected(true)
            } else {
                setAutoDetected(false)
                // Don't clear a manual pick when user keeps typing
            }
        } else {
            setAutoDetected(false)
        }
    }, [momoPhone])

    // ── Poll timer cleanup ────────────────────────────────────
    useEffect(() => {
        return () => { if (pollTimerRef.current) clearTimeout(pollTimerRef.current) }
    }, [])

    // ── Cooldown timer ────────────────────────────────────────
    useEffect(() => {
        if (claimCooldownUntil <= 0) return
        const interval = setInterval(() => {
            const remaining = Math.ceil((claimCooldownUntil - Date.now()) / 1000)
            if (remaining <= 0) {
                setCooldownSeconds(0)
                setClaimCooldownUntil(0)
                setClaimAttempts(0)
                clearInterval(interval)
            } else {
                setCooldownSeconds(remaining)
            }
        }, 500)
        return () => clearInterval(interval)
    }, [claimCooldownUntil])

    useEffect(() => {
        if (dbUser) {
            fetchWalletData()
            fetchUserReference()
        }
    }, [dbUser])

    const fetchWalletData = useCallback(async () => {
        try {
            const [walletRes, txnsRes, momoSettingsRes] = await Promise.all([
                // Fetch wallet
                supabase
                    .from('wallets')
                    .select('*')
                    .eq('user_id', dbUser?.id as any)
                    .single(),

                // Fetch top-up transactions
                supabase
                    .from('wallet_transactions')
                    .select('*')
                    .eq('user_id', dbUser?.id as any)
                    .eq('type', 'credit')
                    .order('created_at', { ascending: false })
                    .limit(20),

                // Fetch MoMo display settings via server API (bypasses RLS safely)
                fetch('/api/wallet/claim-momo?settings_only=true', { credentials: 'include' })
                    .then(r => r.json())
                    .catch(() => null),
            ])

            const wallet = walletRes.data
            const txns = txnsRes.data

            if (wallet) {
                setWalletBalance((wallet as any).balance)
                setTotalCredited((wallet as any).total_credited)
                setTotalDebited((wallet as any).total_spent)
            }
            setTransactions(txns || [])

            // Parse MoMo settings from server API response
            if (momoSettingsRes && !momoSettingsRes.error) {
                setMomoEnabled(momoSettingsRes.momo_enabled !== false)
                setMomoAccounts(momoSettingsRes.momo_accounts || [])
                setMomoAccountName(momoSettingsRes.momo_account_name || '')
                setMomoMinClaimable(momoSettingsRes.momo_min_claimable || 1)
                setMomoMaxClaimable(momoSettingsRes.momo_max_claimable || 50000)
                if (momoSettingsRes.paystack_fee_percent !== undefined) {
                    setPaystackFeePercent(momoSettingsRes.paystack_fee_percent)
                }
                if (momoSettingsRes.paystack_min_topup !== undefined) {
                    setMinTopup(Number(momoSettingsRes.paystack_min_topup) || 5)
                }
                if (momoSettingsRes.paystack_max_topup !== undefined) {
                    setMaxTopup(Number(momoSettingsRes.paystack_max_topup) || 5000)
                }
            }

        } catch (error) {
            console.error('Error fetching wallet data:', error)
        } finally {
            setIsLoading(false)
        }
    }, [dbUser])

    // ── Global Refresh Listener ──────────────────────────────
    useEffect(() => {
        const handleRefresh = () => {
            fetchWalletData()
        }
        window.addEventListener('app-refresh', handleRefresh)
        return () => window.removeEventListener('app-refresh', handleRefresh)
    }, [dbUser])

    // ── Fetch user reference code ────────────────────────────
    const fetchUserReference = async () => {
        setRefLoading(true)
        try {
            const res = await fetch('/api/wallet/reference', { credentials: 'include' })
            const data = await res.json()
            if (res.ok && data.reference) {
                setUserRef(data.reference)
            } else {
                setUserRef(null)
            }
        } catch {
            setUserRef(null)
        } finally {
            setRefLoading(false)
        }
    }

    // ── Generate reference code ───────────────────────────────
    const handleGenerateRef = async () => {
        if (refGenerating) return
        setRefGenerating(true)

        try {
            const res = await fetch('/api/wallet/reference', { method: 'POST', credentials: 'include' })
            const data = await res.json()
            if (res.ok && data.reference) {
                setUserRef(data.reference)
                toast.success('Payment reference generated! Use it when sending payment.')
            } else {
                toast.error(data.error || 'Failed to generate reference. Try again.')
            }
        } catch {
            toast.error('Network error. Please try again.')
        } finally {
            setRefGenerating(false)
        }
    }

    // ── 1-Click Direct Claim (POST-only — VULN-01 fix) ────
    const handleDirectClaim = async () => {
        // VULN-06: Concurrency guard prevents rapid double-fires
        if (claimInFlight.current) return
        claimInFlight.current = true

        const digits = txnIdInput.replace(/\D/g, '')
        if (digits.length < 8) {
            toast.error('Transaction ID must be at least 8 digits')
            claimInFlight.current = false
            return
        }

        // Frontend rate limiting: 3 per 30s (UX polish only — backend is the real enforcer)
        const now = Date.now()
        if (claimCooldownUntil > now) {
            toast.error(`Too many attempts. Please wait ${cooldownSeconds}s`)
            claimInFlight.current = false
            return
        }
        const newAttempts = claimAttempts + 1
        setClaimAttempts(newAttempts)
        if (newAttempts >= 3) {
            const until = now + 30_000
            setClaimCooldownUntil(until)
            setCooldownSeconds(30)
        }

        setClaimStep('claiming')
        try {
            // Single POST request — all validation happens atomically server-side
            const res = await fetch('/api/wallet/claim-momo', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ transaction_id: digits }),
            })
            const data = await res.json()

            if (!res.ok) {
                if (data.error === 'already_claimed') {
                    toast.info(data.is_own_claim
                        ? 'You have already claimed this transaction.'
                        : 'This transaction has already been claimed by another user.'
                    )
                } else {
                    toast.error(data.error || 'Claim failed. Please try again.')
                }
                setClaimStep('input')
                return
            }

            // Success — all data sourced from the atomic POST response
            setSuccessClaimData({
                amount: data.amount,
                fee_percent: data.fee_percent,
                fee_amount: data.fee_amount,
                net_amount: data.net_amount,
                new_balance: data.new_balance,
                transaction_id: data.transaction_id
            })
            setWalletBalance(data.new_balance)
            setIsSuccessModalOpen(true)
            toast.success(`GHS ${data.net_amount.toFixed(2)} credited to your wallet!`)

            // Refresh & reset
            fetchWalletData()
            setTxnIdInput('')
            setClaimStep('input')
            setClaimAttempts(0)

        } catch (e: any) {
            toast.error('Network error. Please try again.')
            setClaimStep('input')
        } finally {
            claimInFlight.current = false
        }
    }

    // ── Stop the background poll loop (idempotent) ────────────────────────
    const stopPolling = useCallback(() => {
        if (pollTimerRef.current) { clearTimeout(pollTimerRef.current); pollTimerRef.current = null }
    }, [])

    // ── Reset to a clean success state ────────────────────────────────────
    const handlePaidSuccess = useCallback(() => {
        stopPolling()
        toast.success('Wallet topped up successfully!')
        fetchWalletData()
        setTopUpAmount('')
        setMomoPhone('')
        setSelectedNetwork('')
        setAutoDetected(false)
        setChargeStep('idle')
        setChargeReference('')
        setOtpValue('')
    }, [stopPolling, fetchWalletData])

    // ── Single authoritative status check ─────────────────────────────────
    // Hits the DB-authoritative check-pending endpoint. Returns the outcome;
    // a network/parse hiccup is treated as 'pending' (keep waiting), never a
    // failure.
    const checkChargeStatus = useCallback(async (ref: string): Promise<'paid' | 'pending' | 'terminal'> => {
        try {
            const res = await fetchWithTimeout(`/api/payments/charge/check-pending?reference=${encodeURIComponent(ref)}`, {
                credentials: 'include',
                headers: { 'Accept': 'application/json' },
            }, 20_000)
            const data = await res.json()
            if (data.paid) return 'paid'
            if (data.terminal) return 'terminal'
            return 'pending'
        } catch {
            return 'pending'
        }
    }, [])

    // ── Background poll — de-fanged: never fails on pending/timeout ────────
    const startPolling = useCallback((ref: string) => {
        setPollCount(0)
        const poll = async (count: number) => {
            const outcome = await checkChargeStatus(ref)
            if (outcome === 'paid') { handlePaidSuccess(); return }
            if (outcome === 'terminal') {
                stopPolling()
                toast.error('Payment was declined. Please try again.')
                setChargeStep('failed')
                return
            }
            // pending — keep waiting indefinitely, with back-off. Never fail.
            setPollCount(count + 1)
            const delay = count < PATIENT_POLLS ? 10_000 : 20_000
            pollTimerRef.current = setTimeout(() => poll(count + 1), delay)
        }
        pollTimerRef.current = setTimeout(() => poll(0), 10_000)
    }, [checkChargeStatus, handlePaidSuccess, stopPolling])

    // ── Confirm once, then route (used by initial success + OTP success) ──
    const confirmOnce = useCallback(async (ref: string) => {
        setChargeStep('verifying')
        const outcome = await checkChargeStatus(ref)
        if (outcome === 'paid') { handlePaidSuccess(); return }
        if (outcome === 'terminal') {
            stopPolling()
            toast.error('Payment was declined. Please try again.')
            setChargeStep('failed')
            return
        }
        setChargeStep('pending')
        startPolling(ref)
    }, [checkChargeStatus, handlePaidSuccess, startPolling, stopPolling])

    // ── "I've paid" manual check — friendly, stays pending if not yet in ──
    const handleIHavePaid = useCallback(async () => {
        if (!chargeReference || checkingPaidRef.current) return
        checkingPaidRef.current = true
        setCheckingPaid(true)
        const outcome = await checkChargeStatus(chargeReference)
        if (outcome === 'paid') {
            handlePaidSuccess()
        } else if (outcome === 'terminal') {
            stopPolling()
            toast.error('Payment was declined. Please try again.')
            setChargeStep('failed')
        } else {
            toast.info("Not received yet. Approve the prompt on your phone, then tap “I've paid” again.")
        }
        checkingPaidRef.current = false
        setCheckingPaid(false)
    }, [chargeReference, checkChargeStatus, handlePaidSuccess, stopPolling])

    // ── Initiate MoMo charge ──────────────────────────────────
    const handleCharge = async () => {
        const amount = parseFloat(topUpAmount)
        if (isNaN(amount) || amount < minTopup) {
            toast.error(`Minimum amount is ${formatCurrency(minTopup)}`); return
        }
        if (amount > maxTopup) {
            toast.error(`Maximum amount is ${formatCurrency(maxTopup)}`); return
        }
        if (!momoPhone || !/^0[0-9]{9}$/.test(momoPhone)) {
            toast.error('Enter a valid Ghana mobile number (e.g. 0241234567)'); return
        }
        if (!selectedNetwork) {
            toast.error('Select your mobile network'); return
        }

        setChargeStep('charging')
        try {
            const res = await fetchWithTimeout('/api/payments/charge', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ amount, phone: momoPhone, provider: selectedNetwork }),
            }, 30_000)
            const data = await res.json()
            if (!res.ok) {
                if (data.needsManualSelection) {
                    setSelectedNetwork('')
                    setAutoDetected(false)
                    setChargeStep('idle')
                    toast.error('Could not detect your network. Please select it manually.')
                    return
                }
                throw new Error(data.error || 'Failed to initiate payment')
            }
            setChargeReference(data.reference)
            setChargeDisplayText(data.display_text || '')

            if (data.status === 'send_otp' || data.status === 'send_birthday') {
                setChargeStep('otp_required')
            } else if (data.status === 'success') {
                await confirmOnce(data.reference)
            } else if (data.status === 'failed' || data.status === 'timeout') {
                throw new Error(data.display_text || 'Payment could not be processed')
            } else {
                // 'pending' or any undocumented status Paystack may return —
                // the mobile prompt has already been sent server-side, so treat as pending
                setChargeStep('pending')
                startPolling(data.reference)
            }
        } catch (err: any) {
            toast.error(err.message || 'Payment failed')
            setChargeStep('failed')
        }
    }

    // ── Submit OTP for MoMo charge ────────────────────────────
    const handleSubmitOtp = async () => {
        if (!otpValue.trim()) { toast.error('Enter the OTP'); return }
        setChargeStep('charging')
        try {
            const res = await fetchWithTimeout('/api/payments/charge/submit-otp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ reference: chargeReference, otp: otpValue }),
            }, 30_000)
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || 'OTP submission failed')
            setChargeDisplayText(data.display_text || '')

            if (data.status === 'success') {
                await confirmOnce(chargeReference)
            } else if (data.status === 'send_otp' || data.status === 'send_birthday') {
                setOtpValue('')
                setChargeStep('otp_required')
                toast.info(data.display_text || 'Please re-enter OTP')
            } else if (data.status === 'failed' || data.status === 'timeout') {
                throw new Error(data.display_text || 'Payment failed')
            } else {
                // 'pending' or any undocumented status — mobile prompt already sent
                setChargeStep('pending')
                startPolling(chargeReference)
            }
        } catch (err: any) {
            toast.error(err.message || 'OTP submission failed')
            setChargeStep('failed')
        }
    }

    if (isLoading) {
        return (
            <div className="flex items-center justify-center py-24">
                <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
        )
    }

    return (
        <div className="space-y-4 max-w-2xl mx-auto">

            {/* Wallet Balance Card */}
            <div
                id="wallet-balance-card"
                className="rounded-2xl bg-card shadow-sm border border-border p-5 flex items-center justify-between"
            >
                <div>
                    <p className="text-xs font-semibold text-foreground/70 mb-1">Wallet Balance</p>
                    <p className="text-3xl font-bold tracking-tight text-foreground">
                        {formatCurrency(walletBalance)}
                    </p>
                    <p className="text-xs text-foreground/70 mt-1">Available now</p>
                </div>
                <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-green-500" />
                    <span className="text-xs font-medium text-green-600 dark:text-green-400">Active</span>
                </div>
            </div>

            {/* Lifetime Stats */}
            <div className="grid grid-cols-2 gap-3">
                <div className="rounded-2xl bg-card shadow-sm border border-border p-4">
                    <div className="flex items-center gap-2 mb-2">
                        <TrendingUp className="w-4 h-4 text-green-600 dark:text-green-500" />
                        <p className="text-xs font-semibold text-foreground/70">Total Credited</p>
                    </div>
                    <p className="text-xl font-semibold text-foreground">{formatCurrency(totalCredited)}</p>
                    <p className="text-xs text-foreground/70 mt-0.5">Lifetime</p>
                </div>
                <div className="rounded-2xl bg-card shadow-sm border border-border p-4">
                    <div className="flex items-center gap-2 mb-2">
                        <TrendingDown className="w-4 h-4 text-red-500 dark:text-red-400" />
                        <p className="text-xs font-semibold text-foreground/70">Total Spent</p>
                    </div>
                    <p className="text-xl font-semibold text-foreground">{formatCurrency(totalDebited)}</p>
                    <p className="text-xs text-foreground/70 mt-0.5">Lifetime</p>
                </div>
            </div>

            {/* ── Tabs: Top Up / Send & Claim ── */}
            <Tabs defaultValue="topup" className="w-full">
                <TabsList className="w-full grid grid-cols-2 mb-4 h-12 p-1 bg-muted border border-border rounded-xl">
                    <TabsTrigger value="topup" className="h-full text-sm font-semibold rounded-lg data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md">Top Up Wallet</TabsTrigger>
                    <TabsTrigger value="claim" className="h-full text-sm font-semibold rounded-lg data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md">Send &amp; Claim</TabsTrigger>
                </TabsList>

                {/* ── Top Up Tab ── */}
                <TabsContent value="topup">
                    <Card>
                        <CardHeader className="pb-3">
                            <CardTitle className="text-sm font-semibold flex items-center gap-2">
                                <Plus className="w-4 h-4 text-blue-600" />
                                Top Up Wallet
                                {(dbUser?.role === 'agent' || dbUser?.role === 'dealer') && (
                                    <span className="text-xs font-normal text-red-500 ml-1">· Paystack fee applies</span>
                                )}
                            </CardTitle>
                            <CardDescription className="text-xs text-foreground/70">Pay with mobile money — funds arrive instantly</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-6">

                            {/* Prominent top-up limits */}
                            <div className="flex items-center gap-2.5 rounded-xl border border-amber-300 dark:border-amber-700/60 bg-amber-50 dark:bg-amber-950/30 px-4 py-3">
                                <AlertCircle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0" />
                                <p className="text-sm font-bold text-amber-800 dark:text-amber-300">
                                    Top up between {formatCurrency(minTopup)} and {formatCurrency(maxTopup)}
                                </p>
                            </div>

                            {chargeStep === 'idle' && (
                                <>
                                    {/* Quick Amounts */}
                                    <div>
                                        <Label className="text-sm font-medium text-foreground mb-3 block">Quick Select</Label>
                                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                                            {QUICK_AMOUNTS.filter(amt => amt >= minTopup && amt <= maxTopup).map(amt => (
                                                <Button key={amt} type="button"
                                                    variant={topUpAmount === amt.toString() ? 'default' : 'outline'}
                                                    onClick={() => setTopUpAmount(amt.toString())}
                                                    className="h-12">
                                                    {formatCurrency(amt)}
                                                </Button>
                                            ))}
                                        </div>
                                    </div>

                                    {/* Custom Amount */}
                                    <div>
                                        <Label htmlFor="charge-amount">Custom Amount (GHS)</Label>
                                        <div className="relative mt-2">
                                            <span className="absolute left-3 top-1/2 -translate-y-1/2 font-medium text-foreground/70">GHS</span>
                                            <Input id="charge-amount" type="number" placeholder="Enter amount"
                                                value={topUpAmount}
                                                onChange={e => setTopUpAmount(e.target.value)}
                                                className="pl-12 h-12 text-lg text-foreground" min={minTopup} max={maxTopup} />
                                        </div>
                                        <p className="text-xs text-foreground/70 mt-1">Enter between {formatCurrency(minTopup)} and {formatCurrency(maxTopup)}</p>
                                    </div>

                                    {/* Phone input + network badge */}
                                    <div className="grid grid-cols-2 gap-3">
                                        {/* Phone number */}
                                        <div>
                                            <Label htmlFor="momo-phone">Mobile Number</Label>
                                            <Input id="momo-phone" type="tel" placeholder="0241234567"
                                                value={momoPhone}
                                                onChange={e => setMomoPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
                                                className="h-12 mt-2 text-foreground" maxLength={10} />
                                        </div>

                                        {/* Network selector — always visible, auto-fills on detection */}
                                        <div>
                                            <Label>
                                                Network
                                                {autoDetected && selectedNetwork && (
                                                    <span className="ml-2 text-xs font-medium text-green-600 dark:text-green-400">Auto-detected</span>
                                                )}
                                            </Label>
                                            <Select value={selectedNetwork} onValueChange={v => { setSelectedNetwork(v); setAutoDetected(false) }}>
                                                <SelectTrigger className="h-12 mt-2">
                                                    <SelectValue placeholder="Select network" />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="MTN">
                                                        <span className="flex items-center gap-2">
                                                            <span className="w-2.5 h-2.5 rounded-full bg-yellow-400 shrink-0" />
                                                            MTN
                                                        </span>
                                                    </SelectItem>
                                                    <SelectItem value="VOD">
                                                        <span className="flex items-center gap-2">
                                                            <span className="w-2.5 h-2.5 rounded-full bg-red-600 shrink-0" />
                                                            Telecel
                                                        </span>
                                                    </SelectItem>
                                                    <SelectItem value="ATL">
                                                        <span className="flex items-center gap-2">
                                                            <span className="w-2.5 h-2.5 rounded-full bg-blue-600 shrink-0" />
                                                            AirtelTigo
                                                        </span>
                                                    </SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>
                                    </div>

                                    {/* Fee summary */}
                                    {topUpAmount && parseFloat(topUpAmount) >= minTopup && parseFloat(topUpAmount) <= maxTopup && (
                                        <div className="p-4 rounded-xl bg-muted/50 border border-border space-y-2">
                                            <div className="flex justify-between text-sm">
                                                <span className="text-foreground/70">Top-up amount</span>
                                                <span className="font-medium text-foreground">{formatCurrency(parseFloat(topUpAmount))}</span>
                                            </div>
                                            <div className="flex justify-between text-sm">
                                                <span className="text-foreground/70">Transaction fee ({paystackFeePercent}%)</span>
                                                <span className="font-medium text-foreground">{formatCurrency(fee)}</span>
                                            </div>
                                            <Separator />
                                            <div className="flex justify-between font-semibold text-foreground">
                                                <span>Total to pay</span>
                                                <span className="text-primary">{formatCurrency(totalAmount)}</span>
                                            </div>
                                        </div>
                                    )}

                                    {/* Pay button */}
                                    <Button onClick={handleCharge}
                                        className="w-full h-12 text-lg bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700"
                                        disabled={!topUpAmount || parseFloat(topUpAmount) < minTopup || parseFloat(topUpAmount) > maxTopup || !momoPhone}>
                                        <Smartphone className="w-5 h-5 mr-2" />
                                        Pay {topUpAmount && parseFloat(topUpAmount) >= minTopup && parseFloat(topUpAmount) <= maxTopup && formatCurrency(totalAmount)} via MoMo
                                    </Button>
                                </>
                            )}

                        </CardContent>
                    </Card>
                </TabsContent>

                {/* ── Send & Claim Tab ── */}
                <TabsContent value="claim">
                    {!momoEnabled ? (
                        <Card>
                            <CardContent className="flex flex-col items-center text-center gap-3 py-10">
                                <AlertTriangle className="w-8 h-8 text-amber-500" />
                                <p className="font-semibold text-sm text-foreground">Temporarily Unavailable</p>
                                <p className="text-xs text-foreground/70 max-w-xs">
                                    This service is temporarily unavailable. Use the Top Up tab to fund your wallet via mobile money.
                                </p>
                            </CardContent>
                        </Card>
                    ) : (
                        <Card>
                            <CardHeader className="pb-3">
                                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                                    <Zap className="w-4 h-4 text-amber-500" />
                                    Send &amp; Claim
                                </CardTitle>
                                <CardDescription className="text-xs text-foreground/70">
                                    Send money to the number below, then claim your wallet credit instantly
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-5">

                                {/* Prominent claim limits */}
                                <div className="flex items-center gap-2.5 rounded-xl border border-amber-300 dark:border-amber-700/60 bg-amber-50 dark:bg-amber-950/30 px-4 py-3">
                                    <AlertCircle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0" />
                                    <p className="text-sm font-bold text-amber-800 dark:text-amber-300">
                                        Send between GH₵ {momoMinClaimable.toFixed(2)} and GH₵ {momoMaxClaimable.toLocaleString()}
                                    </p>
                                </div>

                                {/* Step 1: Payment Reference */}
                                <div className="space-y-2">
                                    <p className="text-xs font-bold text-foreground uppercase tracking-wide">Step 1 — Your Reference Code</p>
                                    {refLoading ? (
                                        <div className="flex items-center justify-center h-11">
                                            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                                        </div>
                                    ) : userRef ? (
                                        <div className="space-y-2">
                                            <div className="flex items-center gap-2">
                                                <div className="flex-1 rounded-xl border border-border bg-muted/40 px-4 py-2.5 flex items-center justify-center">
                                                    <span className={`font-mono text-xl font-bold tracking-[4px] ${userRef.is_active ? 'text-foreground' : 'text-muted-foreground'}`}>
                                                        {userRef.code}
                                                    </span>
                                                </div>
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    className="h-11 px-4 shrink-0"
                                                    onClick={() => {
                                                        navigator.clipboard.writeText(userRef.code)
                                                        setRefCopied(true)
                                                        toast.success('Reference copied!')
                                                        setTimeout(() => setRefCopied(false), 2000)
                                                    }}
                                                >
                                                    {refCopied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
                                                </Button>
                                            </div>
                                            {!userRef.is_active && (
                                                <p className="text-xs font-medium text-red-600 dark:text-red-400">This reference has been disabled. Contact support.</p>
                                            )}
                                            <p className="text-xs text-foreground/70">
                                                Include this as your payment reference when sending — required for cross-network transfers (e.g. Telecel → MTN).
                                            </p>
                                        </div>
                                    ) : (
                                        <Button
                                            onClick={handleGenerateRef}
                                            disabled={refGenerating}
                                            variant="outline"
                                            className="w-full h-11"
                                        >
                                            {refGenerating ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plus className="w-4 h-4 mr-2" />}
                                            Get My Reference Code
                                        </Button>
                                    )}
                                </div>

                                <Separator />

                                {/* Step 2: Send money to */}
                                <div className="space-y-2">
                                    <p className="text-xs font-bold text-foreground uppercase tracking-wide">Step 2 — Send Money To</p>
                                    {momoAccounts.length > 0 ? (
                                        <div className="rounded-xl border border-border overflow-hidden divide-y divide-border">
                                            {momoAccounts.map((acct, i) => {
                                                const badge = NETWORK_BADGE[acct.network] || NETWORK_BADGE['Unknown']
                                                return (
                                                    <div key={i} className="flex items-center justify-between px-4 py-3 bg-card hover:bg-muted/30 transition-colors">
                                                        <div>
                                                            <div className="flex items-center gap-1.5 mb-0.5">
                                                                <span className={`w-2 h-2 rounded-full ${badge.bg} shrink-0`} />
                                                                <p className="text-xs text-foreground/70 font-semibold">{badge.label}</p>
                                                            </div>
                                                            <p className="font-mono font-semibold text-base tracking-wide text-foreground">{acct.number}</p>
                                                        </div>
                                                        <Button
                                                            variant="outline"
                                                            size="sm"
                                                            className="h-8 px-3 text-xs shrink-0"
                                                            onClick={() => {
                                                                navigator.clipboard.writeText(acct.number)
                                                                setCopiedIndex(i)
                                                                setTimeout(() => setCopiedIndex(null), 1800)
                                                                toast.success('Number copied!')
                                                            }}
                                                        >
                                                            {copiedIndex === i
                                                                ? <><Check className="w-3 h-3 mr-1 text-green-600" />Copied</>
                                                                : <><Copy className="w-3 h-3 mr-1" />Copy</>
                                                            }
                                                        </Button>
                                                    </div>
                                                )
                                            })}
                                            {momoAccountName && (
                                                <div className="px-4 py-2.5 bg-muted/30 flex items-center justify-between">
                                                    <span className="text-xs text-foreground/70">Account Name</span>
                                                    <span className="text-xs font-semibold text-foreground uppercase">{momoAccountName}</span>
                                                </div>
                                            )}
                                        </div>
                                    ) : (
                                        <p className="text-xs text-foreground/60 italic">No payment numbers configured.</p>
                                    )}
                                    <p className="text-xs text-foreground/70">
                                        Accepted: <span className="font-semibold text-foreground">GH₵ {momoMinClaimable.toFixed(2)} – GH₵ {momoMaxClaimable.toLocaleString()}</span>
                                    </p>
                                </div>

                                <Separator />

                                {/* Step 3: Claim */}
                                <div className="space-y-2">
                                    <p className="text-xs font-bold text-foreground uppercase tracking-wide">Step 3 — Claim Your Funds</p>
                                    <p className="text-xs text-foreground/70">
                                        After sending, paste the transaction ID from your MoMo confirmation SMS to credit your wallet instantly.
                                    </p>
                                    <div className="flex gap-2">
                                        <Input
                                            type="text"
                                            placeholder="Paste transaction ID"
                                            value={txnIdInput}
                                            pattern="\d*"
                                            maxLength={15}
                                            onChange={(e) => setTxnIdInput(e.target.value.replace(/\D/g, ''))}
                                            disabled={claimStep === 'claiming' || cooldownSeconds > 0}
                                            className="h-11 flex-1 font-mono tracking-wider text-foreground"
                                        />
                                        <Button
                                            onClick={handleDirectClaim}
                                            disabled={txnIdInput.length < 8 || claimStep === 'claiming' || cooldownSeconds > 0}
                                            className="h-11 px-5 font-semibold shrink-0"
                                        >
                                            {claimStep === 'claiming' ? (
                                                <Loader2 className="w-4 h-4 animate-spin" />
                                            ) : cooldownSeconds > 0 ? (
                                                `Wait ${cooldownSeconds}s`
                                            ) : (
                                                'Claim'
                                            )}
                                        </Button>
                                    </div>
                                </div>

                            </CardContent>
                        </Card>
                    )}
                </TabsContent>
            </Tabs>

            {/* ── Payment Processing Modal ──
                The charge flow lives in a focus-trapped, non-dismissible modal
                (portaled to document.body) so it stays centered and can't be
                scrolled away or buried when the user switches to their MoMo app
                to approve the prompt and returns. Closing is driven ONLY by the
                explicit in-modal buttons, each of which resets chargeStep to
                'idle' (which flips `open` to false). Esc / outside-click are
                blocked so a payment in flight can't be dismissed by accident. */}
            <Dialog open={chargeStep !== 'idle'}>
                <DialogContent
                    hideCloseButton
                    aria-describedby={undefined}
                    onInteractOutside={(e) => e.preventDefault()}
                    onEscapeKeyDown={(e) => e.preventDefault()}
                    className="sm:max-w-md"
                >
                    <DialogTitle className="sr-only">Wallet top-up payment</DialogTitle>

                    {chargeStep === 'charging' && (
                        <div className="flex flex-col items-center py-10 gap-4">
                            <Loader2 className="w-10 h-10 animate-spin text-blue-600" />
                            <p className="font-semibold">Initiating payment...</p>
                        </div>
                    )}

                    {chargeStep === 'otp_required' && (
                        <div className="space-y-4">
                            <p className="text-sm font-medium text-center text-foreground">{chargeDisplayText || 'Enter the OTP sent to your phone'}</p>
                            <Input placeholder="Enter OTP"
                                value={otpValue}
                                onChange={e => setOtpValue(e.target.value.replace(/\D/g, ''))}
                                className="h-12 text-center text-xl font-mono tracking-widest text-foreground"
                                maxLength={6} />
                            <Button onClick={handleSubmitOtp} className="w-full h-12" disabled={!otpValue}>
                                Submit OTP
                            </Button>
                            <button type="button" onClick={() => setChargeStep('idle')}
                                className="w-full text-xs text-foreground/70 hover:text-foreground hover:underline text-center">
                                Cancel
                            </button>
                        </div>
                    )}

                    {chargeStep === 'pending' && (
                        <div className="flex flex-col items-center py-10 gap-4 text-center">
                            <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                                <Smartphone className="w-8 h-8 text-green-600" />
                            </div>
                            <div className="space-y-1">
                                <p className="font-bold text-lg text-foreground">Payment request sent!</p>
                                <p className="text-sm text-foreground/70">
                                    A prompt has been sent to <span className="font-semibold text-foreground">{momoPhone}</span>.
                                </p>
                                <p className="text-sm text-foreground/70">
                                    Enter your MoMo PIN on your phone to approve, then tap below.
                                </p>
                            </div>

                            {/* Always-available manual confirm — no longer gated behind a timeout */}
                            <Button
                                onClick={handleIHavePaid}
                                disabled={checkingPaid}
                                className="w-full h-12 text-base"
                            >
                                {checkingPaid ? (
                                    <><Loader2 className="w-5 h-5 mr-2 animate-spin" /> Checking…</>
                                ) : (
                                    <><CheckCircle2 className="w-5 h-5 mr-2" /> I&apos;ve Paid — Check Now</>
                                )}
                            </Button>

                            <div className="flex items-center gap-2 text-xs text-foreground/70">
                                <Loader2 className="w-4 h-4 animate-spin" />
                                <span>
                                    {pollCount >= PATIENT_POLLS
                                        ? 'Taking longer than usual — once you approve, you’ll be credited automatically and notified.'
                                        : 'Waiting for your approval…'}
                                </span>
                            </div>

                            <button type="button" onClick={() => { stopPolling(); setChargeStep('idle') }}
                                className="text-xs text-foreground/70 hover:text-foreground hover:underline">
                                Cancel
                            </button>
                        </div>
                    )}

                    {chargeStep === 'verifying' && (
                        <div className="flex flex-col items-center py-10 gap-4">
                            <Loader2 className="w-10 h-10 animate-spin text-blue-600" />
                            <p className="font-semibold">Confirming payment...</p>
                        </div>
                    )}

                    {chargeStep === 'failed' && (
                        <div className="flex flex-col items-center py-10 gap-4">
                            <AlertTriangle className="w-10 h-10 text-red-500" />
                            <p className="font-semibold text-center">Payment could not be completed</p>
                            <Button onClick={() => setChargeStep('idle')} variant="outline">Try Again</Button>
                        </div>
                    )}
                </DialogContent>
            </Dialog>

            {/* Success Summary Modal */}
            <Dialog open={isSuccessModalOpen} onOpenChange={setIsSuccessModalOpen}>
                <DialogContent className="sm:max-w-sm p-0 overflow-hidden border-0 shadow-2xl rounded-2xl bg-white dark:bg-slate-900" aria-describedby={undefined}>
                    {successClaimData && (
                        <div className="flex flex-col w-full">
                            <div className="bg-emerald-500 px-6 py-8 flex flex-col items-center justify-center text-center">
                                <div className="w-16 h-16 bg-white rounded-full flex items-center justify-center mb-4 shadow-lg">
                                    <CheckCircle2 className="w-10 h-10 text-emerald-500" />
                                </div>
                                <DialogTitle className="text-white text-2xl font-black m-0 mb-1">Claim Successful</DialogTitle>
                                <p className="text-emerald-50 text-sm font-medium">Wallet credited instantly</p>
                            </div>

                            <div className="p-6 divide-y divide-slate-100 dark:divide-slate-800">
                                <div className="flex justify-between py-3 text-sm">
                                    <span className="text-slate-600 dark:text-slate-300">Transaction ID</span>
                                    <span className="font-mono font-bold text-slate-800 dark:text-slate-200">#{successClaimData.transaction_id}</span>
                                </div>
                                <div className="flex justify-between py-3 text-sm">
                                    <span className="text-slate-600 dark:text-slate-300">Amount Sent</span>
                                    <span className="font-medium text-slate-800 dark:text-slate-200">{formatCurrency(successClaimData.amount)}</span>
                                </div>
                                {successClaimData.fee_amount > 0 && (
                                    <div className="flex justify-between py-3 text-sm">
                                        <span className="text-slate-600 dark:text-slate-300">Fee ({successClaimData.fee_percent}%)</span>
                                        <span className="font-medium text-rose-600">-{formatCurrency(successClaimData.fee_amount)}</span>
                                    </div>
                                )}
                                <div className="flex justify-between py-4 text-base">
                                    <span className="font-bold text-slate-800 dark:text-slate-200">Amount Credited</span>
                                    <span className="font-black text-emerald-600 dark:text-emerald-400">{formatCurrency(successClaimData.net_amount)}</span>
                                </div>
                                <div className="flex justify-between py-4 text-base bg-slate-50 dark:bg-slate-800/50 -mx-6 px-6 mt-2 border-t border-slate-100 dark:border-slate-800">
                                    <span className="font-bold text-slate-800 dark:text-slate-200">New Balance</span>
                                    <span className="font-black text-[#0B1F3A] dark:text-white">{formatCurrency(successClaimData.new_balance)}</span>
                                </div>
                            </div>

                            <div className="p-4 bg-slate-50 dark:bg-slate-800/80 border-t border-slate-100 dark:border-slate-700">
                                <Button
                                    className="w-full bg-slate-800 hover:bg-slate-900 text-white h-12 rounded-xl font-bold"
                                    onClick={() => setIsSuccessModalOpen(false)}
                                >
                                    Done
                                </Button>
                            </div>
                        </div>
                    )}
                </DialogContent>
            </Dialog>

            {/* Recent Transactions */}
            <Card id="recent-activity">
                <CardHeader className="pb-3">
                    <CardTitle className="text-sm font-semibold">Recent Top-ups</CardTitle>
                </CardHeader>
                <CardContent>
                    {transactions.length === 0 ? (
                        <div className="text-center py-12">
                            <Wallet className="w-12 h-12 mx-auto text-foreground/40 mb-4" />
                            <p className="text-sm text-foreground/70">No transactions yet</p>
                        </div>
                    ) : (
                        <div className="space-y-4">
                            {transactions.map((txn) => (
                                <div
                                    key={txn.id}
                                    className="flex items-center justify-between p-4 rounded-xl bg-muted/30 hover:bg-muted/50 transition-colors"
                                >
                                    <div className="flex items-center gap-4">
                                        <div className="w-10 h-10 rounded-full flex items-center justify-center bg-green-100 dark:bg-green-900/30">
                                            <ArrowDownLeft className="w-5 h-5 text-green-600" />
                                        </div>
                                        <div>
                                            <p className="font-medium text-foreground">{txn.description}</p>
                                            <p className="text-sm text-foreground/70">
                                                {formatDate(txn.created_at ?? '')}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="text-right">
                                        <p className="font-semibold text-green-600 dark:text-green-500">
                                            +{formatCurrency(txn.amount)}
                                        </p>
                                        <Badge variant={txn.status === 'completed' ? 'completed' : 'pending'} className="text-xs">
                                            {txn.status}
                                        </Badge>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    )
}

export default function WalletPage() {
    return (
        <Suspense fallback={
            <div className="flex items-center justify-center py-24">
                <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
        }>
            <WalletContent />
        </Suspense>
    )
}
