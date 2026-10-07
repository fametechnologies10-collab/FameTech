'use client'

import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
    Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import {
    Loader2, ShieldCheck, Clock, CheckCircle2, XCircle,
    AlertCircle, Wallet, Download, Eye, FileText, AlertTriangle, RefreshCw,
} from 'lucide-react'
import { toast } from '@/lib/toast'
import { useAuth } from '@/contexts/auth-context'
import { format, parseISO } from 'date-fns'
import { cn } from '@/lib/utils'

// ─── Constants ───────────────────────────────────────────
const REGIONS = [
    'Greater Accra', 'Ashanti', 'Western', 'Eastern', 'Central',
    'Northern', 'Volta', 'Upper East', 'Upper West', 'Bono',
    'Bono East', 'Ahafo', 'Savannah', 'North East', 'Oti', 'Western North',
]

const GC_PATTERN = /^GHA-\d{9}-\d$/
const GC_HINT = 'Format: GHA-XXXXXXXXX-X (type digits only — prefix is automatic)'

const EMPTY_FORM = {
    full_name: '', phone: '', id_number: 'GHA-',
    date_of_birth: '', location: '', region: 'Greater Accra', notes: '',
}

type Tab = 'registrations' | 'new' | 'stats'

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: any; description: string }> = {
    pending: {
        label: 'Pending', icon: Clock,
        color: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/20 dark:text-yellow-400',
        description: 'Your application has been received and is awaiting review.',
    },
    processing: {
        label: 'Processing', icon: Clock,
        color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400',
        description: 'Our team is currently processing your registration.',
    },
    completed: {
        label: 'Completed', icon: CheckCircle2,
        color: 'bg-green-100 text-green-700 dark:bg-green-900/20 dark:text-green-400',
        description: 'Your AFA registration is complete. You are now an officially recognized member.',
    },
    cancelled: {
        label: 'Cancelled', icon: XCircle,
        color: 'bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-400',
        description: 'This application was cancelled. Please contact support for more information.',
    },
}

// ─── Types ────────────────────────────────────────────────
type AfarOrder = {
    id: string
    full_name: string
    phone: string
    id_type: string
    id_number: string
    date_of_birth?: string
    ghana_card?: string
    location: string
    region: string
    occupation: string
    status: string
    notes?: string
    payment_amount?: number
    created_at: string
    updated_at?: string
}

// ─── Helpers ──────────────────────────────────────────────

// Mask Ghana Card in list: GHA-123456789-0 → GHA-•••••789-0
function maskGhanaCard(id: string | null | undefined): string {
    if (!id) return '—'
    const m = id.match(/^GHA-(\d{9})-(\d)$/)
    if (!m) return id
    return `GHA-•••••${m[1].slice(-3)}-${m[2]}`
}

// Auto-format Ghana Card input: digits only → GHA-XXXXXXXXX-X
function maskGcInput(raw: string): string {
    const digits = raw.replace(/\D/g, '').slice(0, 10)
    if (digits.length === 0) return 'GHA-'
    if (digits.length <= 9) return 'GHA-' + digits
    return 'GHA-' + digits.slice(0, 9) + '-' + digits[9]
}

function validateGhanaCard(value: string): string | null {
    if (!GC_PATTERN.test(value.trim())) return GC_HINT
    return null
}

// Safe DOB formatter — avoids day/month ambiguity regardless of locale
function formatDob(dob: string | undefined | null): string {
    if (!dob) return '—'
    try { return format(parseISO(dob), 'dd MMM yyyy') } catch { return dob }
}

// ─── Receipt Generator ────────────────────────────────────
function downloadReceipt(app: AfarOrder) {
    const idNumber = app.id_number ?? app.ghana_card ?? 'N/A'
    const lines = [
        '╔══════════════════════════════════════════════╗',
        '║        MTN AFA REGISTRATION RECEIPT          ║',
        '╚══════════════════════════════════════════════╝',
        '',
        `Application ID   : ${app.id}`,
        `Submitted On     : ${format(new Date(app.created_at), 'dd MMM yyyy, hh:mm a')}`,
        '',
        '── Applicant Details ──────────────────────────',
        `Full Name        : ${app.full_name}`,
        `Phone Number     : ${app.phone}`,
        `ID Type          : Ghana Card`,
        `Ghana Card No.   : ${idNumber}`,
        ...(app.date_of_birth ? [`Date of Birth    : ${formatDob(app.date_of_birth)}`] : []),
        `Region           : ${app.region}`,
        `City / Town      : ${app.location}`,
        `Occupation       : ${app.occupation || 'Farmer'}`,
        ...(app.notes ? [`Notes            : ${app.notes}`] : []),
        '',
        '── Payment Summary ────────────────────────────',
        `Registration Fee : GHS ${app.payment_amount?.toFixed(2) ?? '—'}`,
        `Payment Status   : PAID`,
        '',
        '── Application Status ─────────────────────────',
        `Current Status   : ${(app.status || 'pending').toUpperCase()}`,
        '',
        '══════════════════════════════════════════════',
        '  AFA membership is permanent.',
        '  Processed by: KingFlexy Dashboard',
        '══════════════════════════════════════════════',
    ]
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `AFA_Receipt_${app.full_name.replace(/\s+/g, '_')}_${app.id.slice(0, 8)}.txt`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
}

// ─── Main Page ────────────────────────────────────────────
export default function AFAOrdersPage() {
    const { dbUser } = useAuth()

    // Tab
    const [activeTab, setActiveTab] = useState<Tab>('registrations')

    // Data
    const [applications, setApplications] = useState<AfarOrder[]>([])
    const [applicationPrice, setApplicationPrice] = useState(0)
    const [walletBalance, setWalletBalance] = useState(0)
    const [loadingPrice, setLoadingPrice] = useState(true)
    const [hasPricingError, setHasPricingError] = useState(false)
    // Plan 4, Task 8 (spec C4): true unless /api/user/afa-price explicitly
    // reports `configured: false` — that only ever happens for a sub-agent
    // caller with no AFA pricing configured (override or recruiter default).
    // Every other role's response omits the field, so this stays true.
    const [pricingConfigured, setPricingConfigured] = useState(true)
    const [loadingApps, setLoadingApps] = useState(true)
    const [refreshCooldown, setRefreshCooldown] = useState(0)
    const [isRefreshing, setIsRefreshing] = useState(false)

    // Registrations tab filters
    const [searchQuery, setSearchQuery] = useState('')
    const [statusFilter, setStatusFilter] = useState('all')

    // Form state
    const [formData, setFormData] = useState({ ...EMPTY_FORM })
    const [gcError, setGcError] = useState<string | null>(null)
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [showConfirmDialog, setShowConfirmDialog] = useState(false)

    // Detail modal
    const [selectedApp, setSelectedApp] = useState<AfarOrder | null>(null)

    // ── Fetch ──────────────────────────────────────────────
    const fetchApplications = useCallback(async () => {
        if (!dbUser?.id) return
        setLoadingApps(true)
        const { data } = await (supabase.from('afa_orders') as any)
            .select('*')
            .eq('user_id', dbUser.id)
            .order('created_at', { ascending: false })
        setApplications(data || [])
        setLoadingApps(false)
    }, [dbUser?.id])

    const fetchApplicationPrice = useCallback(async () => {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 8000)
        try {
            const res = await fetch('/api/user/afa-price', {
                cache: 'no-store',
                signal: controller.signal,
            })
            if (!res.ok) throw new Error(`Price API returned ${res.status}`)
            const json = await res.json()
            setPricingConfigured(json?.configured !== false)
            const price = parseFloat(json?.price)
            if (!json?.price || isNaN(price) || price <= 0) throw new Error('Invalid price')
            setApplicationPrice(price)
            setHasPricingError(false)
        } catch (err) {
            console.error('[AFA] Failed to load registration price:', err)
            setHasPricingError(true)
        } finally {
            clearTimeout(timeout)
            setLoadingPrice(false)
        }
    }, [])

    const fetchWalletBalance = useCallback(async () => {
        if (!dbUser?.id) return
        const { data } = await (supabase.from('wallets')
            .select('balance')
            .eq('user_id', dbUser.id)
            .single() as any)
        if (data) setWalletBalance(data.balance || 0)
    }, [dbUser?.id])

    // ── Init ──────────────────────────────────────────────
    useEffect(() => {
        if (!dbUser) return
        fetchApplications()
        fetchApplicationPrice()
        fetchWalletBalance()
    }, [dbUser, fetchApplications, fetchApplicationPrice, fetchWalletBalance])

    useEffect(() => {
        if (refreshCooldown <= 0) return
        const timer = setInterval(() => {
            setRefreshCooldown(prev => (prev <= 1 ? 0 : prev - 1))
        }, 1000)
        return () => clearInterval(timer)
    }, [refreshCooldown])

    const handleManualRefresh = async () => {
        if (isRefreshing || refreshCooldown > 0) return
        setIsRefreshing(true)
        await fetchApplications()
        setIsRefreshing(false)
        setRefreshCooldown(60)
    }

    // ── Ghana Card input handler ───────────────────────────
    const handleGcChange = (raw: string) => {
        const masked = maskGcInput(raw)
        setFormData(p => ({ ...p, id_number: masked }))
        if (masked.length > 4) {
            setGcError(validateGhanaCard(masked))
        } else {
            setGcError(null)
        }
    }

    // ── Pre-submit validation ──────────────────────────────
    const handlePreSubmit = (e: React.FormEvent) => {
        e.preventDefault()

        if (!formData.id_number || formData.id_number === 'GHA-') {
            toast.error('Please enter your Ghana Card number')
            return
        }
        const gcValidationError = validateGhanaCard(formData.id_number)
        if (gcValidationError) {
            setGcError(gcValidationError)
            toast.error('Invalid Ghana Card format', { description: GC_HINT })
            return
        }

        if (!formData.date_of_birth) { toast.error('Please enter Date of Birth'); return }

        const dob = new Date(formData.date_of_birth)
        const today = new Date()
        let age = today.getFullYear() - dob.getFullYear()
        const m = today.getMonth() - dob.getMonth()
        if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--
        if (age < 18) { toast.error('Applicant must be at least 18 years old.'); return }

        setShowConfirmDialog(true)
    }

    // ── Actual submission after confirm ────────────────────
    const handleConfirmedSubmit = async () => {
        setShowConfirmDialog(false)
        setIsSubmitting(true)
        const referenceCode = crypto.randomUUID()
        try {
            const res = await fetch('/api/user/afa-registration', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    referenceCode,
                    formData: {
                        full_name:     formData.full_name,
                        phone:         formData.phone,
                        id_type:       'Ghana Card',
                        id_number:     formData.id_number.trim(),
                        date_of_birth: formData.date_of_birth,
                        location:      formData.location,
                        region:        formData.region,
                        notes:         formData.notes,
                    },
                }),
            })
            const json = await res.json()
            if (!res.ok) {
                if (json?.error === 'INSUFFICIENT_BALANCE') {
                    toast.error(`Insufficient balance. You need GHS ${applicationPrice.toFixed(2)} but have GHS ${walletBalance.toFixed(2)}`)
                    return
                }
                throw new Error(json?.error || 'Registration failed')
            }
            toast.success('Registration submitted!', {
                description: 'Our team will process the application within 24 hours.',
            })
            await Promise.all([fetchWalletBalance(), fetchApplications()])
            setFormData({ ...EMPTY_FORM })
            setGcError(null)
            setActiveTab('registrations')
        } catch (err) {
            console.error('[AFA] Submission error:', err)
            toast.error('Failed to submit registration')
        } finally {
            setIsSubmitting(false)
        }
    }

    if (loadingApps) {
        return (
            <div className="flex items-center justify-center py-24">
                <Loader2 className="w-8 h-8 animate-spin text-yellow-400" />
            </div>
        )
    }

    return (
        <div className="max-w-3xl mx-auto space-y-6 pb-10">

            {/* ── Hero Header ── */}
            <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-yellow-400 via-yellow-500 to-amber-600 p-6 sm:p-8 text-white shadow-xl">
                <div className="relative z-10">
                    <div className="flex items-center gap-2 mb-1">
                        <ShieldCheck className="w-5 h-5 opacity-80" />
                        <span className="text-xs font-semibold uppercase tracking-widest opacity-80">Official Registration</span>
                    </div>
                    <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">MTN AFA REGISTRATION</h1>
                    <p className="mt-2 text-yellow-100 text-sm max-w-lg leading-relaxed">
                        Register yourself or anyone else for the MTN Authorized Field Agent (AFA) programme.{' '}
                        <strong className="text-white">One registration per person</strong> — membership is permanent.
                    </p>
                </div>
                <div className="absolute -top-8 -right-8 w-40 h-40 rounded-full bg-white/10" />
                <div className="absolute -bottom-6 -right-16 w-56 h-56 rounded-full bg-white/5" />
            </div>

            {/* ── Tab Navigation ── */}
            <div className="flex border-b border-border">
                {(['registrations', 'new', 'stats'] as Tab[]).map(tab => (
                    <button
                        key={tab}
                        onClick={() => setActiveTab(tab)}
                        className={cn(
                            'px-4 py-2.5 text-sm font-semibold border-b-2 -mb-px transition-colors',
                            activeTab === tab
                                ? 'border-yellow-500 text-yellow-600 dark:text-yellow-400'
                                : 'border-transparent text-muted-foreground hover:text-foreground'
                        )}
                    >
                        {tab === 'registrations' ? 'Registrations' : tab === 'new' ? '+ New' : 'Stats'}
                    </button>
                ))}
            </div>

            {/* ── Stats Tab ── */}
            {activeTab === 'stats' && (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                    {[
                        { label: 'Total Registered', value: applications.length, color: 'text-blue-600', bg: 'bg-blue-50 dark:bg-blue-900/20' },
                        { label: 'Pending',          value: applications.filter(a => a.status === 'pending').length,    color: 'text-yellow-600', bg: 'bg-yellow-50 dark:bg-yellow-900/20' },
                        { label: 'Processing',       value: applications.filter(a => a.status === 'processing').length, color: 'text-blue-600',   bg: 'bg-blue-50 dark:bg-blue-900/20' },
                        { label: 'Completed',        value: applications.filter(a => a.status === 'completed').length,  color: 'text-green-600',  bg: 'bg-green-50 dark:bg-green-900/20' },
                        { label: 'Cancelled',        value: applications.filter(a => a.status === 'cancelled').length,  color: 'text-red-600',    bg: 'bg-red-50 dark:bg-red-900/20' },
                        {
                            label: 'Total GHS Spent',
                            value: `GHS ${applications.reduce((s, a) => s + (a.payment_amount ?? 0), 0).toFixed(2)}`,
                            color: 'text-amber-600', bg: 'bg-amber-50 dark:bg-amber-900/20',
                        },
                    ].map(stat => (
                        <Card key={stat.label} className="border shadow-sm">
                            <CardContent className="p-4">
                                <div className={cn('w-9 h-9 rounded-xl flex items-center justify-center mb-2', stat.bg)}>
                                    <ShieldCheck className={cn('w-4 h-4', stat.color)} />
                                </div>
                                <p className="text-xs text-muted-foreground">{stat.label}</p>
                                <p className={cn('text-xl font-bold mt-0.5', stat.color)}>{stat.value}</p>
                            </CardContent>
                        </Card>
                    ))}
                </div>
            )}

            {/* ── Registrations Tab ── */}
            {activeTab === 'registrations' && (
                <div className="space-y-3">
                    {/* Wallet + Fee summary */}
                    <div className="grid grid-cols-2 gap-4">
                        <Card className="border border-yellow-200 dark:border-yellow-900/40">
                            <CardContent className="p-4 flex items-center gap-3">
                                <div className="w-10 h-10 rounded-xl bg-yellow-100 dark:bg-yellow-900/30 flex items-center justify-center shrink-0">
                                    <Wallet className="w-5 h-5 text-yellow-600" />
                                </div>
                                <div>
                                    <p className="text-xs text-muted-foreground">Wallet Balance</p>
                                    <p className="text-xl font-bold text-yellow-700 dark:text-yellow-400">GHS {walletBalance.toFixed(2)}</p>
                                </div>
                            </CardContent>
                        </Card>
                        <Card>
                            <CardContent className="p-4 flex items-center gap-3">
                                <div className="w-10 h-10 rounded-xl bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center shrink-0">
                                    <ShieldCheck className="w-5 h-5 text-blue-600" />
                                </div>
                                <div>
                                    <p className="text-xs text-muted-foreground">Registration Fee</p>
                                    <p className="text-xl font-bold">
                                        {loadingPrice ? 'Loading…' : hasPricingError ? 'Unavailable' : `GHS ${applicationPrice.toFixed(2)}`}
                                    </p>
                                </div>
                            </CardContent>
                        </Card>
                    </div>

                    {/* Search + filter */}
                    <div className="flex flex-col sm:flex-row gap-3">
                        <Input
                            placeholder="Search by name or phone..."
                            value={searchQuery}
                            onChange={e => setSearchQuery(e.target.value)}
                            className="h-10 sm:max-w-xs"
                        />
                        <Select value={statusFilter} onValueChange={setStatusFilter}>
                            <SelectTrigger className="h-10 sm:max-w-[160px]">
                                <SelectValue placeholder="All Statuses" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">All Statuses</SelectItem>
                                <SelectItem value="pending">Pending</SelectItem>
                                <SelectItem value="processing">Processing</SelectItem>
                                <SelectItem value="completed">Completed</SelectItem>
                                <SelectItem value="cancelled">Cancelled</SelectItem>
                            </SelectContent>
                        </Select>
                        <button
                            onClick={handleManualRefresh}
                            disabled={isRefreshing || refreshCooldown > 0}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm font-medium disabled:opacity-50 transition-colors"
                        >
                            {isRefreshing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                            {refreshCooldown > 0 ? `Refresh (${refreshCooldown}s)` : 'Refresh'}
                        </button>
                    </div>

                    {/* Registration cards */}
                    {(() => {
                        const filtered = applications.filter(app => {
                            const q = searchQuery.toLowerCase()
                            const matchSearch = app.full_name.toLowerCase().includes(q) || app.phone.includes(q)
                            const matchStatus = statusFilter === 'all' || app.status === statusFilter
                            return matchSearch && matchStatus
                        })
                        if (filtered.length === 0) return (
                            <Card className="border-dashed">
                                <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-2">
                                    <ShieldCheck className="w-10 h-10 opacity-20" />
                                    <p className="text-sm">No registrations yet. Go to + New to register someone.</p>
                                </CardContent>
                            </Card>
                        )
                        return filtered.map(app => {
                            const cfg = STATUS_CONFIG[app.status] || STATUS_CONFIG.pending
                            const StatusIcon = cfg.icon
                            const idNum = app.id_number ?? app.ghana_card
                            return (
                                <Card key={app.id} className="shadow-sm hover:shadow-md transition-shadow">
                                    <CardContent className="p-4">
                                        <div className="flex items-start gap-3">
                                            <div className={cn('w-9 h-9 rounded-xl flex items-center justify-center shrink-0',
                                                app.status === 'completed' ? 'bg-green-100 dark:bg-green-900/20' :
                                                app.status === 'cancelled' ? 'bg-red-100 dark:bg-red-900/20' :
                                                app.status === 'processing' ? 'bg-blue-100 dark:bg-blue-900/20' :
                                                'bg-yellow-100 dark:bg-yellow-900/20')}>
                                                <StatusIcon className={cn('w-5 h-5',
                                                    app.status === 'completed' ? 'text-green-600' :
                                                    app.status === 'cancelled' ? 'text-red-600' :
                                                    app.status === 'processing' ? 'text-blue-600' : 'text-yellow-600')} />
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-start justify-between gap-2 flex-wrap">
                                                    <div>
                                                        <p className="font-semibold leading-tight">{app.full_name}</p>
                                                        <p className="text-xs text-muted-foreground mt-0.5">{app.phone}</p>
                                                    </div>
                                                    <span className={cn('inline-flex items-center gap-1 text-[10px] font-bold uppercase px-2 py-0.5 rounded-full shrink-0', cfg.color)}>
                                                        <StatusIcon className="w-3 h-3" />{cfg.label}
                                                    </span>
                                                </div>
                                                <p className="text-xs text-muted-foreground mt-1">
                                                    Ghana Card · {maskGhanaCard(idNum)} · {app.location}, {app.region}
                                                </p>
                                                <p className="text-xs text-muted-foreground mt-0.5">
                                                    Submitted {format(new Date(app.created_at), 'dd MMM yyyy, hh:mm a')}
                                                </p>
                                                <p className="text-xs italic text-muted-foreground/80 mt-1">{cfg.description}</p>
                                            </div>
                                        </div>
                                        <div className="flex gap-2 mt-3 pt-3 border-t flex-wrap">
                                            <Button size="sm" variant="outline" className="gap-1.5 h-8 text-xs" onClick={() => setSelectedApp(app)}>
                                                <Eye className="w-3.5 h-3.5" />View Details
                                            </Button>
                                            <Button size="sm" variant="outline"
                                                className="gap-1.5 h-8 text-xs text-yellow-700 border-yellow-300 hover:bg-yellow-50 dark:text-yellow-400 dark:border-yellow-800 dark:hover:bg-yellow-900/20"
                                                onClick={() => downloadReceipt(app)}>
                                                <Download className="w-3.5 h-3.5" />Receipt
                                            </Button>
                                        </div>
                                    </CardContent>
                                </Card>
                            )
                        })
                    })()}
                </div>
            )}

            {/* ── + New Tab ── */}
            {activeTab === 'new' && !loadingPrice && !pricingConfigured && (
                <Card className="border-dashed">
                    <CardContent className="flex flex-col items-center justify-center py-12 text-center gap-3">
                        <div className="w-12 h-12 rounded-full bg-yellow-100 dark:bg-yellow-900/20 flex items-center justify-center">
                            <AlertCircle className="w-6 h-6 text-yellow-600" />
                        </div>
                        <div className="space-y-1">
                            <p className="font-semibold">AFA registration isn&apos;t available yet</p>
                            <p className="text-sm text-muted-foreground max-w-sm">
                                Your account isn&apos;t set up to register AFA members yet. Please contact your recruiter to get this enabled.
                            </p>
                        </div>
                        <Button variant="outline" size="sm" onClick={() => setActiveTab('registrations')}>
                            Back to Registrations
                        </Button>
                    </CardContent>
                </Card>
            )}

            {activeTab === 'new' && (loadingPrice || pricingConfigured) && (
                <Card>
                    <CardHeader>
                        <CardTitle>Who are you registering?</CardTitle>
                        <CardDescription>
                            Register yourself or anyone else. AFA membership is permanent — one registration per person.
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <form onSubmit={handlePreSubmit} className="space-y-5">
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div className="space-y-1.5">
                                    <Label>Full Name <span className="text-red-500">*</span></Label>
                                    <Input required disabled={isSubmitting} value={formData.full_name}
                                        onChange={e => setFormData(p => ({ ...p, full_name: e.target.value }))}
                                        placeholder="John Kwame Mensah" className="h-11" />
                                </div>
                                <div className="space-y-1.5">
                                    <Label>Phone Number <span className="text-red-500">*</span></Label>
                                    <Input required type="tel" disabled={isSubmitting} value={formData.phone}
                                        onChange={e => setFormData(p => ({ ...p, phone: e.target.value }))}
                                        placeholder="024xxxxxxx" className="h-11" />
                                </div>
                            </div>

                            {/* Ghana Card — no type picker */}
                            <div className="space-y-1.5">
                                <Label>Ghana Card Number <span className="text-red-500">*</span></Label>
                                <div className="flex items-center gap-2">
                                    <span className="inline-flex items-center px-3 py-1.5 rounded-lg bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 text-xs font-bold text-yellow-700 dark:text-yellow-400 shrink-0">
                                        Ghana Card
                                    </span>
                                    <Input required disabled={isSubmitting} value={formData.id_number}
                                        onChange={e => handleGcChange(e.target.value)}
                                        placeholder="GHA-XXXXXXXXX-X"
                                        className={cn('h-11 font-mono', gcError ? 'border-red-500 focus-visible:ring-red-500' : '')} />
                                </div>
                                {!gcError && (
                                    <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                                        <AlertCircle className="w-3 h-3" /> Type digits only — GHA- prefix is automatic
                                    </p>
                                )}
                                {gcError && (
                                    <p className="text-[11px] text-red-500 flex items-center gap-1">
                                        <XCircle className="w-3 h-3" /> {gcError}
                                    </p>
                                )}
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div className="space-y-1.5">
                                    <Label>Date of Birth <span className="text-red-500">*</span></Label>
                                    <Input required type="date" disabled={isSubmitting} value={formData.date_of_birth}
                                        onChange={e => setFormData(p => ({ ...p, date_of_birth: e.target.value }))}
                                        className="h-11 cursor-pointer"
                                        max={new Date(new Date().setFullYear(new Date().getFullYear() - 18)).toISOString().split('T')[0]} />
                                </div>
                                <div className="space-y-1.5">
                                    <Label>Region <span className="text-red-500">*</span></Label>
                                    <Select disabled={isSubmitting} value={formData.region} onValueChange={v => setFormData(p => ({ ...p, region: v }))}>
                                        <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
                                        <SelectContent>{REGIONS.map(r => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
                                    </Select>
                                </div>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div className="space-y-1.5">
                                    <Label>City / Town <span className="text-red-500">*</span></Label>
                                    <Input required disabled={isSubmitting} value={formData.location}
                                        onChange={e => setFormData(p => ({ ...p, location: e.target.value }))}
                                        placeholder="e.g. Kumasi" className="h-11" />
                                </div>
                                <div className="space-y-1.5">
                                    <Label>Occupation</Label>
                                    <Input value="Farmer" readOnly className="bg-muted cursor-not-allowed text-muted-foreground h-11" />
                                </div>
                            </div>

                            <div className="space-y-1.5">
                                <Label>Additional Notes <span className="text-xs text-muted-foreground">(optional)</span></Label>
                                <Input disabled={isSubmitting} value={formData.notes}
                                    onChange={e => setFormData(p => ({ ...p, notes: e.target.value }))}
                                    placeholder="Any extra information..." className="h-11" />
                            </div>

                            {/* Balance check */}
                            <div className={cn('rounded-xl p-4 flex items-center gap-3 border',
                                walletBalance >= applicationPrice
                                    ? 'bg-green-50 dark:bg-green-950/20 border-green-200 dark:border-green-800'
                                    : 'bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-800')}>
                                <Wallet className={cn('w-5 h-5 shrink-0', walletBalance >= applicationPrice ? 'text-green-600' : 'text-red-600')} />
                                <div className="text-sm">
                                    {walletBalance >= applicationPrice ? (
                                        <>
                                            <span className="font-medium text-green-800 dark:text-green-300">Balance after payment: </span>
                                            <span className="font-bold text-green-700 dark:text-green-400">GHS {(walletBalance - applicationPrice).toFixed(2)}</span>
                                        </>
                                    ) : (
                                        <span className="font-medium text-red-800 dark:text-red-300">
                                            Insufficient balance. Please top up at least GHS {(applicationPrice - walletBalance).toFixed(2)} to proceed.
                                        </span>
                                    )}
                                </div>
                            </div>

                            <div className="flex flex-col-reverse sm:flex-row gap-3 pt-1">
                                <Button type="button" variant="outline" className="flex-1 h-11"
                                    onClick={() => { setActiveTab('registrations'); setFormData({ ...EMPTY_FORM }); setGcError(null) }}>
                                    Cancel
                                </Button>
                                {walletBalance >= applicationPrice && (
                                    <Button type="submit"
                                        className="flex-1 h-11 bg-yellow-500 hover:bg-yellow-600 text-white font-bold gap-2"
                                        disabled={isSubmitting || loadingPrice || !!gcError}>
                                        {isSubmitting
                                            ? <><Loader2 className="w-4 h-4 animate-spin" /> Processing...</>
                                            : <><ShieldCheck className="w-4 h-4" /> Submit &amp; Pay GHS {applicationPrice.toFixed(2)}</>}
                                    </Button>
                                )}
                            </div>
                        </form>
                    </CardContent>
                </Card>
            )}

            {/* ── Confirm Dialog ── */}
            <Dialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <AlertTriangle className="w-5 h-5 text-amber-500" />
                            Confirm Submission
                        </DialogTitle>
                        <DialogDescription>
                            Please review the details below before proceeding. This action cannot be undone.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-3">
                        <div className="rounded-xl border bg-muted/30 p-4 space-y-2 text-sm">
                            {[
                                { label: 'Full Name',    value: formData.full_name },
                                { label: 'Phone',        value: formData.phone },
                                { label: 'Ghana Card',   value: formData.id_number },
                                { label: 'Date of Birth', value: formData.date_of_birth },
                                { label: 'Region',       value: formData.region },
                                { label: 'City / Town',  value: formData.location },
                            ].map(row => (
                                <div key={row.label} className="flex justify-between gap-2">
                                    <span className="text-muted-foreground text-xs font-medium w-24 shrink-0">{row.label}</span>
                                    <span className="font-semibold text-right break-all">{row.value || '—'}</span>
                                </div>
                            ))}
                        </div>
                        <div className="flex justify-between items-center px-1">
                            <span className="text-sm font-medium">Registration Fee</span>
                            <span className="font-black text-lg text-yellow-600">GHS {applicationPrice.toFixed(2)}</span>
                        </div>
                        <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-xs text-amber-800 dark:text-amber-300">
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                            <span>Incorrect details may lead to cancellation. Once submitted, this application cannot be edited and your payment may not be refunded.</span>
                        </div>
                    </div>
                    <DialogFooter className="gap-2">
                        <Button variant="ghost" onClick={() => setShowConfirmDialog(false)} className="flex-1">
                            Go Back &amp; Edit
                        </Button>
                        <Button onClick={handleConfirmedSubmit}
                            className="flex-1 bg-yellow-500 hover:bg-yellow-600 text-white font-bold gap-2"
                            disabled={isSubmitting}>
                            {isSubmitting
                                ? <><Loader2 className="w-4 h-4 animate-spin" /> Processing...</>
                                : <><ShieldCheck className="w-4 h-4" /> Confirm &amp; Pay</>}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* ── Detail Modal ── */}
            <Dialog open={!!selectedApp} onOpenChange={(open) => { if (!open) setSelectedApp(null) }}>
                <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
                    {selectedApp && (() => {
                        const cfg = STATUS_CONFIG[selectedApp.status] || STATUS_CONFIG.pending
                        const StatusIcon = cfg.icon
                        return (
                            <>
                                <DialogHeader>
                                    <DialogTitle className="flex items-center gap-2">
                                        <FileText className="w-5 h-5 text-yellow-500" />
                                        Application Details
                                    </DialogTitle>
                                    <DialogDescription>
                                        Submitted {format(new Date(selectedApp.created_at), 'dd MMM yyyy, hh:mm a')}
                                    </DialogDescription>
                                </DialogHeader>
                                <div className={cn(
                                    'rounded-xl p-4 flex items-center gap-3 border',
                                    selectedApp.status === 'completed' ? 'bg-green-50 dark:bg-green-950/20 border-green-200 dark:border-green-800' :
                                    selectedApp.status === 'cancelled' ? 'bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-800' :
                                    selectedApp.status === 'processing' ? 'bg-blue-50 dark:bg-blue-950/20 border-blue-200 dark:border-blue-800' :
                                    'bg-yellow-50 dark:bg-yellow-950/20 border-yellow-200 dark:border-yellow-800'
                                )}>
                                    <StatusIcon className="w-5 h-5 shrink-0" />
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2">
                                            <span className={cn('text-sm font-bold uppercase', cfg.color.replace(/bg-\S+ /, ''))}>
                                                {cfg.label}
                                            </span>
                                            {selectedApp.payment_amount != null && (
                                                <span className="text-xs text-muted-foreground">· Fee Paid: GHS {selectedApp.payment_amount.toFixed(2)}</span>
                                            )}
                                        </div>
                                        <p className="text-xs text-muted-foreground mt-0.5">{cfg.description}</p>
                                    </div>
                                </div>
                                <div className="rounded-xl border bg-muted/30 dark:bg-muted/10 divide-y overflow-hidden">
                                    {[
                                        { label: 'Full Name',    value: selectedApp.full_name },
                                        { label: 'Phone Number', value: selectedApp.phone },
                                        { label: 'Ghana Card',   value: selectedApp.id_number ?? selectedApp.ghana_card ?? '—' },
                                        ...(selectedApp.date_of_birth ? [{ label: 'Date of Birth', value: formatDob(selectedApp.date_of_birth) }] : []),
                                        { label: 'Region',       value: selectedApp.region },
                                        { label: 'City / Town',  value: selectedApp.location },
                                        { label: 'Occupation',   value: selectedApp.occupation || 'Farmer' },
                                        ...(selectedApp.notes ? [{ label: 'Notes', value: selectedApp.notes }] : []),
                                        { label: 'Application ID', value: selectedApp.id },
                                    ].map(row => (
                                        <div key={row.label} className="flex items-center justify-between px-4 py-3 gap-3">
                                            <p className="text-xs font-medium text-muted-foreground w-28 shrink-0">{row.label}</p>
                                            <p className="text-sm font-semibold text-right break-all">{row.value || '—'}</p>
                                        </div>
                                    ))}
                                </div>
                                <Button
                                    className="w-full gap-2 bg-yellow-500 hover:bg-yellow-600 text-white font-bold"
                                    onClick={() => downloadReceipt(selectedApp)}>
                                    <Download className="w-4 h-4" />
                                    Download Receipt (.txt)
                                </Button>
                                <DialogFooter>
                                    <Button variant="outline" onClick={() => setSelectedApp(null)} className="w-full">Close</Button>
                                </DialogFooter>
                            </>
                        )
                    })()}
                </DialogContent>
            </Dialog>

        </div>
    )
}
