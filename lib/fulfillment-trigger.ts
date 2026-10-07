import { createServerClient } from '@/lib/supabase'
import { shouldAutoFulfill } from '@/lib/mashup'
import { sanitizeForStorage } from '@/lib/sanitize-for-storage'
import { resolveEnabledSuppliers, type FulfillmentNetworkSettings } from '@/lib/order-supplier'
import {
    claimForDispatch,
    reclaimForFallback,
    acceptDispatch,
    releaseClaim,
} from '@/lib/dispatch-claim'

/**
 * What happened to one order. Returned so a BULK caller can aggregate many
 * outcomes into a single admin email instead of this function emitting one
 * alert per order — see `suppressAdminAlerts` below.
 *
 * Existing single-order callers ignore the return value entirely, which stays
 * source-compatible: adding a return type to a former `Promise<void>` breaks
 * nothing.
 */
export interface TriggerFulfillmentOutcome {
    failed: boolean
    type: 'success' | 'skipped' | 'error'
    reason?: string
    /** The supplier actually dispatched to, when one was. */
    supplier?: string
}

export async function triggerFulfillment(
    orderId: string,
    network: string,
    user: { email: string, name: string },
    options?: {
        dispatchKey?: string
        /**
         * Suppress this function's OWN per-order admin alerts. For bulk callers
         * that aggregate every outcome into one email — without this, a 50-order
         * batch that fails would send 50 separate alerts. The caller becomes
         * responsible for reporting: every suppressed path still returns a
         * populated `reason`, so nothing is silently swallowed.
         */
        suppressAdminAlerts?: boolean
    }
): Promise<TriggerFulfillmentOutcome> {
    try {
        const { sendAdminNewOrderAlert } = await import('@/lib/email-service')
        const { syncShopOrderStatus } = await import('@/lib/shop-service')
        const supabase = createServerClient()

        // Single wrapper for every admin alert in this function, so a future
        // alert added here cannot forget the suppression check. Never throws —
        // an alert failure must not change an order's fate.
        const alertAdmin = async (details: any) => {
            if (options?.suppressAdminAlerts) return
            await sendAdminNewOrderAlert(details).catch((err: any) =>
                console.error('[Fulfillment] Admin alert failed:', err)
            )
        }

        const { data: settingsData } = await supabase
            .from('admin_settings')
            .select('key, value')
            .in('key', ['auto_fulfillment_enabled', 'fulfillment_settings'])

        const settingsMap = (settingsData || []).reduce((acc: any, curr: any) => {
            acc[curr.key] = curr.value
            return acc
        }, {})

        // EGRESS: this was select('*') — 36 columns fetched, and only 7 ever read
        // in this function (verified via grep of every `order.<field>` access
        // below). Measured 2026-09-01: this exact query is the single largest
        // REST shape on the platform, 5,145 requests/day. `id` isn't read here
        // (orderId is already the caller's argument) but is kept for parity with
        // callers that log it.
        const { data: order } = await supabase
            .from('orders')
            .select('id, category, reference_code, phone_number, network, size, price, retry_count')
            .eq('id', orderId)
            .single()

        if (!order) {
            console.error(`[Fulfillment] Order ${orderId} not found`)
            return { failed: true, type: 'error', reason: 'Order not found' }
        }

        if (!shouldAutoFulfill((order as any).category)) {
            console.log(`[Fulfillment] Skipping auto-fulfillment for manual category=${(order as any).category}, order=${orderId}`)
            return { failed: false, type: 'skipped', reason: `Manual category: ${(order as any).category}` }
        }

        const alertDetails = {
            referenceCode: (order as any).reference_code,
            phoneNumber: (order as any).phone_number,
            network: (order as any).network,
            size: (order as any).size,
            price: (order as any).price,
            customerName: user.name,
            customerEmail: user.email,
            source: 'main_site' as const,
            reason: ''
        }

        if (settingsMap.auto_fulfillment_enabled === 'false') {
            await alertAdmin({ ...alertDetails, reason: 'Global auto-fulfillment is disabled' })
            return { failed: true, type: 'skipped', reason: 'Global auto-fulfillment is disabled' }
        }

        // ── Parse all seven supplier network settings ───────────────────────
        let fulfillmentSettings: {
            networks: Record<string, boolean>
            codecraft_networks: Record<string, boolean>
            xpress_networks: Record<string, boolean>
            ghdata_networks: Record<string, boolean>
            agentportal_networks: Record<string, boolean>
            bundleportal_networks: Record<string, boolean>
            hendylinks_networks: Record<string, boolean>
            atishare_console_networks: Record<string, boolean>
            spfastit_networks: Record<string, boolean>
        } = { networks: {}, codecraft_networks: {}, xpress_networks: {}, ghdata_networks: {}, agentportal_networks: {}, bundleportal_networks: {}, hendylinks_networks: {}, atishare_console_networks: {}, spfastit_networks: {} }
        try {
            if (settingsMap.fulfillment_settings) {
                const parsed = typeof settingsMap.fulfillment_settings === 'string'
                    ? JSON.parse(settingsMap.fulfillment_settings)
                    : settingsMap.fulfillment_settings
                fulfillmentSettings.networks = parsed.networks || {}
                fulfillmentSettings.codecraft_networks = parsed.codecraft_networks || {}
                fulfillmentSettings.xpress_networks = parsed.xpress_networks || {}
                fulfillmentSettings.ghdata_networks = parsed.ghdata_networks || {}
                fulfillmentSettings.agentportal_networks = parsed.agentportal_networks || {}
                fulfillmentSettings.bundleportal_networks = parsed.bundleportal_networks || {}
                fulfillmentSettings.hendylinks_networks = parsed.hendylinks_networks || {}
                fulfillmentSettings.atishare_console_networks = parsed.atishare_console_networks || {}
                fulfillmentSettings.spfastit_networks = parsed.spfastit_networks || {}
            }
        } catch (e) {
            console.error('[Fulfillment] Failed to parse fulfillment_settings:', e)
        }

        const isDataKazinaEnabled = fulfillmentSettings.networks[network] === true
        const isCodeCraftEnabled = fulfillmentSettings.codecraft_networks[network] === true
        const isXpressEnabled = fulfillmentSettings.xpress_networks[network] === true
        const isGhDataEnabled = fulfillmentSettings.ghdata_networks[network] === true
        const isAgentPortalEnabled = fulfillmentSettings.agentportal_networks[network] === true
        const isBundlePortalEnabled = fulfillmentSettings.bundleportal_networks[network] === true
        const isHendyLinksEnabled = fulfillmentSettings.hendylinks_networks[network] === true
        const isAtiShareConsoleEnabled = fulfillmentSettings.atishare_console_networks[network] === true
        const isSpfastitEnabled = fulfillmentSettings.spfastit_networks[network] === true
        // Supplier selection comes from the shared registry in lib/order-supplier.ts so
        // this guard can never drift out of sync with the other dispatch paths.
        const enabledSuppliers = resolveEnabledSuppliers(
            fulfillmentSettings as FulfillmentNetworkSettings,
            network
        )
        const enabledCount = enabledSuppliers.length

        // ── Conflict Guard ─────────────────────────────────────────────────
        if (enabledCount > 1) {
            console.error(`[Fulfillment] CONFLICT DETECTED for ${network} on order ${orderId}`)
            await alertAdmin({
                ...alertDetails,
                reason: `⚠️ SYSTEM HALTED: Multiple suppliers active for ${network}. Order ${orderId} kept pending. Fix in admin panel immediately.`
            })
            return { failed: true, type: 'error', reason: `Multiple suppliers active for ${network} — order kept pending` }
        }

        // ── No Supplier Guard ──────────────────────────────────────────────
        if (enabledCount === 0) {
            console.log(`[Fulfillment] No active supplier for network ${network}. Order ${orderId} kept pending.`)
            await alertAdmin({ ...alertDetails, reason: `No active supplier configured for network: ${network}` })
            return { failed: true, type: 'skipped', reason: `No active supplier configured for network: ${network}` }
        }

        // Taken from the registry rather than a ternary chain: the old chain ended in a
        // 'datakazina' default, so any supplier missing from it silently routed to
        // DataKazina instead. enabledSuppliers[0] is exact — both guards above have
        // already returned unless exactly one supplier is enabled.
        const supplierLabel = enabledSuppliers[0]
        console.log(`[Fulfillment] Routing to ${supplierLabel} for order ${orderId} | network: ${network}`)

        // ── Idempotency check ──────────────────────────────────────────────
        // Scoped to the order's CURRENT retry_count, not "has this order ever been
        // tracked" — otherwise every in-place retry (which reuses the same order id)
        // would be blocked outright by its own prior attempt's tracking row. Selecting
        // all matching rows (not .maybeSingle()) also fixes a pre-existing bug: an
        // order can accumulate 2+ tracking rows over its lifetime (e.g. via the bulk
        // refulfill path), which made .maybeSingle() throw.
        const { data: existingTrackingRows } = await supabase
            .from('mtn_fulfillment_tracking')
            .select('id, retry_count')
            .eq('order_id', orderId)

        const alreadyTrackedThisAttempt = (existingTrackingRows || []).some(
            (row: any) => (row.retry_count ?? 0) === ((order as any).retry_count ?? 0)
        )
        if (alreadyTrackedThisAttempt) {
            console.log(`[Fulfillment] Order ${orderId} already tracked for retry_count=${(order as any).retry_count ?? 0}, skipping`)
            // Not a failure: something already dispatched this attempt.
            return { failed: false, type: 'success', reason: 'Already dispatched for this attempt' }
        }

        // ── Claim (NOT a status flip — see lib/dispatch-claim.ts) ───────────
        // orders.status stays 'pending' through the whole dispatch attempt. A claim that
        // never resolves (dead process, Vercel timeout) simply expires and becomes
        // reclaimable — this order can never be stranded in 'processing' the way the old
        // claim-then-lose-the-process bug did.
        const claimed = await claimForDispatch(supabase, orderId, supplierLabel)
        if (!claimed) {
            console.log(`[Fulfillment] Order ${orderId} could not be claimed for ${supplierLabel} (not pending, or already claimed by a live process), skipping`)
            // Not this caller's failure — either another worker won the claim, or the
            // order is no longer pending. Matches the pre-dispatch-claim-separation
            // behavior this branch's TriggerFulfillmentOutcome return type depends on
            // (see the bulk-purchase caller, which aggregates this into one summary).
            return { failed: false, type: 'success', reason: 'Already claimed by another worker' }
        }

        // ── Execute fulfillment ────────────────────────────────────────────
        const dispatchKey = options?.dispatchKey ?? orderId
        // `ambiguous` means "the supplier may already have accepted and CHARGED this order" —
        // set by lib/hendylinks-service.ts and lib/agentportal-service.ts (no idempotency key
        // on placement) AND by lib/fulfillment-service.ts on a DataKazina duplicate-reference
        // rejection (proof the order was already submitted there). Treat it generically — do
        // not assume it belongs to any single supplier.
        let result: { success: boolean; reference?: string; transactionId?: string; error?: string; apiResponse?: any; ghdataOrderId?: string; ghdataShortId?: string; ambiguous?: boolean }
        try {
            if (isCodeCraftEnabled) {
                const { fulfillOrder: ccFulfill } = await import('@/lib/codecraft-service')
                result = await ccFulfill(network, (order as any).phone_number, (order as any).size, orderId, dispatchKey)
            } else if (isXpressEnabled) {
                const { fulfillOrder: xpFulfill } = await import('@/lib/xpress-service')
                result = await xpFulfill(network, (order as any).phone_number, (order as any).size, orderId, dispatchKey)
            } else if (isGhDataEnabled) {
                const { fulfillGhDataOrder } = await import('@/lib/ghdata-service')
                const ghResult = await fulfillGhDataOrder(network, (order as any).phone_number, (order as any).size, orderId, dispatchKey)
                result = {
                    success: ghResult.success,
                    error: ghResult.error,
                    apiResponse: ghResult.apiResponse,
                    ghdataOrderId: ghResult.ghdataOrderId,
                    ghdataShortId: ghResult.ghdataShortId,
                }
            } else if (isAgentPortalEnabled) {
                const { fulfillOrder: apFulfill } = await import('@/lib/agentportal-service')
                result = await apFulfill(network, (order as any).phone_number, (order as any).size, orderId, dispatchKey)
            } else if (isBundlePortalEnabled) {
                const { fulfillOrder: bpFulfill } = await import('@/lib/bundleportal-service')
                result = await bpFulfill(network, (order as any).phone_number, (order as any).size, orderId, dispatchKey)
            } else if (isHendyLinksEnabled) {
                // HendyLinks has no client-supplied idempotency key — dispatchKey is
                // intentionally NOT passed (its fulfillOrder signature doesn't accept one).
                const { fulfillOrder: hlFulfill } = await import('@/lib/hendylinks-service')
                result = await hlFulfill(network, (order as any).phone_number, (order as any).size, orderId)
            } else if (isAtiShareConsoleEnabled) {
                const { sendBundle, buildClientReference, sizeToMb, assertAtIShareNetwork } =
                    await import('@/lib/atishare-console-service')

                // Boundary check: this supplier serves AT-iShare only. Never trust the toggle
                // alone. Deliberately reports through `result` (not an early return) so a
                // mismatch flows into the normal definite-failure handling below — which
                // reverts the atomic claim above back to 'pending', clears every reference
                // column, and alerts an admin. An early return here would leave the order
                // stuck in 'processing' forever (the claim UPDATE above already ran).
                if (!assertAtIShareNetwork(network)) {
                    result = { success: false, error: `AT-iShare Console cannot serve ${network}` }
                } else {
                    const bundleMb = sizeToMb((order as any).size)
                    if (bundleMb === null) {
                        result = { success: false, error: `Unparseable size "${(order as any).size}" for AT-iShare Console` }
                    } else {
                        // attemptNo comes from the order's OWN retry_count (never a loop index
                        // or counter) — see buildClientReference's doc comment. This is what
                        // lets a re-fulfillment cron pass replay the SAME client_reference so
                        // the console returns the existing transaction instead of creating and
                        // charging for a second one.
                        const clientReference = buildClientReference(orderId, (order as any).retry_count ?? 0)
                        const sendResult = await sendBundle({
                            phone: (order as any).phone_number,
                            bundleMb,
                            clientReference,
                        })
                        result = {
                            success: sendResult.success,
                            reference: clientReference,
                            transactionId: sendResult.transactionId,
                            error: sendResult.error,
                            apiResponse: sendResult.apiResponse,
                        }
                    }
                }
            } else if (isSpfastitEnabled) {
                const { placeOrder, buildSpfastitReference, sizeToMb, assertTelecelNetwork } =
                    await import('@/lib/spfastit-service')

                // Boundary check: this supplier serves Telecel only. Deliberately reports
                // through `result` (not an early return) so a mismatch flows into the normal
                // definite-failure handling below — an early return here would leave the
                // order stuck in 'processing' forever (the claim above already ran).
                if (!assertTelecelNetwork(network)) {
                    result = { success: false, error: `SPFastIT cannot serve ${network}` }
                } else {
                    const bundleMb = sizeToMb((order as any).size)
                    if (bundleMb === null) {
                        result = { success: false, error: `Unsupported size "${(order as any).size}" for SPFastIT` }
                    } else {
                        // attemptNo comes from the order's OWN retry_count, never a loop index —
                        // see buildSpfastitReference's doc comment.
                        const reference = buildSpfastitReference(orderId, (order as any).retry_count ?? 0)
                        const sendResult = await placeOrder({
                            phone: (order as any).phone_number,
                            bundleMb,
                            reference,
                        })
                        result = {
                            success: sendResult.success,
                            reference,
                            error: sendResult.error,
                            apiResponse: sendResult.apiResponse,
                            // Only a genuine transport fault is ambiguous — a definite
                            // rejection is never ambiguous (design spec §7).
                            ambiguous: sendResult.transportFault === true,
                        }
                    }
                }
            } else if (isDataKazinaEnabled) {
                const { fulfillOrder: dkFulfill } = await import('@/lib/fulfillment-service')
                // retry_count is passed as attemptNo so an admin retry of a failed order sends
                // a fresh incoming_api_ref rather than being rejected as a DataKazina duplicate.
                result = await dkFulfill(network, (order as any).phone_number, (order as any).size, orderId, dispatchKey, (order as any).retry_count ?? 0)
            } else {
                // No dispatch branch exists for the enabled supplier. Throw rather than falling
                // through to DataKazina: a silent fallthrough spends real money at the wrong
                // wholesaler AND leaves the order stamped with a supplier that never saw it.
                // Throwing routes into the exception branch below, which releases the claim and
                // clears fulfillment_method, then alerts an admin. (Reference columns are NOT
                // cleared by releaseClaim and need to be handled separately if needed.)
                throw new Error(`No dispatch implementation for supplier ${supplierLabel}`)
            }
        } catch (supplierErr: any) {
            console.error(`[Fulfillment] Supplier call exception for order ${orderId}:`, supplierErr)
            // status never left 'pending' — nothing to revert there. releaseClaim clears
            // the claim and fulfillment_method; a false return means a webhook already
            // resolved the order (safe no-op, not an error).
            const released = await releaseClaim(supabase, orderId)
            if (!released) {
                console.log(`[Fulfillment] Order ${orderId} claim was already gone when releasing after supplier exception — a concurrent webhook likely already resolved it; left untouched`)
            }
            await alertAdmin({ ...alertDetails, reason: `Supplier exception: ${supplierErr.message}` })
            return { failed: true, type: 'error', reason: `Supplier exception: ${supplierErr.message}`, supplier: supplierLabel }
        }

        // ── MTN CodeCraft unverified-number fallback ────────────────────────
        // Only when CodeCraft was the one dispatched above, it failed, its
        // failure is specifically the 422 "number not verified" business
        // rejection, and an admin has configured a fallback supplier for MTN.
        // Every other rejection code / network / primary-supplier combination
        // is untouched by this block.
        let usedFallback: 'datakazina' | 'xpress' | 'ghdata' | 'codecraft' | 'agentportal' | 'bundleportal' | 'hendylinks' | null = null
        if (!result.success && isCodeCraftEnabled) {
            const { isUnverifiedNumberRejection, resolveFallbackSupplier, dispatchFallbackSupplier } =
                await import('@/lib/mtn-codecraft-fallback')

            if (isUnverifiedNumberRejection(network, result.apiResponse)) {
                const { data: fallbackSetting } = await supabase
                    .from('admin_settings')
                    .select('value')
                    .eq('key', 'mtn_codecraft_fallback')
                    .maybeSingle()

                const fallbackSupplier = resolveFallbackSupplier((fallbackSetting as any)?.value)
                if (fallbackSupplier && await reclaimForFallback(supabase, orderId, fallbackSupplier)) {
                    console.log(`[Fulfillment] CodeCraft rejected order ${orderId} as unverified — retrying via fallback supplier ${fallbackSupplier}`)
                    const fallbackResult = await dispatchFallbackSupplier(
                        fallbackSupplier, network, (order as any).phone_number, (order as any).size, orderId, (order as any).retry_count ?? 0
                    )
                    if (fallbackResult.success) {
                        usedFallback = fallbackSupplier
                        result = fallbackResult
                    } else {
                        // Fallback also declined/failed — keep the ORIGINAL CodeCraft
                        // result for the failure-path alert/tracking below, but note
                        // the fallback attempt too.
                        // `ambiguous` is carried forward from EITHER attempt: if the fallback was
                        // HendyLinks and it may already have charged, this order must not be
                        // reverted to 'pending' and re-dispatched. See the ambiguous branch below.
                        result = {
                            ...result,
                            error: `CodeCraft: ${result.error} | Fallback (${fallbackSupplier}): ${fallbackResult.error}`,
                            ambiguous: result.ambiguous || fallbackResult.ambiguous,
                        }
                    }
                }
            }
        }

        // ── MTN AgentPortal whitelist-rejection fallback ────────────────────
        // Only when AgentPortal was the one dispatched above, it failed, its failure is
        // specifically a whitelist rejection, and an admin has configured a fallback
        // supplier for MTN. Mirrors the CodeCraft block above exactly — see
        // lib/mtn-agentportal-fallback.ts. Single-hop: dispatchFallbackSupplier calls the
        // target's plain fulfillOrder(), never its own fallback logic.
        if (!result.success && isAgentPortalEnabled) {
            const { isWhitelistRejection, resolveFallbackSupplier: resolveAgentPortalFallback, dispatchFallbackSupplier: dispatchAgentPortalFallback } =
                await import('@/lib/mtn-agentportal-fallback')

            if (isWhitelistRejection(network, result.apiResponse)) {
                const { data: fallbackSetting } = await supabase
                    .from('admin_settings')
                    .select('value')
                    .eq('key', 'mtn_agentportal_fallback')
                    .maybeSingle()

                const fallbackSupplier = resolveAgentPortalFallback((fallbackSetting as any)?.value)
                if (fallbackSupplier && await reclaimForFallback(supabase, orderId, fallbackSupplier)) {
                    console.log(`[Fulfillment] AgentPortal rejected order ${orderId} as not-yet-whitelisted — retrying via fallback supplier ${fallbackSupplier}`)
                    const fallbackResult = await dispatchAgentPortalFallback(
                        fallbackSupplier, network, (order as any).phone_number, (order as any).size, orderId, (order as any).retry_count ?? 0
                    )
                    if (fallbackResult.success) {
                        usedFallback = fallbackSupplier
                        result = fallbackResult
                    } else {
                        result = {
                            ...result,
                            error: `AgentPortal: ${result.error} | Fallback (${fallbackSupplier}): ${fallbackResult.error}`,
                            // Carried forward in case the fallback was HendyLinks — see the
                            // CodeCraft block above for why.
                            ambiguous: result.ambiguous || fallbackResult.ambiguous,
                        }
                    }
                }
            }
        }

        // ── MTN Bundle Portal not-allowlisted fallback ──────────────────────
        // Only when Bundle Portal was the one dispatched above, it failed, its failure is
        // specifically a not_allowlisted rejection, and an admin has configured a fallback
        // supplier for MTN. Mirrors the CodeCraft/AgentPortal blocks above exactly — see
        // lib/mtn-bundleportal-fallback.ts. Single-hop.
        if (!result.success && isBundlePortalEnabled) {
            const { isNotAllowlistedRejection, resolveFallbackSupplier: resolveBundlePortalFallback, dispatchFallbackSupplier: dispatchBundlePortalFallback } =
                await import('@/lib/mtn-bundleportal-fallback')

            if (isNotAllowlistedRejection(network, result.apiResponse)) {
                const { data: fallbackSetting } = await supabase
                    .from('admin_settings')
                    .select('value')
                    .eq('key', 'mtn_bundleportal_fallback')
                    .maybeSingle()

                const fallbackSupplier = resolveBundlePortalFallback((fallbackSetting as any)?.value)
                if (fallbackSupplier && await reclaimForFallback(supabase, orderId, fallbackSupplier)) {
                    console.log(`[Fulfillment] Bundle Portal rejected order ${orderId} as not-allowlisted — retrying via fallback supplier ${fallbackSupplier}`)
                    const fallbackResult = await dispatchBundlePortalFallback(
                        fallbackSupplier, network, (order as any).phone_number, (order as any).size, orderId, (order as any).retry_count ?? 0
                    )
                    if (fallbackResult.success) {
                        usedFallback = fallbackSupplier
                        result = fallbackResult
                    } else {
                        result = {
                            ...result,
                            error: `Bundle Portal: ${result.error} | Fallback (${fallbackSupplier}): ${fallbackResult.error}`,
                            // Carried forward in case the fallback was HendyLinks — see the
                            // CodeCraft block above for why.
                            ambiguous: result.ambiguous || fallbackResult.ambiguous,
                        }
                    }
                }
            }
        }

        // ── MTN HendyLinks 404 fallback ─────────────────────────────────────
        // Only when HendyLinks was the one dispatched above, it failed with specifically an
        // HTTP 404 ("Plan not found"), and an admin has configured a fallback supplier for
        // MTN. Mirrors the CodeCraft/AgentPortal/BundlePortal blocks above exactly — see
        // lib/mtn-hendylinks-fallback.ts. Single-hop. HTTP 402 (insufficient balance) does
        // NOT reach this block's trigger — isFallbackWorthyRejection returns false for it by
        // design (per the user's explicit decision), leaving those orders pending instead.
        if (!result.success && isHendyLinksEnabled) {
            const { isFallbackWorthyRejection, resolveFallbackSupplier: resolveHendyLinksFallback, dispatchFallbackSupplier: dispatchHendyLinksFallback } =
                await import('@/lib/mtn-hendylinks-fallback')

            if (isFallbackWorthyRejection(network, result.apiResponse)) {
                const { data: fallbackSetting } = await supabase
                    .from('admin_settings')
                    .select('value')
                    .eq('key', 'mtn_hendylinks_fallback')
                    .maybeSingle()

                const fallbackSupplier = resolveHendyLinksFallback((fallbackSetting as any)?.value)
                if (fallbackSupplier && await reclaimForFallback(supabase, orderId, fallbackSupplier)) {
                    console.log(`[Fulfillment] HendyLinks rejected order ${orderId} with HTTP 404 — retrying via fallback supplier ${fallbackSupplier}`)
                    const fallbackResult = await dispatchHendyLinksFallback(
                        fallbackSupplier, network, (order as any).phone_number, (order as any).size, orderId, (order as any).retry_count ?? 0
                    )
                    if (fallbackResult.success) {
                        usedFallback = fallbackSupplier
                        result = fallbackResult
                    } else {
                        result = {
                            ...result,
                            error: `HendyLinks: ${result.error} | Fallback (${fallbackSupplier}): ${fallbackResult.error}`,
                            // The HendyLinks primary result cannot be ambiguous here (this block
                            // only runs for a 404 rejection, and the ambiguous branch never
                            // attaches _httpStatus), but carried forward for the same reason and
                            // so no future fallback target can silently drop the flag.
                            ambiguous: result.ambiguous || fallbackResult.ambiguous,
                        }
                    }
                }
            }
        }

        // Effective supplier label for bookkeeping below — the fallback supplier
        // if it was used successfully, otherwise the originally-dispatched one.
        const effectiveSupplierLabel = usedFallback ?? supplierLabel

        if (result.success) {
            // ── Build atomic orders update ─────────────────────────────────
            const ordersUpdate: Record<string, any> = {
                status: 'processing',
                updated_at: new Date().toISOString(),
                fulfillment_method: effectiveSupplierLabel,
            }
            if (effectiveSupplierLabel === 'codecraft' && (result.transactionId || result.reference)) {
                ordersUpdate.codecraft_reference = result.transactionId || result.reference
            }
            if (effectiveSupplierLabel === 'bundleportal' && (result.transactionId || result.reference)) {
                ordersUpdate.bundleportal_reference = result.transactionId || result.reference
            }
            if (effectiveSupplierLabel === 'hendylinks' && (result.transactionId || result.reference)) {
                // HendyLinks' order id comes straight off their JSON response — supplier-controlled.
                // Bounded/stripped before it is persisted, per the codebase convention for supplier
                // strings (lib/sanitize-for-storage.ts). Not a SQL-injection concern (this write is
                // parameterized) — it stops a malformed response bloating or polluting the column.
                ordersUpdate.hendylinks_order_id = sanitizeForStorage(result.transactionId || result.reference, 200)
            }
            if (effectiveSupplierLabel === 'atishare_console' && (result.transactionId || result.reference)) {
                // reference is the client_reference WE generated deterministically
                // (orderId-r<retry_count>); transactionId is SPFastIT's own id — supplier-
                // controlled, so it is bounded/stripped before persisting, per the codebase
                // convention (lib/sanitize-for-storage.ts), same as hendylinks_order_id above.
                // Both are persisted — the cron replays `reference` to recover an in-flight
                // order, and `transactionId` is what checkOrderStatus polls against.
                ordersUpdate.atishare_console_reference = result.reference
                ordersUpdate.atishare_console_transaction_id = result.transactionId != null
                    ? sanitizeForStorage(result.transactionId, 200)
                    : result.transactionId
            }
            if (effectiveSupplierLabel === 'spfastit' && result.reference) {
                ordersUpdate.spfastit_reference = result.reference
            }
            if (effectiveSupplierLabel === 'ghdata' && result.ghdataOrderId) {
                ordersUpdate.ghdata_order_id = result.ghdataOrderId
            }
            if ((effectiveSupplierLabel === 'datakazina' || effectiveSupplierLabel === 'xpress') && (result.transactionId || result.reference)) {
                ordersUpdate.dakazina_reference = result.transactionId || result.reference
            }
            if (effectiveSupplierLabel === 'datakazina') {
                // Store BOTH DataKazina identifiers — their webhook may quote either one and we
                // cannot control which. dakazina_reference is pinned to the exact
                // incoming_api_ref we sent (which carries a "-r<n>" suffix on a retry), and
                // dakazina_order_code holds their own ORDER-.../BULK-... code.
                if ((result as any).sentApiRef) {
                    ordersUpdate.dakazina_reference = (result as any).sentApiRef
                }
                if ((result as any).supplierOrderCode) {
                    ordersUpdate.dakazina_order_code = sanitizeForStorage(String((result as any).supplierOrderCode), 200)
                }
            }

            const { status: _status, updated_at: _updatedAt, fulfillment_method: _fm, ...referenceColumns } = ordersUpdate
            const accepted = await acceptDispatch(supabase, orderId, effectiveSupplierLabel, referenceColumns)
            if (!accepted) {
                console.log(`[Fulfillment] Order ${orderId} accept was a no-op — a webhook already resolved it before this dispatch's own bookkeeping ran`)
            } else {
                await (supabase.from('mtn_fulfillment_tracking') as any).insert({
                    order_id: orderId,
                    // All non-DataKazina suppliers use 'completed' here — this table itself is
                    // not what the sync routes query. CodeCraft/Xpress/GhData/AgentPortal are
                    // resolved by their own webhooks; Bundle Portal has NO webhook and is instead
                    // polled by app/api/cron/sync-bundleportal-status and
                    // app/api/admin/fulfillment/sync-bundleportal, both of which query `orders`
                    // directly (filtering on bundleportal_reference IS NOT NULL), never this
                    // tracking table. 'completed' is used consistently here just for bookkeeping
                    // parity with the other suppliers, not because anything reads it back.
                    status: effectiveSupplierLabel !== 'datakazina' ? 'completed' : 'processing',
                    retry_count: (order as any).retry_count ?? 0,
                    api_response: {
                        ...(result.apiResponse || {}),
                        reference: result.transactionId || result.reference,
                        supplier: effectiveSupplierLabel,
                        network,
                        ...(usedFallback ? { via_fallback: true, primary_supplier: supplierLabel } : {}),
                        ...(effectiveSupplierLabel === 'ghdata' ? {
                            ghdata_order_id: result.ghdataOrderId,
                            ghdata_short_id: result.ghdataShortId,
                        } : {}),
                    },
                })

                // Sync status to healing wrapper so shop owners see it
                await syncShopOrderStatus(orderId, 'processing').catch(err =>
                    console.error(`[Fulfillment] syncShopOrderStatus failed for ${orderId}:`, err)
                )
            }
        } else if (result.ambiguous) {
            // AMBIGUOUS, not definite — same rule as lib/refulfillment-service.ts step 11,
            // which owns this decision for the bulk path. Set by hendylinks-service/
            // agentportal-service (no idempotency key on placement) and by
            // fulfillment-service on a DataKazina duplicate-reference rejection — handled
            // generically, not per-supplier. Land the order in 'processing' anyway (via
            // acceptDispatch, with no reference columns — we don't have a confirmed one):
            // reverting it to 'pending' would let the re-fulfillment cron treat it as an
            // ordinary pending order and re-dispatch, paying and delivering a second time
            // for an order the supplier may already have accepted and charged.
            console.error(`[Fulfillment] AMBIGUOUS dispatch outcome for order ${orderId} via ${supplierLabel}: ${result.error}. Marking 'processing' (NOT reverted to pending) to avoid a possible double-charge/double-deliver. Manual reconciliation required.`)

            // SPFastIT is the one supplier whose reference we generate ourselves
            // (buildSpfastitReference), deterministically, BEFORE the dispatch call — so even
            // on a transport-fault ambiguous outcome we already know what reference was
            // attempted. Persisting it here (unlike every other supplier, which has no
            // confirmed reference to persist on an ambiguous outcome) is what makes this order
            // visible to app/api/cron/sync-spfastit-status's poll — that route only selects
            // orders with spfastit_reference IS NOT NULL. If SPFastIT never actually received
            // this attempt, /status will simply fail to find it and the cron logs+skips; if it
            // did receive it, the cron can now reconcile it automatically.
            const ambiguousExtraColumns: Record<string, any> =
                supplierLabel === 'spfastit' && result.reference ? { spfastit_reference: result.reference } : {}
            const ambiguousAccepted = await acceptDispatch(supabase, orderId, supplierLabel, ambiguousExtraColumns)
            if (!ambiguousAccepted) {
                console.log(`[Fulfillment] Order ${orderId} ambiguous-accept was a no-op — a webhook already resolved it`)
            } else {
                // Spec item 6 (docs/superpowers/specs/2026-08-24-dispatch-claim-separation-design.md):
                // the success branch above syncs shop_orders to 'processing' after its accept;
                // this branch also now moves orders.status to 'processing' via acceptDispatch
                // but previously never synced shop_orders to match — producing exactly the
                // "admin sees processing, shop sees pending" divergence this whole plan exists
                // to close, specifically for ambiguous outcomes. Only sync when acceptDispatch
                // actually transitioned the row (a no-op here means a webhook already handled
                // the shop sync too, via its own resolution path).
                await syncShopOrderStatus(orderId, 'processing').catch(err =>
                    console.error(`[Fulfillment] syncShopOrderStatus (ambiguous) failed for ${orderId}:`, err)
                )
            }

            // Distinct dedup-key prefix, same discipline as step 11: sendAdminNewOrderAlert
            // suppresses re-alerts for 6h on push:order_alert:${referenceCode} and silently
            // returns success:true when suppressed (a .catch() can't see it) — reusing the
            // order's own reference_code here would risk this alert being swallowed by an
            // unrelated earlier alert for the same order.
            await alertAdmin({
                ...alertDetails,
                referenceCode: `AMBIGUOUS-DISPATCH-${orderId}`,
                reason: `⚠️ AMBIGUOUS_TRANSPORT_FAILURE: order ${orderId} left in 'processing' — the ${supplierLabel} request may have already been accepted/charged (${result.error || 'unknown error'}). Do NOT resubmit without confirming with the supplier first.`,
            })

            await (supabase.from('mtn_fulfillment_tracking') as any).insert({
                order_id: orderId,
                status: 'failed',
                retry_count: (order as any).retry_count ?? 0,
                api_response: { error: result.error, ambiguous: true, supplier: supplierLabel, network, ...result.apiResponse },
            })
        } else {
            console.warn(`[Fulfillment] Supplier ${supplierLabel} failed for order ${orderId}: ${result.error}`)
            const released = await releaseClaim(supabase, orderId)
            if (!released) {
                console.log(`[Fulfillment] Order ${orderId} claim was already gone when releasing after a ${supplierLabel} failure — a concurrent webhook likely already resolved it; left untouched`)
            }
            await alertAdmin({ ...alertDetails, reason: `Auto-fulfillment API error (${supplierLabel}): ${result.error || 'Unknown error'}` })

            await (supabase.from('mtn_fulfillment_tracking') as any).insert({
                order_id: orderId,
                status: 'failed',
                retry_count: (order as any).retry_count ?? 0,
                api_response: { error: result.error, supplier: supplierLabel, network, ...result.apiResponse },
            })

            return {
                failed: true,
                type: 'error',
                reason: `Auto-fulfillment API error (${supplierLabel}): ${result.error || 'Unknown error'}`,
                supplier: supplierLabel,
            }
        }

        // Reached only from the success and ambiguous branches above, which both
        // fall through. Ambiguous is reported as a FAILURE for the caller's
        // summary — the order is deliberately left in 'processing' for manual
        // reconciliation, so telling a bulk caller it succeeded would hide
        // exactly the case that needs a human.
        if (result.success) {
            return { failed: false, type: 'success', supplier: effectiveSupplierLabel }
        }
        return {
            failed: true,
            type: 'error',
            reason: `AMBIGUOUS: the ${supplierLabel} request may already have been accepted/charged (${result.error || 'unknown error'}) — manual reconciliation required, do NOT resubmit`,
            supplier: supplierLabel,
        }
    } catch (error: any) {
        console.error(`[Fulfillment] Error processing order ${orderId}:`, error)
        // Previously swallowed and returned void. Now surfaced so a bulk caller's
        // aggregated report cannot silently omit an order that threw.
        return { failed: true, type: 'error', reason: `Exception: ${error?.message || 'Unknown error'}` }
    }
}
