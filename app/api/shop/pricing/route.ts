import { NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { cookies } from 'next/headers'
import { createServerClient } from '@/lib/supabase'
import { resolveOwnerCost } from '@/lib/pricing/cost-basis'
import { resolveSubAgentContext } from '@/lib/sub-agent-account'
import { resolveSubAgentDataCost } from '@/lib/sub-agent-data-pricing'
import { AFA_PRICE_KEYS, resolveAfaPrice } from '@/lib/afa-pricing'
import { resolveSubAgentAfaCost } from '@/lib/sub-agent-afa-pricing'

export async function GET() {
    try {
        const cookieStore = await cookies()
        const supabaseAuth = await createRouteClient()
        const { data: { user: authUser } } = await supabaseAuth.auth.getUser()
        
        if (!authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const supabase = createServerClient()
        const { data, error } = await supabase
            .from('admin_settings')
            .select('key, value')
            .in('key', [
                'airtime_fee_mtn_customer', 'airtime_fee_mtn_agent',
                'airtime_fee_telecel_customer', 'airtime_fee_telecel_agent',
                'airtime_fee_at_customer', 'airtime_fee_at_agent',
                ...AFA_PRICE_KEYS,
            ])

        if (error) throw error

        const settings: Record<string, string> = {}
        for (const row of (data as any) || []) settings[row.key] = String(row.value)

        return NextResponse.json(settings)
    } catch (err: any) {
        console.error('Settings API Error:', err)
        return NextResponse.json({ error: 'Failed to fetch settings' }, { status: 500 })
    }
}

export async function POST(req: Request) {
    try {
        const supabase = await createRouteClient()
        
        // Ensure user is authenticated
        const { data: { user: authUser } } = await supabase.auth.getUser()
        if (!authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const body = await req.json()
        const { shopId, items, airtimeFees, rcFees, rcMarkups, mashupFee, afaSellingPrice, subPrices } = body

        if (!shopId) {
            return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
        }

        // Verify shop ownership
        const { data: shopProfile, error: shopError } = await supabase
            .from('shop_profiles')
            .select('id, owner_id')
            .eq('id', shopId)
            .single()

        if (shopError || !shopProfile || shopProfile.owner_id !== authUser.id) {
            return NextResponse.json({ error: 'Unauthorized to modify this shop' }, { status: 403 })
        }

        // From here on, only the DB-verified ID is used for writes — the
        // client-supplied shopId is never passed to a service-role query.
        const verifiedShopId: string = (shopProfile as any).id

        const { data: userData } = await supabase.from('users').select('role, agent_expires_at, dealer_expires_at').eq('id', shopProfile.owner_id).single()
        const userRole = userData?.role || 'customer'
        const ownerRoleCtx = {
            role: userRole,
            agent_expires_at: (userData as any)?.agent_expires_at,
            dealer_expires_at: (userData as any)?.dealer_expires_at,
        }

        // Fetch Admin Settings (service-role bypass for RLS) — includes profit caps, fee caps, auto-approve
        const adminDb = createServerClient()

        // Sub-agent caller? Their retail cost basis comes from resolveSubAgentDataCost
        // (recruiter cost + markup), never role-tier costs — see lib/shop-checkout.ts.
        const subCtx = await resolveSubAgentContext(adminDb, shopProfile.owner_id)
        if (subCtx.isSub && subPrices !== undefined) {
            // Single-level model (spec C1): a sub can never itself have a downline, so
            // there is nothing for them to wholesale-price.
            return NextResponse.json({ error: 'Sub-agent accounts cannot set wholesale prices' }, { status: 403 })
        }

        const { data: globalRows } = await adminDb
            .from('shop_global_settings')
            .select('key, value')
            .in('key', [
                'data_profit_max_customer', 'data_profit_max_agent', 'data_profit_max_dealer',
                'mashup_shop_fee_max_customer', 'mashup_shop_fee_max_agent', 'mashup_shop_fee_max_dealer',
                'afa_shop_fee_max_customer', 'afa_shop_fee_max_agent', 'afa_shop_fee_max_dealer',
                'sub_min_margin',
                `auto_approve_pricing_${userRole}`,
            ])
        const globalSettings: Record<string, any> = {}
        for (const row of (globalRows as any) || []) globalSettings[row.key] = row.value

        const configuredMax = parseFloat(globalSettings[`data_profit_max_${userRole}`] || '0')
        const maxDataProfit = configuredMax > 0 ? configuredMax : Infinity

        const { data: adminSettingsData } = await adminDb.from('admin_settings').select('key, value')
        const adminSettings: Record<string, string> = {}
        for (const row of (adminSettingsData as any) || []) adminSettings[row.key] = String(row.value)

        // Strict Backend Validation for Data Packages
        if (items && Array.isArray(items)) {
            // Validate basic shape before hitting the DB
            for (const item of items) {
                if (!item.package_id || typeof item.package_id !== 'string') {
                    return NextResponse.json({ error: 'Invalid payload format' }, { status: 400 })
                }
                const sp = parseFloat(item.selling_price)
                if (isNaN(sp) || sp <= 0) {
                    return NextResponse.json({ error: 'Invalid selling price' }, { status: 400 })
                }
            }

            // Dedupe items by package_id (keep LAST). A duplicate package_id would otherwise
            // violate UNIQUE(shop_id, package_id) on INSERT — AFTER the DELETE already ran —
            // leaving the shop with ZERO pricing rows and destroying preserved sub_price.
            const _byPkg = new Map<string, any>()
            for (const it of items) _byPkg.set(it.package_id, it)
            if (_byPkg.size !== items.length) {
                items.length = 0
                items.push(..._byPkg.values())
            }

            // Fetch actual cost prices from DB — never trust client-supplied profit_margin
            const packageIds = items.map((i: any) => i.package_id)
            const { data: pkgRows, error: pkgErr } = await adminDb
                .from('data_packages')
                .select('id, price, agent_price, dealer_price')
                .in('id', packageIds)
                .eq('is_available', true)

            if (pkgErr || !pkgRows || pkgRows.length === 0) {
                return NextResponse.json({ error: 'Failed to verify package prices' }, { status: 400 })
            }

            const pkgMap: Record<string, any> = {}
            for (const p of (pkgRows as any[])) pkgMap[p.id] = p

            const skipZeroMarkup: Set<string> = new Set()
            for (const item of items) {
                const pkg = pkgMap[item.package_id]
                if (!pkg) {
                    return NextResponse.json({ error: `Package ${item.package_id} not found or unavailable` }, { status: 400 })
                }

                const sellingPrice = parseFloat(item.selling_price)
                let costPrice: number
                let computedProfit: number

                if (subCtx.isSub) {
                    // Sub retail cost basis is resolved LIVE via the single-hop engine
                    // (recruiterCost + per-sub/default markup) — the same resolver storefront
                    // checkout and order fulfillment already call (lib/sub-agent-data-pricing.ts).
                    // There is no more Lead-set wholesale table and no markup ceiling on the
                    // sub's own retail price here: the only constraint, matching
                    // lib/shop-checkout.ts's identical contract, is profit >= 0 against this
                    // live cost floor. (The recruiter's markup TO the sub is capped separately,
                    // in sub_agent_pricing / sub_agent_default_pricing — not here.)
                    const resolved = await resolveSubAgentDataCost(adminDb, shopProfile.owner_id, item.package_id, pkg, 'data')
                    if (!resolved.ok) {
                        // Never surface resolved.reason to the caller (spec §11) — same
                        // discipline as lib/shop-checkout.ts's identical resolution failure.
                        return NextResponse.json({ error: 'This package is not available for your shop yet' }, { status: 400 })
                    }
                    costPrice = resolved.subCost
                    computedProfit = parseFloat((sellingPrice - costPrice).toFixed(2))
                    if (computedProfit < 0) {
                        return NextResponse.json({ error: 'Selling price cannot be below your wholesale cost' }, { status: 400 })
                    }
                    // profit_margin has a >0 CHECK; a zero-markup row is expressed by having
                    // NO row — checkout falls back to selling at cost (sub earns 0).
                    if (computedProfit === 0) skipZeroMarkup.add(item.package_id)
                } else {
                    // Cost via the single shared resolver — expiry-aware (spec D17)
                    costPrice = resolveOwnerCost(pkg, ownerRoleCtx)
                    computedProfit = parseFloat((sellingPrice - costPrice).toFixed(2))
                    if (computedProfit <= 0) {
                        return NextResponse.json({ error: 'Selling price must be higher than your cost price' }, { status: 400 })
                    }
                    if (configuredMax > 0 && computedProfit > maxDataProfit) {
                        return NextResponse.json({ error: `Profit cannot exceed GHS ${configuredMax.toFixed(2)}` }, { status: 400 })
                    }
                }

                // Write only allowed fields — strip all client-supplied extras
                item.shop_id      = verifiedShopId
                item.package_id   = pkg.id          // already validated
                item.selling_price = sellingPrice
                item.profit_margin = computedProfit  // server-computed, not client
            }

            // Validate the Lead's wholesale subPrices BEFORE the delete (all-or-nothing):
            // sub_price >= owner_cost + sub_min_margin so the Lead can never wholesale at a loss.
            const subMinMargin = Math.max(0.01, parseFloat(String(globalSettings['sub_min_margin'] ?? '0.01').replace(/"/g, '')) || 0.01)
            const wholesaleByPackage: Record<string, number> = {}
            const clearedSubPrices: Set<string> = new Set() // packages the Lead explicitly un-wholesaled
            if (!subCtx.isSub && subPrices !== undefined) {
                if (!Array.isArray(subPrices) || subPrices.length > 500) {
                    return NextResponse.json({ error: 'Invalid subPrices payload' }, { status: 400 })
                }
                for (const spRow of subPrices) {
                    if (!spRow || typeof spRow.package_id !== 'string') {
                        return NextResponse.json({ error: 'Invalid subPrices payload' }, { status: 400 })
                    }
                    const pkg = pkgMap[spRow.package_id]
                    if (!pkg) continue // only packages in this save can carry a wholesale price
                    const sp = parseFloat(spRow.sub_price)
                    if (isNaN(sp) || sp <= 0) {
                        // Explicit null/0 = the Lead is REMOVING this wholesale price (spec §7.2,
                        // finding F). Record the intent so preservation doesn't resurrect the old value.
                        clearedSubPrices.add(spRow.package_id)
                        continue
                    }
                    const ownerCost = resolveOwnerCost(pkg, ownerRoleCtx)
                    if (sp < ownerCost + subMinMargin) {
                        return NextResponse.json({ error: `Sub-agent price for a package cannot be below your cost + GHS ${subMinMargin.toFixed(2)}` }, { status: 400 })
                    }
                    // Cap: subs must never wholesale ABOVE the standard customer price (finding B) —
                    // kills the "sub_price = 1000 on a GHS 5 package" margin-inflation amplifier.
                    if (sp > Number(pkg.price)) {
                        return NextResponse.json({ error: 'Sub-agent wholesale price cannot exceed the standard customer price' }, { status: 400 })
                    }
                    wholesaleByPackage[spRow.package_id] = parseFloat(sp.toFixed(2))
                }
            }

            // Preserve existing wholesale sub_price across the delete+re-insert below —
            // without this, every retail re-save silently wiped the Lead's sub pricing.
            const { data: existingSubRows } = await adminDb
                .from('shop_pricing')
                .select('package_id, sub_price')
                .eq('shop_id', verifiedShopId)
                .not('sub_price', 'is', null)
            for (const r of (existingSubRows as any[]) || []) {
                // Preserve an existing wholesale price UNLESS the Lead explicitly cleared it this save.
                if (wholesaleByPackage[r.package_id] === undefined
                    && !clearedSubPrices.has(r.package_id)
                    && r.sub_price != null) {
                    wholesaleByPackage[r.package_id] = Number(r.sub_price)
                }
            }

            // Use service-role client for write operations — ownership is already verified above
            const { error: deleteError } = await adminDb
                .from('shop_pricing')
                .delete()
                .eq('shop_id', verifiedShopId)

            if (deleteError) {
                console.error('[PricingRoute] Delete error:', deleteError)
                return NextResponse.json({ error: 'Failed to clear previous pricing data' }, { status: 500 })
            }

            // Insert only known-safe fields — no client extras reach the DB
            if (items.length > 0) {
                const safeRows = items
                    .filter((item: any) => !skipZeroMarkup.has(item.package_id))
                    .map((item: any) => ({
                        shop_id:       item.shop_id,
                        package_id:    item.package_id,
                        selling_price: item.selling_price,
                        profit_margin: item.profit_margin,
                        sub_price:     subCtx.isSub ? null : (wholesaleByPackage[item.package_id] ?? null),
                    }))
                if (safeRows.length > 0) {
                    const { error: insertError } = await (adminDb as any)
                        .from('shop_pricing')
                        .insert(safeRows)

                    if (insertError) {
                        console.error('[PricingRoute] Insert error:', insertError)
                        return NextResponse.json({ error: 'Failed to insert pricing data' }, { status: 500 })
                    }
                }
            }
        }

        // Secure Airtime Fee calculations & clamping strictly bounding at MAX 10% including admin baseline
        let airtimeUpdates: any = {}
        if (airtimeFees) {
            for (const net of ['mtn', 'telecel', 'at']) {
                if (airtimeFees[net] !== undefined) {
                    let fee = parseFloat(airtimeFees[net])
                    if (isNaN(fee) || fee < 0) fee = 0

                    const adminFeeKey = `airtime_fee_${net}_${userRole}`
                    const baseAdminFeeString = adminSettings[adminFeeKey] || '0'
                    const baseAdminFee = parseFloat(baseAdminFeeString)

                    const maxAllowedFee = Math.max(0, 10 - baseAdminFee)
                    if (fee > maxAllowedFee) fee = maxAllowedFee

                    airtimeUpdates[`airtime_fee_${net}`] = fee
                }
            }
        }

        // Results Checker Markup Clamping
        if (rcFees) {
            for (const role of ['customer']) {
                if (rcFees[role] !== undefined) {
                    let fee = parseFloat(rcFees[role])
                    if (isNaN(fee) || fee < 0) fee = 0

                    const maxFeeKey = `results_checker_max_markup_${role}`
                    const maxAllowedFee = parseFloat(adminSettings[maxFeeKey] || '0')

                    if (maxAllowedFee > 0 && fee > maxAllowedFee) fee = maxAllowedFee
                    
                    airtimeUpdates[`results_checker_markup_${role}`] = fee
                }
            }
        }

        // Per-exam-type Results Checker markups — validated against live exam
        // types and clamped to the admin cap server-side.
        if (rcMarkups !== undefined) {
            if (!Array.isArray(rcMarkups) || rcMarkups.length > 50) {
                return NextResponse.json({ error: 'Invalid rcMarkups payload' }, { status: 400 })
            }
            const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
            for (const m of rcMarkups) {
                if (!m || typeof m.exam_type_id !== 'string' || !uuidRe.test(m.exam_type_id)) {
                    return NextResponse.json({ error: 'Invalid exam type in rcMarkups' }, { status: 400 })
                }
            }

            const { data: examRows } = await adminDb
                .from('results_checker_types')
                .select('id')
                .eq('is_active', true)
                .in('id', rcMarkups.map((m: any) => m.exam_type_id))
            const validExamIds = new Set(((examRows as any[]) || []).map(r => r.id))

            const rcMaxMarkup = parseFloat(adminSettings['results_checker_max_markup_customer'] || '0')
            const safeMarkupRows = rcMarkups
                .filter((m: any) => validExamIds.has(m.exam_type_id))
                .map((m: any) => {
                    let markup = parseFloat(m.markup)
                    if (isNaN(markup) || markup < 0) markup = 0
                    if (rcMaxMarkup > 0 && markup > rcMaxMarkup) markup = rcMaxMarkup
                    return {
                        shop_id: verifiedShopId,
                        exam_type_id: m.exam_type_id,
                        markup,
                        updated_at: new Date().toISOString(),
                    }
                })

            const { error: rcDelErr } = await adminDb
                .from('shop_rc_markups')
                .delete()
                .eq('shop_id', verifiedShopId)
            if (rcDelErr) {
                console.error('[PricingRoute] RC markup delete error:', rcDelErr)
                return NextResponse.json({ error: 'Failed to update exam markups' }, { status: 500 })
            }
            if (safeMarkupRows.length > 0) {
                const { error: rcInsErr } = await (adminDb as any)
                    .from('shop_rc_markups')
                    .insert(safeMarkupRows)
                if (rcInsErr) {
                    console.error('[PricingRoute] RC markup insert error:', rcInsErr)
                    return NextResponse.json({ error: 'Failed to save exam markups' }, { status: 500 })
                }
            }
        }

        // Mashup Fee Clamping
        if (mashupFee !== undefined) {
            let fee = parseFloat(mashupFee)
            if (isNaN(fee) || fee < 0) fee = 0
            const maxFeeKey = `mashup_shop_fee_max_${userRole}`
            const maxFee = parseFloat(globalSettings[maxFeeKey] || '0')
            if (maxFee > 0 && fee > maxFee) fee = maxFee
            airtimeUpdates.mashup_fee_percent = fee
        }

        // AFA selling price. An explicitly cleared value persists as NULL — NULL
        // means "AFA off for this shop" (there is no "0 = free" concept in the flat
        // selling-price model; a selling price must exceed cost to be valid at all).
        // Cost is resolved server-side via the shared role tiering — never trust a
        // client-supplied cost. Mirrors the DATA branch's identical floor check.
        if (afaSellingPrice !== undefined) {
            if (afaSellingPrice === null || afaSellingPrice === '') {
                airtimeUpdates.afa_selling_price = null
            } else {
                const selling = parseFloat(afaSellingPrice)
                if (isNaN(selling) || selling <= 0) {
                    return NextResponse.json({ error: 'Invalid selling price' }, { status: 400 })
                }
                // Sub-agent caller? Their real cost floor is the recruiter-marked-up
                // resolveSubAgentAfaCost value, never the plain role-tier price — mirrors
                // the DATA branch's identical resolveSubAgentDataCost usage above.
                let resolvedAfaCost: number | null
                if (subCtx.isSub) {
                    const subResult = await resolveSubAgentAfaCost(adminDb, shopProfile.owner_id, adminSettings)
                    if (!subResult.ok) {
                        return NextResponse.json({ error: 'Registration pricing is not configured. Please contact support.' }, { status: 500 })
                    }
                    resolvedAfaCost = subResult.subCost
                } else {
                    resolvedAfaCost = resolveAfaPrice(adminSettings, userRole)
                    if (resolvedAfaCost === null) {
                        return NextResponse.json({ error: 'Registration pricing is not configured. Please contact support.' }, { status: 500 })
                    }
                }
                const profit = parseFloat((selling - resolvedAfaCost).toFixed(2))
                if (profit <= 0) {
                    return NextResponse.json({ error: 'Selling price must be higher than your cost price' }, { status: 400 })
                }
                const maxFeeKey = `afa_shop_fee_max_${userRole}`
                const maxProfit = parseFloat(globalSettings[maxFeeKey] || '0')
                // Cap is now a GHS profit ceiling (Task 1) — clamp the selling price
                // down to cost + cap when it's set, rather than clamping a percentage.
                const clampedSelling = (maxProfit > 0 && profit > maxProfit)
                    ? parseFloat((resolvedAfaCost + maxProfit).toFixed(2))
                    : selling
                airtimeUpdates.afa_selling_price = clampedSelling
            }
        }

        // Only enforce go-live guard when items are submitted
        if (items !== undefined) {
            const hasValidPrice = Array.isArray(items) && items.some(
                (item: any) => typeof item.selling_price === 'number' && item.selling_price > 0
            )
            if (!hasValidPrice) {
                return NextResponse.json(
                    { error: 'At least one item must have a valid price before your shop can go live.' },
                    { status: 400 }
                )
            }
        }

        // Contact phone is required before a shop can go live (relaxed to optional
        // at shop-creation time — see app/api/shop/profile/route.ts — so this is
        // where it's actually enforced, matching the existing valid-price gate above).
        const { data: contactCheck, error: contactCheckError } = await (adminDb as any)
            .from('shop_profiles')
            .select('owner_phone')
            .eq('id', verifiedShopId)
            .single()
        if (contactCheckError) {
            console.error('[ShopPricing] Contact check error:', contactCheckError)
            return NextResponse.json({ error: 'Failed to verify shop contact details' }, { status: 500 })
        }
        if (!contactCheck?.owner_phone) {
            return NextResponse.json(
                { error: 'Add your contact phone number before your shop can go live.' },
                { status: 400 }
            )
        }

        // Determine if pricing should be auto-approved for this role
        const autoApproveVal = globalSettings[`auto_approve_pricing_${userRole}`]
        // Default to true when the key is absent; explicit false/0/'false'/'0' disables it
        const autoApprovePricing =
            autoApproveVal === undefined ||
            autoApproveVal === null ||
            (autoApproveVal !== false &&
                autoApproveVal !== 'false' &&
                autoApproveVal !== 0 &&
                autoApproveVal !== '0')

        // SF-01: a pricing re-submission must NEVER lift an admin hold. If the shop
        // is suspended/rejected, route the new pricing to review but leave
        // approval_status / is_active untouched so the suspension stands.
        const { data: currentShop } = await (adminDb as any)
            .from('shop_profiles')
            .select('approval_status')
            .eq('id', verifiedShopId)
            .single()
        const isTerminal = currentShop?.approval_status === 'suspended' || currentShop?.approval_status === 'rejected'
        const canAutoApprove = autoApprovePricing && !isTerminal

        const profileUpdates: Record<string, any> = {
            pricing_status: canAutoApprove ? 'approved' : 'pending_review',
            pricing_submitted_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            ...airtimeUpdates,
        }
        // Only (re)activate/approve a shop that is not under an admin hold.
        if (!isTerminal) {
            profileUpdates.is_active = canAutoApprove
            if (canAutoApprove) {
                profileUpdates.approval_status = 'approved'
            }
        }

        const { error: updateError } = await (adminDb as any)
            .from('shop_profiles')
            .update(profileUpdates)
            .eq('id', verifiedShopId)

        if (updateError) {
            return NextResponse.json({ error: 'Pricing saved but failed to update shop status' }, { status: 500 })
        }

        return NextResponse.json({ success: true })
    } catch (err: any) {
        console.error('Pricing API Error:', err)
        return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 })
    }
}
