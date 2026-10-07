import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { generateReferenceCode } from '@/lib/utils'
import { cookies } from 'next/headers'
import { waitUntil } from '@vercel/functions'
// import { isRateLimited, checkFraudSignals, logSuspiciousActivity } from '@/lib/security'
import { getAdminOOSNetworks, isNetworkOOS } from '@/lib/network-stock'
import { resolveOrderQueueing } from '@/lib/number-registration'
import { checkMtnWhitelistGateBatch } from '@/lib/mtn-whitelist-gate'
import { resolveOwnConfirmationSender } from '@/lib/sms-confirmation-sender'

interface BulkOrderItem {
    packageId: string
    phoneNumber: string
    packagePrice: number
}

interface FulfillmentOutcome {
    failed: boolean
    type: 'error' | 'skipped' | 'success'
    reason?: string
    referenceCode: string
    network: string
}

export async function POST(request: NextRequest) {
    try {
        const cookieStore = await cookies()
        const supabaseUserClient = await createRouteClient()
        const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const userId = authUser.id

        // === SECURITY: Rate limit purchases ===
        // if (isRateLimited(userId, 'bulk')) {
        //     return NextResponse.json({ error: 'Too many requests. Please wait a few seconds.' }, { status: 429 })
        // }

        let body: { orders: BulkOrderItem[]; batchReference?: string }
        try {
            body = await request.json()
        } catch {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
        }

        const { orders, batchReference } = body

        if (!Array.isArray(orders) || orders.length === 0) {
            return NextResponse.json({ error: 'No orders provided' }, { status: 400 })
        }

        if (orders.length > 500) {
            return NextResponse.json({ error: 'Maximum 500 orders per batch' }, { status: 400 })
        }

        // === IDEMPOTENCY: optional client-supplied batch key ===
        // When present, every order's reference_code is derived deterministically
        // from it (`${batchReference}-${i}`). The orders.reference_code UNIQUE
        // constraint then makes a replayed batch fail atomically (all-or-nothing),
        // and the pre-check below short-circuits before any wallet deduction â€”
        // preventing accidental double-charge from a double-click or retry.
        const normalizedBatchRef =
            typeof batchReference === 'string' && batchReference.trim().length >= 6 && batchReference.length <= 80
                ? batchReference.trim()
                : null

        const supabase = createServerClient()

        if (normalizedBatchRef) {
            const { data: existingBatch } = await (supabase.from('orders') as any)
                .select('id')
                .eq('reference_code', `${normalizedBatchRef}-0`)
                .eq('user_id', userId)
                .maybeSingle()
            if (existingBatch) {
                // This batch was already placed â€” return a generic duplicate ack.
                return NextResponse.json({ success: true, isDuplicate: true })
            }
        }

        // === 1. Get user role â€” fetch expiry fields to validate active subscription before granting agent pricing ===
        const { data: userRoleData } = await supabase
            .from('users')
            .select('role, status, email, first_name, last_name, dealer_expires_at, agent_expires_at, order_success_sms_enabled')
            .eq('id', userId)
            .single()

        // Server-side suspension enforcement â€” the dashboard gate alone is bypassable.
        if ((userRoleData as any)?.status === 'suspended') {
            return NextResponse.json({ error: 'Your account is currently suspended. Please contact support.' }, { status: 403 })
        }

        const userRoleName = (userRoleData as any)?.role
        const _dealerExpired = (userRoleData as any)?.dealer_expires_at
            && new Date((userRoleData as any).dealer_expires_at) < new Date()
        const _agentExpired = (userRoleData as any)?.agent_expires_at
            && new Date((userRoleData as any).agent_expires_at) < new Date()
        const isActiveDealer = userRoleName === 'dealer' && !_dealerExpired
        const isActiveAgent = userRoleName === 'agent' && !_agentExpired
        const isAgent = isActiveAgent || isActiveDealer
        const isAdminUser = userRoleName === 'admin' || userRoleName === 'sub-admin'

        if (!isAgent && !isAdminUser) {
            return NextResponse.json({ error: 'Bulk orders are only available to agents, dealers, and admins' }, { status: 403 })
        }

        // Sub-agents are blocked from bulk in v1 (spec Â§11): bulk prices by the buyer's
        // OWN role tier, which would bypass the upline's wholesale sub_price entirely.
        const { data: subMembership } = await (supabase as any)
            .from('sub_agents').select('id').eq('user_id', userId).maybeSingle()
        if (subMembership) {
            return NextResponse.json({ error: 'Bulk orders are not available for sub-agent accounts yet' }, { status: 403 })
        }

        // === 2. Validate all orders server-side ===
        const packageIds = [...new Set(orders.map(o => o.packageId))]
        const { data: packages, error: pkgsError } = await supabase
            .from('data_packages')
            .select('*')
            .in('id', packageIds)
            .eq('is_available', true)
            .neq('category', 'mtn_mashup') // mashup packages are not available through bulk purchase

        if (pkgsError || !packages) {
            return NextResponse.json({ error: 'Failed to load packages' }, { status: 500 })
        }

        const pkgMap = new Map(packages.map((p: any) => [p.id, p]))
        const adminOOS = await getAdminOOSNetworks(supabase)

        // Validate each order and compute authoritative prices
        const validatedOrders = orders.map((order) => {
            const pkg = pkgMap.get(order.packageId)
            if (!pkg) return { ...order, error: 'Package not found' }
            if (isNetworkOOS(adminOOS, (pkg as any).network)) {
                return { ...order, error: `${(pkg as any).network} is out of stock at the moment` }
            }

            const authoritativePrice = isActiveDealer && (pkg as any).dealer_price > 0
                ? (pkg as any).dealer_price
                : isActiveAgent && (pkg as any).agent_price > 0
                    ? (pkg as any).agent_price
                    : (pkg as any).price

            return {
                ...order,
                packagePrice: authoritativePrice,
                network: (pkg as any).network,
                size: (pkg as any).size,
                costPrice: (pkg as any).cost_price || 0,
                category: (pkg as any).category,
            }
        })

        const invalidOrders = validatedOrders.filter((o: any) => o.error)
        if (invalidOrders.length > 0) {
            return NextResponse.json({ error: `Some packages are invalid: ${invalidOrders.map((o: any) => o.error).join(', ')}` }, { status: 400 })
        }

        // === 2.5. MTN AgentPortal whitelist gate â€” filter out blocked MTN items ===
        // Independent of the number-registration gate below. Blocked items are
        // skipped entirely here (never charged, never inserted) rather than held
        // as 'queued' â€” the buyer only pays for numbers that can actually be
        // delivered to right now.
        const whitelistResults = await checkMtnWhitelistGateBatch(
            validatedOrders.map((o: any) => ({ phoneNumber: o.phoneNumber, network: o.network, category: o.category }))
        )
        const skipped: { phone: string; reason: string }[] = []
        const chargeableOrders = validatedOrders.filter((o: any) => {
            const result = whitelistResults.get(o.phoneNumber)
            if (result?.blocked) {
                skipped.push({ phone: o.phoneNumber, reason: result.reason || 'Not yet whitelisted' })
                return false
            }
            return true
        })

        if (chargeableOrders.length === 0) {
            return NextResponse.json(
                { error: 'None of these numbers are registered to receive MTN data yet. We\'ve submitted them for registration — please try again soon.', skipped },
                { status: 400 },
            )
        }

        // === 3. Calculate total and deduct atomically ===
        const totalCost = chargeableOrders.reduce((sum, o: any) => sum + o.packagePrice, 0)

        // === SECURITY: Fraud Check for Admin/Agent ===
        // const isFraud = await checkFraudSignals(userId, 'bulk_admin', supabase)
        // if (isFraud) {
        //     await logSuspiciousActivity(userId, 'bulk_purchase', 'fraud detected', supabase)
        //     return NextResponse.json({ error: 'Bulk action blocked due to suspicious activity' }, { status: 403 })
        // }

        const { data: deductResult, error: deductError } = await (supabase as any)
            .rpc('deduct_wallet_balance', {
                p_user_id: userId,
                p_amount: totalCost,
            })

        if (deductError) {
            if (deductError.message?.includes('INSUFFICIENT_BALANCE')) {
                return NextResponse.json({ error: 'Insufficient balance for all orders' }, { status: 400 })
            }
            console.error('Bulk wallet deduction error:', deductError)
            return NextResponse.json({ error: 'Failed to process payment' }, { status: 500 })
        }

        const walletRow = deductResult?.[0] || deductResult
        const walletId = walletRow?.wallet_id
        const newBalance = walletRow?.new_balance

        if (!walletId) {
            return NextResponse.json({ error: 'Wallet not found' }, { status: 404 })
        }

        // === 4. Insert all orders in one batch ===
        // Deterministic codes when a batchReference was supplied (idempotent),
        // otherwise fall back to random per-order codes (legacy behavior).
        const referenceCodes = normalizedBatchRef
            ? chargeableOrders.map((_, i) => `${normalizedBatchRef}-${i}`)
            : chargeableOrders.map(() => generateReferenceCode())

        // MTN number-registration gate â€” evaluated per row (each order may be a
        // different network/recipient). Unregistered MTN numbers are held 'queued'.
        const queueDecisions = await Promise.all(
            chargeableOrders.map((order: any) => resolveOrderQueueing(order.phoneNumber, order.network))
        )

        const orderInserts = chargeableOrders.map((order: any, i) => ({
            user_id: userId,
            phone_number: order.phoneNumber,
            network: order.network,
            size: order.size,
            price: order.packagePrice,
            cost_price_at_time: order.costPrice,
            role_at_time: (userRoleData as any)?.role || 'customer',
            status: queueDecisions[i].queue ? 'queued' : 'pending',
            payment_status: 'paid',
            reference_code: referenceCodes[i],
            fulfillment_method: 'auto',
        }))

        const { data: createdOrders, error: ordersError } = await (supabase.from('orders') as any)
            .insert(orderInserts)
            .select('id, reference_code, network, size, phone_number, status')

        if (ordersError) {
            console.error('Bulk order insert error:', ordersError)
            // Refund the full amount since order creation failed. Atomic credit
            // RPC (relative increment) instead of an absolute SET so a concurrent
            // wallet operation can't be clobbered (TOCTOU). A duplicate batch that
            // collides on reference_code lands here and is fully refunded.
            const { error: refundError } = await (supabase as any)
                .rpc('credit_wallet_balance', {
                    p_user_id: userId,
                    p_amount: totalCost,
                })
            if (refundError) {
                console.error('[BulkPurchase] CRITICAL: refund failed, manual reconciliation required:', refundError)
            }
            return NextResponse.json({ error: 'Failed to create orders' }, { status: 500 })
        }

        // === 5. Insert all wallet transactions in one batch ===
        const txInserts = chargeableOrders.map((order: any, i) => ({
            wallet_id: walletId,
            user_id: userId,
            type: 'debit',
            amount: order.packagePrice,
            description: `Bulk data purchase: ${order.size} for ${order.phoneNumber}`,
            reference: referenceCodes[i],
            source: 'purchase',
            status: 'completed',
        }))

        await (supabase.from('wallet_transactions') as any).insert(txInserts)

        // === 6. Insert a single summary notification ===
        await (supabase.from('notifications') as any).insert({
            user_id: userId,
            title: 'Bulk Order Placed',
            message: `${chargeableOrders.length} orders have been placed successfully. Total: GHS ${totalCost.toFixed(2)}`,
            type: 'order_update',
            action_url: `/dashboard/my-orders`,
        })

        // === 7. Background: SMS + Fulfillment + Aggregated Admin Alert ===
        if (createdOrders && createdOrders.length > 0) {
            const userName = `${(userRoleData as any)?.first_name || ''} ${(userRoleData as any)?.last_name || ''}`.trim() || 'Customer'
            const userEmail = (userRoleData as any)?.email || 'Unknown'
            // Per-user opt-out for the order-success SMS (defaults to enabled).
            const smsEnabled = (userRoleData as any)?.order_success_sms_enabled !== false

            // Use waitUntil so the lambda stays alive after returning the response
            waitUntil((async () => {
                // Queued orders (unregistered MTN numbers) are held â€” no SMS, no dispatch.
                const dispatchable = (createdOrders as any[]).filter((o) => o.status !== 'queued')
                const queuedCount = createdOrders.length - dispatchable.length
                if (queuedCount > 0) {
                    console.log(`[BulkPurchase] ${queuedCount}/${createdOrders.length} orders QUEUED for MTN number registration â€” fulfillment held`)
                }
                // KFT SMS v2: resolve the buyer's OWN approved sender ONCE per request
                // (every SMS in this batch belongs to the same buyer) â€” not per order row.
                // USSD and shop-customer confirmations stay on the platform sender â€”
                // out of scope here (resolution never throws).
                const ownSender = smsEnabled ? await resolveOwnConfirmationSender(supabase, userId) : null
                const allResults = await Promise.allSettled(
                    dispatchable.map((order) =>
                        processOrderNotifications(order, { email: userEmail, name: userName }, smsEnabled, ownSender)
                    )
                )

                // Collect all failures (API errors) and skips (disabled fulfillment)
                const exceptions: FulfillmentOutcome[] = allResults
                    .filter(r => r.status === 'fulfilled' && (r as PromiseFulfilledResult<FulfillmentOutcome>).value?.failed)
                    .map(r => (r as PromiseFulfilledResult<FulfillmentOutcome>).value)

                // Send ONE aggregated summary email to all admins if any exceptions
                if (exceptions.length > 0) {
                    const { sendAdminBulkOrderAlert } = await import('@/lib/email-service')
                    await sendAdminBulkOrderAlert({
                        totalOrders: createdOrders.length,
                        failureCount: exceptions.length,
                        failures: exceptions.map(e => ({
                            referenceCode: e.referenceCode,
                            network: e.network,
                            reason: e.reason || 'Unknown',
                            type: e.type as 'error' | 'skipped',
                        })),
                        customerName: userName,
                        customerEmail: userEmail,
                    }).catch(err => console.error('[BulkPurchase] Admin alert error:', err))
                }
            })())
        }

        return NextResponse.json({
            success: true,
            ordersPlaced: chargeableOrders.length,
            totalCost,
            newBalance,
            skipped,
        })

    } catch (error) {
        console.error('Bulk purchase error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

/**
 * Handle per-order notifications: SMS to beneficiary first, then fulfillment.
 * Returns outcome so caller can aggregate for admin alert.
 */
async function processOrderNotifications(
    order: { id: string; reference_code: string; network: string; phone_number: string; size: string },
    user: { email: string; name: string },
    sendSms: boolean,
    ownSender: string | null
): Promise<FulfillmentOutcome> {
    // Step 1: SMS to beneficiary (non-blocking â€” errors don't prevent fulfillment).
    // Skipped when the buyer has opted out; fulfillment ALWAYS proceeds.
    if (sendSms) {
        const { sendOrderSuccessSMS } = await import('@/lib/sms-service')
        await sendOrderSuccessSMS(order.phone_number, {
            recipientNumber: order.phone_number,
            network: order.network,
            size: order.size,
            price: 0,
            currentBalance: 0,
            sender: ownSender ?? undefined,
        }).catch(err => console.error(`[BulkOrder] SMS error for ${order.phone_number}:`, err))
    }

    // Step 2: Trigger fulfillment and return the outcome
    return dispatchOrder(order, user)
}

/**
 * Dispatch one order via the SHARED lib/fulfillment-trigger.ts and map its
 * outcome into this route's FulfillmentOutcome shape.
 *
 * This replaces a ~85-line PRIVATE copy of the dispatcher that was badly
 * broken in two ways:
 *
 *  1. It gated on `fulfillment_settings.networks[network] === false`. That
 *     `networks` map is DataKazina's specifically, and DataKazina is currently
 *     toggled OFF for all four networks — so the check was true for every
 *     order and this route returned `skipped` for ALL of them. Dashboard bulk
 *     orders have not been auto-dispatching at all; they sat pending until the
 *     re-fulfillment cron swept them up.
 *  2. Even past that gate it called fulfillOrder from lib/fulfillment-service
 *     (DataKazina's) DIRECTLY, hardcoding one supplier and ignoring the other
 *     seven in the registry. It also had no atomic claim, used .single() on
 *     mtn_fulfillment_tracking (throws on 2+ rows), and had no `ambiguous`
 *     double-charge protection, no fallback chains and no sanitizeForStorage.
 *
 * The shared trigger fixes all of that at once: all 8 suppliers, the atomic
 * pending->processing claim, the four MTN rejection-fallback chains, ambiguous
 * handling, and reference sanitisation.
 *
 * suppressAdminAlerts is the reason the shared trigger grew that option: it
 * normally emits ONE admin alert per order, which would turn a 50-order batch
 * into 50 emails. Suppressing them preserves this route's existing behaviour of
 * aggregating every outcome into a single sendAdminBulkOrderAlert — and nothing
 * is lost, because every suppressed path still returns a populated `reason`
 * that flows into that summary.
 */
async function dispatchOrder(
    order: { id: string; reference_code: string; network: string; phone_number: string; size: string },
    user: { email: string; name: string }
): Promise<FulfillmentOutcome> {
    const { triggerFulfillment } = await import('@/lib/fulfillment-trigger')
    const outcome = await triggerFulfillment(order.id, order.network, user, {
        suppressAdminAlerts: true,
    })
    return {
        failed: outcome.failed,
        type: outcome.type,
        reason: outcome.reason,
        referenceCode: order.reference_code,
        network: order.network,
    }
}
