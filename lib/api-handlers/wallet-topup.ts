// lib/api-handlers/wallet-topup.ts
// Handler for POST /api/v2/wallet/topup.
//
// This endpoint is a TOMBSTONE, not a live money path — MoMo wallet top-up via
// the API was discontinued and returns 410. Kept as an informative 410 rather
// than removed outright so a caller who still has this URL saved gets "use
// the dashboard" instead of a bare 404 indistinguishable from a typo.
import { NextRequest } from 'next/server'
import { apiError } from '@/lib/api-auth'

export async function handleWalletTopup(_request: NextRequest) {
    return apiError(410, 'This endpoint has been removed. Top up your wallet via the KiNG FLEXY GH web dashboard.')
}
