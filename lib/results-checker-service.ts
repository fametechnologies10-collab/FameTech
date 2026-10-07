/**
 * Results Checker Service
 *
 * Core business logic for voucher purchasing, inventory management,
 * and shop order processing. Mirrors airtime/create wallet deduction pattern.
 */

import { createServerClient } from './supabase'
import { generateReferenceCode } from './utils'
import { waitUntil } from '@vercel/functions'
import { resolveSubAgentRcCost } from '@/lib/sub-agent-rc-pricing'
import { hasSubAgentPricingConfigured } from '@/lib/sub-agent-pricing'
import { recordPendingSubAgentEarning } from '@/lib/sub-agent-earnings'
import { resolveSubAgentContext } from '@/lib/sub-agent-account'
import {
    getPriceForRole,
    resolveRcUnitPrice,
    applySubAgentRcOverride,
    type RCBreakdown,
    SUB_AGENT_PRICING_UNAVAILABLE_MESSAGE,
    SUB_AGENT_PRICING_UNAVAILABLE_STATUS,
} from '@/lib/results-checker-pricing'

// getPriceForRole/applySubAgentRcOverride/RCBreakdown/the SUB_AGENT_PRICING_UNAVAILABLE_*
// constants all moved to lib/results-checker-pricing.ts (a leaf module with no imports of its
// own) so lib/sub-agent-rc-pricing.ts can import getPriceForRole/resolveRcUnitPrice without
// pulling in this whole service — that was a real circular import (review finding I3) — and so
// applySubAgentRcOverride's own pure-arithmetic test doesn't need --env-file (review finding
// m3). Re-exported here so existing importers FROM this file keep working unchanged.
export { getPriceForRole, applySubAgentRcOverride, SUB_AGENT_PRICING_UNAVAILABLE_MESSAGE, SUB_AGENT_PRICING_UNAVAILABLE_STATUS }
export type { RCBreakdown }

// ─── Types ─────────────────────────────────────────────────────────────────

export interface RCType {
    id: string
    name: string
    customer_price: number
    agent_price: number
    dealer_price: number
    cost_price: number
    is_active: boolean
    display_order: number
    available_count?: number
    bulk_pricing?: Array<{ min_qty: number; max_qty: number; unit_price: number }>
}

export interface RCVoucher {
    id: string
    pin: string
    serial_number: string
}

export interface RCOrder {
    id: string
    reference_code: string
    type_name: string
    quantity: number
    unit_price: number
    total_paid: number
    status: string
    payment_status: string
    customer_phone: string | null
    customer_email: string | null
    inventory_ids: string[]
    delivered_via: string[]
    fulfilled_at: string | null
    created_at: string
}

export interface RCPriceBreakdown {
    unitPrice: number
    shopMarkup: number
    subtotal: number
    paystackFee: number
    total: number
}

// ─── Admin Settings Helpers ────────────────────────────────────────────────

export async function isRCEnabled(): Promise<boolean> {
    const supabase = createServerClient()
    const { data } = await (supabase.from('admin_settings') as any)
        .select('value')
        .eq('key', 'results_checker_enabled')
        .single()
    return data?.value === 'true'
}

export async function isStorefrontRCEnabled(): Promise<boolean> {
    const supabase = createServerClient()
    const { data } = await (supabase.from('admin_settings') as any)
        .select('value')
        .eq('key', 'results_checker_storefront_enabled')
        .single()
    return data?.value === 'true'
}

export async function getMaxQuantity(): Promise<number> {
    const supabase = createServerClient()
    const { data } = await (supabase.from('admin_settings') as any)
        .select('value')
        .eq('key', 'results_checker_max_quantity')
        .single()
    return data ? parseInt(data.value, 10) : 50
}

export async function getRCSettings(): Promise<Record<string, string>> {
    const supabase = createServerClient()
    const { data } = await (supabase.from('admin_settings') as any)
        .select('key, value')
        .in('key', [
            'results_checker_enabled',
            'results_checker_max_quantity',
            'results_checker_max_markup_customer',
            'results_checker_max_markup_agent',
            'results_checker_max_markup_dealer',
            'results_checker_reservation_timeout',
            'results_checker_paystack_fee_percent',
            // Backorder control: 'true' allows storefront purchases when stock = 0.
            // Defaults to 'false' (secure deny) if the key is absent.
            'results_checker_allow_backorders',
        ])
    const map: Record<string, string> = {}
    for (const row of (data || [])) map[row.key] = row.value
    return map
}

// ─── Type Queries ──────────────────────────────────────────────────────────

/**
 * Returns active types that have available inventory stock.
 */
export async function getAvailableTypes(): Promise<RCType[]> {
    const supabase = createServerClient()

    // SECURITY: cost_price is intentionally excluded here — it is the supplier margin
    // and must NEVER be returned to browser clients. It is only fetched by
    // getTypeById() for server-side pricing calculations (never exposed via API).
    const { data: types, error } = await (supabase
        .from('results_checker_types') as any)
        .select('id, name, customer_price, agent_price, dealer_price, is_active, display_order, bulk_pricing')
        .eq('is_active', true)
        .order('display_order', { ascending: true })

    if (error || !types) return []

    // Annotate with available count (parallel queries)
    const withCounts = await Promise.all(
        types.map(async (t: RCType) => {
            const count = await getAvailableCount(t.id)
            return { ...t, available_count: count }
        })
    )

    // Return all active types; out-of-stock ones are shown as disabled
    return withCounts
}

/**
 * Returns a single type by ID (including inactive).
 */
export async function getTypeById(typeId: string): Promise<RCType | null> {
    const supabase = createServerClient()
    const { data, error } = await (supabase
        .from('results_checker_types') as any)
        .select('*')
        .eq('id', typeId)
        .single()
    if (error || !data) return null
    return data as RCType
}

/**
 * Returns count of available (unreserved, unsold) inventory for a type.
 */
export async function getAvailableCount(typeId: string): Promise<number> {
    const supabase = createServerClient()
    const { count, error } = await (supabase
        .from('results_checker_inventory') as any)
        .select('id', { count: 'exact', head: true })
        .eq('type_id', typeId)
        .eq('status', 'available')
    if (error) return 0
    return count ?? 0
}

// ─── Pricing ───────────────────────────────────────────────────────────────

/**
 * Resolve a shop's RC markup for ONE exam type. The per-exam override in
 * `shop_rc_markups` (what the shop pricing UI actually writes) WINS; otherwise the
 * caller's flat role-based fallback (`results_checker_markup_{role}`) applies.
 *
 * SINGLE SOURCE OF TRUTH: the storefront (charge / initialize / breakdown) and the
 * USSD shop flow must BOTH call this. USSD previously read only the flat legacy field
 * and ignored `shop_rc_markups`, so shop RC USSD sales were mispriced and credited the
 * owner nothing. Centralising the per-exam lookup here prevents that drift recurring.
 */
export async function resolveShopRCMarkup(
    db: any,
    shopId: string,
    examTypeId: string,
    flatFallback: number,
): Promise<number> {
    const { data: exam } = await db
        .from('shop_rc_markups')
        .select('markup')
        .eq('shop_id', shopId)
        .eq('exam_type_id', examTypeId)
        .maybeSingle()
    if (exam && (exam as any).markup != null) {
        const m = parseFloat(String((exam as any).markup))
        if (Number.isFinite(m)) return m
    }
    return flatFallback
}

/**
 * Effective pricing role from the raw role + expiry timestamps. An EXPIRED dealer/agent
 * falls back to customer; a NULL expiry = lifetime/legacy, so honour the role column.
 * Single source of truth so a lapsed reseller is priced identically on every surface.
 *
 * MOVED to lib/effective-role.ts and re-exported here so existing importers keep working.
 * It had to leave this file so lib/api-auth.ts could use it for the v2 API without pulling
 * in this whole service (import cycle). See that module for the boundary convention.
 */
export { effectiveRoleFromExpiry } from '@/lib/effective-role'

/**
 * Cap a shop's RC markup at the admin per-role maximum (results_checker_max_markup_{role};
 * 0 = uncapped). Shared by calculateRCPrice (storefront) and the USSD path so both CHARGE and
 * CREDIT the same capped markup — an uncapped USSD markup previously over-credited the owner
 * beyond the platform's dealer/agent ceiling.
 */
export function capRCMarkup(markup: number, userRole: string, settings: Record<string, string>): number {
    const suffix = userRole === 'dealer' ? 'dealer' : userRole === 'agent' ? 'agent' : 'customer'
    const maxMarkup = parseFloat(settings[`results_checker_max_markup_${suffix}`] || '0')
    return maxMarkup > 0 ? Math.min(markup, maxMarkup) : markup
}

/**
 * Calculates full price breakdown including shop markup + Paystack fee.
 * All arithmetic is server-side — never trust client prices.
 */
export async function calculateRCPrice(params: {
    type: RCType
    quantity: number
    userRole: string
    shopMarkup?: number
    includePaystackFee?: boolean
    settings?: Record<string, string>   // pass to avoid a per-call fetch (e.g. USSD per-quantity menu)
}): Promise<RCBreakdown> {
    const { type, quantity, userRole, shopMarkup = 0, includePaystackFee = false } = params
    const settings = params.settings ?? await getRCSettings()

    // Floor the role-based base at cost_price, and apply the bulk-pricing tier for this quantity
    // if configured and it qualifies — both via the single shared resolver (lib/results-checker-pricing.ts)
    // so calculateRCPrice and resolveSubAgentRcCost can never drift on what "the price" is for a
    // given (type, quantity, role) triple (review finding C1/I3).
    const { unitPrice: resolvedUnitPrice, matchedTier } = resolveRcUnitPrice(type, quantity, userRole)
    let unitPrice = resolvedUnitPrice

    // Safety: ensure unitPrice is never less than cost_price
    if (unitPrice < type.cost_price) {
        throw new Error('PRICING_ERROR_UNIT_BELOW_COST')
    }

    // Cap shop markup against the role-based maximum (0 = no cap). Shared with the USSD path.
    const appliedMarkup = capRCMarkup(shopMarkup, userRole, settings)

    const subtotal = parseFloat(((unitPrice + appliedMarkup) * quantity).toFixed(2))

    let paystackFee = 0
    if (includePaystackFee) {
        const feePercent = parseFloat(settings['results_checker_paystack_fee_percent'] || '1.95')
        paystackFee = parseFloat((subtotal * (feePercent / 100)).toFixed(2))
    }

    return {
        unitPrice,
        shopMarkup: appliedMarkup,
        subtotal,
        paystackFee,
        total: parseFloat((subtotal + paystackFee).toFixed(2)),
        appliedBulkTier: matchedTier || null,
    }
}

// ─── Wallet Purchase Flow ──────────────────────────────────────────────────

/**
 * Full wallet-based purchase flow.
 * Mirrors app/api/airtime/create/route.ts exactly:
 *   1. Atomic wallet deduction via deduct_wallet_balance RPC
 *   2. Create order record
 *   3. Assign vouchers via RPC (all-or-nothing)
 *   4. On failure → refund wallet → throw
 *   5. Finalize sale → mark completed
 *   6. Fire-and-forget wallet_transactions record
 */
export async function purchaseWithWallet(params: {
    userId: string
    userRole: string
    typeId: string
    quantity: number
    shopId?: string | null
    shopMarkup?: number
    customerPhone?: string | null
    customerEmail?: string | null
    customerName?: string | null
    // API v2 threading (Task 6 / CONTROLLER RULING R2): the dashboard caller
    // (app/api/results-checker/purchase/route.ts) never passes any of these
    // three, so the defaults below MUST reproduce today's exact behaviour —
    // source falls back to the results_checker_orders column default
    // ('website', see supabase/migrations/20260606_add_source_to_orders.sql),
    // apiKeyId stays null, and referenceCode is generated internally exactly
    // as before.
    apiKeyId?: string | null
    source?: string
    referenceCode?: string
}): Promise<{ order: RCOrder; vouchers: RCVoucher[]; newBalance: number }> {
    const {
        userId, userRole, typeId, quantity, shopId = null, shopMarkup = 0,
        customerPhone = null, customerEmail = null, customerName = null,
        apiKeyId = null, source = 'website',
    } = params
    const supabase = createServerClient()
    const db = supabase as any

    // Fetch type
    const type = await getTypeById(typeId)
    if (!type || !type.is_active) throw new Error('VOUCHER_TYPE_NOT_FOUND')

    // Sub-agent pricing overrides the role price entirely (spec C2) — fails closed
    // before any wallet deduction (spec C7).
    //
    // Was dashboard-only (review finding I1, gated on `source !== 'api'`) — lifted
    // 2026-09-17 (spec §11 lift) once app/api/v2/resultschecker/purchase stopped
    // 403-blocking sub-agents outright. purchaseWithWallet is the SHARED function
    // behind both app/api/results-checker/purchase (dashboard, source defaults to
    // 'website') and app/api/v2/resultschecker/purchase (source: 'api') — now runs
    // identically for both, same as every other product's sub-agent wiring.
    let recruiterMargin: { recruiterId: string; amount: number } | null = null
    let subAgentUnitPrice: number | null = null
    {
        // Server-side teeth for spec C4's "unconfigured = unbuyable" guarantee (Task 11):
        // resolveSubAgentRcCost treats "no pricing configured" and "configured at zero markup"
        // identically (both resolve through resolveSubAgentMarkup returning 0), so the
        // dashboard hide alone doesn't stop a raw dashboard-path call. Checked BEFORE the cost
        // resolver via our own resolveSubAgentContext call, then the SAME fail-closed convention
        // (throw SUB_AGENT_PRICING_UNAVAILABLE) this function already uses just below.
        const preCtx = await resolveSubAgentContext(db, userId)
        if (
            preCtx.isSub && preCtx.effectiveActive && preCtx.recruiterId
            && !(await hasSubAgentPricingConfigured(db, preCtx.recruiterId, userId, 'results_checker', type.id))
        ) {
            throw new Error('SUB_AGENT_PRICING_UNAVAILABLE')
        }

        const subCtx = await resolveSubAgentRcCost(db, userId, type, quantity)
        if (subCtx.isSub) {
            if (!subCtx.ok) {
                throw new Error('SUB_AGENT_PRICING_UNAVAILABLE')
            }
            subAgentUnitPrice = subCtx.subCost
            if (subCtx.recruiterEarns > 0 && subCtx.recruiterId) {
                recruiterMargin = { recruiterId: subCtx.recruiterId, amount: subCtx.recruiterEarns * quantity }
            }
        }
    }

    // Calculate price (server-side, no Paystack fee for wallet purchases)
    const breakdown = await calculateRCPrice({ type, quantity, userRole, shopMarkup })
    if (subAgentUnitPrice !== null) {
        const overriddenSubtotal = parseFloat(((subAgentUnitPrice + breakdown.shopMarkup) * quantity).toFixed(2))
        breakdown.unitPrice = subAgentUnitPrice
        breakdown.subtotal = overriddenSubtotal
        breakdown.total = overriddenSubtotal + (breakdown.paystackFee ?? 0)
    }

    // ── Atomic wallet deduction (mirrors airtime/create L156-160) ─────────
    const { data: deductResult, error: deductError } = await db
        .rpc('deduct_wallet_balance', {
            p_user_id: userId,
            p_amount: breakdown.total,
        })

    if (deductError) {
        if (deductError.message?.includes('INSUFFICIENT_BALANCE')) {
            throw new Error('INSUFFICIENT_BALANCE')
        }
        console.error('[RC Service] Wallet deduction error:', deductError)
        throw new Error('PAYMENT_FAILED')
    }

    const walletRow = deductResult?.[0] || deductResult
    const walletId = walletRow?.wallet_id
    const newBalance: number = walletRow?.new_balance ?? 0

    if (!walletId) throw new Error('WALLET_NOT_FOUND')

    // Caller's own reference (v2 API) wins so the idempotency lookup, the
    // UNIQUE(reference_code) backstop, and the echoed-back reference all line
    // up with what the caller searched for. Otherwise generate as before.
    const referenceCode = params.referenceCode ?? `RC-${generateReferenceCode()}`

    // ── Create pending order record ───────────────────────────────────────
    const { data: order, error: orderError } = await db
        .from('results_checker_orders')
        .insert({
            user_id:           userId,
            user_role:         userRole,
            shop_id:           shopId,
            type_id:           typeId,
            type_name:         type.name,
            quantity,
            unit_price:        breakdown.unitPrice,
            shop_markup:       breakdown.shopMarkup,
            cost_price_at_time: type.cost_price,
            total_paid:        breakdown.total,
            status:            'pending',
            payment_status:    'completed',
            // Paid from the wallet above — without this the column default ('momo') applied.
            payment_method:    'wallet',
            reference_code:    referenceCode,
            source,
            api_key_id:        apiKeyId,
            // Persisted (not just merged in-memory for the first delivery attempt) so
            // resendVouchers() — called by the admin/user resend button AND the
            // fulfill-pending-rc-vouchers retry cron — can actually reach the customer
            // on every subsequent attempt, not just the one right after purchase.
            customer_phone:    customerPhone,
            customer_email:    customerEmail,
            customer_name:     customerName,
        })
        .select()
        .single()

    if (orderError || !order) {
        // Refund wallet via the atomic RPC — never an absolute write from a cached `newBalance`
        // snapshot (that races with concurrent top-ups/deductions). Matches airtime/create.
        await db.rpc('credit_wallet_balance', { p_user_id: userId, p_amount: breakdown.total })
        console.error('[RC Service] Order creation error:', orderError)
        throw new Error('ORDER_CREATION_FAILED')
    }

    // ── Assign vouchers via RPC (all-or-nothing) ──────────────────────────
    const { data: vouchers, error: assignError } = await db
        .rpc('assign_results_checker_vouchers', {
            p_type_id:  typeId,
            p_quantity: quantity,
            p_order_id: order.id,
        })

    if (assignError || !vouchers || vouchers.length === 0) {
        // Refund wallet via the atomic RPC (no racy absolute write) — insufficient inventory
        await db.rpc('credit_wallet_balance', { p_user_id: userId, p_amount: breakdown.total })
        // Mark order as failed
        await db.from('results_checker_orders')
            .update({ status: 'failed', updated_at: new Date().toISOString() })
            .eq('id', order.id)

        throw new Error('INSUFFICIENT_INVENTORY')
    }

    // ── Finalize sale ────────────────────────────────────────────────────
    await db.rpc('finalize_results_checker_sale', {
        p_order_id: order.id,
        p_user_id:  userId,
    })

    const inventoryIds: string[] = vouchers.map((v: RCVoucher) => v.id)

    // Sub-agent purchase: credit the ONE direct recruiter (spec C3). MUST happen before the
    // completed-status UPDATE below — that UPDATE is what fires the trigger that credits the
    // recruiter's wallet, and the trigger can only find a row that already exists. Getting this
    // ordering backwards means the trigger fires against nothing and the recruiter is never
    // credited, silently, with no error (verified against this file's actual synchronous
    // pending→completed transition before this plan was written).
    if (recruiterMargin) {
        await recordPendingSubAgentEarning(db, {
            orderReference: referenceCode,
            orderTable: 'results_checker_orders',
            recruiterId: recruiterMargin.recruiterId,
            subUserId: userId,
            amount: recruiterMargin.amount,
        }).catch((e) => console.error('[RC Service] recordPendingSubAgentEarning threw:', e))
    }

    // ── Update order → completed ─────────────────────────────────────────
    const { data: completedOrder } = await db
        .from('results_checker_orders')
        .update({
            status:        'completed',
            payment_status:'completed',
            inventory_ids: inventoryIds,
            fulfilled_at:  new Date().toISOString(),
            updated_at:    new Date().toISOString(),
        })
        .eq('id', order.id)
        .select()
        .single()

    // ── Wallet transaction record ─────────────────────────────────────────
    // waitUntil, not a bare floating promise: the wallet has ALREADY been
    // debited above, so a lambda freeze right after the response would leave
    // that debit with no matching wallet_transactions row — an audit gap on a
    // money path (review finding m2, third and last instance).
    //
    // Safe to call from this shared service because purchaseWithWallet has
    // exactly TWO callers and both are request handlers — verified, not
    // assumed: app/api/results-checker/purchase/route.ts (dashboard) and
    // app/api/v2/resultschecker/purchase/route.ts (developer API). An earlier
    // pass left this one unwrapped out of caution that the service might run
    // outside a request context; it does not. If a cron caller is ever added,
    // it must supply its own context rather than call this directly.
    waitUntil((db.from('wallet_transactions') as any).insert({
        wallet_id:   walletId,
        user_id:     userId,
        type:        'debit',
        amount:      breakdown.total,
        description: `Results Checker: ${quantity}x ${type.name}`,
        reference:   referenceCode,
        source:      'results_checker',
        status:      'completed',
    }).then(() => {}).catch((e: any) =>
        console.error('[RC Service] Wallet tx insert error:', e)
    ))

    // ── In-app notification (fire-and-forget) ─────────────────────────────
    ;(db.from('notifications') as any).insert({
        user_id:    userId,
        title:      'Results Checker Voucher Purchased',
        message:    `${quantity}x ${type.name} voucher(s) ready. Ref: ${referenceCode}`,
        type:       'order_update',
        action_url: '/dashboard/results-checker',
    }).then(() => {}).catch((e: any) =>
        console.error('[RC Service] Notification insert error:', e)
    )

    return {
        order:      completedOrder || order,
        vouchers:   vouchers as RCVoucher[],
        newBalance,
    }
}

// ─── Shop Order Processing (webhook handler) ───────────────────────────────

/**
 * Resolves (and reconciliation-checks) the recruiter earning for an RC storefront sale at
 * confirmation/repair time. Shared by processRCShopOrder's main flow (after a winning CAS
 * claim) AND its replay-repair path (review finding I2) so a repair attempt reuses the exact
 * same ineligibility/pricing/reconciliation checks rather than a second copy that could drift
 * or double-credit.
 *
 * `frozenUnitCostBasis` is the per-unit cost basis the guest was actually quoted AT CHECKOUT
 * TIME, reconstructed from the already-persisted order row rather than a new column (review
 * finding I1 — no schema change): initialize/charge insert `unit_price` as
 * (subAgentUnitPrice-or-role-price + shopMarkup) and `shop_markup` as the shop's own markup
 * alone, so `unit_price - shop_markup` recovers the frozen per-unit cost basis exactly,
 * whether or not the sale was a sub-agent sale. Comparing that against the LIVE
 * resolveSubAgentRcCost result here catches a markup/role edit that landed between checkout
 * and this webhook — if the two disagree, pricing changed mid-flight, so no earning is
 * recorded (logged instead), never a re-computed amount that could over/under-credit the
 * recruiter.
 *
 * Returns null (and has already logged/audited) whenever no earning should be recorded —
 * not a sub, ineligible, pricing rejected, zero markup, or a reconciliation mismatch. Never
 * throws — safe to call from an idempotency/replay branch.
 */
async function resolveVerifiedRcSubEarning(
    db: any,
    ownerId: string,
    typeId: string,
    quantity: number,
    frozenUnitCostBasis: number,
    reference: string,
    earningShopId: string,
): Promise<{ recruiterId: string; amount: number } | null> {
    const subCtx = await resolveSubAgentContext(db, ownerId)
    if (!subCtx.isSub) return null

    if (!subCtx.effectiveActive) {
        console.error(`[RC Webhook] 🚨 INELIGIBLE SUB at completion: Ref=${reference} shop=${earningShopId} owner=${ownerId} — no recruiter earning recorded; guest fulfillment proceeds unaffected.`)
        await db.from('security_events').insert({
            event_type: 'rc_shop_ineligible_sub_no_earning',
            reference,
            shop_id: earningShopId,
            order_type: 'results_checker',
            detail: { owner_id: ownerId, reason: subCtx.inactiveReason ?? 'unknown' },
            created_at: new Date().toISOString(),
        }).catch((e: any) => console.error('[RC Webhook] security_events insert failed:', e))
        return null
    }

    const type = await getTypeById(typeId)
    if (!type) {
        console.error(`[RC Webhook] 🚨 TYPE NOT FOUND for sub-agent pricing: Ref=${reference} typeId=${typeId} — no recruiter earning recorded; guest fulfillment proceeds unaffected.`)
        return null
    }

    const subResult = await resolveSubAgentRcCost(db, ownerId, type, quantity)
    if (!subResult.ok) {
        console.error(`[RC Webhook] 🚨 SUB PRICING UNAVAILABLE at completion: Ref=${reference} owner=${ownerId} reason=${subResult.reason} — no recruiter earning recorded; guest fulfillment proceeds unaffected.`)
        await db.from('security_events').insert({
            event_type: 'rc_shop_sub_pricing_unavailable_no_earning',
            reference,
            shop_id: earningShopId,
            order_type: 'results_checker',
            detail: { owner_id: ownerId, reason: subResult.reason ?? 'unknown' },
            created_at: new Date().toISOString(),
        }).catch((e: any) => console.error('[RC Webhook] security_events insert failed:', e))
        return null
    }

    if (!(subResult.recruiterEarns > 0 && subResult.recruiterId)) return null

    // I1 reconciliation: live-resolved per-unit subCost vs. the FROZEN per-unit cost basis
    // captured at checkout. Rounded to 2dp tolerance for normal float rounding.
    const liveSubCost = Number(subResult.subCost)
    const frozen = Number(frozenUnitCostBasis)
    if (!Number.isFinite(frozen) || Math.abs(liveSubCost - frozen) > 0.01) {
        console.error(`[RC Webhook] 🚨 EARNING PRICE MISMATCH: Ref=${reference} shop=${earningShopId} owner=${ownerId} liveSubCost=${liveSubCost} frozenUnitCostBasis=${frozen} — pricing changed between checkout and confirmation; no recruiter earning recorded, guest fulfillment proceeds unaffected.`)
        await db.from('security_events').insert({
            event_type: 'rc_shop_earning_price_mismatch',
            reference,
            shop_id: earningShopId,
            order_type: 'results_checker',
            detail: { owner_id: ownerId, live_sub_cost: liveSubCost, frozen_unit_cost_basis: frozen },
            created_at: new Date().toISOString(),
        }).catch((e: any) => console.error('[RC Webhook] security_events insert failed:', e))
        return null
    }

    return { recruiterId: subResult.recruiterId, amount: subResult.recruiterEarns * quantity }
}

/**
 * Replay repair for a lost recordPendingSubAgentEarning write (review finding I2), mirroring
 * repairSubAgentEarning in lib/shop-order-processor.ts: the CAS-lost branch in
 * processRCShopOrder (claimed.length === 0) is the ONLY path a replayed webhook/status-poll
 * call reaches for an already-claiming order, so if the winning attempt's earning write
 * failed, this is the last chance to record it. Reuses resolveVerifiedRcSubEarning — the
 * SAME reconciliation-aware resolver the main flow uses — so a repair can never ALSO
 * silently overcredit off a stale price. Never throws.
 */
async function repairSubAgentRcEarning(db: any, existingOrder: any, reference: string): Promise<void> {
    try {
        const shopId: string | null = existingOrder?.shop_id ?? null
        if (!shopId) return

        const { data: shopOwnerRow, error: shopOwnerErr } = await db
            .from('shop_profiles')
            .select('owner_id')
            .eq('id', shopId)
            .maybeSingle()
        if (shopOwnerErr) {
            console.error(`[RC Webhook] replay repair: owner lookup error for ${reference}:`, shopOwnerErr)
            return
        }
        const ownerId: string | undefined = shopOwnerRow?.owner_id
        if (!ownerId) return

        const typeId = existingOrder?.type_id
        const quantity = Number(existingOrder?.quantity) || 1
        const frozenUnitCostBasis = Number(existingOrder?.unit_price) - Number(existingOrder?.shop_markup)

        const earning = await resolveVerifiedRcSubEarning(db, ownerId, typeId, quantity, frozenUnitCostBasis, reference, shopId)
        if (!earning) return

        const result = await recordPendingSubAgentEarning(db, {
            orderReference: reference,
            orderTable: 'results_checker_orders',
            recruiterId: earning.recruiterId,
            subUserId: ownerId,
            amount: earning.amount,
        })
        if (!result.success) {
            console.error(`[RC Webhook] replay repair FAILED for ${reference}: ${result.message}`)
        }
    } catch (e) {
        console.error(`[RC Webhook] replay repair threw for ${reference}:`, e)
    }
}

/**
 * Processes a successful Paystack payment for an RC storefront order.
 * Called by the webhook when reference starts with 'RC-'.
 * Mirrors processShopOrder from lib/shop-order-processor.ts.
 */
export async function processRCShopOrder(
    reference: string,
    metadata: {
        rc_order_id?: string
        type_id?: string
        quantity?: number
        shop_id?: string
        shop_name?: string
        guest_phone?: string
        guest_email?: string
        unit_price?: number
        shop_markup?: number
        subtotal?: number
        paystack_fee?: number
        total_charged?: number
        cost_price_at_time?: number
        type_name?: string
    },
    paidAmountKobo: number
): Promise<{ success: boolean; error?: string; orderId?: string; isDuplicate?: boolean }> {
    const supabase = createServerClient()
    const db = supabase as any

    try {
        // 1. Idempotency check
        const { data: existingOrder } = await db
            .from('results_checker_orders')
            .select('id, status, payment_status, total_paid, shop_id, shop_markup, unit_price, quantity, type_id, type_name')
            .eq('reference_code', reference)
            .maybeSingle()

        if (existingOrder?.payment_status === 'completed') {
            console.log(`[RC Webhook] Already processed: ${reference}`)
            // Replay repair (review finding I2): a LATER replay (delayed Paystack webhook
            // retry, cron re-verify, admin manual-verify) lands here rather than the
            // claimed.length===0 branch below, which only catches a replay that arrives
            // within the same race window as the winning attempt. This branch is equally a
            // dead end for any earning write the winning attempt lost, so it needs the same
            // repair call — same function, same reconciliation-aware resolver, never a
            // second copy.
            await repairSubAgentRcEarning(db, existingOrder, reference)
                .catch((e: any) => console.error('[RC Webhook] replay repair threw:', e))
            return { success: true, orderId: existingOrder.id, isDuplicate: true }
        }

        // 2. Amount verification — the expected price MUST come from the
        // server-created order row, NEVER from client-supplied Paystack metadata.
        // A9: the order row is always inserted at /results-checker/initialize with
        // a server-computed total_paid BEFORE Paystack is called, so by webhook
        // time it exists. The old code fell back to metadata.total_charged when
        // total_paid was absent — a value a tampered init could lower to underpay.
        // If there is no server price we refuse rather than trust the client.
        // (total_paid is numeric → PostgREST may return it as a string, so coerce.)
        const serverPrice = existingOrder?.total_paid != null ? Number(existingOrder.total_paid) : NaN
        if (!Number.isFinite(serverPrice) || serverPrice <= 0) {
            console.error(`[RC Webhook] 🚨 NO SERVER PRICE: Ref=${reference} — order row missing or total_paid null; refusing to trust client metadata`)
            return { success: false, error: 'ORDER_PRICE_NOT_FOUND' }
        }
        const expectedKobo = Math.round(serverPrice * 100)
        const diff = Math.abs(paidAmountKobo - expectedKobo)
        if (diff > 5) {
            console.error(`[RC Webhook] 🚨 AMOUNT MISMATCH: Ref=${reference} Paid=${paidAmountKobo} Expected=${expectedKobo}`)
            return { success: false, error: 'AMOUNT_MISMATCH' }
        }

        // 3. Resolve the pending order
        let orderId = existingOrder?.id || metadata.rc_order_id
        if (!orderId) {
            console.error(`[RC Webhook] Order not found for reference: ${reference}`)
            return { success: false, error: 'ORDER_NOT_FOUND' }
        }

        // 4. ATOMIC CLAIM — flip pending→completed exactly once. The Paystack webhook AND the
        // charge status-poll both call this within ~1s of MoMo approval (the normal path); a plain
        // read-gate (step 1) let BOTH pass and assign DIFFERENT voucher batches (customer gets 2×
        // PINs; the orphan batch is sold against no order = inventory loss). CAS so only the winner
        // proceeds — mirrors the transfer.* claim in the Paystack webhook. Also guards the verify
        // cron + admin manual-verify entry points.
        const { data: claimed } = await db.from('results_checker_orders')
            .update({ payment_status: 'completed', updated_at: new Date().toISOString() })
            .eq('id', orderId)
            .neq('payment_status', 'completed')
            .select('id')
        if (!claimed || claimed.length === 0) {
            console.log(`[RC Webhook] ${reference} claimed concurrently — skipping duplicate fulfillment`)
            // Replay repair (review finding I2): this is the ONLY path a losing/replayed
            // caller reaches — if the winning attempt's earning write failed, retry it here.
            await repairSubAgentRcEarning(db, existingOrder, reference)
                .catch((e: any) => console.error('[RC Webhook] replay repair threw:', e))
            return { success: true, orderId, isDuplicate: true }
        }

        // 4b. Credit the shop owner's markup to their shop wallet (idempotent on ref).
        // Storefront RC sales previously credited NOBODY — only the USSD RC path + data sales
        // did. Reuse credit_shop_ussd_profit ("for RC orders with no shop_orders row"). Values
        // come from the server-created order row (never client metadata), like the amount check.
        // Runs before the backorder return below so the owner is paid at confirmation regardless
        // of stock; the RPC's UNIQUE ussd_ref makes repeat calls (webhook + status poll) safe.
        const creditShopId: string | null = (existingOrder as any)?.shop_id ?? null
        const creditMarkup = Number((existingOrder as any)?.shop_markup) || 0
        const creditQty = Number((existingOrder as any)?.quantity) || 1
        if (creditShopId && creditMarkup > 0) {
            const { error: creditErr } = await db.rpc('credit_shop_ussd_profit', {
                p_shop_id:     creditShopId,
                p_profit:      creditMarkup * creditQty,
                p_ussd_ref:    `RC-SHOP-CREDIT-${reference}`,
                p_description: `RC sale: ${creditQty}x ${(existingOrder as any)?.type_name || 'Voucher'}`,
            })
            if (creditErr) console.error(`[RC Webhook] Shop profit credit error for ${reference}:`, creditErr)
        }

        // 4c. Resolve type/qty from the SERVER order row NOW (moved up from what was step 5,
        // which otherwise re-derived these fresh right before voucher assignment) — never client
        // Paystack metadata (a replayed/tampered init could mismatch them to over-fulfill) — so
        // both the sub-agent earning write below and the eventual assignment call use the exact
        // same values.
        const typeId = (existingOrder as any)?.type_id ?? metadata.type_id
        const quantity = Number((existingOrder as any)?.quantity ?? metadata.quantity) || 1

        // 4d. Sub-agent recruiter earning (Plan 2c, Task 4). MUST land here: after the CAS claim
        // above succeeds (so this can never run twice, regardless of which branch the order
        // takes below) and strictly BEFORE the real status:'completed' UPDATE (step 6 below, and
        // the backorder branch's payment_status-only update inside step 5) — that UPDATE is what
        // the SQL trigger (built in an earlier plan) watches to credit the recruiter's wallet. If
        // this write hasn't landed by then, the trigger fires against an empty ledger and the
        // recruiter's commission is lost silently, with no error visible anywhere. Placed ONCE,
        // ahead of the backorder/normal-fulfillment branch split, so neither branch can skip it
        // and neither can double-write it.
        //
        // Unlike Tasks 1/3 (checkout-time, before Paystack captures payment — safe to refuse the
        // sale outright) and unlike lib/shop-afa-order-processor.ts's own ineligible-sub guard
        // (which still runs before ITS order row is created and can safely block/refund the
        // guest), by this point the guest has ALREADY PAID and this RC order row already exists
        // as claimed/completing. Blocking here would strand a paying customer over an internal
        // recruiter-crediting problem that is not their fault. So a sub-agent pricing failure or
        // an ineligible/suspended recruiter chain found here records NO earning, logs loudly via
        // security_events, and lets voucher fulfillment proceed normally below — this is a
        // recruiter-earning-write failure, not a reason to strand the guest's vouchers.
        const earningShopId: string | null = (existingOrder as any)?.shop_id ?? metadata.shop_id ?? null
        if (earningShopId) {
            const { data: shopOwnerRow, error: shopOwnerErr } = await db
                .from('shop_profiles')
                .select('owner_id')
                .eq('id', earningShopId)
                .maybeSingle()
            // m1: a transient DB error here previously failed open silently (skipped the whole
            // guard AND the earning with no log). Not a behavior change — still proceeds with
            // ownerId undefined below — just now visible.
            if (shopOwnerErr) console.error(`[RC Webhook] shop owner lookup error for ${reference}:`, shopOwnerErr)
            const ownerId: string | undefined = (shopOwnerRow as any)?.owner_id

            if (ownerId) {
                // I1: frozen per-unit cost basis reconstructed from the persisted order row —
                // see resolveVerifiedRcSubEarning's doc comment for why this is exact, not an
                // approximation, and needs no new column.
                const frozenUnitCostBasis = Number((existingOrder as any)?.unit_price) - Number((existingOrder as any)?.shop_markup)
                const earning = await resolveVerifiedRcSubEarning(db, ownerId, typeId, quantity, frozenUnitCostBasis, reference, earningShopId)
                if (earning) {
                    await recordPendingSubAgentEarning(db, {
                        orderReference: reference,
                        orderTable: 'results_checker_orders',
                        recruiterId: earning.recruiterId,
                        subUserId: ownerId,
                        amount: earning.amount,
                    }).catch((e) => console.error('[RC Webhook] recordPendingSubAgentEarning threw:', e))
                }
            }
        }

        // 5. Attempt voucher assignment — type/qty resolved above (step 4c).
        const { data: vouchers, error: assignError } = await db
            .rpc('assign_results_checker_vouchers', {
                p_type_id:  typeId,
                p_quantity: quantity,
                p_order_id: orderId,
            })

        if (assignError || !vouchers || vouchers.length === 0) {
            // Backorder: payment done but no stock — keep pending for auto-fulfill on upload
            console.warn(`[RC Webhook] Backorder created for ${reference} — no stock available`)
            await db.from('results_checker_orders')
                .update({ status: 'pending', payment_status: 'completed', updated_at: new Date().toISOString() })
                .eq('id', orderId)
            return { success: true, orderId }
        }

        // 6. Finalize
        await db.rpc('finalize_results_checker_sale', {
            p_order_id: orderId,
            p_user_id:  null,
        })

        const inventoryIds: string[] = vouchers.map((v: RCVoucher) => v.id)

        await db.from('results_checker_orders')
            .update({
                status:        'completed',
                payment_status:'completed',
                inventory_ids: inventoryIds,
                fulfilled_at:  new Date().toISOString(),
                updated_at:    new Date().toISOString(),
            })
            .eq('id', orderId)

        // 7. Deliver vouchers (non-blocking)
        if (metadata.guest_phone || metadata.guest_email) {
            const { deliverVouchers } = await import('./results-checker-notification-service')
            const orderForDelivery = {
                id:             orderId,
                reference_code: reference,
                type_name:      metadata.type_name || '',
                quantity,
                customer_phone: metadata.guest_phone || null,
                customer_email: metadata.guest_email || null,
                // Feature-wave5 Task 2: shop_id must flow through so deliverVouchers can
                // resolve the shop's approved sender — this is a guest shop RC purchase
                // (Paystack webhook), so there is no user_id to fall back to.
                shop_id:        (existingOrder as any)?.shop_id ?? metadata.shop_id ?? null,
            }
            deliverVouchers(orderForDelivery as any, vouchers as RCVoucher[])
                .catch((e: any) => console.error('[RC Webhook] Delivery error:', e))
        }

        return { success: true, orderId }
    } catch (err) {
        console.error('[RC Webhook] processRCShopOrder error:', err)
        return { success: false, error: 'INTERNAL_ERROR' }
    }
}

// ─── Backorder Auto-Fulfillment ────────────────────────────────────────────

/**
 * Called non-blocking after admin uploads new inventory.
 * Finds pending+paid RC orders for a type and fulfills them FIFO.
 */
export async function fulfillPendingRCOrders(typeId: string): Promise<void> {
    const supabase = createServerClient()
    const db = supabase as any

    const { data: pendingOrders } = await db
        .from('results_checker_orders')
        .select('*')
        .eq('type_id', typeId)
        .eq('status', 'pending')
        .eq('payment_status', 'completed')
        .order('created_at', { ascending: true })

    if (!pendingOrders || pendingOrders.length === 0) return

    for (const order of pendingOrders) {
        try {
            // Pre-assignment guard: verify order is still pending before locking
            const { data: currentOrder } = await db
                .from('results_checker_orders')
                .select('status')
                .eq('id', order.id)
                .single()
                
            if (!currentOrder || currentOrder.status !== 'pending') {
                console.log(`[RC Backorder] Order ${order.id} is no longer pending. Skipping.`)
                continue
            }

            const { data: vouchers, error: assignError } = await db
                .rpc('assign_results_checker_vouchers', {
                    p_type_id:  typeId,
                    p_quantity: order.quantity,
                    p_order_id: order.id,
                })

            if (assignError || !vouchers || vouchers.length === 0) {
                // Not enough stock for this order yet or assignment failed — skip this order, don't break the queue
                console.log(`[RC Backorder] Assignment failed/insufficient stock for order ${order.id}. Skipping. Error:`, assignError)
                continue
            }

            await db.rpc('finalize_results_checker_sale', {
                p_order_id: order.id,
                p_user_id:  order.user_id || null,
            })

            const inventoryIds: string[] = vouchers.map((v: RCVoucher) => v.id)

            await db.from('results_checker_orders')
                .update({
                    status:        'completed',
                    inventory_ids: inventoryIds,
                    fulfilled_at:  new Date().toISOString(),
                    updated_at:    new Date().toISOString(),
                })
                .eq('id', order.id)

            // Deliver
            const { deliverVouchers } = await import('./results-checker-notification-service')
            deliverVouchers(order as RCOrder, vouchers as RCVoucher[])
                .catch((e: any) => console.error('[RC Backorder] Delivery error:', e))

        } catch (err) {
            console.error(`[RC Backorder] Failed to fulfill order ${order.id}:`, err)
        }
    }
}
