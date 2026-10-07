import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'

export interface PageAccessSettings {
    dashboard: boolean
    dataPackages: boolean
    orders: boolean
    wallet: boolean
    complaints: boolean
    notifications: boolean
    profile: boolean
    shop: boolean
    storefront: boolean
    airtime: boolean
    resultsChecker: boolean
    upgrade: boolean
    transactions: boolean
    afaOrders: boolean
    recruit: boolean
    commission: boolean
    sms: boolean
    developerApi: boolean
}

// Audited 2026-09-18: /dashboard/recruit, /dashboard/commission, /dashboard/sms
// and /dashboard/api were real dashboard pages (all four in userNavItems/the
// sidebar's own Sub-Agents block, components/dashboard/sidebar.tsx) with NO
// entry here at all — PageAccessGuard (components/dashboard/page-access-guard.tsx)
// wraps every /dashboard/* route by path, but isPageAccessible() below falls back
// to `true` for any route missing from this map, so an admin disabling those
// sections had no lever to pull. Added so all four now go through the same
// enforcement every other dashboard page already has.
const PAGE_ROUTE_MAP: Record<string, keyof PageAccessSettings> = {
    '/dashboard': 'dashboard',
    '/dashboard/data-packages': 'dataPackages',
    '/dashboard/my-orders': 'orders',
    '/dashboard/wallet': 'wallet',
    '/dashboard/complaints': 'complaints',
    '/dashboard/notifications': 'notifications',
    '/dashboard/profile': 'profile',
    '/dashboard/shop': 'shop',
    '/dashboard/airtime': 'airtime',
    '/dashboard/results-checker': 'resultsChecker',
    '/dashboard/upgrade': 'upgrade',
    '/dashboard/transactions': 'transactions',
    '/dashboard/afa-orders': 'afaOrders',
    '/dashboard/recruit': 'recruit',
    '/dashboard/commission': 'commission',
    '/dashboard/sms': 'sms',
    '/dashboard/api': 'developerApi',
}

export function usePageAccess() {
    const [pageAccess, setPageAccess] = useState<PageAccessSettings>({
        dashboard: true,
        dataPackages: true,
        orders: true,
        wallet: true,
        complaints: true,
        notifications: true,
        profile: true,
        shop: true,
        storefront: true,
        airtime: true,
        resultsChecker: true,
        upgrade: true,
        transactions: true,
        afaOrders: true,
        recruit: true,
        commission: true,
        sms: true,
        developerApi: true,
    })
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        fetchPageAccess()
    }, [])

    const fetchPageAccess = async () => {
        try {
            const response = await fetch('/api/settings/page-access')
            if (!response.ok) throw new Error('Failed to fetch settings')
            const settingsMap = await response.json()

            setPageAccess({
                dashboard: settingsMap.page_access_dashboard !== 'false',
                dataPackages: settingsMap.page_access_data_packages !== 'false',
                orders: settingsMap.page_access_orders !== 'false',
                wallet: settingsMap.page_access_wallet !== 'false',
                complaints: settingsMap.page_access_complaints !== 'false',
                notifications: settingsMap.page_access_notifications !== 'false',
                profile: settingsMap.page_access_profile !== 'false',
                shop: settingsMap.page_access_shop !== 'false',
                storefront: settingsMap.page_access_storefront !== 'false',
                airtime: settingsMap.page_access_airtime !== 'false',
                resultsChecker: settingsMap.page_access_results_checker !== 'false',  // Fixed: was 'results_checker_enabled'
                upgrade: settingsMap.page_access_upgrade !== 'false',
                transactions: settingsMap.page_access_transactions !== 'false',
                afaOrders: settingsMap.page_access_afa_orders !== 'false',
                recruit: settingsMap.page_access_recruit !== 'false',
                commission: settingsMap.page_access_commission !== 'false',
                sms: settingsMap.page_access_sms !== 'false',
                developerApi: settingsMap.page_access_developer_api !== 'false',
            })
        } catch (error) {
            console.error('Error fetching page access settings:', error)
            // On error, default to all pages accessible
        } finally {
            setLoading(false)
        }
    }

    const isPageAccessible = (route: string): boolean => {
        // Find best match allowing prefixes for shop routes
        if (route.startsWith('/dashboard/shop')) {
            return pageAccess.shop
        }

        const pageKey = PAGE_ROUTE_MAP[route]
        return pageKey ? pageAccess[pageKey] : true
    }

    return { pageAccess, isPageAccessible, loading }
}
