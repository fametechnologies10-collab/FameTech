'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@/contexts/auth-context'
import { supabase } from '@/lib/supabase'
import { formatCurrency } from '@/lib/utils'
import { resolveAfaPrice } from '@/lib/afa-pricing'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Checkbox } from '@/components/ui/checkbox'
import {
    Tag, Save, Loader2, TrendingUp, AlertCircle, CheckCircle2,
    Clock, XCircle, Send, ArrowLeft, Sparkles, PhoneCall, Zap,
    Copy, Check, ExternalLink, PartyPopper, Lightbulb, MessageCircle,
    IdCard
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { filterPackagesForSubAgent, SubAgentPricingMap } from '@/lib/sub-agent-package-filter'

interface Package {
    id: string
    network: string
    size: string
    price: number
    agent_price: number
    dealer_price: number
    cost_price: number
    is_available: boolean
    sort_order: number
}

interface ExamType {
    id: string
    name: string
    customer_price: number
    agent_price: number
    bulk_pricing?: { min_qty: number; max_qty: number; unit_price: number }[]
}

interface ShopProfile {
    id: string
    shop_name: string
    shop_slug: string
    owner_role: string
    approval_status: string
    pricing_status: 'not_submitted' | 'pending_review' | 'approved' | 'rejected'
    pricing_note: string | null
    pricing_rejection_acknowledged: boolean
    airtime_fee_mtn?: number
    airtime_fee_telecel?: number
    airtime_fee_at?: number
    results_checker_markup_customer?: number
    results_checker_markup_agent?: number
    mashup_fee_percent?: number
    afa_selling_price?: number
    oos_networks?: string[]
}

const networkTabColors: Record<string, { active: string; inactive: string }> = {
    MTN: {
        active: 'bg-yellow-400 text-yellow-950 border-yellow-400 shadow-md',
        inactive: 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800 text-yellow-800 dark:text-yellow-300 hover:bg-yellow-100 dark:hover:bg-yellow-900/30',
    },
    Telecel: {
        active: 'bg-red-500 text-white border-red-500 shadow-md',
        inactive: 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/30',
    },
    'AT-iShare': {
        active: 'bg-blue-500 text-white border-blue-500 shadow-md',
        inactive: 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/30',
    },
    'AT-BigTime': {
        active: 'bg-purple-600 text-white border-purple-600 shadow-md',
        inactive: 'bg-purple-50 dark:bg-purple-900/20 border-purple-200 dark:border-purple-800 text-purple-700 dark:text-purple-300 hover:bg-purple-100 dark:hover:bg-purple-900/30',
    },
}

const networkColors: Record<string, string> = {
    MTN: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400',
    Telecel: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
    'AT-iShare': 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
    'AT-BigTime': 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400',
    AT: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400',
}

const NETWORKS = ['MTN', 'Telecel', 'AT-iShare', 'AT-BigTime']
const AIRTIME_NETWORKS = ['MTN', 'Telecel', 'AT']

type Section = 'data' | 'airtime' | 'rc' | 'mashup' | 'afa'
type BulkMode = 'flat' | 'percent'

const SECTIONS: { id: Section; label: string; icon: any }[] = [
    { id: 'data', label: 'Data Bundles', icon: Tag },
    { id: 'airtime', label: 'Airtime', icon: PhoneCall },
    { id: 'rc', label: 'Results Checker', icon: Sparkles },
    { id: 'mashup', label: 'Mashup', icon: Zap },
    { id: 'afa', label: 'AFA Registration', icon: IdCard },
]

export default function ShopPricingPage() {
    const { dbUser, isAdmin, isSubAdmin } = useAuth()
    const router = useRouter()
    const [shop, setShop] = useState<ShopProfile | null>(null)
    const [packages, setPackages] = useState<Package[]>([])
    const [examTypes, setExamTypes] = useState<ExamType[]>([])
    const [pricing, setPricing] = useState<Record<string, string>>({})
    const [airtimeFees, setAirtimeFees] = useState({ mtn: '', telecel: '', at: '' })
    const [rcMarkups, setRcMarkups] = useState<Record<string, string>>({})
    const [mashupFee, setMashupFee] = useState('')
    const [mashupMaxProfit, setMashupMaxProfit] = useState<number>(0) // 0 = no limit
    const [afaSellingPrice, setAfaSellingPrice] = useState('')
    const [afaCost, setAfaCost] = useState<number>(0) // resolveAfaPrice(role) — what we charge the shop owner
    const [afaMaxProfit, setAfaMaxProfit] = useState<number>(0) // 0 = no limit, GHS profit ceiling
    const [adminAirtimeFees, setAdminAirtimeFees] = useState<Record<string, number>>({})
    const [dataMaxProfit, setDataMaxProfit] = useState<number>(Infinity) // no limit until settings load

    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [savingSection, setSavingSection] = useState<Section | null>(null)
    const [savingPkg, setSavingPkg] = useState<string | null>(null)
    const [acknowledging, setAcknowledging] = useState(false)
    const [activeSection, setActiveSection] = useState<Section>('data')
    const [activeNetwork, setActiveNetwork] = useState<string>('MTN')
    // Data-bundle pricing has two ways in: the per-package Manual grid (default)
    // and the Bulk rule builder.
    const [pricingMode, setPricingMode] = useState<'manual' | 'bulk'>('manual')

    // Per-network out-of-stock state
    const [shopOOS, setShopOOS] = useState<string[]>([])
    const [adminOOS, setAdminOOS] = useState<Record<string, boolean>>({})
    const [oosSaving, setOosSaving] = useState<string | null>(null)

    // Bulk apply state
    const [bulkMode, setBulkMode] = useState<BulkMode>('flat')
    const [bulkValue, setBulkValue] = useState<string>('5')
    const [bulkApplyTarget, setBulkApplyTarget] = useState<string>('MTN')
    // Packages the owner has explicitly unticked in the bulk preview. Rows that
    // fail a policy check (below cost / over the profit cap) are excluded
    // automatically and are NOT tracked here — they can't be ticked back on.
    const [bulkExcludedIds, setBulkExcludedIds] = useState<Set<string>>(new Set())

    // Completion / go-live celebration modal
    const [showLiveModal, setShowLiveModal] = useState(false)
    const [copied, setCopied] = useState(false)
    const [fromSetup, setFromSetup] = useState(false)

    useEffect(() => {
        // Read ?from=setup without useSearchParams (avoids Suspense bailout)
        if (typeof window !== 'undefined') {
            setFromSetup(new URLSearchParams(window.location.search).get('from') === 'setup')
        }
    }, [])

    useEffect(() => {
        if (dbUser) fetchData()
    }, [dbUser, isAdmin, isSubAdmin])

    // Exclusions are per-network/per-mode — a package unticked for MTN must not
    // stay unticked when the owner switches to Telecel.
    useEffect(() => {
        setBulkExcludedIds(new Set())
    }, [bulkApplyTarget, bulkMode])

    const fetchData = async () => {
        try {
            const { data: shopData } = await ((supabase as any)
                .from('shop_profiles')
                .select('id, shop_name, shop_slug, owner_id, approval_status, pricing_status, pricing_note, pricing_rejection_acknowledged, airtime_fee_mtn, airtime_fee_telecel, airtime_fee_at, results_checker_markup_customer, results_checker_markup_agent, mashup_fee_percent, afa_selling_price, oos_networks')
                .eq('owner_id', dbUser!.id)
                .maybeSingle())

            if (shopData && shopData.owner_id) {
                const { data: uData } = await (supabase as any).from('users').select('role').eq('id', shopData.owner_id).single()
                shopData.owner_role = uData?.role || 'customer'
            }

            if (!shopData) {
                toast.error('Please create your shop first')
                router.push('/dashboard/shop/setup')
                return
            }
            setShop(shopData)
            setShopOOS(shopData.oos_networks || [])

            setAirtimeFees({
                mtn: shopData.airtime_fee_mtn?.toString() || '',
                telecel: shopData.airtime_fee_telecel?.toString() || '',
                at: shopData.airtime_fee_at?.toString() || ''
            })

            setMashupFee(shopData.mashup_fee_percent?.toString() || '')
            // afa_selling_price null/absent means AFA is off for this shop — '' clears
            // the input, matching how a cleared save writes NULL server-side.
            setAfaSellingPrice(shopData.afa_selling_price?.toString() ?? '')

            const [pkgRes, priceRes, adminRes, examRes, markupRes] = await Promise.all([
                (supabase.from('data_packages').select('*').eq('is_available', true).order('sort_order') as any),
                // Explicit column list (not '*'): sub_price SELECT is revoked from the
                // authenticated role (migration 20260706g), so '*' would 500 here.
                ((supabase as any).from('shop_pricing').select('id, shop_id, package_id, selling_price, profit_margin, last_auto_updated_at').eq('shop_id', shopData.id)),
                fetch('/api/shop/pricing').then(res => res.json()),
                (supabase.from('results_checker_types').select('*').eq('is_active', true).order('display_order') as any),
                ((supabase as any).from('shop_rc_markups').select('exam_type_id, markup').eq('shop_id', shopData.id)),
            ])

            setPackages(pkgRes.data || [])
            setExamTypes(examRes.data || [])

            const adminFlags: Record<string, number> = {}
            for (const [key, value] of Object.entries(adminRes || {})) {
                adminFlags[key] = parseFloat(value as string) || 0
            }
            setAdminAirtimeFees(adminFlags)

            // AFA cost for this owner's role, resolved via the shared tiering helper —
            // never re-implement the customer/agent/dealer fallback logic here.
            // Sub-agents are excluded: the dedicated /api/user/afa-price effect below
            // is the sole source of truth for their real (markup-adjusted) cost, and
            // this fetchData() Promise.all is reliably the slower of the two async
            // calls — letting this tiered fallback run for sub-agents would race it
            // and overwrite the correct value with the plain customer-tier price.
            if (shopData.owner_role !== 'subagent') {
                setAfaCost(resolveAfaPrice(adminRes || {}, shopData.owner_role) || 0)
            }

            // Per-exam markups; fall back to legacy single markup for unset exams
            const markupMap: Record<string, string> = {}
            const legacy = shopData.results_checker_markup_customer
            for (const exam of (examRes.data || [])) {
                markupMap[exam.id] = legacy != null && legacy > 0 ? String(legacy) : ''
            }
            for (const row of (markupRes.data || [])) {
                markupMap[row.exam_type_id] = String(row.markup)
            }
            setRcMarkups(markupMap)

            // Fetch configurable profit caps from global settings
            const { data: globalRows } = await (supabase as any)
                .from('shop_global_settings')
                .select('key, value')
                .in('key', [
                    'data_profit_max_customer', 'data_profit_max_agent', 'data_profit_max_dealer',
                    'mashup_shop_fee_max_customer', 'mashup_shop_fee_max_agent', 'mashup_shop_fee_max_dealer',
                    'afa_shop_fee_max_customer', 'afa_shop_fee_max_agent', 'afa_shop_fee_max_dealer'
                ])
            if (globalRows) {
                const role = shopData.owner_role || 'customer'

                const dataRow = (globalRows as any[]).find((r: any) => r.key === `data_profit_max_${role}`)
                if (dataRow) {
                    const parsed = parseFloat(dataRow.value)
                    setDataMaxProfit(parsed > 0 ? parsed : Infinity)
                } else {
                    setDataMaxProfit(Infinity)
                }

                const mashupRow = (globalRows as any[]).find((r: any) => r.key === `mashup_shop_fee_max_${role}`)
                if (mashupRow) {
                    setMashupMaxProfit(parseFloat(mashupRow.value) || 0)
                } else {
                    setMashupMaxProfit(0)
                }

                const afaRow = (globalRows as any[]).find((r: any) => r.key === `afa_shop_fee_max_${role}`)
                setAfaMaxProfit(afaRow ? (parseFloat(afaRow.value) || 0) : 0)
            }

            const priceMap: Record<string, string> = {}
            for (const row of (priceRes.data || [])) {
                priceMap[row.package_id] = String(row.selling_price)
            }
            setPricing(priceMap)
        } catch (err) {
            console.error(err)
        } finally {
            setLoading(false)
        }
    }

    // ─── Admin OOS loader ─────────────────────────────────────────────────────
    useEffect(() => {
        fetch('/api/admin-settings?keys=data_network_stock', { cache: 'no-store' })
            .then(r => r.json())
            .then(j => setAdminOOS((j?.data_network_stock as Record<string, boolean>) || {}))
            .catch(() => {})
    }, [])

    // ─── Sub-agent's own resolved cost, per network ────────────────────────────
    // A sub-agent's real "your cost" floor is the recruiter-marked-up
    // resolveSubAgentDataCost() value, not plain customer/agent/dealer pricing.
    // Mirrors the exact fetch pattern in app/dashboard/data-packages/page.tsx:
    // fail-closed to {} on any fetch error (never assume a package is
    // configured), re-fetched whenever the active network changes. Completely
    // inert for every other role: isSubAgentOwner is false, the fetch never
    // runs, and subAgentCostMap stays {} (harmless no-op below).
    const isSubAgentOwner = dbUser?.role === 'subagent'
    const [subAgentCostMap, setSubAgentCostMap] = useState<SubAgentPricingMap>({})

    useEffect(() => {
        if (!isSubAgentOwner) return
        let cancelled = false
        fetch(`/api/dashboard/subagents/my-pricing?network=${encodeURIComponent(activeNetwork)}`, { cache: 'no-store' })
            .then(r => r.json())
            .then(j => {
                if (cancelled) return
                setSubAgentCostMap(j?.success && j.data ? j.data : {})
            })
            .catch(() => { if (!cancelled) setSubAgentCostMap({}) }) // fail closed — never a fabricated cost
        return () => { cancelled = true }
    }, [isSubAgentOwner, activeNetwork])

    // ─── Sub-agent's own resolved RC cost, per exam type ───────────────────────
    // Mirrors the data-package pattern above exactly: GET /api/results-checker/types
    // is already sub-agent-aware (Plan 4 Task 9) and returns the caller's own real
    // cost per type via `price`, with `configured` telling us whether that cost is
    // even usable. Absent-from-map or `configured !== true` both mean "not
    // purchasable for this sub" and must never fall back to a fabricated 0 or the
    // plain customer/agent tier price. Inert for every other role.
    const [rcSubAgentPricing, setRcSubAgentPricing] = useState<Record<string, { price: number; configured: boolean }>>({})

    useEffect(() => {
        if (!isSubAgentOwner) return
        let cancelled = false
        fetch('/api/results-checker/types', { cache: 'no-store' })
            .then(r => r.json())
            .then(j => {
                if (cancelled) return
                const map: Record<string, { price: number; configured: boolean }> = {}
                for (const t of (j?.types || [])) {
                    map[t.id] = { price: typeof t.price === 'number' ? t.price : 0, configured: t.configured === true }
                }
                setRcSubAgentPricing(map)
            })
            .catch(() => { if (!cancelled) setRcSubAgentPricing({}) }) // fail closed — empty map means nothing configured
        return () => { cancelled = true }
    }, [isSubAgentOwner])

    // ─── Sub-agent's own resolved AFA cost ─────────────────────────────────────
    // Mirrors the same pattern: GET /api/user/afa-price is already sub-agent-aware
    // (Plan 4 Task 8) and returns the caller's own real AFA cost via `price` when
    // `configured === true`. On any fetch failure or `configured === false`, AFA
    // must render as unavailable for this owner — never a fabricated 0 used as a
    // real cost floor. Inert for every other role (afaCost keeps its
    // resolveAfaPrice(role)-derived value from fetchData above).
    const [afaConfigured, setAfaConfigured] = useState(true)

    useEffect(() => {
        if (!isSubAgentOwner) return
        let cancelled = false
        fetch('/api/user/afa-price', { cache: 'no-store' })
            .then(r => r.json())
            .then(j => {
                if (cancelled) return
                if (j?.configured === true && typeof j.price === 'number') {
                    setAfaCost(j.price)
                    setAfaConfigured(true)
                } else {
                    setAfaConfigured(false)
                }
            })
            .catch(() => { if (!cancelled) setAfaConfigured(false) }) // fail closed — never assume priceable
        return () => { cancelled = true }
    }, [isSubAgentOwner])

    // ─── Network stock toggle ─────────────────────────────────────────────────
    const toggleShopNetworkStock = async (network: string, outOfStock: boolean) => {
        if (adminOOS[network]) return // locked: admin disabled it platform-wide
        setOosSaving(network)
        // Optimistic update
        setShopOOS(prev => outOfStock ? [...new Set([...prev, network])] : prev.filter(n => n !== network))
        try {
            const res = await fetch('/api/shop/network-stock', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ network, outOfStock }),
            })
            const json = await res.json()
            if (!res.ok || !json.success) throw new Error(json.error || 'Failed')
            setShopOOS(json.oosNetworks || [])
            toast.success(`${network} ${outOfStock ? 'marked Out of Stock' : 'back In Stock'} on your store`)
        } catch (e: any) {
            // Revert on failure
            setShopOOS(prev => outOfStock ? prev.filter(n => n !== network) : [...new Set([...prev, network])])
            toast.error(e.message || 'Failed to update')
        } finally {
            setOosSaving(null)
        }
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────
    const getCostPrice = (pkg: Package) => {
        if (dbUser?.role === 'subagent') {
            const resolved = subAgentCostMap[pkg.id]
            return resolved?.configured ? resolved.subPrice : pkg.price // fail closed to the plain customer price, never a fabricated 0
                                                                          // (note: the price ceiling is temporarily disabled -- see the
                                                                          // marker in lib/pricing/sub-agent-cost.ts -- so this is no
                                                                          // longer guaranteed to be the highest possible reference)
        }
        if (dbUser?.role === 'dealer' && pkg.dealer_price > 0) return pkg.dealer_price
        if (dbUser?.role === 'agent' && pkg.agent_price > 0) return pkg.agent_price
        return pkg.price
    }

    const getProfit = (pkg: Package, sellingStr: string) => {
        const selling = parseFloat(sellingStr)
        if (isNaN(selling)) return null
        return selling - getCostPrice(pkg)
    }

    const isValidPrice = (pkg: Package, sellingStr: string) => {
        const profit = getProfit(pkg, sellingStr)
        if (profit === null) return null
        const maxProfit = isFinite(dataMaxProfit) ? dataMaxProfit : 999
        return profit > 0 && profit <= maxProfit
    }

    const getMaxAirtimeProfit = (networkStr: string) => {
        const role = shop?.owner_role || 'customer'
        const key = `airtime_fee_${networkStr.toLowerCase()}_${role}`
        const adminFee = adminAirtimeFees[key] || 0
        return Math.max(0, 10 - adminFee)
    }

    const rcMaxMarkup = parseFloat(String(adminAirtimeFees['results_checker_max_markup_customer'] || '0'))

    // Parse data volume from size string (e.g. "1GB" → 1, "500MB" → 0.5, "1.5GB" → 1.5)
    const parseVolumeGB = (size: string): number | null => {
        const mb = size.match(/^([\d.]+)\s*MB$/i)
        if (mb) return parseFloat(mb[1]) / 1000
        const gb = size.match(/^([\d.]+)\s*GB$/i)
        if (gb) return parseFloat(gb[1])
        return null
    }

    const shopUrl = shop ? `https://shop.kingflexygh.com/${shop.shop_slug}` : ''

    const copyLink = async () => {
        await navigator.clipboard.writeText(shopUrl)
        setCopied(true)
        toast.success('Shop link copied!')
        setTimeout(() => setCopied(false), 2000)
    }

    // ─── Validation helpers ───────────────────────────────────────────────────
    const validateAirtime = (): boolean => {
        for (const net of ['mtn', 'telecel', 'at']) {
            const max = getMaxAirtimeProfit(net)
            const val = parseFloat(airtimeFees[net as keyof typeof airtimeFees] || '0')
            if (val > max) {
                toast.error(`${net.toUpperCase()} airtime profit exceeds maximum of ${max.toFixed(2)}%`)
                return false
            }
        }
        return true
    }

    const validateData = (): boolean => {
        const maxDataProfitCap = isFinite(dataMaxProfit) ? dataMaxProfit : null
        let invalidReason = ''
        const invalid = packages.filter(pkg => {
            const val = pricing[pkg.id]
            if (!val || parseFloat(val) <= 0) return false
            const profit = getProfit(pkg, val)
            if (profit === null) return false
            if (profit <= 0) { invalidReason = 'Profit must be more than 0'; return true }
            if (maxDataProfitCap !== null && profit > maxDataProfitCap) {
                invalidReason = `Profit cannot exceed GHS ${maxDataProfitCap.toFixed(2)}`
                return true
            }
            return false
        })
        if (invalid.length > 0) {
            toast.error(`${invalidReason} for: ${invalid.map(p => `${p.network} ${p.size}`).join(', ')}`)
            return false
        }
        return true
    }

    const buildDataRows = () => packages
        .filter(pkg => pricing[pkg.id] && parseFloat(pricing[pkg.id]) > 0)
        .map(pkg => ({
            shop_id: shop!.id,
            package_id: pkg.id,
            profit_margin: getProfit(pkg, pricing[pkg.id]),
            selling_price: parseFloat(pricing[pkg.id])
        }))

    const buildRcMarkupRows = () => examTypes
        .filter(e => rcMarkups[e.id] !== undefined && rcMarkups[e.id] !== '')
        .map(e => ({ exam_type_id: e.id, markup: parseFloat(rcMarkups[e.id]) || 0 }))

    const postPricing = async (payload: Record<string, any>) => {
        const res = await fetch('/api/shop/pricing', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ shopId: shop!.id, ...payload })
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'Failed to save pricing')
        return data
    }

    const markLive = () => {
        const wasLive = shop?.pricing_status === 'approved'
        setShop(prev => prev ? { ...prev, pricing_status: 'approved', approval_status: 'approved' } : null)
        if (!wasLive || fromSetup) {
            setShowLiveModal(true)
            setFromSetup(false)
        }
    }

    // ─── Per-section saves ────────────────────────────────────────────────────
    const handleSaveSection = async (section: Section) => {
        if (!shop) return
        setSavingSection(section)
        try {
            if (section === 'data') {
                if (!validateData()) return
                const rows = buildDataRows()
                if (rows.length === 0) { toast.error('Set at least one bundle price first'); return }
                await postPricing({ items: rows })
                toast.success('Data bundle prices saved!')
                markLive()
            } else if (section === 'airtime') {
                if (!validateAirtime()) return
                await postPricing({ airtimeFees })
                toast.success('Airtime profit settings live!')
            } else if (section === 'rc') {
                await postPricing({ rcMarkups: buildRcMarkupRows() })
                toast.success('Exam markups saved!')
            } else if (section === 'mashup') {
                await postPricing({ mashupFee: mashupFee || '0' })
                toast.success('Mashup profit saved!')
            } else if (section === 'afa') {
                if (afaSellingPrice !== '') {
                    const profit = parseFloat(afaSellingPrice) - afaCost
                    if (isNaN(profit) || profit <= 0) {
                        toast.error(`Selling price must be more than your cost of GHS ${afaCost.toFixed(2)}`)
                        return
                    }
                }
                // Send '' through untouched (never coerced to '0') so clearing the
                // field actually turns AFA off instead of leaving the old price live.
                await postPricing({ afaSellingPrice })
                toast.success(afaSellingPrice === ''
                    ? 'AFA registration turned off for your shop.'
                    : 'AFA settings saved — now live on your storefront!')
            }
        } catch (err: any) {
            toast.error(err.message || 'Failed to save')
        } finally {
            setSavingSection(null)
        }
    }

    // ─── Global save ──────────────────────────────────────────────────────────
    const handleSubmitAll = async () => {
        if (!shop) return
        if (!validateData() || !validateAirtime()) return
        if (afaSellingPrice !== '') {
            const profit = parseFloat(afaSellingPrice) - afaCost
            if (isNaN(profit) || profit <= 0) {
                toast.error(`AFA selling price must be more than your cost of GHS ${afaCost.toFixed(2)}`)
                return
            }
        }

        const rows = buildDataRows()
        if (rows.length === 0 && !airtimeFees.mtn && !airtimeFees.telecel && !airtimeFees.at) {
            toast.error('Please configure a price to save changes')
            return
        }

        setSaving(true)
        try {
            await postPricing({
                items: rows,
                airtimeFees,
                rcMarkups: buildRcMarkupRows(),
                mashupFee: mashupFee || undefined,
                // Raw string (including '') — NOT `afaSellingPrice || undefined`. An
                // empty string must mean "turn AFA off" (the API route maps '' ->
                // null), not "leave unchanged". Coercing to undefined here would
                // silently discard whatever the owner typed in the AFA tab on a bulk save.
                afaSellingPrice,
            })
            toast.success('Your shop is now live! Customers can start buying.')
            markLive()
        } catch (err: any) {
            toast.error(err.message || 'Failed to submit pricing')
        } finally {
            setSaving(false)
        }
    }

    const handleSavePkg = async (pkgId: string) => {
        if (!shop || savingPkg) return
        const valStr = pricing[pkgId]
        const pkg = packages.find(p => p.id === pkgId)
        if (!pkg) return
        if (!valStr || parseFloat(valStr) <= 0) { toast.error('Enter a selling price first'); return }
        const valid = isValidPrice(pkg, valStr)
        if (!valid) {
            const profit = getProfit(pkg, valStr)
            toast.error(profit !== null && profit <= 0 ? 'Price must be above your cost' : `Max profit GHS ${isFinite(dataMaxProfit) ? dataMaxProfit.toFixed(2) : '∞'}`)
            return
        }
        setSavingPkg(pkgId)
        try {
            const rows = buildDataRows()
            if (rows.length === 0) { toast.error('No valid prices to save'); return }
            await postPricing({ items: rows })
            toast.success(`${pkg.network} ${pkg.size} saved!`)
            markLive()
        } catch (err: any) {
            toast.error(err.message || 'Failed to save')
        } finally {
            setSavingPkg(null)
        }
    }

    const handleAcknowledge = async () => {
        if (!shop) return
        setAcknowledging(true)
        try {
            const { error } = await (supabase as any).from('shop_profiles').update({
                pricing_rejection_acknowledged: true,
                updated_at: new Date().toISOString(),
            }).eq('id', shop.id)
            if (error) throw error
            setShop(prev => prev ? { ...prev, pricing_rejection_acknowledged: true } : null)
        } catch (err: any) {
            toast.error(err.message || 'Failed to acknowledge')
        } finally {
            setAcknowledging(false)
        }
    }

    // ─── Bulk apply with live preview ─────────────────────────────────────────
    // NOTE: subAgentCostMap is fetched keyed by activeNetwork (the Manual-grid
    // network), not bulkApplyTarget, so it cannot be safely used to gate this
    // list without risking a stale/wrong-network filter — the manual grid
    // (filteredPackages above) is the one place Step 3 requires the gate, and a
    // sub-agent's cost floor is still enforced by getCostPrice()/isValidPrice()
    // wherever bulk-computed prices get applied.
    const bulkTargets = packages.filter(pkg => pkg.is_available && pkg.network === bulkApplyTarget)

    const bulkComputeSelling = (pkg: Package): number | null => {
        const v = parseFloat(bulkValue)
        if (isNaN(v) || v <= 0) return null
        if (bulkMode === 'flat') {
            // flat rate = GHS per GB; selling price = rate × volume
            const vol = parseVolumeGB(pkg.size)
            if (vol === null || vol <= 0) return null
            return parseFloat((v * vol).toFixed(2))
        }
        // percent = cost × (1 + v/100)
        const cost = getCostPrice(pkg)
        return parseFloat((cost * (1 + v / 100)).toFixed(2))
    }

    // One row per candidate package, carrying its own policy verdict. A row with a
    // `warning` is never applied — mirroring the admin BulkPricingTab, a policy
    // violation skips just that package instead of blocking the whole batch.
    interface BulkPreviewRow {
        pkg: Package
        cost: number
        selling: number | null
        profit: number | null
        warning: string | null
    }

    const bulkPreviewRows: BulkPreviewRow[] = bulkTargets.map(pkg => {
        const cost = getCostPrice(pkg)
        const selling = bulkComputeSelling(pkg)
        if (selling === null) {
            return { pkg, cost, selling: null, profit: null, warning: null }
        }
        const profit = selling - cost
        const maxProfit = isFinite(dataMaxProfit) ? dataMaxProfit : 999
        let warning: string | null = null
        if (profit <= 0) warning = 'Below cost price'
        else if (profit > maxProfit) warning = `Exceeds max profit (GHS ${maxProfit.toFixed(2)})`
        return { pkg, cost, selling, profit, warning }
    })

    const bulkSelectableRows = bulkPreviewRows.filter(r => r.warning === null && r.selling !== null)
    const bulkExcludedCount = bulkSelectableRows.filter(r => bulkExcludedIds.has(r.pkg.id)).length
    const bulkApplicableRows = bulkSelectableRows.filter(r => !bulkExcludedIds.has(r.pkg.id))
    const bulkWarningRows = bulkPreviewRows.filter(r => r.warning !== null)
    const bulkAllSelected = bulkSelectableRows.length > 0 && bulkExcludedCount === 0
    const bulkSomeSelected = bulkExcludedCount < bulkSelectableRows.length

    const toggleBulkRow = (id: string) => {
        setBulkExcludedIds(prev => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })
    }
    const toggleBulkAll = () => {
        setBulkExcludedIds(bulkAllSelected ? new Set(bulkSelectableRows.map(r => r.pkg.id)) : new Set())
    }

    const handleApplyBulk = () => {
        const v = parseFloat(bulkValue)
        if (isNaN(v) || v <= 0) { toast.error('Enter a value greater than 0'); return }
        if (bulkApplicableRows.length === 0) { toast.error('No packages to apply to — check your selections above'); return }
        const newPricing: Record<string, string> = { ...pricing }
        bulkApplicableRows.forEach(({ pkg, selling }) => {
            if (selling !== null) newPricing[pkg.id] = selling.toFixed(2)
        })
        setPricing(newPricing)
        setBulkExcludedIds(new Set())
        toast.success(`Applied to ${bulkApplicableRows.length} package(s) — review and save when ready`)
    }

    // ─── Render guards ────────────────────────────────────────────────────────
    if (loading) {
        return (
            <div className="flex items-center justify-center py-20">
                <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
        )
    }

    if (shop?.approval_status !== 'approved') {
        return (
            <div className="flex flex-col items-center justify-center py-20 text-center space-y-4">
                <div className="w-16 h-16 rounded-full bg-yellow-100 dark:bg-yellow-900/30 flex items-center justify-center">
                    <Clock className="w-8 h-8 text-yellow-600" />
                </div>
                <h2 className="text-xl font-bold">Awaiting Profile Approval</h2>
                <p className="text-muted-foreground text-sm max-w-sm">
                    Your shop profile is being reviewed by an admin. You'll be able to set your prices once your profile is approved.
                </p>
            </div>
        )
    }

    if (shop?.pricing_status === 'rejected' && !shop?.pricing_rejection_acknowledged) {
        return (
            <div className="max-w-lg mx-auto py-10 space-y-4">
                <Card className="border-red-200 dark:border-red-800">
                    <CardContent className="p-6 space-y-4">
                        <div className="flex items-center gap-3">
                            <div className="w-12 h-12 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center flex-shrink-0">
                                <XCircle className="w-6 h-6 text-red-600" />
                            </div>
                            <div>
                                <h2 className="font-bold text-lg">Pricing Rejected</h2>
                                <p className="text-sm text-muted-foreground">Admin has reviewed and rejected your submitted prices.</p>
                            </div>
                        </div>

                        {shop.pricing_note && (
                            <div className="p-4 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
                                <p className="text-xs font-semibold text-red-700 dark:text-red-400 mb-1">Admin Note:</p>
                                <p className="text-sm text-red-800 dark:text-red-300">{shop.pricing_note}</p>
                            </div>
                        )}

                        <p className="text-sm text-muted-foreground">
                            Please read the admin's feedback above, then click below to revise your prices.
                        </p>

                        <Button
                            onClick={handleAcknowledge}
                            disabled={acknowledging}
                            className="w-full bg-emerald-600 hover:bg-emerald-700 text-white gap-2 h-12"
                        >
                            {acknowledging ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                            I Understand, Let Me Revise
                        </Button>
                    </CardContent>
                </Card>
            </div>
        )
    }

    const filteredPackages = isSubAgentOwner
        ? filterPackagesForSubAgent(packages.filter(p => p.network === activeNetwork), subAgentCostMap)
        : packages.filter(p => p.network === activeNetwork)
    const isResubmission = shop?.pricing_status === 'approved'
    const ownerIsReseller = shop?.owner_role === 'agent' || shop?.owner_role === 'dealer'

    return (
        <div className="space-y-5 pb-32 max-w-6xl mx-auto px-4 md:px-6 mt-4">
            {/* ── Header ── */}
            <div className="flex flex-col gap-3">
                <Link href="/dashboard/shop">
                    <Button variant="ghost" size="sm" className="w-fit gap-2 -ml-2 text-muted-foreground hover:text-emerald-600 transition-colors">
                        <ArrowLeft className="w-4 h-4" />
                        Back to Shop Dashboard
                    </Button>
                </Link>
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                    <div>
                        <h1 className="text-xl font-bold flex items-center gap-2">
                            <Tag className="w-5 h-5 text-emerald-600" />
                            Pricing
                        </h1>
                        <p className="text-muted-foreground text-sm mt-0.5">
                            Set your profit on each service. Save sections individually or everything at once.
                        </p>
                    </div>
                    <Button
                        onClick={handleSubmitAll}
                        disabled={saving}
                        className="hidden sm:flex bg-emerald-600 hover:bg-emerald-700 text-white gap-2 h-10 px-5 rounded-xl font-semibold"
                    >
                        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                        {saving ? 'Saving...' : 'Save All & Go Live'}
                    </Button>
                </div>

                {isResubmission && (
                    <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 flex gap-2.5 text-xs text-amber-700 dark:text-amber-300">
                        <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5 text-amber-500" />
                        <span>
                            <strong>Heads up!</strong> New prices go live automatically, but admins reserve the right to review and reject them later.
                        </span>
                    </div>
                )}
            </div>

            {/* ── Section Tabs ── */}
            <div className="flex p-1 bg-muted rounded-xl border shadow-sm overflow-x-auto">
                {SECTIONS.map(({ id, label, icon: Icon }) => (
                    <button
                        key={id}
                        onClick={() => setActiveSection(id)}
                        className={cn(
                            'flex-1 px-3 sm:px-5 py-2 text-xs sm:text-sm font-semibold rounded-lg transition-all flex items-center justify-center gap-1.5 whitespace-nowrap',
                            activeSection === id ? 'bg-white dark:bg-gray-800 shadow-sm text-emerald-600' : 'text-muted-foreground hover:text-foreground'
                        )}
                    >
                        <Icon className="w-4 h-4" />
                        {label}
                    </button>
                ))}
            </div>

            {/* ════════════ DATA BUNDLES ════════════ */}
            {activeSection === 'data' && (
                <div className="space-y-5">
                <Tabs value={pricingMode} onValueChange={(v) => setPricingMode(v as 'manual' | 'bulk')}>
                    <TabsList className="grid grid-cols-2 w-full sm:w-64">
                        <TabsTrigger value="manual">Manual</TabsTrigger>
                        <TabsTrigger value="bulk">Bulk</TabsTrigger>
                    </TabsList>

                    {/* NOTE: the Bulk panel is declared first here purely because that's
                        where it already lived — TabsList above fixes the visible order
                        (Manual, Bulk) and only the active panel ever renders. */}
                    <TabsContent value="bulk" className="pt-4">
                    {/* Bulk apply with live preview */}
                    <div className="rounded-2xl border border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-900/10 p-4 sm:p-5 space-y-4">
                        <div className="flex items-center justify-between gap-3 flex-wrap">
                            <div className="flex items-center gap-2">
                                <TrendingUp className="w-4 h-4 text-blue-600" />
                                <h2 className="text-sm font-bold text-blue-900 dark:text-blue-300">Bulk Pricing</h2>
                            </div>
                            {/* Mode tabs */}
                            <div className="flex p-0.5 bg-white dark:bg-gray-900 rounded-lg border">
                                {([
                                    { id: 'flat', label: 'Rate per GB (GHS)' },
                                    { id: 'percent', label: 'Margin (%)' },
                                ] as const).map(m => (
                                    <button
                                        key={m.id}
                                        onClick={() => { setBulkMode(m.id); setBulkValue('') }}
                                        className={cn(
                                            'px-3 py-1.5 text-[11px] font-semibold rounded-md transition-all',
                                            bulkMode === m.id ? 'bg-blue-600 text-white shadow-sm' : 'text-muted-foreground hover:text-foreground'
                                        )}
                                    >
                                        {m.label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <p className="text-xs text-blue-700/80 dark:text-blue-400/80">
                            {bulkMode === 'flat'
                                ? 'Sets a selling price per GB — e.g. typing 5 means 1GB → GHS 5.00, 2GB → GHS 10.00, 500MB → GHS 2.50. Profit is calculated automatically.'
                                : 'Adds a percentage of your cost as profit (e.g. cost + 5%). Bigger bundles earn more.'}
                        </p>

                        <div className="flex flex-col sm:flex-row gap-2.5">
                            <div className="sm:w-44">
                                <Select value={bulkApplyTarget} onValueChange={setBulkApplyTarget}>
                                    <SelectTrigger className="h-10 rounded-lg bg-white dark:bg-gray-900 font-semibold text-sm">
                                        <SelectValue placeholder="Select Network" />
                                    </SelectTrigger>
                                    <SelectContent className="rounded-lg">
                                        {NETWORKS.map(net => (
                                            <SelectItem key={net} value={net}>{net}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="relative flex-1">
                                <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground text-xs font-semibold">
                                    {bulkMode === 'flat' ? 'GHS/GB' : '%'}
                                </span>
                                <Input
                                    type="number" min="0.01" step={bulkMode === 'flat' ? '0.5' : '0.1'} value={bulkValue}
                                    onChange={(e) => setBulkValue(e.target.value)}
                                    className={cn('h-10 rounded-lg bg-white dark:bg-gray-900 font-semibold', bulkMode === 'flat' ? 'pl-16' : 'pl-12')}
                                />
                            </div>
                        </div>

                        {bulkTargets.length === 0 ? (
                            <p className="text-sm text-muted-foreground">No packages found for {bulkApplyTarget}.</p>
                        ) : (
                            <div className="rounded-xl border bg-white dark:bg-gray-900 overflow-x-auto">
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead className="w-10">
                                                <Checkbox
                                                    checked={bulkAllSelected ? true : bulkSomeSelected ? 'indeterminate' : false}
                                                    onCheckedChange={toggleBulkAll}
                                                    aria-label="Select all packages"
                                                />
                                            </TableHead>
                                            <TableHead>Size</TableHead>
                                            <TableHead>Cost</TableHead>
                                            <TableHead>Current selling</TableHead>
                                            <TableHead>New selling</TableHead>
                                            <TableHead>New profit</TableHead>
                                            <TableHead>Status</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {bulkPreviewRows.map(({ pkg, cost, selling, profit, warning }) => {
                                            const isExcluded = !warning && bulkExcludedIds.has(pkg.id)
                                            const currentSelling = parseFloat(pricing[pkg.id] || '0') || null
                                            return (
                                                <TableRow key={pkg.id} className={warning || isExcluded ? 'opacity-60' : ''}>
                                                    <TableCell>
                                                        {!warning && selling !== null && (
                                                            <Checkbox
                                                                checked={!isExcluded}
                                                                onCheckedChange={() => toggleBulkRow(pkg.id)}
                                                                aria-label={`Include ${pkg.size} in bulk pricing`}
                                                            />
                                                        )}
                                                    </TableCell>
                                                    <TableCell className="font-semibold">{pkg.size}</TableCell>
                                                    <TableCell>{formatCurrency(cost)}</TableCell>
                                                    <TableCell>{currentSelling !== null ? formatCurrency(currentSelling) : <span className="text-muted-foreground text-xs">not set</span>}</TableCell>
                                                    <TableCell>{selling !== null ? formatCurrency(selling) : <span className="text-muted-foreground text-xs">—</span>}</TableCell>
                                                    <TableCell className={cn('font-semibold tabular-nums', warning ? 'text-red-600' : 'text-emerald-600')}>
                                                        {profit !== null ? formatCurrency(profit) : '—'}
                                                    </TableCell>
                                                    <TableCell>
                                                        {warning ? (
                                                            <Badge variant="outline" className="gap-1 text-amber-600 border-amber-300 bg-amber-50 dark:bg-amber-950">
                                                                <AlertCircle className="w-3 h-3" /> {warning}
                                                            </Badge>
                                                        ) : isExcluded ? (
                                                            <Badge variant="outline" className="gap-1 text-muted-foreground">Excluded</Badge>
                                                        ) : selling !== null ? (
                                                            <Badge variant="outline" className="gap-1 text-green-600 border-green-300 bg-green-50 dark:bg-green-950">
                                                                <CheckCircle2 className="w-3 h-3" /> Will update
                                                            </Badge>
                                                        ) : (
                                                            <span className="text-muted-foreground text-xs">Enter a value above</span>
                                                        )}
                                                    </TableCell>
                                                </TableRow>
                                            )
                                        })}
                                    </TableBody>
                                </Table>
                            </div>
                        )}

                        {parseFloat(bulkValue) > 0 && bulkPreviewRows.length > 0 && (
                            <div className="flex items-center justify-between pt-2 border-t border-blue-100 dark:border-blue-900">
                                <div className="text-xs text-muted-foreground space-y-0.5">
                                    <p><span className="font-medium text-foreground">{bulkApplicableRows.length}</span> package(s) will be updated</p>
                                    {bulkExcludedCount > 0 && <p>{bulkExcludedCount} excluded by you</p>}
                                    {bulkWarningRows.length > 0 && (
                                        <p className="text-amber-600 flex items-center gap-1">
                                            <AlertCircle className="w-3 h-3" /> {bulkWarningRows.length} skipped (see warnings above)
                                        </p>
                                    )}
                                </div>
                                <Button
                                    onClick={handleApplyBulk}
                                    disabled={bulkApplicableRows.length === 0}
                                    className="bg-blue-600 hover:bg-blue-700 text-white px-5 rounded-lg h-10 font-semibold text-sm shrink-0"
                                >
                                    Apply to {bulkApplicableRows.length}
                                </Button>
                            </div>
                        )}
                    </div>
                    </TabsContent>

                    <TabsContent value="manual" className="space-y-5 pt-4">
                    {/* Pricing guide — compact */}
                    <div className="flex gap-2.5 items-start p-3.5 rounded-xl bg-emerald-50/70 dark:bg-emerald-900/10 border border-emerald-100 dark:border-emerald-900 text-xs text-emerald-800 dark:text-emerald-300">
                        <Lightbulb className="w-4 h-4 flex-shrink-0 mt-0.5 text-emerald-500" />
                        <p>
                            Your cost is what you pay us; your profit is what you add on top.
                            Example: cost GHS 10 + GHS {ownerIsReseller ? '3' : '2'} profit = customer pays GHS {ownerIsReseller ? '13' : '12'}.
                            {' '}Max profit per bundle: <strong>GHS {isFinite(dataMaxProfit) ? dataMaxProfit.toFixed(2) : 'no limit'}</strong>. You cannot sell below cost.
                        </p>
                    </div>

                    {/* Network tabs — 2×2 on mobile, 4-col on sm+ */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                        {NETWORKS.map(network => {
                            const count = packages.filter(p => p.network === network).length
                            if (count === 0) return null
                            const isActiveTab = activeNetwork === network
                            const colors = networkTabColors[network] ?? {
                                active: 'bg-slate-900 text-white border-slate-900 shadow-md',
                                inactive: 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-500 hover:bg-slate-50',
                            }
                            return (
                                <button
                                    key={network}
                                    onClick={() => setActiveNetwork(network)}
                                    className={cn(
                                        'flex items-center justify-between h-10 px-3 rounded-xl text-xs font-semibold transition-all border w-full',
                                        isActiveTab ? colors.active : colors.inactive
                                    )}
                                >
                                    <span>{network}</span>
                                    <span className={cn('px-1.5 py-0.5 rounded-md text-[10px] font-bold', isActiveTab ? 'bg-black/10 dark:bg-white/20' : 'bg-black/5 dark:bg-white/10')}>
                                        {count}
                                    </span>
                                </button>
                            )
                        })}
                    </div>

                    {/* Out-of-stock control for the active network */}
                    {(() => {
                        const lockedByAdmin = !!adminOOS[activeNetwork]
                        const isOut = lockedByAdmin || shopOOS.includes(activeNetwork)
                        return (
                            <div className="flex items-center justify-between rounded-xl border border-slate-200 dark:border-slate-800 px-3 py-2 mb-3 bg-white/60 dark:bg-slate-900/50">
                                <div className="flex flex-col">
                                    <span className="text-xs font-semibold">
                                        {activeNetwork}: {isOut ? 'Out of Stock at the Moment' : 'In Stock'}
                                    </span>
                                    {lockedByAdmin && (
                                        <span className="text-[10px] text-amber-600">
                                            Temporarily unavailable platform-wide — set by KiNG FLEXY
                                        </span>
                                    )}
                                </div>
                                <Switch
                                    checked={isOut}
                                    disabled={lockedByAdmin || oosSaving === activeNetwork}
                                    onCheckedChange={(v) => toggleShopNetworkStock(activeNetwork, v)}
                                    aria-label={`Toggle ${activeNetwork} out of stock on your store`}
                                />
                            </div>
                        )
                    })()}

                    {/* Package grid — 2-col on mobile */}
                    <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2.5">
                        {filteredPackages.map((pkg) => {
                            const valStr = pricing[pkg.id] || ''
                            const cost = getCostPrice(pkg)
                            const finalSelling = parseFloat(valStr) || 0
                            const profit = finalSelling > 0 ? finalSelling - cost : 0
                            const valid = isValidPrice(pkg, valStr)
                            const isSavingThis = savingPkg === pkg.id

                            return (
                                <div key={pkg.id} className={cn(
                                    'flex flex-col p-3 rounded-xl border transition-all',
                                    valStr && valid === false ? 'border-red-400 bg-red-50/50 dark:border-red-900/40' :
                                        valStr && valid === true ? 'border-emerald-300 bg-white dark:bg-slate-900 shadow-sm' : 'border-slate-200 dark:border-slate-800 bg-white/60 dark:bg-slate-900/50'
                                )}>
                                    {/* Header */}
                                    <div className="flex items-start justify-between mb-2 gap-1">
                                        <h3 className="font-bold text-sm leading-tight">{pkg.size}</h3>
                                        <span className="text-[10px] font-medium text-slate-500 bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded-md shrink-0">
                                            Cost: {formatCurrency(cost)}
                                        </span>
                                    </div>

                                    {/* Price input */}
                                    <div className="relative mb-2">
                                        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 font-semibold text-[11px] text-slate-400">GHS</span>
                                        <Input
                                            type="number" inputMode="decimal" value={valStr}
                                            onChange={(e) => setPricing(prev => ({ ...prev, [pkg.id]: e.target.value }))}
                                            placeholder={cost.toFixed(2)}
                                            className={cn(
                                                'h-9 rounded-lg pl-10 text-sm font-semibold',
                                                valStr && valid === false ? 'border-red-500 bg-red-50 text-red-900' :
                                                    valStr && valid === true ? 'border-emerald-500 bg-emerald-50 text-emerald-900 dark:bg-emerald-900/20 dark:text-emerald-100' : 'bg-slate-50 dark:bg-slate-800'
                                            )}
                                        />
                                    </div>

                                    {/* Profit row */}
                                    <div className="flex items-center justify-between text-xs mb-2">
                                        <span className="text-slate-400 font-medium">Profit</span>
                                        <span className={cn('font-semibold tabular-nums', valid === true ? 'text-emerald-600' : valid === false ? 'text-red-500' : 'text-slate-400')}>
                                            {valStr && valid !== null ? `+${formatCurrency(profit)}` : '—'}
                                        </span>
                                    </div>
                                    {valStr && valid === false && (
                                        <p className="text-[10px] text-red-600 font-semibold mb-2">
                                            {profit <= 0 ? 'Must be above cost' : `Max GHS ${isFinite(dataMaxProfit) ? dataMaxProfit.toFixed(2) : '∞'}`}
                                        </p>
                                    )}

                                    {/* Per-card save */}
                                    <button
                                        onClick={() => handleSavePkg(pkg.id)}
                                        disabled={!!savingPkg || !valStr}
                                        className={cn(
                                            'mt-auto flex items-center justify-center gap-1 h-7 rounded-lg text-[11px] font-semibold transition-all border',
                                            valid === true
                                                ? 'bg-emerald-600 hover:bg-emerald-700 text-white border-emerald-600 disabled:opacity-50'
                                                : 'bg-slate-100 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-400 cursor-not-allowed'
                                        )}
                                    >
                                        {isSavingThis
                                            ? <Loader2 className="w-3 h-3 animate-spin" />
                                            : <Save className="w-3 h-3" />}
                                        {isSavingThis ? 'Saving…' : 'Save'}
                                    </button>
                                </div>
                            )
                        })}
                    </div>

                    {/* Section save */}
                    <Button
                        onClick={() => handleSaveSection('data')}
                        disabled={savingSection === 'data'}
                        className="w-full sm:w-auto bg-slate-900 dark:bg-white text-white dark:text-slate-900 hover:bg-black h-11 px-6 rounded-xl font-semibold gap-2"
                    >
                        {savingSection === 'data' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                        Save Data Prices
                    </Button>
                    </TabsContent>
                </Tabs>
                </div>
            )}

            {/* ════════════ AIRTIME ════════════ */}
            {activeSection === 'airtime' && (
                <div className="space-y-4">
                    <div className="flex gap-2.5 items-start p-3.5 rounded-xl bg-indigo-50/70 dark:bg-indigo-900/10 border border-indigo-100 dark:border-indigo-900 text-xs text-indigo-800 dark:text-indigo-300">
                        <Lightbulb className="w-4 h-4 flex-shrink-0 mt-0.5 text-indigo-500" />
                        <p>
                            By default airtime profit is zero — you earn nothing until you set a markup below.
                            The combined total fee (network cost + your markup) is capped at 10%.
                        </p>
                    </div>

                    <div className="bg-white dark:bg-slate-900 rounded-2xl border shadow-sm overflow-hidden divide-y divide-slate-100 dark:divide-slate-800/60">
                        {AIRTIME_NETWORKS.map(net => {
                            const key = net.toLowerCase() as keyof typeof airtimeFees
                            const maxAllowed = getMaxAirtimeProfit(net)
                            const val = parseFloat(airtimeFees[key] || '0')
                            const isOverLimit = val > maxAllowed

                            return (
                                <div key={net} className={cn(
                                    'p-4 flex flex-col sm:flex-row sm:items-center gap-3',
                                    isOverLimit ? 'bg-red-50/50 dark:bg-red-900/10' : ''
                                )}>
                                    <div className="flex items-center justify-between sm:w-36 shrink-0">
                                        <Badge variant="outline" className={cn('px-2.5 py-0.5 font-semibold text-xs', networkColors[net] || networkColors['MTN'])}>{net}</Badge>
                                        <div className="sm:hidden text-right">
                                            <p className="text-[10px] text-slate-400 font-medium">Max markup</p>
                                            <p className="font-semibold text-sm">{maxAllowed.toFixed(2)}%</p>
                                        </div>
                                    </div>

                                    <div className="hidden sm:flex flex-1 items-center justify-center gap-8 text-center">
                                        <div>
                                            <p className="text-[10px] text-slate-400 font-medium">Network cost</p>
                                            <p className="font-semibold text-sm text-slate-500">{(10 - maxAllowed).toFixed(2)}%</p>
                                        </div>
                                        <div className="w-px h-6 bg-slate-200 dark:bg-slate-700" />
                                        <div>
                                            <p className="text-[10px] text-slate-400 font-medium">Max markup</p>
                                            <p className="font-semibold text-sm">{maxAllowed.toFixed(2)}%</p>
                                        </div>
                                    </div>

                                    <div className="relative w-full sm:w-32 shrink-0">
                                        <Input
                                            type="number"
                                            value={airtimeFees[key]}
                                            onChange={e => setAirtimeFees(s => ({ ...s, [key]: e.target.value }))}
                                            className={cn(
                                                'rounded-lg h-10 pr-7 text-sm font-semibold text-center',
                                                isOverLimit ? 'text-red-600 border-red-300 ring-1 ring-red-200' : 'bg-slate-50 dark:bg-slate-950'
                                            )}
                                            min="0" max={maxAllowed} step="0.1" placeholder="0.0"
                                        />
                                        <span className={cn('absolute right-3 top-1/2 -translate-y-1/2 font-semibold text-xs', isOverLimit ? 'text-red-500' : 'text-slate-400')}>%</span>
                                    </div>
                                </div>
                            )
                        })}
                    </div>

                    <Button
                        onClick={() => handleSaveSection('airtime')}
                        disabled={savingSection === 'airtime'}
                        className="w-full sm:w-auto bg-indigo-600 hover:bg-indigo-700 text-white h-11 px-6 rounded-xl font-semibold gap-2"
                    >
                        {savingSection === 'airtime' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                        Save Airtime Profit
                    </Button>
                </div>
            )}

            {/* ════════════ RESULTS CHECKER ════════════ */}
            {activeSection === 'rc' && (
                <div className="space-y-4">
                    <div className="flex gap-2.5 items-start p-3.5 rounded-xl bg-emerald-50/70 dark:bg-emerald-900/10 border border-emerald-100 dark:border-emerald-900 text-xs text-emerald-800 dark:text-emerald-300">
                        <Lightbulb className="w-4 h-4 flex-shrink-0 mt-0.5 text-emerald-500" />
                        <p>
                            Set a separate profit for <strong>each exam type</strong>. Your profit is added to the voucher base price.
                            {rcMaxMarkup > 0 && <> Max markup per voucher: <strong>GHS {rcMaxMarkup.toFixed(2)}</strong>.</>}
                        </p>
                    </div>

                    {examTypes.length === 0 ? (
                        <div className="text-center py-12 text-muted-foreground text-sm">No exam types available right now.</div>
                    ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                            {examTypes.map(exam => {
                                const subInfo = isSubAgentOwner ? rcSubAgentPricing[exam.id] : undefined
                                const notConfigured = isSubAgentOwner && !subInfo?.configured
                                const cost = isSubAgentOwner
                                    ? (subInfo?.configured ? subInfo.price : 0)
                                    : (ownerIsReseller ? exam.agent_price : exam.customer_price)
                                const markupStr = rcMarkups[exam.id] ?? ''
                                const markup = parseFloat(markupStr) || 0
                                const over = rcMaxMarkup > 0 && markup > rcMaxMarkup
                                const sellPrice = cost + (over ? rcMaxMarkup : markup)

                                return (
                                    <div key={exam.id} className={cn(
                                        'relative bg-white dark:bg-slate-900 rounded-xl border p-4 shadow-sm space-y-3',
                                        notConfigured && 'opacity-60'
                                    )}>
                                        <div className="flex items-center justify-between">
                                            <h4 className="font-bold text-sm">{exam.name}</h4>
                                            {!notConfigured && (
                                                <span className="text-[11px] font-medium text-slate-500 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded-md">
                                                    Cost {formatCurrency(cost)}
                                                </span>
                                            )}
                                        </div>

                                        <div className="relative">
                                            <span className="absolute left-3 top-1/2 -translate-y-1/2 font-semibold text-xs text-slate-400">GHS</span>
                                            <Input
                                                type="number" step="0.5" min="0" placeholder="0.00"
                                                value={markupStr}
                                                disabled={notConfigured}
                                                onChange={e => setRcMarkups(prev => ({ ...prev, [exam.id]: e.target.value }))}
                                                className={cn(
                                                    'h-10 rounded-lg pl-11 text-sm font-semibold bg-slate-50 dark:bg-slate-950',
                                                    over && 'border-red-400 text-red-600 ring-1 ring-red-200'
                                                )}
                                            />
                                        </div>
                                        {notConfigured && (
                                            <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-white/60 dark:bg-black/50">
                                                <span className="bg-amber-600 dark:bg-amber-700 text-white text-[8px] font-bold px-2 py-1 rounded-md uppercase tracking-wider shadow">Not available</span>
                                            </div>
                                        )}
                                        {over && (
                                            <p className="text-[10px] text-red-600 font-semibold flex items-center gap-1">
                                                <AlertCircle className="w-3 h-3" /> Clamped to GHS {rcMaxMarkup.toFixed(2)} on save
                                            </p>
                                        )}

                                        <div className="bg-slate-50 dark:bg-slate-800/50 rounded-lg p-3 space-y-1.5 text-xs">
                                            <div className="flex items-center justify-between">
                                                <span className="text-slate-400 font-medium">Sells for</span>
                                                <span className="font-bold text-emerald-600 tabular-nums">{formatCurrency(sellPrice)}</span>
                                            </div>
                                            <div className="flex items-center justify-between">
                                                <span className="text-slate-400 font-medium">Your profit</span>
                                                <span className="font-semibold text-emerald-500 tabular-nums">+{formatCurrency(over ? rcMaxMarkup : markup)}</span>
                                            </div>
                                        </div>

                                        {exam.bulk_pricing && exam.bulk_pricing.length > 0 && (
                                            <div className="space-y-1 pt-1 border-t border-slate-100 dark:border-slate-800">
                                                <p className="text-[10px] font-semibold text-slate-400">Bulk tiers (your profit applies per voucher)</p>
                                                {exam.bulk_pricing.map((tier, idx) => (
                                                    <div key={idx} className="flex items-center justify-between text-[11px]">
                                                        <span className="text-slate-500">
                                                            {tier.min_qty}{tier.max_qty >= 99999 ? '+' : `–${tier.max_qty}`} pcs
                                                        </span>
                                                        <span className="font-semibold text-emerald-600 tabular-nums">{formatCurrency(tier.unit_price + (over ? rcMaxMarkup : markup))}/ea</span>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                )
                            })}
                        </div>
                    )}

                    <Button
                        onClick={() => handleSaveSection('rc')}
                        disabled={savingSection === 'rc'}
                        className="w-full sm:w-auto bg-emerald-600 hover:bg-emerald-700 text-white h-11 px-6 rounded-xl font-semibold gap-2"
                    >
                        {savingSection === 'rc' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                        Save Exam Markups
                    </Button>
                </div>
            )}

            {/* ════════════ MASHUP ════════════ */}
            {activeSection === 'mashup' && (
                <div className="space-y-4 max-w-md">
                    <div className="flex gap-2.5 items-start p-3.5 rounded-xl bg-amber-50/70 dark:bg-amber-900/10 border border-amber-100 dark:border-amber-900 text-xs text-amber-800 dark:text-amber-300">
                        <Lightbulb className="w-4 h-4 flex-shrink-0 mt-0.5 text-amber-500" />
                        <p>
                            Your profit percentage on MTN Mashup orders placed through your storefront.
                            {mashupMaxProfit > 0 && <> Max allowed: <strong>{mashupMaxProfit.toFixed(2)}%</strong>.</>}
                        </p>
                    </div>

                    <div className="bg-white dark:bg-slate-900 rounded-xl border p-4 shadow-sm space-y-3">
                        <div className="flex items-center justify-between">
                            <p className="text-sm font-bold">Mashup Profit Margin</p>
                            {mashupMaxProfit > 0 && (
                                <span className="text-[11px] font-medium text-slate-500">Max {mashupMaxProfit.toFixed(2)}%</span>
                            )}
                        </div>

                        <div className="relative">
                            <Input
                                type="number" step="0.1" min="0"
                                max={mashupMaxProfit > 0 ? mashupMaxProfit : undefined}
                                placeholder="0.0"
                                value={mashupFee}
                                onChange={e => setMashupFee(e.target.value)}
                                className={cn(
                                    'h-11 rounded-lg pr-9 text-base font-semibold bg-slate-50 dark:bg-slate-950',
                                    mashupMaxProfit > 0 && parseFloat(mashupFee) > mashupMaxProfit && 'border-red-400 text-red-600 ring-1 ring-red-200'
                                )}
                            />
                            <span className="absolute right-3.5 top-1/2 -translate-y-1/2 font-semibold text-sm text-slate-400">%</span>
                        </div>

                        {mashupMaxProfit > 0 && parseFloat(mashupFee) > mashupMaxProfit && (
                            <p className="text-xs text-red-500 font-semibold flex items-center gap-1">
                                <AlertCircle className="w-3.5 h-3.5" /> Exceeds maximum — clamped to {mashupMaxProfit.toFixed(2)}% on save.
                            </p>
                        )}

                        {mashupFee && parseFloat(mashupFee) >= 0 && !(mashupMaxProfit > 0 && parseFloat(mashupFee) > mashupMaxProfit) && (
                            <div className="bg-amber-50 dark:bg-amber-900/20 rounded-lg p-3 border border-amber-100 dark:border-amber-800 text-xs">
                                <p className="font-medium text-amber-900 dark:text-amber-200">
                                    On a GHS 100 Mashup order you earn{' '}
                                    <span className="font-bold text-amber-600">GHS {(parseFloat(mashupFee) || 0).toFixed(2)}</span>
                                </p>
                            </div>
                        )}
                    </div>

                    <Button
                        onClick={() => handleSaveSection('mashup')}
                        disabled={savingSection === 'mashup'}
                        className="w-full sm:w-auto bg-amber-600 hover:bg-amber-700 text-white h-11 px-6 rounded-xl font-semibold gap-2"
                    >
                        {savingSection === 'mashup' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                        Save Mashup Profit
                    </Button>
                </div>
            )}

            {/* ════════════ AFA REGISTRATION ════════════ */}
            {activeSection === 'afa' && (() => {
                const valStr = afaSellingPrice
                const finalSelling = parseFloat(valStr) || 0
                const profit = valStr !== '' ? finalSelling - afaCost : null
                const maxProfit = afaMaxProfit > 0 ? afaMaxProfit : Infinity
                const valid = valStr === '' ? null : (profit !== null && profit > 0 && profit <= maxProfit)
                // A sub-agent owner with no AFA pricing configured has no real cost to
                // validate against — never let them save against a fabricated 0 floor.
                const notAvailable = isSubAgentOwner && !afaConfigured
                const saveDisabled = savingSection === 'afa' || notAvailable || (valStr !== '' && valid !== true)

                return (
                <div className="space-y-4 max-w-md">
                    <div className="flex gap-2.5 items-start p-3.5 rounded-xl bg-amber-50/70 dark:bg-amber-900/10 border border-amber-100 dark:border-amber-900 text-xs text-amber-800 dark:text-amber-300">
                        <Lightbulb className="w-4 h-4 flex-shrink-0 mt-0.5 text-amber-500" />
                        <p>
                            Type the full price you want to charge for an AFA registration — your profit is
                            what's left after your cost. Saving a price turns AFA on for your storefront;
                            clearing the field turns it off. You cannot sell below cost.
                            {afaMaxProfit > 0 && <> Max profit per registration: <strong>GHS {afaMaxProfit.toFixed(2)}</strong>.</>}
                        </p>
                    </div>

                    <div className={cn(
                        'bg-white dark:bg-slate-900 rounded-xl border p-4 shadow-sm space-y-3',
                        valStr && valid === false ? 'border-red-400 bg-red-50/50 dark:border-red-900/40' :
                            valStr && valid === true ? 'border-emerald-300' : ''
                    )}>
                        <div className="flex items-center justify-between">
                            <p className="text-sm font-bold">AFA Registration Price</p>
                            {!notAvailable && (
                                <span className="text-[11px] font-medium text-slate-500 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded-md">
                                    Cost: {formatCurrency(afaCost)}
                                </span>
                            )}
                        </div>

                        <div className="relative">
                            <span className="absolute left-3.5 top-1/2 -translate-y-1/2 font-semibold text-xs text-slate-400">GHS</span>
                            <Input
                                type="number" inputMode="decimal" step="0.5" min="0"
                                placeholder={`e.g. ${(afaCost + 2).toFixed(2)}`}
                                value={afaSellingPrice}
                                disabled={notAvailable}
                                onChange={e => setAfaSellingPrice(e.target.value)}
                                className={cn(
                                    'h-11 rounded-lg pl-11 text-base font-semibold',
                                    valStr && valid === false ? 'border-red-500 bg-red-50 text-red-900 dark:bg-red-950/20' :
                                        valStr && valid === true ? 'border-emerald-500 bg-emerald-50 text-emerald-900 dark:bg-emerald-900/20 dark:text-emerald-100' :
                                            'bg-slate-50 dark:bg-slate-950'
                                )}
                            />
                        </div>

                        {/* Live profit readout */}
                        {!notAvailable && (
                            <div className="flex items-center justify-between text-xs">
                                <span className="text-slate-400 font-medium">Profit</span>
                                <span className={cn('font-semibold tabular-nums', valid === true ? 'text-emerald-600' : valid === false ? 'text-red-500' : 'text-slate-400')}>
                                    {valStr && profit !== null ? `+${formatCurrency(profit)}` : '—'}
                                </span>
                            </div>
                        )}

                        {!notAvailable && valStr && valid === false && (
                            <p className="text-xs text-red-600 font-semibold flex items-center gap-1">
                                <AlertCircle className="w-3.5 h-3.5" />
                                {profit !== null && profit <= 0
                                    ? `Must be more than your cost of GHS ${afaCost.toFixed(2)}`
                                    : `Max profit is GHS ${afaMaxProfit.toFixed(2)}`}
                            </p>
                        )}

                        {(notAvailable || valStr === '') && (
                            <p className="text-xs text-slate-500">AFA registration is currently off for your shop.</p>
                        )}
                    </div>

                    <Button
                        onClick={() => handleSaveSection('afa')}
                        disabled={saveDisabled}
                        className="w-full sm:w-auto bg-amber-600 hover:bg-amber-700 text-white h-11 px-6 rounded-xl font-semibold gap-2 disabled:opacity-50"
                    >
                        {savingSection === 'afa' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                        Save AFA Settings
                    </Button>
                </div>
                )
            })()}

            {/* ── Mobile global save (floating) ── */}
            <div className="fixed bottom-4 max-md:bottom-[calc(env(safe-area-inset-bottom,0px)+72px)] left-4 right-4 z-40 sm:hidden">
                <Button
                    onClick={handleSubmitAll} disabled={saving}
                    className="w-full h-12 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-semibold shadow-xl gap-2"
                >
                    {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                    {saving ? 'Saving Everything...' : 'Save All & Go Live'}
                </Button>
            </div>

            {/* ── "Your Shop Is Live" completion modal ── */}
            {showLiveModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
                    <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 p-6 max-w-md w-full space-y-5 animate-in zoom-in-95 duration-200 max-h-[85vh] overflow-y-auto">
                        <div className="text-center space-y-2">
                            <div className="w-16 h-16 mx-auto rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
                                <PartyPopper className="w-8 h-8 text-emerald-600" />
                            </div>
                            <h2 className="text-lg font-bold">Your shop is fully set up! 🎉</h2>
                            <p className="text-sm text-muted-foreground">
                                Customers can now buy from your storefront. Share your link to find your first customers.
                            </p>
                        </div>

                        <div className="flex flex-col gap-2 bg-emerald-50/60 dark:bg-emerald-950/20 p-2 rounded-xl border border-emerald-100 dark:border-emerald-900/50">
                            <span className="text-xs font-mono text-emerald-800 dark:text-emerald-300 truncate px-2 py-1.5">{shopUrl}</span>
                            <div className="flex gap-2">
                                <Button onClick={copyLink} variant="secondary" size="sm" className="flex-1 h-9 bg-white dark:bg-zinc-900 text-emerald-600 gap-1.5 rounded-lg font-semibold">
                                    {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />} {copied ? 'Copied!' : 'Copy Link'}
                                </Button>
                                <a
                                    className="flex-1"
                                    href={`https://wa.me/?text=${encodeURIComponent(`🛍️ Buy affordable data bundles, airtime & vouchers from my shop: ${shopUrl}`)}`}
                                    target="_blank" rel="noopener noreferrer"
                                >
                                    <Button size="sm" className="w-full h-9 bg-[#25D366] hover:bg-[#1ebc57] text-white gap-1.5 rounded-lg font-semibold">
                                        <MessageCircle className="w-3.5 h-3.5" /> Share on WhatsApp
                                    </Button>
                                </a>
                            </div>
                        </div>

                        <div className="space-y-2">
                            <p className="text-xs font-bold text-gray-900 dark:text-gray-100">How to get more customers:</p>
                            <ul className="space-y-1.5 text-xs text-muted-foreground">
                                <li className="flex gap-2"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0 mt-0.5" /> Share your link in WhatsApp groups and your status daily.</li>
                                <li className="flex gap-2"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0 mt-0.5" /> Keep your prices slightly below local competitors.</li>
                                <li className="flex gap-2"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0 mt-0.5" /> Post your storefront notice with promos to returning buyers.</li>
                                <li className="flex gap-2"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0 mt-0.5" /> Respond fast on WhatsApp — speed builds trust and repeat sales.</li>
                            </ul>
                        </div>

                        <div className="flex gap-2">
                            <a href={shopUrl} target="_blank" rel="noopener noreferrer" className="flex-1">
                                <Button variant="outline" className="w-full gap-1.5 font-semibold">
                                    <ExternalLink className="w-4 h-4" /> View Storefront
                                </Button>
                            </a>
                            <Button className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold" onClick={() => setShowLiveModal(false)}>
                                Done
                            </Button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}
