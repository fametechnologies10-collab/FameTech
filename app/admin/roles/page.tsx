'use client'

import { useEffect, useState, useMemo } from 'react'
import { supabase } from '@/lib/supabase'
import { clearPricingCache } from '@/lib/pricing-cache'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import {
    Users,
    ShieldCheck,
    Save,
    Loader2,
    Search,
    RefreshCw,
    MoreVertical,
    Plus,
    History,
    Gem,
    UserPlus,
    X,
    Timer,
    Gift,
    Sparkles,
    AlertTriangle,
    Crown,
    TrendingUp,
    Tag,
    Zap,
} from 'lucide-react'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'

type RoleFilter = 'all' | 'agent' | 'dealer'
type StatusFilter = 'all' | 'active' | 'expiring' | 'expired'
type AgentDuration = '3d' | '14d' | '30d' | 'permanent'

const DURATION_LABELS: Record<AgentDuration, string> = {
    '3d': '3 Days',
    '14d': '14 Days',
    '30d': '30 Days',
    'permanent': 'Permanent',
}

function getDaysLeft(user: any): number | null {
    const expiry = user.role === 'dealer' ? user.dealer_expires_at : user.agent_expires_at
    if (!expiry) return null
    const diff = new Date(expiry).getTime() - Date.now()
    return Math.max(0, Math.ceil(diff / 86400000))
}

function getUserStatus(user: any): 'permanent' | 'active' | 'expiring' | 'expired' {
    const d = getDaysLeft(user)
    if (d === null) return 'permanent'
    if (d === 0) return 'expired'
    if (d <= 7) return 'expiring'
    return 'active'
}

function getProgressProps(user: any, days: number | null) {
    if (days === null) return { width: '100%', colorClass: 'fill-indigo-400' }
    const max = user.role === 'dealer' ? 180 : 30
    const pct = Math.min((days / max) * 100, 100)
    const colorClass =
        days <= 7 ? 'fill-red-500' :
        days <= 14 ? 'fill-amber-400' :
        user.role === 'dealer' ? 'fill-violet-400' : 'fill-blue-400'
    return { width: `${pct}%`, colorClass }
}

export default function RoleManagementPage() {
    const [agents, setAgents] = useState<any[]>([])
    const [dealers, setDealers] = useState<any[]>([])
    const [loading, setLoading] = useState(true)

    // Filters
    const [searchTerm, setSearchTerm] = useState('')
    const [roleFilter, setRoleFilter] = useState<RoleFilter>('all')
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')

    // Pricing
    const [prices, setPrices] = useState({ '3d': '9.99', '14d': '49.99', '30d': '99.99', 'permanent': '149.99' })
    const [dealerPrice, setDealerPrice] = useState('299.99')
    const [dealerPrice1m, setDealerPrice1m] = useState('99.99')
    const [dealerPrice3m, setDealerPrice3m] = useState('199.99')
    const [showStrikethrough, setShowStrikethrough] = useState(false)
    const [isSavingPrices, setIsSavingPrices] = useState(false)

    // Promos
    const [signupPromoRole, setSignupPromoRole] = useState<'dealer' | 'agent' | null>(null)
    const [isSavingPromo, setIsSavingPromo] = useState(false)

    // Assign Role
    const [assignRole, setAssignRole] = useState<'agent' | 'dealer'>('agent')
    const [assignDuration, setAssignDuration] = useState<AgentDuration>('30d')
    const [assignSearchQ, setAssignSearchQ] = useState('')
    const [assignResults, setAssignResults] = useState<any[]>([])
    const [isSearchingAssign, setIsSearchingAssign] = useState(false)
    const [selectedAssignUser, setSelectedAssignUser] = useState<any>(null)
    const [isAssigning, setIsAssigning] = useState(false)

    // Extend dialog
    const [extendUser, setExtendUser] = useState<any>(null)
    const [extendDays, setExtendDays] = useState('30')
    const [isExtending, setIsExtending] = useState(false)

    // Reduce dialog
    const [reduceUser, setReduceUser] = useState<any>(null)
    const [reduceDays, setReduceDays] = useState('7')
    const [isReducing, setIsReducing] = useState(false)

    // Make Permanent dialog
    const [permanentUser, setPermanentUser] = useState<any>(null)
    const [isMakingPermanent, setIsMakingPermanent] = useState(false)

    // Expire Now dialog
    const [expireUser, setExpireUser] = useState<any>(null)
    const [isExpiring, setIsExpiring] = useState(false)

    useEffect(() => { fetchData() }, [])

    // Clear assign panel when role type changes
    useEffect(() => {
        setAssignSearchQ('')
        setAssignResults([])
        setSelectedAssignUser(null)
    }, [assignRole])

    // Debounced assign user search
    useEffect(() => {
        if (!assignSearchQ.trim()) { setAssignResults([]); return }
        const t = setTimeout(async () => {
            setIsSearchingAssign(true)
            try {
                const endpoint = assignRole === 'dealer'
                    ? `/api/admin/lifetime-agents?q=${encodeURIComponent(assignSearchQ)}`
                    : `/api/admin/search-users?q=${encodeURIComponent(assignSearchQ)}`
                const res = await fetch(endpoint)
                if (res.ok) setAssignResults(await res.json())
            } catch {}
            setIsSearchingAssign(false)
        }, 350)
        return () => clearTimeout(t)
    }, [assignSearchQ, assignRole])

    const fetchData = async () => {
        setLoading(true)
        try {
            const [settingsResult, agentsRes, dealersRes] = await Promise.all([
                (supabase as any).from('admin_settings').select('*'),
                fetch('/api/admin/agents'),
                fetch('/api/admin/dealers'),
            ])

            if (settingsResult.data) {
                const s = settingsResult.data as any[]
                setPrices({
                    '3d': String(s.find(x => x.key === 'agent_upgrade_price_3d')?.value || '9.99'),
                    '14d': String(s.find(x => x.key === 'agent_upgrade_price_14d')?.value || '49.99'),
                    '30d': String(s.find(x => x.key === 'agent_upgrade_price_30d')?.value || '99.99'),
                    'permanent': String(s.find(x => x.key === 'agent_upgrade_price_permanent')?.value || '149.99'),
                })
                setDealerPrice(String(s.find(x => x.key === 'dealer_upgrade_price_6m')?.value || '299.99'))
                setDealerPrice1m(String(s.find(x => x.key === 'dealer_upgrade_price_1m')?.value || '99.99'))
                setDealerPrice3m(String(s.find(x => x.key === 'dealer_upgrade_price_3m')?.value || '199.99'))
                setShowStrikethrough(s.find(x => x.key === 'show_price_strikethrough')?.value === 'true')
                const promo = s.find(x => x.key === 'signup_promo_role')?.value || null
                setSignupPromoRole(promo === 'dealer' || promo === 'agent' ? promo : null)
            }

            if (agentsRes.ok) setAgents(await agentsRes.json())
            if (dealersRes.ok) setDealers(await dealersRes.json())
        } catch {
            toast.error('Failed to load data')
        } finally {
            setLoading(false)
        }
    }

    const handleSavePrices = async () => {
        setIsSavingPrices(true)
        try {
            const res = await fetch('/api/admin/update-prices', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prices, dealerPrice, dealerPrice1m, dealerPrice3m, showStrikethrough }),
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || 'Failed to update prices')
            clearPricingCache()
            toast.success(data.message || 'Prices updated')
            await fetchData()
        } catch (e: any) {
            toast.error(e.message)
        } finally {
            setIsSavingPrices(false)
        }
    }

    const handleSavePromo = async (newRole: 'dealer' | 'agent' | null) => {
        const prev = signupPromoRole
        setSignupPromoRole(newRole)
        setIsSavingPromo(true)
        try {
            const res = await fetch('/api/admin/settings/signup-promo', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ promoRole: newRole }),
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || 'Failed to update promo')
            toast.success(newRole ? `${newRole === 'dealer' ? 'Dealer' : 'Agent'} promo enabled` : 'Promo disabled')
        } catch (e: any) {
            setSignupPromoRole(prev)
            toast.error(e.message)
        } finally {
            setIsSavingPromo(false)
        }
    }

    const handleAssign = async () => {
        if (!selectedAssignUser) return
        setIsAssigning(true)
        try {
            const endpoint = assignRole === 'dealer' ? '/api/admin/assign-dealer' : '/api/admin/assign-agent'
            const body = assignRole === 'dealer'
                ? { userId: selectedAssignUser.id }
                : { userId: selectedAssignUser.id, duration: assignDuration }

            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || 'Failed to assign role')

            toast.success(
                assignRole === 'dealer'
                    ? `${selectedAssignUser.first_name} assigned as Dealer (6 months)`
                    : `${selectedAssignUser.first_name} assigned as Agent (${DURATION_LABELS[assignDuration]})`
            )
            setSelectedAssignUser(null)
            setAssignSearchQ('')
            setAssignResults([])
            await fetchData()
        } catch (e: any) {
            toast.error(e.message)
        } finally {
            setIsAssigning(false)
        }
    }

    const handleExtend = async () => {
        if (!extendUser) return
        const days = parseInt(extendDays)
        if (isNaN(days) || days <= 0) { toast.error('Enter a valid number of days'); return }
        setIsExtending(true)
        try {
            const endpoint = extendUser.role === 'dealer' ? '/api/admin/extend-dealer' : '/api/admin/extend-agent'
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: extendUser.id, days, action: 'extend' }),
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error)

            if (extendUser.role === 'dealer') {
                setDealers(prev => prev.map(d => d.id === extendUser.id ? { ...d, dealer_expires_at: data.newExpiry } : d))
            } else {
                setAgents(prev => prev.map(a => a.id === extendUser.id ? { ...a, agent_expires_at: data.newExpiry } : a))
            }
            toast.success(`Extended by ${days} days`)
            setExtendUser(null)
            setExtendDays('30')
        } catch (e: any) {
            toast.error(e.message)
        } finally {
            setIsExtending(false)
        }
    }

    const handleReduce = async () => {
        if (!reduceUser) return
        const days = parseInt(reduceDays)
        if (isNaN(days) || days <= 0) { toast.error('Enter a valid number of days'); return }
        setIsReducing(true)
        try {
            const endpoint = reduceUser.role === 'dealer' ? '/api/admin/extend-dealer' : '/api/admin/extend-agent'
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: reduceUser.id, days: -days, action: 'reduce' }),
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error)

            if (reduceUser.role === 'dealer') {
                setDealers(prev => prev.map(d => d.id === reduceUser.id ? { ...d, dealer_expires_at: data.newExpiry } : d))
            } else {
                setAgents(prev => prev.map(a => a.id === reduceUser.id ? { ...a, agent_expires_at: data.newExpiry } : a))
            }
            toast.success(`Reduced by ${days} days${data.isExpired ? ' — user has expired' : ''}`)
            setReduceUser(null)
            setReduceDays('7')
        } catch (e: any) {
            toast.error(e.message)
        } finally {
            setIsReducing(false)
        }
    }

    const handleMakePermanent = async () => {
        if (!permanentUser) return
        setIsMakingPermanent(true)
        try {
            const res = await fetch('/api/admin/extend-agent/permanent', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: permanentUser.id }),
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error)
            setAgents(prev => prev.map(a => a.id === permanentUser.id ? { ...a, agent_expires_at: null } : a))
            toast.success(`${permanentUser.first_name} is now a Permanent Agent`)
            setPermanentUser(null)
        } catch (e: any) {
            toast.error(e.message)
        } finally {
            setIsMakingPermanent(false)
        }
    }

    const handleExpireNow = async () => {
        if (!expireUser) return
        setIsExpiring(true)
        try {
            const res = await fetch('/api/admin/extend-dealer', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: expireUser.id, action: 'expire' }),
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error)
            setDealers(prev => prev.map(d => d.id === expireUser.id ? { ...d, dealer_expires_at: data.newExpiry } : d))
            toast.success(data.message || 'Dealer expired')
            setExpireUser(null)
        } catch (e: any) {
            toast.error(e.message)
        } finally {
            setIsExpiring(false)
        }
    }

    // Computed stats
    const stats = useMemo(() => {
        const now = Date.now()
        const agentActive = agents.filter(a =>
            a.agent_expires_at === null || new Date(a.agent_expires_at).getTime() > now
        )
        const agentExpiring = agents.filter(a => {
            if (!a.agent_expires_at) return false
            const d = Math.ceil((new Date(a.agent_expires_at).getTime() - now) / 86400000)
            return d > 0 && d <= 7
        })
        const dealerActive = dealers.filter(d =>
            d.dealer_expires_at && new Date(d.dealer_expires_at).getTime() > now
        )
        const dealerExpiring = dealers.filter(d => {
            if (!d.dealer_expires_at) return false
            const days = Math.ceil((new Date(d.dealer_expires_at).getTime() - now) / 86400000)
            return days > 0 && days <= 14
        })
        return {
            totalAgents: agents.length,
            activeAgents: agentActive.length,
            agentExpiring: agentExpiring.length,
            totalDealers: dealers.length,
            activeDealers: dealerActive.length,
            dealerExpiring: dealerExpiring.length,
        }
    }, [agents, dealers])

    // Filtered + merged user list
    const displayedUsers = useMemo(() => {
        let list: any[] = []
        if (roleFilter === 'all' || roleFilter === 'agent') list.push(...agents)
        if (roleFilter === 'all' || roleFilter === 'dealer') list.push(...dealers)

        if (searchTerm) {
            const q = searchTerm.toLowerCase()
            list = list.filter(u =>
                u.email?.toLowerCase().includes(q) ||
                u.first_name?.toLowerCase().includes(q) ||
                u.last_name?.toLowerCase().includes(q)
            )
        }

        if (statusFilter !== 'all') {
            list = list.filter(u => {
                const s = getUserStatus(u)
                if (statusFilter === 'active') return s === 'active' || s === 'permanent'
                if (statusFilter === 'expiring') return s === 'expiring'
                if (statusFilter === 'expired') return s === 'expired'
                return true
            })
        }

        return list
    }, [agents, dealers, roleFilter, statusFilter, searchTerm])

    const statCards = [
        { label: 'Total Agents', value: stats.totalAgents, Icon: Crown, iconColor: 'text-amber-500', numColor: 'text-slate-900 dark:text-slate-100', bg: 'bg-amber-500' },
        { label: 'Active Agents', value: stats.activeAgents, Icon: ShieldCheck, iconColor: 'text-emerald-500', numColor: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-500' },
        { label: 'Expiring ≤7d', value: stats.agentExpiring, Icon: AlertTriangle, iconColor: 'text-orange-500', numColor: stats.agentExpiring > 0 ? 'text-orange-600 dark:text-orange-400' : 'text-slate-400 dark:text-slate-600', bg: 'bg-orange-500' },
        { label: 'Total Dealers', value: stats.totalDealers, Icon: Gem, iconColor: 'text-violet-500', numColor: 'text-slate-900 dark:text-slate-100', bg: 'bg-violet-500' },
        { label: 'Active Dealers', value: stats.activeDealers, Icon: TrendingUp, iconColor: 'text-violet-500', numColor: 'text-violet-600 dark:text-violet-400', bg: 'bg-violet-500' },
        { label: 'Expiring ≤14d', value: stats.dealerExpiring, Icon: Timer, iconColor: 'text-red-500', numColor: stats.dealerExpiring > 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-400 dark:text-slate-600', bg: 'bg-red-500' },
    ]

    return (
        <div className="space-y-6 pb-20">
            {/* Header */}
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-xl font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                        <Users className="w-5 h-5 text-slate-500 dark:text-slate-400" />
                        Role Management
                    </h1>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
                        Manage agent and dealer roles, pricing, and promotions.
                    </p>
                </div>
                <Button
                    variant="outline"
                    size="sm"
                    onClick={fetchData}
                    disabled={loading}
                    className="gap-1.5 shrink-0 text-xs"
                >
                    <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
                    Refresh
                </Button>
            </div>

            {/* Stat Cards */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                {statCards.map(({ label, value, Icon, iconColor, numColor, bg }) => (
                    <div
                        key={label}
                        className="relative overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700/60 bg-white dark:bg-slate-900 p-3.5"
                    >
                        <div className={cn('absolute inset-0 opacity-[0.04] dark:opacity-[0.07]', bg)} />
                        <div className="flex items-center justify-between mb-2">
                            <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400 leading-tight">{label}</span>
                            <Icon className={cn('w-3.5 h-3.5 shrink-0', iconColor)} />
                        </div>
                        <div className={cn('text-2xl font-bold tabular-nums', numColor)}>
                            {loading ? <span className="text-slate-300 dark:text-slate-700">—</span> : value}
                        </div>
                    </div>
                ))}
            </div>

            {/* Main Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

                {/* ── LEFT PANEL ── */}
                <div className="space-y-4">

                    {/* Pricing Card */}
                    <Card className="border-slate-200 dark:border-slate-700/60 shadow-sm">
                        <CardHeader className="pb-3 border-b border-slate-100 dark:border-slate-700/60 bg-slate-50/60 dark:bg-slate-800/30 rounded-t-xl">
                            <CardTitle className="text-sm font-medium flex items-center gap-2">
                                <Tag className="w-4 h-4 text-slate-400 dark:text-slate-500" />
                                Upgrade Pricing
                            </CardTitle>
                            <CardDescription className="text-xs">Set costs for each membership tier.</CardDescription>
                        </CardHeader>
                        <CardContent className="pt-4 space-y-3">
                            <div className="grid grid-cols-2 gap-2">
                                {([['3d', '3 Days'], ['14d', '14 Days'], ['30d', '30 Days']] as const).map(([key, label]) => (
                                    <div key={key} className="space-y-1">
                                        <Label className="text-[11px] text-slate-500 dark:text-slate-400">{label} (GHS)</Label>
                                        <Input
                                            type="number"
                                            value={prices[key]}
                                            onChange={e => setPrices({ ...prices, [key]: e.target.value })}
                                            className="h-8 text-sm font-medium"
                                        />
                                    </div>
                                ))}
                                <div className="space-y-1">
                                    <Label className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
                                        <ShieldCheck className="w-3 h-3 text-indigo-500" /> Permanent (GHS)
                                    </Label>
                                    <Input
                                        type="number"
                                        value={prices['permanent']}
                                        onChange={e => setPrices({ ...prices, 'permanent': e.target.value })}
                                        className="h-8 text-sm font-medium border-indigo-200 dark:border-indigo-800/50"
                                    />
                                </div>
                            </div>
                            <div className="pt-1 border-t border-slate-100 dark:border-slate-700/60 space-y-2">
                                <p className="text-[10px] font-bold text-violet-500 uppercase tracking-widest">Dealer Plans</p>
                                <div className="space-y-1">
                                    <Label className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
                                        <Gem className="w-3 h-3 text-violet-400" /> Dealer 1-Month (GHS)
                                    </Label>
                                    <Input
                                        type="number"
                                        value={dealerPrice1m}
                                        onChange={e => setDealerPrice1m(e.target.value)}
                                        className="h-8 text-sm font-medium border-violet-200 dark:border-violet-800/50"
                                    />
                                </div>
                                <div className="space-y-1">
                                    <Label className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
                                        <Gem className="w-3 h-3 text-violet-500" /> Dealer 3-Month (GHS)
                                    </Label>
                                    <Input
                                        type="number"
                                        value={dealerPrice3m}
                                        onChange={e => setDealerPrice3m(e.target.value)}
                                        className="h-8 text-sm font-medium border-violet-200 dark:border-violet-800/50"
                                    />
                                </div>
                                <div className="space-y-1">
                                    <Label className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
                                        <Gem className="w-3 h-3 text-violet-600" /> Dealer 6-Month (GHS)
                                    </Label>
                                    <Input
                                        type="number"
                                        value={dealerPrice}
                                        onChange={e => setDealerPrice(e.target.value)}
                                        className="h-8 text-sm font-medium border-violet-200 dark:border-violet-800/50"
                                    />
                                </div>
                            </div>
                            <div className="flex items-center gap-2 pt-1">
                                <Checkbox
                                    id="strike"
                                    checked={showStrikethrough}
                                    onCheckedChange={v => setShowStrikethrough(v as boolean)}
                                />
                                <Label htmlFor="strike" className="text-[11px] text-slate-600 dark:text-slate-400 cursor-pointer">
                                    Show old prices with strikethrough
                                </Label>
                            </div>
                            <Button
                                className="w-full h-9 text-sm font-medium bg-slate-900 hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200"
                                onClick={handleSavePrices}
                                disabled={isSavingPrices}
                            >
                                {isSavingPrices
                                    ? <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
                                    : <Save className="w-3.5 h-3.5 mr-2" />}
                                Save Prices
                            </Button>
                        </CardContent>
                    </Card>

                    {/* Promos Card */}
                    <Card className="border-slate-200 dark:border-slate-700/60 shadow-sm">
                        <CardHeader className="pb-3 border-b border-slate-100 dark:border-slate-700/60 bg-slate-50/60 dark:bg-slate-800/30 rounded-t-xl">
                            <CardTitle className="text-sm font-medium flex items-center gap-2">
                                <Gift className="w-4 h-4 text-emerald-500" />
                                Signup Promos
                            </CardTitle>
                            <CardDescription className="text-xs">Grant new users a free role on signup.</CardDescription>
                        </CardHeader>
                        <CardContent className="pt-4 space-y-3">
                            {/* Dealer Promo */}
                            <div className="flex items-start justify-between gap-3 p-3 rounded-lg border border-violet-100 dark:border-violet-900/40 bg-violet-50/40 dark:bg-violet-950/20">
                                <div className="space-y-0.5">
                                    <div className="flex items-center gap-1.5 flex-wrap">
                                        <Gem className="w-3.5 h-3.5 text-violet-500" />
                                        <span className="text-xs font-medium text-slate-800 dark:text-slate-200">Dealer Promo</span>
                                        {signupPromoRole === 'dealer' && (
                                            <Badge className="bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-800/60 text-[10px] px-1.5 py-0 h-4">Active</Badge>
                                        )}
                                    </div>
                                    <p className="text-[11px] text-slate-500 dark:text-slate-400">Free 1-month Dealer on signup.</p>
                                </div>
                                <Switch
                                    checked={signupPromoRole === 'dealer'}
                                    disabled={isSavingPromo}
                                    onCheckedChange={v => handleSavePromo(v ? 'dealer' : null)}
                                />
                            </div>

                            {/* Agent Promo */}
                            <div className="flex items-start justify-between gap-3 p-3 rounded-lg border border-blue-100 dark:border-blue-900/40 bg-blue-50/40 dark:bg-blue-950/20">
                                <div className="space-y-0.5">
                                    <div className="flex items-center gap-1.5 flex-wrap">
                                        <Sparkles className="w-3.5 h-3.5 text-blue-500" />
                                        <span className="text-xs font-medium text-slate-800 dark:text-slate-200">Agent Promo</span>
                                        {signupPromoRole === 'agent' && (
                                            <Badge className="bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800/60 text-[10px] px-1.5 py-0 h-4">Active</Badge>
                                        )}
                                    </div>
                                    <p className="text-[11px] text-slate-500 dark:text-slate-400">Free 3-day Agent trial on signup.</p>
                                </div>
                                <Switch
                                    checked={signupPromoRole === 'agent'}
                                    disabled={isSavingPromo}
                                    onCheckedChange={v => handleSavePromo(v ? 'agent' : null)}
                                />
                            </div>

                            {isSavingPromo && (
                                <div className="flex items-center gap-1.5 text-[11px] text-slate-400 dark:text-slate-500 justify-center">
                                    <Loader2 className="w-3 h-3 animate-spin" /> Saving…
                                </div>
                            )}
                            <p className="text-[11px] text-slate-400 dark:text-slate-500 border-t border-slate-100 dark:border-slate-700/60 pt-2">
                                Only one promo can be active at a time.
                            </p>
                        </CardContent>
                    </Card>

                    {/* Assign Role Card */}
                    <Card className="border-slate-200 dark:border-slate-700/60 shadow-sm">
                        <CardHeader className="pb-3 border-b border-slate-100 dark:border-slate-700/60 bg-slate-50/60 dark:bg-slate-800/30 rounded-t-xl">
                            <CardTitle className="text-sm font-medium flex items-center gap-2">
                                <UserPlus className="w-4 h-4 text-slate-400 dark:text-slate-500" />
                                Assign Role
                            </CardTitle>
                            <CardDescription className="text-xs">Grant agent or dealer access to any user.</CardDescription>
                        </CardHeader>
                        <CardContent className="pt-4 space-y-3">
                            {/* Role toggle */}
                            <div className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800">
                                {(['agent', 'dealer'] as const).map(r => (
                                    <button
                                        key={r}
                                        onClick={() => setAssignRole(r)}
                                        className={cn(
                                            'py-1.5 rounded-md text-xs font-medium transition-all',
                                            assignRole === r
                                                ? 'bg-white dark:bg-slate-700 shadow-sm text-slate-900 dark:text-slate-100'
                                                : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'
                                        )}
                                    >
                                        {r === 'agent' ? (
                                            <span className="flex items-center justify-center gap-1">
                                                <Crown className="w-3 h-3 text-amber-500" /> Agent
                                            </span>
                                        ) : (
                                            <span className="flex items-center justify-center gap-1">
                                                <Gem className="w-3 h-3 text-violet-500" /> Dealer
                                            </span>
                                        )}
                                    </button>
                                ))}
                            </div>

                            {/* Duration picker (agent only) */}
                            {assignRole === 'agent' && (
                                <div className="space-y-1.5">
                                    <Label className="text-[11px] text-slate-500 dark:text-slate-400">Duration</Label>
                                    <div className="grid grid-cols-2 gap-1.5">
                                        {(['3d', '14d', '30d', 'permanent'] as const).map(d => (
                                            <button
                                                key={d}
                                                onClick={() => setAssignDuration(d)}
                                                className={cn(
                                                    'py-1.5 px-2 rounded-md text-[11px] font-medium border transition-all',
                                                    assignDuration === d
                                                        ? d === 'permanent'
                                                            ? 'bg-indigo-600 text-white border-indigo-600'
                                                            : 'bg-amber-500 text-white border-amber-500'
                                                        : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-slate-300 dark:hover:border-slate-600 bg-white dark:bg-slate-900'
                                                )}
                                            >
                                                {DURATION_LABELS[d]}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {assignRole === 'dealer' && (
                                <div className="text-[11px] text-violet-700 dark:text-violet-400 bg-violet-50 dark:bg-violet-950/30 border border-violet-100 dark:border-violet-900/40 rounded-md px-3 py-2">
                                    Dealer assignment requires a Lifetime Agent (6-month fixed term).
                                </div>
                            )}

                            {/* User search */}
                            {selectedAssignUser ? (
                                <div className="flex items-center justify-between bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/60 rounded-lg px-3 py-2.5">
                                    <div>
                                        <p className="text-xs font-medium text-slate-900 dark:text-slate-100">
                                            {selectedAssignUser.first_name} {selectedAssignUser.last_name}
                                        </p>
                                        <p className="text-[11px] text-slate-500 dark:text-slate-400">{selectedAssignUser.email}</p>
                                    </div>
                                    <button
                                        onClick={() => { setSelectedAssignUser(null); setAssignSearchQ('') }}
                                        aria-label="Remove selected user"
                                    >
                                        <X className="w-3.5 h-3.5 text-slate-400 hover:text-red-500 transition-colors" />
                                    </button>
                                </div>
                            ) : (
                                <div className="relative">
                                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                                    <Input
                                        placeholder={assignRole === 'dealer' ? 'Search lifetime agents…' : 'Search users…'}
                                        value={assignSearchQ}
                                        onChange={e => setAssignSearchQ(e.target.value)}
                                        className="pl-8 h-9 text-xs"
                                    />
                                    {isSearchingAssign && (
                                        <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 animate-spin text-slate-400" />
                                    )}
                                    {assignResults.length > 0 && (
                                        <div className="absolute z-20 w-full mt-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg overflow-hidden">
                                            {assignResults.map(u => (
                                                <button
                                                    key={u.id}
                                                    className="w-full text-left px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-700/60 transition-colors border-b border-slate-100 dark:border-slate-700/60 last:border-0"
                                                    onClick={() => { setSelectedAssignUser(u); setAssignSearchQ(''); setAssignResults([]) }}
                                                >
                                                    <p className="text-xs font-medium text-slate-900 dark:text-slate-100">
                                                        {u.first_name} {u.last_name}
                                                    </p>
                                                    <p className="text-[11px] text-slate-500 dark:text-slate-400">{u.email}</p>
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                    {assignSearchQ && !isSearchingAssign && assignResults.length === 0 && (
                                        <div className="absolute z-20 w-full mt-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg px-3 py-2.5 text-[11px] text-slate-500 dark:text-slate-400">
                                            No users found for "{assignSearchQ}"
                                        </div>
                                    )}
                                </div>
                            )}

                            <Button
                                className={cn(
                                    'w-full h-9 text-sm font-medium',
                                    assignRole === 'dealer'
                                        ? 'bg-violet-600 hover:bg-violet-700 text-white'
                                        : 'bg-amber-500 hover:bg-amber-600 text-white'
                                )}
                                onClick={handleAssign}
                                disabled={!selectedAssignUser || isAssigning}
                            >
                                {isAssigning
                                    ? <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
                                    : <UserPlus className="w-3.5 h-3.5 mr-2" />}
                                {assignRole === 'dealer'
                                    ? 'Assign Dealer (6 mo)'
                                    : `Assign Agent (${DURATION_LABELS[assignDuration]})`}
                            </Button>
                        </CardContent>
                    </Card>
                </div>

                {/* ── RIGHT PANEL — User Table ── */}
                <Card className="lg:col-span-2 border-slate-200 dark:border-slate-700/60 shadow-sm flex flex-col min-h-[500px]">
                    {/* Filter bar */}
                    <div className="p-4 border-b border-slate-200 dark:border-slate-700/60 space-y-3">
                        <div className="relative">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                            <Input
                                placeholder="Search by name or email…"
                                value={searchTerm}
                                onChange={e => setSearchTerm(e.target.value)}
                                className="pl-9 h-9 text-xs"
                            />
                        </div>
                        <div className="flex items-center justify-between flex-wrap gap-2">
                            <div className="flex flex-wrap gap-1.5">
                                {/* Role chips */}
                                {([['all', 'All'], ['agent', 'Agents'], ['dealer', 'Dealers']] as const).map(([val, label]) => (
                                    <button
                                        key={val}
                                        onClick={() => setRoleFilter(val)}
                                        className={cn(
                                            'px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors',
                                            roleFilter === val
                                                ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900'
                                                : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'
                                        )}
                                    >
                                        {label}
                                    </button>
                                ))}
                                <span className="text-slate-200 dark:text-slate-700 select-none">|</span>
                                {/* Status chips */}
                                {([
                                    ['all', 'All Status', ''],
                                    ['active', 'Active', 'bg-emerald-600 text-white'],
                                    ['expiring', 'Expiring', 'bg-amber-500 text-white'],
                                    ['expired', 'Expired', 'bg-red-600 text-white'],
                                ] as const).map(([val, label, activeClass]) => (
                                    <button
                                        key={val}
                                        onClick={() => setStatusFilter(val)}
                                        className={cn(
                                            'px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors',
                                            statusFilter === val
                                                ? (activeClass || 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900')
                                                : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'
                                        )}
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>
                            <span className="text-[11px] text-slate-400 dark:text-slate-500 tabular-nums">
                                {displayedUsers.length} user{displayedUsers.length !== 1 ? 's' : ''}
                            </span>
                        </div>
                    </div>

                    <CardContent className="p-0 flex-1">
                        {loading ? (
                            <div className="flex items-center justify-center py-24">
                                <Loader2 className="w-6 h-6 animate-spin text-slate-300 dark:text-slate-600" />
                            </div>
                        ) : displayedUsers.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-24 space-y-3">
                                <Users className="w-10 h-10 text-slate-200 dark:text-slate-700" />
                                <p className="text-sm text-slate-400 dark:text-slate-500">No users match your filters.</p>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="text-xs h-8"
                                    onClick={() => { setSearchTerm(''); setRoleFilter('all'); setStatusFilter('all') }}
                                >
                                    Clear filters
                                </Button>
                            </div>
                        ) : (
                            <>
                                {/* Desktop Table */}
                                <div className="hidden md:block overflow-x-auto">
                                    <table className="w-full text-xs">
                                        <thead>
                                            <tr className="bg-slate-50/80 dark:bg-slate-800/40 border-b border-slate-100 dark:border-slate-700/60">
                                                <th className="px-5 py-3 text-left text-[11px] font-medium text-slate-500 dark:text-slate-400">User</th>
                                                <th className="px-5 py-3 text-left text-[11px] font-medium text-slate-500 dark:text-slate-400">Role</th>
                                                <th className="px-5 py-3 text-left text-[11px] font-medium text-slate-500 dark:text-slate-400">Status</th>
                                                <th className="px-5 py-3 text-center text-[11px] font-medium text-slate-500 dark:text-slate-400">Days Left</th>
                                                <th className="px-5 py-3 text-right text-[11px] font-medium text-slate-500 dark:text-slate-400">Actions</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-slate-100 dark:divide-slate-700/40">
                                            {displayedUsers.map(user => {
                                                const days = getDaysLeft(user)
                                                const status = getUserStatus(user)
                                                const { width, colorClass } = getProgressProps(user, days)
                                                return (
                                                    <tr
                                                        key={`${user.role}-${user.id}`}
                                                        className="hover:bg-slate-50/60 dark:hover:bg-slate-800/30 transition-colors"
                                                    >
                                                        <td className="px-5 py-3.5">
                                                            <div className="flex items-center gap-2.5">
                                                                <div className={cn(
                                                                    'w-7 h-7 rounded-full flex items-center justify-center text-white text-[10px] font-semibold shrink-0',
                                                                    user.role === 'dealer' ? 'bg-violet-500' : 'bg-amber-500'
                                                                )}>
                                                                    {(user.first_name?.[0] || user.email?.[0] || '?').toUpperCase()}
                                                                </div>
                                                                <div>
                                                                    <div className="flex items-center gap-1.5 flex-wrap">
                                                                        <p className="font-medium text-slate-900 dark:text-slate-100">
                                                                            {user.first_name} {user.last_name}
                                                                        </p>
                                                                        {user.auto_upgrade_enabled && (
                                                                            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 border border-green-200 dark:border-green-700/40">
                                                                                <Zap className="w-2.5 h-2.5 fill-current" />
                                                                                AUTO
                                                                            </span>
                                                                        )}
                                                                    </div>
                                                                    <p className="text-[11px] text-slate-400 dark:text-slate-500">{user.email}</p>
                                                                </div>
                                                            </div>
                                                        </td>
                                                        <td className="px-5 py-3.5">
                                                            {user.role === 'dealer' ? (
                                                                <Badge className="bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-800/60 text-[10px] font-medium gap-0.5">
                                                                    <Gem className="w-2.5 h-2.5" /> Dealer
                                                                </Badge>
                                                            ) : (
                                                                <Badge className="bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800/60 text-[10px] font-medium gap-0.5">
                                                                    <Crown className="w-2.5 h-2.5" /> Agent
                                                                </Badge>
                                                            )}
                                                        </td>
                                                        <td className="px-5 py-3.5">
                                                            {status === 'permanent' && (
                                                                <Badge className="bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 border-indigo-200 dark:border-indigo-800/60 text-[10px] font-medium gap-0.5">
                                                                    <ShieldCheck className="w-2.5 h-2.5" /> Lifetime
                                                                </Badge>
                                                            )}
                                                            {status === 'active' && (
                                                                <Badge className="bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800/60 text-[10px] font-medium">Active</Badge>
                                                            )}
                                                            {status === 'expiring' && (
                                                                <Badge className="bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800/60 text-[10px] font-medium">Expiring</Badge>
                                                            )}
                                                            {status === 'expired' && (
                                                                <Badge className="bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800/60 text-[10px] font-medium">Expired</Badge>
                                                            )}
                                                        </td>
                                                        <td className="px-5 py-3.5">
                                                            <div className="flex flex-col items-center gap-1">
                                                                {days === null ? (
                                                                    <span className="text-[11px] font-medium text-indigo-600 dark:text-indigo-400">∞</span>
                                                                ) : (
                                                                    <>
                                                                        <span className={cn(
                                                                            'text-sm font-bold tabular-nums',
                                                                            days <= 7 ? 'text-red-600 dark:text-red-400' : 'text-slate-900 dark:text-slate-100'
                                                                        )}>
                                                                            {days}
                                                                        </span>
                                                                        <div className="w-14 h-1 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden">
                                                                            <svg width="100%" height="100%" preserveAspectRatio="none">
                                                                                <rect width={width} height="100%" className={colorClass} />
                                                                            </svg>
                                                                        </div>
                                                                    </>
                                                                )}
                                                            </div>
                                                        </td>
                                                        <td className="px-5 py-3.5 text-right">
                                                            <DropdownMenu>
                                                                <DropdownMenuTrigger asChild>
                                                                    <Button variant="ghost" size="icon" className="h-7 w-7">
                                                                        <MoreVertical className="w-3.5 h-3.5" />
                                                                    </Button>
                                                                </DropdownMenuTrigger>
                                                                <DropdownMenuContent align="end" className="text-xs min-w-[160px]">
                                                                    {status !== 'permanent' && (
                                                                        <DropdownMenuItem
                                                                            className="text-xs gap-2"
                                                                            onClick={() => { setExtendUser(user); setExtendDays('30') }}
                                                                        >
                                                                            <Plus className="w-3.5 h-3.5 text-blue-500" /> Extend Days
                                                                        </DropdownMenuItem>
                                                                    )}
                                                                    {status !== 'permanent' && (
                                                                        <DropdownMenuItem
                                                                            className="text-xs gap-2"
                                                                            onClick={() => { setReduceUser(user); setReduceDays(user.role === 'dealer' ? '7' : '3') }}
                                                                        >
                                                                            <History className="w-3.5 h-3.5 text-orange-500" /> Reduce Days
                                                                        </DropdownMenuItem>
                                                                    )}
                                                                    {user.role === 'agent' && status !== 'permanent' && (
                                                                        <>
                                                                            <DropdownMenuSeparator />
                                                                            <DropdownMenuItem
                                                                                className="text-xs gap-2 text-indigo-600 dark:text-indigo-400 focus:bg-indigo-50 dark:focus:bg-indigo-950/30 focus:text-indigo-700 dark:focus:text-indigo-300"
                                                                                onClick={() => setPermanentUser(user)}
                                                                            >
                                                                                <ShieldCheck className="w-3.5 h-3.5" /> Make Permanent
                                                                            </DropdownMenuItem>
                                                                        </>
                                                                    )}
                                                                    {user.role === 'dealer' && (
                                                                        <>
                                                                            <DropdownMenuSeparator />
                                                                            <DropdownMenuItem
                                                                                className="text-xs gap-2 text-amber-600 dark:text-amber-400 focus:bg-amber-50 dark:focus:bg-amber-950/30 focus:text-amber-700 dark:focus:text-amber-300"
                                                                                onClick={() => setExpireUser(user)}
                                                                            >
                                                                                <Timer className="w-3.5 h-3.5" /> Expire Now
                                                                            </DropdownMenuItem>
                                                                        </>
                                                                    )}
                                                                </DropdownMenuContent>
                                                            </DropdownMenu>
                                                        </td>
                                                    </tr>
                                                )
                                            })}
                                        </tbody>
                                    </table>
                                </div>

                                {/* Mobile Cards */}
                                <div className="md:hidden space-y-3 p-4">
                                    {displayedUsers.map(user => {
                                        const days = getDaysLeft(user)
                                        const status = getUserStatus(user)
                                        return (
                                            <div
                                                key={`${user.role}-${user.id}`}
                                                className="border border-slate-200 dark:border-slate-700/60 rounded-xl p-4 bg-white dark:bg-slate-900 space-y-3"
                                            >
                                                <div className="flex items-start justify-between gap-2">
                                                    <div className="flex items-center gap-2.5 min-w-0">
                                                        <div className={cn(
                                                            'w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-semibold shrink-0',
                                                            user.role === 'dealer' ? 'bg-violet-500' : 'bg-amber-500'
                                                        )}>
                                                            {(user.first_name?.[0] || '?').toUpperCase()}
                                                        </div>
                                                        <div className="min-w-0">
                                                            <p className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
                                                                {user.first_name} {user.last_name}
                                                            </p>
                                                            <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">{user.email}</p>
                                                        </div>
                                                    </div>
                                                    <div className="flex flex-col items-end gap-1 shrink-0">
                                                        {user.role === 'dealer' ? (
                                                            <Badge className="bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-800/60 text-[10px] gap-0.5">
                                                                <Gem className="w-2.5 h-2.5" /> Dealer
                                                            </Badge>
                                                        ) : (
                                                            <Badge className="bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800/60 text-[10px] gap-0.5">
                                                                <Crown className="w-2.5 h-2.5" /> Agent
                                                            </Badge>
                                                        )}
                                                        {status === 'permanent' && <Badge className="bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 border-indigo-200 dark:border-indigo-800/60 text-[10px]">Lifetime</Badge>}
                                                        {status === 'active' && <Badge className="bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800/60 text-[10px]">Active</Badge>}
                                                        {status === 'expiring' && <Badge className="bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800/60 text-[10px]">Expiring</Badge>}
                                                        {status === 'expired' && <Badge className="bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800/60 text-[10px]">Expired</Badge>}
                                                    </div>
                                                </div>

                                                <div className="flex items-center justify-between bg-slate-50 dark:bg-slate-800/50 rounded-lg px-3 py-2">
                                                    <span className="text-[11px] text-slate-500 dark:text-slate-400">Days left</span>
                                                    {days === null ? (
                                                        <span className="text-xs font-medium text-indigo-600 dark:text-indigo-400">∞ Lifetime</span>
                                                    ) : (
                                                        <span className={cn(
                                                            'text-sm font-bold tabular-nums',
                                                            days <= 7 ? 'text-red-600 dark:text-red-400' : 'text-slate-900 dark:text-slate-100'
                                                        )}>
                                                            {days}d
                                                        </span>
                                                    )}
                                                </div>

                                                <div className="flex gap-2 flex-wrap">
                                                    {status !== 'permanent' && (
                                                        <>
                                                            <Button
                                                                size="sm"
                                                                variant="outline"
                                                                className="flex-1 h-8 text-[11px] text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-800/60 hover:bg-blue-50 dark:hover:bg-blue-950/30"
                                                                onClick={() => { setExtendUser(user); setExtendDays('30') }}
                                                            >
                                                                <Plus className="w-3 h-3 mr-1" /> Extend
                                                            </Button>
                                                            <Button
                                                                size="sm"
                                                                variant="outline"
                                                                className="flex-1 h-8 text-[11px] text-orange-600 dark:text-orange-400 border-orange-200 dark:border-orange-800/60 hover:bg-orange-50 dark:hover:bg-orange-950/30"
                                                                onClick={() => { setReduceUser(user); setReduceDays(user.role === 'dealer' ? '7' : '3') }}
                                                            >
                                                                <History className="w-3 h-3 mr-1" /> Reduce
                                                            </Button>
                                                        </>
                                                    )}
                                                    {user.role === 'agent' && status !== 'permanent' && (
                                                        <Button
                                                            size="sm"
                                                            variant="outline"
                                                            className="flex-1 h-8 text-[11px] text-indigo-600 dark:text-indigo-400 border-indigo-200 dark:border-indigo-800/60 hover:bg-indigo-50 dark:hover:bg-indigo-950/30"
                                                            onClick={() => setPermanentUser(user)}
                                                        >
                                                            <ShieldCheck className="w-3 h-3 mr-1" /> Permanent
                                                        </Button>
                                                    )}
                                                    {user.role === 'dealer' && (
                                                        <Button
                                                            size="sm"
                                                            variant="outline"
                                                            className="flex-1 h-8 text-[11px] text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-800/60 hover:bg-amber-50 dark:hover:bg-amber-950/30"
                                                            onClick={() => setExpireUser(user)}
                                                        >
                                                            <Timer className="w-3 h-3 mr-1" /> Expire Now
                                                        </Button>
                                                    )}
                                                </div>
                                            </div>
                                        )
                                    })}
                                </div>
                            </>
                        )}
                    </CardContent>
                </Card>
            </div>

            {/* ── DIALOGS ── */}

            {/* Extend */}
            <Dialog open={!!extendUser} onOpenChange={() => setExtendUser(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle className="text-base font-semibold">Extend Subscription</DialogTitle>
                        <DialogDescription className="text-sm flex items-center gap-2">
                            Add days for <strong>{extendUser?.first_name} {extendUser?.last_name}</strong>
                            <Badge className={cn(
                                'text-[10px] ml-1',
                                extendUser?.role === 'dealer'
                                    ? 'bg-violet-100 text-violet-700 border-violet-200 dark:bg-violet-900/30 dark:text-violet-300 dark:border-violet-800/60'
                                    : 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800/60'
                            )}>
                                {extendUser?.role}
                            </Badge>
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-3 py-2">
                        <Label className="text-xs text-slate-500 dark:text-slate-400">Days to Add</Label>
                        <Input
                            type="number"
                            value={extendDays}
                            onChange={e => setExtendDays(e.target.value)}
                            min="1"
                            className="font-medium"
                        />
                        <div className="flex gap-1.5 flex-wrap">
                            {(extendUser?.role === 'dealer' ? [7, 14, 30, 60, 90, 180] : [3, 7, 14, 30]).map(d => (
                                <Badge
                                    key={d}
                                    variant="outline"
                                    className="cursor-pointer text-xs border-blue-300 dark:border-blue-700 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/30"
                                    onClick={() => setExtendDays(d.toString())}
                                >
                                    +{d}d
                                </Badge>
                            ))}
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" className="text-sm" onClick={() => setExtendUser(null)}>Cancel</Button>
                        <Button className="text-sm bg-blue-600 hover:bg-blue-700" onClick={handleExtend} disabled={isExtending}>
                            {isExtending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plus className="w-4 h-4 mr-2" />}
                            Extend Days
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Reduce */}
            <Dialog open={!!reduceUser} onOpenChange={() => setReduceUser(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle className="text-base font-semibold">Reduce Subscription</DialogTitle>
                        <DialogDescription className="text-sm">
                            Subtract days from <strong>{reduceUser?.first_name} {reduceUser?.last_name}</strong>'s membership.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-3 py-2">
                        <Label className="text-xs text-slate-500 dark:text-slate-400">Days to Reduce</Label>
                        <Input
                            type="number"
                            value={reduceDays}
                            onChange={e => setReduceDays(e.target.value)}
                            min="1"
                            className="font-medium"
                        />
                        <div className="flex gap-1.5 flex-wrap">
                            {(reduceUser?.role === 'dealer' ? [7, 14, 30] : [3, 7, 14, 30]).map(d => (
                                <Badge
                                    key={d}
                                    variant="outline"
                                    className="cursor-pointer text-xs border-orange-300 dark:border-orange-700 text-orange-600 dark:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-950/30"
                                    onClick={() => setReduceDays(d.toString())}
                                >
                                    {d}d
                                </Badge>
                            ))}
                        </div>
                        <p className="text-[11px] text-orange-600 dark:text-orange-400">
                            If reduction causes expiry, a notification will be sent.
                        </p>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" className="text-sm" onClick={() => setReduceUser(null)}>Cancel</Button>
                        <Button className="text-sm bg-orange-600 hover:bg-orange-700" onClick={handleReduce} disabled={isReducing}>
                            {isReducing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <History className="w-4 h-4 mr-2" />}
                            Reduce Days
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Make Permanent */}
            <Dialog open={!!permanentUser} onOpenChange={() => setPermanentUser(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle className="text-base font-semibold flex items-center gap-2">
                            <ShieldCheck className="w-5 h-5 text-indigo-500" /> Make Permanent Agent
                        </DialogTitle>
                        <DialogDescription className="text-sm">
                            Grant <strong>{permanentUser?.first_name} {permanentUser?.last_name}</strong> permanent lifetime access.
                            They will receive an SMS and email notification.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" className="text-sm" onClick={() => setPermanentUser(null)}>Cancel</Button>
                        <Button className="text-sm bg-indigo-600 hover:bg-indigo-700" onClick={handleMakePermanent} disabled={isMakingPermanent}>
                            {isMakingPermanent ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <ShieldCheck className="w-4 h-4 mr-2" />}
                            Confirm Permanent
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Expire Now */}
            <Dialog open={!!expireUser} onOpenChange={() => setExpireUser(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle className="text-base font-semibold flex items-center gap-2 text-amber-700 dark:text-amber-400">
                            <Timer className="w-5 h-5" /> Expire Dealer Now
                        </DialogTitle>
                        <DialogDescription className="text-sm">
                            Immediately expire <strong>{expireUser?.first_name} {expireUser?.last_name}</strong>'s dealer
                            subscription. Their role will be automatically downgraded to Lifetime Agent within 6 hours.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" className="text-sm" onClick={() => setExpireUser(null)}>Cancel</Button>
                        <Button className="text-sm bg-amber-600 hover:bg-amber-700 text-white" onClick={handleExpireNow} disabled={isExpiring}>
                            {isExpiring ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Timer className="w-4 h-4 mr-2" />}
                            Expire Now
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
