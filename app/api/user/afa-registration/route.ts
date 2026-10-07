import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createAdminClient } from '@/lib/supabase-admin'
import { isValidGhanaPhone, normalizePhone } from '@/lib/ussd/utils'
import { validateAfaRegistration } from '@/lib/afa-validation'
import { AFA_PRICE_KEYS, resolveAfaPrice } from '@/lib/afa-pricing'
import { resolveSubAgentAfaCost, AFA_PRODUCT_REF } from '@/lib/sub-agent-afa-pricing'
import { recordPendingSubAgentEarning } from '@/lib/sub-agent-earnings'
import { resolveSubAgentContext } from '@/lib/sub-agent-account'
import { hasSubAgentPricingConfigured } from '@/lib/sub-agent-pricing'
import { waitUntil } from '@vercel/functions'

// Allowlists, ID format patterns and field length caps now live in
// lib/afa-validation.ts, shared with app/api/v2/afa/register. They are
// deliberately NOT re-declared here: leaving a local copy behind is exactly
// how the two surfaces drifted in the first place (review finding I6) — the
// next person to add a region would edit whichever copy they found.

export async function POST(request: NextRequest) {
    try {
        // ── 2A: Authenticate user ──────────────────────────────────
        const supabaseUserClient = await createRouteClient()
        const supabaseAdmin = createAdminClient()

        const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const userId = authUser.id

        // ── Parse request body ────────────────────────────────────
        let body: any
        try {
            body = await request.json()
        } catch {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
        }

        const { referenceCode, formData } = body

        if (!referenceCode || typeof referenceCode !== 'string') {
            return NextResponse.json({ error: 'Missing referenceCode' }, { status: 400 })
        }

        // Finding 8 fix — referenceCode length cap (legitimate UUIDs are 36 chars)
        if (referenceCode.length > 100) {
            return NextResponse.json({ error: 'Invalid reference code.' }, { status: 400 })
        }

        if (!formData || typeof formData !== 'object') {
            return NextResponse.json({ error: 'Missing form data' }, { status: 400 })
        }

        // ── Phone validation + normalization (M3) ──────────────────
        // Stays here rather than moving into the shared validator: this route
        // and the v2 API normalise phones with the same helpers but the shared
        // module deliberately doesn't own that step (see lib/afa-validation.ts).
        // Runs FIRST so formData.phone is normalised before its length cap is
        // checked, preserving the original ordering exactly.
        if (!isValidGhanaPhone(String(formData.phone))) {
            return NextResponse.json(
                { error: 'Invalid phone number. Use format 0XXXXXXXXX or +233XXXXXXXXX.' },
                { status: 400 }
            )
        }
        formData.phone = normalizePhone(String(formData.phone))

        // ── Shared AFA validation ──────────────────────────────────
        // Presence checks, field length caps, free-text angle-bracket rejection
        // (stored-XSS defence in depth — these fields are rendered into admin
        // email and in-app notification HTML), the ID type + region allowlists,
        // the fail-closed ID format check, and the 18+ age check all live in
        // lib/afa-validation.ts, shared with app/api/v2/afa/register (review
        // finding I6). Order and messages are unchanged from the copy this
        // replaces — two copies of a KYC allowlist would drift the moment
        // Ghana gains a region or the Ghana Card format tightens.
        const validation = validateAfaRegistration(formData)
        if (!validation.ok) {
            // '__config' means VALID_ID_TYPES gained an entry with no matching
            // format pattern. That is our configuration mistake, not the
            // applicant's input, so it stays a fail-closed 500 rather than a 400.
            if (validation.field === '__config') {
                console.error(`[AFA Registration] ${validation.message} (id_type: "${formData.id_type}")`)
                return NextResponse.json({ error: validation.message }, { status: 500 })
            }
            return NextResponse.json({ error: validation.message }, { status: 400 })
        }

        // ── 2B: Fetch user role ────────────────────────────────────
        const { data: userRow } = await (supabaseUserClient
            .from('users')
            .select('role')
            .eq('id', userId)
            .single() as any)

        const userRole = (userRow as any)?.role || 'customer'

        // ── 2C: Fetch price server-side using service role (bypasses RLS) ──
        const { data: settingsData, error: settingsError } = await supabaseAdmin
            .from('admin_settings')
            .select('key, value')
            .in('key', AFA_PRICE_KEYS)

        if (settingsError) {
            console.error('[AFA Registration] Failed to fetch pricing settings:', settingsError)
            return NextResponse.json(
                { error: 'Registration pricing is not configured. Please contact support.' },
                { status: 500 }
            )
        }

        const settingsMap: Record<string, string> = ((settingsData || []) as any[]).reduce(
            (acc: Record<string, string>, row: any) => {
                acc[row.key] = row.value
                return acc
            },
            {}
        )

        const price = resolveAfaPrice(settingsMap, userRole)

        if (price === null) {
            console.error(`[AFA Registration] No usable price for role "${userRole}" in admin_settings:`, settingsMap)
            return NextResponse.json(
                { error: 'Registration pricing is not configured. Please contact support.' },
                { status: 500 }
            )
        }

        // Sub-agent pricing overrides the role price entirely (spec C2) — the sub's cost
        // is recruiter-derived, never role-derived. Fails closed before any charge (spec C7).
        let recruiterMargin: { recruiterId: string; amount: number } | null = null
        let priceToCharge = price

        // Server-side teeth for spec C4's "unconfigured = unbuyable" guarantee (Task 11):
        // resolveSubAgentAfaCost treats "no pricing configured" and "configured at zero
        // markup" identically (both resolve through resolveSubAgentMarkup returning 0), so the
        // dashboard hide alone doesn't stop a raw API call. Checked BEFORE the cost resolver via
        // our own resolveSubAgentContext call, mirroring the eligibility check every other
        // purchase route in this feature already does at its own call site.
        const preCtx = await resolveSubAgentContext(supabaseAdmin, userId)
        if (
            preCtx.isSub && preCtx.effectiveActive && preCtx.recruiterId
            && !(await hasSubAgentPricingConfigured(supabaseAdmin, preCtx.recruiterId, userId, 'afa', AFA_PRODUCT_REF))
        ) {
            return NextResponse.json(
                { error: 'Pricing is not available for this service right now' },
                { status: 409 },
            )
        }

        const subCtx = await resolveSubAgentAfaCost(supabaseAdmin, userId, settingsMap)
        if (subCtx.isSub) {
            if (!subCtx.ok) {
                console.error(`[AFA Registration] 🚨 sub cost unresolvable for user ${userId}: ${subCtx.reason}`)
                return NextResponse.json(
                    { error: 'Pricing is not available for this service right now' },
                    { status: 409 },
                )
            }
            priceToCharge = subCtx.subCost
            if (subCtx.recruiterEarns > 0 && subCtx.recruiterId) {
                recruiterMargin = { recruiterId: subCtx.recruiterId, amount: subCtx.recruiterEarns }
            }
        }

        // ── 2D: Call atomic RPC via service-role client (C1 fix) ─────
        // process_afa_order EXECUTE is revoked from 'authenticated' — must use
        // service_role. The function is SECURITY DEFINER so it still enforces
        // its own internal logic (wallet lock, balance check, etc.).
        const { data: rpcResult, error: rpcError } = await (supabaseAdmin as any).rpc(
            'process_afa_order',
            {
                p_user_id:        userId,
                p_amount:         priceToCharge,
                p_form_data:      formData,
                p_reference_code: referenceCode,
            }
        )

        // ── 2E: Handle errors ─────────────────────────────────────
        if (rpcError) {
            // Graceful duplicate: unique constraint violation (Postgres code 23505)
            if (
                rpcError.code === '23505' ||
                rpcError.message?.includes('afa_orders_reference_code_unique') ||
                rpcError.message?.includes('duplicate key')
            ) {
                // Ownership enforced via both referenceCode AND userId (Finding 9 fix)
                const { data: existingOrder, error: duplicateError } = await (supabaseUserClient
                    .from('afa_orders')
                    .select('id, status, payment_amount')
                    .eq('reference_code', referenceCode)
                    .eq('user_id', userId)
                    .single() as any)

                // Finding 7 fix — log ownership mismatch instead of silently returning null
                if (duplicateError) {
                    console.warn(
                        '[AFA Registration] Duplicate reference code but no matching order for user:',
                        userId,
                        duplicateError.code
                    )
                }

                return NextResponse.json({
                    success:     true,
                    isDuplicate: true,
                    order_id:    (existingOrder as any)?.id ?? null,
                })
            }

            // Insufficient balance
            if (rpcError.message?.includes('INSUFFICIENT_BALANCE')) {
                return NextResponse.json(
                    { error: 'INSUFFICIENT_BALANCE' },
                    { status: 400 }
                )
            }

            // Wallet not found
            if (rpcError.message?.includes('WALLET_NOT_FOUND')) {
                return NextResponse.json(
                    { error: 'Wallet not found' },
                    { status: 404 }
                )
            }

            console.error('[AFA Registration] RPC error:', rpcError)
            return NextResponse.json(
                { error: 'Failed to process registration' },
                { status: 500 }
            )
        }

        // Sub-agent registration: credit the ONE direct recruiter (spec C3, C4 — a pending row
        // now, credited by the trigger only once the order actually completes). Never blocks
        // the registration — the sub already paid, the application must still be submitted.
        if (recruiterMargin) {
            await recordPendingSubAgentEarning(supabaseAdmin, {
                orderReference: referenceCode,
                orderTable: 'afa_orders',
                recruiterId: recruiterMargin.recruiterId,
                subUserId: userId,
                amount: recruiterMargin.amount,
            }).catch((e) => console.error('[AFA Registration] recordPendingSubAgentEarning threw:', e))
        }

        // ── 2F: Send Admin Notification (Asynchronous) ──────────────
        waitUntil((async () => {
            try {
                // Find main admins to notify (excluding sub_admin)
                const { data: adminUsers } = await supabaseUserClient
                    .from('users')
                    .select('email')
                    .eq('role', 'admin')

                // Create a unique set of recipients (DB Admins + Env Fallback)
                const recipients = new Set<string>()
                if (process.env.ADMIN_EMAIL) recipients.add(process.env.ADMIN_EMAIL)

                if (adminUsers) {
                    (adminUsers as any[]).forEach(u => {
                        if (u.email) recipients.add(u.email)
                    })
                }

                if (recipients.size > 0) {
                    const { sendAdminNewAfaApplicationAlert } = await import('@/lib/email-service')
                    
                    const notifyPromises = Array.from(recipients).map(email => 
                        sendAdminNewAfaApplicationAlert(
                            {
                                applicantName: formData.full_name,
                                phone: formData.phone,
                                region: formData.region
                            },
                            email
                        )
                    )
                    
                    await Promise.allSettled(notifyPromises)
                }
            } catch (emailError) {
                console.error('[AFA Registration] Failed to send admin alert email:', emailError)
            }
        })())

        // ── Success ───────────────────────────────────────────────
        return NextResponse.json({
            success:        true,
            order_id:       rpcResult?.order_id,
            transaction_id: rpcResult?.transaction_id,
            new_balance:    rpcResult?.new_balance,
        })
    } catch (error) {
        console.error('[AFA Registration] Unexpected error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
