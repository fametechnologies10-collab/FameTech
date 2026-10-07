/**
 * Client-side pricing cache utility
 * Reduces API calls to /api/admin/get-prices by caching prices in sessionStorage.
 *
 * Security notes:
 * - sessionStorage is preferred over localStorage: it is scoped to the browser
 *   tab and cleared automatically when the tab is closed, reducing the window
 *   for client-side cache manipulation.
 * - Prices stored here are DISPLAY-ONLY. The authoritative price for any charge
 *   is always resolved server-side at payment initialization time.
 * - Cache expires after 5 minutes regardless.
 */

const CACHE_KEY = 'agent_pricing_cache'
const CACHE_DURATION = 5 * 60 * 1000 // 5 minutes

export interface PricingData {
    prices: {
        '3d': number
        '14d': number
        '30d': number
        'permanent': number
    } | null
    oldPrices: {
        '3d': number
        '14d': number
        '30d': number
        'permanent': number
    } | null
    showStrikethrough: boolean
    dealerPrice?: number
    dealerPrice1m?: number
    dealerPrice3m?: number
    guestStorefrontUrl: string
    whatsappGroupLink: string
    whatsappChannelLink: string
    whatsappAdminNumber: string
    whatsappCommunityLink: string
}

interface CachedData extends PricingData {
    timestamp: number
}

/**
 * Get pricing data from cache or fetch from API if cache is expired/missing.
 * Uses sessionStorage (tab-scoped) to reduce manipulation window.
 */
export async function getCachedPricing(): Promise<PricingData> {
    // Check if we're in browser environment
    if (typeof window === 'undefined') {
        return fetchPricingFromAPI()
    }

    try {
        // Use sessionStorage (clears on tab close, harder to persist tampering)
        const cached = sessionStorage.getItem(CACHE_KEY)

        if (cached) {
            const data: CachedData = JSON.parse(cached)
            const isExpired = Date.now() - data.timestamp > CACHE_DURATION

            if (!isExpired) {
                return {
                    prices: data.prices,
                    oldPrices: data.oldPrices,
                    showStrikethrough: data.showStrikethrough,
                    dealerPrice: data.dealerPrice,
                    dealerPrice1m: data.dealerPrice1m,
                    dealerPrice3m: data.dealerPrice3m,
                    guestStorefrontUrl: data.guestStorefrontUrl,
                    whatsappGroupLink: data.whatsappGroupLink,
                    whatsappChannelLink: data.whatsappChannelLink,
                    whatsappAdminNumber: data.whatsappAdminNumber,
                    whatsappCommunityLink: data.whatsappCommunityLink,
                }
            }
        }
    } catch (error) {
        console.error('[pricing-cache] Failed to read cache:', {
            error: error instanceof Error ? error.message : 'unknown',
        })
    }

    return fetchPricingFromAPI()
}

/**
 * Fetch pricing from API and cache the result in sessionStorage.
 */
async function fetchPricingFromAPI(): Promise<PricingData> {
    const response = await fetch('/api/admin/get-prices', {
        cache: 'no-store',
    })

    if (!response.ok) {
        throw new Error(`[pricing-cache] API returned ${response.status}`)
    }

    const data: PricingData = await response.json()

    // Only cache if we got actual price data — don't poison the cache with
    // a null-price response that arrived before auth was fully established.
    if (typeof window !== 'undefined' && data.prices !== null) {
        try {
            const cacheData: CachedData = {
                ...data,
                timestamp: Date.now(),
            }
            // sessionStorage — tab-scoped, cleared when tab closes
            sessionStorage.setItem(CACHE_KEY, JSON.stringify(cacheData))
        } catch (error) {
            // Non-critical — QuotaExceededError or private browsing; continue without cache
            console.error('[pricing-cache] Failed to write cache:', {
                error: error instanceof Error ? error.message : 'unknown',
            })
        }
    }

    return data
}

/**
 * Clear the pricing cache (sessionStorage).
 * Should be called when admin updates prices so the next fetch is fresh.
 */
export function clearPricingCache(): void {
    if (typeof window !== 'undefined') {
        try {
            sessionStorage.removeItem(CACHE_KEY)
        } catch (error) {
            console.error('[pricing-cache] Failed to clear cache:', {
                error: error instanceof Error ? error.message : 'unknown',
            })
        }
    }
}

/**
 * Check if a valid (non-expired) pricing cache entry exists in sessionStorage.
 */
export function hasCachedPricing(): boolean {
    if (typeof window === 'undefined') return false

    try {
        const cached = sessionStorage.getItem(CACHE_KEY)
        if (!cached) return false

        const data: CachedData = JSON.parse(cached)
        return Date.now() - data.timestamp <= CACHE_DURATION
    } catch {
        return false
    }
}




