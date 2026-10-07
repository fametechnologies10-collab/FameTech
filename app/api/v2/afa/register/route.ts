import { NextRequest } from 'next/server'
import { validateApiKey, isApiError, apiSuccess, apiError, logApiRequest, getClientIp } from '@/lib/api-auth'
import { consumeRateLimit } from '@/lib/simple-rate-limit'
import { createAdminClient } from '@/lib/supabase-admin'
import { isValidGhanaPhone, normalizePhone } from '@/lib/ussd/utils'
import { validateAfaRegistration } from '@/lib/afa-validation'
import { AFA_PRICE_KEYS, resolveAfaPrice } from '@/lib/afa-pricing'
import { waitUntil } from '@vercel/functions'
import { resolveSubAgentContext } from '@/lib/sub-agent-account'
import { resolveSubAgentAfaCost, AFA_PRODUCT_REF } from '@/lib/sub-agent-afa-pricing'
import { hasSubAgentPricingConfigured } from '@/lib/sub-agent-pricing'
import { recordPendingSubAgentEarning } from '@/lib/sub-agent-earnings'

// ============================================================================
// POST /api/v2/afa/register
// Mirrors app/api/user/afa-registration/route.ts's validation and RPC call
// EXACTLY — same allowlists, same regex, same age check. Only difference:
// API-key auth and a developer-supplied `reference` (prefixed API-) instead
// of a client-generated UUID. See
// docs/superpowers/specs/2026-08-24-api-v2-new-products-design.md §2.
// ============================================================================

const ENDPOINT = '/api/v2/afa/register'

// Allowlists, ID format, length caps and the 18+ check all live in
// lib/afa-validation.ts, shared with app/api/user/afa-registration. This route
// used to carry its own copy of every one of them (review finding I6) — two
// copies of a KYC allowlist that would drift the moment Ghana gains a region
// or the ID format tightens.

export async function POST(request: NextRequest) {
    const startTime = Date.now()
    const ip = getClientIp(request)

    const auth = await validateApiKey(request)
    if (isApiError(auth)) {
        logApiRequest({ apiKeyId: null, userId: null, endpoint: ENDPOINT, method: 'POST', statusCode: auth.status, responseTimeMs: Date.now() - startTime, ip, errorMessage: 'Authentication failed' })
        return auth
    }

    const { userId, apiKeyId, effectiveRole, supabase } = auth
    const done = (statusCode: number, errorMessage?: string) =>
        logApiRequest({ apiKeyId, userId, endpoint: ENDPOINT, method: 'POST', statusCode, responseTimeMs: Date.now() - startTime, ip, errorMessage })

    try {
        // Sub-agent eligibility (spec §11 lift, 2026-09-17) — mirrors app/api/user/afa-registration
        // exactly. Evaluated LIVE: a pending/suspended sub, or one whose recruiter is currently
        // ineligible, cannot transact.
        const subCtx = await resolveSubAgentContext(supabase, userId)
        if (subCtx.isSub && !subCtx.effectiveActive) {
            done(403, 'Sub-agent inactive')
            return apiError(403, subCtx.inactiveReason || 'Your account is not currently active')
        }

        const rl = consumeRateLimit(`v2-afa-register:${apiKeyId}`, 10, 60_000)
        if (!rl.allowed) {
            done(429, 'Rate limited')
            return apiError(429, `Rate limit exceeded (10/min). Retry in ${Math.ceil(rl.retryAfterMs / 1000)}s`)
        }

        let body: any
        try { body = await request.json() } catch {
            done(400, 'Invalid JSON')
            return apiError(400, 'Invalid request body')
        }

        const { reference, ...formData } = body || {}

        if (!reference || typeof reference !== 'string' || reference.length < 3 || reference.length > 100) {
            done(400, 'Invalid reference')
            return apiError(400, 'reference is required (3-100 characters) — your unique transaction ID for idempotency')
        }
        const referenceCode = `API-${reference}`

        // Phone stays here, deliberately: the two callers normalise it with
        // different helpers, so folding it into the shared validator would have
        // changed behaviour on one of them. Runs BEFORE the shared validation so
        // formData.phone is already normalised when its length cap is checked.
        if (!isValidGhanaPhone(String(formData.phone))) {
            done(400, 'Invalid phone')
            return apiError(400, 'Invalid phone number. Use format 0XXXXXXXXX or +233XXXXXXXXX.')
        }
        formData.phone = normalizePhone(String(formData.phone))

        const validation = validateAfaRegistration(formData)
        if (!validation.ok) {
            // '__config' means VALID_ID_TYPES gained an entry with no matching
            // format pattern — our configuration mistake, not the applicant's
            // input, so it must not be reported as a 400 against them.
            if (validation.field === '__config') {
                console.error(`[API v2 AFA] ${validation.message} (id_type: "${formData.id_type}")`)
                done(500, 'id_type not configured')
                return apiError(500, validation.message)
            }
            done(400, `Invalid ${validation.field}`)
            return apiError(400, validation.message)
        }

        const supabaseAdmin = createAdminClient()
        const { data: settingsData, error: settingsError } = await supabaseAdmin
            .from('admin_settings').select('key, value').in('key', AFA_PRICE_KEYS)
        if (settingsError) {
            done(500, 'Pricing not configured')
            return apiError(500, 'Registration pricing is not configured. Please contact support.')
        }
        const settingsMap: Record<string, string> = ((settingsData || []) as any[]).reduce((acc, row) => { acc[row.key] = row.value; return acc }, {} as Record<string, string>)
        let price = resolveAfaPrice(settingsMap, effectiveRole)
        if (price === null) {
            console.error(`[API v2 AFA] No usable price for role "${effectiveRole}":`, settingsMap)
            done(500, 'Pricing not configured')
            return apiError(500, 'Registration pricing is not configured. Please contact support.')
        }

        // Sub-agent pricing overrides the role price entirely (spec C2) — mirrors
        // app/api/user/afa-registration's Task 11 wiring exactly, including the
        // "unconfigured = unbuyable" server-side teeth (spec C4).
        let recruiterMargin: { recruiterId: string; amount: number } | null = null
        if (subCtx.isSub) {
            if (
                subCtx.recruiterId
                && !(await hasSubAgentPricingConfigured(supabaseAdmin, subCtx.recruiterId, userId, 'afa', AFA_PRODUCT_REF))
            ) {
                done(409, 'Sub-agent pricing unavailable')
                return apiError(409, 'Pricing is not available for this service right now')
            }
            const afaSubCtx = await resolveSubAgentAfaCost(supabaseAdmin, userId, settingsMap)
            if (!afaSubCtx.ok) {
                console.error(`[API v2 AFA] sub cost unresolvable for user ${userId}: ${afaSubCtx.reason}`)
                done(409, 'Sub-agent cost unresolvable')
                return apiError(409, 'Pricing is not available for this service right now')
            }
            price = afaSubCtx.subCost
            if (afaSubCtx.recruiterEarns > 0 && afaSubCtx.recruiterId) {
                recruiterMargin = { recruiterId: afaSubCtx.recruiterId, amount: afaSubCtx.recruiterEarns }
            }
        }

        const { data: rpcResult, error: rpcError } = await (supabaseAdmin as any).rpc('process_afa_order', {
            p_user_id: userId, p_amount: price, p_form_data: formData, p_reference_code: referenceCode,
        })

        if (rpcError) {
            if (rpcError.constraint === 'afa_orders_reference_code_unique' || rpcError.code === '23505' || rpcError.message?.includes('afa_orders_reference_code_unique') || rpcError.message?.includes('duplicate key')) {
                const { data: existingOrder } = await (supabase.from('afa_orders') as any)
                    .select('id, status, payment_amount').eq('reference_code', referenceCode).eq('user_id', userId).single()
                // afa_orders_reference_code_unique is GLOBAL, not per-user, and developer
                // references are plaintext strings they choose. So a miss here means the
                // reference belongs to ANOTHER account: nothing was created for this caller and
                // no money moved. Returning 200 is_duplicate:true would be a silent success on a
                // KYC + money endpoint. Mirrors the dashboard route's "Finding 7" ownership-
                // mismatch log — the risk is higher here, since the dashboard reference is a
                // client-generated UUID and this one is whatever string the developer typed.
                if (!existingOrder) {
                    console.warn(`[API v2 AFA] Reference "${referenceCode}" collided with an order owned by a different user (caller ${userId}) — rejecting with 409, nothing created.`)
                    done(409, 'Reference already in use')
                    return apiError(409, 'This reference is already in use. Choose a different reference.')
                }
                done(200)
                return apiSuccess({ order_id: (existingOrder as any).id, status: (existingOrder as any).status, is_duplicate: true }, { version: 'v2' })
            }
            if (rpcError.message?.includes('INSUFFICIENT_BALANCE')) {
                done(400, 'Insufficient balance')
                return apiError(400, 'Insufficient wallet balance')
            }
            if (rpcError.message?.includes('WALLET_NOT_FOUND')) {
                done(404, 'Wallet not found')
                return apiError(404, 'Wallet not found')
            }
            console.error('[API v2 AFA] RPC error:', rpcError)
            done(500, 'RPC failed')
            return apiError(500, 'Failed to process registration')
        }

        // Stamp source/api_key_id — process_afa_order's signature doesn't
        // accept them (shared with the dashboard route), so update after.
        if (rpcResult?.order_id) {
            await (supabaseAdmin.from('afa_orders') as any)
                .update({ source: 'api', api_key_id: apiKeyId }).eq('id', rpcResult.order_id)
        }

        // Sub-agent purchase: credit the ONE direct recruiter (spec C3, C4 — a pending row
        // now, credited by the trigger only once the registration is completed by an admin).
        // Never blocks the registration — the sub already paid, the application must still
        // be submitted.
        if (recruiterMargin) {
            await recordPendingSubAgentEarning(supabaseAdmin, {
                orderReference: referenceCode,
                orderTable: 'afa_orders',
                recruiterId: recruiterMargin.recruiterId,
                subUserId: userId,
                amount: recruiterMargin.amount,
            }).catch((e) => console.error('[API v2 AFA] recordPendingSubAgentEarning threw:', e))
        }

        waitUntil((async () => {
            try {
                const { data: adminUsers } = await supabase.from('users').select('email').eq('role', 'admin')
                const recipients = new Set<string>()
                if (process.env.ADMIN_EMAIL) recipients.add(process.env.ADMIN_EMAIL)
                ;(adminUsers as any[] || []).forEach(u => { if (u.email) recipients.add(u.email) })
                if (recipients.size > 0) {
                    const { sendAdminNewAfaApplicationAlert } = await import('@/lib/email-service')
                    await Promise.allSettled(Array.from(recipients).map(email =>
                        sendAdminNewAfaApplicationAlert({ applicantName: formData.full_name, phone: formData.phone, region: formData.region }, email)
                    ))
                }
            } catch (e) { console.error('[API v2 AFA] Admin alert failed:', e) }
        })())

        done(200)
        return apiSuccess({ order_id: rpcResult?.order_id, reference, status: 'pending', new_balance: rpcResult?.new_balance }, { version: 'v2' })

    } catch (error: any) {
        console.error('[API v2 AFA] Exception:', error.message)
        done(500, error.message)
        return apiError(500, 'Internal server error')
    }
}
