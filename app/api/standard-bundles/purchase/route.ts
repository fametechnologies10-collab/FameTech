import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { effectiveRoleFromExpiry } from '@/lib/effective-role'
import { resolveSubAgentContext } from '@/lib/sub-agent-account'
import { consumeRateLimit } from '@/lib/simple-rate-limit'
import { getBundleCatalog } from '@/lib/kingflexy-bundles-service'
import { recordBundleDebitLedger } from '@/lib/standard-bundles-ledger'
import {
    bundleKillSwitchKeys,
    computeBundlePrice,
    findBundle,
    isBundleFlagEnabled,
    isValidBeneficiary,
    isValidIdempotencyKey,
    normalizeBundleNetwork,
    parseDiscountSetting,
    referenceFromKey,
    validateBroadbandAmount,
    type BundleKind,
} from '@/lib/standard-bundles-logic'

const fail = (error: string, status: number) =>
    NextResponse.json({ success: false, error }, { status })

export async function POST(request: NextRequest) {
    try {
        // Auth via the cookie/RLS-aware client only. The service client has no session.
        const routeClient = await createRouteClient()
        const { data: { user: authUser }, error: authError } = await routeClient.auth.getUser()
        if (authError || !authUser) return fail('Unauthorized', 401)

        const userId = authUser.id
        const supabase = createServerClient()

        let body: any
        try {
            body = await request.json()
        } catch {
            return fail('Invalid request body', 400)
        }

        const { kind, network: rawNetwork, beneficiaryPhone, value, packId, amount, idempotencyKey } = body || {}

        if (kind !== 'standard' && kind !== 'special' && kind !== 'broadband') {
            return fail('Invalid bundle type', 400)
        }
        const bundleKind: BundleKind = kind
        const storedNetwork = normalizeBundleNetwork(bundleKind, rawNetwork)
        if (!storedNetwork) return fail('Invalid network', 400)
        // Catalog family: broadband lives in the Telecel catalog.
        const catalogNetwork: 'MTN' | 'Telecel' | 'AT' = storedNetwork === 'TelecelBroadband' ? 'Telecel' : storedNetwork

        if (!isValidIdempotencyKey(idempotencyKey)) return fail('Invalid idempotency key', 400)

        const cleanPhone = String(beneficiaryPhone ?? '').replace(/\s+/g, '')
        if (!isValidBeneficiary(bundleKind, cleanPhone)) {
            return fail('Invalid phone number. Use Ghana format: 0XXXXXXXXX (10 digits starting with 0)', 400)
        }

        if (bundleKind === 'special' && (typeof packId !== 'string' || !packId)) {
            return fail('Missing bundle selection', 400)
        }
        if (bundleKind === 'standard' && (typeof value !== 'string' || !value)) {
            return fail('Missing bundle selection', 400)
        }

        // Per-user backstop (per-instance memory). Middleware's general /api limiter also applies.
        const rl = consumeRateLimit(`std-bundles-purchase:${userId}`, 10, 60 * 1000)
        if (!rl.allowed) return fail('Too many requests. Please wait a moment and try again.', 429)

        // Client idempotency replay, scoped to the caller and checked BEFORE anything is debited.
        const clientReference = referenceFromKey(idempotencyKey)
        const orderCols = 'id, reference_code, status, network, kind, beneficiary_phone, bundle_label, total_paid'
        const replayOf = async () => {
            const { data } = await (supabase as any).from('standard_bundle_orders')
                .select(orderCols)
                .eq('reference_code', clientReference)
                .eq('user_id', userId)
                .maybeSingle()
            return data as any | null
        }
        const replayResponse = (o: any) => NextResponse.json({
            success: true,
            data: {
                order: {
                    id: o.id, reference_code: o.reference_code, status: o.status, network: o.network,
                    kind: o.kind, beneficiary_phone: o.beneficiary_phone, bundle_label: o.bundle_label,
                    total_paid: Number(o.total_paid), isDuplicate: true,
                },
            },
        })
        const existing = await replayOf()
        if (existing) return replayResponse(existing)

        // User + settings
        const killKeys = bundleKillSwitchKeys(storedNetwork === 'TelecelBroadband' ? 'Telecel' : storedNetwork, bundleKind)
        const discountKey = `std_bundles_discount_${catalogNetwork.toLowerCase()}`
        const [userResult, settingsResult] = await Promise.all([
            (supabase.from('users') as any)
                .select('role, status, dealer_expires_at, agent_expires_at')
                .eq('id', userId)
                .single(),
            (supabase.from('admin_settings') as any).select('key, value').in('key', [...killKeys, discountKey]),
        ])
        if (userResult.error || !userResult.data) return fail('User not found', 404)
        const userData = userResult.data as any

        if (userData.status === 'suspended') {
            return fail('Your account is currently suspended. Please contact support.', 403)
        }
        const subCtx = await resolveSubAgentContext(supabase, userId)
        if (subCtx.isSub && !subCtx.effectiveActive) {
            return fail(subCtx.inactiveReason || 'Your account is not currently active', 403)
        }

        const userRole = effectiveRoleFromExpiry(
            userData.role,
            userData.agent_expires_at ?? null,
            userData.dealer_expires_at ?? null,
        )

        const settings: Record<string, unknown> = {}
        for (const s of (settingsResult.data || []) as any[]) settings[s.key] = s.value

        if (!isBundleFlagEnabled(settings[killKeys[0]])) {
            return fail('Bundles are currently unavailable. Please try again later.', 503)
        }
        if (!isBundleFlagEnabled(settings[killKeys[1]])) {
            return fail(`${bundleKind === 'broadband' ? 'Broadband' : catalogNetwork} bundles are currently unavailable. Please try again later.`, 503)
        }

        // Server-side catalog lookup. Nothing price-related from the client is used.
        const catalog = await getBundleCatalog(catalogNetwork)
        if (!catalog.ok || !catalog.data) {
            return fail('Bundles are temporarily unavailable. Please try again shortly.', 503)
        }
        if (!catalog.data.enabled) {
            return fail('Bundles are currently unavailable. Please try again later.', 503)
        }

        let catalogPrice: number // base for the discount
        let sentAmount: number // exactly what the supplier will be sent
        let catalogValue: string | null = null
        let catalogPackId: string | null = null
        let bundleLabel: string

        if (bundleKind === 'broadband') {
            const bb = catalog.data.broadband
            if (!bb) return fail('This bundle is no longer available. Please refresh.', 404)
            if (!bb.enabled) return fail('Broadband is currently unavailable. Please try again later.', 503)
            const validAmount = validateBroadbandAmount(amount, bb.min, bb.max)
            if (validAmount === null) {
                return fail(`Enter an amount between GHS ${bb.min.toFixed(2)} and GHS ${bb.max.toFixed(2)}.`, 400)
            }
            catalogPrice = validAmount
            sentAmount = validAmount
            bundleLabel = 'Telecel Broadband'
        } else {
            const found = findBundle(
                catalog.data.bundles,
                bundleKind === 'special' ? { pack_id: packId } : { value },
            )
            if (!found || (bundleKind === 'special' ? !found.pack_id : !found.value)) {
                return fail('This bundle is no longer available. Please refresh.', 404)
            }
            catalogPrice = found.price
            sentAmount = found.amount
            catalogValue = found.value
            catalogPackId = found.pack_id
            bundleLabel = (found.size || found.family_label || 'Data bundle').slice(0, 120)
        }

        const discountPct = bundleKind === 'broadband' ? 0 : parseDiscountSetting(settings[discountKey])
        const totalPaid = computeBundlePrice({ catalogPrice, discountSetting: discountPct, kind: bundleKind })
        if (totalPaid === null) return fail('This bundle is currently unavailable.', 400)

        // Atomic wallet deduction (RPC; never a direct UPDATE)
        const { data: deductResult, error: deductError } = await (supabase as any)
            .rpc('deduct_wallet_balance', { p_user_id: userId, p_amount: totalPaid })

        if (deductError) {
            if (deductError.message?.includes('INSUFFICIENT_BALANCE')) {
                return fail('Insufficient balance. Please top up your wallet.', 400)
            }
            console.error('[StandardBundles] wallet deduction error:', deductError)
            return fail('Failed to process payment', 500)
        }

        const refund = async (why: string) => {
            const { error: refundError } = await (supabase as any).rpc('credit_wallet_balance', {
                p_user_id: userId,
                p_amount: totalPaid,
            })
            if (refundError) {
                console.error(`[StandardBundles] CRITICAL: refund failed after ${why} (user ${userId}, GHS ${totalPaid}, ref ${clientReference}); manual reconciliation required:`, refundError)
            }
        }

        const walletRow = deductResult?.[0] || deductResult
        const walletId = walletRow?.wallet_id
        const newBalance = walletRow?.new_balance

        if (!walletId) {
            // The debit was applied (the RPC raises otherwise). Refund before failing.
            await refund('missing wallet_id post-deduct')
            return fail('Failed to process payment', 500)
        }

        const { data: order, error: orderError } = await (supabase as any).from('standard_bundle_orders')
            .insert({
                reference_code: clientReference,
                user_id: userId,
                user_role: userRole,
                network: storedNetwork,
                kind: bundleKind,
                catalog_value: catalogValue,
                pack_id: catalogPackId,
                bundle_label: bundleLabel,
                beneficiary_phone: cleanPhone,
                catalog_price: sentAmount,
                discount_pct: discountPct,
                total_paid: totalPaid,
                status: 'pending',
                source: 'web',
            })
            .select('id')
            .single()

        if (orderError || !order) {
            console.error('[StandardBundles] order creation error:', orderError)
            await refund('order-insert failure')
            // Concurrent request with the same key: the loser's insert hit the UNIQUE reference_code.
            // It has just been refunded; hand back the winner's order.
            if (orderError && (orderError.code === '23505' || orderError.message?.includes('duplicate key'))) {
                const winner = await replayOf()
                if (winner) return replayResponse(winner)
            }
            return fail('Failed to create order', 500)
        }

        waitUntil(recordBundleDebitLedger(supabase, {
            wallet_id: walletId,
            user_id: userId,
            amount: totalPaid,
            description: `Bundle: ${bundleLabel} for ${cleanPhone} (${storedNetwork})`,
            reference: clientReference,
        }))

        waitUntil((async () => {
            const { error } = await (supabase.from('notifications') as any).insert({
                user_id: userId,
                title: 'Bundle Order Placed',
                message: `${bundleLabel} for ${cleanPhone} (${storedNetwork}) is pending. Ref: ${clientReference}`,
                type: 'order_update',
                action_url: '/dashboard/standard-bundles',
            })
            if (error) console.error('[StandardBundles] notification error:', error.message)
        })())

        waitUntil((async () => {
            try {
                const { dispatchBundleFulfillment } = await import('@/lib/standard-bundles-fulfillment')
                await dispatchBundleFulfillment(order.id)
            } catch (e) {
                console.error('[StandardBundles] auto-dispatch failed:', e)
            }
        })())

        return NextResponse.json({
            success: true,
            data: {
                order: {
                    id: order.id,
                    reference_code: clientReference,
                    status: 'pending',
                    network: storedNetwork,
                    kind: bundleKind,
                    beneficiary_phone: cleanPhone,
                    bundle_label: bundleLabel,
                    total_paid: totalPaid,
                    new_balance: newBalance,
                },
            },
        })
    } catch (error) {
        console.error('[StandardBundles] unexpected error:', error)
        return fail('Internal server error', 500)
    }
}
