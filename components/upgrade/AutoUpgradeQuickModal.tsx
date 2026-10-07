'use client'

import { useState, useEffect } from 'react'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
    X,
    Zap,
    ZapOff,
    Wallet,
    Calendar,
    Info,
    RefreshCw,
    CheckCircle,
    Crown,
    Gem,
} from 'lucide-react'
import { getCachedPricing } from '@/lib/pricing-cache'

type AgentPlan = '3d' | '14d' | '30d'
type Plan = AgentPlan | '6m'

interface AutoUpgradeQuickModalProps {
    mode: 'enable' | 'manage'
    userRole: 'agent' | 'dealer'
    /** For agents: agent_expires_at. For dealers: dealer_expires_at */
    expiresAt: string | null
    currentPlan: string | null
    firstName: string
    onClose: () => void
    onUpdated: () => void
}

const AGENT_PLANS: { id: AgentPlan; label: string }[] = [
    { id: '3d',  label: '3 Days'  },
    { id: '14d', label: '14 Days' },
    { id: '30d', label: '30 Days' },
]

const PLAN_PRICE_DEFAULTS: Record<Plan, number> = {
    '3d':  9.99,
    '14d': 49.99,
    '30d': 99.99,
    '6m':  299.99,
}

export default function AutoUpgradeQuickModal({
    mode,
    userRole,
    expiresAt,
    currentPlan,
    firstName,
    onClose,
    onUpdated,
}: AutoUpgradeQuickModalProps) {
    const isDealer = userRole === 'dealer'

    const defaultPlan: Plan = isDealer
        ? '6m'
        : (currentPlan && currentPlan !== '6m' ? currentPlan as AgentPlan : '30d')

    const [selectedPlan, setSelectedPlan] = useState<Plan>(defaultPlan)
    const [prices, setPrices] = useState<Record<Plan, number>>(PLAN_PRICE_DEFAULTS)
    const [isSaving, setIsSaving] = useState(false)

    useEffect(() => {
        getCachedPricing().then(data => {
            if (!data.prices) return
            setPrices({
                '3d':  data.prices['3d']  ?? PLAN_PRICE_DEFAULTS['3d'],
                '14d': data.prices['14d'] ?? PLAN_PRICE_DEFAULTS['14d'],
                '30d': data.prices['30d'] ?? PLAN_PRICE_DEFAULTS['30d'],
                '6m':  data.dealerPrice   ?? PLAN_PRICE_DEFAULTS['6m'],
            })
        }).catch(() => null)
    }, [])

    const price = prices[selectedPlan]

    const expiryFormatted = expiresAt
        ? new Date(expiresAt).toLocaleDateString('en-GB', {
              day: 'numeric', month: 'long', year: 'numeric',
          })
        : null

    const accentGradient = isDealer ? 'from-violet-600 to-indigo-700' : 'from-[#FFCE00] to-amber-500'
    const accentText     = isDealer ? 'text-violet-300' : 'text-amber-600'
    const accentBg       = isDealer ? 'bg-violet-500/15 border-violet-500/30' : 'bg-yellow-400/15 border-yellow-400/30'
    const Icon           = isDealer ? Gem : Crown

    const handleEnable = async () => {
        setIsSaving(true)
        try {
            const res = await fetch('/api/user/upgrade/toggle-auto-upgrade', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: true, plan: selectedPlan }),
            })
            const data = await res.json()
            if (!res.ok) {
                toast.error(data.error || 'Failed to enable auto-upgrade')
                return
            }
            toast.success('Auto-upgrade enabled!')
            onUpdated()
        } catch {
            toast.error('Something went wrong. Please try again.')
        } finally {
            setIsSaving(false)
        }
    }

    const handleDisable = async () => {
        setIsSaving(true)
        try {
            const res = await fetch('/api/user/upgrade/toggle-auto-upgrade', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: false, plan: selectedPlan }),
            })
            const data = await res.json()
            if (!res.ok) {
                toast.error(data.error || 'Failed to disable auto-upgrade')
                return
            }
            toast.success('Auto-upgrade disabled.')
            onUpdated()
        } catch {
            toast.error('Something went wrong. Please try again.')
        } finally {
            setIsSaving(false)
        }
    }

    return (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
            <div className={cn(
                'relative w-full max-w-sm rounded-2xl shadow-2xl overflow-hidden',
                isDealer
                    ? 'bg-gradient-to-br from-violet-950 via-purple-900 to-indigo-950 border border-violet-500/40'
                    : 'bg-white dark:bg-gray-900 border border-yellow-200 dark:border-yellow-900/40'
            )}>
                {/* Header */}
                <div className={cn('px-5 pt-5 pb-4 bg-gradient-to-r', accentGradient)}>
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <div className="w-9 h-9 rounded-full bg-white/20 flex items-center justify-center">
                                {mode === 'manage'
                                    ? <ZapOff className="w-4 h-4 text-white" />
                                    : <Zap className="w-4 h-4 text-white fill-white/40" />
                                }
                            </div>
                            <div>
                                <p className="text-white/70 text-[10px] font-bold uppercase tracking-widest">
                                    {mode === 'manage' ? 'Auto-Upgrade Settings' : 'Enable Auto-Upgrade'}
                                </p>
                                <h2 className="text-white font-bold text-base leading-tight">
                                    {mode === 'manage'
                                        ? `Auto-Upgrade is ON`
                                        : `Never Miss a Renewal`}
                                </h2>
                            </div>
                        </div>
                        <button
                            onClick={onClose}
                            className="w-7 h-7 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors"
                        >
                            <X className="w-3.5 h-3.5 text-white" />
                        </button>
                    </div>
                </div>

                <div className="px-5 py-4 space-y-4">

                    {/* MANAGE MODE — current settings + disable option */}
                    {mode === 'manage' && (
                        <>
                            <div className={cn('rounded-xl border p-3.5 space-y-2.5', accentBg)}>
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <Icon className={cn('w-4 h-4', accentText)} />
                                        <span className={cn('text-sm font-bold', isDealer ? 'text-violet-100' : 'text-gray-800 dark:text-gray-100')}>
                                            Active Plan
                                        </span>
                                    </div>
                                    <span className={cn(
                                        'text-xs font-bold px-2.5 py-1 rounded-full',
                                        isDealer ? 'bg-violet-400/30 text-violet-200' : 'bg-yellow-300/40 text-yellow-800 dark:text-yellow-200'
                                    )}>
                                        {currentPlan === '6m' ? '6 Months Dealer'
                                            : currentPlan === 'permanent' ? 'Permanent'
                                            : currentPlan ? `${currentPlan} Agent`
                                            : '—'}
                                    </span>
                                </div>

                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <Wallet className={cn('w-4 h-4', accentText)} />
                                        <span className={cn('text-sm font-semibold', isDealer ? 'text-violet-200' : 'text-gray-700 dark:text-gray-300')}>
                                            Renewal Cost
                                        </span>
                                    </div>
                                    <span className={cn('text-sm font-bold', isDealer ? 'text-white' : 'text-gray-900 dark:text-white')}>
                                        GHS {prices[currentPlan as Plan] ? prices[currentPlan as Plan].toFixed(2) : price.toFixed(2)}
                                    </span>
                                </div>

                                {expiryFormatted && (
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-2">
                                            <Calendar className={cn('w-4 h-4', accentText)} />
                                            <span className={cn('text-sm font-semibold', isDealer ? 'text-violet-200' : 'text-gray-700 dark:text-gray-300')}>
                                                Next Renewal
                                            </span>
                                        </div>
                                        <span className={cn('text-sm font-bold', isDealer ? 'text-white' : 'text-gray-900 dark:text-white')}>
                                            {expiryFormatted}
                                        </span>
                                    </div>
                                )}
                            </div>

                            <div className={cn(
                                'rounded-lg px-3 py-2.5 flex items-start gap-2 text-xs',
                                isDealer ? 'bg-green-500/10 border border-green-500/20 text-green-300'
                                         : 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800/40 text-green-700 dark:text-green-400'
                            )}>
                                <CheckCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                                <span>
                                    Your membership will be auto-renewed from your Flexy-Wallet on expiry. Keep at least{' '}
                                    <strong>GHS {prices[currentPlan as Plan] ? prices[currentPlan as Plan].toFixed(2) : price.toFixed(2)}</strong>{' '}
                                    in your wallet to avoid interruption.
                                </span>
                            </div>

                            <div className="flex gap-3 pt-1">
                                <Button
                                    variant="outline"
                                    onClick={onClose}
                                    disabled={isSaving}
                                    className={cn(
                                        'flex-1 h-10 rounded-xl font-bold text-sm',
                                        isDealer ? 'border-violet-500/40 text-violet-300 hover:bg-violet-500/10 bg-transparent' : ''
                                    )}
                                >
                                    Keep ON
                                </Button>
                                <Button
                                    onClick={handleDisable}
                                    disabled={isSaving}
                                    className="flex-1 h-10 rounded-xl font-bold text-sm bg-red-500 hover:bg-red-600 text-white"
                                >
                                    {isSaving ? <RefreshCw className="w-4 h-4 animate-spin" /> : (
                                        <><ZapOff className="w-4 h-4 mr-1.5" />Turn OFF</>
                                    )}
                                </Button>
                            </div>
                        </>
                    )}

                    {/* ENABLE MODE — plan picker + confirm */}
                    {mode === 'enable' && (
                        <>
                            <p className={cn('text-sm font-medium', isDealer ? 'text-violet-200' : 'text-gray-600 dark:text-gray-400')}>
                                Hi <strong>{firstName}</strong>! Choose which plan to auto-renew when your membership expires.
                            </p>

                            {/* Plan selector — agents only; dealers have one option */}
                            {!isDealer && (
                                <div className="grid grid-cols-3 gap-2">
                                    {AGENT_PLANS.map(p => (
                                        <button
                                            key={p.id}
                                            onClick={() => setSelectedPlan(p.id)}
                                            className={cn(
                                                'rounded-xl py-2.5 text-xs font-bold border-2 transition-all',
                                                selectedPlan === p.id
                                                    ? 'border-[#FFCE00] bg-yellow-400/20 text-gray-900 dark:text-white'
                                                    : 'border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-yellow-300'
                                            )}
                                        >
                                            {p.label}
                                        </button>
                                    ))}
                                </div>
                            )}

                            {/* Price + expiry summary */}
                            <div className={cn('rounded-xl border p-3.5 space-y-2.5', accentBg)}>
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <Wallet className={cn('w-4 h-4', accentText)} />
                                        <span className={cn('text-sm font-semibold', isDealer ? 'text-violet-200' : 'text-gray-700 dark:text-gray-300')}>
                                            Renewal Amount
                                        </span>
                                    </div>
                                    <span className={cn('text-sm font-bold', isDealer ? 'text-white' : 'text-gray-900 dark:text-white')}>
                                        GHS {price.toFixed(2)}
                                    </span>
                                </div>
                                {expiryFormatted && (
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-2">
                                            <Calendar className={cn('w-4 h-4', accentText)} />
                                            <span className={cn('text-sm font-semibold', isDealer ? 'text-violet-200' : 'text-gray-700 dark:text-gray-300')}>
                                                Auto-renews on
                                            </span>
                                        </div>
                                        <span className={cn('text-sm font-bold', isDealer ? 'text-white' : 'text-gray-900 dark:text-white')}>
                                            {expiryFormatted}
                                        </span>
                                    </div>
                                )}
                            </div>

                            {/* Keep balance hint */}
                            <div className={cn(
                                'rounded-lg px-3 py-2.5 flex items-start gap-2 text-xs',
                                isDealer ? 'bg-violet-500/10 border border-violet-500/20 text-violet-300'
                                         : 'bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800/40 text-amber-700 dark:text-amber-300'
                            )}>
                                <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                                <span>
                                    Keep at least <strong>GHS {price.toFixed(2)}</strong> in your Flexy-Wallet before your expiry date. If balance is too low, auto-upgrade is disabled and you'll be notified by SMS.
                                </span>
                            </div>

                            <div className="flex gap-3 pt-1">
                                <Button
                                    variant="outline"
                                    onClick={onClose}
                                    disabled={isSaving}
                                    className={cn(
                                        'flex-1 h-10 rounded-xl font-bold text-sm',
                                        isDealer ? 'border-violet-500/40 text-violet-300 hover:bg-violet-500/10 bg-transparent' : ''
                                    )}
                                >
                                    Cancel
                                </Button>
                                <Button
                                    onClick={handleEnable}
                                    disabled={isSaving}
                                    className={cn(
                                        'flex-1 h-10 rounded-xl font-bold text-sm transition-all active:scale-95',
                                        isDealer
                                            ? 'bg-gradient-to-r from-violet-500 to-indigo-600 hover:from-violet-600 hover:to-indigo-700 text-white'
                                            : 'bg-[#FFCE00] hover:bg-[#E6B800] text-black shadow-md shadow-yellow-400/20'
                                    )}
                                >
                                    {isSaving ? <RefreshCw className="w-4 h-4 animate-spin" /> : (
                                        <><Zap className="w-4 h-4 mr-1.5 fill-current" />Enable Auto-Upgrade</>
                                    )}
                                </Button>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    )
}
