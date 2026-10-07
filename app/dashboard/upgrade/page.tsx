'use client'

import { useEffect, useState, Suspense } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/contexts/auth-context'
import { supabase } from '@/lib/supabase'
import { getCachedPricing, clearPricingCache } from '@/lib/pricing-cache'
import { Button } from '@/components/ui/button'
import { Crown, Sparkles, Zap, Star, CheckCircle, Gem, Code2, Rocket, HeadphonesIcon, TrendingDown, Shield } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import { toast } from '@/lib/toast'
import CongratsModal from '@/components/upgrade/CongratsModal'
import WalletUpgradeModal from '@/components/upgrade/WalletUpgradeModal'
import { cn } from '@/lib/utils'

function UpgradePageInner() {
    const { dbUser, refreshUser } = useAuth()
    const router = useRouter()

    // Congrats modal state
    const [showCongrats, setShowCongrats] = useState(false)

    // Wallet modal state
    const [walletModal, setWalletModal] = useState<{
        plan: string
        planLabel: string
        price: number
        upgradeType: 'agent' | 'dealer'
    } | null>(null)

    // Live wallet balance (fetched when user opens modal)
    const [walletBalance, setWalletBalance] = useState<number>(0)
    const [walletLoading, setWalletLoading] = useState(false)

    // Dealer upgrade state
    const [dealerPrice, setDealerPrice] = useState(299.99)
    const [dealerPrice1m, setDealerPrice1m] = useState(99.99)
    const [dealerPrice3m, setDealerPrice3m] = useState(199.99)

    // Prices for tiers
    const [prices, setPrices] = useState({
        '3d': 9.99,
        '14d': 49.99,
        '30d': 99.99,
        'permanent': 149.99
    })

    const [oldPrices, setOldPrices] = useState({
        '3d': 0,
        '14d': 0,
        '30d': 0,
        'permanent': 0
    })

    const [showStrikethrough, setShowStrikethrough] = useState(false)
    const [isLoading, setIsLoading] = useState(true)

    useEffect(() => {
        let retryTimer: ReturnType<typeof setTimeout> | null = null

        const fetchPrices = async (isRetry = false) => {
            try {
                if (isRetry) clearPricingCache()

                const data = await getCachedPricing()

                if (data.prices === null && !isRetry) {
                    retryTimer = setTimeout(() => fetchPrices(true), 1500)
                    return
                }

                setPrices({
                    '3d': data.prices?.['3d'] ?? 9.99,
                    '14d': data.prices?.['14d'] ?? 49.99,
                    '30d': data.prices?.['30d'] ?? 99.99,
                    'permanent': data.prices?.['permanent'] ?? 149.99,
                })
                setOldPrices({
                    '3d': data.oldPrices?.['3d'] ?? 0,
                    '14d': data.oldPrices?.['14d'] ?? 0,
                    '30d': data.oldPrices?.['30d'] ?? 0,
                    'permanent': data.oldPrices?.['permanent'] ?? 0,
                })
                setShowStrikethrough(data.showStrikethrough || false)
                if (data.dealerPrice != null) setDealerPrice(data.dealerPrice)
                if (data.dealerPrice1m != null) setDealerPrice1m(data.dealerPrice1m)
                if (data.dealerPrice3m != null) setDealerPrice3m(data.dealerPrice3m)
                setIsLoading(false)
            } catch (err) {
                console.error('Failed to fetch upgrade prices:', err)
                toast.error('Failed to load upgrade prices.')
                setIsLoading(false)
            }
        }

        fetchPrices()
        return () => { if (retryTimer) clearTimeout(retryTimer) }
    }, [])

    const fetchWalletBalance = async () => {
        setWalletLoading(true)
        try {
            const { data: { user } } = await supabase.auth.getUser()
            if (!user) return

            const { data: wallet } = await supabase
                .from('wallets')
                .select('balance')
                .eq('user_id', user.id)
                .single()

            setWalletBalance((wallet as any)?.balance ?? 0)
        } catch {
            // Non-critical — modal still shows with 0 balance and user sees shortfall
        } finally {
            setWalletLoading(false)
        }
    }

    const handleUpgrade = async (plan: string) => {
        const planLabelMap: Record<string, string> = {
            '3d': '3 Days Agent Pass',
            '14d': '14 Days Agent Pass',
            '30d': '30 Days Agent Pass',
            'permanent': 'Permanent Agent Pass',
        }
        await fetchWalletBalance()
        setWalletModal({
            plan,
            planLabel: planLabelMap[plan] ?? 'Agent Pass',
            price: prices[plan as keyof typeof prices] ?? 99.99,
            upgradeType: 'agent',
        })
    }

    const dealerPlanConfig = {
        '1m': { price: dealerPrice1m, label: '1 Month Dealer Pass',  extensionLabel: '1 Month Dealer Extension'  },
        '3m': { price: dealerPrice3m, label: '3 Months Dealer Pass', extensionLabel: '3 Months Dealer Extension' },
        '6m': { price: dealerPrice,   label: '6 Months Dealer Pass', extensionLabel: '6 Months Dealer Extension' },
    }

    const handleDealerUpgrade = async (plan: '1m' | '3m' | '6m') => {
        await fetchWalletBalance()
        const config = dealerPlanConfig[plan]
        setWalletModal({
            plan,
            planLabel: isActiveDealer ? config.extensionLabel : config.label,
            price: config.price,
            upgradeType: 'dealer',
        })
    }

    const handleUpgradeSuccess = async () => {
        setWalletModal(null)
        setShowCongrats(true)
        await refreshUser()
    }

    const getDiscountPercent = (oldPrice: number, newPrice: number): number => {
        if (!oldPrice || oldPrice <= newPrice) return 0
        return Math.round(((oldPrice - newPrice) / oldPrice) * 100)
    }

    const tiers = [
        {
            id: '3d',
            name: '3 Days',
            duration: '3 Days Access',
            price: prices['3d'],
            oldPrice: oldPrices['3d'],
            popular: false,
            tier: 'bronze',
            color: 'border-[#C0C0C0] dark:border-gray-500',
            buttonClass: 'bg-gradient-to-r from-gray-300 to-gray-400 hover:from-gray-400 hover:to-gray-500 text-gray-800 shadow-sm',
            badgeText: 'STARTER',
            badgeColor: 'from-gray-300 to-gray-400',
            priceColor: 'text-gray-600 dark:text-gray-300',
            bgClass: 'bg-slate-50 dark:bg-slate-900'
        },
        {
            id: '14d',
            name: '2 weeks',
            duration: '14 Days Access',
            price: prices['14d'],
            oldPrice: oldPrices['14d'],
            popular: true,
            tier: 'gold',
            color: 'border-[#FFCE00] ring-2 ring-[#FFCE00]/30 dark:border-amber-500 dark:ring-amber-500/30',
            buttonClass: 'bg-[#FFCE00] hover:bg-[#E6B800] text-black shadow-lg shadow-[#FFCE00]/20',
            badgeText: 'MOST POPULAR',
            badgeColor: 'from-[#FFCE00] to-[#E6B800]',
            priceColor: 'text-amber-600 dark:text-amber-400',
            bgClass: 'bg-amber-50 dark:bg-amber-950/40'
        },
        {
            id: '30d',
            name: '1 month',
            duration: '30 Days Access',
            price: prices['30d'],
            oldPrice: oldPrices['30d'],
            popular: false,
            tier: 'diamond',
            color: 'border-purple-400 ring-2 ring-purple-400/30 dark:border-purple-600 dark:ring-purple-600/30',
            buttonClass: 'bg-gradient-to-r from-purple-600 via-blue-600 to-indigo-700 hover:from-purple-700 hover:via-blue-700 hover:to-indigo-800 shadow-lg shadow-purple-500/30',
            badgeText: 'PREMIUM',
            badgeColor: 'from-purple-600 to-indigo-700',
            priceColor: 'text-purple-600 dark:text-purple-400',
            bgClass: 'bg-purple-50 dark:bg-purple-950/40'
        },
        {
            id: 'permanent',
            name: 'Lifetime',
            duration: 'Permanent Access',
            price: prices['permanent'],
            oldPrice: oldPrices['permanent'],
            popular: false,
            tier: 'elite',
            color: 'border-slate-800 ring-2 ring-slate-800/30 dark:border-slate-500 dark:ring-slate-500/30',
            buttonClass: 'bg-gradient-to-r from-slate-900 via-slate-800 to-black hover:from-black hover:to-slate-900 shadow-xl shadow-slate-900/40 text-yellow-500',
            badgeText: 'LIFETIME ELITE',
            badgeColor: 'from-slate-800 to-black',
            priceColor: 'text-slate-900 dark:text-slate-100',
            bgClass: 'bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-800'
        }
    ]

    const commonFeatures = [
        'Exclusive Wholesale Pricing',
        'Priority Customer Support',
        '0% Top Up Charges (Admin Manual Top Up)',
        'Faster Order Processing',
        'Bulk Order Import Feature',
        'New Exclusive UI Design Features',
        'Shop Storefront Feature (Live)',
        'Developer API Key Access'
    ]

    const dealerFeatures = [
        { label: 'All Agent Benefits Included', icon: CheckCircle },
        { label: 'More Discounted Prices (Lower than Agent)', icon: TrendingDown },
        { label: 'Full Developer API Access', icon: Code2 },
        { label: 'High Rate Limits on Developer API', icon: Rocket },
        { label: 'Faster & Prioritized Order Processing', icon: Zap },
        { label: 'Priority Order Complaint Resolution', icon: Shield },
        { label: 'Priority Customer Support (Direct Line)', icon: HeadphonesIcon },
    ]

    if (isLoading) {
        return (
            <div className="fixed inset-0 bg-[#FFCE00] flex items-center justify-center z-50 p-6">
                <Crown className="w-16 h-16 text-yellow-600 animate-bounce" />
            </div>
        )
    }

    const isPermanentAgent = dbUser?.role === 'agent' && dbUser?.agent_expires_at === null
    const isActiveDealer = dbUser?.role === 'dealer'
    const autoUpgradeEnabled = (dbUser as any)?.auto_upgrade_enabled ?? false
    const autoUpgradePlan = (dbUser as any)?.auto_upgrade_plan ?? null

    return (
        <>
            {showCongrats && (
                <CongratsModal
                    onClose={() => setShowCongrats(false)}
                    onBrowsePackages={() => router.push('/dashboard/data-packages')}
                />
            )}

            {walletModal && !walletLoading && (
                <WalletUpgradeModal
                    plan={walletModal.plan}
                    planLabel={walletModal.planLabel}
                    price={walletModal.price}
                    walletBalance={walletBalance}
                    upgradeType={walletModal.upgradeType}
                    currentAutoUpgrade={autoUpgradeEnabled}
                    currentAutoUpgradePlan={autoUpgradePlan}
                    onClose={() => setWalletModal(null)}
                    onSuccess={handleUpgradeSuccess}
                />
            )}

            <div className="relative -m-4 sm:-m-6 min-h-[calc(100vh+2rem)] lg:min-h-screen bg-gradient-to-br from-yellow-400 via-amber-500 to-yellow-600 overflow-x-hidden selection:bg-yellow-200 px-4 sm:px-6 py-10 sm:py-16 flex flex-col items-center scroll-smooth [font-family:'Fira_Sans',sans-serif]">

                <div className="relative z-10 w-full max-w-6xl flex flex-col items-center">

                    {/* Header Section */}
                    <div className="text-center mb-8 sm:mb-12 space-y-3 sm:space-y-4 relative w-full">
                        <div className="mb-4 sm:mb-6 flex justify-center">
                            <div className="relative">
                                <Crown className="w-20 h-20 sm:w-28 sm:h-28 text-black animate-[bounce_2s_infinite] drop-shadow-xl" />
                            </div>
                        </div>

                        <h1 className="text-4xl sm:text-6xl lg:text-7xl font-bold text-[#b45309] leading-tight">
                            {isActiveDealer ? (
                                <span className="relative inline-block">
                                    <span className="relative">
                                        D
                                        <Gem className="absolute -top-6 -left-3 w-8 h-8 sm:w-12 sm:h-12 text-violet-500 fill-violet-400 -rotate-[25deg] drop-shadow-md" />
                                    </span>
                                    EALER STATUS
                                </span>
                            ) : dbUser?.role === 'agent' ? (
                                <span className="relative inline-block">
                                    <span className="relative">
                                        A
                                        <Crown className="absolute -top-6 -left-3 w-8 h-8 sm:w-12 sm:h-12 text-yellow-500 fill-yellow-500 -rotate-[25deg] drop-shadow-md" />
                                    </span>
                                    LREADY AN AGENT
                                </span>
                            ) : (
                                <span className="relative inline-block">
                                    <span className="relative">
                                        B
                                        <Crown className="absolute -top-6 -left-3 w-8 h-8 sm:w-12 sm:h-12 text-yellow-500 fill-yellow-500 -rotate-[25deg] drop-shadow-md" />
                                    </span>
                                    ECOME AN AGENT
                                </span>
                            )}
                        </h1>

                        {/* Premium Badge */}
                        {(dbUser?.role === 'agent' || isActiveDealer) && (
                            <div className={cn(
                                "inline-block px-4 py-1.5 rounded-full backdrop-blur-sm shadow-sm group border",
                                isActiveDealer
                                    ? "bg-violet-100/90 border-violet-300"
                                    : "bg-yellow-100/90 border-yellow-200"
                            )}>
                                <span className={cn(
                                    "text-[10px] sm:text-xs font-bold uppercase tracking-[0.2em] flex items-center gap-2",
                                    isActiveDealer ? "text-violet-700" : "text-yellow-700"
                                )}>
                                    {isActiveDealer
                                        ? <><Gem className="w-3 h-3" />HIGHEST ROLE — DEALER MEMBERSHIP<Gem className="w-3 h-3" /></>
                                        : <><Crown className="w-3 h-3 fill-yellow-600 text-yellow-600 group-hover:rotate-180 transition-transform duration-700" />{isPermanentAgent ? 'PERMANENT ELITE MEMBERSHIP' : 'PREMIUM MEMBERSHIP'}<Crown className="w-3 h-3 fill-yellow-600 text-yellow-600 group-hover:rotate-180 transition-transform duration-700" /></>
                                    }
                                </span>
                            </div>
                        )}

                        <p id="agent-benefits" className="text-sm sm:text-base lg:text-lg text-white font-semibold max-w-3xl mx-auto px-4 drop-shadow-sm">
                            {isActiveDealer
                                ? "You're on the highest reseller role on the platform. Extend your membership before it expires to keep enjoying the best prices and all premium benefits."
                                : isPermanentAgent
                                    ? "You have permanent lifetime access to the Agent rank. Scroll down to upgrade to the exclusive Dealer tier."
                                    : dbUser?.role === 'agent'
                                        ? "Renew/Extend Your Subscription to Continue Enjoying Your Existing Features and Benefits"
                                        : "Unlock the New Premium Membership (Agent Role) for Exciting Features to Grow your Business. Choose from the Plans below (Each plan has same features)."}
                        </p>
                    </div>

                    {!isPermanentAgent && !isActiveDealer && (
                        <>
                            {/* Plans Grid */}
                            <div id="pricing-plans" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 lg:gap-5 mb-12 w-full max-w-7xl items-stretch px-2 sm:px-0">
                                {tiers.map((tier) => (
                                    <div
                                        key={tier.id}
                                        className={cn(
                                            "relative rounded-2xl p-4 sm:p-5 flex flex-col transition-all duration-500 shadow-xl border-2",
                                            tier.bgClass,
                                            tier.color,
                                            tier.popular ? 'md:scale-105 z-10' : 'opacity-95'
                                        )}
                                    >
                                        {tier.badgeText && (
                                            <div className={`absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 bg-gradient-to-r ${tier.badgeColor} rounded-full shadow-lg z-20 flex items-center gap-1.5`}>
                                                {tier.tier === 'bronze' && <Zap className="w-3 h-3 text-white fill-current" />}
                                                {tier.tier === 'gold' && <Sparkles className="w-3 h-3 text-white fill-current" />}
                                                {tier.tier === 'diamond' && <Crown className="w-3 h-3 text-white fill-current" />}
                                                <span className="text-[10px] font-bold text-white uppercase tracking-wider">
                                                    {tier.badgeText}
                                                </span>
                                            </div>
                                        )}

                                        <div className="text-center mb-3 space-y-0.5">
                                            <h3 className="text-lg sm:text-xl font-bold text-gray-900 dark:text-gray-100 border-b-2 border-yellow-50/50 dark:border-yellow-900/50 pb-1.5">{tier.name}</h3>
                                            <p className="text-gray-400 dark:text-gray-500 text-xs font-bold pt-0.5">{tier.duration}</p>
                                        </div>

                                        <div className="text-center mb-4 flex flex-col items-center justify-center gap-0.5">
                                            {showStrikethrough && tier.oldPrice > 0 && tier.oldPrice !== tier.price && (
                                                <>
                                                    <div className="inline-flex items-center gap-1 bg-red-500 text-white text-xs font-bold px-2 py-0.5 rounded-full shadow-sm">
                                                        <span>🔥</span>
                                                        <span>SAVE {getDiscountPercent(tier.oldPrice, tier.price)}%</span>
                                                    </div>
                                                    <span className="text-red-400 line-through text-xs font-bold opacity-75">
                                                        GHS {(tier.oldPrice ?? 0).toFixed(2)}
                                                    </span>
                                                </>
                                            )}

                                            <div className="flex items-baseline justify-center gap-1">
                                                <span className={`font-bold text-sm ${tier.priceColor}`}>GHS</span>
                                                <span className={`text-3xl sm:text-4xl font-bold ${tier.priceColor} tracking-tighter`}>
                                                    {(tier.price ?? 0).toFixed(2).split('.')[0]}
                                                    <span className="text-xl sm:text-2xl font-bold">
                                                        .{(tier.price ?? 0).toFixed(2).split('.')[1]}
                                                    </span>
                                                </span>
                                            </div>

                                            {showStrikethrough && tier.oldPrice > 0 && tier.oldPrice !== tier.price && (
                                                <p className="text-green-600 text-xs font-bold">✅ Limited time offer</p>
                                            )}
                                        </div>

                                        <div className="space-y-2 mb-5 flex-1">
                                            {commonFeatures.map((feature, i) => {
                                                const isComingSoon = feature.toLowerCase().includes('coming soon')
                                                return (
                                                    <div key={i} className="flex items-start gap-2.5">
                                                        <div className={cn(
                                                            "mt-0.5 flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center",
                                                            isComingSoon ? "bg-yellow-100 dark:bg-yellow-900/50" : "bg-green-50 dark:bg-green-900/50"
                                                        )}>
                                                            <CheckCircle className={cn(
                                                                "w-3.5 h-3.5",
                                                                isComingSoon ? "text-yellow-500 dark:text-yellow-400" : "text-green-500 dark:text-green-400"
                                                            )} />
                                                        </div>
                                                        <span className="text-xs sm:text-sm font-bold text-gray-700 dark:text-gray-300 leading-snug">{feature}</span>
                                                    </div>
                                                )
                                            })}
                                        </div>

                                        <Button
                                            onClick={() => handleUpgrade(tier.id)}
                                            className={`w-full h-10 rounded-xl text-sm font-bold transition-all active:scale-95 text-white ${tier.buttonClass}`}
                                        >
                                            {dbUser?.role === 'agent' ? 'Renew / Extend' : 'Be an Agent Today'}
                                        </Button>

                                        {tier.id === 'permanent' && (
                                            <div className="mt-3 flex items-center gap-1.5 justify-center bg-violet-50 dark:bg-violet-900/20 border border-violet-200 dark:border-violet-700 rounded-xl px-3 py-2">
                                                <Gem className="w-3.5 h-3.5 text-violet-500 flex-shrink-0" />
                                                <span className="text-[10px] font-bold text-violet-600 dark:text-violet-400 uppercase tracking-wider">Unlocks Dealer upgrade eligibility</span>
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>

                            {/* Wallet payment info banner */}
                            <div className="w-full max-w-3xl">
                                <div className="bg-white/60 dark:bg-slate-900/60 backdrop-blur-xl rounded-2xl p-6 sm:p-10 border-2 border-[#EEEEEE] dark:border-slate-800 shadow-[0_8px_30px_rgba(238,238,238,0.8)] dark:shadow-none flex flex-col items-center text-center space-y-6">
                                    <div className="inline-flex items-center gap-2 text-amber-600 dark:text-amber-400 bg-yellow-100/50 dark:bg-yellow-900/30 px-4 py-1.5 rounded-full border border-yellow-200/50 dark:border-yellow-800/50">
                                        <Zap className="w-5 h-5 fill-current" />
                                        <span className="text-xs font-bold uppercase tracking-[0.2em]">INSTANT · SECURE · FROM WALLET</span>
                                    </div>
                                    <p className="text-base text-gray-500 dark:text-gray-400 font-bold leading-relaxed max-w-xl">
                                        Upgrades are now powered by your Flexy-Wallet — instant activation, no external payment page needed. Keep your wallet topped up and enable Auto-Upgrade to never miss a renewal.
                                    </p>
                                </div>
                            </div>
                        </>
                    )}

                    {/* ── Dealer Upgrade Cards (permanent agents only) ── */}
                    {isPermanentAgent && !isActiveDealer && (
                        <div className="w-full max-w-3xl mt-12">
                            <div className="text-center mb-6 space-y-2">
                                <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-violet-100/80 dark:bg-violet-900/40 border border-violet-300/50 dark:border-violet-700/50">
                                    <Gem className="w-4 h-4 text-violet-600 dark:text-violet-400" />
                                    <span className="text-[11px] font-bold text-violet-700 dark:text-violet-300 uppercase tracking-[0.2em]">EXCLUSIVE — LIFETIME MEMBERS ONLY</span>
                                </div>
                                <h2 className="text-2xl sm:text-3xl font-bold text-black drop-shadow-sm">Upgrade to Dealer</h2>
                                <p className="text-sm text-white/80 font-medium max-w-md mx-auto">
                                    As a Lifetime Agent, you qualify for the premium Dealer tier. Choose a plan that fits your budget.
                                </p>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                                {([
                                    { plan: '1m' as const, title: '1 Month',  price: dealerPrice1m, badge: 'STARTER',   highlight: false },
                                    { plan: '3m' as const, title: '3 Months', price: dealerPrice3m, badge: 'VALUE',      highlight: true  },
                                    { plan: '6m' as const, title: '6 Months', price: dealerPrice,   badge: 'BEST DEAL', highlight: false },
                                ]).map(({ plan, title, price, badge, highlight }) => (
                                    <div
                                        key={plan}
                                        className={cn(
                                            'relative rounded-2xl p-6 border-2 bg-gradient-to-br from-violet-950 via-purple-900 to-indigo-950 shadow-xl shadow-violet-900/50 flex flex-col gap-4',
                                            highlight
                                                ? 'border-violet-400 ring-4 ring-violet-500/20'
                                                : 'border-violet-700/60'
                                        )}
                                    >
                                        <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-4 py-1 bg-gradient-to-r from-violet-500 to-indigo-600 rounded-full shadow-md z-10">
                                            <span className="text-[9px] font-bold text-white uppercase tracking-widest">{badge}</span>
                                        </div>
                                        <div className="mt-2">
                                            <p className="text-violet-300 text-xs font-bold uppercase tracking-widest mb-1">{title}</p>
                                            <div className="flex items-baseline gap-1">
                                                <span className="text-violet-300 font-bold text-sm">GHS</span>
                                                <span className="text-4xl font-bold text-white tracking-tighter">
                                                    {(price ?? 0).toFixed(2).split('.')[0]}
                                                    <span className="text-xl font-bold text-violet-200">.{(price ?? 0).toFixed(2).split('.')[1]}</span>
                                                </span>
                                            </div>
                                        </div>
                                        {dealerFeatures.map(({ label, icon: Icon }, i) => (
                                            <div key={i} className="flex items-start gap-2">
                                                <div className="mt-0.5 flex-shrink-0 w-4 h-4 rounded-full bg-violet-500/30 flex items-center justify-center">
                                                    <Icon className="w-2.5 h-2.5 text-violet-300" />
                                                </div>
                                                <span className="text-xs font-medium text-violet-100 leading-snug">{label}</span>
                                            </div>
                                        ))}
                                        <Button
                                            onClick={() => handleDealerUpgrade(plan)}
                                            className="w-full h-10 rounded-xl font-bold bg-gradient-to-r from-violet-500 to-indigo-600 hover:from-violet-600 hover:to-indigo-700 text-white shadow-lg shadow-violet-900/50 transition-all active:scale-95 text-sm mt-auto"
                                        >
                                            <Gem className="w-3.5 h-3.5 mr-2" />
                                            Choose {title}
                                        </Button>
                                        <p className="text-[9px] text-violet-400 font-bold text-center -mt-2">
                                            After {title.toLowerCase()}, you return to Lifetime Agent automatically
                                        </p>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* ── Dealer: extend membership cards ── */}
                    {isActiveDealer && (
                        <div className="w-full max-w-3xl mt-4">
                            <div className="mb-6 rounded-2xl bg-black/20 border border-white/20 px-5 py-4 flex items-center gap-4 backdrop-blur-sm">
                                <div className="flex-shrink-0 w-10 h-10 rounded-full bg-violet-500/30 flex items-center justify-center">
                                    <Gem className="w-5 h-5 text-violet-200 fill-violet-300" />
                                </div>
                                <div>
                                    <p className="text-white font-bold text-sm leading-tight">You're at the top — Dealer is the highest role.</p>
                                    <p className="text-white/70 text-xs font-medium mt-0.5">
                                        {(dbUser as any)?.dealer_expires_at
                                            ? <>Expires <span className="font-bold text-white">{new Date((dbUser as any).dealer_expires_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</span>. Extend to add more time from that date.</>
                                            : 'Extend your Dealer membership.'}
                                    </p>
                                </div>
                            </div>

                            <div className="text-center mb-6 space-y-2">
                                <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-violet-100/80 dark:bg-violet-900/40 border border-violet-300/50 dark:border-violet-700/50">
                                    <Gem className="w-4 h-4 text-violet-600 dark:text-violet-400" />
                                    <span className="text-[11px] font-bold text-violet-700 dark:text-violet-300 uppercase tracking-[0.2em]">ACTIVE DEALER MEMBERSHIP</span>
                                </div>
                                <h2 className="text-2xl sm:text-3xl font-bold text-black drop-shadow-sm">Extend Your Dealership</h2>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                                {([
                                    { plan: '1m' as const, title: '1 Month',  price: dealerPrice1m, badge: 'STARTER',   highlight: false },
                                    { plan: '3m' as const, title: '3 Months', price: dealerPrice3m, badge: 'VALUE',      highlight: true  },
                                    { plan: '6m' as const, title: '6 Months', price: dealerPrice,   badge: 'BEST DEAL', highlight: false },
                                ]).map(({ plan, title, price, badge, highlight }) => (
                                    <div
                                        key={plan}
                                        className={cn(
                                            'relative rounded-2xl p-6 border-2 bg-gradient-to-br from-violet-950 via-purple-900 to-indigo-950 shadow-xl shadow-violet-900/50 flex flex-col gap-4',
                                            highlight
                                                ? 'border-violet-400 ring-4 ring-violet-500/20'
                                                : 'border-violet-700/60'
                                        )}
                                    >
                                        <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-4 py-1 bg-gradient-to-r from-violet-500 to-indigo-600 rounded-full shadow-md z-10">
                                            <span className="text-[9px] font-bold text-white uppercase tracking-widest">{badge}</span>
                                        </div>
                                        <div className="mt-2">
                                            <p className="text-violet-300 text-xs font-bold uppercase tracking-widest mb-1">+{title}</p>
                                            <div className="flex items-baseline gap-1">
                                                <span className="text-violet-300 font-bold text-sm">GHS</span>
                                                <span className="text-4xl font-bold text-white tracking-tighter">
                                                    {(price ?? 0).toFixed(2).split('.')[0]}
                                                    <span className="text-xl font-bold text-violet-200">.{(price ?? 0).toFixed(2).split('.')[1]}</span>
                                                </span>
                                            </div>
                                        </div>
                                        {dealerFeatures.map(({ label, icon: Icon }, i) => (
                                            <div key={i} className="flex items-start gap-2">
                                                <div className="mt-0.5 flex-shrink-0 w-4 h-4 rounded-full bg-violet-500/30 flex items-center justify-center">
                                                    <Icon className="w-2.5 h-2.5 text-violet-300" />
                                                </div>
                                                <span className="text-xs font-medium text-violet-100 leading-snug">{label}</span>
                                            </div>
                                        ))}
                                        <Button
                                            onClick={() => handleDealerUpgrade(plan)}
                                            className="w-full h-10 rounded-xl font-bold bg-gradient-to-r from-violet-500 to-indigo-600 hover:from-violet-600 hover:to-indigo-700 text-white shadow-lg shadow-violet-900/50 transition-all active:scale-95 text-sm mt-auto"
                                        >
                                            <Gem className="w-3.5 h-3.5 mr-2" />
                                            Add {title}
                                        </Button>
                                        <p className="text-[9px] text-violet-400 font-bold text-center -mt-2">
                                            Adds {title.toLowerCase()} from current expiry
                                        </p>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </>
    )
}

export default function UpgradePage() {
    return (
        <Suspense fallback={
            <div className="fixed inset-0 bg-[#FFCE00] flex items-center justify-center z-50">
                <Crown className="w-16 h-16 text-yellow-600 animate-bounce" />
            </div>
        }>
            <UpgradePageInner />
        </Suspense>
    )
}
