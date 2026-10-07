import type { HubtelRequest, HubtelResponse, USSDState } from './types'
import { respond, normalizePhone } from './utils'

// =============================================================================
// "Who is this for?" — shared beneficiary picker for USSD flows.
// 1. My Self      → use the dialer's own number (Hubtel's req.Mobile)
// 2. Someone Else → fall through to the existing "enter phone number" prompt
// 0. Back
// =============================================================================

export type BeneficiaryChoice = 'self' | 'other' | 'back' | 'invalid'

interface MenuOptions {
    title?: string
    otherLabel?: string
}

export function parseBeneficiaryChoice(input: string): BeneficiaryChoice {
    switch (input.trim()) {
        case '1': return 'self'
        case '2': return 'other'
        case '0': return 'back'
        default:  return 'invalid'
    }
}

/**
 * The "self" number is ALWAYS derived from the current request's Hubtel MSISDN —
 * never from ClientState — so a replayed/tampered state can't point "My Self" at
 * someone else's number.
 */
export function selfBeneficiaryPhone(mobile: string): string {
    return normalizePhone(mobile)
}

export function beneficiaryMenuText(mobile: string, opts: MenuOptions = {}): string {
    const { title = 'Who is this for?', otherLabel = 'Someone Else' } = opts
    return [
        title,
        `1. My Self (${selfBeneficiaryPhone(mobile)})`,
        `2. ${otherLabel}`,
        '0. Back',
    ].join('\n')
}

/** Render the picker and park the session on `step`. */
export function showBeneficiaryMenu(
    req: HubtelRequest,
    state: USSDState,
    step: string,
    opts: MenuOptions = {},
): HubtelResponse {
    return respond(req.SessionId, beneficiaryMenuText(req.Mobile, opts), { ...state, step }, 'Beneficiary')
}
