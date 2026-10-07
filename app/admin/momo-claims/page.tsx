'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { supabase } from '@/lib/supabase'
import { formatCurrency, formatDate } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Skeleton } from '@/components/ui/skeleton'
import {
    Loader2, Search, Eye, Ban, UserCheck,
    CheckCircle2, Clock, XCircle, AlertTriangle,
    Smartphone, RefreshCw, Plus, Trash2, Save, Settings2,
    Calendar
} from 'lucide-react'
import {
    format,
    startOfDay,
    endOfDay,
    subDays,
    startOfWeek,
    startOfMonth,
    isWithinInterval,
    parseISO,
    isSameDay
} from 'date-fns'
import { toast } from '@/lib/toast'
import {
    Dialog, DialogContent, DialogHeader,
    DialogTitle, DialogDescription
} from '@/components/ui/dialog'
import {
    Select, SelectContent, SelectItem,
    SelectTrigger, SelectValue
} from '@/components/ui/select'

interface MomoTransaction {
    id: string
    transaction_id: string
    amount: number
    sender_name: string
    sender_network: string
    raw_sms: string
    status: 'pending' | 'claimed' | 'voided' | 'flagged'
    claimed_by: string | null
    claimed_at: string | null
    claim_fee_percent: number
    claim_fee_amount: number
    net_amount: number | null
    created_at: string
    // joined
    claimer_name?: string
}

interface ClaimAttempt {
    user_id: string
    count: number
    user_name: string
}

interface Stats {
    total: number
    pending: number
    claimed: number
    voided: number
    flagged: number
    totalCredited: number
}

interface MomoSettings {
    momo_claim_enabled: boolean
    momo_payment_accounts: { network: string; number: string }[]
    momo_account_name: string
    momo_claim_fee_customer: string
    momo_claim_fee_agent: string
    momo_min_claimable: string
    momo_max_claimable: string
}

const EMPTY_ACCOUNT = (): { network: string; number: string } => ({ network: 'MTN Mobile Money', number: '' })

const NETWORK_OPTIONS = [
    'MTN Mobile Money',
    'Telecel Cash',
    'AirtelTigo Money',
]

const NETWORK_COLORS: Record<string, string> = {
    MTN: 'bg-yellow-100 text-yellow-800 border-yellow-300',
    Telecel: 'bg-red-100 text-red-800 border-red-300',
    AirtelTigo: 'bg-blue-100 text-blue-800 border-blue-300',
    Unknown: 'bg-gray-100 text-gray-700 border-gray-300',
}

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: any }> = {
    pending:  { label: 'Pending',  color: 'bg-amber-100 text-amber-800 border-amber-300',   icon: Clock },
    claimed:  { label: 'Claimed',  color: 'bg-green-100 text-green-800 border-green-300',   icon: CheckCircle2 },
    voided:   { label: 'Voided',   color: 'bg-gray-100 text-gray-600 border-gray-300',      icon: XCircle },
    flagged:  { label: 'Flagged',  color: 'bg-red-100 text-red-800 border-red-300',         icon: AlertTriangle },
}

export default function MomoClaimsAdminPage() {
    const { isAdmin, isSubAdmin } = useAuth()
    const [transactions, setTransactions] = useState<MomoTransaction[]>([])
    const [stats, setStats] = useState<Stats>({ total: 0, pending: 0, claimed: 0, voided: 0, flagged: 0, totalCredited: 0 })
    const [attempts, setAttempts] = useState<ClaimAttempt[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [statusFilter, setStatusFilter] = useState<string>('all')
    const [networkFilter, setNetworkFilter] = useState<string>('all')
    const [searchQuery, setSearchQuery] = useState('')
    const [rawSmsModal, setRawSmsModal] = useState<{ open: boolean; sms: string; txnId: string }>({ open: false, sms: '', txnId: '' })
    // Date filtering state
    const [timePeriod, setTimePeriod] = useState('Today')
    const [isCustomDialogOpen, setIsCustomDialogOpen] = useState(false)
    const [customStart, setCustomStart] = useState('')
    const [customEnd, setCustomEnd] = useState('')
    const [actionLoading, setActionLoading] = useState<string | null>(null)
    // References tab state
    const [references, setReferences] = useState<any[]>([])
    const [refsLoading, setRefsLoading] = useState(false)

    // Settings tab state
    const [settings, setSettings] = useState<MomoSettings>({
        momo_claim_enabled: true,
        momo_payment_accounts: [EMPTY_ACCOUNT()],
        momo_account_name: '',
        momo_claim_fee_customer: '0',
        momo_claim_fee_agent: '0',
        momo_min_claimable: '1',
        momo_max_claimable: '50000',
    })
    const [isSavingSettings, setIsSavingSettings] = useState(false)

    const fetchReferences = useCallback(async () => {
        setRefsLoading(true)
        try {
            const res = await fetch('/api/admin/momo-references')
            const data = await res.json()
            if (data.success) {
                setReferences(data.references || [])
            } else {
                toast.error(data.error || 'Failed to load references')
            }
        } catch (e: any) {
            toast.error('Network error loading references')
        } finally {
            setRefsLoading(false)
        }
    }, [])

    const handleToggleRef = async (id: string, is_active: boolean) => {
        try {
            const res = await fetch('/api/admin/momo-references', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, is_active })
            })
            const data = await res.json()
            if (data.success) {
                toast.success('Reference updated')
                fetchReferences()
            } else {
                toast.error(data.error || 'Failed to update')
            }
        } catch (e) {
            toast.error('Network error')
        }
    }

    const handleDeleteRef = async (id: string) => {
        if (!confirm('Are you sure you want to delete this reference? The user will need to generate a new one.')) return
        try {
            const res = await fetch('/api/admin/momo-references', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id })
            })
            const data = await res.json()
            if (data.success) {
                toast.success('Reference deleted')
                fetchReferences()
            } else {
                toast.error(data.error || 'Failed to delete')
            }
        } catch (e) {
            toast.error('Network error')
        }
    }

    const fetchData = useCallback(async () => {
        setIsLoading(true)
        try {
            const res = await fetch('/api/admin/momo-claims')
            const data = await res.json()
            if (!data.success) throw new Error(data.error || 'Failed to fetch')

            const txnList: MomoTransaction[] = data.transactions || []

            // Enrich with claimer names
            const claimerIds = [...new Set(txnList.filter(t => t.claimed_by).map(t => t.claimed_by!))]
            let claimerMap: Record<string, string> = {}
            if (claimerIds.length > 0) {
                const { data: claimers } = await supabase
                    .from('users')
                    .select('id, first_name, last_name')
                    .in('id', claimerIds)
                claimerMap = ((claimers as any[]) || []).reduce((acc: Record<string, string>, u: any) => {
                    acc[u.id] = `${u.first_name} ${u.last_name}`.trim()
                    return acc
                }, {})
            }

            const enriched = txnList.map(t => ({
                ...t,
                claimer_name: t.claimed_by ? claimerMap[t.claimed_by] || 'Unknown' : undefined,
            }))
            setTransactions(enriched)

            const s: Stats = { total: enriched.length, pending: 0, claimed: 0, voided: 0, flagged: 0, totalCredited: 0 }
            enriched.forEach(t => {
                s[t.status as keyof Pick<Stats, 'pending' | 'claimed' | 'voided' | 'flagged'>]++
                if (t.status === 'claimed' && t.net_amount) s.totalCredited += t.net_amount
            })
            setStats(s)

            if (data.attempts) {
                const countMap: Record<string, number> = {}
                ;(data.attempts as any[]).forEach((a: any) => { countMap[a.user_id] = (countMap[a.user_id] || 0) + 1 })
                const suspicious = Object.entries(countMap).filter(([, c]) => c >= 5).sort(([, a], [, b]) => b - a).slice(0, 10)
                if (suspicious.length > 0) {
                    const userIds = suspicious.map(([id]) => id)
                    const { data: suspUsers } = await supabase.from('users').select('id, first_name, last_name').in('id', userIds)
                    const userMap: Record<string, string> = ((suspUsers as any[]) || []).reduce((acc: Record<string, string>, u: any) => {
                        acc[u.id] = `${u.first_name} ${u.last_name}`.trim(); return acc
                    }, {})
                    setAttempts(suspicious.map(([id, count]) => ({ user_id: id, count, user_name: userMap[id] || 'Unknown' })))
                } else { setAttempts([]) }
            }

            // Populate settings tab from API response
            if (data.settings) {
                const s = data.settings
                setSettings({
                    momo_claim_enabled: s.momo_claim_enabled,
                    momo_payment_accounts: s.momo_payment_accounts?.length > 0 ? s.momo_payment_accounts : [EMPTY_ACCOUNT()],
                    momo_account_name: s.momo_account_name || '',
                    momo_claim_fee_customer: s.momo_claim_fee_customer || '0',
                    momo_claim_fee_agent: s.momo_claim_fee_agent || '0',
                    momo_min_claimable: s.momo_min_claimable || '1',
                    momo_max_claimable: s.momo_max_claimable || '50000',
                })
            }

        } catch (e: any) {
            toast.error('Failed to load MoMo claims data')
            console.error(e)
        } finally {
            setIsLoading(false)
        }
    }, [])

    useEffect(() => {
        if (isAdmin || isSubAdmin) {
            fetchData()
            if (isAdmin) fetchReferences()
        }
    }, [isAdmin, isSubAdmin, fetchData, fetchReferences])

    const handleVoid = async (txn: MomoTransaction) => {
        if (!confirm(`Void transaction ${txn.transaction_id}? The user will no longer be able to claim it.`)) return
        setActionLoading(txn.id)
        try {
            const res = await fetch('/api/admin/momo-claims', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: txn.id, status: 'voided' })
            })
            const data = await res.json()
            if (!data.success) throw new Error(data.error)
            toast.success(`Transaction ${txn.transaction_id} voided`)
            fetchData()
        } catch (e: any) {
            toast.error('Failed to void transaction')
        } finally {
            setActionLoading(null)
        }
    }

    const handleUndoVoid = async (txn: MomoTransaction) => {
        setActionLoading(txn.id)
        try {
            const res = await fetch('/api/admin/momo-claims', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: txn.id, status: 'pending' })
            })
            const data = await res.json()
            if (!data.success) throw new Error(data.error)
            toast.success('Transaction restored to pending')
            fetchData()
        } catch (e: any) {
            toast.error('Failed to restore transaction')
        } finally {
            setActionLoading(null)
        }
    }

    // ── Filtered list (with date filtering) ─────────────────────
    const filtered = useMemo(() => {
        return transactions.filter(t => {
            if (statusFilter !== 'all' && t.status !== statusFilter) return false
            if (networkFilter !== 'all' && t.sender_network !== networkFilter) return false
            if (searchQuery) {
                const q = searchQuery.toLowerCase()
                if (
                    !t.transaction_id.includes(q) &&
                    !t.sender_name.toLowerCase().includes(q) &&
                    !(t.claimer_name || '').toLowerCase().includes(q)
                ) return false
            }
            // Time Period
            if (timePeriod === 'All') return true
            const date = parseISO(t.created_at)
            const now = new Date()
            if (timePeriod === 'Today') return isSameDay(date, now)
            if (timePeriod === 'Yesterday') return isSameDay(date, subDays(now, 1))
            if (timePeriod === 'This Week') return isWithinInterval(date, { start: startOfWeek(now), end: endOfDay(now) })
            if (timePeriod === 'This Month') return isWithinInterval(date, { start: startOfMonth(now), end: endOfDay(now) })
            if (timePeriod === 'Custom' && customStart && customEnd) {
                return isWithinInterval(date, {
                    start: startOfDay(new Date(customStart)),
                    end: endOfDay(new Date(customEnd))
                })
            }
            return true
        })
    }, [transactions, statusFilter, networkFilter, searchQuery, timePeriod, customStart, customEnd])

    // ── Stats recalculated from filtered set ─────────────────
    const filteredStats = useMemo(() => {
        const s: Stats = { total: filtered.length, pending: 0, claimed: 0, voided: 0, flagged: 0, totalCredited: 0 }
        filtered.forEach(t => {
            s[t.status as keyof Pick<Stats, 'pending' | 'claimed' | 'voided' | 'flagged'>]++
            if (t.status === 'claimed' && t.net_amount) s.totalCredited += t.net_amount
        })
        return s
    }, [filtered])

    const handleSaveSettings = async () => {
        setIsSavingSettings(true)
        try {
            const res = await fetch('/api/admin/momo-claims', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(settings),
            })
            const data = await res.json()
            if (!data.success) throw new Error(data.error || 'Failed to save')
            toast.success('MoMo settings saved successfully')
        } catch (e: any) {
            toast.error(e.message || 'Failed to save settings')
        } finally {
            setIsSavingSettings(false)
        }
    }

    if (!isAdmin && !isSubAdmin) {
        return (
            <div className="p-8 text-center text-muted-foreground">
                You do not have permission to view this page.
            </div>
        )
    }

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold flex items-center gap-2">
                        <Smartphone className="w-6 h-6 text-indigo-500" />
                        MoMo Claims
                    </h1>
                    <p className="text-muted-foreground text-sm mt-1">
                        Monitor and manage all MoMo Transaction ID claims
                    </p>
                </div>
                <Button variant="outline" onClick={fetchData} disabled={isLoading} size="sm">
                    <RefreshCw className={`w-4 h-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
                    Refresh
                </Button>
            </div>

            <Tabs defaultValue="monitoring">
                <TabsList>
                    <TabsTrigger value="monitoring">📊 Monitoring</TabsTrigger>
                    {isAdmin && <TabsTrigger value="references"><UserCheck className="w-4 h-4 mr-1" />User References</TabsTrigger>}
                    {isAdmin && <TabsTrigger value="settings"><Settings2 className="w-4 h-4 mr-1" />Settings</TabsTrigger>}
                </TabsList>

            <TabsContent value="monitoring" className="space-y-6 mt-4">
            {/* Stat Cards */}
            {isLoading ? (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                    {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-20" />)}
                </div>
            ) : (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                    {[
                        { label: 'Total', value: filteredStats.total, color: 'text-indigo-600', bg: 'bg-indigo-50' },
                        { label: 'Pending', value: filteredStats.pending, color: 'text-amber-600', bg: 'bg-amber-50' },
                        { label: 'Claimed', value: filteredStats.claimed, color: 'text-green-600', bg: 'bg-green-50' },
                        { label: 'Voided', value: filteredStats.voided, color: 'text-gray-500', bg: 'bg-gray-50' },
                        { label: 'Flagged', value: filteredStats.flagged, color: 'text-red-600', bg: 'bg-red-50' },
                        { label: 'Total Credited', value: formatCurrency(filteredStats.totalCredited), color: 'text-emerald-700', bg: 'bg-emerald-50', isAmount: true },
                    ].map((s) => (
                        <Card key={s.label} className={`${s.bg} border-0`}>
                            <CardContent className="p-4">
                                <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">{s.label}</p>
                                <p className={`text-xl font-bold mt-1 ${s.color}`}>{s.value}</p>
                            </CardContent>
                        </Card>
                    ))}
                </div>
            )}

            {/* Filters */}
            <div className="flex flex-wrap gap-3 items-center">
                <div className="relative flex-1 min-w-[200px]">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                        placeholder="Search by TXN ID, sender, or claimer..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="pl-9"
                    />
                </div>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                    <SelectTrigger className="w-36">
                        <SelectValue placeholder="Status" />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">All Status</SelectItem>
                        <SelectItem value="pending">Pending</SelectItem>
                        <SelectItem value="claimed">Claimed</SelectItem>
                        <SelectItem value="voided">Voided</SelectItem>
                        <SelectItem value="flagged">Flagged</SelectItem>
                    </SelectContent>
                </Select>
                <Select value={networkFilter} onValueChange={setNetworkFilter}>
                    <SelectTrigger className="w-36">
                        <SelectValue placeholder="Network" />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">All Networks</SelectItem>
                        <SelectItem value="MTN">MTN</SelectItem>
                        <SelectItem value="Telecel">Telecel</SelectItem>
                        <SelectItem value="AirtelTigo">AirtelTigo</SelectItem>
                    </SelectContent>
                </Select>
                <Select value={timePeriod} onValueChange={(val) => {
                    if (val === 'Custom') setIsCustomDialogOpen(true)
                    else setTimePeriod(val)
                }}>
                    <SelectTrigger className="w-36">
                        <Calendar className="w-4 h-4 mr-1 text-muted-foreground" />
                        <SelectValue placeholder="Time" />
                    </SelectTrigger>
                    <SelectContent>
                        {['Today', 'Yesterday', 'This Week', 'This Month', 'All', 'Custom'].map(period => (
                            <SelectItem key={period} value={period}>{period}</SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>

            {/* Transactions Table */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Transactions ({filtered.length})</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                    {isLoading ? (
                        <div className="p-6 space-y-3">
                            {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-14" />)}
                        </div>
                    ) : filtered.length === 0 ? (
                        <div className="p-12 text-center text-muted-foreground">
                            <Smartphone className="w-12 h-12 mx-auto mb-4 opacity-30" />
                            <p>No transactions found</p>
                        </div>
                    ) : (
                        <>
                        {/* Mobile Card View */}
                        <div className="md:hidden divide-y">
                            {filtered.map((txn) => {
                                const sc = STATUS_CONFIG[txn.status]
                                const StatusIcon = sc.icon
                                return (
                                    <div key={txn.id} className="p-4 space-y-3">
                                        <div className="flex items-center justify-between">
                                            <code className="text-xs font-bold text-slate-700 dark:text-slate-300">{txn.transaction_id}</code>
                                            <Badge variant="outline" className={`text-[10px] gap-1 ${sc.color}`}>
                                                <StatusIcon className="w-3 h-3" /> {sc.label}
                                            </Badge>
                                        </div>
                                        <div className="flex items-center justify-between">
                                            <span className="text-sm font-medium text-slate-900 dark:text-white">{txn.sender_name}</span>
                                            <Badge variant="outline" className={`text-[10px] ${NETWORK_COLORS[txn.sender_network] || NETWORK_COLORS.Unknown}`}>
                                                {txn.sender_network}
                                            </Badge>
                                        </div>
                                        <div className="flex items-center justify-between text-xs bg-muted/40 rounded-lg px-3 py-2">
                                            <div className="text-center">
                                                <p className="text-muted-foreground">Amount</p>
                                                <p className="font-bold">{formatCurrency(txn.amount)}</p>
                                            </div>
                                            <span className="text-muted-foreground">→</span>
                                            <div className="text-center">
                                                <p className="text-muted-foreground">Fee</p>
                                                <p className="font-bold text-rose-600">{txn.claim_fee_amount > 0 ? `-${formatCurrency(txn.claim_fee_amount)}` : 'Free'}</p>
                                            </div>
                                            <span className="text-muted-foreground">→</span>
                                            <div className="text-center">
                                                <p className="text-muted-foreground">Net</p>
                                                <p className="font-bold text-emerald-700">{txn.net_amount ? formatCurrency(txn.net_amount) : '—'}</p>
                                            </div>
                                        </div>
                                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                                            <span>{txn.claimer_name ? `Claimed by ${txn.claimer_name}` : 'Unclaimed'}</span>
                                            <span>{formatDate(txn.created_at)}</span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <Button variant="outline" size="sm" className="h-8 text-xs flex-1"
                                                onClick={() => setRawSmsModal({ open: true, sms: txn.raw_sms || '(no raw SMS saved)', txnId: txn.transaction_id })}
                                            >
                                                <Eye className="w-3 h-3 mr-1" /> View SMS
                                            </Button>
                                            {(txn.status === 'pending' || txn.status === 'flagged') && (
                                                <Button variant="outline" size="sm" className="h-8 text-xs text-red-500 border-red-200 hover:bg-red-50"
                                                    disabled={actionLoading === txn.id} onClick={() => handleVoid(txn)}
                                                >
                                                    {actionLoading === txn.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <><Ban className="w-3 h-3 mr-1" /> Void</>}
                                                </Button>
                                            )}
                                            {txn.status === 'voided' && (
                                                <Button variant="outline" size="sm" className="h-8 text-xs text-green-600 border-green-200 hover:bg-green-50"
                                                    disabled={actionLoading === txn.id} onClick={() => handleUndoVoid(txn)}
                                                >
                                                    {actionLoading === txn.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <><UserCheck className="w-3 h-3 mr-1" /> Restore</>}
                                                </Button>
                                            )}
                                        </div>
                                    </div>
                                )
                            })}
                        </div>

                        {/* Desktop Table View */}
                        <div className="hidden md:block overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead className="bg-muted/40 border-b">
                                    <tr>
                                        {['Transaction ID', 'Sender', 'Network', 'Amount', 'Fee', 'Net', 'Status', 'Claimed By', 'Received', 'Actions'].map(h => (
                                            <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground whitespace-nowrap">{h}</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody className="divide-y">
                                    {filtered.map((txn) => {
                                        const sc = STATUS_CONFIG[txn.status]
                                        const StatusIcon = sc.icon
                                        return (
                                            <tr key={txn.id} className="hover:bg-muted/20 transition-colors">
                                                <td className="px-4 py-3 font-mono text-xs font-semibold">{txn.transaction_id}</td>
                                                <td className="px-4 py-3 whitespace-nowrap font-medium">{txn.sender_name}</td>
                                                <td className="px-4 py-3">
                                                    <Badge variant="outline" className={`text-xs ${NETWORK_COLORS[txn.sender_network] || NETWORK_COLORS.Unknown}`}>
                                                        {txn.sender_network}
                                                    </Badge>
                                                </td>
                                                <td className="px-4 py-3 font-semibold">{formatCurrency(txn.amount)}</td>
                                                <td className="px-4 py-3 text-rose-600">{txn.claim_fee_amount > 0 ? `-${formatCurrency(txn.claim_fee_amount)}` : <span className="text-emerald-600">Free</span>}</td>
                                                <td className="px-4 py-3 font-bold text-emerald-700">{txn.net_amount ? formatCurrency(txn.net_amount) : '—'}</td>
                                                <td className="px-4 py-3">
                                                    <Badge variant="outline" className={`text-xs gap-1 ${sc.color}`}>
                                                        <StatusIcon className="w-3 h-3" />
                                                        {sc.label}
                                                    </Badge>
                                                </td>
                                                <td className="px-4 py-3 text-xs text-muted-foreground">
                                                    {txn.claimer_name || '—'}
                                                    {txn.claimed_at && (
                                                        <div className="text-[10px] text-muted-foreground/70">{formatDate(txn.claimed_at)}</div>
                                                    )}
                                                </td>
                                                <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">{formatDate(txn.created_at)}</td>
                                                <td className="px-4 py-3">
                                                    <div className="flex items-center gap-1">
                                                        <Button variant="ghost" size="icon" className="h-7 w-7" title="View Raw SMS"
                                                            onClick={() => setRawSmsModal({ open: true, sms: txn.raw_sms || '(no raw SMS saved)', txnId: txn.transaction_id })}
                                                        >
                                                            <Eye className="w-3.5 h-3.5" />
                                                        </Button>
                                                        {(txn.status === 'pending' || txn.status === 'flagged') ? (
                                                            <Button variant="ghost" size="icon" className="h-7 w-7 text-red-500 hover:bg-red-50" title="Void Transaction"
                                                                disabled={actionLoading === txn.id} onClick={() => handleVoid(txn)}
                                                            >
                                                                {actionLoading === txn.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Ban className="w-3.5 h-3.5" />}
                                                            </Button>
                                                        ) : txn.status === 'voided' ? (
                                                            <Button variant="ghost" size="icon" className="h-7 w-7 text-green-600 hover:bg-green-50" title="Restore to Pending"
                                                                disabled={actionLoading === txn.id} onClick={() => handleUndoVoid(txn)}
                                                            >
                                                                {actionLoading === txn.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserCheck className="w-3.5 h-3.5" />}
                                                            </Button>
                                                        ) : null}
                                                    </div>
                                                </td>
                                            </tr>
                                        )
                                    })}
                                </tbody>
                            </table>
                        </div>
                        </>
                    )}
                </CardContent>
            </Card>

            {/* Suspicious Activity */}
            {attempts.length > 0 && (
                <Card className="border-red-100 bg-red-50/30">
                    <CardHeader>
                        <CardTitle className="text-base text-red-700 flex items-center gap-2">
                            <AlertTriangle className="w-4 h-4" />
                            Suspicious Activity (Last 24h — ≥5 Lookups)
                        </CardTitle>
                        <CardDescription>Users with unusually high lookup attempt counts. Consider investigating.</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="space-y-2">
                            {attempts.map(a => (
                                <div key={a.user_id} className="flex items-center justify-between p-3 rounded-lg bg-white border border-red-100">
                                    <span className="font-medium text-sm">{a.user_name}</span>
                                    <Badge variant="destructive">{a.count} attempts</Badge>
                                </div>
                            ))}
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* Raw SMS Modal */}
            <Dialog open={rawSmsModal.open} onOpenChange={(o) => setRawSmsModal(prev => ({ ...prev, open: o }))}>
                <DialogContent className="max-w-lg">
                    <DialogHeader>
                        <DialogTitle>Raw SMS — TXN {rawSmsModal.txnId}</DialogTitle>
                        <DialogDescription>Original SMS text received from the Forward SMS app.</DialogDescription>
                    </DialogHeader>
                    <div className="bg-muted rounded-lg p-4 text-sm font-mono whitespace-pre-wrap break-words">
                        {rawSmsModal.sms}
                    </div>
                </DialogContent>
            </Dialog>

            {/* Custom Date Range Dialog */}
            <Dialog open={isCustomDialogOpen} onOpenChange={setIsCustomDialogOpen}>
                <DialogContent className="max-w-sm">
                    <DialogHeader>
                        <DialogTitle>Custom Date Range</DialogTitle>
                        <DialogDescription>Select a start and end date to filter transactions.</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-2">
                        <div className="space-y-2">
                            <Label>From</Label>
                            <Input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} />
                        </div>
                        <div className="space-y-2">
                            <Label>To</Label>
                            <Input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} />
                        </div>
                    </div>
                    <div className="flex gap-2 justify-end">
                        <Button variant="outline" onClick={() => setIsCustomDialogOpen(false)}>Cancel</Button>
                        <Button onClick={() => {
                            if (customStart && customEnd) {
                                setTimePeriod('Custom')
                                setIsCustomDialogOpen(false)
                            } else {
                                toast.error('Please select both start and end dates')
                            }
                        }}>Apply Range</Button>
                    </div>
                </DialogContent>
            </Dialog>
            </TabsContent>

            {/* ── User References Tab ── */}
            {isAdmin && (
            <TabsContent value="references" className="space-y-4 mt-4">
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between">
                        <div>
                            <CardTitle>User Payment References</CardTitle>
                            <CardDescription>Manage unique 5-character reference codes generated by users.</CardDescription>
                        </div>
                        <Button variant="outline" size="sm" onClick={fetchReferences} disabled={refsLoading}>
                            <RefreshCw className={`w-4 h-4 mr-2 ${refsLoading ? 'animate-spin' : ''}`} />
                            Refresh
                        </Button>
                    </CardHeader>
                    <CardContent>
                        {refsLoading ? (
                            <div className="space-y-3">
                                {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
                            </div>
                        ) : references.length === 0 ? (
                            <div className="text-center py-8 text-muted-foreground">
                                No user references generated yet.
                            </div>
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="w-full text-sm">
                                    <thead className="bg-muted/40 border-b">
                                        <tr>
                                            <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground">Reference</th>
                                            <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground">User</th>
                                            <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground">Created</th>
                                            <th className="text-center px-4 py-3 text-xs font-semibold text-muted-foreground">Status</th>
                                            <th className="text-right px-4 py-3 text-xs font-semibold text-muted-foreground">Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y">
                                        {references.map((r: any) => (
                                            <tr key={r.id} className="hover:bg-muted/20 transition-colors">
                                                <td className="px-4 py-3">
                                                    <span className="font-mono font-bold tracking-widest text-base bg-slate-100 dark:bg-slate-800 px-2 py-1 rounded">
                                                        {r.reference_code}
                                                    </span>
                                                </td>
                                                <td className="px-4 py-3">
                                                    <p className="font-medium">{r.users?.first_name} {r.users?.last_name}</p>
                                                    <p className="text-xs text-muted-foreground">{r.users?.phone_number}</p>
                                                </td>
                                                <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                                                    {formatDate(r.created_at)}
                                                </td>
                                                <td className="px-4 py-3 text-center">
                                                    <Badge variant={r.is_active ? 'outline' : 'destructive'} className={r.is_active ? 'border-emerald-200 text-emerald-600 bg-emerald-50 dark:bg-emerald-950 dark:border-emerald-800' : ''}>
                                                        {r.is_active ? 'Active' : 'Disabled'}
                                                    </Badge>
                                                </td>
                                                <td className="px-4 py-3">
                                                    <div className="flex items-center justify-end gap-2">
                                                        <Switch 
                                                            checked={r.is_active}
                                                            onCheckedChange={(v) => handleToggleRef(r.id, v)}
                                                            title={r.is_active ? "Disable reference" : "Enable reference"}
                                                        />
                                                        <Button 
                                                            variant="ghost" 
                                                            size="icon" 
                                                            className="h-8 w-8 text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950" 
                                                            title="Delete reference permanently"
                                                            onClick={() => handleDeleteRef(r.id)}
                                                        >
                                                            <Trash2 className="w-4 h-4" />
                                                        </Button>
                                                    </div>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </CardContent>
                </Card>
            </TabsContent>
            )}

            {/* ── Settings Tab ── */}
            {isAdmin && (
            <TabsContent value="settings" className="space-y-4 mt-4">
                {/* Enable Toggle */}
                <Card>
                    <CardHeader>
                        <CardTitle>MoMo Claim Feature</CardTitle>
                        <CardDescription>Enable or disable the entire MoMo claim system for all users.</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="flex items-center justify-between p-4 border rounded-lg">
                            <div>
                                <Label className="text-base">Enable MoMo Claims</Label>
                                <p className="text-sm text-muted-foreground">When disabled, the claim card is hidden and API returns 503.</p>
                            </div>
                            <Switch
                                checked={settings.momo_claim_enabled}
                                onCheckedChange={(v) => setSettings(p => ({ ...p, momo_claim_enabled: v }))}
                            />
                        </div>
                    </CardContent>
                </Card>

                {/* Payment Accounts */}
                <Card>
                    <CardHeader>
                        <CardTitle>Payment Accounts</CardTitle>
                        <CardDescription>MoMo numbers users will send money to. Account name is shown below the numbers.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="space-y-2">
                            <Label>Account Name (Display Only)</Label>
                            <Input
                                value={settings.momo_account_name}
                                onChange={(e) => setSettings(p => ({ ...p, momo_account_name: e.target.value }))}
                                placeholder="e.g. Felix Boahen"
                                maxLength={80}
                            />
                        </div>
                        <div className="space-y-3">
                            <Label>Payment Numbers</Label>
                            {settings.momo_payment_accounts.map((acct, i) => (
                                <div key={i} className="grid grid-cols-[180px_1fr_auto] gap-2 items-end">
                                    <div className="space-y-1">
                                        {i === 0 && <p className="text-xs text-muted-foreground">Network</p>}
                                        <select
                                            value={acct.network}
                                            aria-label={`Network for account ${i + 1}`}
                                            onChange={(e) => {
                                                const updated = [...settings.momo_payment_accounts]
                                                updated[i] = { ...updated[i], network: e.target.value }
                                                setSettings(p => ({ ...p, momo_payment_accounts: updated }))
                                            }}
                                            className="w-full h-9 rounded-md border border-input bg-background px-3 py-1 text-sm"
                                        >
                                            {NETWORK_OPTIONS.map(n => <option key={n} value={n}>{n}</option>)}
                                        </select>
                                    </div>
                                    <div className="space-y-1">
                                        {i === 0 && <p className="text-xs text-muted-foreground">MoMo Number</p>}
                                        <Input
                                            placeholder="e.g. 0551617309"
                                            value={acct.number}
                                            onChange={(e) => {
                                                const updated = [...settings.momo_payment_accounts]
                                                updated[i] = { ...updated[i], number: e.target.value }
                                                setSettings(p => ({ ...p, momo_payment_accounts: updated }))
                                            }}
                                        />
                                    </div>
                                    <Button
                                        type="button" variant="ghost" size="icon"
                                        className="text-destructive hover:bg-destructive/10"
                                        onClick={() => setSettings(p => ({ ...p, momo_payment_accounts: p.momo_payment_accounts.filter((_, idx) => idx !== i) }))}
                                    >
                                        <Trash2 className="w-4 h-4" />
                                    </Button>
                                </div>
                            ))}
                            <Button type="button" variant="outline" size="sm"
                                onClick={() => setSettings(p => ({ ...p, momo_payment_accounts: [...p.momo_payment_accounts, EMPTY_ACCOUNT()] }))}
                            >
                                <Plus className="w-4 h-4 mr-1" /> Add Payment Number
                            </Button>
                        </div>
                    </CardContent>
                </Card>

                {/* Claim Fees */}
                <Card>
                    <CardHeader>
                        <CardTitle>Claim Fees (Role-Based)</CardTitle>
                        <CardDescription>Percentage deducted from the claimed amount. Set to 0 for no charge. Applied server-side — users cannot bypass this.</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="space-y-2">
                                <Label>Customer Claim Fee (%)</Label>
                                <Input type="number" min="0" max="100" step="0.01"
                                    value={settings.momo_claim_fee_customer}
                                    onChange={(e) => setSettings(p => ({ ...p, momo_claim_fee_customer: e.target.value }))}
                                />
                                <p className="text-xs text-muted-foreground">0 = no charge for customers</p>
                            </div>
                            <div className="space-y-2">
                                <Label>Agent Claim Fee (%)</Label>
                                <Input type="number" min="0" max="100" step="0.01"
                                    value={settings.momo_claim_fee_agent}
                                    onChange={(e) => setSettings(p => ({ ...p, momo_claim_fee_agent: e.target.value }))}
                                />
                                <p className="text-xs text-muted-foreground">0 = no charge for agents</p>
                            </div>
                        </div>
                    </CardContent>
                </Card>

                {/* Amount Limits */}
                <Card>
                    <CardHeader>
                        <CardTitle>Accepted Amount Range</CardTitle>
                        <CardDescription>Shown to users on the wallet page. Claims below minimum are blocked server-side.</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="space-y-2">
                                <Label>Minimum Claimable Amount (GHS)</Label>
                                <Input type="number" min="0" step="0.01"
                                    value={settings.momo_min_claimable}
                                    onChange={(e) => setSettings(p => ({ ...p, momo_min_claimable: e.target.value }))}
                                />
                            </div>
                            <div className="space-y-2">
                                <Label>Maximum Claimable Amount (GHS)</Label>
                                <Input type="number" min="0" step="0.01"
                                    value={settings.momo_max_claimable}
                                    onChange={(e) => setSettings(p => ({ ...p, momo_max_claimable: e.target.value }))}
                                />
                            </div>
                        </div>
                    </CardContent>
                </Card>

                <Button onClick={handleSaveSettings} disabled={isSavingSettings} className="w-full md:w-auto">
                    {isSavingSettings ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                    Save MoMo Settings
                </Button>
            </TabsContent>
            )}
            </Tabs>
        </div>
    )
}
