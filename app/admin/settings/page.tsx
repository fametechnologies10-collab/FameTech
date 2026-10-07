'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { coerceBool } from '@/lib/admin-settings'
import { useAuth } from '@/contexts/auth-context'
import { cn, normalizeWhatsAppNumber } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
    Loader2, Save, Plus, Trash2, ShieldAlert, Settings,
    Mail, MessageSquare, Store, Shield, Percent, Star,
    Users, Zap, Globe, CreditCard, Phone, Wallet, ExternalLink,
    IdCard,
} from 'lucide-react'
import { toast } from '@/lib/toast'

interface LandingDataPackage { network: string; volume: string; price: string }
interface LandingAgentPlan { key: string; title: string; duration: string; price: string; oldPrice?: string; badge?: string }
interface LandingTestimonial { name: string; role: string; rating: number; quote: string }

const EMPTY_PACKAGE = (): LandingDataPackage => ({ network: '', volume: '', price: '' })
const EMPTY_PLAN = (): LandingAgentPlan => ({ key: '', title: '', duration: '', price: '', oldPrice: '', badge: '' })
const EMPTY_TESTIMONIAL = (): LandingTestimonial => ({ name: '', role: '', rating: 5, quote: '' })

// ─── Helper Components ────────────────────────────────────────────────────────

function SettingsPanel({ title, description, icon: Icon, children }: {
    title: string
    description?: string
    icon?: any
    children: React.ReactNode
}) {
    return (
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
            <div className="flex items-start gap-3 px-5 py-4 border-b border-slate-100 dark:border-slate-800">
                {Icon && (
                    <div className="w-7 h-7 rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center flex-shrink-0 mt-0.5">
                        <Icon className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
                    </div>
                )}
                <div>
                    <p className="text-sm font-bold text-slate-900 dark:text-white">{title}</p>
                    {description && <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">{description}</p>}
                </div>
            </div>
            <div className="p-5 space-y-4">{children}</div>
        </div>
    )
}

function SettingField({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
    return (
        <div className="space-y-1.5">
            <Label className="text-[11px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest">{label}</Label>
            {children}
            {hint && <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1">{hint}</p>}
        </div>
    )
}

function ToggleRow({
    label, description, checked, onCheckedChange, color = 'default', compact = false,
}: {
    label: string
    description?: string
    checked: boolean
    onCheckedChange: (v: boolean) => void
    color?: 'default' | 'emerald'
    compact?: boolean
}) {
    return (
        <div className={cn(
            'flex items-center justify-between rounded-xl border transition-all',
            compact ? 'p-3' : 'p-4',
            checked
                ? color === 'emerald'
                    ? 'bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/20'
                    : 'bg-violet-50/60 dark:bg-violet-500/5 border-violet-200/80 dark:border-violet-500/20'
                : 'bg-slate-50/50 dark:bg-slate-800/30 border-slate-200 dark:border-slate-700/60'
        )}>
            <div className="min-w-0 mr-3 flex-1">
                <p className={cn(
                    'font-semibold',
                    compact ? 'text-xs' : 'text-sm',
                    checked
                        ? color === 'emerald' ? 'text-emerald-700 dark:text-emerald-400' : 'text-slate-900 dark:text-white'
                        : 'text-slate-500 dark:text-slate-400'
                )}>{label}</p>
                {description && (
                    <p className={cn('text-slate-400 dark:text-slate-500 leading-tight', compact ? 'text-[10px] mt-0.5' : 'text-xs mt-0.5')}>
                        {description}
                    </p>
                )}
            </div>
            <Switch
                checked={checked}
                onCheckedChange={onCheckedChange}
                className={cn('flex-shrink-0', color === 'emerald' && 'data-[state=checked]:bg-emerald-500')}
            />
        </div>
    )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AdminSettingsPage() {
    const { isAdmin, isSubAdmin, isLoading: authLoading } = useAuth()
    const router = useRouter()
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)

    // Form states
    const [paystackFee, setPaystackFee] = useState('1.95')
    const [agentPaystackFee, setAgentPaystackFee] = useState('1.95')
    const [dealerPaystackFee, setDealerPaystackFee] = useState('')
    const [paystackMinTopup, setPaystackMinTopup] = useState('5')
    const [paystackMaxTopup, setPaystackMaxTopup] = useState('5000')
    const [mtnAdjustment, setMtnAdjustment] = useState('0')
    const [agentUpgradePrice, setAgentUpgradePrice] = useState('100')
    const [afaPriceCustomer, setAfaPriceCustomer] = useState('15')
    const [afaPriceAgent, setAfaPriceAgent] = useState('15')
    const [afaPriceDealer, setAfaPriceDealer] = useState('15')
    const [afaCostPrice, setAfaCostPrice] = useState('11.5')
    const [smsCostPerSegment, setSmsCostPerSegment] = useState('0.243')
    const [storefrontAfaEnabled, setStorefrontAfaEnabled] = useState(false)
    // shop_global_settings caps — separate table, separate save path from the
    // admin_settings fields above. 0 means no limit (matches mashup_shop_fee_max_*).
    const [afaShopFeeMaxCustomer, setAfaShopFeeMaxCustomer] = useState('0')
    const [afaShopFeeMaxAgent, setAfaShopFeeMaxAgent] = useState('0')
    const [afaShopFeeMaxDealer, setAfaShopFeeMaxDealer] = useState('0')
    const [savingAfaCaps, setSavingAfaCaps] = useState(false)
    const [supportEmail, setSupportEmail] = useState('')
    const [guestStorefrontUrl, setGuestStorefrontUrl] = useState('')
    const [whatsappGroupLink, setWhatsappGroupLink] = useState('')
    const [whatsappChannelLink, setWhatsappChannelLink] = useState('')
    const [whatsappAdminNumber, setWhatsappAdminNumber] = useState('')
    const [whatsappCommunityLink, setWhatsappCommunityLink] = useState('')
    const [footerCopyrightText, setFooterCopyrightText] = useState('')
    const [footerBrandingText, setFooterBrandingText] = useState('')
    const [autoFulfillment, setAutoFulfillment] = useState(true)
    const [phoneVerificationEnabled, setPhoneVerificationEnabled] = useState(false)

    // USSD settings
    const [ussdEnabled, setUssdEnabled] = useState(true)
    const [ussdDataEnabled, setUssdDataEnabled] = useState(true)
    const [ussdRcEnabled, setUssdRcEnabled] = useState(true)
    const [ussdAfaEnabled, setUssdAfaEnabled] = useState(true)
    const [ussdAfaPrice, setUssdAfaPrice] = useState('15.00')
    const [ussdMaxRcQty, setUssdMaxRcQty] = useState('3')
    const [ussdResumeMinutes, setUssdResumeMinutes] = useState('30')

    // Landing page states
    const [landingCustomerCount, setLandingCustomerCount] = useState('5,000+')
    const [landingDataPackages, setLandingDataPackages] = useState<LandingDataPackage[]>([EMPTY_PACKAGE()])
    const [landingAgentPlans, setLandingAgentPlans] = useState<LandingAgentPlan[]>([EMPTY_PLAN()])
    const [landingTestimonials, setLandingTestimonials] = useState<LandingTestimonial[]>([EMPTY_TESTIMONIAL()])

    // Page access states
    const [pageAccessDashboard, setPageAccessDashboard] = useState(true)
    const [pageAccessDataPackages, setPageAccessDataPackages] = useState(true)
    const [pageAccessOrders, setPageAccessOrders] = useState(true)
    const [pageAccessWallet, setPageAccessWallet] = useState(true)
    const [pageAccessComplaints, setPageAccessComplaints] = useState(true)
    const [pageAccessNotifications, setPageAccessNotifications] = useState(true)
    const [pageAccessProfile, setPageAccessProfile] = useState(true)
    const [pageAccessShop, setPageAccessShop] = useState(true)
    const [pageAccessStorefront, setPageAccessStorefront] = useState(true)
    const [pageAccessAirtime, setPageAccessAirtime] = useState(true)
    const [pageAccessResultsChecker, setPageAccessResultsChecker] = useState(true)
    const [pageAccessUpgrade, setPageAccessUpgrade] = useState(true)
    const [pageAccessTransactions, setPageAccessTransactions] = useState(true)
    const [pageAccessAfaOrders, setPageAccessAfaOrders] = useState(true)
    const [pageAccessRecruit, setPageAccessRecruit] = useState(true)
    const [pageAccessCommission, setPageAccessCommission] = useState(true)
    const [pageAccessSms, setPageAccessSms] = useState(true)
    const [pageAccessDeveloperApi, setPageAccessDeveloperApi] = useState(true)

    // Snapshot of last-saved values (as a stable JSON string) for dirty-tracking
    // and changed-keys-only saves. Set once after load and reset after each save.
    const baselineRef = useRef<string | null>(null)

    // Single source for the full settings payload — used by both save and
    // dirty-detection so they can never drift.
    const buildUpdates = useCallback((): { key: string; value: string }[] => ([
        { key: 'paystack_fee_percent', value: paystackFee },
        { key: 'agent_paystack_fee_percent', value: agentPaystackFee },
        { key: 'dealer_paystack_fee_percent', value: dealerPaystackFee.trim() },
        { key: 'paystack_min_topup', value: paystackMinTopup },
        { key: 'paystack_max_topup', value: paystackMaxTopup },
        { key: 'mtn_price_adjustment', value: mtnAdjustment },
        { key: 'agent_upgrade_price', value: agentUpgradePrice },
        { key: 'afa_price_customer', value: afaPriceCustomer },
        { key: 'afa_price_agent', value: afaPriceAgent },
        { key: 'afa_price_dealer', value: afaPriceDealer },
        { key: 'afa_cost_price', value: afaCostPrice },
        { key: 'sms_cost_per_segment', value: smsCostPerSegment },
        // jsonb STRING 'true'/'false' — matches every sibling storefront toggle
        // (storefront_mashup_enabled, storefront_utilities_enabled). A jsonb
        // boolean here makes the gate unopenable (already fixed once).
        { key: 'storefront_afa_enabled', value: String(storefrontAfaEnabled) },
        { key: 'support_email', value: supportEmail },
        { key: 'guest_storefront_url', value: guestStorefrontUrl },
        { key: 'whatsapp_group_link', value: whatsappGroupLink },
        { key: 'whatsapp_channel_link', value: whatsappChannelLink },
        { key: 'whatsapp_admin_number', value: normalizeWhatsAppNumber(whatsappAdminNumber) },
        { key: 'whatsapp_community_link', value: whatsappCommunityLink },
        { key: 'footer_copyright_text', value: footerCopyrightText },
        { key: 'footer_branding_text', value: footerBrandingText },
        { key: 'auto_fulfillment_enabled', value: String(autoFulfillment) },
        { key: 'phone_verification_enabled', value: coerceBool(phoneVerificationEnabled) },
        { key: 'ussd_enabled', value: String(ussdEnabled) },
        { key: 'ussd_data_enabled', value: String(ussdDataEnabled) },
        { key: 'ussd_rc_enabled', value: String(ussdRcEnabled) },
        { key: 'ussd_afa_enabled', value: String(ussdAfaEnabled) },
        { key: 'afa_price_ussd', value: ussdAfaPrice },
        { key: 'ussd_max_rc_quantity', value: ussdMaxRcQty },
        { key: 'ussd_session_resume_minutes', value: ussdResumeMinutes },
        { key: 'page_access_dashboard', value: String(pageAccessDashboard) },
        { key: 'page_access_data_packages', value: String(pageAccessDataPackages) },
        { key: 'page_access_orders', value: String(pageAccessOrders) },
        { key: 'page_access_wallet', value: String(pageAccessWallet) },
        { key: 'page_access_complaints', value: String(pageAccessComplaints) },
        { key: 'page_access_notifications', value: String(pageAccessNotifications) },
        { key: 'page_access_profile', value: String(pageAccessProfile) },
        { key: 'page_access_shop', value: String(pageAccessShop) },
        { key: 'page_access_storefront', value: String(pageAccessStorefront) },
        { key: 'page_access_airtime', value: String(pageAccessAirtime) },
        { key: 'page_access_results_checker', value: String(pageAccessResultsChecker) },
        { key: 'page_access_upgrade', value: String(pageAccessUpgrade) },
        { key: 'page_access_transactions', value: String(pageAccessTransactions) },
        { key: 'page_access_afa_orders', value: String(pageAccessAfaOrders) },
        { key: 'page_access_recruit', value: String(pageAccessRecruit) },
        { key: 'page_access_commission', value: String(pageAccessCommission) },
        { key: 'page_access_sms', value: String(pageAccessSms) },
        { key: 'page_access_developer_api', value: String(pageAccessDeveloperApi) },
        { key: 'landing_customer_count', value: landingCustomerCount.trim() },
        { key: 'landing_data_packages', value: JSON.stringify(landingDataPackages.filter(p => p.network && p.volume && p.price)) },
        { key: 'landing_agent_pricing', value: JSON.stringify(landingAgentPlans.filter(p => p.key && p.title && p.duration && p.price)) },
        { key: 'landing_testimonials', value: JSON.stringify(landingTestimonials.filter(t => t.name && t.role && t.quote)) },
    ]), [
        paystackFee, agentPaystackFee, dealerPaystackFee, paystackMinTopup, paystackMaxTopup, mtnAdjustment,
        agentUpgradePrice, afaPriceCustomer, afaPriceAgent, afaPriceDealer, afaCostPrice, smsCostPerSegment, storefrontAfaEnabled, supportEmail, guestStorefrontUrl,
        whatsappGroupLink, whatsappChannelLink, whatsappAdminNumber, whatsappCommunityLink, footerCopyrightText,
        footerBrandingText, autoFulfillment, phoneVerificationEnabled, ussdEnabled, ussdDataEnabled, ussdRcEnabled,
        ussdAfaEnabled, ussdAfaPrice, ussdMaxRcQty, ussdResumeMinutes, pageAccessDashboard, pageAccessDataPackages,
        pageAccessOrders, pageAccessWallet, pageAccessComplaints, pageAccessNotifications, pageAccessProfile,
        pageAccessShop, pageAccessStorefront, pageAccessAirtime, pageAccessResultsChecker, pageAccessUpgrade,
        pageAccessTransactions, pageAccessAfaOrders, pageAccessRecruit, pageAccessCommission, pageAccessSms,
        pageAccessDeveloperApi, landingCustomerCount, landingDataPackages, landingAgentPlans,
        landingTestimonials,
    ])

    const isDirty = baselineRef.current !== null && baselineRef.current !== JSON.stringify(buildUpdates())

    useEffect(() => {
        if (!authLoading && isSubAdmin && !isAdmin) {
            router.replace('/admin/orders')
            return
        }
        if (!authLoading && isAdmin) {
            fetchSettings()
        }
    }, [authLoading, isAdmin, isSubAdmin])

    // Capture the saved baseline once, after the initial load completes.
    useEffect(() => {
        if (!loading && baselineRef.current === null) {
            baselineRef.current = JSON.stringify(buildUpdates())
        }
    }, [loading, buildUpdates])

    // Warn before leaving with unsaved changes.
    useEffect(() => {
        if (!isDirty) return
        const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
        window.addEventListener('beforeunload', handler)
        return () => window.removeEventListener('beforeunload', handler)
    }, [isDirty])

    const fetchSettings = async () => {
        if (!isAdmin) { setLoading(false); return }
        try {
            const { data, error } = await (supabase.from('admin_settings') as any).select('key, value')
            if (error) throw error

            const s = (data as { key: string; value: string }[]).reduce((acc: Record<string, string>, curr) => {
                acc[curr.key] = curr.value
                return acc
            }, {})

            setPaystackFee(s.paystack_fee_percent || '1.95')
            setAgentPaystackFee(s.agent_paystack_fee_percent || '1.95')
            setDealerPaystackFee(s.dealer_paystack_fee_percent ?? '')
            setPaystackMinTopup(s.paystack_min_topup || '5')
            setPaystackMaxTopup(s.paystack_max_topup || '5000')
            setMtnAdjustment(s.mtn_price_adjustment || '0')
            setAgentUpgradePrice(s.agent_upgrade_price || '100')
            setAfaPriceCustomer(s.afa_price_customer || '15')
            setAfaPriceAgent(s.afa_price_agent || '15')
            setAfaPriceDealer(s.afa_price_dealer || '15')
            setAfaCostPrice(s.afa_cost_price || '11.5')
            setSmsCostPerSegment(s.sms_cost_per_segment || '0.243')
            // Accept either jsonb representation defensively (matches
            // computeShopAfaCheckout's read) — a boolean once slipped in here.
            setStorefrontAfaEnabled(s.storefront_afa_enabled === 'true' || (s.storefront_afa_enabled as unknown) === true)
            setSupportEmail(s.support_email || '')
            setGuestStorefrontUrl(s.guest_storefront_url || '')
            setWhatsappGroupLink(s.whatsapp_group_link || '')
            setWhatsappChannelLink(s.whatsapp_channel_link || '')
            setWhatsappAdminNumber(s.whatsapp_admin_number || '')
            setWhatsappCommunityLink(s.whatsapp_community_link || '')
            setFooterCopyrightText(s.footer_copyright_text || '2026 KiNG FLEXY TECHNOLOGIES LTD')
            setFooterBrandingText(s.footer_branding_text || 'KiNG FLEXY TECHNOLOGIES')
            setAutoFulfillment(s.auto_fulfillment_enabled === 'true')
            setPhoneVerificationEnabled(s.phone_verification_enabled === 'true' || (s.phone_verification_enabled as unknown) === true)

            // USSD settings
            setUssdEnabled(s.ussd_enabled !== 'false')
            setUssdDataEnabled(s.ussd_data_enabled !== 'false')
            setUssdRcEnabled(s.ussd_rc_enabled !== 'false')
            setUssdAfaEnabled(s.ussd_afa_enabled !== 'false')
            setUssdAfaPrice(s.afa_price_ussd || '15.00')
            setUssdMaxRcQty(s.ussd_max_rc_quantity || '3')
            setUssdResumeMinutes(s.ussd_session_resume_minutes || '30')

            const tryParseArray = (raw: unknown, fallback: unknown[]) => {
                if (Array.isArray(raw)) return raw
                if (typeof raw === 'string') { try { const p = JSON.parse(raw); return Array.isArray(p) ? p : fallback } catch { return fallback } }
                return fallback
            }

            setPageAccessDashboard(s.page_access_dashboard !== 'false')
            setPageAccessDataPackages(s.page_access_data_packages !== 'false')
            setPageAccessOrders(s.page_access_orders !== 'false')
            setPageAccessWallet(s.page_access_wallet !== 'false')
            setPageAccessComplaints(s.page_access_complaints !== 'false')
            setPageAccessNotifications(s.page_access_notifications !== 'false')
            setPageAccessProfile(s.page_access_profile !== 'false')
            setPageAccessShop(s.page_access_shop !== 'false')
            setPageAccessStorefront(s.page_access_storefront !== 'false')
            setPageAccessAirtime(s.page_access_airtime !== 'false')
            setPageAccessResultsChecker(s.page_access_results_checker !== 'false')
            setPageAccessUpgrade(s.page_access_upgrade !== 'false')
            setPageAccessTransactions(s.page_access_transactions !== 'false')
            setPageAccessAfaOrders(s.page_access_afa_orders !== 'false')
            setPageAccessRecruit(s.page_access_recruit !== 'false')
            setPageAccessCommission(s.page_access_commission !== 'false')
            setPageAccessSms(s.page_access_sms !== 'false')
            setPageAccessDeveloperApi(s.page_access_developer_api !== 'false')

            const rawCount = s.landing_customer_count
            if (typeof rawCount === 'string' && rawCount.trim()) setLandingCustomerCount(rawCount.trim())

            const pkgs = tryParseArray(s.landing_data_packages, [EMPTY_PACKAGE()])
            setLandingDataPackages((pkgs as LandingDataPackage[]).length > 0 ? pkgs as LandingDataPackage[] : [EMPTY_PACKAGE()])
            const plans = tryParseArray(s.landing_agent_pricing, [EMPTY_PLAN()])
            setLandingAgentPlans((plans as LandingAgentPlan[]).length > 0 ? plans as LandingAgentPlan[] : [EMPTY_PLAN()])
            const tests = tryParseArray(s.landing_testimonials, [EMPTY_TESTIMONIAL()])
            setLandingTestimonials((tests as LandingTestimonial[]).length > 0 ? tests as LandingTestimonial[] : [EMPTY_TESTIMONIAL()])
            // AFA shop markup caps — different table (shop_global_settings), same
            // key/value shape as admin_settings but with a separate save path
            // (see saveAfaCaps) since it lives in a different table.
            const { data: capsData } = await (supabase.from('shop_global_settings') as any)
                .select('key, value')
                .in('key', ['afa_shop_fee_max_customer', 'afa_shop_fee_max_agent', 'afa_shop_fee_max_dealer'])
            const capsMap: Record<string, string> = {}
            for (const row of (capsData as { key: string; value: any }[]) || []) capsMap[row.key] = String(row.value)
            setAfaShopFeeMaxCustomer(capsMap.afa_shop_fee_max_customer ?? '0')
            setAfaShopFeeMaxAgent(capsMap.afa_shop_fee_max_agent ?? '0')
            setAfaShopFeeMaxDealer(capsMap.afa_shop_fee_max_dealer ?? '0')
        } catch (error) {
            console.error('Error fetching settings:', error)
            toast.error('Failed to load settings')
        } finally {
            setLoading(false)
        }
    }

    // Separate save mechanism from saveSettings() — afa_shop_fee_max_* live in
    // shop_global_settings, not admin_settings, so they can't ride buildUpdates'
    // single upsert. 0 means no limit (label this clearly in the UI).
    const saveAfaCaps = async () => {
        if (!isAdmin) { toast.error('You do not have permission to modify settings.'); return }
        const checks: [string, string][] = [
            ['Customer AFA markup cap', afaShopFeeMaxCustomer],
            ['Agent AFA markup cap', afaShopFeeMaxAgent],
            ['Dealer AFA markup cap', afaShopFeeMaxDealer],
        ]
        for (const [label, val] of checks) {
            const n = parseFloat(val)
            if (!Number.isFinite(n) || n < 0) { toast.error(`${label} must be a valid non-negative number (0 = no limit).`); return }
        }
        setSavingAfaCaps(true)
        try {
            const now = new Date().toISOString()
            const { error } = await (supabase.from('shop_global_settings') as any).upsert([
                { key: 'afa_shop_fee_max_customer', value: parseFloat(afaShopFeeMaxCustomer) || 0, updated_at: now },
                { key: 'afa_shop_fee_max_agent', value: parseFloat(afaShopFeeMaxAgent) || 0, updated_at: now },
                { key: 'afa_shop_fee_max_dealer', value: parseFloat(afaShopFeeMaxDealer) || 0, updated_at: now },
            ], { onConflict: 'key' })
            if (error) throw error
            toast.success('AFA markup caps saved')
        } catch (error) {
            console.error('Error saving AFA caps:', error)
            toast.error('Failed to save AFA markup caps')
        } finally {
            setSavingAfaCaps(false)
        }
    }

    const saveSettings = async () => {
        if (!isAdmin) { toast.error('You do not have permission to modify settings.'); return }

        const isSafeUrl = (url: string): boolean => {
            if (!url.trim()) return true
            try {
                const { protocol, hostname } = new URL(url.trim())
                if (protocol !== 'https:') return false
                const allowed = ['wa.me', 'chat.whatsapp.com', 'whatsapp.com', 'www.whatsapp.com']
                return allowed.some(h => hostname === h || hostname.endsWith('.' + h))
            } catch { return false }
        }
        const isSafeGenericUrl = (url: string): boolean => {
            if (!url.trim()) return true
            try { const { protocol } = new URL(url.trim()); return protocol === 'https:' || protocol === 'http:' } catch { return false }
        }

        if (!isSafeUrl(whatsappGroupLink)) { toast.error('WhatsApp Group Link must be a valid wa.me or whatsapp.com URL.'); return }
        if (!isSafeUrl(whatsappChannelLink)) { toast.error('WhatsApp Channel Link must be a valid wa.me or whatsapp.com URL.'); return }
        if (!isSafeUrl(whatsappCommunityLink)) { toast.error('WhatsApp Community Link must be a valid wa.me or whatsapp.com URL.'); return }
        if (!isSafeGenericUrl(guestStorefrontUrl)) { toast.error('Guest Storefront URL must be a valid https:// URL.'); return }

        const lengthChecks: [string, string, number][] = [
            ['Support email', supportEmail, 254],
            ['Guest storefront URL', guestStorefrontUrl, 500],
            ['WhatsApp group link', whatsappGroupLink, 500],
            ['WhatsApp channel link', whatsappChannelLink, 500],
            ['WhatsApp community link', whatsappCommunityLink, 500],
            ['Footer copyright text', footerCopyrightText, 200],
            ['Footer branding text', footerBrandingText, 100],
            ['Customer count label', landingCustomerCount, 20],
        ]
        for (const [label, value, max] of lengthChecks) {
            if (value.length > max) { toast.error(`${label} exceeds the maximum of ${max} characters.`); return }
        }

        const countDigits = landingCustomerCount.replace(/[^\d]/g, '')
        if (countDigits) {
            const countNum = parseInt(countDigits, 10)
            if (isNaN(countNum) || countNum < 0 || countNum > 10_000_000) {
                toast.error('Customer count must be a positive number no greater than 10,000,000.'); return
            }
        }

        for (const pkg of landingDataPackages) {
            if (!pkg.network && !pkg.volume && !pkg.price) continue
            if (pkg.network.length > 30 || pkg.volume.length > 20 || pkg.price.length > 10) {
                toast.error('A data package row has a field that exceeds its maximum length.'); return
            }
        }
        for (const plan of landingAgentPlans) {
            if (!plan.key && !plan.title && !plan.duration && !plan.price) continue
            if (plan.title.length > 50 || plan.duration.length > 60 || plan.price.length > 10 || plan.key.length > 20) {
                toast.error('An agent plan row has a field that exceeds its maximum length.'); return
            }
        }
        for (const t of landingTestimonials) {
            if (!t.name && !t.role && !t.quote) continue
            if (t.name.length > 60 || t.role.length > 80 || t.quote.length > 300) {
                toast.error('A testimonial row has a field that exceeds its maximum length (name: 60, role: 80, quote: 300).'); return
            }
            if (t.rating < 1 || t.rating > 5) { toast.error(`Rating for "${t.name || 'a review'}" must be between 1 and 5.`); return }
        }

        const minNum = parseFloat(paystackMinTopup)
        const maxNum = parseFloat(paystackMaxTopup)
        if (!Number.isFinite(minNum) || minNum < 1) { toast.error('Minimum top-up must be at least GHS 1.'); return }
        if (!Number.isFinite(maxNum) || maxNum <= minNum) { toast.error('Maximum top-up must be greater than the minimum.'); return }
        if (dealerPaystackFee.trim() !== '') {
            const dealerNum = parseFloat(dealerPaystackFee)
            if (!Number.isFinite(dealerNum) || dealerNum < 0 || dealerNum > 100) { toast.error('Dealer Paystack fee must be between 0 and 100.'); return }
        }

        // Fee / price bounds — these feed money math directly, so validate before save.
        const feePercentChecks: [string, string][] = [
            ['Customer Paystack fee', paystackFee],
            ['Agent Paystack fee', agentPaystackFee],
        ]
        for (const [label, val] of feePercentChecks) {
            const n = parseFloat(val)
            if (!Number.isFinite(n) || n < 0 || n > 100) { toast.error(`${label} must be a number between 0 and 100.`); return }
        }
        const nonNegativeChecks: [string, string][] = [
            ['MTN price adjustment', mtnAdjustment],
            ['Agent upgrade price', agentUpgradePrice],
            ['Customer AFA price', afaPriceCustomer],
            ['Agent AFA price', afaPriceAgent],
            ['Dealer AFA price', afaPriceDealer],
            ['AFA platform cost', afaCostPrice],
            ['SMS cost per segment', smsCostPerSegment],
        ]
        for (const [label, val] of nonNegativeChecks) {
            const n = parseFloat(val)
            if (!Number.isFinite(n) || n < 0) { toast.error(`${label} must be a valid non-negative number.`); return }
        }

        // Save only the keys that actually changed since load — prevents two admins
        // editing different tabs from clobbering each other (last-write-wins on the
        // full set), and lets one bad field not block unrelated saves.
        const allUpdates = buildUpdates()
        const baseline: { key: string; value: string }[] = baselineRef.current ? JSON.parse(baselineRef.current) : []
        const baseMap = Object.fromEntries(baseline.map(u => [u.key, u.value]))
        const changed = allUpdates.filter(u => u.value !== baseMap[u.key])

        if (changed.length === 0) {
            toast.success('No changes to save')
            return
        }

        setSaving(true)
        try {
            const { error } = await (supabase.from('admin_settings') as any).upsert(changed, { onConflict: 'key' })
            if (error) throw error
            baselineRef.current = JSON.stringify(allUpdates)
            toast.success(`Saved ${changed.length} change${changed.length !== 1 ? 's' : ''}`)
        } catch (error) {
            console.error('Error saving settings:', error)
            toast.error('Failed to save settings')
        } finally {
            setSaving(false)
        }
    }

    if (authLoading) return <div className="p-8 flex justify-center"><Loader2 className="animate-spin" /></div>

    if (!isAdmin) {
        return (
            <div className="p-8">
                <Alert variant="destructive" className="max-w-md">
                    <ShieldAlert className="h-4 w-4" />
                    <AlertTitle>Access Denied</AlertTitle>
                    <AlertDescription>Only administrators can access System Settings.</AlertDescription>
                </Alert>
            </div>
        )
    }

    if (loading) return <div className="p-8 flex justify-center"><Loader2 className="animate-spin" /></div>

    return (
        <div className="space-y-6 max-w-4xl">

            {/* ── Header ──────────────────────────────────────────────────────── */}
            <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-slate-700 to-slate-900 dark:from-slate-600 dark:to-slate-800 flex items-center justify-center shadow-lg flex-shrink-0">
                        <Settings className="w-6 h-6 text-white" />
                    </div>
                    <div>
                        <h1 className="text-xl font-black text-slate-900 dark:text-white tracking-tight">System Settings</h1>
                        <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">Configure detailed platform parameters</p>
                    </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                    {isDirty && !saving && (
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-600 dark:text-amber-400">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" /> Unsaved
                        </span>
                    )}
                    <Button
                        onClick={saveSettings}
                        disabled={saving || !isDirty}
                        className="gap-2 h-9 text-xs font-bold"
                    >
                        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                        Save Changes
                    </Button>
                </div>
            </div>

            <Tabs defaultValue="general">
                <TabsList className="flex-wrap h-auto gap-1">
                    <TabsTrigger value="general">General</TabsTrigger>
                    <TabsTrigger value="fees">Fees & Pricing</TabsTrigger>
                    <TabsTrigger value="fulfillment">Fulfillment</TabsTrigger>
                    <TabsTrigger value="access">Page Access</TabsTrigger>
                    <TabsTrigger value="landing">Landing Page</TabsTrigger>
                    <TabsTrigger value="momo" className="text-indigo-600 font-semibold">📱 MoMo Claims</TabsTrigger>
                    <TabsTrigger value="ussd" className="text-orange-600 font-semibold">USSD *713*9939#</TabsTrigger>
                </TabsList>

                {/* ── General ─────────────────────────────────────────────────── */}
                <TabsContent value="general" className="space-y-4 mt-4">
                    <SettingsPanel title="Support Information" description="Contact details displayed to users" icon={Mail}>
                        <SettingField label="Support Email" hint="Displayed on help and contact pages">
                            <Input value={supportEmail} onChange={e => setSupportEmail(e.target.value)} placeholder="support@kingflexydataltd.com" className="max-w-sm" />
                        </SettingField>
                    </SettingsPanel>

                    <SettingsPanel title="Social Media & Community" description="Configure WhatsApp links and support contacts" icon={MessageSquare}>
                        <SettingField label="WhatsApp Admin Number" hint="Used for direct support chats. Auto-normalized to international format (233...).">
                            <Input value={whatsappAdminNumber} onChange={e => setWhatsappAdminNumber(e.target.value)} placeholder="e.g. 0555123456 or 233555123456" className="max-w-sm" />
                        </SettingField>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <SettingField label="WhatsApp Group Link">
                                <Input value={whatsappGroupLink} onChange={e => setWhatsappGroupLink(e.target.value)} placeholder="https://chat.whatsapp.com/..." />
                            </SettingField>
                            <SettingField label="WhatsApp Channel Link">
                                <Input value={whatsappChannelLink} onChange={e => setWhatsappChannelLink(e.target.value)} placeholder="https://whatsapp.com/channel/..." />
                            </SettingField>
                        </div>
                        <SettingField label="WhatsApp Community Link (Sidebar)" hint={'The "Join Community" link shown in the dashboard sidebar.'}>
                            <Input value={whatsappCommunityLink} onChange={e => setWhatsappCommunityLink(e.target.value)} placeholder="https://chat.whatsapp.com/..." />
                        </SettingField>
                    </SettingsPanel>

                    <SettingsPanel title="Guest Storefront Configuration" description="Default shop users are directed to when buying as a guest without creating an account." icon={Store}>
                        <SettingField label="Guest Store URL" hint="Changes to this link will instantly update all unauthenticated app pages.">
                            <Input value={guestStorefrontUrl} onChange={e => setGuestStorefrontUrl(e.target.value)} placeholder="https://kingflexygh.com/shop/your-shop" />
                        </SettingField>
                    </SettingsPanel>

                    <SettingsPanel title="Copyright & Branding" description={'Configure the copyright text and "Powered by" labels used in footers.'} icon={Shield}>
                        <SettingField label="Platform Copyright Text" hint="Used on Dashboard and Admin footer: © [Text]. All rights reserved.">
                            <Input value={footerCopyrightText} onChange={e => setFooterCopyrightText(e.target.value)} placeholder="e.g. 2026 KiNG FLEXY TECHNOLOGIES LTD" />
                        </SettingField>
                        <SettingField label="Storefront Branding Label (Powered by)" hint="Plain text label shown on shop footers: Powered by [Text].">
                            <Input value={footerBrandingText} onChange={e => setFooterBrandingText(e.target.value)} placeholder="e.g. KiNG FLEXY TECHNOLOGIES" />
                        </SettingField>
                    </SettingsPanel>
                </TabsContent>

                {/* ── Fees & Pricing ───────────────────────────────────────────── */}
                <TabsContent value="fees" className="space-y-4 mt-4">
                    <SettingsPanel title="Payment & Transaction Fees" description="Configure fees passed on to users during wallet top-ups" icon={Percent}>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <SettingField label="Customer Paystack Fee %" hint="Fee for regular users during top-up">
                                <Input type="number" value={paystackFee} onChange={e => setPaystackFee(e.target.value)} step="0.01" />
                            </SettingField>
                            <SettingField label="Agent Paystack Fee %" hint="Fee for agents during top-up">
                                <Input type="number" value={agentPaystackFee} onChange={e => setAgentPaystackFee(e.target.value)} step="0.01" />
                            </SettingField>
                            <SettingField label="Dealer Paystack Fee %" hint="Fee for dealers during top-up. Leave blank to use the customer fee.">
                                <Input type="number" value={dealerPaystackFee} onChange={e => setDealerPaystackFee(e.target.value)} step="0.01" placeholder="Uses customer fee" />
                            </SettingField>
                        </div>
                        <SettingField label="MTN Price Adjustment (GHS)" hint="Additional markup fee added to all MTN data packages">
                            <Input type="number" value={mtnAdjustment} onChange={e => setMtnAdjustment(e.target.value)} step="0.01" className="max-w-[180px]" />
                        </SettingField>
                    </SettingsPanel>

                    <SettingsPanel title="Wallet Top-up Limits" description="Minimum and maximum amount a user can top up per Paystack transaction" icon={Percent}>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <SettingField label="Minimum Top-up (GHS)" hint="Smallest allowed top-up amount">
                                <Input type="number" value={paystackMinTopup} onChange={e => setPaystackMinTopup(e.target.value)} step="1" min="1" />
                            </SettingField>
                            <SettingField label="Maximum Top-up (GHS)" hint="Largest allowed top-up amount">
                                <Input type="number" value={paystackMaxTopup} onChange={e => setPaystackMaxTopup(e.target.value)} step="1" />
                            </SettingField>
                        </div>
                    </SettingsPanel>

                    <SettingsPanel title="Membership Pricing" description="Fees for account upgrades and agent plans" icon={Star}>
                        <SettingField label="Agent Upgrade Price (GHS)" hint="One-time fee for customers upgrading to agent status">
                            <Input type="number" value={agentUpgradePrice} onChange={e => setAgentUpgradePrice(e.target.value)} step="0.01" min="0" className="max-w-[180px]" />
                        </SettingField>
                    </SettingsPanel>

                    <SettingsPanel title="AFA Application Pricing" description="Set application fees for Authorized Field Agent registrations" icon={Users}>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <SettingField label="Customer Application Fee (GHS)" hint="Fee charged to customers for AFA application">
                                <Input type="number" value={afaPriceCustomer} onChange={e => setAfaPriceCustomer(e.target.value)} step="0.01" min="0" />
                            </SettingField>
                            <SettingField label="Agent Application Fee (GHS)" hint="Fee charged to agents for AFA application">
                                <Input type="number" value={afaPriceAgent} onChange={e => setAfaPriceAgent(e.target.value)} step="0.01" min="0" />
                            </SettingField>
                            <SettingField label="Dealer Application Fee (GHS)" hint="Fee charged to dealers for AFA application">
                                <Input type="number" value={afaPriceDealer} onChange={e => setAfaPriceDealer(e.target.value)} step="0.01" min="0" />
                            </SettingField>
                            <SettingField label="Platform Cost Per Registration (GHS)" hint="Real cost to the platform per AFA registration — subtracted from revenue in the profit engine, not a customer-facing price">
                                <Input type="number" value={afaCostPrice} onChange={e => setAfaCostPrice(e.target.value)} step="0.01" min="0" />
                            </SettingField>
                        </div>
                    </SettingsPanel>

                    <SettingsPanel title="SMS Cost Basis" description="Hubtel's real per-segment SMS cost, used by the profit engine — not a customer-facing price" icon={MessageSquare}>
                        <SettingField label="Cost Per 159-Char Segment (GHS)" hint="1 purchased credit = 1 segment. Update this if Hubtel's rate changes.">
                            <Input type="number" value={smsCostPerSegment} onChange={e => setSmsCostPerSegment(e.target.value)} step="0.001" min="0" className="max-w-[180px]" />
                        </SettingField>
                    </SettingsPanel>

                    <SettingsPanel title="Storefront AFA Registration" description="Master switch and per-shop markup caps for AFA registration on shop storefronts" icon={IdCard}>
                        <ToggleRow
                            label="Enable Storefront AFA Registration"
                            description="When off, no shop can offer AFA registration on its storefront — use this to shut the feature off in an emergency."
                            checked={storefrontAfaEnabled}
                            onCheckedChange={setStorefrontAfaEnabled}
                            color="emerald"
                        />
                        <div className="pt-2">
                            <p className="text-[11px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest mb-3">
                                Max profit per registration (GHS) — saved separately from the fields above
                            </p>
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                                <SettingField label="Customer Shops (GHS)" hint="Max profit a customer-tier shop can earn per AFA registration. 0 = no limit">
                                    <Input type="number" value={afaShopFeeMaxCustomer} onChange={e => setAfaShopFeeMaxCustomer(e.target.value)} step="0.1" min="0" />
                                </SettingField>
                                <SettingField label="Agent Shops (GHS)" hint="Max profit an agent-tier shop can earn per AFA registration. 0 = no limit">
                                    <Input type="number" value={afaShopFeeMaxAgent} onChange={e => setAfaShopFeeMaxAgent(e.target.value)} step="0.1" min="0" />
                                </SettingField>
                                <SettingField label="Dealer Shops (GHS)" hint="Max profit a dealer-tier shop can earn per AFA registration. 0 = no limit">
                                    <Input type="number" value={afaShopFeeMaxDealer} onChange={e => setAfaShopFeeMaxDealer(e.target.value)} step="0.1" min="0" />
                                </SettingField>
                            </div>
                            <Button
                                onClick={saveAfaCaps}
                                disabled={savingAfaCaps}
                                size="sm"
                                className="mt-3 gap-2"
                            >
                                {savingAfaCaps ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                                Save Markup Caps
                            </Button>
                        </div>
                    </SettingsPanel>
                </TabsContent>

                {/* ── Fulfillment ──────────────────────────────────────────────── */}
                <TabsContent value="fulfillment" className="space-y-4 mt-4">
                    <SettingsPanel title="Auto Fulfillment" description="Control automated order processing" icon={Zap}>
                        <ToggleRow
                            label="Enable Auto-Fulfillment"
                            description="Automatically process and fulfill data orders via APIs without manual intervention"
                            checked={autoFulfillment}
                            onCheckedChange={setAutoFulfillment}
                        />
                    </SettingsPanel>

                    <SettingsPanel title="Phone Verification" description="SMS OTP verification during signup via Moolre" icon={Phone}>
                        <ToggleRow
                            label="Require Phone OTP on Signup"
                            description="Send a 6-digit SMS code to verify each user's phone number before their account is created. Disable to skip verification (useful during testing)."
                            checked={phoneVerificationEnabled}
                            onCheckedChange={setPhoneVerificationEnabled}
                        />
                    </SettingsPanel>
                </TabsContent>

                {/* ── Page Access ──────────────────────────────────────────────── */}
                <TabsContent value="access" className="space-y-4 mt-4">
                    <SettingsPanel
                        title="Page Access Control"
                        description="Control which pages are accessible to non-admin users. Admins always retain full access. Disabled pages are hidden from navigation and blocked if accessed directly."
                        icon={Globe}
                    >
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <ToggleRow compact label="Dashboard" description="Main dashboard home page" checked={pageAccessDashboard} onCheckedChange={setPageAccessDashboard} />
                            <ToggleRow compact label="Data Packages" description="Browse and purchase data" checked={pageAccessDataPackages} onCheckedChange={setPageAccessDataPackages} />
                            <ToggleRow compact label="Orders" description="Order history and status" checked={pageAccessOrders} onCheckedChange={setPageAccessOrders} />
                            <ToggleRow compact label="Wallet" description="Balance and top-up" checked={pageAccessWallet} onCheckedChange={setPageAccessWallet} />
                            <ToggleRow compact label="Complaints" description="Submit and track complaints" checked={pageAccessComplaints} onCheckedChange={setPageAccessComplaints} />
                            <ToggleRow compact label="Notifications" description="View system notifications" checked={pageAccessNotifications} onCheckedChange={setPageAccessNotifications} />
                            <ToggleRow compact label="Profile" description="User profile and settings" checked={pageAccessProfile} onCheckedChange={setPageAccessProfile} />
                            <ToggleRow compact label="Shop Management" description="Agent shop, pricing, and orders" checked={pageAccessShop} onCheckedChange={setPageAccessShop} />
                            <ToggleRow compact label="Buy Airtime" description="MTN, Telecel, AT airtime" checked={pageAccessAirtime} onCheckedChange={setPageAccessAirtime} />
                            <ToggleRow compact label="Results Checker" description="Exam result vouchers" checked={pageAccessResultsChecker} onCheckedChange={setPageAccessResultsChecker} />
                            <ToggleRow compact label="Membership / Upgrade" description="Agent plans and subscriptions" checked={pageAccessUpgrade} onCheckedChange={setPageAccessUpgrade} />
                            <ToggleRow compact label="Transactions" description="Payment and wallet history" checked={pageAccessTransactions} onCheckedChange={setPageAccessTransactions} />
                            <ToggleRow compact label="AFA Application" description="Field Agent registration" checked={pageAccessAfaOrders} onCheckedChange={setPageAccessAfaOrders} />
                            <ToggleRow compact label="Sub-Agents" description="Recruit and manage sub-agents" checked={pageAccessRecruit} onCheckedChange={setPageAccessRecruit} />
                            <ToggleRow compact label="Commission Wallet" description="Recruiter earnings and withdrawals" checked={pageAccessCommission} onCheckedChange={setPageAccessCommission} />
                            <ToggleRow compact label="SMS Platform" description="Bulk SMS sending" checked={pageAccessSms} onCheckedChange={setPageAccessSms} />
                            <ToggleRow compact label="Developer API" description="API keys and documentation" checked={pageAccessDeveloperApi} onCheckedChange={setPageAccessDeveloperApi} />
                            <ToggleRow compact color="emerald" label="Public Storefront" description="Disabling takes all shops offline" checked={pageAccessStorefront} onCheckedChange={setPageAccessStorefront} />
                        </div>
                    </SettingsPanel>
                </TabsContent>

                {/* ── Landing Page ─────────────────────────────────────────────── */}
                <TabsContent value="landing" className="space-y-4 mt-4">
                    <SettingsPanel title="Customer Count Display" description={'Number shown on the landing page social proof section (e.g. "5,000+" or "10,000+").'} icon={Users}>
                        <SettingField label="Customer Count Label" hint={'Include the "+" sign if desired. The counter animates up to the numeric portion.'}>
                            <Input
                                value={landingCustomerCount}
                                onChange={e => setLandingCustomerCount(e.target.value)}
                                placeholder="e.g. 5,000+"
                                maxLength={20}
                                className="max-w-[200px]"
                            />
                        </SettingField>
                    </SettingsPanel>

                    <SettingsPanel title="Popular Data Packages" description="Displayed on the landing page as featured pricing. Only fully filled rows are saved." icon={CreditCard}>
                        <div className="space-y-3">
                            {landingDataPackages.map((pkg, i) => (
                                <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 items-end">
                                    <div className="space-y-1">
                                        {i === 0 && <Label className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Network</Label>}
                                        <Input placeholder="e.g. MTN" value={pkg.network} onChange={e => { const u = [...landingDataPackages]; u[i] = { ...u[i], network: e.target.value }; setLandingDataPackages(u) }} />
                                    </div>
                                    <div className="space-y-1">
                                        {i === 0 && <Label className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Volume</Label>}
                                        <Input placeholder="e.g. 1GB" value={pkg.volume} onChange={e => { const u = [...landingDataPackages]; u[i] = { ...u[i], volume: e.target.value }; setLandingDataPackages(u) }} />
                                    </div>
                                    <div className="space-y-1">
                                        {i === 0 && <Label className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Price (GHS)</Label>}
                                        <Input placeholder="e.g. 4.30" value={pkg.price} onChange={e => { const u = [...landingDataPackages]; u[i] = { ...u[i], price: e.target.value }; setLandingDataPackages(u) }} />
                                    </div>
                                    <Button type="button" variant="ghost" size="icon" className="text-destructive hover:bg-destructive/10" onClick={() => setLandingDataPackages(landingDataPackages.filter((_, idx) => idx !== i))}>
                                        <Trash2 className="w-4 h-4" />
                                    </Button>
                                </div>
                            ))}
                            <Button type="button" variant="outline" size="sm" onClick={() => setLandingDataPackages([...landingDataPackages, EMPTY_PACKAGE()])}>
                                <Plus className="w-4 h-4 mr-1" /> Add Package
                            </Button>
                        </div>
                    </SettingsPanel>

                    <SettingsPanel title="Agent Membership Plans" description="Pricing cards shown on the landing page. Key must be unique (e.g. 3d, 14d, 30d, permanent)." icon={Star}>
                        <div className="space-y-4">
                            {landingAgentPlans.map((plan, i) => (
                                <div key={i} className="p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-800/30 space-y-3">
                                    <div className="flex items-center justify-between">
                                        <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">Plan {i + 1}</p>
                                        <Button type="button" variant="ghost" size="icon" className="text-destructive hover:bg-destructive/10 h-7 w-7" onClick={() => setLandingAgentPlans(landingAgentPlans.filter((_, idx) => idx !== i))}>
                                            <Trash2 className="w-3.5 h-3.5" />
                                        </Button>
                                    </div>
                                    <div className="grid grid-cols-2 gap-2">
                                        <SettingField label="Key (unique ID)"><Input placeholder="e.g. 3d" value={plan.key} onChange={e => { const u = [...landingAgentPlans]; u[i] = { ...u[i], key: e.target.value }; setLandingAgentPlans(u) }} /></SettingField>
                                        <SettingField label="Title"><Input placeholder="e.g. Starter" value={plan.title} onChange={e => { const u = [...landingAgentPlans]; u[i] = { ...u[i], title: e.target.value }; setLandingAgentPlans(u) }} /></SettingField>
                                        <SettingField label="Duration"><Input placeholder="e.g. 3 Days Access" value={plan.duration} onChange={e => { const u = [...landingAgentPlans]; u[i] = { ...u[i], duration: e.target.value }; setLandingAgentPlans(u) }} /></SettingField>
                                        <SettingField label="Price (GHS)"><Input placeholder="e.g. 9.99" value={plan.price} onChange={e => { const u = [...landingAgentPlans]; u[i] = { ...u[i], price: e.target.value }; setLandingAgentPlans(u) }} /></SettingField>
                                        <SettingField label="Old Price (optional)"><Input placeholder="e.g. 12.99" value={plan.oldPrice || ''} onChange={e => { const u = [...landingAgentPlans]; u[i] = { ...u[i], oldPrice: e.target.value }; setLandingAgentPlans(u) }} /></SettingField>
                                        <SettingField label="Badge (optional)"><Input placeholder="e.g. Best Value" value={plan.badge || ''} onChange={e => { const u = [...landingAgentPlans]; u[i] = { ...u[i], badge: e.target.value }; setLandingAgentPlans(u) }} /></SettingField>
                                    </div>
                                </div>
                            ))}
                            <Button type="button" variant="outline" size="sm" onClick={() => setLandingAgentPlans([...landingAgentPlans, EMPTY_PLAN()])}>
                                <Plus className="w-4 h-4 mr-1" /> Add Plan
                            </Button>
                        </div>
                    </SettingsPanel>

                    <SettingsPanel title="Customer Testimonials" description="Reviews shown on the landing page. Minimum 3 required to display the section. Maximum 6 shown." icon={Users}>
                        <div className="space-y-4">
                            {landingTestimonials.map((t, i) => (
                                <div key={i} className="p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-800/30 space-y-3">
                                    <div className="flex items-center justify-between">
                                        <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">Review {i + 1}</p>
                                        <Button type="button" variant="ghost" size="icon" className="text-destructive hover:bg-destructive/10 h-7 w-7" onClick={() => setLandingTestimonials(landingTestimonials.filter((_, idx) => idx !== i))}>
                                            <Trash2 className="w-3.5 h-3.5" />
                                        </Button>
                                    </div>
                                    <div className="grid grid-cols-2 gap-2">
                                        <SettingField label="Name"><Input maxLength={60} placeholder="e.g. Efua A." value={t.name} onChange={e => { const u = [...landingTestimonials]; u[i] = { ...u[i], name: e.target.value }; setLandingTestimonials(u) }} /></SettingField>
                                        <SettingField label="Role / Location"><Input maxLength={80} placeholder="e.g. Retail Buyer - Accra" value={t.role} onChange={e => { const u = [...landingTestimonials]; u[i] = { ...u[i], role: e.target.value }; setLandingTestimonials(u) }} /></SettingField>
                                        <SettingField label="Rating (1–5)"><Input type="number" min={1} max={5} value={t.rating} onChange={e => { const u = [...landingTestimonials]; u[i] = { ...u[i], rating: Math.max(1, Math.min(5, Number(e.target.value))) }; setLandingTestimonials(u) }} /></SettingField>
                                    </div>
                                    <SettingField label="Quote"><Input maxLength={300} placeholder="Customer quote..." value={t.quote} onChange={e => { const u = [...landingTestimonials]; u[i] = { ...u[i], quote: e.target.value }; setLandingTestimonials(u) }} /></SettingField>
                                </div>
                            ))}
                            <Button type="button" variant="outline" size="sm" onClick={() => setLandingTestimonials([...landingTestimonials, EMPTY_TESTIMONIAL()])}>
                                <Plus className="w-4 h-4 mr-1" /> Add Review
                            </Button>
                        </div>
                    </SettingsPanel>
                </TabsContent>

                {/* ── USSD ─────────────────────────────────────────────────── */}
                <TabsContent value="ussd" className="space-y-4 mt-4">
                    <SettingsPanel
                        title="USSD Master Control"
                        description="Global on/off switch for the *713*9939# USSD service"
                        icon={Phone}
                    >
                        <ToggleRow
                            label="Enable USSD Service"
                            description="Turn off to disable the entire USSD service (*713*9939#) instantly. Customers will see a maintenance message."
                            checked={ussdEnabled}
                            onCheckedChange={setUssdEnabled}
                            color="emerald"
                        />
                    </SettingsPanel>

                    <SettingsPanel
                        title="USSD Service Menu"
                        description="Control which services appear on the USSD menu. Disabling a service removes it from the menu and renumbers remaining options automatically."
                        icon={Zap}
                    >
                        <div className="space-y-2">
                            <ToggleRow
                                compact
                                label="Data Bundles"
                                description="MTN, Telecel, AT-iShare, AT-BigTime bundles"
                                checked={ussdDataEnabled}
                                onCheckedChange={setUssdDataEnabled}
                            />
                            <ToggleRow
                                compact
                                label="Results Checker"
                                description="WAEC, BECE and other exam PIN vouchers"
                                checked={ussdRcEnabled}
                                onCheckedChange={setUssdRcEnabled}
                            />
                            <ToggleRow
                                compact
                                label="AFA Registration"
                                description="Agent field assistant application registration"
                                checked={ussdAfaEnabled}
                                onCheckedChange={setUssdAfaEnabled}
                            />
                        </div>
                        <div className="mt-3 p-3 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800">
                            <p className="text-xs text-amber-700 dark:text-amber-400 font-medium">
                                Menu auto-renumbers: if Data Bundles is off, Results Checker becomes option 1, AFA becomes option 2, and so on.
                            </p>
                        </div>
                    </SettingsPanel>

                    <SettingsPanel
                        title="USSD Pricing & Limits"
                        description="Pricing and session configuration for USSD users"
                        icon={CreditCard}
                    >
                        <SettingField
                            label="AFA Registration Fee — USSD Guest Users (GHS)"
                            hint="Applied to USSD users with no KiNG FLEXY account. Registered users pay their role price."
                        >
                            <Input
                                type="number"
                                step="0.5"
                                min="0"
                                value={ussdAfaPrice}
                                onChange={e => setUssdAfaPrice(e.target.value)}
                                className="max-w-xs"
                                placeholder="15.00"
                            />
                        </SettingField>
                        <SettingField
                            label="Max Results Checker PINs per USSD Transaction"
                            hint="Maximum number of exam PINs a user can buy in a single USSD session. Users needing more are directed to the website for bulk pricing."
                        >
                            <Input
                                type="number"
                                min="1"
                                max="10"
                                value={ussdMaxRcQty}
                                onChange={e => setUssdMaxRcQty(e.target.value)}
                                className="max-w-xs"
                                placeholder="3"
                            />
                        </SettingField>
                        <SettingField
                            label="Session Resume Window (minutes)"
                            hint="How long (in minutes) a timed-out session can be resumed. After this window, users must start fresh."
                        >
                            <Input
                                type="number"
                                min="5"
                                max="120"
                                value={ussdResumeMinutes}
                                onChange={e => setUssdResumeMinutes(e.target.value)}
                                className="max-w-xs"
                                placeholder="30"
                            />
                        </SettingField>
                    </SettingsPanel>
                </TabsContent>

                {/* ── MoMo Claims ──────────────────────────────────────────── */}
                <TabsContent value="momo" className="space-y-4 mt-4">
                    <SettingsPanel
                        title="Mobile Money Claims"
                        description="Customers who pay by MoMo but aren't auto-credited can submit a claim. Review, match, and resolve claims from the dedicated MoMo Claims center."
                        icon={Wallet}
                    >
                        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                            <p className="text-sm text-slate-500 dark:text-slate-400 flex-1">
                                Claim review, transaction matching, and crediting live on the MoMo Claims page so they stay close to the payment records.
                            </p>
                            <Link href="/admin/momo-claims">
                                <Button variant="outline" className="gap-2 h-9 text-xs font-bold">
                                    Open MoMo Claims <ExternalLink className="w-3.5 h-3.5" />
                                </Button>
                            </Link>
                        </div>
                    </SettingsPanel>
                </TabsContent>
            </Tabs>
        </div>
    )
}
