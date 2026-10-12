export interface ClaimHttpError {
    status: number
    body: Record<string, unknown>
}

export const GENERIC_CLAIM_ERROR = 'Unable to claim this transaction. Please check the details and try again.'

/**
 * Maps the claim RPC's error result to an HTTP response. Only a small set of
 * states are distinguishable to the caller; everything else collapses to one
 * generic error so the endpoint can't be used to probe transaction state.
 */
export function mapClaimError(res: {
    error?: string
    is_own_claim?: boolean
    claimed_at?: string
    min_claimable?: number | string
}): ClaimHttpError {
    switch (res.error) {
        case 'already_claimed':
            return {
                status: 409,
                body: {
                    error: 'already_claimed',
                    is_own_claim: res.is_own_claim,
                    claimed_at: res.claimed_at,
                },
            }
        case 'below_minimum': {
            const min = parseFloat(String(res.min_claimable)).toFixed(2)
            return {
                status: 400,
                body: { error: `Amount is below the minimum claimable amount of GH₵${min}` },
            }
        }
        case 'account_not_active':
            return {
                status: 403,
                body: { error: 'Your account is not active. Please contact support.' },
            }
        default:
            return { status: 400, body: { error: GENERIC_CLAIM_ERROR } }
    }
}

export function mapClaimLimiterBlock(reason: 'burst' | 'hourly'): ClaimHttpError {
    return {
        status: 429,
        body: {
            error:
                reason === 'burst'
                    ? 'Too many claim attempts. Please wait 30 seconds and try again.'
                    : 'Too many claim attempts. Please try again in an hour.',
        },
    }
}
