'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/contexts/auth-context'
import { supabase } from '@/lib/supabase'
import { formatCurrency } from '@/lib/utils'
import { toast } from '@/lib/toast'
import {
    FileText, Loader2, Save, RefreshCw, Archive, Settings2, ShieldCheck, Copy, Database, ListOrdered, FileUp, Plus, Search, Filter, Edit2, TrendingUp, AlertCircle, X, ChevronDown, ChevronUp
} from 'lucide-react'

interface RCType { id: string; name: string; customer_price: number; agent_price: number; dealer_price: number; cost_price: number; is_active: boolean; display_order: number; stock: { available: number; reserved: number; sold: number; invalid: number; total: number } }
interface RCInventory { id: string; pin: string; serial_number: string; status: string; batch_id: string; created_at: string; type: { name: string } }
interface RCOrder { id: string; reference_code: string; type_name: string; quantity: number; total_paid: number; status: string; payment_status: string; user_role: string; customer_phone: string | null; source?: string; created_at: string; fulfilled_at: string | null }

const SETTING_KEYS = [
    'results_checker_enabled',
    'results_checker_storefront_enabled',
    'results_checker_max_quantity',
    'results_checker_max_markup_customer',
    'results_checker_max_markup_agent',
    'results_checker_max_markup_dealer',
    'results_checker_reservation_timeout',
    'results_checker_paystack_fee_percent'
]

export default function AdminResultsCheckerPage() {
    const { user, isLoading: authLoading } = useAuth()
    const router = useRouter()

    const [activeTab, setActiveTab] = useState<'types' | 'inventory' | 'orders' | 'complaints'>('types')
    const [loading, setLoading] = useState(true)

    const [types, setTypes] = useState<RCType[]>([])
    const [inventory, setInventory] = useState<RCInventory[]>([])
    const [orders, setOrders] = useState<RCOrder[]>([])
    const [complaints, setComplaints] = useState<any[]>([])
    const [viewingOrder, setViewingOrder] = useState<{ order: any; vouchers: any[] } | null>(null)
    const [loadingVouchers, setLoadingVouchers] = useState(false)
    const [settings, setSettings] = useState<Record<string, string>>({})
    const [searchQuery, setSearchQuery] = useState('')
    const [filterStatus, setFilterStatus] = useState<'all' | 'active' | 'archived'>('all')
    const [invSearch, setInvSearch] = useState('')
    const [invTypeFilter, setInvTypeFilter] = useState('')
    const [invStatusFilter, setInvStatusFilter] = useState('')
    const [orderSearch, setOrderSearch] = useState('')
    const [orderDatePreset, setOrderDatePreset] = useState('all')
    const [resendingOrder, setResendingOrder] = useState<string | null>(null)

    const [uploadMode, setUploadMode] = useState<'csv' | 'excel' | 'manual'>('csv')
    const [uploadTypeId, setUploadTypeId] = useState('')
    const [uploadFile, setUploadFile] = useState<File | null>(null)
    const [uploadText, setUploadText] = useState('')
    const [uploading, setUploading] = useState(false)
    const [uploadResult, setUploadResult] = useState<{inserted: number, skipped: number, errors: string[]} | null>(null)

    const [savingSettings, setSavingSettings] = useState(false)
    const [settingsCollapsed, setSettingsCollapsed] = useState(false)
    const [releasing, setReleasing] = useState(false)

    const [isTypeModalOpen, setIsTypeModalOpen] = useState(false)
    const [editingType, setEditingType] = useState<Partial<RCType & { bulk_pricing: any[] }>>({
        name: '', customer_price: 0, agent_price: 0, dealer_price: 0, cost_price: 0, display_order: 0, is_active: true, bulk_pricing: []
    })
    const [savingType, setSavingType] = useState(false)

    useEffect(() => {
        if (!authLoading && !user) router.replace('/login')
        else if (!authLoading && user) fetchData()
    }, [authLoading, user])

    const fetchData = async () => {
        setLoading(true)
        try {
            const [typesRes, invRes, ordersRes, settingsRes, complaintsRes] = await Promise.all([
                fetch('/api/admin/results-checker/types'),
                fetch('/api/admin/results-checker/inventory'),
                fetch('/api/admin/results-checker/orders'),
                (supabase as any).from('admin_settings').select('key, value').in('key', SETTING_KEYS),
                fetch('/api/admin/results-checker/complaints')
            ])

            const typesData = await typesRes.json()
            if (typesData.success) setTypes(typesData.types)

            const invData = await invRes.json()
            setInventory(invData.inventory || [])

            const ordersData = await ordersRes.json()
            setOrders(ordersData.orders || [])

            const complaintsData = await complaintsRes.json()
            if (complaintsData.complaints) setComplaints(complaintsData.complaints)

            const smap: Record<string, string> = {}
            for (const r of (settingsRes.data || [])) smap[r.key] = r.value
            setSettings(smap)
        } catch (e) {
            console.error(e)
            toast.error('Failed to load data')
        } finally {
            setLoading(false)
        }
    }

    const handleReleaseReservations = async () => {
        setReleasing(true)
        try {
            const res = await fetch('/api/admin/results-checker/release-reservations', { method: 'POST' })
            const data = await res.json()
            if (res.ok) {
                toast.success(`Released ${data.releasedCount} expired reservations`)
                fetchData()
            } else {
                throw new Error(data.error)
            }
        } catch (e: any) {
            toast.error(e.message || 'Failed to release reservations')
        } finally {
            setReleasing(false)
        }
    }

    const handleResolveComplaint = async (id: string) => {
        try {
            const res = await fetch('/api/admin/results-checker/complaints', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, status: 'resolved' })
            })
            if (res.ok) {
                toast.success('Complaint marked as resolved')
                fetchData()
            }
        } catch (e) {
            toast.error('Failed to resolve complaint')
        }
    }

    const handleOpenTypeModal = (type?: RCType) => {
        if (type) {
            setEditingType({ ...type, bulk_pricing: (type as any).bulk_pricing || [] })
        } else {
            setEditingType({ name: '', customer_price: 0, agent_price: 0, dealer_price: 0, cost_price: 0, display_order: 0, is_active: true, bulk_pricing: [] })
        }
        setIsTypeModalOpen(true)
    }

    const handleSaveType = async () => {
        if (!editingType.name) return toast.error('Name is required')
        setSavingType(true)
        try {
            const isEditing = !!editingType.id
            const method = isEditing ? 'PATCH' : 'POST'
            const res = await fetch('/api/admin/results-checker/types', {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(editingType)
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || 'Failed to save exam type')

            toast.success(`Exam type ${isEditing ? 'updated' : 'created'} successfully`)
            setIsTypeModalOpen(false)
            fetchData()
        } catch (e: any) {
            toast.error(e.message)
        } finally {
            setSavingType(false)
        }
    }

    const handleUpload = async () => {
        if (!uploadTypeId) return toast.error('Select an exam type first')
        if (uploadMode !== 'manual' && !uploadFile) return toast.error('Select a file to upload')
        if (uploadMode === 'manual' && !uploadText.trim()) return toast.error('Enter PINs and Serials')

        setUploading(true)
        setUploadResult(null)

        try {
            const formData = new FormData()
            formData.append('type_id', uploadTypeId)
            formData.append('mode', uploadMode)

            if (uploadMode === 'manual') {
                const res = await fetch('/api/admin/results-checker/upload', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ type_id: uploadTypeId, text: uploadText })
                })
                const data = await res.json()
                if (!res.ok) throw new Error(data.error || 'Upload failed')
                setUploadResult({ inserted: data.inserted, skipped: data.duplicates_skipped, errors: data.errors })
            } else {
                formData.append('file', uploadFile!)
                const res = await fetch('/api/admin/results-checker/upload', { method: 'POST', body: formData })
                const data = await res.json()
                if (!res.ok) throw new Error(data.error || 'Upload failed')
                setUploadResult({ inserted: data.inserted, skipped: data.duplicates_skipped, errors: data.errors })
            }
            toast.success('Inventory processed successfully')
            setUploadFile(null)
            setUploadText('')
            fetchData()
        } catch (e: any) {
            toast.error(e.message)
        } finally {
            setUploading(false)
        }
    }

    const handleSaveSettings = async () => {
        setSavingSettings(true)
        try {
            const updates = Object.entries(settings).map(([key, value]) => ({ key, value }))
            const { error } = await (supabase as any).from('admin_settings').upsert(updates, { onConflict: 'key' })
            if (error) throw error
            toast.success('Settings saved')
        } catch (e) {
            toast.error('Failed to save settings')
        } finally {
            setSavingSettings(false)
        }
    }

    const downloadTemplate = (type: 'csv' | 'excel') => {
        if (type === 'csv') {
            const blob = new Blob(['pin,serial_number\n123456789012,WR123456\n'], { type: 'text/csv' })
            const url = window.URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = 'results_checker_template.csv'
            a.click()
        } else {
            toast.error('Excel template not yet available. Use CSV template.')
        }
    }

    if (authLoading || loading) return (
        <div className="flex h-[80vh] items-center justify-center">
            <Loader2 className="w-8 h-8 animate-spin text-emerald-500" />
        </div>
    )

    const TABS = [
        { key: 'types', label: 'Exam Types' },
        { key: 'inventory', label: 'Inventory' },
        { key: 'orders', label: 'Orders' },
        { key: 'complaints', label: 'Complaints' },
    ] as const

    return (
        <div className="max-w-7xl mx-auto px-3 sm:px-4 py-6 sm:py-8 space-y-5 sm:space-y-6">

            {/* ── Page Header ── */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                    <h1 className="text-xl sm:text-2xl font-black text-gray-900 dark:text-white flex items-center gap-2">
                        <ShieldCheck className="w-5 h-5 sm:w-6 sm:h-6 text-emerald-500 flex-shrink-0" /> Results Checker
                    </h1>
                    <p className="text-gray-500 text-sm mt-0.5">Manage vouchers, inventory, and global storefront settings.</p>
                </div>
                <button
                    onClick={handleReleaseReservations}
                    disabled={releasing}
                    className="flex items-center gap-2 px-4 py-2.5 bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800 rounded-xl text-sm font-bold hover:opacity-90 disabled:opacity-50 transition-all self-start sm:self-auto flex-shrink-0"
                >
                    {releasing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                    Release Reservations
                </button>
            </div>

            {/* ── Global Settings ── */}
            <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm overflow-hidden">
                <div className="px-4 sm:px-6 py-4 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between gap-3 bg-gray-50/50 dark:bg-gray-800/30">
                    <h2 className="text-sm font-black text-gray-900 dark:text-white flex items-center gap-2 uppercase tracking-tight">
                        <Settings2 className="w-4 h-4 text-gray-500" /> Global Settings
                    </h2>
                    <div className="flex items-center gap-2">
                        <button onClick={handleSaveSettings} disabled={savingSettings}
                            className="px-4 py-2 bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded-xl text-xs font-bold flex items-center gap-2 hover:opacity-90 disabled:opacity-50 transition-all active:scale-95 flex-shrink-0">
                            {savingSettings ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save
                        </button>
                        <button
                            onClick={() => setSettingsCollapsed(c => !c)}
                            className="p-2 rounded-xl hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                            title={settingsCollapsed ? 'Expand settings' : 'Collapse settings'}>
                            {settingsCollapsed
                                ? <ChevronDown className="w-4 h-4 text-gray-500" />
                                : <ChevronUp className="w-4 h-4 text-gray-500" />}
                        </button>
                    </div>
                </div>
                {!settingsCollapsed && (
                    <div className="p-4 sm:p-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-5">
                        {[
                            {
                                id: 'rc-enabled', key: 'results_checker_enabled', label: 'Enable RC (Main Site)',
                                hint: 'Controls the logged-in user dashboard.',
                                type: 'select', options: [
                                    { value: 'true', label: 'Enabled' },
                                    { value: 'false', label: 'Disabled' },
                                ]
                            },
                            {
                                id: 'rc-storefront-enabled', key: 'results_checker_storefront_enabled', label: 'Enable RC (Guest Storefronts)',
                                hint: 'Controls public /shop storefronts.',
                                type: 'select', options: [
                                    { value: 'true', label: 'Enabled' },
                                    { value: 'false', label: 'Disabled' },
                                ]
                            },
                            { id: 'rc-fee', key: 'results_checker_paystack_fee_percent', label: 'Paystack Fee %', hint: 'Added to guest total (buyer pays fee).', type: 'number', placeholder: '1.95', step: '0.01' },
                            { id: 'rc-max-qty', key: 'results_checker_max_quantity', label: 'Max Vouchers Per Order', type: 'number', placeholder: '50' },
                            { id: 'rc-max-markup-customer', key: 'results_checker_max_markup_customer', label: 'Max Shop Markup (Customer)', hint: 'Cap for Customer shops.', type: 'number', step: '0.5', placeholder: '0' },
                            { id: 'rc-max-markup-agent', key: 'results_checker_max_markup_agent', label: 'Max Shop Markup (Agent)', hint: 'Cap for Agent shops.', type: 'number', step: '0.5', placeholder: '0' },
                            { id: 'rc-max-markup-dealer', key: 'results_checker_max_markup_dealer', label: 'Max Shop Markup (Dealer)', hint: 'Cap for Dealer shops.', type: 'number', step: '0.5', placeholder: '0' },
                        ].map(f => (
                            <div key={f.id}>
                                <label htmlFor={f.id} className="block text-xs font-bold text-gray-600 dark:text-gray-400 mb-1.5">{f.label}</label>
                                {f.type === 'select' ? (
                                    <select id={f.id} title={f.label}
                                        value={settings[f.key] || 'false'}
                                        onChange={e => setSettings(s => ({ ...s, [f.key]: e.target.value }))}
                                        className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-emerald-500/30 transition-all">
                                        {f.options!.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                                    </select>
                                ) : (
                                    <input id={f.id} title={f.label} type="number"
                                        placeholder={f.placeholder}
                                        step={(f as any).step}
                                        value={settings[f.key] || ''}
                                        onChange={e => setSettings(s => ({ ...s, [f.key]: e.target.value }))}
                                        className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-emerald-500/30 transition-all" />
                                )}
                                {f.hint && <p className="text-xs text-gray-400 mt-1">{f.hint}</p>}
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* ── Tabs ── */}
            <div className="overflow-x-auto -mx-3 sm:-mx-4 px-3 sm:px-4">
                <div className="flex gap-1 border-b border-gray-200 dark:border-gray-800 min-w-max">
                    {TABS.map(tab => (
                        <button key={tab.key} onClick={() => setActiveTab(tab.key)}
                            className={`px-4 sm:px-5 py-2.5 font-bold text-sm border-b-2 transition-all whitespace-nowrap ${
                                activeTab === tab.key
                                    ? 'border-emerald-500 text-emerald-600 dark:text-emerald-400'
                                    : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300'
                            }`}>
                            {tab.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* ── Types Tab ── */}
            {activeTab === 'types' && (
                <div className="space-y-5">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white dark:bg-gray-900 p-4 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm">
                        <div className="relative flex-1 max-w-md">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
                            <input
                                type="text"
                                placeholder="Search exam types..."
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm focus:ring-2 focus:ring-emerald-500/30 outline-none transition-all"
                            />
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                            <div className="flex bg-gray-100 dark:bg-gray-800 p-1 rounded-xl">
                                {(['all', 'active', 'archived'] as const).map(f => (
                                    <button key={f} onClick={() => setFilterStatus(f)}
                                        className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-all ${filterStatus === f ? 'bg-white dark:bg-gray-700 shadow-sm text-emerald-600 dark:text-emerald-400' : 'text-gray-500 hover:text-gray-700'}`}>
                                        {f.charAt(0).toUpperCase() + f.slice(1)}
                                    </button>
                                ))}
                            </div>
                            <button onClick={() => handleOpenTypeModal()}
                                className="px-4 py-2.5 bg-emerald-600 text-white rounded-xl text-sm font-bold hover:bg-emerald-700 flex items-center gap-1.5 shadow-sm transition-all active:scale-95">
                                <Plus className="w-4 h-4" /> Add Type
                            </button>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        {types
                            .filter(t => {
                                const matchesSearch = t.name.toLowerCase().includes(searchQuery.toLowerCase())
                                const matchesFilter = filterStatus === 'all' || (filterStatus === 'active' ? t.is_active : !t.is_active)
                                return matchesSearch && matchesFilter
                            })
                            .map(t => {
                                const bulkTiers: any[] = (t as any).bulk_pricing || []
                                return (
                                    <div key={t.id} className="group bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm hover:shadow-lg hover:border-emerald-500/30 transition-all duration-200 overflow-hidden flex flex-col">
                                        {/* Card Header */}
                                        <div className="px-4 py-3.5 border-b border-gray-100 dark:border-gray-800 flex justify-between items-start gap-2">
                                            <div className="min-w-0 flex-1">
                                                <h3 className="text-sm font-black text-gray-900 dark:text-white tracking-tight group-hover:text-emerald-600 transition-colors uppercase truncate">{t.name}</h3>
                                                <div className="flex items-center gap-2 mt-1 flex-wrap">
                                                    <span className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase ${t.is_active ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-400'}`}>
                                                        <span className={`w-1.5 h-1.5 rounded-full ${t.is_active ? 'bg-emerald-500' : 'bg-gray-400'}`} />
                                                        {t.is_active ? 'Live' : 'Archived'}
                                                    </span>
                                                    {bulkTiers.length > 0 && (
                                                        <span className="text-[9px] font-bold uppercase text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 px-1.5 py-0.5 rounded-md">Bulk</span>
                                                    )}
                                                </div>
                                            </div>
                                            <button onClick={() => handleOpenTypeModal(t)}
                                                className="p-2 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 text-gray-400 hover:text-emerald-600 rounded-xl transition-all flex-shrink-0"
                                                title="Edit Type">
                                                <Edit2 className="w-4 h-4" />
                                            </button>
                                        </div>

                                        {/* Pricing Row */}
                                        <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-800">
                                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                                                <div className="p-2 bg-gray-50 dark:bg-gray-800/50 rounded-xl text-center">
                                                    <p className="text-[9px] font-bold text-gray-400 uppercase mb-0.5">Cost</p>
                                                    <p className="text-xs font-black text-gray-700 dark:text-gray-300 truncate">{formatCurrency(t.cost_price)}</p>
                                                </div>
                                                <div className="p-2 bg-blue-50 dark:bg-blue-900/10 rounded-xl text-center">
                                                    <p className="text-[9px] font-bold text-blue-400 uppercase mb-0.5">Customer</p>
                                                    <p className="text-xs font-black text-blue-700 dark:text-blue-400 truncate">{formatCurrency(t.customer_price)}</p>
                                                </div>
                                                <div className="p-2 bg-emerald-50 dark:bg-emerald-900/10 rounded-xl text-center">
                                                    <p className="text-[9px] font-bold text-emerald-500 uppercase mb-0.5">Agent</p>
                                                    <p className="text-xs font-black text-emerald-600 dark:text-emerald-400 truncate">{formatCurrency(t.agent_price)}</p>
                                                </div>
                                                <div className="p-2 bg-purple-50 dark:bg-purple-900/10 rounded-xl text-center">
                                                    <p className="text-[9px] font-bold text-purple-500 uppercase mb-0.5">Dealer</p>
                                                    <p className="text-xs font-black text-purple-600 dark:text-purple-400 truncate">{formatCurrency(t.dealer_price)}</p>
                                                </div>
                                            </div>
                                        </div>

                                        {/* Stock Row */}
                                        <div className="px-4 py-3 flex-1">
                                            <div className="grid grid-cols-2 gap-1.5">
                                                {[
                                                    { label: 'Available', val: t.stock.available, cls: 'text-emerald-600 dark:text-emerald-400' },
                                                    { label: 'Reserved', val: t.stock.reserved, cls: 'text-amber-600 dark:text-amber-400' },
                                                    { label: 'Sold', val: t.stock.sold, cls: 'text-blue-600 dark:text-blue-400' },
                                                    { label: 'Invalid', val: t.stock.invalid, cls: 'text-red-500 dark:text-red-400' },
                                                ].map(({ label, val, cls }) => (
                                                    <div key={label} className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-gray-50 dark:bg-gray-800">
                                                        <span className={`text-[10px] font-bold ${cls}`}>{label}</span>
                                                        <span className="text-sm font-black text-gray-900 dark:text-white">{val}</span>
                                                    </div>
                                                ))}
                                            </div>

                                            {bulkTiers.length > 0 && (
                                                <div className="border-t border-gray-100 dark:border-gray-800 pt-2.5 mt-2.5 space-y-1.5">
                                                    <p className="text-[9px] font-bold text-gray-400 uppercase tracking-wide">Bulk Tiers</p>
                                                    {bulkTiers.map((tier: any, i: number) => (
                                                        <div key={i} className="flex justify-between items-center text-xs px-2.5 py-1.5 bg-amber-50 dark:bg-amber-900/10 rounded-lg">
                                                            <span className="font-bold text-amber-700 dark:text-amber-400">{tier.min_qty}{tier.max_qty >= 99999 ? '+' : `–${tier.max_qty}`} vouchers</span>
                                                            <span className="font-black text-amber-800 dark:text-amber-300">{formatCurrency(tier.unit_price)}/ea</span>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>

                                        {/* Footer */}
                                        <div className="px-4 py-2 bg-gray-50/50 dark:bg-gray-800/20 border-t border-gray-100 dark:border-gray-800">
                                            <span className="text-[10px] font-bold text-gray-400">Total Stock: {t.stock.total}</span>
                                        </div>
                                    </div>
                                )
                            })}
                    </div>

                    {types.filter(t => {
                        const m = t.name.toLowerCase().includes(searchQuery.toLowerCase())
                        const f = filterStatus === 'all' || (filterStatus === 'active' ? t.is_active : !t.is_active)
                        return m && f
                    }).length === 0 && (
                        <div className="text-center py-20 bg-white dark:bg-gray-900 rounded-3xl border border-dashed border-gray-300 dark:border-gray-800">
                            <AlertCircle className="w-10 h-10 text-gray-300 mx-auto mb-3" />
                            <p className="text-gray-500 font-bold text-sm">No exam types match your filters.</p>
                        </div>
                    )}
                </div>
            )}

            {/* ── Inventory Tab ── */}
            {activeTab === 'inventory' && (
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
                    <div className="lg:col-span-1 bg-white dark:bg-gray-900 p-4 sm:p-5 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm self-start">
                        <h3 className="font-black text-base text-gray-900 dark:text-white mb-4 flex items-center gap-2 uppercase tracking-tight">
                            <FileUp className="w-4 h-4 text-gray-500" /> Upload Vouchers
                        </h3>

                        <div className="space-y-4">
                            <div>
                                <label htmlFor="rc-exam-type" className="block text-xs font-bold text-gray-500 uppercase mb-1.5">Exam Type</label>
                                <select id="rc-exam-type" title="Exam Type" value={uploadTypeId} onChange={e => setUploadTypeId(e.target.value)}
                                    className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm focus:ring-2 focus:ring-emerald-500/30 outline-none transition-all">
                                    <option value="">Select Type...</option>
                                    {types.filter(t => t.is_active).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                                </select>
                            </div>

                            <div className="flex rounded-xl p-1 bg-gray-100 dark:bg-gray-800">
                                {(['csv', 'excel', 'manual'] as const).map(m => (
                                    <button key={m} onClick={() => setUploadMode(m)}
                                        className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all ${uploadMode === m ? 'bg-white dark:bg-gray-700 shadow text-gray-900 dark:text-white' : 'text-gray-500'}`}>
                                        {m.charAt(0).toUpperCase() + m.slice(1)}
                                    </button>
                                ))}
                            </div>

                            {uploadMode !== 'manual' ? (
                                <div className="border-2 border-dashed border-gray-200 dark:border-gray-700 rounded-xl p-5 text-center hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                                    <input type="file" title="Upload File"
                                        accept={uploadMode === 'csv' ? '.csv' : '.xlsx'}
                                        onChange={e => setUploadFile(e.target.files?.[0] || null)}
                                        className="block w-full text-sm text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-bold file:bg-emerald-50 file:text-emerald-700 hover:file:bg-emerald-100" />
                                    <button onClick={() => downloadTemplate('csv')} className="mt-3 text-xs font-bold text-emerald-600 hover:underline">Download Template</button>
                                </div>
                            ) : (
                                <div>
                                    <label htmlFor="rc-manual-text" className="text-xs text-gray-500 mb-1.5 block font-medium">Format: PIN,SERIAL (one per line)</label>
                                    <textarea id="rc-manual-text" title="Manual Entry" value={uploadText} onChange={e => setUploadText(e.target.value)} rows={6}
                                        className="w-full p-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 font-mono text-sm focus:ring-2 focus:ring-emerald-500/30 outline-none resize-none"
                                        placeholder={"123456789012,WR123456\n987654321098,WR987654"} />
                                </div>
                            )}

                            <button onClick={handleUpload} disabled={uploading}
                                className="w-full py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-bold text-sm uppercase tracking-wide flex items-center justify-center gap-2 transition-all active:scale-95 disabled:opacity-50">
                                {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Database className="w-4 h-4" />} Process Upload
                            </button>

                            {uploadResult && (
                                <div className="p-3.5 rounded-xl bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-sm space-y-1">
                                    <p className="text-emerald-600 font-bold text-xs">✓ {uploadResult.inserted} Inserted</p>
                                    {uploadResult.skipped > 0 && <p className="text-amber-600 font-bold text-xs">! {uploadResult.skipped} Duplicates Skipped</p>}
                                    {uploadResult.errors.length > 0 && (
                                        <div className="mt-2 text-red-600 text-xs max-h-32 overflow-y-auto">
                                            <p className="font-bold">Errors:</p>
                                            <ul className="list-disc pl-4 mt-1 space-y-0.5">
                                                {uploadResult.errors.map((e, i) => <li key={i}>{e}</li>)}
                                            </ul>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="lg:col-span-2 bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm overflow-hidden">
                        <div className="p-4 border-b border-gray-200 dark:border-gray-800 space-y-3">
                            <p className="font-black text-sm text-gray-900 dark:text-white uppercase tracking-tight">Recent Additions (100)</p>
                            <div className="flex flex-col sm:flex-row gap-2">
                                <input type="text" placeholder="Search PIN or Serial..." value={invSearch} onChange={e => setInvSearch(e.target.value)}
                                    className="flex-1 px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/30 min-w-0" />
                                <select title="Filter by type" value={invTypeFilter} onChange={e => setInvTypeFilter(e.target.value)}
                                    className="px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/30">
                                    <option value="">All Types</option>
                                    {types.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
                                </select>
                                <select title="Filter by status" value={invStatusFilter} onChange={e => setInvStatusFilter(e.target.value)}
                                    className="px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/30">
                                    <option value="">All Status</option>
                                    <option value="available">Available</option>
                                    <option value="sold">Sold</option>
                                    <option value="reserved">Reserved</option>
                                    <option value="invalid">Invalid</option>
                                </select>
                            </div>
                        </div>
                        <div className="overflow-x-auto">
                            <table className="w-full text-left text-sm">
                                <thead className="bg-gray-50 dark:bg-gray-800 text-[10px] uppercase font-black text-gray-500">
                                    <tr>
                                        <th className="px-4 py-3">Type</th>
                                        <th className="px-4 py-3">PIN (Masked)</th>
                                        <th className="px-4 py-3">Serial</th>
                                        <th className="px-4 py-3">Status</th>
                                        <th className="px-4 py-3 text-right">Actions</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                                    {inventory.filter(inv => {
                                        if (invSearch && !inv.pin.includes(invSearch) && !inv.serial_number.includes(invSearch)) return false
                                        if (invTypeFilter && inv.type?.name !== invTypeFilter) return false
                                        if (invStatusFilter && inv.status !== invStatusFilter) return false
                                        return true
                                    }).map(inv => (
                                        <tr key={inv.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors">
                                            <td className="px-4 py-3 font-medium text-sm">{inv.type?.name}</td>
                                            <td className="px-4 py-3 font-mono text-sm">{inv.pin.slice(0, 4)}••••••••</td>
                                            <td className="px-4 py-3 font-mono text-sm">{inv.serial_number}</td>
                                            <td className="px-4 py-3">
                                                <span className={`px-2 py-0.5 rounded-lg text-[10px] font-bold uppercase ${
                                                    inv.status === 'available' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' :
                                                    inv.status === 'reserved' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' :
                                                    inv.status === 'invalid' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' :
                                                    'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
                                                }`}>{inv.status}</span>
                                            </td>
                                            <td className="px-4 py-3 text-right">
                                                {(inv.status === 'available' || inv.status === 'invalid') && (
                                                    <button
                                                        onClick={async () => {
                                                            if (!confirm('Delete this voucher?')) return
                                                            try {
                                                                const res = await fetch(`/api/admin/results-checker/inventory?id=${inv.id}`, { method: 'DELETE' })
                                                                if (res.ok) { toast.success('Voucher deleted'); fetchData() }
                                                                else { const d = await res.json(); toast.error(d.error || 'Failed to delete') }
                                                            } catch { toast.error('Failed to delete') }
                                                        }}
                                                        className="p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
                                                        title="Delete Voucher">
                                                        <Archive className="w-4 h-4" />
                                                    </button>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            )}

            {/* ── Orders Tab ── */}
            {activeTab === 'orders' && (
                <>
                    <div className="space-y-4">
                        <div className="flex flex-col sm:flex-row gap-2">
                            <input type="text" placeholder="Search reference, name, phone..." value={orderSearch} onChange={e => setOrderSearch(e.target.value)}
                                className="flex-1 px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/30 min-w-0" />
                            <div className="flex gap-1.5 overflow-x-auto pb-0.5">
                                {(['all','today','yesterday','this_week','this_month'] as const).map(p => (
                                    <button key={p} onClick={() => setOrderDatePreset(p)}
                                        className={`px-3 py-2 rounded-xl text-xs font-bold uppercase transition-all whitespace-nowrap flex-shrink-0 ${
                                            orderDatePreset === p ? 'bg-emerald-600 text-white shadow-sm' : 'bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-500 hover:border-emerald-400'
                                        }`}>
                                        {p === 'this_week' ? 'Week' : p === 'this_month' ? 'Month' : p.charAt(0).toUpperCase() + p.slice(1)}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div className="space-y-2.5">
                            {orders.filter(o => {
                                const s = orderSearch.toLowerCase()
                                if (s && !o.reference_code.toLowerCase().includes(s) && !o.type_name.toLowerCase().includes(s) && !(o.customer_phone || '').includes(s) && !((o as any).user_name || '').toLowerCase().includes(s)) return false
                                const d = new Date(o.created_at); const today = new Date(); today.setHours(0,0,0,0); const od = new Date(d); od.setHours(0,0,0,0)
                                if (orderDatePreset === 'today' && od.getTime() !== today.getTime()) return false
                                if (orderDatePreset === 'yesterday') { const y = new Date(today); y.setDate(today.getDate()-1); if (od.getTime() !== y.getTime()) return false }
                                if (orderDatePreset === 'this_week') { const w = new Date(today); w.setDate(today.getDate()-today.getDay()); if (od < w) return false }
                                if (orderDatePreset === 'this_month' && (d.getMonth() !== today.getMonth() || d.getFullYear() !== today.getFullYear())) return false
                                return true
                            }).map(order => (
                                <div key={order.id} className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-4 shadow-sm hover:shadow-md transition-shadow">
                                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                                        <div className="space-y-1 min-w-0">
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <span className="font-mono text-[10px] text-emerald-600 dark:text-emerald-400 font-bold bg-emerald-50 dark:bg-emerald-900/20 px-2 py-0.5 rounded">{order.reference_code}</span>
                                                <span className={`px-2 py-0.5 rounded-lg text-[10px] font-bold uppercase ${order.status === 'completed' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' : order.status === 'pending' ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}`}>{order.status}</span>
                                                {order.source === 'ussd' && <span className="px-2 py-0.5 rounded-lg text-[10px] font-bold uppercase bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">USSD</span>}
                                            </div>
                                            <p className="font-bold text-gray-900 dark:text-white text-sm">{order.quantity}× {order.type_name}</p>
                                            <p className="text-xs text-gray-500 font-medium">
                                                👤 {(order as any).user_name || (order as any).customer_name || 'Guest'}
                                                {(order as any).shop_name && <span className="ml-2">🏪 {(order as any).shop_name}</span>}
                                                {order.customer_phone && <span className="ml-2">· {order.customer_phone}</span>}
                                            </p>
                                            <p className="text-[10px] text-gray-400">{new Date(order.created_at).toLocaleString()}</p>
                                        </div>
                                        <div className="flex sm:flex-col items-center sm:items-end gap-3 flex-shrink-0">
                                            <span className="text-lg font-black text-emerald-600">{formatCurrency(order.total_paid)}</span>
                                            <button
                                                onClick={async () => {
                                                    setLoadingVouchers(true)
                                                    try {
                                                        const res = await fetch(`/api/admin/results-checker/orders/vouchers?orderId=${order.id}`)
                                                        const d = await res.json()
                                                        if (d.success) setViewingOrder({ order, vouchers: d.vouchers })
                                                        else toast.error(d.error || 'Failed to load vouchers')
                                                    } catch { toast.error('Network error') } finally { setLoadingVouchers(false) }
                                                }}
                                                disabled={loadingVouchers}
                                                className="px-3 py-1.5 text-xs font-bold bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 rounded-xl border border-emerald-200 dark:border-emerald-800 hover:bg-emerald-100 disabled:opacity-50 flex items-center gap-1.5 transition-all">
                                                {loadingVouchers ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Database className="w-3.5 h-3.5" />} View Vouchers
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            ))}
                            {orders.length === 0 && (
                                <div className="text-center py-16 text-gray-400 font-bold text-sm">No orders found.</div>
                            )}
                        </div>
                    </div>

                    {/* View Vouchers Modal */}
                    {viewingOrder && (
                        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-3 sm:p-4" onClick={() => setViewingOrder(null)}>
                            <div className="bg-white dark:bg-gray-900 rounded-3xl border border-gray-200 dark:border-gray-700 shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
                                <div className="p-4 sm:p-5 border-b border-gray-100 dark:border-gray-800 flex items-start justify-between gap-3 flex-shrink-0">
                                    <div>
                                        <h3 className="font-black text-gray-900 dark:text-white text-base uppercase tracking-tight">Voucher Details</h3>
                                        <p className="text-[10px] text-gray-500 font-mono mt-0.5">{viewingOrder.order.reference_code}</p>
                                        <p className="text-xs text-gray-500 mt-0.5">Customer: <span className="font-bold text-gray-700 dark:text-gray-300">{viewingOrder.order.user_name || viewingOrder.order.customer_name || 'Guest'}</span></p>
                                        {viewingOrder.order.customer_email && <p className="text-xs text-gray-400">Email: <span className="font-medium">{viewingOrder.order.customer_email}</span></p>}
                                        {viewingOrder.order.customer_phone && <p className="text-xs text-gray-400">Phone: <span className="font-medium">{viewingOrder.order.customer_phone}</span></p>}
                                    </div>
                                    <button onClick={() => setViewingOrder(null)}
                                        className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors flex-shrink-0">
                                        <X className="w-5 h-5" />
                                    </button>
                                </div>
                                <div className="overflow-y-auto flex-1 p-4 sm:p-5 space-y-3">
                                    {viewingOrder.vouchers.length === 0 ? (
                                        <p className="text-center text-gray-400 text-sm py-8">No vouchers assigned to this order yet.</p>
                                    ) : viewingOrder.vouchers.map((v: any, idx: number) => (
                                        <div key={v.id} className="bg-gray-50 dark:bg-gray-800 rounded-2xl p-4 border border-gray-100 dark:border-gray-700">
                                            <div className="flex items-center justify-between mb-3">
                                                <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest">Voucher {idx + 1}</span>
                                                {v.expiry_date && <span className="text-[10px] text-amber-600 font-bold">Expires: {v.expiry_date}</span>}
                                            </div>
                                            <div className="space-y-2">
                                                <div className="flex items-center justify-between bg-white dark:bg-gray-900 rounded-xl px-3.5 py-2.5 border border-gray-100 dark:border-gray-700">
                                                    <div className="min-w-0">
                                                        <p className="text-[9px] text-gray-400 font-bold uppercase mb-0.5">PIN</p>
                                                        <p className="font-mono font-black text-gray-900 dark:text-white tracking-widest text-sm">{v.pin}</p>
                                                    </div>
                                                    <button onClick={() => { navigator.clipboard.writeText(v.pin); toast.success('PIN copied!') }}
                                                        title="Copy PIN"
                                                        className="p-1.5 text-emerald-600 hover:text-emerald-700 rounded-lg hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-all flex-shrink-0 ml-2">
                                                        <Copy className="w-4 h-4" />
                                                    </button>
                                                </div>
                                                <div className="flex items-center justify-between bg-white dark:bg-gray-900 rounded-xl px-3.5 py-2.5 border border-gray-100 dark:border-gray-700">
                                                    <div className="min-w-0">
                                                        <p className="text-[9px] text-gray-400 font-bold uppercase mb-0.5">Serial</p>
                                                        <p className="font-mono font-black text-gray-900 dark:text-white tracking-widest text-sm">{v.serial_number}</p>
                                                    </div>
                                                    <button onClick={() => { navigator.clipboard.writeText(v.serial_number); toast.success('Serial copied!') }}
                                                        title="Copy Serial"
                                                        className="p-1.5 text-emerald-600 hover:text-emerald-700 rounded-lg hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-all flex-shrink-0 ml-2">
                                                        <Copy className="w-4 h-4" />
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>
                    )}
                </>
            )}

            {/* ── Complaints Tab ── */}
            {activeTab === 'complaints' && (
                <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm overflow-hidden">
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm">
                            <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 text-[10px] uppercase font-black text-gray-500">
                                <tr>
                                    <th className="px-4 py-3">Date</th>
                                    <th className="px-4 py-3">User / Shop</th>
                                    <th className="px-4 py-3">Order Ref</th>
                                    <th className="px-4 py-3">Issue</th>
                                    <th className="px-4 py-3">Status</th>
                                    <th className="px-4 py-3">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                                {complaints.length === 0 ? (
                                    <tr><td colSpan={6} className="p-12 text-center text-gray-400 font-medium">No complaints found.</td></tr>
                                ) : complaints.map(c => (
                                    <tr key={c.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors">
                                        <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{new Date(c.created_at).toLocaleString()}</td>
                                        <td className="px-4 py-3">
                                            <div className="font-bold text-sm text-gray-900 dark:text-white">{c.user?.first_name} {c.user?.last_name}</div>
                                            <div className="text-xs text-gray-400">{c.shop?.shop_name || 'Direct Purchase'}</div>
                                        </td>
                                        <td className="px-4 py-3 font-mono text-xs text-emerald-600 dark:text-emerald-400 font-bold whitespace-nowrap">{c.order?.reference_code}</td>
                                        <td className="px-4 py-3 max-w-xs">
                                            <p className="text-sm text-gray-700 dark:text-gray-300 truncate" title={c.description}>{c.description}</p>
                                        </td>
                                        <td className="px-4 py-3">
                                            <span className={`px-2 py-0.5 rounded-lg text-[10px] font-bold uppercase ${c.status === 'resolved' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'}`}>{c.status}</span>
                                        </td>
                                        <td className="px-4 py-3">
                                            {c.status === 'open' && (
                                                <button
                                                    onClick={() => handleResolveComplaint(c.id)}
                                                    className="px-3 py-1.5 bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded-lg text-xs font-bold hover:opacity-80 transition-all">
                                                    Resolve
                                                </button>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* ── Exam Type Modal (scrollable) ── */}
            {isTypeModalOpen && (
                <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-3 sm:p-4">
                    <div className="bg-white dark:bg-gray-900 w-full max-w-md rounded-2xl shadow-2xl border border-gray-100 dark:border-gray-800 flex flex-col max-h-[92vh]">

                        {/* Modal Header — sticky */}
                        <div className="flex items-center justify-between px-5 sm:px-6 py-4 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
                            <h3 className="text-lg font-black text-gray-900 dark:text-white">
                                {editingType.id ? 'Edit Exam Type' : 'Add Exam Type'}
                            </h3>
                            <button onClick={() => setIsTypeModalOpen(false)}
                                className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        {/* Modal Body — scrollable */}
                        <div className="overflow-y-auto flex-1 px-5 sm:px-6 py-4 space-y-4">

                            <div>
                                <label className="block text-xs font-bold text-gray-500 uppercase mb-1.5">Exam Name</label>
                                <input type="text" title="Exam Name" placeholder="e.g. WAEC Scratch Card"
                                    value={editingType.name || ''}
                                    onChange={e => setEditingType({...editingType, name: e.target.value})}
                                    className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 font-bold text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-400 outline-none transition-all" />
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                {[
                                    { key: 'customer_price', label: 'Customer Price (GH₵)' },
                                    { key: 'agent_price', label: 'Agent Price (GH₵)' },
                                    { key: 'dealer_price', label: 'Dealer Price (GH₵)' },
                                    { key: 'cost_price', label: 'Cost Price (GH₵)' },
                                ].map(f => (
                                    <div key={f.key}>
                                        <label className="block text-xs font-bold text-gray-500 uppercase mb-1.5">{f.label}</label>
                                        <input type="number" title={f.label} placeholder="0.00" step="0.5" min="0"
                                            value={(editingType as any)[f.key] || 0}
                                            onChange={e => setEditingType({...editingType, [f.key]: parseFloat(e.target.value) || 0})}
                                            className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 font-bold text-sm focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-400 outline-none transition-all" />
                                    </div>
                                ))}

                                {/* USSD Price */}
                                <div className="col-span-2 rounded-xl border border-orange-200 dark:border-orange-800 bg-orange-50 dark:bg-orange-950/30 p-3">
                                    <label className="block text-xs font-bold text-orange-600 uppercase mb-1.5">USSD Price — *713*9939# (GH₵)</label>
                                    <input
                                        type="number"
                                        title="USSD Price"
                                        placeholder="Leave empty to use Customer Price"
                                        step="0.5"
                                        min="0"
                                        value={(editingType as any).ussd_price ?? ''}
                                        onChange={e => setEditingType({...editingType, ussd_price: e.target.value ? parseFloat(e.target.value) : null} as any)}
                                        className="w-full px-3 py-2.5 rounded-xl border border-orange-200 dark:border-orange-700 bg-white dark:bg-gray-800 font-bold text-sm focus:ring-2 focus:ring-orange-500/30 focus:border-orange-400 outline-none transition-all"
                                    />
                                    <p className="text-[10px] text-orange-600 dark:text-orange-400 mt-1.5">Price for USSD users. Leave empty to fall back to Customer Price.</p>
                                </div>

                                <div>
                                    <label className="block text-xs font-bold text-gray-500 uppercase mb-1.5">Display Order</label>
                                    <input type="number" title="Display Order" placeholder="0" min="0"
                                        value={editingType.display_order || 0}
                                        onChange={e => setEditingType({...editingType, display_order: parseInt(e.target.value) || 0})}
                                        className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 font-bold text-sm focus:ring-2 focus:ring-emerald-500/30 outline-none transition-all" />
                                </div>
                            </div>

                            {/* Active Toggle */}
                            <div
                                className="flex items-center gap-3 p-3 rounded-xl bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 cursor-pointer select-none"
                                onClick={() => setEditingType({...editingType, is_active: !editingType.is_active})}>
                                <input type="checkbox" id="isActive" checked={editingType.is_active} readOnly
                                    className="w-4 h-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500 pointer-events-none" />
                                <div>
                                    <label htmlFor="isActive" className="text-sm font-bold text-gray-900 dark:text-white pointer-events-none">Active / Visible</label>
                                    <p className="text-xs text-gray-500">Uncheck to hide from storefronts.</p>
                                </div>
                            </div>

                            {/* Bulk Pricing Tiers */}
                            <div className="border border-dashed border-gray-200 dark:border-gray-700 rounded-xl p-4 space-y-3">
                                <div className="flex items-center justify-between">
                                    <p className="text-xs font-black text-gray-500 uppercase tracking-widest">Bulk Pricing Tiers</p>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            const tiers = [...((editingType as any).bulk_pricing || [])]
                                            tiers.push({ min_qty: 10, max_qty: 20, unit_price: 0 })
                                            setEditingType({ ...editingType, bulk_pricing: tiers } as any)
                                        }}
                                        className="text-xs font-bold text-emerald-600 hover:text-emerald-700 flex items-center gap-1 transition-colors">
                                        <Plus className="w-3 h-3" /> Add Tier
                                    </button>
                                </div>
                                {((editingType as any).bulk_pricing || []).length === 0 && (
                                    <p className="text-xs text-gray-400 text-center py-2">No bulk tiers. Add one to offer volume discounts.</p>
                                )}
                                <div className="space-y-2.5">
                                    {((editingType as any).bulk_pricing || []).map((tier: any, i: number) => (
                                        <div key={i} className="grid grid-cols-4 gap-2 items-end">
                                            <div>
                                                <p className="text-[10px] font-bold text-gray-400 mb-1">Min Qty</p>
                                                <input type="number" min="1" title="Min Qty" value={tier.min_qty}
                                                    onChange={e => {
                                                        const tiers = [...(editingType as any).bulk_pricing]
                                                        tiers[i] = { ...tiers[i], min_qty: parseInt(e.target.value) || 1 }
                                                        setEditingType({ ...editingType, bulk_pricing: tiers } as any)
                                                    }}
                                                    className="w-full px-2 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm font-bold focus:ring-1 focus:ring-emerald-500 outline-none" />
                                            </div>
                                            <div>
                                                <p className="text-[10px] font-bold text-gray-400 mb-1">Max Qty</p>
                                                <input type="number" min="1" title="Max Qty" value={tier.max_qty}
                                                    onChange={e => {
                                                        const tiers = [...(editingType as any).bulk_pricing]
                                                        tiers[i] = { ...tiers[i], max_qty: parseInt(e.target.value) || 1 }
                                                        setEditingType({ ...editingType, bulk_pricing: tiers } as any)
                                                    }}
                                                    className="w-full px-2 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm font-bold focus:ring-1 focus:ring-emerald-500 outline-none" />
                                            </div>
                                            <div>
                                                <p className="text-[10px] font-bold text-gray-400 mb-1">Price (GH₵)</p>
                                                <input type="number" min="0" step="0.5" title="Bulk Price" value={tier.unit_price}
                                                    onChange={e => {
                                                        const tiers = [...(editingType as any).bulk_pricing]
                                                        tiers[i] = { ...tiers[i], unit_price: parseFloat(e.target.value) || 0 }
                                                        setEditingType({ ...editingType, bulk_pricing: tiers } as any)
                                                    }}
                                                    className="w-full px-2 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm font-bold focus:ring-1 focus:ring-emerald-500 outline-none" />
                                            </div>
                                            <div className="flex justify-center">
                                                <button type="button" title="Remove Tier"
                                                    onClick={() => {
                                                        const tiers = [...(editingType as any).bulk_pricing]
                                                        tiers.splice(i, 1)
                                                        setEditingType({ ...editingType, bulk_pricing: tiers } as any)
                                                    }}
                                                    className="p-2 text-red-400 hover:text-red-600 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
                                                    <X className="w-4 h-4" />
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>

                        {/* Modal Footer — sticky */}
                        <div className="flex gap-3 px-5 sm:px-6 py-4 border-t border-gray-100 dark:border-gray-800 flex-shrink-0">
                            <button onClick={() => setIsTypeModalOpen(false)}
                                className="flex-1 py-2.5 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-xl font-bold text-sm hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">
                                Cancel
                            </button>
                            <button onClick={handleSaveType} disabled={savingType}
                                className="flex-1 py-2.5 bg-emerald-600 text-white rounded-xl font-bold text-sm hover:bg-emerald-700 flex items-center justify-center gap-2 disabled:opacity-50 transition-all active:scale-95 shadow-sm">
                                {savingType ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}
