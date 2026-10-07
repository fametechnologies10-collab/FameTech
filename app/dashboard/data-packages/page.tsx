'use client'

import { useEffect, useState, useRef, useMemo } from 'react'
import * as XLSX from 'xlsx'
import { useAuth } from '@/contexts/auth-context'
import { supabase } from '@/lib/supabase'
import Link from 'next/link'
import { formatCurrency, cn } from '@/lib/utils'
import { generateReferenceCode } from '@/lib/utils'
import { validateGhanaianPhone, detectNetwork } from '@/lib/phone-validation'
import { NetworkIcon } from '@/components/network-icon'
import { MtnWhitelistChecker } from '@/components/mtn-whitelist-checker'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import {
    Search,
    LayoutGrid,
    List,
    Wifi,
    Loader2,
    CheckCircle2,
    Check,
    AlertCircle,
    ShoppingCart,
    Plus,
    X,
    FileSpreadsheet,
    FileText,
    Upload,
    ExternalLink,
    Eye,
    Download,
    ShieldCheck,
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import { toast } from '@/lib/toast'
import { DataPackage } from '@/types/supabase'
import { filterPackagesForSubAgent, SubAgentPricingMap } from '@/lib/sub-agent-package-filter'

interface ValidationResult {
    lineNumber: number
    phoneNumber: string
    volume: number
    packagePrice: number
    isValid: boolean
    errorMessage?: string
    packageId?: string
    packageName?: string
    /** Set only for MTN rows when the whitelist gate is on and the number is blocked. */
    whitelistStatus?: 'blocked'
}

const NETWORKS = ['MTN', 'Telecel', 'AT-iShare', 'AT-BigTime'] as const

const NETWORK_STYLE: Record<string, {
    selectedBorder: string
    cardBg: string
    isMTN: boolean
}> = {
    MTN: { selectedBorder: 'border-amber-400', cardBg: 'bg-amber-400', isMTN: true },
    Telecel: { selectedBorder: 'border-red-600', cardBg: 'bg-red-600', isMTN: false },
    'AT-iShare': { selectedBorder: 'border-blue-600', cardBg: 'bg-blue-600', isMTN: false },
    'AT-BigTime': { selectedBorder: 'border-violet-600', cardBg: 'bg-violet-600', isMTN: false },
}

function NetworkSelectorCard({
    network,
    selected,
    onClick,
}: {
    network: string
    selected: boolean
    onClick: () => void
}) {
    const style = NETWORK_STYLE[network] ?? NETWORK_STYLE.MTN
    const label =
        network === 'AT-iShare' ? 'AT iShare' :
        network === 'AT-BigTime' ? 'AT BigTime' :
        network

    return (
        <button
            onClick={onClick}
            className={cn(
                'relative flex flex-col items-center gap-1.5 p-2.5 sm:p-3 rounded-2xl border-2 bg-white dark:bg-zinc-900 transition-all duration-200 w-full',
                selected
                    ? `${style.selectedBorder} shadow-sm`
                    : 'border-gray-100 dark:border-zinc-800 hover:border-gray-200 dark:hover:border-zinc-700'
            )}
        >
            {selected && (
                <span className="absolute top-1.5 right-1.5 w-4 h-4 rounded-full bg-green-500 flex items-center justify-center shadow-sm">
                    <Check className="w-2.5 h-2.5 text-white" />
                </span>
            )}
            <NetworkIcon network={network} size={34} />
            <span className="text-[10px] sm:text-[11px] font-semibold text-gray-800 dark:text-gray-200 leading-tight text-center">
                {label}
            </span>
            <div className="flex items-center gap-1">
                <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
                <span className="text-[9px] sm:text-[10px] text-green-600 font-medium">Live</span>
            </div>
        </button>
    )
}

function useCountUp(target: number, duration = 900) {
    const [value, setValue] = useState(0)
    useEffect(() => {
        if (target === 0) { setValue(0); return }
        let rafId: number
        let startTime: number | null = null
        const step = (ts: number) => {
            if (!startTime) startTime = ts
            const progress = Math.min((ts - startTime) / duration, 1)
            const eased = 1 - Math.pow(1 - progress, 3)
            setValue(target * eased)
            if (progress < 1) rafId = requestAnimationFrame(step)
            else setValue(target)
        }
        rafId = requestAnimationFrame(step)
        return () => cancelAnimationFrame(rafId)
    }, [target, duration])
    return value
}

const PKG_CACHE_KEY = 'kf-packages-cache'
const PKG_CACHE_TTL = 5 * 60 * 1000

export default function DataPackagesPage() {
    const { dbUser, session, refreshUser } = useAuth()
    const router = useRouter()

    const [packages, setPackages] = useState<DataPackage[]>([])
    const [selectedNetwork, setSelectedNetwork] = useState<string>('MTN')
    const [searchQuery, setSearchQuery] = useState('')
    const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')
    const [isLoading, setIsLoading] = useState(true)
    const [walletBalance, setWalletBalance] = useState(0)
    const [ordersToday, setOrdersToday] = useState(0)
    const animatedBalance = useCountUp(walletBalance)
    const animatedOrders = useCountUp(ordersToday, 600)
    const [activeTab, setActiveTab] = useState<'single' | 'bulk' | 'mtn_mashup'>('single')
    const [whitelistOpen, setWhitelistOpen] = useState(false)
    const [adminOOS, setAdminOOS] = useState<Record<string, boolean>>({})

    // Order-success SMS preference — shared by single & bulk, defaults enabled.
    const [orderSmsEnabled, setOrderSmsEnabled] = useState(true)
    const [savingOrderSms, setSavingOrderSms] = useState(false)
    useEffect(() => {
        if (dbUser) setOrderSmsEnabled((dbUser as any).order_success_sms_enabled !== false)
    }, [dbUser])
    const handleToggleOrderSms = async (next: boolean) => {
        const prev = orderSmsEnabled
        setOrderSmsEnabled(next)
        setSavingOrderSms(true)
        try {
            const res = await fetch('/api/user/notification-prefs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: next }),
            })
            const data = await res.json()
            if (res.ok && data.success) {
                toast.success(next ? 'Order SMS turned on' : 'Order SMS turned off')
                refreshUser()
            } else {
                setOrderSmsEnabled(prev)
                toast.error(data.error || 'Could not update setting')
            }
        } catch {
            setOrderSmsEnabled(prev)
            toast.error('Could not update setting')
        } finally {
            setSavingOrderSms(false)
        }
    }

    // Single purchase dialog
    const [selectedPackage, setSelectedPackage] = useState<DataPackage | null>(null)
    const [phoneNumber, setPhoneNumber] = useState('')
    const [phoneError, setPhoneError] = useState('')
    const [isPurchasing, setIsPurchasing] = useState(false)
    const [purchaseSuccess, setPurchaseSuccess] = useState(false)
    const [purchaseDetails, setPurchaseDetails] = useState<{
        referenceCode: string
        network: string
        size: string
        phoneNumber: string
        price: number
        newBalance: number
    } | null>(null)
    const [currentReferenceCode, setCurrentReferenceCode] = useState('')

    // Bulk state
    const [bulkSuccess, setBulkSuccess] = useState(false)
    const [bulkSuccessDetails, setBulkSuccessDetails] = useState<{
        ordersPlaced: number
        totalCost: number
        newBalance: number
        orders: { phoneNumber: string; volume: number; packagePrice: number }[]
        /** Numbers the server actually skipped (never charged) — see handleSubmitBulkOrder. */
        skipped: { phone: string; reason: string }[]
    } | null>(null)
    const [bulkInputType, setBulkInputType] = useState<'text' | 'excel'>('text')
    const [bulkText, setBulkText] = useState('')
    const [validationResults, setValidationResults] = useState<ValidationResult[]>([])
    const [isValidating, setIsValidating] = useState(false)
    const [isSubmittingBulk, setIsSubmittingBulk] = useState(false)
    const [bulkFile, setBulkFile] = useState<File | null>(null)
    const [previewDone, setPreviewDone] = useState(false)
    // Idempotency key for the bulk batch — generated once when a preview
    // succeeds and reused across retries so a double-click/retry can't place
    // (and charge for) the same batch twice. Cleared on edit and after success.
    const [bulkBatchRef, setBulkBatchRef] = useState('')
    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const phoneInputRef = useRef<HTMLInputElement>(null)

    const isBulkUser =
        dbUser?.role === 'agent' ||
        dbUser?.role === 'dealer' ||
        dbUser?.role === 'admin' ||
        dbUser?.role === 'sub-admin'

    // Sub-agent-only pricing/visibility gate (Plan 4 Task 7, spec C4). A sub-agent
    // must only ever see data packages their recruiter has priced for them —
    // never shown-then-failing-at-checkout. Completely inert for every other
    // role: isSubAgentViewer is false, the fetch below never runs, and
    // subAgentPricing stays {} (harmless no-op in filterPackagesForSubAgent,
    // which is never even called for non-sub-agents). Mashup is deliberately
    // untouched — see the mashupPackages memo below, which never passes through
    // this filter and never consults subAgentPricing.
    const isSubAgentViewer = dbUser?.role === 'subagent'
    const [subAgentPricing, setSubAgentPricing] = useState<SubAgentPricingMap>({})
    const [subAgentPricingLoaded, setSubAgentPricingLoaded] = useState(false)

    useEffect(() => {
        if (!isSubAgentViewer) return
        let cancelled = false
        setSubAgentPricingLoaded(false)
        fetch(`/api/dashboard/subagents/my-pricing?network=${encodeURIComponent(selectedNetwork)}`, { cache: 'no-store' })
            .then(r => r.json())
            .then(j => {
                if (cancelled) return
                setSubAgentPricing(j?.success && j.data ? j.data : {})
            })
            .catch(() => { if (!cancelled) setSubAgentPricing({}) }) // fail closed — nothing purchasable on error
            .finally(() => { if (!cancelled) setSubAgentPricingLoaded(true) })
        return () => { cancelled = true }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isSubAgentViewer, selectedNetwork])

    const filteredPackages = useMemo(() => {
        let filtered = packages.filter(p => p.network === selectedNetwork && (p as any).category !== 'mtn_mashup')
        if (isSubAgentViewer) {
            filtered = filterPackagesForSubAgent(filtered, subAgentPricing)
        }
        if (searchQuery) {
            const q = searchQuery.toLowerCase()
            filtered = filtered.filter(p =>
                p.size.toLowerCase().includes(q) ||
                p.network.toLowerCase().includes(q) ||
                p.description?.toLowerCase().includes(q)
            )
        }
        return filtered
    }, [packages, selectedNetwork, searchQuery, isSubAgentViewer, subAgentPricing])

    const isSelectedNetworkOOS = !!adminOOS[selectedNetwork]

    const mashupPackages = useMemo(
        () => packages
            .filter(p => (p as any).category === 'mtn_mashup')
            .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)),
        [packages]
    )

    const validOrders = useMemo(
        () => validationResults.filter(r => r.isValid && r.whitelistStatus !== 'blocked'),
        [validationResults],
    )
    const totalBulkCost = useMemo(() => validOrders.reduce((s, r) => s + r.packagePrice, 0), [validOrders])

    // Persist preferences
    useEffect(() => {
        const net = localStorage.getItem('kf-selected-network')
        const vm = localStorage.getItem('kf-view-mode') as 'grid' | 'list' | null
        if (net && (NETWORKS as readonly string[]).includes(net)) setSelectedNetwork(net)
        if (vm === 'grid' || vm === 'list') setViewMode(vm)
    }, [])

    // Load admin per-network out-of-stock map on mount.
    useEffect(() => {
        fetch('/api/admin-settings?keys=data_network_stock', { cache: 'no-store' })
            .then(r => r.json())
            .then(j => setAdminOOS((j?.data_network_stock as Record<string, boolean>) || {}))
            .catch(() => {})
    }, [])

    useEffect(() => {
        if (!dbUser) return
        fetchPackages()
        fetchWalletBalance()
        fetchOrdersToday()
    }, [dbUser])


    const fetchPackages = async () => {
        // SWR: hydrate from cache immediately so grid shows on repeat visits
        try {
            const raw = localStorage.getItem(PKG_CACHE_KEY)
            if (raw) {
                const { data: cached, ts } = JSON.parse(raw)
                if (Date.now() - ts < PKG_CACHE_TTL && Array.isArray(cached)) {
                    setPackages(cached)
                    setIsLoading(false)
                }
            }
        } catch { /* ignore bad cache */ }

        try {
            const { data, error } = await supabase
                .from('data_packages')
                .select('*')
                .eq('is_available', true)
                .order('sort_order', { ascending: true })
            if (error) throw error
            setPackages(data || [])
            localStorage.setItem(PKG_CACHE_KEY, JSON.stringify({ data, ts: Date.now() }))
        } catch {
            toast.error('Failed to load packages')
        } finally {
            setIsLoading(false)
        }
    }

    const fetchWalletBalance = async () => {
        if (!dbUser) return
        const { data } = await supabase
            .from('wallets')
            .select('balance')
            .eq('user_id', dbUser.id)
            .single()
        setWalletBalance((data as any)?.balance || 0)
    }

    const fetchOrdersToday = async () => {
        if (!dbUser) return
        const today = new Date()
        today.setHours(0, 0, 0, 0)
        const { count } = await supabase
            .from('orders')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', dbUser.id)
            .gte('created_at', today.toISOString())
            .neq('status', 'failed')
        setOrdersToday(count || 0)
    }

    const getEffectivePrice = (pkg: DataPackage) => {
        // Sub-agent price takes priority over role tiers, for non-mashup packages the
        // sub has pricing configured for (subAgentPricing is scoped to those by the API —
        // see /api/dashboard/subagents/my-pricing). Anything absent from that map (mashup,
        // or the rare stale-reference case) falls through to the same role-tier logic every
        // other role uses — for a 'subagent' role that means the plain `pkg.price` fallback
        // below, unchanged from before this gate existed.
        if (isSubAgentViewer) {
            const sub = subAgentPricing[pkg.id]
            if (sub) return sub.subPrice
        }
        if (dbUser?.role === 'dealer' && (pkg as any).dealer_price > 0) return (pkg as any).dealer_price
        if (dbUser?.role === 'agent' && (pkg as any).agent_price > 0) return (pkg as any).agent_price
        return pkg.price
    }

    const handleNetworkChange = (network: string) => {
        setSelectedNetwork(network)
        localStorage.setItem('kf-selected-network', network)
        setPreviewDone(false)
        setValidationResults([])
    }

    const handleViewModeChange = (mode: 'grid' | 'list') => {
        setViewMode(mode)
        localStorage.setItem('kf-view-mode', mode)
    }

    const handlePurchaseClick = (pkg: DataPackage) => {
        setSelectedPackage(pkg)
        setPhoneNumber('')
        setPhoneError('')
        setPurchaseSuccess(false)
        setPurchaseDetails(null)
        setCurrentReferenceCode(generateReferenceCode())
        // Focus inside the user-gesture handler so iOS opens the keyboard.
        // Double RAF: first waits for React to flush, second for DOM commit.
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                phoneInputRef.current?.focus()
            })
        })
    }

    const handlePhoneChange = (value: string) => {
        setPhoneNumber(value)
        setPhoneError('')
        if (value.length >= 10) {
            const validation = validateGhanaianPhone(value)
            if (!validation.isValid) {
                setPhoneError(validation.error || 'Invalid phone number')
            } else if (selectedPackage) {
                const detectedNet = detectNetwork(value)
                const packageNetwork = selectedPackage.network.includes('AT') ? 'AirtelTigo' : selectedPackage.network
                if (detectedNet !== packageNetwork && selectedPackage.network !== 'AT-BigTime') {
                    setPhoneError(`This number is for ${detectedNet}, not ${selectedPackage.network}`)
                }
            }
        }
    }

    const handlePurchase = async () => {
        if (!selectedPackage || !dbUser) return
        const validation = validateGhanaianPhone(phoneNumber)
        if (!validation.isValid) {
            setPhoneError(validation.error || 'Invalid phone number')
            return
        }
        const effectivePrice = getEffectivePrice(selectedPackage)
        if (walletBalance < effectivePrice) {
            setPhoneError('Insufficient wallet balance')
            return
        }
        setIsPurchasing(true)
        try {
            const response = await fetch('/api/orders/purchase', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${session?.access_token}`,
                },
                body: JSON.stringify({
                    packageId: selectedPackage.id,
                    phoneNumber: validation.normalizedNumber,
                    referenceCode: currentReferenceCode,
                }),
            })
            const data = await response.json()
            if (!response.ok) throw new Error(data.error || 'Purchase failed')
            setPurchaseSuccess(true)
            setPurchaseDetails({
                referenceCode: data.order.reference_code,
                network: data.order.network,
                size: data.order.size,
                phoneNumber: data.order.phone_number,
                price: data.order.price,
                newBalance: data.order.new_balance,
            })
            setWalletBalance(
                typeof data.order?.new_balance === 'number'
                    ? data.order.new_balance
                    : walletBalance - effectivePrice
            )
            setOrdersToday(prev => prev + 1)
            // Revalidate server-rendered balance elsewhere (main dashboard / header) so it
            // doesn't show a stale figure after this wallet debit. The local setWalletBalance
            // above keeps THIS page instant; router.refresh() syncs the rest.
            router.refresh()
            toast.success('Order placed successfully!')
        } catch (error: any) {
            toast.error(error.message || 'Failed to place order')
        } finally {
            setIsPurchasing(false)
        }
    }

    // Bulk helpers
    const parseTextInput = (text: string) =>
        text.trim().split('\n')
            .map((line, index) => {
                const trimmed = line.trim()
                if (!trimmed) return null
                const parts = trimmed.split(/\s+/)
                if (parts.length < 2) return null
                const phone = parts[0]
                const volStr = parts[1].toLowerCase().replace('gb', '')
                const volume = parseFloat(volStr)
                if (isNaN(volume)) return null
                return { lineNumber: index + 1, phoneNumber: phone, volume, rawLine: trimmed }
            })
            .filter(Boolean) as any[]

    const validateLines = (parsedLines: any[]): ValidationResult[] =>
        parsedLines.map((line: any) => {
            const phoneValidation = validateGhanaianPhone(line.phoneNumber)
            if (!phoneValidation.isValid) {
                return { ...line, packagePrice: 0, isValid: false, errorMessage: 'Invalid phone' }
            }
            const detectedNet = detectNetwork(line.phoneNumber)
            const targetNet = selectedNetwork === 'AT-BigTime' || selectedNetwork === 'AT-iShare'
                ? 'AirtelTigo'
                : selectedNetwork
            if (detectedNet !== targetNet) {
                return { ...line, packagePrice: 0, isValid: false, errorMessage: `Wrong network (${detectedNet})` }
            }
            const pkg = packages.find(p => {
                if (p.network !== selectedNetwork) return false
                if ((p as any).category === 'mtn_mashup') return false // mashup packages are not available through bulk
                const pkgSize = p.size.toLowerCase()
                if (pkgSize.includes('gb')) {
                    return parseFloat(pkgSize.replace('gb', '').trim()) === line.volume
                } else if (pkgSize.includes('mb')) {
                    return parseFloat(pkgSize.replace('mb', '').trim()) / 1000 === line.volume
                }
                return false
            })
            if (!pkg) {
                return { ...line, packagePrice: 0, isValid: false, errorMessage: `No ${line.volume}GB package` }
            }
            return {
                ...line,
                packagePrice: getEffectivePrice(pkg),
                packageId: pkg.id,
                packageName: `${pkg.network} ${pkg.size}`,
                isValid: true,
            }
        })

    const parseExcelFile = (file: File): Promise<any[]> =>
        new Promise((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = (e) => {
                try {
                    const workbook = XLSX.read(e.target?.result, { type: 'binary' })
                    const worksheet = workbook.Sheets[workbook.SheetNames[0]]
                    const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as any[][]
                    const parsed = rows
                        .map((row, i) => {
                            const phone = row[0]?.toString().trim()
                            const volStr = row[1]?.toString().toLowerCase().replace('gb', '').trim()
                            const volume = parseFloat(volStr)
                            if (!phone || phone.toLowerCase().includes('phone') || isNaN(volume)) return null
                            return { lineNumber: i + 1, phoneNumber: phone, volume, rawLine: row.join(' ') }
                        })
                        .filter(Boolean)
                    resolve(parsed)
                } catch (err) {
                    reject(err)
                }
            }
            reader.onerror = reject
            reader.readAsBinaryString(file)
        })

    const downloadBulkTemplate = () => {
        const worksheet = XLSX.utils.aoa_to_sheet([
            ['Phone', 'Volume (GB)'],
            ['0241234567', 5],
            ['0551234567', 10],
        ])
        const workbook = XLSX.utils.book_new()
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Template')
        XLSX.writeFile(workbook, 'bulk-order-template.xlsx')
    }

    const handlePreviewPrice = async () => {
        setIsValidating(true)
        try {
            let parsedLines: any[] = []
            if (bulkInputType === 'text') {
                if (!bulkText.trim()) { toast.error('Enter phone numbers first'); return }
                parsedLines = parseTextInput(bulkText)
            } else {
                if (!bulkFile) { toast.error('Select a file first'); return }
                parsedLines = await parseExcelFile(bulkFile)
            }

            const results = validateLines(parsedLines)

            let finalResults = results
            if (selectedNetwork === 'MTN') {
                const mtnValid = results.filter(r => r.isValid)
                if (mtnValid.length > 0) {
                    try {
                        const settingsRes = await fetch('/api/admin-settings?keys=mtn_agentportal_whitelist_gate_enabled,mtn_bundleportal_whitelist_gate_enabled', { cache: 'no-store' })
                        const settings = await settingsRes.json()
                        const isOn = (v: unknown) => v === true || v === 'true'
                        const gateOn = isOn(settings?.mtn_agentportal_whitelist_gate_enabled) || isOn(settings?.mtn_bundleportal_whitelist_gate_enabled)

                        if (gateOn) {
                            const checkRes = await fetch('/api/mtn-whitelist/verify', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ msisdns: mtnValid.map(r => r.phoneNumber) }),
                            })
                            const checkPayload = await checkRes.json()
                            if (checkRes.ok && checkPayload?.success && checkPayload.data) {
                                const blockedSet = new Set(
                                    (checkPayload.data.results as { normalized: string; allowed: boolean }[])
                                        .filter(r => !r.allowed)
                                        .map(r => r.normalized)
                                )
                                finalResults = results.map(r => {
                                    if (!r.isValid) return r
                                    const normalized = validateGhanaianPhone(r.phoneNumber).normalizedNumber
                                    return blockedSet.has(normalized) ? { ...r, whitelistStatus: 'blocked' as const } : r
                                })
                            }
                            // On any check failure, fall through with unblocked results —
                            // the server-side gate (Task 8) is the authoritative enforcement
                            // point; this preview is a UI nicety only, never a hard gate.
                        }
                    } catch {
                        // Same fail-open reasoning as above.
                    }
                }
            }

            setValidationResults(finalResults)

            const valid = finalResults.filter(r => r.isValid && r.whitelistStatus !== 'blocked')
            const invalid = finalResults.filter(r => !r.isValid)
            const blockedCount = finalResults.filter(r => r.whitelistStatus === 'blocked').length
            const cost = valid.reduce((s, r) => s + r.packagePrice, 0)

            if (invalid.length > 0) {
                toast.error(
                    `${invalid.length} invalid ${invalid.length === 1 ? 'entry' : 'entries'} — check network or phone numbers`
                )
            }
            if (blockedCount > 0) {
                toast.error(`${blockedCount} ${blockedCount === 1 ? 'number is' : 'numbers are'} not yet whitelisted and will be skipped`)
            }

            if (valid.length === 0) {
                toast.error('No valid orders found')
                return
            }

            if (walletBalance < cost) {
                toast.error(
                    `Insufficient balance — need ${formatCurrency(cost)}, have ${formatCurrency(walletBalance)}`
                )
                return
            }

            toast.success(
                `${valid.length} orders · ${formatCurrency(cost)} total · Balance after: ${formatCurrency(walletBalance - cost)}`
            )
            setBulkBatchRef(generateReferenceCode())
            setPreviewDone(true)
        } catch {
            toast.error('Error reading data')
        } finally {
            setIsValidating(false)
        }
    }

    const handleSubmitBulkOrder = async () => {
        if (!previewDone || validOrders.length === 0) return
        if (walletBalance < totalBulkCost) {
            toast.error('Insufficient balance')
            return
        }
        setIsSubmittingBulk(true)
        try {
            const response = await fetch('/api/orders/bulk-purchase', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${session?.access_token}`,
                },
                body: JSON.stringify({
                    batchReference: bulkBatchRef,
                    orders: validOrders.map(o => ({
                        packageId: o.packageId,
                        phoneNumber: validateGhanaianPhone(o.phoneNumber).normalizedNumber,
                        packagePrice: o.packagePrice,
                    })),
                }),
            })
            const data = await response.json()
            if (!response.ok) throw new Error(data.error || 'Bulk order failed')

            // The server may skip numbers at submit time that our client-side preview
            // didn't catch (a race between preview and submit, the gate toggling mid-session,
            // or a number's whitelist status changing) — Task 8 guarantees skipped numbers
            // are never charged, but the success screen must reflect that, not silently claim
            // every submitted number went through. Match on the SAME normalized form that was
            // actually sent in the request body (data.skipped[].phone echoes that value back).
            const skippedPhones: { phone: string; reason: string }[] = data.skipped ?? []
            const skippedSet = new Set(skippedPhones.map(s => s.phone))
            const deliveredOrders = validOrders.filter(o => {
                const normalized = validateGhanaianPhone(o.phoneNumber).normalizedNumber
                return !skippedSet.has(normalized as string)
            })

            setBulkSuccessDetails({
                ordersPlaced: data.ordersPlaced,
                totalCost: data.totalCost,
                newBalance: data.newBalance,
                orders: deliveredOrders.map(o => ({
                    phoneNumber: o.phoneNumber,
                    volume: o.volume,
                    packagePrice: o.packagePrice,
                })),
                skipped: skippedPhones,
            })
            if (skippedPhones.length > 0) {
                toast.error(
                    `${skippedPhones.length} ${skippedPhones.length === 1 ? 'number was' : 'numbers were'} skipped and not charged — not yet whitelisted`
                )
            }
            setBulkSuccess(true)
            setValidationResults([])
            setBulkText('')
            setBulkFile(null)
            setPreviewDone(false)
            setBulkBatchRef('')
            fetchWalletBalance()
            fetchOrdersToday()
        } catch (error: any) {
            toast.error(error.message || 'Error submitting bulk orders')
        } finally {
            setIsSubmittingBulk(false)
        }
    }

    const deleteResult = (index: number) => {
        setValidationResults(prev => prev.filter((_, i) => i !== index))
        setPreviewDone(false)
    }

    return (
        <div className="space-y-4 pb-10">
            {/* Stats Cards */}
            <div className="grid grid-cols-2 gap-3">
                <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-gray-100 dark:border-zinc-800 p-3.5 flex flex-col items-center justify-center gap-1.5 min-h-[76px]">
                    <p className="text-[11px] text-muted-foreground font-medium text-center">Wallet Balance</p>
                    <p className="text-lg font-bold leading-none text-center">{formatCurrency(animatedBalance)}</p>
                </div>
                <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-gray-100 dark:border-zinc-800 p-3.5 flex flex-col items-center justify-center gap-1.5 min-h-[76px]">
                    <p className="text-[11px] text-muted-foreground font-medium text-center">Orders Today</p>
                    <p className="text-lg font-bold leading-none text-center">{Math.round(animatedOrders)}</p>
                </div>
            </div>

            {/* Network Selector */}
            <div className="grid grid-cols-4 gap-2">
                {NETWORKS.map(network => (
                    <NetworkSelectorCard
                        key={network}
                        network={network}
                        selected={selectedNetwork === network}
                        onClick={() => handleNetworkChange(network)}
                    />
                ))}
            </div>

            {/* MTN whitelist — only MTN delivery is gated behind a registration list */}
            {selectedNetwork === 'MTN' && (
                <button
                    onClick={() => setWhitelistOpen(true)}
                    className="w-full flex items-center gap-3 rounded-2xl border border-gray-100 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3.5 text-left hover:border-amber-300 dark:hover:border-amber-700 transition-colors"
                >
                    <span className="flex-shrink-0 w-9 h-9 rounded-xl bg-amber-400/15 flex items-center justify-center">
                        <ShieldCheck className="w-[18px] h-[18px] text-amber-500" />
                    </span>
                    <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold text-foreground">Check MTN Number Registration</span>
                        <span className="block text-xs text-muted-foreground mt-0.5">
                            Not-registered numbers are sent to MTN automatically · up to 1,000 at once
                        </span>
                    </span>
                    <ExternalLink className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                </button>
            )}

            <MtnWhitelistChecker open={whitelistOpen} onOpenChange={setWhitelistOpen} />

            {/* Single · Special MTN Mashup · Bulk Tabs */}
            <div className="flex bg-gray-100 dark:bg-zinc-800 rounded-xl p-1 gap-1">
                <button
                    onClick={() => setActiveTab('single')}
                    className={cn(
                        'flex-1 py-2 text-sm font-semibold rounded-lg transition-all duration-150',
                        activeTab === 'single'
                            ? 'bg-white dark:bg-zinc-900 text-foreground shadow-sm'
                            : 'text-muted-foreground hover:text-foreground'
                    )}
                >
                    Single
                </button>
                {mashupPackages.length > 0 && (
                    <button
                        onClick={() => setActiveTab('mtn_mashup')}
                        className={cn(
                            'flex-1 py-2 text-xs sm:text-sm font-semibold rounded-lg transition-all duration-150 whitespace-nowrap',
                            activeTab === 'mtn_mashup'
                                ? 'bg-white dark:bg-zinc-900 text-foreground shadow-sm'
                                : 'text-muted-foreground hover:text-foreground'
                        )}
                    >
                        Special MTN Mashup
                    </button>
                )}
                <button
                    onClick={() => setActiveTab('bulk')}
                    className={cn(
                        'flex-1 py-2 text-sm font-semibold rounded-lg transition-all duration-150',
                        activeTab === 'bulk'
                            ? 'bg-white dark:bg-zinc-900 text-foreground shadow-sm'
                            : 'text-muted-foreground hover:text-foreground'
                    )}
                >
                    Bulk Order
                </button>
            </div>

            {/* Order-success SMS preference — applies to single & bulk */}
            <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card p-3.5">
                <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">Order SMS confirmation</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                        The beneficiary gets a text confirming their order (single &amp; bulk).
                    </p>
                </div>
                <Switch
                    checked={orderSmsEnabled}
                    onCheckedChange={handleToggleOrderSms}
                    disabled={savingOrderSms}
                    aria-label="Send the beneficiary an SMS confirming their order"
                />
            </div>

            {/* ── Single Tab ── */}
            {activeTab === 'single' && (
                <div className="space-y-4">
                    {/* Search + View Toggle */}
                    <div className="flex gap-2">
                        <div className="relative flex-1">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                            <Input
                                placeholder="Search packages…"
                                value={searchQuery}
                                onChange={e => setSearchQuery(e.target.value)}
                                className="pl-9 h-9 text-sm"
                            />
                        </div>
                        <div className="flex border border-border rounded-lg overflow-hidden">
                            <button
                                onClick={() => handleViewModeChange('grid')}
                                title="Grid view"
                                className={cn(
                                    'px-2.5 py-2 transition-colors',
                                    viewMode === 'grid'
                                        ? 'bg-foreground text-background'
                                        : 'hover:bg-muted text-muted-foreground'
                                )}
                            >
                                <LayoutGrid className="w-4 h-4" />
                            </button>
                            <button
                                onClick={() => handleViewModeChange('list')}
                                title="List view"
                                className={cn(
                                    'px-2.5 py-2 border-l border-border transition-colors',
                                    viewMode === 'list'
                                        ? 'bg-foreground text-background'
                                        : 'hover:bg-muted text-muted-foreground'
                                )}
                            >
                                <List className="w-4 h-4" />
                            </button>
                        </div>
                    </div>

                    {/* Package Grid / List */}
                    {isLoading || (isSubAgentViewer && !subAgentPricingLoaded) ? (
                        <div className="flex items-center justify-center py-20">
                            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
                        </div>
                    ) : isSelectedNetworkOOS ? (
                        <div className="rounded-2xl border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-8 text-center">
                            <p className="text-lg font-bold text-amber-700 dark:text-amber-400">
                                {selectedNetwork} is Out of Stock at the Moment
                            </p>
                            <p className="text-sm text-amber-600/80 mt-1">
                                Please check back soon or pick another network.
                            </p>
                        </div>
                    ) : filteredPackages.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
                            <Wifi className="w-10 h-10 opacity-30" />
                            <p className="text-sm">No packages found</p>
                        </div>
                    ) : viewMode === 'grid' ? (
                        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
                            {filteredPackages.map(pkg => {
                                const style = NETWORK_STYLE[pkg.network] ?? NETWORK_STYLE.MTN
                                return (
                                    <button
                                        key={pkg.id}
                                        onClick={() => handlePurchaseClick(pkg)}
                                        className={cn(
                                            'relative flex flex-col items-center rounded-2xl overflow-hidden transition-all duration-150 shadow-md hover:shadow-xl hover:-translate-y-0.5 active:scale-[0.94] active:shadow-sm cursor-pointer select-none text-left',
                                            style.cardBg
                                        )}
                                    >
                                        <div className="flex items-center justify-between w-full px-3 pt-3 pb-1">
                                            <div className="p-1.5 bg-white/20 rounded-full">
                                                <NetworkIcon network={pkg.network} size={20} variant="card" />
                                            </div>
                                            <span className={cn(
                                                'text-[9px] font-semibold px-2 py-0.5 rounded-full',
                                                style.isMTN ? 'bg-black/10 text-black' : 'bg-white/20 text-white'
                                            )}>
                                                {pkg.network === 'AT-iShare' ? 'AT-iS' :
                                                 pkg.network === 'AT-BigTime' ? 'AT-BT' :
                                                 pkg.network}
                                            </span>
                                        </div>

                                        <div className="flex-1 flex flex-col items-center justify-center px-2 py-3 gap-0.5">
                                            <span className={cn(
                                                'text-2xl font-black tracking-tight',
                                                style.isMTN ? 'text-black' : 'text-white'
                                            )}>
                                                {pkg.size}
                                            </span>
                                            <span className={cn(
                                                'text-sm font-bold',
                                                style.isMTN ? 'text-black/80' : 'text-white/90'
                                            )}>
                                                {formatCurrency(getEffectivePrice(pkg))}
                                            </span>
                                            {pkg.description && pkg.description !== 'Instant Delivery' && (
                                                <span className={cn(
                                                    'text-[9px] mt-0.5 px-1 text-center line-clamp-1 opacity-70',
                                                    style.isMTN ? 'text-black' : 'text-white'
                                                )}>
                                                    {pkg.description}
                                                </span>
                                            )}
                                        </div>

                                        <div className={cn(
                                            'w-full py-2.5 text-[11px] font-semibold flex items-center justify-center gap-1.5',
                                            style.isMTN ? 'bg-black/10 text-black' : 'bg-black/20 text-white'
                                        )}>
                                            <ShoppingCart className="w-3 h-3" />
                                            Buy Now
                                        </div>
                                    </button>
                                )
                            })}
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {filteredPackages.map(pkg => {
                                const style = NETWORK_STYLE[pkg.network] ?? NETWORK_STYLE.MTN
                                return (
                                    <button
                                        key={pkg.id}
                                        onClick={() => handlePurchaseClick(pkg)}
                                        className={cn(
                                            'w-full flex items-center justify-between p-3.5 rounded-2xl transition-all duration-150 shadow-sm hover:shadow-md active:scale-[0.97] active:brightness-95 cursor-pointer select-none',
                                            style.cardBg
                                        )}
                                    >
                                        <div className="flex items-center gap-3">
                                            <div className="p-2 bg-white/20 rounded-xl">
                                                <NetworkIcon network={pkg.network} size={30} />
                                            </div>
                                            <div className="text-left">
                                                <p className={cn('font-bold text-sm leading-tight', style.isMTN ? 'text-black' : 'text-white')}>
                                                    {pkg.size}
                                                </p>
                                                <p className={cn('text-[10px] mt-0.5', style.isMTN ? 'text-black/60' : 'text-white/60')}>
                                                    {pkg.description || 'Data Bundle'}
                                                </p>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-3">
                                            <span className={cn('text-base font-black', style.isMTN ? 'text-black' : 'text-white')}>
                                                {formatCurrency(getEffectivePrice(pkg))}
                                            </span>
                                            <div className={cn(
                                                'px-3 py-1.5 rounded-xl text-[11px] font-semibold flex items-center gap-1.5',
                                                style.isMTN ? 'bg-black/10 text-black' : 'bg-white/20 text-white'
                                            )}>
                                                <ShoppingCart className="w-3 h-3" />
                                                Buy
                                            </div>
                                        </div>
                                    </button>
                                )
                            })}
                        </div>
                    )}
                </div>
            )}

            {/* ── MTN Mashup Tab ── */}
            {activeTab === 'mtn_mashup' && (
                <div className="space-y-4">
                    <div className="rounded-2xl bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 px-4 py-3">
                        <p className="text-sm font-semibold text-amber-900 dark:text-amber-300">Special MTN Mashup</p>
                        <p className="text-xs text-amber-800/80 dark:text-amber-400/80">
                            Curated MTN bundles. Processed by our team — status updates appear in My Orders.
                        </p>
                    </div>

                    {/* View toggle (grid / list) — shares viewMode with the Single tab */}
                    {mashupPackages.length > 0 && (
                        <div className="flex justify-end">
                            <div className="flex border border-border rounded-lg overflow-hidden">
                                <button
                                    onClick={() => handleViewModeChange('grid')}
                                    title="Grid view"
                                    className={cn('px-2.5 py-2 transition-colors', viewMode === 'grid' ? 'bg-foreground text-background' : 'hover:bg-muted text-muted-foreground')}
                                >
                                    <LayoutGrid className="w-4 h-4" />
                                </button>
                                <button
                                    onClick={() => handleViewModeChange('list')}
                                    title="List view"
                                    className={cn('px-2.5 py-2 border-l border-border transition-colors', viewMode === 'list' ? 'bg-foreground text-background' : 'hover:bg-muted text-muted-foreground')}
                                >
                                    <List className="w-4 h-4" />
                                </button>
                            </div>
                        </div>
                    )}

                    {mashupPackages.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
                            <Wifi className="w-10 h-10 opacity-30" />
                            <p className="text-sm">No Mashup packages available</p>
                        </div>
                    ) : viewMode === 'grid' ? (
                        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
                            {mashupPackages.map(pkg => {
                                const style = NETWORK_STYLE[pkg.network] ?? NETWORK_STYLE.MTN
                                return (
                                    <button
                                        key={pkg.id}
                                        onClick={() => handlePurchaseClick(pkg)}
                                        className={cn(
                                            'relative flex flex-col items-center rounded-2xl overflow-hidden transition-all duration-150 shadow-md hover:shadow-xl hover:-translate-y-0.5 active:scale-[0.94] active:shadow-sm cursor-pointer select-none text-left',
                                            style.cardBg
                                        )}
                                    >
                                        <div className="flex items-center justify-between w-full px-3 pt-3 pb-1">
                                            <div className="p-1.5 bg-white/20 rounded-full">
                                                <NetworkIcon network={pkg.network} size={20} variant="card" />
                                            </div>
                                            <span className={cn(
                                                'text-[8px] font-semibold px-1.5 py-0.5 rounded-full shrink-0',
                                                style.isMTN ? 'bg-black/10 text-black' : 'bg-white/20 text-white'
                                            )}>
                                                MASHUP
                                            </span>
                                        </div>
                                        <div className="flex-1 flex flex-col items-center justify-center w-full px-2 py-3 gap-0.5 text-center">
                                            <span className={cn('text-sm sm:text-base font-black leading-tight break-words w-full', style.isMTN ? 'text-black' : 'text-white')}>
                                                {pkg.size}
                                            </span>
                                            <span className={cn('text-sm font-bold', style.isMTN ? 'text-black/80' : 'text-white/90')}>
                                                {formatCurrency(getEffectivePrice(pkg))}
                                            </span>
                                            {pkg.description && (
                                                <span className={cn('text-[9px] mt-0.5 px-1 break-words line-clamp-2', style.isMTN ? 'text-black/70' : 'text-white/80')}>
                                                    {pkg.description}
                                                </span>
                                            )}
                                        </div>
                                        <div className={cn(
                                            'w-full py-2.5 text-[11px] font-semibold flex items-center justify-center gap-1.5',
                                            style.isMTN ? 'bg-black/10 text-black' : 'bg-black/20 text-white'
                                        )}>
                                            <ShoppingCart className="w-3 h-3" />
                                            Buy Now
                                        </div>
                                    </button>
                                )
                            })}
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {mashupPackages.map(pkg => {
                                const style = NETWORK_STYLE[pkg.network] ?? NETWORK_STYLE.MTN
                                return (
                                    <button
                                        key={pkg.id}
                                        onClick={() => handlePurchaseClick(pkg)}
                                        className={cn(
                                            'w-full flex items-center justify-between gap-3 p-3.5 rounded-2xl transition-all duration-150 shadow-md hover:shadow-lg active:scale-[0.98] active:brightness-95 cursor-pointer select-none text-left',
                                            style.cardBg
                                        )}
                                    >
                                        <div className="flex items-center gap-3 min-w-0">
                                            <div className="p-2 bg-white/20 rounded-xl shrink-0">
                                                <NetworkIcon network={pkg.network} size={30} variant="card" />
                                            </div>
                                            <div className="min-w-0">
                                                <div className="flex items-center gap-1.5 flex-wrap">
                                                    <p className={cn('font-bold text-sm leading-tight break-words', style.isMTN ? 'text-black' : 'text-white')}>
                                                        {pkg.size}
                                                    </p>
                                                    <span className={cn(
                                                        'text-[8px] font-semibold px-1.5 py-0.5 rounded-full shrink-0',
                                                        style.isMTN ? 'bg-black/10 text-black' : 'bg-white/20 text-white'
                                                    )}>
                                                        MASHUP
                                                    </span>
                                                </div>
                                                {pkg.description && (
                                                    <p className={cn('text-[10px] mt-0.5 break-words line-clamp-2', style.isMTN ? 'text-black/60' : 'text-white/60')}>
                                                        {pkg.description}
                                                    </p>
                                                )}
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-3 shrink-0">
                                            <span className={cn('text-base font-black', style.isMTN ? 'text-black' : 'text-white')}>
                                                {formatCurrency(getEffectivePrice(pkg))}
                                            </span>
                                            <div className={cn(
                                                'px-3 py-1.5 rounded-xl text-[11px] font-semibold flex items-center gap-1.5',
                                                style.isMTN ? 'bg-black/10 text-black' : 'bg-white/20 text-white'
                                            )}>
                                                <ShoppingCart className="w-3 h-3" />
                                                Buy
                                            </div>
                                        </div>
                                    </button>
                                )
                            })}
                        </div>
                    )}
                </div>
            )}

            {/* ── Bulk Tab ── */}
            {activeTab === 'bulk' && (
                <div className="space-y-3">
                    {/* Input card */}
                    <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-gray-100 dark:border-zinc-800 overflow-hidden">
                        {/* Tab header */}
                        <div className="flex border-b border-gray-100 dark:border-zinc-800">
                            <button
                                onClick={() => {
                                    setBulkInputType('text')
                                    setPreviewDone(false)
                                    setValidationResults([])
                                }}
                                className={cn(
                                    'flex-1 flex items-center justify-center gap-2 py-3 text-sm font-medium transition-colors',
                                    bulkInputType === 'text'
                                        ? 'border-b-2 border-foreground text-foreground'
                                        : 'text-muted-foreground hover:text-foreground'
                                )}
                            >
                                <FileText className="w-4 h-4" />
                                Text
                            </button>
                            <button
                                onClick={() => {
                                    setBulkInputType('excel')
                                    setPreviewDone(false)
                                    setValidationResults([])
                                }}
                                className={cn(
                                    'flex-1 flex items-center justify-center gap-2 py-3 text-sm font-medium transition-colors',
                                    bulkInputType === 'excel'
                                        ? 'border-b-2 border-foreground text-foreground'
                                        : 'text-muted-foreground hover:text-foreground'
                                )}
                            >
                                <FileSpreadsheet className="w-4 h-4" />
                                Excel / CSV
                            </button>
                        </div>

                        <div className="p-4 space-y-3">
                            {bulkInputType === 'text' ? (
                                <>
                                    <p className="text-xs text-muted-foreground">
                                        One per line · up to 500 items · e.g.{' '}
                                        <code className="font-mono font-bold text-foreground">0241234567 5</code>
                                        {' '}or{' '}
                                        <code className="font-mono font-bold text-foreground">0551234567 10</code>
                                    </p>
                                    <textarea
                                        ref={textareaRef}
                                        className="w-full min-h-[150px] rounded-xl border border-gray-200 dark:border-zinc-700 bg-gray-50 dark:bg-zinc-800 px-3 py-3 text-xs font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-gray-400 dark:focus:border-zinc-500 resize-none transition-colors"
                                        placeholder={`0241234567  5\n0541234567  10\n0207654321  1`}
                                        value={bulkText}
                                        onChange={e => {
                                            setBulkText(e.target.value)
                                            setPreviewDone(false)
                                        }}
                                    />
                                </>
                            ) : (
                                <>
                                    <div className="flex items-center justify-between gap-2">
                                        <p className="text-xs text-muted-foreground">
                                            Upload Excel or CSV with two columns: Phone, Volume (GB)
                                        </p>
                                        <button
                                            type="button"
                                            onClick={downloadBulkTemplate}
                                            className="shrink-0 flex items-center gap-1.5 text-xs font-medium text-foreground hover:underline"
                                        >
                                            <Download className="w-3.5 h-3.5" />
                                            Template
                                        </button>
                                    </div>
                                    <div
                                        className="flex flex-col items-center gap-3 border-2 border-dashed border-gray-200 dark:border-zinc-700 rounded-xl p-8 cursor-pointer hover:bg-gray-50 dark:hover:bg-zinc-800/50 transition-colors"
                                        onClick={() => document.getElementById('excel-upload')?.click()}
                                    >
                                        <input
                                            id="excel-upload"
                                            type="file"
                                            accept=".xlsx,.xls,.csv"
                                            className="hidden"
                                            onChange={e => {
                                                const file = e.target.files?.[0]
                                                if (file) {
                                                    setBulkFile(file)
                                                    setPreviewDone(false)
                                                    setValidationResults([])
                                                }
                                            }}
                                        />
                                        <div className="p-3 bg-gray-100 dark:bg-zinc-800 rounded-xl">
                                            <Upload className="w-5 h-5 text-muted-foreground" />
                                        </div>
                                        <p className="text-sm font-medium">{bulkFile ? bulkFile.name : 'Click to upload'}</p>
                                        <p className="text-xs text-muted-foreground">.xlsx · .xls · .csv</p>
                                    </div>
                                </>
                            )}
                        </div>
                    </div>

                    {/* Validation Results */}
                    {validationResults.length > 0 && (
                        <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-gray-100 dark:border-zinc-800 overflow-hidden">
                            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-zinc-800">
                                <p className="text-sm font-semibold">
                                    <span className="text-green-600">{validOrders.length} valid</span>
                                    {validationResults.filter(r => r.whitelistStatus === 'blocked').length > 0 && (
                                        <span className="text-muted-foreground">
                                            {' · '}
                                            <span className="text-amber-600">{validationResults.filter(r => r.whitelistStatus === 'blocked').length} not whitelisted</span>
                                        </span>
                                    )}
                                    {validationResults.filter(r => !r.isValid).length > 0 && (
                                        <span className="text-muted-foreground">
                                            {' · '}
                                            <span className="text-red-500">{validationResults.filter(r => !r.isValid).length} invalid</span>
                                        </span>
                                    )}
                                </p>
                                <div className="flex items-center gap-3">
                                    {validationResults.some(r => !r.isValid) && (
                                        <button
                                            onClick={() => {
                                                setValidationResults(prev => prev.filter(r => r.isValid))
                                                setPreviewDone(false)
                                            }}
                                            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                                        >
                                            Clear invalid
                                        </button>
                                    )}
                                    <button
                                        onClick={() => {
                                            setValidationResults([])
                                            setBulkText('')
                                            setBulkFile(null)
                                            setPreviewDone(false)
                                        }}
                                        className="text-xs text-red-500 hover:text-red-600 transition-colors"
                                    >
                                        Clear all
                                    </button>
                                </div>
                            </div>
                            <div className="max-h-56 overflow-y-auto divide-y divide-gray-50 dark:divide-zinc-800">
                                {validationResults.map((res, i) => (
                                    <div
                                        key={i}
                                        className="flex items-center justify-between px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-zinc-800/50 group transition-colors"
                                    >
                                        <div className="flex items-center gap-2.5">
                                            <div className={cn(
                                                'w-1.5 h-1.5 rounded-full flex-shrink-0',
                                                !res.isValid ? 'bg-red-500' : res.whitelistStatus === 'blocked' ? 'bg-amber-500' : 'bg-green-500'
                                            )} />
                                            <span className="text-xs font-medium">{res.phoneNumber}</span>
                                        </div>
                                        <div className="flex items-center gap-3">
                                            <span className="text-xs text-muted-foreground">{res.volume}GB</span>
                                            {!res.isValid ? (
                                                <span className="text-xs text-red-500">{res.errorMessage}</span>
                                            ) : res.whitelistStatus === 'blocked' ? (
                                                <span className="text-xs text-amber-600">Not whitelisted — skipped</span>
                                            ) : (
                                                <span className="text-xs font-semibold">{formatCurrency(res.packagePrice)}</span>
                                            )}
                                            <button
                                                onClick={() => deleteResult(i)}
                                                className="opacity-0 group-hover:opacity-100 p-1 rounded-md hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-500 transition-all"
                                            >
                                                <X className="w-3 h-3" />
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Action bar */}
                    <div className="flex items-center gap-2 bg-white dark:bg-zinc-900 rounded-2xl border border-gray-100 dark:border-zinc-800 px-3 py-2.5">
                        <p className="flex-1 min-w-0 text-xs text-muted-foreground truncate">
                            {validOrders.length > 0
                                ? `${validOrders.length} valid rows · Wallet ${formatCurrency(walletBalance)}`
                                : `0 valid rows · Wallet ${formatCurrency(walletBalance)}`}
                        </p>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={handlePreviewPrice}
                            disabled={
                                isValidating ||
                                (bulkInputType === 'text' ? !bulkText.trim() : !bulkFile)
                            }
                            className="shrink-0 h-8 text-xs gap-1.5 px-3"
                        >
                            {isValidating
                                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                : <Eye className="w-3.5 h-3.5" />}
                            Preview price
                        </Button>
                        {validOrders.length > 0 && walletBalance < totalBulkCost ? (
                            <Link href="/dashboard/wallet">
                                <Button
                                    size="sm"
                                    className="shrink-0 h-8 text-xs px-3 bg-amber-400 hover:bg-amber-500 text-black border-0"
                                >
                                    Top Up
                                </Button>
                            </Link>
                        ) : (
                            <Button
                                size="sm"
                                onClick={handleSubmitBulkOrder}
                                disabled={!previewDone || validOrders.length === 0 || isSubmittingBulk}
                                className="shrink-0 h-8 text-xs px-3 bg-foreground text-background hover:bg-foreground/90 gap-1.5"
                            >
                                {isSubmittingBulk && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                                Place order
                            </Button>
                        )}
                    </div>
                </div>
            )}

            {/* ── Single Purchase Bottom Sheet ── */}
            <Dialog
                open={!!selectedPackage}
                onOpenChange={open => {
                    if (!open && !isPurchasing) setSelectedPackage(null)
                }}
            >
                <DialogContent
                    className="!fixed !left-0 !right-0 !bottom-0 !top-auto !translate-x-0 !translate-y-0 w-full max-w-full rounded-t-[2rem] rounded-b-none p-0 gap-0 shadow-2xl border-x-0 border-b-0 [&>button:last-of-type]:hidden"
                    aria-describedby={undefined}
                    onOpenAutoFocus={e => {
                        e.preventDefault()
                        if (!purchaseSuccess) setTimeout(() => phoneInputRef.current?.focus(), 50)
                    }}
                    onInteractOutside={e => { if (isPurchasing) e.preventDefault() }}
                >
                    <DialogDescription className="sr-only">Purchase data bundle</DialogDescription>

                    {/* drag handle + close button */}
                    <div className="relative flex items-center justify-center pt-3 pb-1">
                        <div className="w-9 h-1 rounded-full bg-gray-200 dark:bg-zinc-700" />
                        <DialogClose
                            disabled={isPurchasing}
                            className="absolute right-3 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-muted flex items-center justify-center text-muted-foreground hover:bg-muted/80 active:scale-95 transition-all disabled:pointer-events-none disabled:opacity-40"
                        >
                            <X className="w-4 h-4" />
                            <span className="sr-only">Close</span>
                        </DialogClose>
                    </div>

                    {purchaseSuccess ? (
                        /* ── Success state ── */
                        <div className="px-6 pb-10 pt-3 space-y-5">
                            <div className="flex flex-col items-center gap-2">
                                <div className="w-14 h-14 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                                    <CheckCircle2 className="w-7 h-7 text-green-600" />
                                </div>
                                <DialogTitle className="text-lg font-bold">Order Placed!</DialogTitle>
                                <p className="text-xs text-muted-foreground text-center">Your data bundle is being processed</p>
                            </div>

                            {purchaseDetails && (
                                <div className="bg-muted/50 rounded-2xl p-4 space-y-3">
                                    {[
                                        ['Recipient', purchaseDetails.phoneNumber],
                                        ['Package', `${purchaseDetails.network} ${purchaseDetails.size}`],
                                        ['Amount Paid', formatCurrency(purchaseDetails.price)],
                                    ].map(([label, value]) => (
                                        <div key={label} className="flex items-center justify-between text-sm">
                                            <span className="text-muted-foreground">{label}</span>
                                            <span className="font-semibold">{value}</span>
                                        </div>
                                    ))}
                                    <div className="border-t border-border/50 pt-2 flex items-center justify-between text-sm">
                                        <span className="text-muted-foreground">Ref</span>
                                        <span className="font-mono text-xs text-muted-foreground">{purchaseDetails.referenceCode}</span>
                                    </div>
                                </div>
                            )}

                            <div className="flex gap-3">
                                <Button variant="outline" className="flex-1" onClick={() => setSelectedPackage(null)}>
                                    Done
                                </Button>
                                <Button
                                    className="flex-1"
                                    onClick={() => { setSelectedPackage(null); router.push('/dashboard/my-orders') }}
                                >
                                    <ExternalLink className="w-4 h-4 mr-2" />
                                    View Orders
                                </Button>
                            </div>
                        </div>
                    ) : (
                        /* ── Purchase form ── */
                        <div className="pb-8">
                            {/* Network badge */}
                            {selectedPackage && (() => {
                                const style = NETWORK_STYLE[selectedPackage.network] ?? NETWORK_STYLE.MTN
                                return (
                                    <div className={cn('mx-4 mt-2 mb-4 rounded-2xl px-4 py-3 flex items-center gap-3', style.cardBg)}>
                                        <div className="p-2 bg-white/20 rounded-xl shrink-0">
                                            <NetworkIcon network={selectedPackage.network} size={32} variant="card" />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className={cn('text-xs font-semibold', style.isMTN ? 'text-black/60' : 'text-white/70')}>
                                                {selectedPackage.network === 'AT-iShare' ? 'AT iShare' :
                                                 selectedPackage.network === 'AT-BigTime' ? 'AT BigTime' :
                                                 selectedPackage.network} · {selectedPackage.description || 'Data Bundle'}
                                            </p>
                                            <p className={cn('text-2xl font-black leading-none mt-0.5', style.isMTN ? 'text-black' : 'text-white')}>
                                                {selectedPackage.size}
                                            </p>
                                        </div>
                                        <p className={cn('text-xl font-black shrink-0', style.isMTN ? 'text-black' : 'text-white')}>
                                            {formatCurrency(getEffectivePrice(selectedPackage))}
                                        </p>
                                    </div>
                                )
                            })()}

                            <div className="px-4 space-y-4">
                                <DialogTitle className="sr-only">Buy {selectedPackage?.size}</DialogTitle>

                                {/* Phone input */}
                                <div className="space-y-1.5 relative">
                                    <Label htmlFor="phone-sheet" className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground px-1">
                                        Send to
                                    </Label>
                                    <Input
                                        ref={phoneInputRef}
                                        id="phone-sheet"
                                        type="tel"
                                        inputMode="numeric"
                                        placeholder="0241234567"
                                        value={phoneNumber}
                                        onChange={e => handlePhoneChange(e.target.value)}
                                        className={cn(
                                            'h-12 px-5 rounded-full text-base font-semibold',
                                            phoneError ? 'border-red-500 focus-visible:ring-red-500' : ''
                                        )}
                                    />
                                    {phoneError && (
                                        <p className="text-[10px] text-red-500 font-medium flex items-center gap-1 ml-4">
                                            <AlertCircle className="w-3 h-3" />
                                            {phoneError}
                                        </p>
                                    )}
                                </div>

                                {/* Balance row */}
                                <div className="flex items-center justify-between px-1 text-xs text-muted-foreground">
                                    <span>Wallet: <span className="font-semibold text-foreground">{formatCurrency(walletBalance)}</span></span>
                                    {selectedPackage && walletBalance >= getEffectivePrice(selectedPackage) && (
                                        <span>After: <span className="font-semibold text-green-600">{formatCurrency(walletBalance - getEffectivePrice(selectedPackage))}</span></span>
                                    )}
                                </div>

                                {/* CTA */}
                                {walletBalance < (selectedPackage ? getEffectivePrice(selectedPackage) : 0) ? (
                                    <Link href="/dashboard/wallet" onClick={() => setSelectedPackage(null)} className="block w-full">
                                        <Button className="w-full rounded-full h-13 font-semibold uppercase tracking-wide text-sm">
                                            Recharge Wallet
                                        </Button>
                                    </Link>
                                ) : (
                                    <Button
                                        onClick={handlePurchase}
                                        disabled={isPurchasing || !phoneNumber || !!phoneError}
                                        className="w-full rounded-full h-13 bg-amber-400 hover:bg-amber-500 text-black font-bold text-sm transition-all active:scale-[0.98] shadow-sm disabled:opacity-50"
                                    >
                                        {isPurchasing ? (
                                            <div className="flex items-center gap-2">
                                                <Loader2 className="w-4 h-4 animate-spin" />
                                                Processing…
                                            </div>
                                        ) : (
                                            `Pay ${selectedPackage && formatCurrency(getEffectivePrice(selectedPackage))}`
                                        )}
                                    </Button>
                                )}
                            </div>
                        </div>
                    )}
                </DialogContent>
            </Dialog>

            {/* ── Bulk Success Dialog ── */}
            <Dialog open={bulkSuccess} onOpenChange={() => setBulkSuccess(false)}>
                <DialogContent
                    className="w-[95%] max-w-sm sm:max-w-md rounded-2xl p-5"
                    aria-describedby={undefined}
                >
                    <div className="space-y-5">
                        <div className="flex flex-col items-center gap-2 pt-2">
                            <div className="w-14 h-14 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                                <CheckCircle2 className="w-7 h-7 text-green-600" />
                            </div>
                            <DialogTitle className="text-lg font-bold text-center">
                                {bulkSuccessDetails?.ordersPlaced} Orders Placed!
                            </DialogTitle>
                            <p className="text-xs text-muted-foreground text-center">All bundles are being processed</p>
                        </div>

                        {bulkSuccessDetails && (
                            <div className="grid grid-cols-2 gap-3">
                                <div className="bg-muted/50 rounded-xl p-3 text-center">
                                    <p className="text-xs text-muted-foreground mb-1">Total Cost</p>
                                    <p className="font-bold text-sm">{formatCurrency(bulkSuccessDetails.totalCost)}</p>
                                </div>
                                <div className="bg-muted/50 rounded-xl p-3 text-center">
                                    <p className="text-xs text-muted-foreground mb-1">New Balance</p>
                                    <p className="font-bold text-sm">{formatCurrency(bulkSuccessDetails.newBalance)}</p>
                                </div>
                            </div>
                        )}

                        {bulkSuccessDetails && bulkSuccessDetails.orders.length > 0 && (
                            <div className="rounded-xl border border-border/50 overflow-hidden">
                                <div className="bg-muted/30 px-4 py-2 border-b border-border/50">
                                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Order Summary</p>
                                </div>
                                <div className="overflow-y-auto max-h-[35vh] divide-y divide-border/30">
                                    {bulkSuccessDetails.orders.map((o, i) => (
                                        <div key={i} className="flex items-center justify-between px-4 py-2.5 hover:bg-muted/20 transition-colors">
                                            <div className="flex items-center gap-2">
                                                <div className="w-1.5 h-1.5 rounded-full bg-green-500 flex-shrink-0" />
                                                <span className="text-xs font-medium">{o.phoneNumber}</span>
                                            </div>
                                            <div className="flex items-center gap-3 text-xs text-muted-foreground">
                                                <span>{o.volume}GB</span>
                                                <span className="font-semibold text-foreground">{formatCurrency(o.packagePrice)}</span>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {bulkSuccessDetails && bulkSuccessDetails.skipped.length > 0 && (
                            <div className="rounded-xl border border-amber-200 dark:border-amber-800 overflow-hidden">
                                <div className="bg-amber-50 dark:bg-amber-950/30 px-4 py-2 border-b border-amber-200 dark:border-amber-800">
                                    <p className="text-xs font-semibold text-amber-700 dark:text-amber-400 uppercase tracking-wide">
                                        {bulkSuccessDetails.skipped.length} Skipped — Not Delivered
                                    </p>
                                </div>
                                <div className="overflow-y-auto max-h-[25vh] divide-y divide-amber-100 dark:divide-amber-900/40">
                                    {bulkSuccessDetails.skipped.map((s, i) => (
                                        <div key={i} className="flex items-center justify-between px-4 py-2.5">
                                            <div className="flex items-center gap-2">
                                                <div className="w-1.5 h-1.5 rounded-full bg-amber-500 flex-shrink-0" />
                                                <span className="text-xs font-medium">{s.phone}</span>
                                            </div>
                                            <span className="text-xs text-amber-600">{s.reason}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        <div className="flex gap-3">
                            <Button variant="outline" className="flex-1" onClick={() => setBulkSuccess(false)}>
                                Done
                            </Button>
                            <Button
                                className="flex-1"
                                onClick={() => { setBulkSuccess(false); router.push('/dashboard/my-orders') }}
                            >
                                <ExternalLink className="w-4 h-4 mr-2" />
                                View Orders
                            </Button>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    )
}
