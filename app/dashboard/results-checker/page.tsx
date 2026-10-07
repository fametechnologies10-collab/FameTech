'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/contexts/auth-context'
import { supabase } from '@/lib/supabase'
import { formatCurrency, cn } from '@/lib/utils'
import {
    downloadResultsCheckerVouchers,
    type ResultsCheckerVoucher as RCVoucher,
} from '@/lib/results-checker-utils'
import { toast } from 'sonner'
import {
    FileText, Loader2, Copy, CheckCircle2, AlertCircle,
    ShoppingCart, ChevronDown, ChevronUp, RefreshCw, Clock, Zap, Download, MessageSquare,
    Info, Gift, Star, GraduationCap, ArrowRight, Wallet, ShieldCheck, Lock, Check, Eye, EyeOff, X
} from 'lucide-react'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'

interface RCType {
    id: string;
    name: string;
    price: number;
    available_count: number;
    bulk_pricing?: Array<{ min_qty: number; max_qty: number; unit_price: number }>;
    // Plan 4, Task 9 (spec C4) — present only for a sub-agent caller. `false` means
    // this specific type has no RC pricing configured for this sub (override or
    // recruiter default) — per-type, not all-or-nothing. Absent for every other role.
    configured?: boolean;
}

interface RCOrder {
    id: string; reference_code: string; type_name: string; quantity: number
    unit_price: number; total_paid: number; status: string; created_at: string
    inventory_ids: string[]
    results_checker_complaints?: { id: string, status: string }[]
}

function CopyButton({ text }: { text: string }) {
    const [copied, setCopied] = useState(false)
    const handleCopy = () => {
        navigator.clipboard.writeText(text).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
        })
    }
    return (
        <button onClick={handleCopy} className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors" title="Copy">
            {copied ? <CheckCircle2 className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4 text-gray-400" />}
        </button>
    )
}

function StatusBadge({ status }: { status: string }) {
    const map: Record<string, string> = {
        completed: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
        pending:   'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
        failed:    'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
        refunded:  'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400',
    }
    return (
        <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wide ${map[status] || map.pending}`}>
            {status}
        </span>
    )
}

export default function ResultsCheckerPage() {
    const { user, dbUser, isLoading: authLoading } = useAuth()
    const router = useRouter()

    const [pageEnabled, setPageEnabled] = useState(true)
    const [types, setTypes] = useState<RCType[]>([])
    const [orders, setOrders] = useState<RCOrder[]>([])
    const [walletBalance, setWalletBalance] = useState(0)
    const [loading, setLoading] = useState(true)
    const [purchasing, setPurchasing] = useState(false)

    const [selectedTypeId, setSelectedTypeId] = useState('')
    const [quantity, setQuantity] = useState(1)
    const [maxQty, setMaxQty] = useState(50)

    const [successOrder, setSuccessOrder] = useState<any>(null)
    const [successVouchers, setSuccessVouchers] = useState<RCVoucher[]>([])
    const [expandedOrders, setExpandedOrders] = useState<Set<string>>(new Set())
    const [orderVouchers, setOrderVouchers] = useState<Record<string, RCVoucher[]>>({})
    const [orderVoucherLoading, setOrderVoucherLoading] = useState<Record<string, boolean>>({})
    const [orderVoucherErrors, setOrderVoucherErrors] = useState<Record<string, string>>({})
    const [resending, setResending] = useState<string | null>(null)

    // Complaint state
    const [complaintOrder, setComplaintOrder] = useState<RCOrder | null>(null)
    const [complaintDesc, setComplaintDesc] = useState('')
    const [submittingComplaint, setSubmittingComplaint] = useState(false)

    // Filters
    const [searchQuery, setSearchQuery] = useState('')
    const [dateFilter, setDateFilter] = useState('')
    const [datePreset, setDatePreset] = useState('all')
    const [customDateFrom, setCustomDateFrom] = useState('')
    const [customDateTo, setCustomDateTo] = useState('')

    // Optional recipient for reseller use-case
    const [recipientPhone, setRecipientPhone] = useState('')
    const [recipientEmail, setRecipientEmail] = useState('')

    // UI States for refinement
    const [showConfirmModal, setShowConfirmModal] = useState(false)
    const [revealedPins, setRevealedPins] = useState<Set<string>>(new Set())

    const togglePinReveal = (pin: string) => {
        const next = new Set(revealedPins)
        if (next.has(pin)) next.delete(pin)
        else next.add(pin)
        setRevealedPins(next)
    }

    const fetchData = useCallback(async () => {
        try {
            const [typesRes, settingsRes] = await Promise.all([
                fetch('/api/results-checker/types'),
                (supabase as any).from('admin_settings').select('key,value')
                    .in('key', ['results_checker_enabled', 'results_checker_max_quantity'])
            ])

            const typesData = await typesRes.json()
            if (typesData.types) setTypes(typesData.types)
            // No default selection

            const settingsMap: Record<string, string> = {}
            for (const r of (settingsRes.data || [])) settingsMap[r.key] = r.value

            // If the main site RC is disabled, we don't block the whole page anymore,
            // we just disable the selection.
            if (settingsMap.results_checker_enabled === 'false') setPageEnabled(false)
            if (settingsMap.results_checker_max_quantity) setMaxQty(parseInt(settingsMap.results_checker_max_quantity, 10))

            // Fetch orders and wallet balance
            const { data: { user: authUser } } = await supabase.auth.getUser()
            if (authUser) {
                const [ordersRes, walletRes] = await Promise.all([
                    (supabase as any)
                        .from('results_checker_orders')
                        .select('*, results_checker_complaints(id, status)')
                        .eq('user_id', authUser.id)
                        .order('created_at', { ascending: false })
                        .limit(20),
                    (supabase as any)
                        .from('wallets')
                        .select('balance')
                        .eq('user_id', authUser.id)
                        .single()
                ])
                setOrders(ordersRes.data || [])
                setWalletBalance(walletRes.data?.balance || 0)
            }
        } catch (e) {
            console.error('[RC Dashboard] Fetch error:', e)
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => {
        if (!authLoading && !user) { router.replace('/login'); return }
        if (!authLoading && user) fetchData()
    }, [authLoading, user, router, fetchData])

    // Clamp the quantity to on-hand stock whenever the selected type or max changes, so a
    // stale quantity from a previously-selected, better-stocked type can't exceed what exists.
    useEffect(() => {
        const sel = types.find(t => t.id === selectedTypeId)
        if (!sel) return
        const cap = Math.max(1, Math.min(maxQty, sel.available_count))
        setQuantity(q => Math.min(q, cap))
    }, [selectedTypeId, types, maxQty])

    const selectedType = types.find(t => t.id === selectedTypeId)

    // Calculate price with bulk pricing
    const getEffectiveUnitPrice = () => {
        if (!selectedType) return 0
        const bulkTiers = selectedType.bulk_pricing || []
        const matchedTier = bulkTiers.find(tier => quantity >= tier.min_qty && quantity <= tier.max_qty)
        return matchedTier ? matchedTier.unit_price : selectedType.price
    }

    const unitPrice = getEffectiveUnitPrice()
    const totalPrice = unitPrice * quantity
    const isOutOfStock = selectedType ? selectedType.available_count === 0 : false
    // Plan 4, Task 9 (spec C4): a sub-agent type with no pricing configured — distinct from
    // out-of-stock (there IS inventory, the account just isn't priced for it yet).
    const isNotConfigured = selectedType ? selectedType.configured === false : false
    const isUnselectable = isOutOfStock || isNotConfigured
    // Main-site wallet purchase is fail-closed on stock (no backorders), so cap the quantity at
    // on-hand stock — a user can't pick more than exists and hit INSUFFICIENT_INVENTORY after paying.
    const effectiveMaxQty = selectedType ? Math.max(1, Math.min(maxQty, selectedType.available_count)) : maxQty
    const currentBulkTier = selectedType?.bulk_pricing?.find(tier => quantity >= tier.min_qty && quantity <= tier.max_qty)
    const hasInsufficientBalance = totalPrice > walletBalance

    const handlePurchase = async () => {
        if (!selectedTypeId) { toast.error('Select a voucher type'); return }
        if (isOutOfStock) { toast.error('Selected type is out of stock'); return }
        if (isNotConfigured) { toast.error('This voucher type is not available for your account'); return }
        if (quantity < 1 || quantity > effectiveMaxQty) { toast.error(`Quantity must be 1–${effectiveMaxQty}`); return }
        if (!pageEnabled) { toast.error('Results Checker is currently offline'); return }

        setPurchasing(true)
        setSuccessVouchers([])
        setSuccessOrder(null)
        try {
            const res = await fetch('/api/results-checker/purchase', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ typeId: selectedTypeId, quantity, recipientPhone: recipientPhone.trim() || undefined, recipientEmail: recipientEmail.trim() || undefined }),
            })
            const data = await res.json()
            if (!res.ok) { toast.error(data.error || 'Purchase failed'); return }
            setSuccessVouchers(data.vouchers || [])
            setSuccessOrder(data.order)
            setShowConfirmModal(false)
            toast.success('Credentials delivered successfully!')
            fetchData()
            // Invalidate the router cache so the main dashboard / header reflect the wallet debit.
            router.refresh()
        } catch { toast.error('Network error. Please try again.') }
        finally { setPurchasing(false) }
    }

    const toggleOrderExpand = async (orderId: string, inventoryIds: string[]) => {
        const next = new Set(expandedOrders)
        if (next.has(orderId)) { next.delete(orderId); setExpandedOrders(next); return }
        next.add(orderId)
        setExpandedOrders(next)

        if (!inventoryIds?.length || orderVouchers[orderId] || orderVoucherLoading[orderId]) {
            return
        }

        setOrderVoucherLoading((prev) => ({ ...prev, [orderId]: true }))
        setOrderVoucherErrors((prev) => {
            const nextErrors = { ...prev }
            delete nextErrors[orderId]
            return nextErrors
        })

        try {
            const res = await fetch('/api/results-checker/order-vouchers', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderId }),
            })
            const data = await res.json()

            if (!res.ok) {
                setOrderVoucherErrors((prev) => ({
                    ...prev,
                    [orderId]: data.error || 'Unable to load your vouchers right now.',
                }))
                return
            }

            const vouchers = Array.isArray(data.vouchers) ? data.vouchers : []

            if (inventoryIds.length > 0 && vouchers.length === 0) {
                setOrderVoucherErrors((prev) => ({
                    ...prev,
                    [orderId]: 'This order is completed, but the voucher details could not be retrieved.',
                }))
                return
            }

            setOrderVouchers((prev) => ({ ...prev, [orderId]: vouchers }))
        } catch {
            setOrderVoucherErrors((prev) => ({
                ...prev,
                [orderId]: 'Network error while loading voucher details.',
            }))
        } finally {
            setOrderVoucherLoading((prev) => ({ ...prev, [orderId]: false }))
        }
    }

    const handleResendSMS = async (orderId: string) => {
        setResending(orderId)
        try {
            const res = await fetch('/api/results-checker/resend', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderId }),
            })
            const data = await res.json()
            if (data.success) toast.success('Vouchers resent!')
            else toast.error(data.error || 'Failed to resend')
        } catch { toast.error('Network error') }
        finally { setResending(null) }
    }

    const handleDownloadSuccess = () => {
        if (successOrder && successVouchers.length > 0) {
            downloadResultsCheckerVouchers(successOrder, successVouchers, dbUser?.phone_number ?? undefined, dbUser?.email ?? undefined)
        }
    }

    const handleDownloadHistory = (order: RCOrder, vouchers: RCVoucher[]) => {
        if (!vouchers.length) {
            toast.error('Voucher details are not loaded yet.')
            return
        }

        downloadResultsCheckerVouchers(order, vouchers, dbUser?.phone_number ?? undefined, dbUser?.email ?? undefined)
    }

    const submitComplaint = async () => {
        if (!complaintOrder || !complaintDesc.trim()) return
        setSubmittingComplaint(true)
        try {
            const res = await fetch('/api/results-checker/complaints', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    orderId: complaintOrder.id,
                    description: complaintDesc
                })
            })
            const data = await res.json()
            if (res.ok) {
                toast.success('Complaint filed successfully')
                setOrders(orders.map(o => o.id === complaintOrder.id ? { ...o, results_checker_complaints: [{ id: 'temp', status: 'open' }] } : o))
                setComplaintOrder(null)
                setComplaintDesc('')
            } else {
                toast.error(data.error || 'Failed to file complaint')
            }
        } catch {
            toast.error('Network error')
        } finally {
            setSubmittingComplaint(false)
        }
    }

    if (authLoading || loading) {
        return (
            <div className="flex items-center justify-center min-h-[60vh]">
                <Loader2 className="w-8 h-8 animate-spin text-emerald-500" />
            </div>
        )
    }

    const filteredOrders = orders.filter(order => {
        const matchesSearch = order.reference_code.toLowerCase().includes(searchQuery.toLowerCase()) || order.type_name.toLowerCase().includes(searchQuery.toLowerCase())
        if (!matchesSearch) return false

        const orderDate = new Date(order.created_at)
        const today = new Date(); today.setHours(0,0,0,0)
        const orderDay = new Date(orderDate); orderDay.setHours(0,0,0,0)

        if (datePreset === 'today') {
            if (orderDay.getTime() !== today.getTime()) return false
        } else if (datePreset === 'yesterday') {
            const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1)
            if (orderDay.getTime() !== yesterday.getTime()) return false
        } else if (datePreset === 'this_week') {
            const weekStart = new Date(today); weekStart.setDate(today.getDate() - today.getDay())
            if (orderDay < weekStart) return false
        } else if (datePreset === 'this_month') {
            if (orderDate.getMonth() !== today.getMonth() || orderDate.getFullYear() !== today.getFullYear()) return false
        } else if (datePreset === 'custom') {
            if (customDateFrom && orderDay < new Date(customDateFrom)) return false
            if (customDateTo && orderDay > new Date(customDateTo)) return false
        }
        return true
    })

    return (
        <div className="max-w-4xl mx-auto px-4 pb-24 space-y-5">
            {/* Compact Header */}
            <div className="mt-6 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="space-y-0.5">
                    <div className="flex items-center gap-2 text-[#F5B800]">
                        <GraduationCap className="w-4 h-4" />
                        <span className="text-[9px] font-bold uppercase tracking-[0.2em]">Official Portal</span>
                    </div>
                    <h1 className="text-xl font-black tracking-tight text-gray-900 dark:text-white">
                        Result Checker <span className="text-[#0B1F3A] dark:text-blue-400">Access</span>
                    </h1>
                    <p className="text-gray-500 dark:text-gray-400 text-xs font-medium">Securely purchase and manage your examination credentials.</p>
                </div>
                <div className="flex items-center gap-3 px-3 py-1.5 bg-gray-50 dark:bg-white/5 rounded-xl border border-gray-100 dark:border-white/5 text-[9px] font-bold text-gray-500 uppercase tracking-wider w-fit">
                    <span className="flex items-center gap-1"><Lock className="w-2.5 h-2.5 text-emerald-500" />Secure</span>
                    <span className="w-px h-3 bg-gray-200 dark:bg-gray-700" />
                    <span className="flex items-center gap-1"><Zap className="w-2.5 h-2.5 text-[#F5B800]" />Instant</span>
                    <span className="w-px h-3 bg-gray-200 dark:bg-gray-700" />
                    <span className="flex items-center gap-1"><ShieldCheck className="w-2.5 h-2.5 text-blue-500" />Verified</span>
                </div>
            </div>

            {/* ── Stats Strip ── */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 text-sm">
                <span className="text-[11px] font-semibold text-gray-400">Balance</span>
                <span className="font-bold text-emerald-600 dark:text-emerald-400">{formatCurrency(walletBalance)}</span>
              </div>
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 text-sm">
                <span className="text-[11px] font-semibold text-gray-400">Orders</span>
                <span className="font-bold text-gray-900 dark:text-white">{orders.length}</span>
              </div>
            </div>

            {/* Offline Banner if disabled */}
            {!pageEnabled && (
                <div className="bg-red-50 dark:bg-red-900/20 border-2 border-red-200 dark:border-red-800 rounded-2xl p-4 flex items-center gap-4 animate-pulse">
                    <div className="bg-red-500 rounded-full p-2">
                        <AlertCircle className="w-6 h-6 text-white" />
                    </div>
                    <div>
                        <h3 className="text-red-900 dark:text-red-300 font-bold uppercase text-xs tracking-wider">Currently Unavailable</h3>
                        <p className="text-red-700 dark:text-red-400 text-[11px]">The Results Checker service is currently undergoing maintenance. Please try again later.</p>
                    </div>
                </div>
            )}

            {/* ── Purchase Form ── */}
            <div className="bg-white dark:bg-gray-950 rounded-xl border border-gray-100 dark:border-gray-900 shadow-sm p-5 sm:p-6 space-y-6">
              {/* Section heading */}
              <div className="flex items-center gap-3 pb-4 border-b border-gray-100 dark:border-gray-900">
                <div className="w-9 h-9 rounded-xl bg-[#0B1F3A] dark:bg-[#F5B800] flex items-center justify-center flex-shrink-0">
                  <GraduationCap className="w-5 h-5 text-white dark:text-[#0B1F3A]" />
                </div>
                <div>
                  <h2 className="text-sm font-bold text-gray-900 dark:text-white">Results Checker</h2>
                  <p className="text-[11px] text-gray-400 mt-0.5">Purchase official WAEC exam credentials</p>
                </div>
                {selectedType?.bulk_pricing && selectedType.bulk_pricing.length > 0 && (
                  <div className="ml-auto hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-50 dark:bg-amber-900/20 border border-amber-100 dark:border-amber-800/40 text-amber-700 dark:text-amber-400 text-[10px] font-semibold">
                    <Info className="w-3 h-3" /> Bulk Pricing
                  </div>
                )}
              </div>

              <div className={cn("space-y-6", !pageEnabled && "opacity-50 pointer-events-none")}>
                {/* Step 1 — Exam type */}
                <div>
                  <span className="block text-sm font-semibold text-gray-900 dark:text-white mb-3">Select Examination Type</span>
                  <div className="pl-7">
                    {types.length === 0 ? (
                      <div className="rounded-xl border-2 border-dashed border-gray-200 dark:border-gray-700 p-10 text-center">
                        <Clock className="w-8 h-8 mx-auto mb-3 text-gray-300" />
                        <p className="text-sm text-gray-500 font-medium">No voucher types available at this time.</p>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {types.map(t => {
                          const outOfStock = t.available_count === 0
                          // Plan 4, Task 9 (spec C4): distinct from out-of-stock — there IS
                          // inventory, this sub-agent's account just has no RC pricing
                          // configured for this specific type yet (per-type, not all-or-
                          // nothing: a "Sold out" badge here would be actively misleading,
                          // since restocking does nothing to fix it — only a pricing
                          // configuration change does). Absent (undefined) for every
                          // non-sub-agent role, so this never affects them.
                          const notConfigured = !outOfStock && t.configured === false
                          const unselectable = outOfStock || notConfigured
                          const isSelected = selectedTypeId === t.id
                          const hasBulk = Array.isArray(t.bulk_pricing) && t.bulk_pricing.length > 0
                          const waecUrl = t.name.includes('BECE') ? 'eresults.waecgh.org' : 'ghana.waecdirect.org'
                          return (
                            // Tap a selected type again to deselect it.
                            <button key={t.id} onClick={() => !unselectable && setSelectedTypeId(isSelected ? '' : t.id)}
                              disabled={unselectable}
                              className={cn(
                                'relative flex items-center gap-2.5 p-3 rounded-xl border-[1.5px] text-left transition-all duration-200 overflow-hidden',
                                'before:absolute before:left-0 before:top-0 before:bottom-0 before:w-[3px] before:content-[""] before:transition-colors',
                                unselectable ? 'opacity-40 cursor-not-allowed border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50 before:bg-gray-200' :
                                isSelected
                                  ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-500/[0.12] before:bg-emerald-500 ring-1 ring-emerald-500/30'
                                  : 'border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 hover:border-gray-300 dark:hover:border-gray-700 before:bg-transparent'
                              )}>
                              <div className="flex-1 min-w-0">
                                <p className={cn('text-[13px] sm:text-sm font-semibold leading-snug break-words', isSelected ? 'text-emerald-700 dark:text-emerald-400' : 'text-gray-900 dark:text-white')}>{t.name}</p>
                                <p className="text-[10px] sm:text-[11px] text-gray-400 mt-0.5 truncate">{waecUrl}{hasBulk ? ' · Bulk discounts' : ''}</p>
                              </div>
                              <p className="text-[13px] sm:text-sm font-bold text-gray-900 dark:text-white whitespace-nowrap flex-shrink-0">{formatCurrency(t.price)}</p>
                              <div className={cn(
                                'w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-all',
                                isSelected ? 'border-emerald-500 bg-emerald-500' : 'border-gray-300 dark:border-gray-600'
                              )}>
                                {isSelected && <Check className="w-2.5 h-2.5 text-white" />}
                              </div>
                              {outOfStock && (
                                <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-white/60 dark:bg-black/50">
                                  <span className="bg-gray-800 dark:bg-gray-900 text-white text-[8px] font-bold px-2 py-1 rounded-md uppercase tracking-wider shadow">Sold out</span>
                                </div>
                              )}
                              {notConfigured && (
                                <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-white/60 dark:bg-black/50">
                                  <span className="bg-amber-600 dark:bg-amber-700 text-white text-[8px] font-bold px-2 py-1 rounded-md uppercase tracking-wider shadow">Not available</span>
                                </div>
                              )}
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </div>

                {/* Steps 2 & 3 + summary — only when type selected */}
                {types.length > 0 && selectedTypeId && (
                  <div className="space-y-5">

                    {/* Bulk tiers */}
                    {selectedType?.bulk_pricing && selectedType.bulk_pricing.length > 0 && (
                      <div className="pl-7">
                        <div className="bg-amber-50 dark:bg-amber-900/10 border border-amber-100 dark:border-amber-800/40 rounded-xl p-3">
                          <p className="text-[11px] font-semibold text-amber-700 dark:text-amber-400 mb-2 flex items-center gap-1.5">
                            <Info className="w-3.5 h-3.5" /> Bulk Discounts Available
                          </p>
                          <div className="flex flex-wrap gap-2">
                            {selectedType.bulk_pricing.map((tier, idx) => (
                              <div key={idx} className={cn(
                                "px-3 py-1.5 rounded-lg border text-center text-[11px] font-semibold",
                                quantity >= tier.min_qty && quantity <= tier.max_qty
                                  ? "bg-amber-500 text-white border-amber-600"
                                  : "bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 border-amber-100 dark:border-amber-900/30"
                              )}>
                                {tier.min_qty}{tier.max_qty >= 99999 ? '+' : `–${tier.max_qty}`} · {formatCurrency(tier.unit_price)}/ea
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Step 2 — Quantity */}
                    <div>
                      <span className="block text-sm font-semibold text-gray-900 dark:text-white mb-3">Set Quantity</span>
                      <div className="pl-7 flex items-center gap-4">
                        <div className="text-[11px] text-gray-400 flex-1">Bulk discounts apply automatically · Max {maxQty}</div>
                        <div className="flex items-center">
                          <button onClick={() => setQuantity(q => Math.max(1, q - 1))} disabled={!pageEnabled || isUnselectable}
                            className="w-8 h-8 rounded-l-lg border-[1.5px] border-r-0 border-gray-200 dark:border-gray-700 flex items-center justify-center text-gray-500 hover:bg-[#0B1F3A] hover:text-white hover:border-[#0B1F3A] dark:hover:bg-[#F5B800] dark:hover:text-[#0B1F3A] dark:hover:border-[#F5B800] transition-all disabled:opacity-30 bg-white dark:bg-gray-900">
                            –
                          </button>
                          <input type="number" title="Quantity" placeholder="1" min={1} max={effectiveMaxQty} value={quantity}
                            disabled={!pageEnabled || isUnselectable}
                            onChange={e => setQuantity(Math.max(1, Math.min(effectiveMaxQty, parseInt(e.target.value) || 1)))}
                            className="w-12 h-8 text-center border-[1.5px] border-y-gray-200 dark:border-y-gray-700 border-x-0 text-sm font-bold text-gray-900 dark:text-white bg-white dark:bg-gray-900 focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none" />
                          <button onClick={() => setQuantity(q => Math.min(effectiveMaxQty, q + 1))} disabled={!pageEnabled || isUnselectable}
                            className="w-8 h-8 rounded-r-lg border-[1.5px] border-l-0 border-gray-200 dark:border-gray-700 flex items-center justify-center text-gray-500 hover:bg-[#0B1F3A] hover:text-white hover:border-[#0B1F3A] dark:hover:bg-[#F5B800] dark:hover:text-[#0B1F3A] dark:hover:border-[#F5B800] transition-all disabled:opacity-30 bg-white dark:bg-gray-900">
                            +
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Step 3 — Delivery */}
                    <div>
                      <span className="block text-sm font-semibold text-gray-900 dark:text-white mb-3">Delivery Details <span className="text-[11px] font-normal text-gray-400">(optional)</span></span>
                      <div className="pl-7 grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div className="relative">
                          <MessageSquare className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                          <input type="tel" placeholder="Phone (Optional)" value={recipientPhone} onChange={e => setRecipientPhone(e.target.value)}
                            className="w-full pl-10 pr-3 py-2.5 bg-gray-50 dark:bg-white/[0.03] border border-gray-200 dark:border-gray-800 rounded-xl text-sm font-medium focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all" />
                        </div>
                        <div className="relative">
                          <FileText className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                          <input type="email" placeholder="Email (Optional)" value={recipientEmail} onChange={e => setRecipientEmail(e.target.value)}
                            className="w-full pl-10 pr-3 py-2.5 bg-gray-50 dark:bg-white/[0.03] border border-gray-200 dark:border-gray-800 rounded-xl text-sm font-medium focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all" />
                        </div>
                      </div>
                    </div>

                    {/* Order summary + CTA */}
                    {selectedType && !isUnselectable && (
                      <div className="pl-7 space-y-3">
                        <div className="border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden">
                          <div className="flex justify-between items-center px-4 py-2.5 border-b border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50 text-sm">
                            <span className="text-gray-500 font-medium">Exam</span>
                            <span className="font-semibold text-gray-900 dark:text-white">{selectedType.name}</span>
                          </div>
                          <div className="flex justify-between items-center px-4 py-2.5 border-b border-gray-100 dark:border-gray-800 text-sm">
                            <span className="text-gray-500 font-medium">Quantity</span>
                            <span className="font-semibold text-gray-900 dark:text-white">{quantity} {quantity === 1 ? 'voucher' : 'vouchers'}</span>
                          </div>
                          <div className="flex justify-between items-center px-4 py-2.5 border-b border-gray-100 dark:border-gray-800 text-sm">
                            <span className="text-gray-500 font-medium">Unit price</span>
                            <span className="font-semibold text-gray-900 dark:text-white">{formatCurrency(unitPrice)}{currentBulkTier ? <span className="text-[11px] text-amber-600 ml-1">bulk</span> : ''}</span>
                          </div>
                          <div className="flex justify-between items-center px-4 py-3">
                            <div>
                              <span className="text-sm font-semibold text-gray-900 dark:text-white">Total</span>
                              {hasInsufficientBalance && <p className="text-[11px] text-red-500 mt-0.5">Wallet: {formatCurrency(walletBalance)} — insufficient</p>}
                            </div>
                            <span className="text-xl font-black text-[#0B1F3A] dark:text-[#F5B800]">{formatCurrency(totalPrice)}</span>
                          </div>
                        </div>

                        {hasInsufficientBalance ? (
                          <button onClick={() => router.push('/dashboard/fund-wallet')}
                            className="w-full py-3.5 rounded-xl bg-red-500 text-white font-bold text-sm flex items-center justify-center gap-2 transition-all hover:opacity-90 active:scale-[0.98]">
                            <Wallet className="w-4 h-4" /> Insufficient Balance — Top Up Wallet
                          </button>
                        ) : (
                          <button onClick={() => setShowConfirmModal(true)} disabled={purchasing || !selectedTypeId || isUnselectable || types.length === 0 || !pageEnabled}
                            className="w-full py-3.5 rounded-xl bg-[#0B1F3A] dark:bg-[#F5B800] text-white dark:text-[#0B1F3A] text-sm font-bold flex items-center justify-center gap-2 transition-all hover:opacity-90 active:scale-[0.98] disabled:opacity-50">
                            <Lock className="w-4 h-4" /> Secure Purchase
                          </button>
                        )}
                        <p className="text-center text-[11px] text-gray-400">Debited instantly from wallet · Delivered via SMS &amp; Email</p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Success State — positioned BELOW the purchase form */}
            {successVouchers.length > 0 && successOrder && (
                <div className="rounded-2xl bg-emerald-50 dark:bg-emerald-900/20 border-2 border-emerald-200 dark:border-emerald-800 p-5 space-y-3 shadow-lg overflow-hidden relative">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <div className="bg-emerald-500 rounded-full p-1.5">
                                <CheckCircle2 className="w-4 h-4 text-white" />
                            </div>
                            <div>
                                <p className="font-bold text-emerald-800 dark:text-emerald-300 text-sm uppercase tracking-tight">Vouchers Ready!</p>
                                <p className="text-[10px] text-emerald-600 font-mono">{successOrder.reference_code}</p>
                            </div>
                        </div>
                        <div className="flex items-center gap-3">
                            <button onClick={handleDownloadSuccess}
                                className="text-xs font-bold px-3 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 flex items-center gap-1.5 transition-all active:scale-95">
                                <Download className="w-3.5 h-3.5" /> Download
                            </button>
                            <button onClick={() => { setSuccessVouchers([]); setSuccessOrder(null) }}
                                className="text-xs font-bold text-gray-400 hover:text-gray-700 dark:hover:text-white transition-colors">✕</button>
                        </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                        {successVouchers.map((v, i) => (
                            <div key={i} className="bg-white dark:bg-gray-800 rounded-xl p-3 border border-emerald-100 dark:border-emerald-900 shadow-sm">
                                <div className="flex justify-between items-center mb-2">
                                    <span className="text-[9px] font-bold text-gray-400 uppercase tracking-wide">Voucher {i + 1}</span>
                                    <div className="flex gap-0.5">
                                        <div className="w-1 h-2 bg-red-500 rounded-full" />
                                        <div className="w-1 h-2 bg-yellow-500 rounded-full" />
                                        <div className="w-1 h-2 bg-green-500 rounded-full" />
                                    </div>
                                </div>
                                <div className="space-y-1.5">
                                    <div className="p-1.5 bg-gray-50 dark:bg-gray-900/50 rounded-lg border border-gray-100 dark:border-gray-800">
                                        <p className="text-[9px] text-gray-400 font-bold mb-0.5 uppercase">PIN</p>
                                        <div className="flex items-center justify-between">
                                            <span className="font-mono font-bold text-gray-900 dark:text-white text-sm tracking-wider">{v.pin}</span>
                                            <CopyButton text={v.pin} />
                                        </div>
                                    </div>
                                    <div className="p-1.5 bg-gray-50 dark:bg-gray-900/50 rounded-lg border border-gray-100 dark:border-gray-800">
                                        <p className="text-[9px] text-gray-400 font-bold mb-0.5 uppercase">SERIAL</p>
                                        <div className="flex items-center justify-between">
                                            <span className="font-mono font-bold text-gray-900 dark:text-white text-xs">{v.serial_number}</span>
                                            <CopyButton text={v.serial_number} />
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* ── Order History ── */}
            <div className="bg-white dark:bg-gray-950 rounded-xl border border-gray-100 dark:border-gray-900 shadow-sm overflow-hidden">
                {/* History Header */}
                <div className="px-4 sm:px-6 py-4 border-b border-gray-100 dark:border-gray-900 flex items-center justify-between bg-gray-50/50 dark:bg-gray-900/50">
                    <div className="flex items-center gap-3">
                        <div className="bg-gray-200 dark:bg-white/5 p-2 sm:p-2.5 rounded-xl flex-shrink-0">
                            <Clock className="w-5 h-5 text-gray-500" />
                        </div>
                        <div>
                            <h2 className="text-sm font-bold text-gray-900 dark:text-white">Transaction History</h2>
                            <p className="text-[10px] font-medium text-gray-500 mt-0.5">Track your credentials</p>
                        </div>
                    </div>
                    <button onClick={fetchData} title="Refresh Orders" aria-label="Refresh Orders" className="p-2.5 rounded-xl hover:bg-gray-200 dark:hover:bg-white/5 transition-all group">
                        <RefreshCw className="w-4 h-4 text-gray-400 group-hover:rotate-180 transition-transform duration-500" />
                    </button>
                </div>

                {/* Filters */}
                <div className="px-4 sm:px-6 py-4 border-b border-gray-100 dark:border-gray-900 space-y-3">
                    <div className="relative">
                        <MessageSquare className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-300 pointer-events-none" />
                        <input
                            type="text"
                            placeholder="Search by reference or exam type..."
                            value={searchQuery}
                            onChange={e => setSearchQuery(e.target.value)}
                            className="w-full pl-10 pr-4 py-3 bg-gray-50 dark:bg-white/[0.03] border border-gray-100 dark:border-white/5 rounded-xl text-sm font-medium focus:outline-none focus:ring-2 focus:ring-emerald-500/20 transition-all"
                        />
                    </div>
                    {/* Scrollable filter chips */}
                    <div className="overflow-x-auto -mx-4 sm:-mx-6 px-4 sm:px-6 pb-0.5">
                        <div className="flex gap-2 min-w-max">
                            {(['all','today','yesterday','this_week','this_month','custom'] as const).map(preset => (
                                <button key={preset}
                                    onClick={() => setDatePreset(preset)}
                                    className={cn(
                                        'px-3.5 py-1.5 rounded-xl text-[10px] font-semibold transition-all whitespace-nowrap',
                                        datePreset === preset
                                            ? 'bg-[#0B1F3A] dark:bg-white text-white dark:text-gray-900 shadow-md'
                                            : 'bg-gray-100 dark:bg-white/[0.05] text-gray-500 hover:bg-gray-200 dark:hover:bg-white/[0.08]'
                                    )}>
                                    {preset.replace('_', ' ')}
                                </button>
                            ))}
                        </div>
                    </div>
                    {datePreset === 'custom' && (
                        <div className="flex gap-2">
                            <input type="date" aria-label="From date" title="From date" value={customDateFrom} onChange={e => setCustomDateFrom(e.target.value)}
                                className="flex-1 bg-gray-50 dark:bg-white/[0.03] border border-gray-100 dark:border-white/5 rounded-xl px-3 py-2 text-sm font-medium focus:outline-none focus:border-emerald-500 min-w-0" />
                            <input type="date" aria-label="To date" title="To date" value={customDateTo} onChange={e => setCustomDateTo(e.target.value)}
                                className="flex-1 bg-gray-50 dark:bg-white/[0.03] border border-gray-100 dark:border-white/5 rounded-xl px-3 py-2 text-sm font-medium focus:outline-none focus:border-emerald-500 min-w-0" />
                        </div>
                    )}
                </div>

                {/* Order List */}
                {filteredOrders.length === 0 ? (
                    <div className="py-16 text-center space-y-3">
                        <div className="bg-gray-100 dark:bg-gray-800 w-14 h-14 rounded-full flex items-center justify-center mx-auto">
                            <Clock className="w-7 h-7 text-gray-300 dark:text-gray-600" />
                        </div>
                        <p className="text-sm text-gray-500 dark:text-gray-400 font-semibold">No orders found</p>
                    </div>
                ) : (
                    <div className="divide-y divide-gray-100 dark:divide-gray-800">
                        {filteredOrders.map(order => {
                            const isExpanded = expandedOrders.has(order.id)
                            const vouchers = orderVouchers[order.id] || []
                            return (
                                <div key={order.id} className={cn("transition-all", isExpanded && "bg-gray-50 dark:bg-gray-800/20")}>
                                    <button onClick={() => toggleOrderExpand(order.id, order.inventory_ids)}
                                        className="w-full px-4 py-4 text-left hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors flex items-center justify-between gap-3">
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2 mb-1">
                                                <p className="font-bold text-gray-900 dark:text-white text-base tracking-tight truncate">{order.type_name}</p>
                                                <StatusBadge status={order.status} />
                                            </div>
                                            <div className="flex items-center gap-3 text-xs font-medium text-gray-400">
                                                <span className="font-mono text-[#0B1F3A] dark:text-[#F5B800]">{order.reference_code}</span>
                                                <span className="w-1 h-1 bg-gray-300 rounded-full" />
                                                <span>{new Date(order.created_at).toLocaleDateString()}</span>
                                            </div>
                                        </div>
                                        <div className="text-right">
                                            <p className="text-sm font-bold text-gray-900 dark:text-white mb-1">{formatCurrency(order.total_paid)}</p>
                                            <p className="text-[10px] font-medium text-gray-400">{order.quantity} Units</p>
                                        </div>
                                        {isExpanded ? <ChevronUp className="w-5 h-5 text-gray-300" /> : <ChevronDown className="w-5 h-5 text-gray-300" />}
                                    </button>

                                    {isExpanded && order.status === 'completed' && (
                                        <div className="px-4 pb-4 space-y-3">
                                            {orderVoucherLoading[order.id] ? (
                                                <div className="flex items-center justify-center py-8">
                                                    <Loader2 className="w-6 h-6 animate-spin text-emerald-500" />
                                                </div>
                                            ) : orderVoucherErrors[order.id] ? (
                                                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-4 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-200">
                                                    {orderVoucherErrors[order.id]}
                                                </div>
                                            ) : !orderVouchers[order.id]?.length ? (
                                                <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-4 text-sm text-gray-600 dark:border-gray-800 dark:bg-gray-900/40 dark:text-gray-300">
                                                    Voucher details are not available yet for this order.
                                                </div>
                                            ) : (
                                                <>
                                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                                        {vouchers.map((v, i) => {
                                                            const isRevealed = revealedPins.has(v.pin)
                                                            return (
                                                                <div key={i} className="bg-gray-50 dark:bg-white/[0.02] rounded-xl p-4 border border-gray-100 dark:border-white/5 space-y-3">
                                                                    <div className="flex justify-between items-center pb-2 border-b border-gray-200 dark:border-white/5">
                                                                        <span className="text-[9px] font-bold text-gray-400 uppercase">Credential {i + 1}</span>
                                                                        <button
                                                                            onClick={(e) => {
                                                                                e.stopPropagation()
                                                                                navigator.clipboard.writeText(`Serial: ${v.serial_number}\nPIN: ${v.pin}`)
                                                                                toast.success('Copied to clipboard')
                                                                            }}
                                                                            className="text-[9px] font-bold text-blue-500 uppercase flex items-center gap-1"
                                                                        >
                                                                            <Copy className="w-3 h-3" /> Copy Both
                                                                        </button>
                                                                    </div>
                                                                    <div className="space-y-2">
                                                                        <div className="flex justify-between items-center">
                                                                            <p className="text-[10px] text-gray-500 font-bold uppercase">Serial</p>
                                                                            <span className="font-mono text-xs font-medium text-gray-900 dark:text-white">{v.serial_number}</span>
                                                                        </div>
                                                                        <div className="flex justify-between items-center">
                                                                            <p className="text-[10px] text-gray-500 font-bold uppercase">PIN</p>
                                                                            <div
                                                                                onClick={(e) => { e.stopPropagation(); togglePinReveal(v.pin) }}
                                                                                className="flex items-center gap-2 cursor-pointer group/pin bg-white dark:bg-black/20 px-2 py-1 rounded border border-gray-100 dark:border-white/5"
                                                                            >
                                                                                <span className={cn("font-mono text-xs font-bold transition-all", isRevealed ? "text-[#0B1F3A] dark:text-[#F5B800]" : "text-gray-300 blur-[3px]")}>
                                                                                    {isRevealed ? v.pin : "PIN HIDDEN"}
                                                                                </span>
                                                                                {isRevealed ? <EyeOff className="w-3 h-3 text-gray-400 group-hover/pin:text-gray-600" /> : <Eye className="w-3 h-3 text-gray-400 group-hover/pin:text-gray-600" />}
                                                                            </div>
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            )
                                                        })}
                                                    </div>
                                                    <div className="grid grid-cols-2 gap-3">
                                                        <button onClick={() => handleDownloadHistory(order, vouchers)}
                                                            disabled={!vouchers.length}
                                                            className="py-3 rounded-xl border-2 border-emerald-100 dark:border-emerald-900 text-emerald-700 dark:text-emerald-400 font-semibold text-[10px] hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-all flex items-center justify-center gap-2">
                                                            <Download className="w-4 h-4" /> Download
                                                        </button>
                                                        {(() => {
                                                            const complaint = order.results_checker_complaints?.[0]
                                                            if (complaint) {
                                                                return (
                                                                    <div className="py-3 px-4 rounded-xl border-2 border-gray-100 dark:border-gray-800 text-gray-500 font-semibold text-[10px] flex items-center justify-center gap-2 cursor-not-allowed bg-gray-50 dark:bg-gray-800/50">
                                                                        <AlertCircle className="w-4 h-4" /> {complaint.status === 'resolved' ? 'Resolved' : 'Reviewing...'}
                                                                    </div>
                                                                )
                                                            }
                                                            return (
                                                                <button onClick={() => setComplaintOrder(order)}
                                                                    className="py-3 px-4 rounded-xl border-2 border-red-100 dark:border-red-900 text-red-700 dark:text-red-400 font-semibold text-[10px] hover:bg-red-50 dark:hover:bg-red-900/20 transition-all flex items-center justify-center gap-2">
                                                                    <MessageSquare className="w-4 h-4" /> Complain
                                                                </button>
                                                            )
                                                        })()}
                                                    </div>
                                                    {/* Resend the voucher SMS to the recipient (endpoint enforces ownership). */}
                                                    <button
                                                        onClick={() => handleResendSMS(order.id)}
                                                        disabled={resending === order.id || !vouchers.length}
                                                        className="mt-3 w-full py-3 rounded-xl border-2 border-blue-100 dark:border-blue-900 text-blue-700 dark:text-blue-400 font-semibold text-[10px] hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed">
                                                        {resending === order.id
                                                            ? <><Loader2 className="w-4 h-4 animate-spin" /> Resending…</>
                                                            : <><RefreshCw className="w-4 h-4" /> Resend SMS</>}
                                                    </button>
                                                </>
                                            )}
                                        </div>
                                    )}
                                    {isExpanded && order.status === 'pending' && (
                                        <div className="px-4 pb-4">
                                            <div className="bg-amber-50 dark:bg-amber-900/10 border border-amber-100 dark:border-amber-800 rounded-xl p-4 flex items-start gap-3">
                                                <Clock className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
                                                <p className="text-xs text-amber-700 dark:text-amber-400 font-medium leading-relaxed">
                                                    Order queued. We are currently restocking vouchers for this exam type. Your order will be fulfilled automatically as soon as inventory is available.
                                                </p>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )
                        })}
                    </div>
                )}
            </div>

            {/* Confirm Purchase Modal */}
            <Dialog open={showConfirmModal} onOpenChange={setShowConfirmModal}>
                <DialogContent className="rounded-[2rem] max-w-sm p-0 overflow-hidden border-none shadow-2xl">
                    <DialogHeader className="sr-only">
                        <DialogTitle>Confirm Results Checker purchase</DialogTitle>
                        <DialogDescription>
                            Review the selected examination type, quantity, and total price before paying from your wallet.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="bg-[#0B1F3A] p-8 text-white space-y-2">
                        <h3 className="text-xl font-bold tracking-tight">Confirm Purchase</h3>
                        <p className="text-xs text-gray-400 font-medium leading-relaxed">
                            Please review your order details before proceeding. Credentials are delivered instantly upon confirmation.
                        </p>
                    </div>
                    <div className="p-8 space-y-6 bg-white dark:bg-gray-950">
                        <div className="space-y-4">
                            <div className="flex justify-between items-center text-xs pb-3 border-b border-gray-100 dark:border-white/5">
                                <span className="text-gray-500 font-medium">Credential Type</span>
                                <span className="font-bold text-gray-900 dark:text-white">{selectedType?.name}</span>
                            </div>
                            <div className="flex justify-between items-center text-xs pb-3 border-b border-gray-100 dark:border-white/5">
                                <span className="text-gray-500 font-medium">Quantity</span>
                                <span className="font-bold text-gray-900 dark:text-white">{quantity} Units</span>
                            </div>
                            <div className="flex justify-between items-center text-sm pt-2">
                                <span className="text-gray-900 dark:text-white font-bold">Total Payable</span>
                                <span className="font-black text-[#0B1F3A] dark:text-[#F5B800]">{formatCurrency(totalPrice)}</span>
                            </div>
                        </div>

                        <div className="flex gap-3">
                            <Button variant="ghost" className="flex-1 rounded-xl text-xs font-bold uppercase tracking-widest" onClick={() => setShowConfirmModal(false)}>
                                Cancel
                            </Button>
                            <Button
                                className="flex-1 rounded-xl text-xs font-bold uppercase tracking-widest bg-[#0B1F3A] dark:bg-[#F5B800] text-white dark:text-[#0B1F3A] hover:opacity-90"
                                onClick={handlePurchase}
                                disabled={purchasing}
                            >
                                {purchasing ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Confirm Pay'}
                            </Button>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>

            {/* Complaint Modal */}
            <Dialog open={!!complaintOrder} onOpenChange={() => setComplaintOrder(null)}>
                <DialogContent className="rounded-[2rem] max-w-md p-0 overflow-hidden border-none shadow-2xl">
                    <DialogHeader className="sr-only">
                        <DialogTitle>File a results checker complaint</DialogTitle>
                        <DialogDescription>
                            Describe the issue with this voucher order so the support team can review it.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="bg-[#EF4444] p-8 text-white space-y-2">
                        <h3 className="text-xl font-bold tracking-tight uppercase">File a Complaint</h3>
                        <p className="text-xs text-red-100 font-medium leading-relaxed">
                            Order Ref: <span className="font-mono font-bold">{complaintOrder?.reference_code}</span>. Our team reviews all reports within 24 hours.
                        </p>
                    </div>
                    <div className="p-8 space-y-6 bg-white dark:bg-gray-950">
                        <div className="space-y-2">
                            <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">Issue Description</label>
                            <Textarea
                                placeholder="Example: PIN is showing as already used, or I didn't receive the SMS..."
                                value={complaintDesc}
                                onChange={(e) => setComplaintDesc(e.target.value)}
                                rows={4}
                                className="rounded-2xl border-gray-100 dark:border-white/5 focus:ring-2 focus:ring-[#EF4444]/20 focus:border-[#EF4444] transition-all text-sm font-medium"
                            />
                        </div>
                        <div className="flex gap-3">
                            <Button variant="ghost" className="flex-1 rounded-xl text-xs font-bold uppercase tracking-widest" onClick={() => setComplaintOrder(null)}>
                                Back
                            </Button>
                            <Button
                                className="flex-1 rounded-xl text-xs font-bold uppercase tracking-widest bg-[#EF4444] text-white hover:opacity-90"
                                onClick={submitComplaint}
                                disabled={submittingComplaint || !complaintDesc.trim()}
                            >
                                {submittingComplaint ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Submit Report'}
                            </Button>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    )
}
