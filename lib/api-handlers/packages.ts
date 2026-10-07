// lib/api-handlers/packages.ts
//
// Handler for GET /api/v2/packages. See lib/api-handlers/README-style note below.
//
// ── WHY HANDLERS LIVE HERE AND NOT IN THE ROUTE FILES ──────────────────────
// This file used to be shared between /api/v1/packages and /api/v2/packages
// during the v1→v2 migration (v1 has since been retired and removed — the
// route file is gone, this handler is not). The one-body-per-endpoint
// discipline stays: the one thing this codebase has proven repeatedly is that
// a second copy of a route body drifts. Three private copies of the
// fulfillment dispatcher drifted until two of them could not reach the only
// suppliers that were actually switched on; the airtime and AFA v2 routes
// duplicated dashboard money logic and diverged on day one (review finding
// I6/I5). Keeping each endpoint's body here, with the route file as a thin
// re-export, is what prevents that class of bug.
import { NextRequest } from 'next/server'
import {
    validateApiKey,
    isApiError,
    apiSuccess,
    apiError,
    logApiRequest,
    getClientIp,
} from '@/lib/api-auth'
import { versionMeta } from '@/lib/api-version'

const VALID_NETWORKS = ['MTN', 'Telecel', 'AT-iShare', 'AT-BigTime']

export async function handlePackages(request: NextRequest) {
    const startTime = Date.now()
    const ip = getClientIp(request)
    const endpoint = request.nextUrl.pathname
    const meta = versionMeta(endpoint)

    const auth = await validateApiKey(request)
    if (isApiError(auth)) {
        logApiRequest({
            apiKeyId: null,
            userId: null,
            endpoint,
            method: 'GET',
            statusCode: auth.status,
            responseTimeMs: Date.now() - startTime,
            ip,
            errorMessage: 'Authentication failed',
        })
        return auth
    }

    try {
        const { userId, apiKeyId, effectiveRole, supabase } = auth

        // ── Parse query params ────────────────────────────────────────────
        const url = new URL(request.url)
        const networkFilter = url.searchParams.get('network')
        const sizeGbFilter = url.searchParams.get('size_gb')

        if (networkFilter && !VALID_NETWORKS.includes(networkFilter)) {
            logApiRequest({ apiKeyId, userId, endpoint, method: 'GET', statusCode: 400, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Invalid network filter' })
            return apiError(400, `Invalid network. Must be one of: ${VALID_NETWORKS.join(', ')}`)
        }

        if (sizeGbFilter !== null) {
            const parsed = parseFloat(sizeGbFilter)
            if (isNaN(parsed) || parsed <= 0) {
                logApiRequest({ apiKeyId, userId, endpoint, method: 'GET', statusCode: 400, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Invalid size_gb filter' })
                return apiError(400, 'size_gb must be a positive number e.g. 5')
            }
        }

        // ── Role-based pricing ────────────────────────────────────────────
        // Uses auth.effectiveRole, which applies dealer/agent expiry centrally
        // (lib/effective-role.ts). The v1 route previously ran its OWN inline
        // expiry check here with `expiry < now`, one of the three disagreeing
        // copies unified in commit 44a4059f — and the last one still outside
        // that unification. Two things improve as a result: the price QUOTED
        // here is now guaranteed to be the price /data/purchase actually
        // CHARGES (they read the same value), and the extra per-request
        // `users` round-trip this route used to make for the expiry columns is
        // gone, since validateApiKey already selected them.
        const isActiveDealer = effectiveRole === 'dealer'
        const isActiveAgent = effectiveRole === 'agent'

        // ── Query packages ────────────────────────────────────────────────
        let query = (supabase.from('data_packages') as any)
            .select('id, network, size, price, dealer_price, agent_price')
            .eq('is_available', true)
            .neq('category', 'mtn_mashup')
            .order('network', { ascending: true })
            .order('size', { ascending: true })

        if (networkFilter) query = query.eq('network', networkFilter)

        if (sizeGbFilter) {
            const sizeString = `${parseFloat(sizeGbFilter)}GB`
            query = query.eq('size', sizeString)
        }

        const { data: packages, error: pkgError } = await query

        if (pkgError) {
            console.error('[API Packages] Query error:', pkgError.message)
            logApiRequest({ apiKeyId, userId, endpoint, method: 'GET', statusCode: 500, responseTimeMs: Date.now() - startTime, ip, errorMessage: pkgError.message })
            return apiError(500, 'Failed to fetch packages')
        }

        // ── Shape response with role-based price ──────────────────────────
        const shaped = ((packages as any[]) || []).map((pkg: any) => {
            const sizeGb = parseFloat(pkg.size) || 0
            const price = isActiveDealer && pkg.dealer_price > 0
                ? parseFloat(pkg.dealer_price)
                : isActiveAgent && pkg.agent_price > 0
                    ? parseFloat(pkg.agent_price)
                    : parseFloat(pkg.price)

            return {
                id: pkg.id,
                network: pkg.network,
                size: pkg.size,
                volume_gb: sizeGb,
                price,
                currency: 'GHS',
            }
        })

        logApiRequest({
            apiKeyId,
            userId,
            endpoint,
            method: 'GET',
            statusCode: 200,
            responseTimeMs: Date.now() - startTime,
            ip,
        })

        return apiSuccess({
            packages: shaped,
            total: shaped.length,
        }, meta)

    } catch (error: any) {
        console.error('[API Packages] Error:', error.message)
        logApiRequest({
            apiKeyId: auth.apiKeyId,
            userId: auth.userId,
            endpoint,
            method: 'GET',
            statusCode: 500,
            responseTimeMs: Date.now() - startTime,
            ip,
            errorMessage: error.message,
        })
        return apiError(500, 'Internal server error')
    }
}
