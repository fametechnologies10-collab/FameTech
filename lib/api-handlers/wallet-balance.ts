// lib/api-handlers/wallet-balance.ts
// Handler for GET /api/v2/wallet/balance.
// See lib/api-handlers/packages.ts for why handlers live here.
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

export async function handleWalletBalance(request: NextRequest) {
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
        const { userId, apiKeyId, supabase } = auth

        const { data: wallet, error: walletError } = await supabase
            .from('wallets')
            .select('balance')
            .eq('user_id', userId)
            .single()

        if (walletError || !wallet) {
            logApiRequest({
                apiKeyId,
                userId,
                endpoint,
                method: 'GET',
                statusCode: 404,
                responseTimeMs: Date.now() - startTime,
                ip,
                errorMessage: 'Wallet not found',
            })
            return apiError(404, 'Wallet not found')
        }

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
            balance: parseFloat(String((wallet as any).balance)) || 0,
            currency: 'GHS',
        }, meta)

    } catch (error: any) {
        console.error('[API Wallet Balance] Error:', error.message)
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
