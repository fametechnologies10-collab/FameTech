import { z } from 'zod'
import { phoneSchema } from '@/lib/validation'

// Shop withdrawals are mobile-money only — bank payouts were removed. Keep this
// the single source of truth so the route and its tests can't drift.
export const WITHDRAW_NETWORKS = ['MTN MoMo', 'Telecel Cash', 'AirtelTigo Money'] as const

const MAX_WITHDRAW_AMOUNT = 1_000_000

export function roundMoney(n: number): number {
    return Math.round((n + Number.EPSILON) * 100) / 100
}

/**
 * Parses a client-supplied amount. Accepts a number or a plain decimal string,
 * both limited to 2 decimal places (the wallet columns are numeric(12,2); a
 * sub-cent amount would be debited unrounded but recorded rounded).
 * Returns null for anything else.
 */
export function parseWithdrawAmount(input: unknown): number | null {
    let n: number
    if (typeof input === 'number') {
        n = input
    } else if (typeof input === 'string' && /^\d+(\.\d{1,2})?$/.test(input)) {
        n = Number(input)
    } else {
        return null
    }
    if (!Number.isFinite(n) || n <= 0 || n > MAX_WITHDRAW_AMOUNT) return null
    if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) return null
    return roundMoney(n)
}

// Manual fallback name — strict allowlist to prevent injection/abuse.
// Allowed: letters (incl. accented), spaces, hyphen, apostrophe, period.
const MANUAL_NAME_REGEX = /^[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ '.\-]{1,99}$/
const MANUAL_NAME_BLOCK = /(script|javascript:|onerror|onload|onclick|onmouseover|eval\(|data:|<|>|&lt|&gt)/i
const manualAccountNameSchema = z.string()
    .trim()
    .min(2, 'Name must be at least 2 characters')
    .max(100, 'Name must be 100 characters or less')
    .regex(MANUAL_NAME_REGEX, 'Only letters, spaces, hyphens, apostrophes and periods allowed')
    .refine((v: string) => !/\s{2,}/.test(v), 'No consecutive spaces allowed')
    .refine((v: string) => !MANUAL_NAME_BLOCK.test(v), 'Invalid characters detected')

export const withdrawSchema = z.object({
    amount: z.union([z.number(), z.string()])
        .transform((v, ctx) => {
            const parsed = parseWithdrawAmount(v)
            if (parsed === null) {
                ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a valid amount (max 2 decimal places)' })
                return z.NEVER
            }
            return parsed
        }),
    // Stored and paid out in local 0XXXXXXXXX form regardless of how it was typed.
    momoNumber: phoneSchema.transform((v: string) => (v.startsWith('+233') ? '0' + v.slice(4) : v)),
    network: z.enum(WITHDRAW_NETWORKS),
    // Old clients still send payment_type: only 'momo' is accepted now.
    payment_type: z.literal('momo').optional(),
    saveForLater: z.boolean().optional(),
    manualAccountName: manualAccountNameSchema.optional(),
    // When a saved payment detail is selected the server fetches the stored
    // verified name + number from the DB — the name lookup is skipped.
    savedDetailId: z.string().uuid('Invalid saved detail ID').optional(),
    // App-lock PIN, required server-side when the user has one set.
    pin: z.string().regex(/^\d{6}$/, 'PIN must be 6 digits').optional(),
})

export type WithdrawInput = z.infer<typeof withdrawSchema>

export interface WithdrawEligibilityInput {
    userStatus: string | null | undefined
    shopApproval: string | null | undefined
}

/**
 * Server-side gate for who may request a payout. Account suspension is otherwise
 * only enforced client-side, so a suspended user (or a shop an admin rejected /
 * suspended) could still call the API directly. A shop that is merely 'pending'
 * or absent is allowed: commission-only owners hold a wallet without a live shop.
 */
export function checkWithdrawEligibility(
    input: WithdrawEligibilityInput
): { ok: true } | { ok: false; reason: string } {
    if (input.userStatus !== 'active') {
        return { ok: false, reason: 'Your account is not active. Contact support to withdraw.' }
    }
    if (input.shopApproval === 'suspended' || input.shopApproval === 'rejected') {
        return { ok: false, reason: 'Your shop is not active. Contact support to withdraw.' }
    }
    return { ok: true }
}
