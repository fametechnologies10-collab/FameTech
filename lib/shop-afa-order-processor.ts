// lib/shop-afa-order-processor.ts
//
// Runs after a successful Paystack payment for a storefront AFA registration.
// Unlike lib/shop-order-processor.ts there is NO supplier dispatch: AFA
// registrations are always completed manually by an admin, so this only creates
// the afa_orders row and alerts admins. Profit is credited HERE, on payment —
// like every other product — via credit_shop_afa_profit (see step 5a below).
// app/api/admin/afa-orders/[id]/status still calls the same RPC on 'completed'
// as an idempotent backstop (it also reverses on 'cancelled').
//
// The applicant's KYC never travels through Paystack — it is resolved here from
// shop_afa_pending_orders by paystack_reference, mirroring the USSD path's
// session_id -> ussd_pending_orders.order_payload lookup.
import { waitUntil } from '@vercel/functions'
import { createServerClient } from './supabase'
import { resolveSubAgentContext } from '@/lib/sub-agent-account'
import { resolveSubAgentAfaCost } from '@/lib/sub-agent-afa-pricing'
import { recordPendingSubAgentEarning } from '@/lib/sub-agent-earnings'
import { roleFeeSettingKeys, resolveRoleFeeSetting } from '@/lib/pricing/shop-fee-resolver'
import { AFA_PRICE_KEYS } from '@/lib/afa-pricing'

// Guards against two callbacks racing inside the same lambda instance. The
// durable guard is the UNIQUE index on afa_orders.paystack_reference.
const processingLocks = new Set<string>()

/**
 * Resolves (and reconciliation-checks) the recruiter earning for a storefront AFA sale.
 * Shared by processShopAfaOrder's main flow (step 2b, before order creation) AND its
 * replay-repair path (review finding I2) so a repair attempt reuses the exact same
 * eligibility/pricing/reconciliation checks rather than a second copy that could drift or
 * double-credit.
 *
 * `frozenCostPrice` is the sub-agent cost basis the guest was actually quoted AT CHECKOUT
 * TIME — computeShopAfaCheckout (lib/shop-afa-checkout.ts) sets `costPrice` to
 * `resolveSubAgentAfaCost(...).subCost` for a sub-agent sale and persists it verbatim as
 * `shop_afa_pending_orders.cost_price`, later copied unchanged into `afa_orders.cost_price` —
 * so no new column is needed to recover it (review finding I1). Comparing that frozen value
 * against a freshly re-resolved LIVE subCost here catches a markup/role edit that landed
 * between checkout and this webhook — if the two disagree, pricing changed mid-flight, so no
 * earning is recorded (an audited security_events row is written instead), never a
 * re-computed amount that could over/under-credit the recruiter. Does NOT block the
 * registration itself — only the earning write is skipped.
 *
 * Returns null (having already logged/audited as needed) whenever no earning should be
 * recorded — not a sub, ineligible, pricing rejected, zero markup, or a reconciliation
 * mismatch. Never throws — safe to call from an idempotency/replay branch.
 */
async function resolveVerifiedAfaSubEarning(
    db: any,
    ownerId: string,
    frozenCostPrice: number,
    reference: string,
    shopId: string,
): Promise<{ recruiterId: string; amount: number } | null> {
    const subCtx = await resolveSubAgentContext(db, ownerId)
    if (!subCtx.isSub || !subCtx.effectiveActive) return null

    const { data: afaSettingsRows } = await db
        .from('admin_settings')
        .select('key, value')
        .in('key', AFA_PRICE_KEYS)
    const afaSettings: Record<string, unknown> = {}
    for (const row of (afaSettingsRows || [])) afaSettings[row.key] = row.value

    const subResult = await resolveSubAgentAfaCost(db, ownerId, afaSettings)
    if (!subResult.ok || !(subResult.recruiterEarns > 0 && subResult.recruiterId)) return null

    // I1 reconciliation: live-resolved subCost vs. the FROZEN cost basis captured at checkout.
    // Rounded to 2dp tolerance for normal float rounding.
    const liveSubCost = Number(subResult.subCost)
    const frozen = Number(frozenCostPrice)
    if (!Number.isFinite(frozen) || Math.abs(liveSubCost - frozen) > 0.01) {
        console.error(`[Shop AFA Processor] 🚨 EARNING PRICE MISMATCH: Ref=${reference} shop=${shopId} owner=${ownerId} liveSubCost=${liveSubCost} frozenCostPrice=${frozen} — pricing changed between checkout and confirmation; no recruiter earning recorded, registration proceeds unaffected.`)
        await db.from('security_events').insert({
            event_type: 'shop_afa_earning_price_mismatch',
            reference,
            shop_id: shopId,
            order_type: 'afa',
            detail: { owner_id: ownerId, live_sub_cost: liveSubCost, frozen_cost_price: frozen },
            created_at: new Date().toISOString(),
        }).catch((e: any) => console.error('[Shop AFA Processor] security_events insert failed:', e))
        return null
    }

    return { recruiterId: subResult.recruiterId, amount: subResult.recruiterEarns }
}

/**
 * Replay repair for a lost recordPendingSubAgentEarning write (review finding I2), mirroring
 * repairSubAgentEarning in lib/shop-order-processor.ts: the existingOrder idempotency branch
 * in processShopAfaOrder is the ONLY path a replayed callback reaches for an
 * already-created order, so if the original attempt's earning write failed, this is the
 * last chance to record it. Reuses resolveVerifiedAfaSubEarning — the SAME
 * reconciliation-aware resolver the main flow uses — so a repair can never ALSO silently
 * overcredit off a stale price. Never throws.
 */
async function repairSubAgentAfaEarning(
    db: any,
    reference: string,
    shopId: string | null | undefined,
    frozenCostPrice: number | null | undefined,
): Promise<void> {
    try {
        if (!shopId) return

        const { data: shopProfile, error: shopErr } = await db
            .from('shop_profiles')
            .select('owner_id')
            .eq('id', shopId)
            .maybeSingle()
        if (shopErr) {
            console.error(`[Shop AFA Processor] replay repair: owner lookup error for ${reference}:`, shopErr)
            return
        }
        const ownerId: string | undefined = shopProfile?.owner_id
        if (!ownerId) return

        const earning = await resolveVerifiedAfaSubEarning(db, ownerId, Number(frozenCostPrice), reference, shopId)
        if (!earning) return

        const result = await recordPendingSubAgentEarning(db, {
            orderReference: reference,
            orderTable: 'afa_orders',
            recruiterId: earning.recruiterId,
            subUserId: ownerId,
            amount: earning.amount,
        })
        if (!result.success) {
            console.error(`[Shop AFA Processor] replay repair FAILED for ${reference}: ${result.message}`)
        }
    } catch (e) {
        console.error(`[Shop AFA Processor] replay repair threw for ${reference}:`, e)
    }
}

export async function processShopAfaOrder(
    reference: string,
    // Deliberately not read — KYC and money both come from the DB (via
    // shop_afa_pending_orders, resolved by `reference`), never from Paystack
    // metadata. Kept for call-signature symmetry with the shop order processor.
    metadata: {
        shop_id: string
        guest_phone: string
    },
    paidAmountPesewas: number,
    // Unused — kept only for call-signature symmetry with processShopOrder,
    // which does need the slug. Prefixed to mark it intentionally unused.
    _slug?: string
): Promise<{ success: boolean; error?: string; orderId?: string; isDuplicate?: boolean }> {
    const supabase = createServerClient()
    const db = supabase as any

    if (processingLocks.has(reference)) {
        return { success: true, isDuplicate: true }
    }
    processingLocks.add(reference)

    try {
        // 1. Idempotency — has this payment already produced an order?
        const { data: existingOrder } = await db
            .from('afa_orders')
            .select('id, status, shop_id, cost_price')
            .eq('paystack_reference', reference)
            .maybeSingle()

        if (existingOrder) {
            // Self-heal: if a prior attempt created the order but died before retiring
            // the staging row (crash between Step 4 and Step 5), a replayed callback
            // lands here and never reaches Step 5 on its own. Retry the same guarded
            // retire so the staging row doesn't stay 'awaiting_payment' forever. No-op
            // if it was already retired.
            const { error: healRetireError } = await db
                .from('shop_afa_pending_orders')
                .update({ status: 'fulfilled', fulfilled_at: new Date().toISOString() })
                .eq('paystack_reference', reference)
                .eq('status', 'awaiting_payment')

            if (healRetireError) {
                console.error('[Shop AFA Processor] Self-heal retire failed:', healRetireError)
            }

            // Replay repair (review finding I2): this is the ONLY path a replayed callback
            // reaches — if the original attempt's earning write failed, retry it here.
            await repairSubAgentAfaEarning(db, reference, existingOrder.shop_id, existingOrder.cost_price)
                .catch((e: any) => console.error('[Shop AFA Processor] replay repair threw:', e))

            return { success: true, orderId: existingOrder.id, isDuplicate: true }
        }

        // 2. Resolve the staged KYC payload + the price the guest was actually quoted.
        const { data: pending, error: pendingError } = await db
            .from('shop_afa_pending_orders')
            .select('id, shop_id, guest_phone, guest_email, order_payload, cost_price, selling_price, profit, status, paystack_fee')
            .eq('paystack_reference', reference)
            .maybeSingle()

        if (pendingError || !pending) {
            console.error(`[Shop AFA Processor] No staged order for reference ${reference}:`, pendingError)
            return { success: false, error: 'Registration details not found' }
        }

        // 2b. Resolve the shop owner + re-check sub-agent eligibility at CONFIRMATION time
        // (Plan 2c, Task 2). Task 1's computeShopAfaCheckout already gated the sale at
        // checkout, but the guest has now actually paid, and the recruiter chain can have
        // gone inactive in the gap (a suspended sub, an expired recruiter) — new coverage
        // this product didn't have before, matching lib/shop-order-processor.ts's existing
        // ineligible-sub guard. `owner_id` isn't otherwise available here — resolved via a
        // small dedicated shop_profiles lookup, same style as the paystack_fee legacy-fallback
        // lookup below. Runs BEFORE step 3's amount check (mirroring the sibling guard in
        // lib/shop-order-processor.ts, which also resolves sub-agent eligibility during price
        // resolution, ahead of its own amount-mismatch check) so an ineligible sale never
        // reaches amount validation or order creation at all.
        const { data: shopOwnerRow, error: shopOwnerErr } = await db
            .from('shop_profiles')
            .select('owner_id')
            .eq('id', pending.shop_id)
            .single()
        // m1: a transient DB error here previously failed open silently (skipped the whole
        // guard AND the earning with no log). Not a behavior change — still proceeds with
        // ownerId undefined below — just now visible.
        if (shopOwnerErr) console.error(`[Shop AFA Processor] shop owner lookup error for ${reference}:`, shopOwnerErr)
        const ownerId: string | undefined = shopOwnerRow?.owner_id

        // Set only when this is a healthy sub-agent sale with a positive recruiter markup —
        // reused verbatim at the recordPendingSubAgentEarning call site below so
        // resolveSubAgentAfaCost is never called twice for the same confirmation.
        let subEarning: { recruiterId: string; amount: number } | null = null

        if (ownerId) {
            const subCtx = await resolveSubAgentContext(db, ownerId)

            // FAIL CLOSED on a chain that stopped being eligible between checkout and now
            // (mirrors lib/shop-order-processor.ts's INELIGIBLE SUB guard).
            if (subCtx.isSub && !subCtx.effectiveActive) {
                console.error(`[Shop AFA Processor] 🚨 INELIGIBLE SUB blocked: Ref ${reference}, shop ${pending.shop_id} — went inactive between checkout and payment confirmation. Flagging for refund.`)
                try {
                    await db.from('security_events').insert({
                        event_type: 'shop_afa_ineligible_sub_chain_blocked',
                        reference,
                        shop_id: pending.shop_id,
                        paid_amount: paidAmountPesewas,
                        guest_phone: pending.guest_phone,
                        order_type: 'afa',
                        created_at: new Date().toISOString(),
                    })
                } catch (auditErr) {
                    console.warn('[Shop AFA Processor] ineligible-sub audit log failed:', auditErr)
                }
                return { success: false, error: 'This order cannot be completed. Your payment will be refunded.' }
            }

            if (subCtx.isSub && subCtx.effectiveActive) {
                // I1: pending.cost_price IS the frozen sub-agent cost basis from checkout time
                // (computeShopAfaCheckout set it to resolveSubAgentAfaCost(...).subCost) — pass
                // it through so the shared resolver can reconcile it against the live re-resolve.
                subEarning = await resolveVerifiedAfaSubEarning(db, ownerId, Number(pending.cost_price), reference, pending.shop_id)
            }
        }

        // 3. Amount check against the staged price (the quote the guest paid).
        // Task 1 added a Paystack fee on top of the selling price in
        // computeShopAfaCheckout's totalAmountPesewas, so the expected amount here
        // must include that fee too — the FROZEN selling_price from the staged quote
        // never re-prices off a later admin/shop change. The fee itself is now ALSO
        // frozen at checkout time (shop_afa_pending_orders.paystack_fee) so a shop's
        // paystack_fee_percent changing between checkout and payment confirmation can
        // never cause a false amount mismatch. Rows staged before that column existed
        // have paystack_fee = NULL — for those only, fall back to the old live lookup
        // (matching lib/shop-order-processor.ts's DATA branch pattern) so in-flight
        // payments from before this change don't break.
        const stagedSellingPrice = Number(pending.selling_price)
        let stagedPaystackFee: number
        if (pending.paystack_fee !== null && pending.paystack_fee !== undefined) {
            stagedPaystackFee = Number(pending.paystack_fee)
        } else {
            const { data: shopRow } = await db
                .from('shop_profiles')
                .select('paystack_fee_percent, owner:users!shop_profiles_owner_id_fkey(role)')
                .eq('id', pending.shop_id)
                .single()
            const ownerRole = (shopRow as any)?.owner?.role || 'customer'
            const { data: paystackFeeRows } = await db
                .from('shop_global_settings')
                .select('key, value')
                .in('key', roleFeeSettingKeys(ownerRole, 'shop_paystack_fee_percent'))
            const paystackFeeMap: Record<string, string> = {}
            for (const row of (paystackFeeRows || [])) paystackFeeMap[row.key] = row.value
            const paystackFeePercent = resolveRoleFeeSetting(
                paystackFeeMap, ownerRole, 'shop_paystack_fee_percent', 1.95, shopRow?.paystack_fee_percent
            )

            stagedPaystackFee = Math.round(stagedSellingPrice * (paystackFeePercent / 100) * 100) / 100
        }
        const expectedTotalPesewas = Math.round((stagedSellingPrice + stagedPaystackFee) * 100)
        if (Math.abs(paidAmountPesewas - expectedTotalPesewas) > 5) {
            console.error(`[Shop AFA Processor] AMOUNT MISMATCH: Ref ${reference}, paid ${paidAmountPesewas}, expected ${expectedTotalPesewas}`)
            return { success: false, error: 'Payment amount mismatch' }
        }

        const formData = (pending.order_payload || {}) as Record<string, any>

        // 4. Create the real registration. status 'pending' here means PAID and
        // awaiting manual processing — the same meaning the USSD fulfiller uses.
        const { data: newOrder, error: createError } = await db
            .from('afa_orders')
            .insert({
                shop_id: pending.shop_id,
                guest_phone: pending.guest_phone,
                full_name: formData.full_name,
                phone: formData.phone,
                ghana_card: formData.id_number,
                id_type: formData.id_type || 'Ghana Card',
                id_number: formData.id_number,
                location: formData.location,
                region: formData.region,
                occupation: formData.occupation || 'N/A',
                date_of_birth: formData.date_of_birth || null,
                notes: formData.notes || null,
                status: 'pending',
                cost_price: pending.cost_price,
                selling_price: pending.selling_price,
                profit: pending.profit,
                payment_amount: pending.selling_price,
                reference_code: reference,
                paystack_reference: reference,
                source: 'shop',
            })
            .select('id')
            .single()

        if (createError) {
            // Cross-instance race: another callback won. Treat as a duplicate — this is
            // a normal, expected outcome and must NOT log a security event.
            if ((createError as any).code === '23505') {
                return { success: true, isDuplicate: true }
            }

            console.error('[Shop AFA Processor] Failed to create order:', createError)

            // The guest has paid but no afa_orders row exists — the staging row is the
            // only remaining trace and nothing is watching it. Record a durable audit
            // event so this doesn't vanish into a console log. Wrapped so a failure to
            // audit can never mask the original error. Never include order_payload
            // (KYC) contents here — only the staged row id, so the KYC stays contained
            // to shop_afa_pending_orders.
            const { error: auditError } = await db.from('security_events').insert({
                event_type: 'shop_afa_order_creation_failed',
                reference,
                shop_id: pending.shop_id,
                paid_amount: paidAmountPesewas,
                expected_amount: expectedTotalPesewas,
                guest_phone: pending.guest_phone,
                order_type: 'afa',
                detail: {
                    pending_id: pending.id,
                    pg_code: (createError as any)?.code ?? null,
                    pg_message: (createError as any)?.message ?? null,
                },
            })
            if (auditError) {
                console.error('[Shop AFA Processor] security_events insert failed:', auditError)
            }

            return { success: false, error: 'Order creation failed' }
        }

        // 4a. Record the recruiter's pending earning (Plan 2c, Task 2) — reusing the SAME
        // resolveSubAgentAfaCost result computed in the eligibility guard above (step 2b),
        // never re-resolved here. Wrapped in .catch() logging only, matching the established
        // pattern everywhere else in this codebase (see lib/shop-order-processor.ts's own use
        // of it) — a failed earning write must never block the guest's already-paid
        // registration.
        if (subEarning && ownerId) {
            await recordPendingSubAgentEarning(db, {
                orderReference: reference,
                orderTable: 'afa_orders',
                recruiterId: subEarning.recruiterId,
                subUserId: ownerId,
                amount: subEarning.amount,
            }).catch((e) => console.error('[Shop AFA Processor] recordPendingSubAgentEarning threw:', e))
        }

        // 5. Retire the staging row. Guarded on the awaiting_payment status so a
        // replayed callback can't reopen it.
        const { error: retireError } = await db
            .from('shop_afa_pending_orders')
            .update({ status: 'fulfilled', fulfilled_at: new Date().toISOString() })
            .eq('id', pending.id)
            .eq('status', 'awaiting_payment')

        if (retireError) {
            // Non-fatal: the registration exists and is what the guest paid for.
            console.error('[Shop AFA Processor] Failed to retire staged order:', retireError)
        }

        // 5a. Credit the shop owner's markup now — the guest has paid, so the shop
        // owner earns like every other product (data/airtime/RC credit on payment
        // too). Non-fatal: the order and payment are already real; a credit failure
        // must not fail the order, but must not vanish either, so it's also recorded
        // as a durable security_events row. app/api/admin/afa-orders/[id]/status's
        // 'completed' handler calls the same idempotent RPC as a backstop.
        if (pending.shop_id && Number(pending.profit) > 0) {
            const { data: creditResult, error: creditError } = await (db as any).rpc('credit_shop_afa_profit', {
                p_afa_order_id: newOrder!.id,
            })
            if (creditError || creditResult?.success === false) {
                console.error(
                    '[Shop AFA Processor] Profit credit failed for order', newOrder!.id,
                    creditError ?? creditResult?.message
                )
                const { error: auditError } = await db.from('security_events').insert({
                    event_type: 'afa_profit_credit_failed',
                    reference,
                    shop_id: pending.shop_id,
                    order_type: 'afa',
                    detail: {
                        order_id: newOrder!.id,
                        rpc_message: creditError?.message ?? creditResult?.message ?? null,
                    },
                })
                if (auditError) {
                    console.error('[Shop AFA Processor] security_events insert failed:', auditError)
                }
            }
        }

        // 6. Alert admins, reusing the same template the dashboard AFA route uses.
        waitUntil((async () => {
            try {
                const { data: adminUsers } = await db.from('users').select('email').eq('role', 'admin')
                const recipients = new Set<string>()
                if (process.env.ADMIN_EMAIL) recipients.add(process.env.ADMIN_EMAIL)
                for (const u of (adminUsers || [])) if (u.email) recipients.add(u.email)
                if (recipients.size > 0) {
                    const { sendAdminNewAfaApplicationAlert } = await import('./email-service')
                    await Promise.allSettled(
                        Array.from(recipients).map(email =>
                            sendAdminNewAfaApplicationAlert(
                                { applicantName: formData.full_name, phone: formData.phone, region: formData.region },
                                email
                            )
                        )
                    )
                }
            } catch (e) {
                console.error('[Shop AFA Processor] Admin alert failed:', e)
            }
        })())

        return { success: true, orderId: newOrder?.id }
    } catch (error) {
        console.error('[Shop AFA Processor] Critical error:', error)
        return { success: false, error: 'Internal processor error' }
    } finally {
        processingLocks.delete(reference)
    }
}
