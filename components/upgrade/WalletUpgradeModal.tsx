'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
    Crown,
    Gem,
    Wallet,
    CheckCircle,
    X,
    RefreshCw,
    AlertTriangle,
    Zap,
    ToggleLeft,
    ToggleRight,
    Info,
} from 'lucide-react'

interface WalletUpgradeModalProps {
    plan: string
    planLabel: string
    price: number
    walletBalance: number
    upgradeType: 'agent' | 'dealer'
    /** Whether user already has auto-upgrade enabled for this plan */
    currentAutoUpgrade: boolean
    currentAutoUpgradePlan: string | null
    onClose: () => void
    onSuccess: () => void
    /** Called when the server reports the price changed since this modal opened. */
    onPriceChanged?: () => void
}

export default function WalletUpgradeModal({
    plan,
    planLabel,
    price,
    walletBalance,
    upgradeType,
    currentAutoUpgrade,
    currentAutoUpgradePlan,
    onClose,
    onSuccess,
    onPriceChanged,
}: WalletUpgradeModalProps) {
    const router = useRouter()
    const [isProcessing, setIsProcessing] = useState(false)

    const isDealer = upgradeType === 'dealer'
    const isPermanent = plan === 'permanent'

    // Recurring wallet debits must be an explicit opt-in — never pre-ticked.
    const [autoUpgrade, setAutoUpgrade] = useState(false)

    // One key per modal instance: retries of the same confirmation are idempotent server-side.
    const [idempotencyKey] = useState(() => {
        try {
            return crypto.randomUUID()
        } catch {
            return undefined // insecure context — server generates a key instead
        }
    })
    const submittingRef = useRef(false)

    const hasFunds = walletBalance >= price
    const shortfall = price - walletBalance
    const newBalance = walletBalance - price

    const accentClass = isDealer
        ? 'from-violet-600 to-indigo-700'
        : 'from-[#FFCE00] to-amber-500'
    const accentText = isDealer ? 'text-violet-300' : 'text-amber-600'
    const accentBg = isDealer ? 'bg-violet-500/20' : 'bg-yellow-400/20'
    const accentBorder = isDealer ? 'border-violet-500/30' : 'border-yellow-400/30'
    const UpgradeIcon = isDealer ? Gem : Crown

    const handleConfirm = async () => {
        // Synchronous guard: state updates are async, so a fast double-click/tap would otherwise
        // fire two requests before `isProcessing` re-renders the button as disabled.
        if (submittingRef.current) return
        submittingRef.current = true
        setIsProcessing(true)
        try {
            // 1. Process wallet upgrade. The idempotency key is fixed for this modal, so a retry
            //    after a dropped connection can never charge twice; expected_price makes the server
            //    refuse if the price changed since the user agreed to it.
            const res = await fetch('/api/user/upgrade/wallet', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    plan,
                    upgrade_type: upgradeType,
                    expected_price: price,
                    idempotency_key: idempotencyKey,
                }),
            })

            const data = await res.json().catch(() => ({}))

            if (!res.ok) {
                if (data.priceChanged) {
                    toast.error(data.error || 'The price changed. Please review and confirm again.')
                    onPriceChanged?.()
                    return
                }
                if (data.insufficientBalance) {
                    toast.error(`Insufficient balance. You need GHS ${data.shortfall?.toFixed(2)} more.`)
                } else {
                    toast.error(data.error || 'Upgrade failed. Please try again.')
                }
                return
            }

            // 2. Save auto-upgrade preference only if the user explicitly turned it on
            let autoUpgradeSaved = true
            if (autoUpgrade && !isPermanent) {
                try {
                    const toggleRes = await fetch('/api/user/upgrade/toggle-auto-upgrade', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ enabled: true, plan }),
                    })
                    autoUpgradeSaved = toggleRes.ok
                } catch {
                    autoUpgradeSaved = false
                }
            }

            toast.success(`${planLabel} activated!`)
            if (!autoUpgradeSaved) {
                toast.warning("Your upgrade is active, but auto-renewal couldn't be turned on. You can enable it from your dashboard.")
            }
            onSuccess()
        } catch {
            toast.error('Something went wrong. Please check your wallet before trying again.')
        } finally {
            submittingRef.current = false
            setIsProcessing(false)
        }
    }

    return (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
            <div
                className={cn(
                    'relative w-full max-w-md rounded-2xl shadow-2xl overflow-hidden',
                    isDealer
                        ? 'bg-gradient-to-br from-violet-950 via-purple-900 to-indigo-950 border border-violet-500/40'
                        : 'bg-white dark:bg-gray-900 border border-yellow-200 dark:border-yellow-900/40'
                )}
            >
                {/* Header */}
                <div className={cn('px-6 pt-6 pb-4 bg-gradient-to-r', accentClass)}>
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center">
                                <UpgradeIcon className="w-5 h-5 text-white fill-white/30" />
                            </div>
                            <div>
                                <p className="text-white/70 text-xs font-bold uppercase tracking-widest">
                                    Confirm Upgrade
                                </p>
                                <h2 className="text-white font-bold text-lg leading-tight">{planLabel}</h2>
                            </div>
                        </div>
                        <button
                            onClick={onClose}
                            aria-label="Close"
                            className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors"
                        >
                            <X className="w-4 h-4 text-white" />
                        </button>
                    </div>
                </div>

                <div className="px-6 py-5 space-y-4">
                    {/* Price row */}
                    <div className={cn('rounded-xl p-4 border flex items-center justify-between', accentBg, accentBorder)}>
                        <div className="flex items-center gap-2">
                            <Wallet className={cn('w-5 h-5', isDealer ? 'text-violet-300' : 'text-amber-600')} />
                            <span className={cn('font-bold text-sm', isDealer ? 'text-violet-100' : 'text-gray-800 dark:text-gray-200')}>
                                Upgrade Cost
                            </span>
                        </div>
                        <span className={cn('font-bold text-xl', isDealer ? 'text-white' : 'text-gray-900 dark:text-white')}>
                            GHS {price.toFixed(2)}
                        </span>
                    </div>

                    {/* Balance status */}
                    {hasFunds ? (
                        <div className="rounded-xl border border-green-500/30 bg-green-500/10 p-4 space-y-2">
                            <div className="flex items-center justify-between">
                                <span className="text-green-400 font-semibold text-sm flex items-center gap-1.5">
                                    <CheckCircle className="w-4 h-4" /> Wallet Balance
                                </span>
                                <span className="text-green-300 font-bold">GHS {walletBalance.toFixed(2)}</span>
                            </div>
                            <div className="flex items-center justify-between text-xs opacity-70">
                                <span className={isDealer ? 'text-violet-300' : 'text-gray-500 dark:text-gray-400'}>
                                    Balance after upgrade
                                </span>
                                <span className={isDealer ? 'text-violet-200' : 'text-gray-700 dark:text-gray-300'}>
                                    GHS {newBalance.toFixed(2)}
                                </span>
                            </div>
                        </div>
                    ) : (
                        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 space-y-3">
                            <div className="flex items-start gap-2">
                                <AlertTriangle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
                                <div>
                                    <p className="text-red-300 font-bold text-sm">Insufficient Balance</p>
                                    <p className="text-red-400/80 text-xs mt-0.5">
                                        You have <span className="font-bold text-red-300">GHS {walletBalance.toFixed(2)}</span> but need{' '}
                                        <span className="font-bold text-red-300">GHS {price.toFixed(2)}</span>.
                                    </p>
                                </div>
                            </div>
                            <div className="bg-red-900/30 rounded-lg px-3 py-2 flex items-center justify-between">
                                <span className="text-red-300 text-xs font-bold">Amount to add to wallet</span>
                                <span className="text-white font-bold text-sm">GHS {shortfall.toFixed(2)}</span>
                            </div>
                            <Link href="/dashboard/wallet">
                                <Button className="w-full bg-red-500 hover:bg-red-600 text-white font-bold rounded-xl h-10 text-sm">
                                    <Wallet className="w-4 h-4 mr-2" />
                                    Recharge Wallet
                                </Button>
                            </Link>
                        </div>
                    )}

                    {/* Auto-upgrade toggle — only for timed plans (not permanent) */}
                    {hasFunds && !isPermanent && (
                        <div className={cn(
                            'rounded-xl border p-4',
                            isDealer ? 'border-violet-500/30 bg-violet-500/10' : 'border-yellow-200 dark:border-yellow-800/40 bg-yellow-50 dark:bg-yellow-900/10'
                        )}>
                            <div className="flex items-start justify-between gap-3">
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-1.5 mb-1">
                                        <Zap className={cn('w-4 h-4 flex-shrink-0', isDealer ? 'text-violet-300' : 'text-amber-600')} />
                                        <p className={cn('font-bold text-sm', isDealer ? 'text-violet-100' : 'text-gray-800 dark:text-gray-200')}>
                                            Enable Auto-Upgrade
                                        </p>
                                        <span className={cn(
                                            'text-[9px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wider',
                                            isDealer ? 'bg-violet-500/40 text-violet-200' : 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300'
                                        )}>
                                            Optional
                                        </span>
                                    </div>
                                    <p className={cn('text-xs leading-relaxed', isDealer ? 'text-violet-300' : 'text-gray-500 dark:text-gray-400')}>
                                        Off by default. Turn it on to automatically renew this plan from your wallet when it's about to expire. You can switch it off any time.
                                    </p>
                                </div>
                                <button
                                    onClick={() => setAutoUpgrade(v => !v)}
                                    className="flex-shrink-0 mt-0.5"
                                    aria-label={autoUpgrade ? 'Disable auto-upgrade' : 'Enable auto-upgrade'}
                                >
                                    {autoUpgrade ? (
                                        <ToggleRight className={cn('w-9 h-9', isDealer ? 'text-violet-400' : 'text-amber-500')} />
                                    ) : (
                                        <ToggleLeft className="w-9 h-9 text-gray-400 dark:text-gray-600" />
                                    )}
                                </button>
                            </div>

                            {autoUpgrade && (
                                <div className={cn(
                                    'mt-3 rounded-lg px-3 py-2 flex items-start gap-2 text-xs',
                                    isDealer ? 'bg-violet-600/20 text-violet-200' : 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300'
                                )}>
                                    <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                                    <span>
                                        Auto-upgrade is <strong>ON</strong>. Keep at least{' '}
                                        <strong>GHS {price.toFixed(2)}</strong> in your wallet before expiry.
                                        If balance is too low when the cron runs, auto-upgrade is disabled and you'll be notified by SMS.
                                    </span>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Action buttons */}
                    <div className="flex gap-3 pt-1">
                        <Button
                            variant="outline"
                            onClick={onClose}
                            disabled={isProcessing}
                            className={cn(
                                'flex-1 h-11 rounded-xl font-bold text-sm',
                                isDealer
                                    ? 'border-violet-500/40 text-violet-300 hover:bg-violet-500/10 bg-transparent'
                                    : 'border-gray-200 dark:border-gray-700'
                            )}
                        >
                            Cancel
                        </Button>

                        {hasFunds && (
                            <Button
                                onClick={handleConfirm}
                                disabled={isProcessing}
                                className={cn(
                                    'flex-1 h-11 rounded-xl font-bold text-sm transition-all active:scale-95',
                                    isDealer
                                        ? 'bg-gradient-to-r from-violet-500 to-indigo-600 hover:from-violet-600 hover:to-indigo-700 text-white shadow-lg shadow-violet-900/50'
                                        : 'bg-[#FFCE00] hover:bg-[#E6B800] text-black shadow-lg shadow-yellow-500/20'
                                )}
                            >
                                {isProcessing ? (
                                    <RefreshCw className="w-4 h-4 animate-spin" />
                                ) : (
                                    <>
                                        <Wallet className="w-4 h-4 mr-2" />
                                        Pay from Wallet
                                    </>
                                )}
                            </Button>
                        )}
                    </div>

                    <p className={cn(
                        'text-center text-[10px] font-medium',
                        isDealer ? 'text-violet-400/60' : 'text-gray-400 dark:text-gray-600'
                    )}>
                        Payment is instant and deducted directly from your FameTech Wallet.
                    </p>
                </div>
            </div>
        </div>
    )
}
