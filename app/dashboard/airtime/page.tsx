'use client'

import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { Phone, CheckCircle, Copy, Wallet, AlertTriangle, Loader2, ChevronRight, Info, History, X, ArrowRight, RefreshCw, Search, Calendar, TrendingUp, Coins, Clock, CalendarRange, Zap, Wifi, Mic2 } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { supabase } from '@/lib/supabase'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { format, endOfDay, subDays, startOfWeek, startOfMonth, isWithinInterval, startOfDay, parseISO, isSameDay } from 'date-fns'

// ─── Constants ────────────────────────────────────────────────────────────────
const NETWORKS = [
    { id: 'MTN', label: 'MTN', accent: 'text-amber-600 dark:text-amber-400', prefixes: ['024', '054', '055', '059', '025', '053'] },
    { id: 'Telecel', label: 'Telecel', accent: 'text-red-600 dark:text-red-400', prefixes: ['020', '050'] },
    { id: 'AT', label: 'AirtelTigo', accent: 'text-orange-600 dark:text-orange-400', prefixes: ['027', '057', '026', '056', '028', '058'] },
]

const QUICK_AMOUNTS = [1, 2, 5, 10, 20, 50]

function detectNetwork(phone: string) {
    if (phone.length < 3) return null
    const prefix = phone.slice(0, 3)
    return NETWORKS.find(n => n.prefixes.includes(prefix)) || null
}

function getNetworkWarning(phone: string, selectedNetwork: string | null) {
    if (!selectedNetwork || phone.length < 3) return null
    const auto = detectNetwork(phone)
    if (!auto) return 'Unrecognized prefix — please confirm your network.'
    if (auto.id !== selectedNetwork) return `This number looks like it belongs to ${auto.label}. Please verify before proceeding.`
    return null
}

// ─── Network Logo SVGs ────────────────────────────────────────────────────────
function MTNLogo({ className }: { className?: string }) {
    return (
        <svg viewBox="0 0 60 60" className={cn('w-8 h-8', className)} fill="none">
            <circle cx="30" cy="30" r="30" fill="#FFD200" />
            <text x="50%" y="55%" dominantBaseline="middle" textAnchor="middle" fontSize="20" fontWeight="bold" fill="#1a1a1a">MTN</text>
        </svg>
    )
}
function TelecelLogo({ className }: { className?: string }) {
    return (
        <svg viewBox="0 0 60 60" className={cn('w-8 h-8', className)} fill="none">
            <circle cx="30" cy="30" r="30" fill="#e63946" />
            <text x="50%" y="55%" dominantBaseline="middle" textAnchor="middle" fontSize="11" fontWeight="bold" fill="white">Telecel</text>
        </svg>
    )
}
function ATLogo({ className }: { className?: string }) {
    return (
        <svg viewBox="0 0 60 60" className={cn('w-8 h-8', className)} fill="none">
            <circle cx="30" cy="30" r="30" fill="#F97316" />
            <text x="50%" y="55%" dominantBaseline="middle" textAnchor="middle" fontSize="16" fontWeight="bold" fill="white">AT</text>
        </svg>
    )
}

const NetworkLogo = ({ id, className }: { id: string; className?: string }) => {
    if (id === 'MTN') return <MTNLogo className={className} />
    if (id === 'Telecel') return <TelecelLogo className={className} />
    return <ATLogo className={className} />
}

interface AirtimeSettings {
    fee_mtn_customer: number; fee_mtn_agent: number; fee_mtn_dealer: number
    fee_telecel_customer: number; fee_telecel_agent: number; fee_telecel_dealer: number
    fee_at_customer: number; fee_at_agent: number; fee_at_dealer: number
    min_amount: number; max_amount: number
    mashup_fee: number; mashup_min: number; mashup_max: number
    enabled_mtn: boolean; enabled_telecel: boolean; enabled_at: boolean
    mashup_dashboard_enabled: boolean
}

interface AirtimeOrder {
    id: string; reference_code: string; network: string; beneficiary_phone: string
    airtime_amount: number; fee_amount: number; total_paid: number
    status: string; created_at: string; use_exact_amount: boolean
    type?: 'airtime' | 'mashup'
    bundle_preference?: 'balanced' | 'data' | 'voice' | null
}

type BundlePreference = 'balanced' | 'data' | 'voice'

// ─── Mashup Bundle Calculator (Hybrid Tier Logic) ────────────────────────────
function calcMashupBundle(amount: number, pref: BundlePreference): { data: string; voice: string; exact: boolean } {
    const round1 = (n: number) => Math.round(n * 10) / 10
    if (amount <= 0) return { data: '0', voice: '0', exact: false }

    // ≥ GHS 10 — stable zone: fixed multipliers
    if (amount >= 10) {
        const BASE_DATA = 18     // MB per GHS
        const BASE_VOICE = 17.3  // mins per GHS
        let dataMult = BASE_DATA, voiceMult = BASE_VOICE
        if (pref === 'data') { dataMult = BASE_DATA * 1.25; voiceMult = BASE_VOICE * 0.6 }
        if (pref === 'voice') { dataMult = BASE_DATA * 0.6; voiceMult = BASE_VOICE * 1.25 }
        return {
            data: round1(amount * dataMult).toFixed(1) + ' MB',
            voice: round1(amount * voiceMult).toFixed(1) + ' Mins',
            exact: true
        }
    }

    // < GHS 10 — variable zone: tier estimates
    let dataLow: number, dataHigh: number, voiceLow: number, voiceHigh: number
    if (amount <= 2) { dataLow = 15; dataHigh = 16; voiceLow = 15; voiceHigh = 16 }
    else if (amount <= 5) { dataLow = 15; dataHigh = 17.5; voiceLow = 15; voiceHigh = 17 }
    else { dataLow = 17; dataHigh = 18; voiceLow = 16.5; voiceHigh = 17.5 }

    // Preference skew for range display
    if (pref === 'data') { dataHigh *= 1.2; voiceLow *= 0.7; voiceHigh *= 0.8 }
    if (pref === 'voice') { voiceHigh *= 1.2; dataLow *= 0.7; dataHigh *= 0.8 }

    return {
        data: `${round1(amount * dataLow).toFixed(0)}–${round1(amount * dataHigh).toFixed(0)} MB`,
        voice: `${round1(amount * voiceLow).toFixed(0)}–${round1(amount * voiceHigh).toFixed(0)} Mins`,
        exact: false
    }
}

// ─── Status Badge ─────────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: string }) {
    const map: Record<string, string> = {
        pending: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-400 dark:border-amber-900',
        processing: 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-400 dark:border-blue-900',
        completed: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-900',
        failed: 'bg-red-100 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-400 dark:border-red-900',
    }
    return (
        <span className={cn('inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border capitalize', map[status] || 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700')}>
            {status}
        </span>
    )
}

// ─── Success Modal ─────────────────────────────────────────────────────────────
function SuccessModal({ order, onClose, onBuyMore }: { order: AirtimeOrder | null; onClose: () => void; onBuyMore: () => void }) {
    const [copied, setCopied] = useState(false)
    if (!order) return null

    const isMashup = order.type === 'mashup'
    const mashupBundle = isMashup ? calcMashupBundle(order.airtime_amount, order.bundle_preference || 'balanced') : null

    const copy = () => {
        navigator.clipboard.writeText(order.reference_code)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-2xl w-full max-w-sm overflow-hidden animate-in zoom-in-95 duration-200">
                <div className="p-5">
                    <div className="flex items-center gap-3 mb-4">
                        <div className={cn('w-11 h-11 rounded-full border flex items-center justify-center shrink-0', isMashup ? 'bg-amber-50 border-amber-200 dark:bg-amber-950/30 dark:border-amber-900' : 'bg-emerald-50 border-emerald-200 dark:bg-emerald-950/30 dark:border-emerald-900')}>
                            <CheckCircle className={cn('w-6 h-6', isMashup ? 'text-amber-500' : 'text-emerald-500')} />
                        </div>
                        <div className="min-w-0">
                            <h2 className="text-base font-semibold text-slate-900 dark:text-white truncate">{isMashup ? 'Mashup Bundle Placed' : 'Order Placed'}</h2>
                            <p className="text-xs text-slate-500 dark:text-slate-400 truncate">{isMashup ? 'Your MTN Mashup bundle is being processed' : 'Your airtime is being processed'}</p>
                        </div>
                    </div>

                    {/* Mashup bundle breakdown */}
                    {isMashup && mashupBundle && (
                        <div className="grid grid-cols-2 gap-2 mb-4">
                            <div className="flex flex-col items-center justify-center rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 p-3">
                                <Wifi className="w-4 h-4 text-blue-500 mb-1" />
                                <span className="text-xs text-slate-500 dark:text-slate-400">Data</span>
                                <span className="text-sm font-semibold text-slate-900 dark:text-white truncate">{mashupBundle.data}</span>
                                {!mashupBundle.exact && <span className="text-xs text-slate-400">Est. range</span>}
                            </div>
                            <div className="flex flex-col items-center justify-center rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 p-3">
                                <Mic2 className="w-4 h-4 text-purple-500 mb-1" />
                                <span className="text-xs text-slate-500 dark:text-slate-400">Voice</span>
                                <span className="text-sm font-semibold text-slate-900 dark:text-white truncate">{mashupBundle.voice}</span>
                                {!mashupBundle.exact && <span className="text-xs text-slate-400">Est. range</span>}
                            </div>
                        </div>
                    )}

                    <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3 mb-3 space-y-2">
                        <div className="flex justify-between gap-3 text-sm"><span className="text-slate-500 dark:text-slate-400">Network</span><span className="font-medium text-slate-900 dark:text-white truncate">{order.network}</span></div>
                        <div className="flex justify-between gap-3 text-sm"><span className="text-slate-500 dark:text-slate-400">Recipient</span><span className="font-medium text-slate-900 dark:text-white truncate">{order.beneficiary_phone}</span></div>
                        {!isMashup && (
                            <div className="flex justify-between gap-3 text-sm"><span className="text-slate-500 dark:text-slate-400">Airtime</span><span className="font-semibold text-emerald-600 dark:text-emerald-400 tabular-nums">GHS {order.airtime_amount.toFixed(2)}</span></div>
                        )}
                        <div className="flex justify-between gap-3 text-sm border-t border-slate-100 dark:border-slate-800 pt-2"><span className="text-slate-500 dark:text-slate-400">You paid</span><span className="font-semibold text-slate-900 dark:text-white tabular-nums">GHS {order.total_paid.toFixed(2)}</span></div>
                    </div>

                    <button onClick={copy} className="w-full flex items-center justify-between gap-3 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60 rounded-xl px-3 py-2.5 mb-3 transition-colors group min-w-0">
                        <div className="text-left min-w-0">
                            <p className="text-xs text-slate-400">Reference code</p>
                            <p className="font-mono font-medium text-slate-800 dark:text-slate-200 text-sm truncate">{order.reference_code}</p>
                        </div>
                        <Copy className={cn('w-4 h-4 shrink-0 transition-colors', copied ? 'text-emerald-500' : 'text-slate-400 group-hover:text-slate-600')} />
                    </button>

                    <p className="text-xs text-slate-400 mb-4 leading-relaxed">
                        {isMashup ? 'MTN will credit the bundle within minutes. Dial *567*1*6# to verify.' : 'The network provider will send a confirmation SMS once credited.'}
                    </p>

                    <div className="flex gap-2">
                        <Button variant="outline" className="flex-1 rounded-xl h-10" onClick={onBuyMore}>Buy more</Button>
                        <Button className="flex-1 rounded-xl h-10 bg-emerald-600 hover:bg-emerald-700 text-white" onClick={onClose}>
                            History <ChevronRight className="w-4 h-4 ml-1" />
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    )
}

// ─── Confirm Sheet ─────────────────────────────────────────────────────────────
function ConfirmSheet({ open, onCancel, onConfirm, isLoading, details }: {
    open: boolean; onCancel: () => void; onConfirm: () => void; isLoading: boolean
    details: { network: string; phone: string; airtime: number; fee: number; total: number; mode: boolean; purchaseMode: 'airtime' | 'mashup'; mashupBundle?: { data: string; voice: string; exact: boolean } | null }
}) {
    if (!open) return null
    const isMashup = details.purchaseMode === 'mashup'
    return (
        <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-2xl w-full max-w-sm animate-in slide-in-from-bottom-4 duration-200">
                <div className="p-5">
                    <h3 className="text-base font-semibold text-slate-900 dark:text-white">{isMashup ? 'Confirm mashup bundle' : 'Confirm payment'}</h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">Please review before proceeding</p>
                    <div className="space-y-2 mb-5">
                        <div className="flex justify-between gap-3 text-sm"><span className="text-slate-500 dark:text-slate-400">Network</span><span className="font-medium text-slate-900 dark:text-white truncate">{details.network}</span></div>
                        <div className="flex justify-between gap-3 text-sm"><span className="text-slate-500 dark:text-slate-400">Recipient</span><span className="font-medium text-slate-900 dark:text-white truncate">{details.phone}</span></div>
                        {isMashup && details.mashupBundle ? (
                            <>
                                <div className="flex justify-between gap-3 text-sm">
                                    <span className="text-slate-500 dark:text-slate-400">Est. data</span>
                                    <span className="font-medium text-slate-900 dark:text-white truncate">{details.mashupBundle.data}</span>
                                </div>
                                <div className="flex justify-between gap-3 text-sm">
                                    <span className="text-slate-500 dark:text-slate-400">Est. voice</span>
                                    <span className="font-medium text-slate-900 dark:text-white truncate">{details.mashupBundle.voice}</span>
                                </div>
                                {!details.mashupBundle.exact && (
                                    <p className="text-xs text-amber-600 dark:text-amber-500">Amounts below GHS 10 are estimated ranges. Actual values set by MTN.</p>
                                )}
                            </>
                        ) : (
                            <div className="flex justify-between gap-3 text-sm"><span className="text-slate-500 dark:text-slate-400">Airtime to send</span><span className="font-semibold text-emerald-600 dark:text-emerald-400 tabular-nums">GHS {details.airtime.toFixed(2)}</span></div>
                        )}
                        <div className="flex justify-between gap-3 text-sm"><span className="text-slate-500 dark:text-slate-400">Service fee</span><span className="font-medium text-slate-900 dark:text-white tabular-nums">GHS {details.fee.toFixed(2)}</span></div>
                        <div className="flex justify-between gap-3 text-sm border-t border-slate-100 dark:border-slate-800 pt-2.5 mt-1">
                            <span className="font-medium text-slate-700 dark:text-slate-300">Total to pay</span>
                            <span className="font-semibold text-base text-slate-900 dark:text-white tabular-nums">GHS {details.total.toFixed(2)}</span>
                        </div>
                    </div>
                    <div className="flex gap-2">
                        <Button variant="outline" className="flex-1 rounded-xl h-10" onClick={onCancel} disabled={isLoading}>Cancel</Button>
                        <Button
                            className="flex-1 rounded-xl h-10 bg-emerald-600 hover:bg-emerald-700 text-white"
                            onClick={onConfirm}
                            disabled={isLoading}
                        >
                            {isLoading ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Processing…</> : <>Confirm &amp; pay <ArrowRight className="w-4 h-4 ml-1" /></>}
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    )
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function AirtimePage() {
    const { dbUser } = useAuth()
    const [activeTab, setActiveTab] = useState<'buy' | 'history'>('buy')

    // Settings & wallet
    const [settings, setSettings] = useState<AirtimeSettings | null>(null)
    const [walletBalance, setWalletBalance] = useState<number | null>(null)
    const [userRole, setUserRole] = useState<'customer' | 'agent' | 'dealer'>('customer')
    const [settingsLoading, setSettingsLoading] = useState(true)

    // Form state
    const [selectedNetwork, setSelectedNetwork] = useState<string | null>(null)
    const [isManualSelection, setIsManualSelection] = useState(false)
    const [phone, setPhone] = useState('')
    const [amount, setAmount] = useState('')
    const [useExact, setUseExact] = useState(true)

    // UI state
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [showConfirm, setShowConfirm] = useState(false)
    const [successOrder, setSuccessOrder] = useState<AirtimeOrder | null>(null)

    // Mashup mode
    const [purchaseMode, setPurchaseMode] = useState<'airtime' | 'mashup'>('airtime')
    const [bundlePreference, setBundlePreference] = useState<BundlePreference>('balanced')

    // History & Filtering
    const [orders, setOrders] = useState<AirtimeOrder[]>([])
    const [historyLoading, setHistoryLoading] = useState(false)
    const [searchQuery, setSearchQuery] = useState('')
    const [timePeriod, setTimePeriod] = useState('Today')
    const [isCustomDialogOpen, setIsCustomDialogOpen] = useState(false)
    const [customStart, setCustomStart] = useState('')
    const [customEnd, setCustomEnd] = useState('')
    const [typeFilter, setTypeFilter] = useState<'all' | 'airtime' | 'mashup'>('all')

    // Load settings + wallet
    useEffect(() => {
        const loadData = async () => {
            if (!dbUser) return
            setSettingsLoading(true)
            try {
                // NOT /api/admin/airtime/settings — that route is admin/sub-admin
                // gated and 401s for every ordinary customer, which silently left
                // `settings` null here and hid the Mashup toggle (it has no fallback:
                // `settings?.mashup_dashboard_enabled && (...)`) while Airtime still
                // rendered. This mirror requires only a session, not a role.
                const settingsRes = await fetch('/api/user/airtime-settings')
                if (settingsRes.ok) {
                    const { settings: raw } = await settingsRes.json()
                    const lr = ['customer', 'agent', 'dealer'].includes(dbUser.role as string) ? (dbUser.role as string) : 'customer'
                    const limDef: Record<string, { min: string; max: string }> = { customer: { min: '1', max: '500' }, agent: { min: '1', max: '1000' }, dealer: { min: '1', max: '2000' } }
                    const feeDef: Record<string, string> = { customer: '5', agent: '3', dealer: '2' }
                    setSettings({
                        fee_mtn_customer: parseFloat(raw.airtime_fee_mtn_customer || '5'),
                        fee_mtn_agent: parseFloat(raw.airtime_fee_mtn_agent || '3'),
                        fee_mtn_dealer: parseFloat(raw.airtime_fee_mtn_dealer || '2'),
                        fee_telecel_customer: parseFloat(raw.airtime_fee_telecel_customer || '5'),
                        fee_telecel_agent: parseFloat(raw.airtime_fee_telecel_agent || '3'),
                        fee_telecel_dealer: parseFloat(raw.airtime_fee_telecel_dealer || '2'),
                        fee_at_customer: parseFloat(raw.airtime_fee_at_customer || '5'),
                        fee_at_agent: parseFloat(raw.airtime_fee_at_agent || '3'),
                        fee_at_dealer: parseFloat(raw.airtime_fee_at_dealer || '2'),
                        min_amount: parseFloat(raw[`airtime_min_amount_${lr}`] || limDef[lr].min),
                        max_amount: parseFloat(raw[`airtime_max_amount_${lr}`] || limDef[lr].max),
                        mashup_fee: parseFloat(raw[`mashup_fee_mtn_${lr}`] || feeDef[lr]),
                        mashup_min: parseFloat(raw[`mashup_min_amount_${lr}`] || '5'),
                        mashup_max: parseFloat(raw[`mashup_max_amount_${lr}`] || limDef[lr].max),
                        enabled_mtn: raw.airtime_enabled_mtn !== 'false',
                        enabled_telecel: raw.airtime_enabled_telecel !== 'false',
                        enabled_at: raw.airtime_enabled_at !== 'false',
                        mashup_dashboard_enabled: raw.dashboard_mashup_enabled === 'true',
                    })
                }

                const { data: walletData } = await supabase
                    .from('wallets')
                    .select('balance')
                    .eq('user_id', dbUser.id)
                    .single()

                if (walletData) {
                    setWalletBalance((walletData as any).balance || 0)
                    setUserRole((dbUser.role === 'agent' || dbUser.role === 'dealer') ? 'agent' : 'customer')
                }
            } catch (e) {
                console.error('[Airtime] Error loading initial data:', e)
            } finally {
                setSettingsLoading(false)
            }
        }
        loadData()
    }, [dbUser])

    // Mashup gate: fall back to airtime if mashup is disabled on the dashboard.
    useEffect(() => {
        if (settings && !settings.mashup_dashboard_enabled && purchaseMode === 'mashup') {
            setPurchaseMode('airtime')
        }
    }, [settings, purchaseMode])

    // History loader
    const loadHistory = useCallback(async () => {
        setHistoryLoading(true)
        try {
            const res = await fetch('/api/airtime/history')
            if (res.ok) {
                const d = await res.json()
                setOrders(d.orders || [])
            }
        } catch (e) { console.error(e) }
        setHistoryLoading(false)
    }, [])

    useEffect(() => {
        if (activeTab === 'history') loadHistory()
    }, [activeTab, loadHistory])

    // Fee calculation
    const getFeeRate = useCallback(() => {
        if (!settings) return 5
        if (purchaseMode === 'mashup') return settings.mashup_fee || 5
        if (!selectedNetwork) return 5
        const key = `fee_${selectedNetwork.toLowerCase()}_${userRole}` as keyof AirtimeSettings
        return (settings[key] as number) || 5
    }, [settings, selectedNetwork, userRole, purchaseMode])

    const parsedAmount = parseFloat(amount) || 0
    const feeRate = getFeeRate()
    const activeMin = (purchaseMode === 'mashup' ? settings?.mashup_min : settings?.min_amount) || (purchaseMode === 'mashup' ? 5 : 1)
    const activeMax = (purchaseMode === 'mashup' ? settings?.mashup_max : settings?.max_amount) || 500

    let airtimeAmount = 0, feeAmount = 0, totalPaid = 0
    if (parsedAmount > 0) {
        const round2 = (n: number) => Math.round(n * 100) / 100
        if (useExact) {
            airtimeAmount = parsedAmount
            feeAmount = round2(parsedAmount * (feeRate / 100))
            totalPaid = round2(parsedAmount + feeAmount)
        } else {
            totalPaid = parsedAmount
            feeAmount = round2(parsedAmount * (feeRate / 100))
            airtimeAmount = round2(parsedAmount - feeAmount)
        }
    }

    const phoneWarning = phone.length >= 3 ? getNetworkWarning(phone, purchaseMode === 'mashup' ? 'MTN' : selectedNetwork) : null
    const isPhoneValid = /^0\d{9}$/.test(phone)
    const isAmountValid = parsedAmount >= activeMin && parsedAmount <= activeMax
    const hasEnoughBalance = walletBalance !== null && totalPaid > 0 && walletBalance >= totalPaid
    const canProceed = (purchaseMode === 'mashup' || selectedNetwork) && isPhoneValid && isAmountValid && hasEnoughBalance && !isSubmitting

    // Mashup bundle calculation (live)
    const mashupBundle = useMemo(() => calcMashupBundle(parsedAmount, bundlePreference), [parsedAmount, bundlePreference])

    const handlePhoneChange = (val: string) => {
        const clean = val.replace(/\D/g, '')
        setPhone(clean.slice(0, 10))

        if (!isManualSelection) {
            if (clean.length === 0) {
                setSelectedNetwork(null)
            } else if (clean.length >= 3) {
                const auto = detectNetwork(clean)
                if (auto) {
                    setSelectedNetwork(auto.id as string)
                }
            }
        }
    }

    const handleSubmit = async () => {
        if (!canProceed) return
        setIsSubmitting(true)
        setShowConfirm(false)
        try {
            const res = await fetch('/api/airtime/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    beneficiaryPhone: phone,
                    network: purchaseMode === 'mashup' ? 'MTN' : selectedNetwork,
                    amount: parsedAmount,
                    useExactAmount: useExact,
                    type: purchaseMode,
                    bundle_preference: purchaseMode === 'mashup' ? bundlePreference : undefined,
                }),
            })
            const data = await res.json()
            if (!res.ok) {
                toast.error(data.error || 'Failed to place order')
                return
            }
            if (data.walletBalance !== undefined) setWalletBalance(data.walletBalance)
            else if (data.order?.new_balance !== undefined) setWalletBalance(data.order.new_balance)
            setSuccessOrder(data.order)
            setPhone(''); setAmount(''); setSelectedNetwork(null); setUseExact(false); setIsManualSelection(false)
        } catch {
            toast.error('An unexpected error occurred. Please try again.')
        } finally {
            setIsSubmitting(false)
        }
    }

    const handleBuyMore = () => { setSuccessOrder(null); setActiveTab('buy') }
    const handleSuccessClose = () => { setSuccessOrder(null); setActiveTab('history') }

    // Filtering Logic
    const filteredOrders = useMemo(() => {
        return orders.filter(order => {
            // Type Filter
            if (typeFilter !== 'all' && order.type !== typeFilter) return false

            // Search
            const matchesSearch =
                order.beneficiary_phone.toLowerCase().includes(searchQuery.toLowerCase()) ||
                order.reference_code.toLowerCase().includes(searchQuery.toLowerCase())
            if (!matchesSearch) return false

            // Time Period
            if (timePeriod === 'All') return true

            const date = parseISO(order.created_at)
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
    }, [orders, searchQuery, timePeriod, customStart, customEnd, typeFilter])

    // Statistics
    const stats = useMemo(() => {
        const today = new Date()
        return {
            totalSpent: filteredOrders.reduce((acc, o) => acc + (o.status === 'completed' ? o.total_paid : 0), 0),
            totalOrders: filteredOrders.length,
            todaySpent: filteredOrders.reduce((acc, o) => {
                if (o.status === 'completed' && isSameDay(parseISO(o.created_at), today)) {
                    return acc + o.total_paid
                }
                return acc
            }, 0)
        }
    }, [filteredOrders])

    if (settingsLoading) {
        return (
            <div className="min-h-[60vh] flex items-center justify-center">
                <Loader2 className="w-7 h-7 animate-spin text-slate-400" />
            </div>
        )
    }

    const lowBalance = walletBalance !== null && walletBalance < 5

    return (
        <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">
            {/* Page Header */}
            <div className="min-w-0">
                <h1 className="text-lg font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                    <Phone className="w-5 h-5 text-emerald-500 shrink-0" /> Buy airtime & mashup
                </h1>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Top up any network or buy an MTN Mashup bundle from your wallet</p>
            </div>

            {/* Wallet Balance Card */}
            <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-sm">
                <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                        <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                            <Wallet className="w-3.5 h-3.5 shrink-0" /> Wallet balance
                        </div>
                        <div className="text-2xl font-semibold text-slate-900 dark:text-white tabular-nums truncate mt-0.5">
                            GHS {walletBalance !== null ? walletBalance.toFixed(2) : '—'}
                        </div>
                    </div>
                    {lowBalance && (
                        <div className={cn('flex items-center gap-1.5 text-xs font-medium shrink-0', walletBalance! < 1 ? 'text-red-500' : 'text-amber-500')}>
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                            <span className="truncate max-w-[8rem]">{walletBalance! < 1 ? 'Balance too low' : 'Low balance'}</span>
                        </div>
                    )}
                </div>
            </div>

            {/* Mode toggle: Airtime vs Mashup (Mashup hidden when disabled) */}
            <div className="flex bg-slate-100 dark:bg-slate-800/60 rounded-xl p-1 gap-1">
                <button
                    onClick={() => setPurchaseMode('airtime')}
                    className={cn('flex-1 py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2',
                        purchaseMode === 'airtime' ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200')}
                >
                    <Phone className="w-4 h-4" /> Airtime
                </button>
                {settings?.mashup_dashboard_enabled && (
                    <button
                        onClick={() => setPurchaseMode('mashup')}
                        className={cn('flex-1 py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2',
                            purchaseMode === 'mashup' ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200')}
                    >
                        <Zap className={cn('w-4 h-4', purchaseMode === 'mashup' && 'text-amber-500 fill-current')} /> MTN Mashup
                    </button>
                )}
            </div>

            {/* Sub-tab bar (buy / history) */}
            <div className="flex bg-slate-100 dark:bg-slate-800/60 rounded-xl p-1 gap-1">
                {(['buy', 'history'] as const).map(tab => (
                    <button
                        key={tab}
                        onClick={() => setActiveTab(tab)}
                        className={cn(
                            'flex-1 py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2',
                            activeTab === tab
                                ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm'
                                : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
                        )}
                    >
                        {tab === 'buy' ? <Phone className="w-4 h-4" /> : <History className="w-4 h-4" />}
                        {tab === 'buy' ? (purchaseMode === 'mashup' ? 'Buy mashup' : 'Buy airtime') : 'History'}
                    </button>
                ))}
            </div>

            {/* ── BUY TAB ─────────────────────────────────────────────────────────── */}
            {activeTab === 'buy' && (
                <div className="space-y-4 animate-in fade-in duration-200">

                    {/* ── MASHUP MODE UI ── */}
                    {purchaseMode === 'mashup' && (
                        <>
                            {/* Mashup Header */}
                            <div className="rounded-2xl border border-amber-200 dark:border-amber-900/60 bg-amber-50/60 dark:bg-amber-950/20 p-4">
                                <div className="flex items-center gap-2 mb-1">
                                    <Zap className="w-4 h-4 text-amber-500 fill-current shrink-0" />
                                    <span className="text-sm font-semibold text-slate-900 dark:text-white">MTN Mashup bundle</span>
                                </div>
                                <p className="text-xs text-slate-600 dark:text-slate-400">Buy data and voice minutes in one optimized bundle</p>
                            </div>

                            {/* Bundle Preference Selector */}
                            <div>
                                <Label className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2 block">Bundle preference</Label>
                                <div className="grid grid-cols-2 gap-2">
                                    {([
                                        { id: 'balanced', icon: Zap, label: 'Balanced', desc: 'Equal data & minutes' },
                                        { id: 'data', icon: Wifi, label: 'Data focus', desc: 'More data' },
                                    ] as const).map(pref => (
                                        <button
                                            key={pref.id}
                                            onClick={() => setBundlePreference(pref.id)}
                                            className={cn(
                                                'flex flex-col items-start gap-1 p-3 rounded-xl border transition-colors text-left',
                                                bundlePreference === pref.id
                                                    ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-500/60 dark:border-emerald-800'
                                                    : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
                                            )}
                                        >
                                            <pref.icon className={cn('w-4 h-4', bundlePreference === pref.id ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400')} />
                                            <span className={cn('text-sm font-medium', bundlePreference === pref.id ? 'text-emerald-700 dark:text-emerald-400' : 'text-slate-700 dark:text-slate-300')}>{pref.label}</span>
                                            <span className="text-xs text-slate-400 truncate w-full">{pref.desc}</span>
                                        </button>
                                    ))}
                                </div>
                                {bundlePreference === 'balanced' && (
                                    <p className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">Balanced bundle — optimized mix of data and voice based on current MTN rates.</p>
                                )}
                            </div>
                        </>
                    )}

                    {/* ── AIRTIME NETWORK SELECTOR (hidden in Mashup mode) ── */}
                    {purchaseMode === 'airtime' && (
                        <div>
                            <Label className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2 block">Network</Label>
                            <div className="grid grid-cols-3 gap-2">
                                {NETWORKS.map(net => {
                                    const enabledKey = `enabled_${net.id.toLowerCase()}` as keyof AirtimeSettings
                                    const isEnabled = settings ? settings[enabledKey] as boolean : true
                                    const isSelected = selectedNetwork === net.id
                                    return (
                                        <button
                                            key={net.id}
                                            onClick={() => { setSelectedNetwork(net.id); setIsManualSelection(true) }}
                                            disabled={!isEnabled}
                                            className={cn(
                                                'relative flex flex-col items-center gap-2 p-3 rounded-xl border transition-colors',
                                                isSelected
                                                    ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-500/60 dark:border-emerald-800'
                                                    : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700',
                                                !isEnabled && 'opacity-50 cursor-not-allowed'
                                            )}
                                        >
                                            <NetworkLogo id={net.id} className="w-7 h-7" />
                                            <span className={cn('text-xs font-medium truncate max-w-full', isSelected ? 'text-emerald-700 dark:text-emerald-400' : 'text-slate-700 dark:text-slate-300')}>{net.label}</span>
                                            {!isEnabled && (
                                                <span className="absolute top-1.5 right-1.5 bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-400 text-xs px-1.5 rounded-full">Off</span>
                                            )}
                                        </button>
                                    )
                                })}
                            </div>
                        </div>
                    )}

                    <div>
                        <Label htmlFor="beneficiary-phone" className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5 block">
                            Beneficiary phone number
                        </Label>
                        <div className="relative">
                            <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                            <Input
                                id="beneficiary-phone"
                                type="tel"
                                inputMode="numeric"
                                placeholder="0XXXXXXXXX"
                                value={phone}
                                onChange={e => handlePhoneChange(e.target.value)}
                                className="pl-9 rounded-xl h-10 font-mono"
                                maxLength={10}
                            />
                            {phone.length === 10 && (
                                <div className={cn('absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full flex items-center justify-center', isPhoneValid ? 'bg-emerald-100 dark:bg-emerald-950/40' : 'bg-red-100 dark:bg-red-950/40')}>
                                    {isPhoneValid ? <CheckCircle className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" /> : <X className="w-3.5 h-3.5 text-red-600 dark:text-red-400" />}
                                </div>
                            )}
                        </div>
                        {phoneWarning && (
                            <p className="mt-1.5 text-xs text-amber-600 dark:text-amber-500 flex items-center gap-1.5">
                                <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> <span className="truncate">{phoneWarning}</span>
                            </p>
                        )}
                        {phone.length > 0 && phone.length < 10 && (
                            <p className="mt-1.5 text-xs text-slate-400">{10 - phone.length} more digits needed</p>
                        )}
                    </div>

                    <div>
                        <Label className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2 block">Quick amount (GHS)</Label>
                        <div className="flex gap-2 flex-wrap">
                            {QUICK_AMOUNTS.map(q => (
                                <button
                                    key={q}
                                    onClick={() => setAmount(String(q))}
                                    className={cn(
                                        'px-3.5 py-1.5 rounded-lg text-sm font-medium border transition-colors tabular-nums',
                                        amount === String(q)
                                            ? 'bg-emerald-600 border-emerald-600 text-white'
                                            : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-700'
                                    )}
                                >
                                    {q}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div>
                        <Label htmlFor="airtime-amount" className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5 flex items-center gap-2 flex-wrap">
                            Custom amount (GHS)
                            {settings && <span className="text-xs font-normal text-slate-400">Min {activeMin} · Max {activeMax}</span>}
                        </Label>
                        <div className="relative">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">GHS</span>
                            <Input
                                id="airtime-amount"
                                type="number"
                                inputMode="decimal"
                                placeholder="0.00"
                                value={amount}
                                onChange={e => setAmount(e.target.value)}
                                className="pl-12 rounded-xl h-10 tabular-nums"
                                min={activeMin}
                                max={activeMax}
                                step="0.01"
                            />
                        </div>
                    </div>

                    <div
                        onClick={() => setUseExact(!useExact)}
                        className={cn(
                            'flex items-start gap-3 rounded-xl p-4 border transition-colors cursor-pointer select-none',
                            useExact
                                ? 'bg-emerald-50/60 dark:bg-emerald-950/20 border-emerald-500/50 dark:border-emerald-900'
                                : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
                        )}
                    >
                        <div className={cn(
                            'mt-0.5 flex items-center justify-center w-5 h-5 rounded-md border transition-colors shrink-0',
                            useExact
                                ? 'bg-emerald-600 border-emerald-600 text-white'
                                : 'border-slate-300 dark:border-slate-600'
                        )}>
                            {useExact && <CheckCircle className="w-3.5 h-3.5" />}
                        </div>
                        <div className="flex-1 min-w-0 space-y-0.5">
                            <h4 className={cn(
                                'text-sm font-medium',
                                useExact ? 'text-emerald-700 dark:text-emerald-400' : 'text-slate-800 dark:text-slate-200'
                            )}>
                                Pay processing fee separately
                            </h4>
                            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                                {useExact
                                    ? 'Beneficiary receives exactly the amount you type. The service fee is added to your total.'
                                    : 'Standard mode: the service fee is deducted from the amount you type.'}
                            </p>
                        </div>
                    </div>

                    {parsedAmount > 0 && (purchaseMode === 'mashup' || selectedNetwork) && (
                        <div className="rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
                            <div className="px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40">
                                <p className="text-sm font-medium text-slate-700 dark:text-slate-300">{purchaseMode === 'mashup' ? 'Estimated bundle value' : 'Fee breakdown'}</p>
                            </div>
                            <div className="p-4 space-y-2.5 text-sm">
                                {/* MASHUP: Live Estimator */}
                                {purchaseMode === 'mashup' ? (
                                    <>
                                        <div className="grid grid-cols-2 gap-2">
                                            <div className="flex flex-col items-center justify-center rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 p-3">
                                                <Wifi className="w-4 h-4 text-blue-500 mb-1" />
                                                <span className="text-xs text-slate-500 dark:text-slate-400">Data</span>
                                                <span className="text-base font-semibold text-slate-900 dark:text-white truncate">{mashupBundle.data}</span>
                                                {!mashupBundle.exact && <span className="text-xs text-slate-400">Estimated range</span>}
                                            </div>
                                            <div className="flex flex-col items-center justify-center rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 p-3">
                                                <Mic2 className="w-4 h-4 text-purple-500 mb-1" />
                                                <span className="text-xs text-slate-500 dark:text-slate-400">Voice</span>
                                                <span className="text-base font-semibold text-slate-900 dark:text-white truncate">{mashupBundle.voice}</span>
                                                {!mashupBundle.exact && <span className="text-xs text-slate-400">Estimated range</span>}
                                            </div>
                                        </div>
                                        {!mashupBundle.exact && (
                                            <p className="text-xs text-amber-600 dark:text-amber-500 text-center">Amounts below GHS 10 show estimated ranges. Actual values are set by MTN.</p>
                                        )}
                                        <div className="flex justify-between gap-3"><span className="text-slate-500 dark:text-slate-400">You type</span><span className="font-medium text-slate-900 dark:text-white tabular-nums">GHS {parsedAmount.toFixed(2)}</span></div>
                                        <div className="flex justify-between gap-3"><span className="text-slate-500 dark:text-slate-400">Service fee ({feeRate}%)</span><span className="font-medium text-slate-900 dark:text-white tabular-nums">{useExact ? '+' : '–'} GHS {feeAmount.toFixed(2)}</span></div>
                                        <div className="flex justify-between gap-3 border-t border-slate-100 dark:border-slate-800 pt-2.5 mt-1">
                                            <span className="font-medium text-slate-700 dark:text-slate-300">You pay</span>
                                            <span className="font-semibold text-base text-slate-900 dark:text-white tabular-nums">GHS {totalPaid.toFixed(2)}</span>
                                        </div>
                                    </>
                                ) : useExact ? (
                                    <>
                                        <div className="flex justify-between gap-3"><span className="text-slate-500 dark:text-slate-400">You type</span><span className="font-medium text-slate-900 dark:text-white tabular-nums">GHS {parsedAmount.toFixed(2)}</span></div>
                                        <div className="flex justify-between gap-3"><span className="text-slate-500 dark:text-slate-400">Beneficiary receives</span><span className="font-semibold text-emerald-600 dark:text-emerald-400 tabular-nums">GHS {airtimeAmount.toFixed(2)}</span></div>
                                        <div className="flex justify-between gap-3"><span className="text-slate-500 dark:text-slate-400">Service fee ({feeRate}%)</span><span className="font-medium text-slate-900 dark:text-white tabular-nums">+ GHS {feeAmount.toFixed(2)}</span></div>
                                        <div className="flex justify-between gap-3 border-t border-slate-100 dark:border-slate-800 pt-2.5 mt-1">
                                            <span className="font-medium text-slate-700 dark:text-slate-300">You pay</span>
                                            <span className="font-semibold text-base text-slate-900 dark:text-white tabular-nums">GHS {totalPaid.toFixed(2)}</span>
                                        </div>
                                    </>
                                ) : (
                                    <>
                                        <div className="flex justify-between gap-3"><span className="text-slate-500 dark:text-slate-400">You type</span><span className="font-medium text-slate-900 dark:text-white tabular-nums">GHS {parsedAmount.toFixed(2)}</span></div>
                                        <div className="flex justify-between gap-3"><span className="text-slate-500 dark:text-slate-400">Service fee ({feeRate}%)</span><span className="font-medium text-slate-900 dark:text-white tabular-nums">– GHS {feeAmount.toFixed(2)}</span></div>
                                        <div className="flex justify-between gap-3 items-center rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900 px-3 py-2">
                                            <span className="text-amber-700 dark:text-amber-400 font-medium flex items-center gap-1.5 text-xs">
                                                <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> Beneficiary receives
                                            </span>
                                            <span className="font-semibold text-amber-700 dark:text-amber-400 tabular-nums">GHS {airtimeAmount.toFixed(2)}</span>
                                        </div>
                                        <p className="text-xs text-amber-600 dark:text-amber-500">Fee deducted — enable &ldquo;Pay separately&rdquo; to avoid this.</p>
                                        <div className="flex justify-between gap-3 border-t border-slate-100 dark:border-slate-800 pt-2.5 mt-1">
                                            <span className="font-medium text-slate-700 dark:text-slate-300">You pay</span>
                                            <span className="font-semibold text-base text-slate-900 dark:text-white tabular-nums">GHS {totalPaid.toFixed(2)}</span>
                                        </div>
                                    </>
                                )}
                            </div>
                        </div>
                    )}

                    {parsedAmount > 0 && !hasEnoughBalance && walletBalance !== null ? (
                        <div className="rounded-xl bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 p-4 flex items-center gap-3">
                            <AlertTriangle className="w-5 h-5 text-red-500 shrink-0" />
                            <div className="min-w-0">
                                <p className="text-sm font-medium text-red-700 dark:text-red-400">Insufficient balance</p>
                                <p className="text-xs text-red-500 dark:text-red-400/80">You need GHS {totalPaid.toFixed(2)} but have GHS {walletBalance.toFixed(2)}. Please top up.</p>
                            </div>
                        </div>
                    ) : (
                        <Button
                            className="w-full h-12 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold shadow-sm"
                            disabled={!canProceed}
                            onClick={() => setShowConfirm(true)}
                        >
                            Proceed to payment <ArrowRight className="w-4 h-4 ml-2" />
                        </Button>
                    )}
                </div>
            )}

            {/* ── HISTORY TAB ──────────────────────────────────────────────────────── */}
            {activeTab === 'history' && (
                <div className="space-y-4 animate-in fade-in duration-200">
                    <div className="grid grid-cols-3 gap-2">
                        <div className="bg-white dark:bg-slate-900 rounded-xl p-3 border border-slate-200 dark:border-slate-800 shadow-sm min-w-0">
                            <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 mb-1">
                                <Coins className="w-3.5 h-3.5 text-emerald-500 shrink-0" /> <span className="truncate">Total spent</span>
                            </div>
                            <p className="text-sm font-semibold text-slate-900 dark:text-white truncate tabular-nums">GHS {stats.totalSpent.toFixed(2)}</p>
                        </div>
                        <div className="bg-white dark:bg-slate-900 rounded-xl p-3 border border-slate-200 dark:border-slate-800 shadow-sm min-w-0">
                            <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 mb-1">
                                <History className="w-3.5 h-3.5 text-blue-500 shrink-0" /> <span className="truncate">Orders</span>
                            </div>
                            <p className="text-sm font-semibold text-slate-900 dark:text-white truncate tabular-nums">{stats.totalOrders}</p>
                        </div>
                        <div className="bg-white dark:bg-slate-900 rounded-xl p-3 border border-slate-200 dark:border-slate-800 shadow-sm min-w-0">
                            <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 mb-1">
                                <TrendingUp className="w-3.5 h-3.5 text-amber-500 shrink-0" /> <span className="truncate">Today</span>
                            </div>
                            <p className="text-sm font-semibold text-slate-900 dark:text-white truncate tabular-nums">GHS {stats.todaySpent.toFixed(2)}</p>
                        </div>
                    </div>

                    {/* Type Filter Chips */}
                    <div className="flex bg-slate-100 dark:bg-slate-800/60 p-1 rounded-xl gap-1">
                        {(['all', 'airtime', 'mashup'] as const).map((type) => (
                            <button
                                key={type}
                                onClick={() => setTypeFilter(type)}
                                className={cn(
                                    'flex-1 py-1.5 rounded-lg text-xs font-medium capitalize transition-colors',
                                    typeFilter === type
                                        ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm'
                                        : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
                                )}
                            >
                                {type}
                            </button>
                        ))}
                    </div>

                    <div className="space-y-2.5">
                        <div className="relative">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                            <Input
                                placeholder="Search beneficiary or reference…"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                className="pl-9 h-10 rounded-xl"
                            />
                        </div>
                        <div className="flex gap-2">
                            <div className="flex-1 min-w-0">
                                <Select value={timePeriod} onValueChange={(val) => {
                                    if (val === 'Custom') setIsCustomDialogOpen(true)
                                    else setTimePeriod(val)
                                }}>
                                    <SelectTrigger className="h-10 rounded-xl">
                                        <div className="flex items-center gap-2 min-w-0">
                                            <Calendar className="w-4 h-4 text-slate-400 shrink-0" />
                                            <SelectValue placeholder="Time period" />
                                        </div>
                                    </SelectTrigger>
                                    <SelectContent className="rounded-xl">
                                        {['Today', 'Yesterday', 'This Week', 'This Month', 'Custom'].map(period => (
                                            <SelectItem key={period} value={period}>{period}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                            <Button variant="outline" size="icon" className="h-10 w-10 rounded-xl shrink-0" onClick={loadHistory} disabled={historyLoading}>
                                <RefreshCw className={cn('w-4 h-4', historyLoading && 'animate-spin')} />
                            </Button>
                        </div>
                        {timePeriod === 'Custom' && customStart && (
                            <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-100 dark:bg-slate-800 rounded-lg text-xs text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700 w-fit">
                                <CalendarRange className="w-3.5 h-3.5 shrink-0" />
                                <span className="truncate">{format(new Date(customStart), 'MMM d')} – {format(new Date(customEnd), 'MMM d, yyyy')}</span>
                                <button onClick={() => setTimePeriod('All')} className="ml-1 text-slate-400 hover:text-red-500 shrink-0" title="Clear custom date filter"><X className="w-3.5 h-3.5" /></button>
                            </div>
                        )}
                    </div>

                    {historyLoading ? (
                        <div className="flex flex-col items-center justify-center py-16 bg-white dark:bg-slate-900 rounded-2xl border border-dashed border-slate-200 dark:border-slate-800">
                            <Loader2 className="w-7 h-7 animate-spin text-slate-400 mb-2" />
                            <p className="text-sm text-slate-500 dark:text-slate-400">Syncing your history…</p>
                        </div>
                    ) : filteredOrders.length === 0 ? (
                        <div className="text-center py-16 bg-white dark:bg-slate-900 rounded-2xl border border-dashed border-slate-200 dark:border-slate-800">
                            <div className="bg-slate-100 dark:bg-slate-800 w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3">
                                <History className="w-6 h-6 text-slate-300 dark:text-slate-600" />
                            </div>
                            <p className="text-sm font-medium text-slate-900 dark:text-white">No orders found</p>
                            <p className="text-xs text-slate-500 dark:text-slate-400 max-w-[14rem] mx-auto mt-0.5">Try adjusting your filters or search query.</p>
                        </div>
                    ) : (
                        <div className="space-y-2.5 pb-16">
                            {filteredOrders.map(order => (
                                <div key={order.id} className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-4 shadow-sm">
                                    <div className="flex items-start justify-between gap-3 mb-3">
                                        <div className="flex items-center gap-3 min-w-0">
                                            <div className="w-10 h-10 rounded-xl bg-slate-50 dark:bg-slate-800 flex items-center justify-center border border-slate-200 dark:border-slate-800 shrink-0">
                                                <NetworkLogo id={order.network} className="w-7 h-7" />
                                            </div>
                                            <div className="min-w-0">
                                                <div className="flex items-center gap-1.5 min-w-0">
                                                    <span className="font-medium text-slate-900 dark:text-white truncate">{order.network}</span>
                                                    <span className={cn(
                                                        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-medium border shrink-0',
                                                        order.type === 'mashup'
                                                            ? 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-400 dark:border-amber-900'
                                                            : 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-400 dark:border-blue-900'
                                                    )}>
                                                        {order.type === 'mashup' ? <Zap className="w-2.5 h-2.5 fill-current" /> : <Phone className="w-2.5 h-2.5" />}
                                                        {order.type === 'mashup' ? 'Mashup' : 'Airtime'}
                                                    </span>
                                                </div>
                                                <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 mt-0.5 min-w-0">
                                                    <Phone className="w-3 h-3 shrink-0" />
                                                    <span className="truncate font-mono">{order.beneficiary_phone}</span>
                                                    <button
                                                        onClick={() => { navigator.clipboard.writeText(order.beneficiary_phone); toast.success('Number copied') }}
                                                        className="p-0.5 hover:bg-slate-100 dark:hover:bg-slate-800 rounded transition-colors shrink-0"
                                                        title="Copy beneficiary number"
                                                    >
                                                        <Copy className="w-3 h-3" />
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                        <div className="text-right shrink-0">
                                            <StatusBadge status={order.status} />
                                            <p className="text-base font-semibold text-slate-900 dark:text-white tabular-nums mt-1">GHS {order.total_paid.toFixed(2)}</p>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-3 gap-2 rounded-lg bg-slate-50 dark:bg-slate-800/40 p-2.5 border border-slate-100 dark:border-slate-800">
                                        <div className="min-w-0">
                                            <p className="text-xs text-slate-400">Amount</p>
                                            <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400 truncate tabular-nums">GHS {order.airtime_amount.toFixed(2)}</p>
                                        </div>
                                        <div className="min-w-0 text-center">
                                            <p className="text-xs text-slate-400">Fee</p>
                                            <p className="text-sm font-medium text-slate-700 dark:text-slate-300 truncate tabular-nums">GHS {order.fee_amount.toFixed(2)}</p>
                                        </div>
                                        <div className="min-w-0 text-right">
                                            <p className="text-xs text-slate-400">Date</p>
                                            <p className="text-xs font-medium text-slate-700 dark:text-slate-300 truncate">{format(parseISO(order.created_at), 'MMM d, p')}</p>
                                        </div>
                                    </div>

                                    <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-3">
                                        <div className="flex items-center gap-1.5 text-slate-400 font-mono text-xs min-w-0">
                                            <Info className="w-3 h-3 shrink-0" />
                                            <span className="truncate">{order.reference_code}</span>
                                        </div>
                                        <div className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400 shrink-0">
                                            <Clock className="w-3 h-3" />
                                            <span className="text-xs tabular-nums">{format(parseISO(order.created_at), 'hh:mm a')}</span>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* Overlays */}
            <ConfirmSheet
                open={showConfirm}
                onCancel={() => setShowConfirm(false)}
                onConfirm={handleSubmit}
                isLoading={isSubmitting}
                details={{ network: selectedNetwork || 'MTN', phone, airtime: airtimeAmount, fee: feeAmount, total: totalPaid, mode: useExact, purchaseMode, mashupBundle: purchaseMode === 'mashup' ? mashupBundle : null }}
            />
            <SuccessModal order={successOrder} onClose={handleSuccessClose} onBuyMore={handleBuyMore} />

            {/* Custom Date Dialog */}
            <Dialog open={isCustomDialogOpen} onOpenChange={setIsCustomDialogOpen}>
                <DialogContent className="rounded-2xl max-w-[400px]">
                    <DialogHeader>
                        <DialogTitle>Custom date range</DialogTitle>
                        <DialogDescription>
                            Select a start and end date to filter your airtime orders.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-3 py-2">
                        <div className="space-y-1.5">
                            <Label htmlFor="start" className="text-sm font-medium">Start date</Label>
                            <Input
                                id="start"
                                type="date"
                                value={customStart}
                                onChange={(e) => setCustomStart(e.target.value)}
                                className="rounded-xl h-10"
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="end" className="text-sm font-medium">End date</Label>
                            <Input
                                id="end"
                                type="date"
                                value={customEnd}
                                onChange={(e) => setCustomEnd(e.target.value)}
                                className="rounded-xl h-10"
                            />
                        </div>
                    </div>
                    <DialogFooter className="gap-2 sm:gap-2">
                        <Button
                            variant="outline"
                            onClick={() => setIsCustomDialogOpen(false)}
                            className="rounded-xl h-10 flex-1"
                        >
                            Cancel
                        </Button>
                        <Button
                            onClick={() => {
                                setTimePeriod('Custom')
                                setIsCustomDialogOpen(false)
                            }}
                            className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl h-10 flex-1"
                            disabled={!customStart || !customEnd}
                        >
                            Apply filter
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
