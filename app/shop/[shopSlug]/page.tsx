import { Metadata } from 'next'
import Image from 'next/image'
import { notFound } from 'next/navigation'
import { createServerClient } from '@/lib/supabase'
import { createServerComponentClient } from '@/lib/supabase-server'
import ShopStorefront from './ShopStorefront'
import { getAdminOOSNetworks, mergeOOS } from '@/lib/network-stock'
import type { UtilityBiller } from '@/lib/hubtel-utility/billers'

interface Props {
    params: Promise<{ shopSlug: string }>
}

export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const { shopSlug } = await params
    const supabase = createServerClient()

    const { data: shop } = await (supabase
        .from('shop_profiles')
        .select('shop_name, description, logo_url')
        .eq('shop_slug', shopSlug)
        .single() as any)

    if (!shop) {
        return { title: 'Shop Not Found' }
    }

    return {
        // White-label: the tab title / link preview shows the shop's own name only.
        title: shop.shop_name,
        description: shop.description || `Buy affordable data bundles from ${shop.shop_name}. Fast, secure delivery.`,
        keywords: [
            shop.shop_name,
            'data bundles Ghana',
            'buy data online',
            'cheap data Ghana',
            'airtime Ghana',
        ],
        alternates: {
            canonical: `https://shop.kingflexygh.com/${shopSlug}`,
        },
        openGraph: {
            title: shop.shop_name,
            description: shop.description || `Buy affordable data bundles from ${shop.shop_name}`,
            images: shop.logo_url ? [{ url: shop.logo_url }] : [],
            url: `https://shop.kingflexygh.com/${shopSlug}`,
            type: 'website',
            siteName: shop.shop_name,
        },
        icons: {
            icon: shop.logo_url || '/favicon.ico',
        },
    }
}

export default async function ShopPage({ params }: Props) {
    const { shopSlug } = await params
    const supabase = createServerClient()

    // We still need the standard client for the auth check later
    const supabaseAuth = await createServerComponentClient()

    // Fetch shop — include pricing_status so we can show Under Review state
    const { data: shop } = await (supabase
        .from('shop_profiles')
        .select('id, shop_name, shop_slug, description, owner_phone, owner_email, whatsapp_number, logo_url, community_link, divider_style, brand_color, brand_accent, approval_status, pricing_status, is_active, owner_id, airtime_fee_mtn, airtime_fee_telecel, airtime_fee_at, mashup_fee_percent, results_checker_markup_customer, ussd_code, ussd_active, oos_networks, utilities_enabled, afa_selling_price, paystack_fee_percent')
        .eq('shop_slug', shopSlug)
        .single() as any)

    // Note: session refresh is handled by middleware; no explicit call needed here

    // Shop doesn't exist → 404
    if (!shop) {
        notFound()
    }

    // Check Global Storefront Access Settings
    const { data: adminSettings } = await (supabase
        .from('admin_settings')
        .select('key, value')
        .in('key', [
            'page_access_storefront', 'storefront_airtime_enabled', 'storefront_mashup_enabled',
            'airtime_fee_mtn_customer', 'airtime_fee_mtn_agent',
            'airtime_fee_telecel_customer', 'airtime_fee_telecel_agent',
            'airtime_fee_at_customer', 'airtime_fee_at_agent',
            'airtime_min_amount_customer', 'airtime_max_amount_customer',
            'mashup_min_amount_customer', 'mashup_max_amount_customer',
            'results_checker_enabled', 'results_checker_storefront_enabled', 'results_checker_paystack_fee_percent', 'results_checker_max_quantity', 'results_checker_allow_backorders',
            'airtime_enabled_mtn', 'airtime_enabled_telecel', 'airtime_enabled_at',
            'utility_bills_enabled', 'storefront_utilities_enabled', 'hubtel_utility_billers', 'utility_min_amount', 'utility_max_amount',
            'storefront_afa_enabled', 'afa_price_customer', 'afa_price_agent', 'afa_price_dealer',
        ]) as any)

    const adminSettingsMap: Record<string, any> = {}
    for (const row of adminSettings || []) {
        adminSettingsMap[row.key] = row.value
    }

    // AFA's per-shop-role Paystack fee override, merged into the same flat settings
    // map so ShopStorefront can mirror lib/shop-afa-checkout.ts's fee resolution
    // exactly (shop.paystack_fee_percent -> shop_paystack_fee_percent_<role> ->
    // shop_paystack_fee_percent -> 1.95 default) for the pre-charge display price.
    const { data: paystackFeeRows } = await (supabase
        .from('shop_global_settings')
        .select('key, value')
        .in('key', ['shop_paystack_fee_percent_customer', 'shop_paystack_fee_percent_agent', 'shop_paystack_fee_percent_dealer', 'shop_paystack_fee_percent']) as any)
    for (const row of paystackFeeRows || []) {
        adminSettingsMap[row.key] = row.value
    }

    // ── Utility Bills tab gate — resolved ONCE, server-side, into a single boolean so the
    // client never re-derives gating. Mirrors the gate chain in app/api/shop/utility/lookup
    // and lib/shop-checkout.ts's 'utility' branch: global admin gates AND ≥1 biller enabled
    // AND the shop's own opt-in (shop_profiles.utilities_enabled). Sub-agent shops are allowed
    // to sell utilities same as any other shop — no sub-agent exclusion here. ──
    const { UTILITY_BILLER_KEYS } = await import('@/lib/hubtel-utility/billers')
    const { parseSettingNumber } = await import('@/lib/paystack-fees')

    const billersMapRaw = adminSettingsMap['hubtel_utility_billers']
    const enabledUtilityBillers: Partial<Record<UtilityBiller, boolean>> = {}
    for (const key of UTILITY_BILLER_KEYS as UtilityBiller[]) {
        enabledUtilityBillers[key] = !!(billersMapRaw && typeof billersMapRaw === 'object' && !Array.isArray(billersMapRaw) && billersMapRaw[key] === true)
    }
    const anyUtilityBillerEnabled = Object.values(enabledUtilityBillers).some(Boolean)

    const utilitiesEnabled =
        adminSettingsMap['utility_bills_enabled'] === 'true' &&
        adminSettingsMap['storefront_utilities_enabled'] === 'true' &&
        anyUtilityBillerEnabled &&
        shop.utilities_enabled === true

    const utilityMinAmount = parseSettingNumber(adminSettingsMap['utility_min_amount'], 1)
    const utilityMaxAmount = parseSettingNumber(adminSettingsMap['utility_max_amount'], 1000)

    // Check Global Storefront Access Settings
    const storefrontSetting = adminSettingsMap['page_access_storefront']

    // Admin pass-through check
    const { data: { user: authUser } } = await supabaseAuth.auth.getUser()
    let isAdmin = false
    if (authUser) {
        const { data: user } = await supabase
            .from('users')
            .select('role')
            .eq('id', authUser.id)
            .single()
        if ((user as any)?.role === 'admin') isAdmin = true
    }

    // Block if globally disabled and not an admin
    if (storefrontSetting === 'false' && !isAdmin) {
        return (
            <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 p-6 transition-colors duration-300">
                <div className="max-w-md w-full text-center space-y-6">
                    {shop.logo_url ? (
                        <Image src={shop.logo_url} alt={shop.shop_name} width={80} height={80} className="w-20 h-20 rounded-2xl object-cover mx-auto shadow-lg" />
                    ) : (
                        <div className="w-20 h-20 rounded-2xl bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center mx-auto shadow-lg">
                            <span className="text-3xl font-black text-emerald-600">{shop.shop_name[0]}</span>
                        </div>
                    )}

                    <div>
                        <h1 className="text-2xl font-black text-gray-900 dark:text-white">{shop.shop_name}</h1>
                        <p className="text-muted-foreground text-sm mt-1">{shop.description || 'Data bundle shop'}</p>
                    </div>

                    <div className="w-16 h-16 rounded-full bg-yellow-100 dark:bg-yellow-900/30 flex items-center justify-center mx-auto">
                        <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-yellow-600 dark:text-yellow-500"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>
                    </div>

                    <div className="p-5 rounded-2xl bg-white dark:bg-slate-900 shadow-md border border-slate-100 dark:border-slate-800 space-y-2 transition-colors">
                        <h2 className="font-bold text-lg text-gray-900 dark:text-white">Service Maintenance</h2>
                        <p className="text-sm text-muted-foreground">
                            This shop is currently undergoing scheduled maintenance and is temporarily offline. Please check back later!
                        </p>
                    </div>

                    {shop.whatsapp_number && (
                        <a
                            href={`https://wa.me/${shop.whatsapp_number}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-[#25D366] hover:bg-[#1ebe5d] text-white font-semibold text-sm transition-colors shadow-md"
                        >
                            <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" /></svg>
                            Contact on WhatsApp
                        </a>
                    )}
                </div>
            </div>
        )
    }

    // Profile not approved OR pricing not yet approved → show Under Review page
    if (shop.approval_status !== 'approved' || shop.pricing_status !== 'approved') {
        return (
            <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 p-6 transition-colors duration-300">
                <div className="max-w-md w-full text-center space-y-6">
                    {/* Logo / Icon */}
                    {shop.logo_url ? (
                        <Image src={shop.logo_url} alt={shop.shop_name} width={80} height={80} className="w-20 h-20 rounded-2xl object-cover mx-auto shadow-lg" />
                    ) : (
                        <div className="w-20 h-20 rounded-2xl bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center mx-auto shadow-lg">
                            <span className="text-3xl font-black text-emerald-600">{shop.shop_name[0]}</span>
                        </div>
                    )}

                    <div>
                        <h1 className="text-2xl font-black text-gray-900 dark:text-white">{shop.shop_name}</h1>
                        <p className="text-muted-foreground text-sm mt-1">{shop.description || 'Data bundle shop'}</p>
                    </div>

                    {/* Animated hourglass */}
                    <div className="w-16 h-16 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center mx-auto animate-pulse">
                        <span className="text-3xl">⏳</span>
                    </div>

                    <div className="p-5 rounded-2xl bg-white dark:bg-slate-900 shadow-md border border-slate-100 dark:border-slate-800 space-y-2 transition-colors">
                        <h2 className="font-bold text-lg text-gray-900 dark:text-white">Under Review</h2>
                        <p className="text-sm text-muted-foreground">
                            This shop is currently awaiting admin approval. Check back soon — it will be live shortly!
                        </p>
                    </div>

                    {/* WhatsApp contact (only if set) */}
                    {shop.whatsapp_number && (
                        <a
                            href={`https://wa.me/${shop.whatsapp_number}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-[#25D366] hover:bg-[#1ebe5d] text-white font-semibold text-sm transition-colors shadow-md"
                        >
                            <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" /></svg>
                            Contact on WhatsApp
                        </a>
                    )}
                </div>
            </div>
        )
    }

    // Fetch live approved packages with shop pricing
    // Uses service role client to bypass RLS — only selling_price is exposed to client, never cost/profit
    const supabaseAdmin = createServerClient()
    const { data: pricingRows } = await (supabaseAdmin
        .from('shop_pricing')
        .select('package_id, selling_price, data_packages(id, network, size, description, sort_order, is_available)')
        .eq('shop_id', shop.id) as any)

    const packages = (pricingRows || [])
        .filter((row: any) => row.data_packages?.is_available)
        .map((row: any) => ({
            id: row.data_packages.id,
            network: row.data_packages.network,
            size: row.data_packages.size,
            description: row.data_packages.description || null,
            sort_order: row.data_packages.sort_order ?? 999,
            selling_price: parseFloat(row.selling_price),
        }))
        .sort((a: any, b: any) => a.network.localeCompare(b.network) || a.sort_order - b.sort_order)

    // Append owner role to calculate correct max amount limits client side
    let ownerRole = 'customer'
    // Effective (expiry-aware) role for RC base pricing, so the displayed RC price matches what the
    // charge route computes for an expired reseller (customer tier). Kept separate from `ownerRole`
    // to avoid changing airtime limits here.
    let rcOwnerRole = 'customer'
    if (shop?.owner_id) {
        const { data: uData } = await supabaseAdmin.from('users').select('role, dealer_expires_at, agent_expires_at').eq('id', shop.owner_id).single()
        ownerRole = (uData as any)?.role || 'customer'
        const { effectiveRoleFromExpiry } = await import('@/lib/results-checker-service')
        rcOwnerRole = effectiveRoleFromExpiry((uData as any)?.role, (uData as any)?.agent_expires_at, (uData as any)?.dealer_expires_at)
    }

    // Fetch announcement server-side to eliminate client-side DB call per visitor
    let initialAnnouncement: { id: string; type: 'admin' | 'shop'; message: string; title?: string; cta_primary_label?: string | null; cta_primary_url?: string | null; cta_secondary_label?: string | null; cta_secondary_url?: string | null } | null = null
    const { data: adminAnn } = await (supabase as any)
        .from('system_announcements')
        .select('id, title, message, cta_primary_label, cta_primary_url, cta_secondary_label, cta_secondary_url')
        .eq('is_active', true)
        .in('visible_on', ['storefronts', 'both'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
    if (adminAnn) {
        initialAnnouncement = {
            id: adminAnn.id, type: 'admin', title: adminAnn.title, message: adminAnn.message,
            cta_primary_label: adminAnn.cta_primary_label, cta_primary_url: adminAnn.cta_primary_url,
            cta_secondary_label: adminAnn.cta_secondary_label, cta_secondary_url: adminAnn.cta_secondary_url,
        }
    } else {
        const { data: shopAnn } = await (supabase as any)
            .from('shop_announcements')
            .select('id, message')
            .eq('shop_id', shop.id)
            .eq('is_active', true)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle()
        if (shopAnn) {
            initialAnnouncement = { id: shopAnn.id, type: 'shop', message: shopAnn.message }
        }
    }

    // Fetch RC types server-side when RC is globally enabled
    let rcTypes: Array<{ id: string; name: string; customer_price: number; available_count?: number }> = []
    let rcMarkups: Record<string, number> = {}
    if (adminSettingsMap['results_checker_storefront_enabled'] === 'true') {
        const { getAvailableTypes, getPriceForRole } = await import('@/lib/results-checker-service')
        // The storefront displays — and the charge route computes — the OWNER-ROLE base price
        // (dealer/agent/customer via getPriceForRole), NOT the literal customer_price. A reseller
        // shop sells at agent/dealer_price + markup, so showing customer_price here would display a
        // price the guest is never charged. Resolve the effective base into `customer_price`.
        rcTypes = (await getAvailableTypes()).map((t: any) => ({
            id: t.id,
            name: t.name,
            customer_price: getPriceForRole(t, rcOwnerRole),
            available_count: t.available_count,
            bulk_pricing: t.bulk_pricing,
        }))

        // Per-exam-type markups override the legacy single markup
        const { data: markupRows } = await (supabase as any)
            .from('shop_rc_markups')
            .select('exam_type_id, markup')
            .eq('shop_id', shop.id)
        for (const row of (markupRows as any[]) || []) {
            rcMarkups[row.exam_type_id] = parseFloat(String(row.markup)) || 0
        }
    }

    // Compute merged OOS set: admin global ∪ this shop's own hidden networks
    const adminOOS = await getAdminOOSNetworks(supabase)
    const oosNetworks = [...mergeOOS(adminOOS, shop.oos_networks)]

    return <ShopStorefront
        shop={{ ...shop, ownerRole }}
        packages={packages}
        adminSettings={adminSettingsMap}
        initialAnnouncement={initialAnnouncement}
        rcTypes={rcTypes}
        rcMarkup={parseFloat(String(shop.results_checker_markup_customer || 0))}
        rcMarkups={rcMarkups}
        oosNetworks={oosNetworks}
        utilitiesEnabled={utilitiesEnabled}
        enabledUtilityBillers={enabledUtilityBillers}
        utilityMinAmount={utilityMinAmount}
        utilityMaxAmount={utilityMaxAmount}
    />
}
