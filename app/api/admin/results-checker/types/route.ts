import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { cookies } from 'next/headers'

async function verifyAdmin(request: NextRequest) {
    const cookieStore = await cookies()
    const supabaseUserClient = await createRouteClient()
    const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()
    if (authError || !authUser) return null

    const supabase = createServerClient()
    const { data: userProfile } = await (supabase as any)
        .from('users')
        .select('role')
        .eq('id', authUser.id)
        .single()

    if (!userProfile || userProfile.role !== 'admin') return null
    return authUser
}

/**
 * Validate a bulk-pricing tier set. Returns an error string or null when valid.
 * Enforces, per tier: whole-number min_qty/max_qty, min_qty >= 1, max_qty >= min_qty,
 * and unit_price >= cost. Across the set (STRICT CONTIGUOUS): sorted by min_qty with no
 * overlaps AND no gaps — each subsequent tier must start exactly at prev.max_qty + 1.
 * (The first tier may start above 1; quantities below it use the base role price.)
 */
function validateBulkTiers(rawTiers: unknown, cost: number): string | null {
    const tiers = Array.isArray(rawTiers) ? rawTiers : []
    if (tiers.length === 0) return null

    for (const tier of tiers) {
        if (typeof tier?.min_qty !== 'number' || typeof tier?.max_qty !== 'number' || typeof tier?.unit_price !== 'number'
            || !Number.isFinite(tier.min_qty) || !Number.isFinite(tier.max_qty) || !Number.isFinite(tier.unit_price)) {
            return 'Each bulk pricing tier must have numeric min_qty, max_qty, and unit_price'
        }
        if (!Number.isInteger(tier.min_qty) || !Number.isInteger(tier.max_qty)) {
            return 'Bulk tier min_qty and max_qty must be whole numbers'
        }
        if (tier.min_qty < 1 || tier.max_qty < tier.min_qty) {
            return 'Invalid bulk tier: min_qty must be >= 1 and max_qty must be >= min_qty'
        }
        if (tier.unit_price < cost) {
            return `Bulk price (${tier.unit_price}) cannot be lower than cost price (${cost})`
        }
    }

    const sorted = [...tiers].sort((a, b) => a.min_qty - b.min_qty)
    for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1]
        const curr = sorted[i]
        if (curr.min_qty <= prev.max_qty) {
            return `Bulk tiers overlap: ${prev.min_qty}-${prev.max_qty} and ${curr.min_qty}-${curr.max_qty} share quantities`
        }
        if (curr.min_qty !== prev.max_qty + 1) {
            return `Bulk tiers must be contiguous: gap between ${prev.max_qty} and ${curr.min_qty} (next tier should start at ${prev.max_qty + 1})`
        }
    }
    return null
}

/**
 * GET /api/admin/results-checker/types
 * Returns all types (including inactive) with live stock counts.
 */
export async function GET(request: NextRequest) {
    const admin = await verifyAdmin(request)
    if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    try {
        const supabase = createServerClient()
        const db = supabase as any

        const { data: types, error } = await db
            .from('results_checker_types')
            .select('*')
            .order('display_order', { ascending: true })

        if (error) throw error

        // Annotate with stock counts
        const withCounts = await Promise.all(
            (types || []).map(async (t: any) => {
                const { count: available } = await db
                    .from('results_checker_inventory')
                    .select('id', { count: 'exact', head: true })
                    .eq('type_id', t.id)
                    .eq('status', 'available')

                const { count: total } = await db
                    .from('results_checker_inventory')
                    .select('id', { count: 'exact', head: true })
                    .eq('type_id', t.id)

                const { count: sold } = await db
                    .from('results_checker_inventory')
                    .select('id', { count: 'exact', head: true })
                    .eq('type_id', t.id)
                    .eq('status', 'sold')

                const { count: reserved } = await db
                    .from('results_checker_inventory')
                    .select('id', { count: 'exact', head: true })
                    .eq('type_id', t.id)
                    .eq('status', 'reserved')

                const { count: invalid } = await db
                    .from('results_checker_inventory')
                    .select('id', { count: 'exact', head: true })
                    .eq('type_id', t.id)
                    .eq('status', 'invalid')

                return {
                    ...t,
                    stock: {
                        available: available ?? 0,
                        reserved:  reserved ?? 0,
                        sold:      sold ?? 0,
                        invalid:   invalid ?? 0,
                        total:     total ?? 0,
                    },
                }
            })
        )

        return NextResponse.json({ success: true, types: withCounts })
    } catch (error) {
        console.error('[RC Admin Types GET] Error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

/**
 * POST /api/admin/results-checker/types
 * Create a new voucher type.
 */
export async function POST(request: NextRequest) {
    const admin = await verifyAdmin(request)
    if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    try {
        const supabase = createServerClient()
        const db = supabase as any

        const body = await request.json()
        const { name, customer_price, agent_price, dealer_price, cost_price, display_order, is_active } = body

        if (!name || customer_price === undefined || agent_price === undefined || dealer_price === undefined || cost_price === undefined) {
            return NextResponse.json(
                { error: 'Missing required fields: name, customer_price, agent_price, dealer_price, cost_price' },
                { status: 400 }
            )
        }

        const cp = parseFloat(customer_price)
        const ap = parseFloat(agent_price)
        const dp = parseFloat(dealer_price)
        const cost = parseFloat(cost_price)

        if (cp < cost || ap < cost || dp < cost) {
            return NextResponse.json(
                { error: 'Customer, Agent, or Dealer price cannot be lower than Cost price' },
                { status: 400 }
            )
        }

        // Validate bulk pricing tiers if provided (structure + cost floor + strict-contiguous bands)
        const bulk_pricing = Array.isArray(body.bulk_pricing) ? body.bulk_pricing : []
        const bulkErr = validateBulkTiers(bulk_pricing, cost)
        if (bulkErr) return NextResponse.json({ error: bulkErr }, { status: 400 })

        const ussd_price = body.ussd_price !== undefined && body.ussd_price !== '' && body.ussd_price !== null
            ? parseFloat(body.ussd_price)
            : null

        const { data, error } = await db
            .from('results_checker_types')
            .insert({
                name:           String(name).trim(),
                customer_price: parseFloat(customer_price),
                agent_price:    parseFloat(agent_price),
                dealer_price:   parseFloat(dealer_price),
                cost_price:     parseFloat(cost_price),
                display_order:  parseInt(display_order || '0', 10),
                is_active:      is_active !== false,
                bulk_pricing:   bulk_pricing,
                ussd_price,
            })
            .select()
            .single()

        if (error) {
            if (error.code === '23505') {
                return NextResponse.json({ error: 'A type with this name already exists' }, { status: 409 })
            }
            throw error
        }

        return NextResponse.json({ success: true, type: data }, { status: 201 })
    } catch (error) {
        console.error('[RC Admin Types POST] Error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

/**
 * PATCH /api/admin/results-checker/types
 * Update a voucher type.
 */
export async function PATCH(request: NextRequest) {
    const admin = await verifyAdmin(request)
    if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    try {
        const supabase = createServerClient()
        const db = supabase as any

        const body = await request.json()
        const { id, ...updates } = body

        if (!id) {
            return NextResponse.json({ error: 'type id is required' }, { status: 400 })
        }

        // Sanitize update fields — only allow known columns
        const allowedFields = ['name', 'customer_price', 'agent_price', 'dealer_price', 'cost_price', 'display_order', 'is_active', 'bulk_pricing', 'ussd_price']
        const sanitized: Record<string, any> = { updated_at: new Date().toISOString() }
        for (const field of allowedFields) {
            if (updates[field] !== undefined) {
                sanitized[field] = updates[field]
            }
        }

        // Validate prices if being updated
        if (sanitized.customer_price !== undefined || sanitized.agent_price !== undefined || sanitized.dealer_price !== undefined || sanitized.cost_price !== undefined) {
            const { data: current } = await db.from('results_checker_types').select('*').eq('id', id).single()
            if (current) {
                // Coerce to numbers up front — the client may send numeric strings, and a raw
                // string comparison ("10abc" < 5 === false) would silently pass an invalid price
                // through to the DB. Reject non-numeric values explicitly.
                const cp = Number(sanitized.customer_price ?? current.customer_price)
                const ap = Number(sanitized.agent_price ?? current.agent_price)
                const dp = Number(sanitized.dealer_price ?? current.dealer_price ?? 0)
                const cost = Number(sanitized.cost_price ?? current.cost_price)

                if (![cp, ap, dp, cost].every(Number.isFinite)) {
                    return NextResponse.json({ error: 'Prices must be valid numbers' }, { status: 400 })
                }
                if (cp < cost || ap < cost || (dp > 0 && dp < cost)) {
                    return NextResponse.json(
                        { error: 'Customer, Agent, or Dealer price cannot be lower than Cost price' },
                        { status: 400 }
                    )
                }

                // Validate bulk pricing tiers against (possibly updated) cost
                if (sanitized.bulk_pricing !== undefined) {
                    const bulkErr = validateBulkTiers(sanitized.bulk_pricing, Number(cost))
                    if (bulkErr) return NextResponse.json({ error: bulkErr }, { status: 400 })
                }
            }
        } else if (sanitized.bulk_pricing !== undefined) {
            // Bulk pricing updated without price change — still validate against current cost
            const { data: current } = await db.from('results_checker_types').select('cost_price').eq('id', id).single()
            if (current) {
                const bulkErr = validateBulkTiers(sanitized.bulk_pricing, Number(current.cost_price))
                if (bulkErr) return NextResponse.json({ error: bulkErr }, { status: 400 })
            }
        }

        const { data, error } = await db
            .from('results_checker_types')
            .update(sanitized)
            .eq('id', id)
            .select()
            .single()

        if (error) throw error

        return NextResponse.json({ success: true, type: data })
    } catch (error) {
        console.error('[RC Admin Types PATCH] Error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

/**
 * DELETE /api/admin/results-checker/types
 * Archive if orders exist, hard delete if no orders.
 */
export async function DELETE(request: NextRequest) {
    const admin = await verifyAdmin(request)
    if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    try {
        const supabase = createServerClient()
        const db = supabase as any

        const { searchParams } = new URL(request.url)
        const id = searchParams.get('id')

        if (!id) {
            return NextResponse.json({ error: 'type id is required' }, { status: 400 })
        }

        // Check for orders
        const { count: orderCount } = await db
            .from('results_checker_orders')
            .select('id', { count: 'exact', head: true })
            .eq('type_id', id)

        if ((orderCount ?? 0) > 0) {
            // Archive — orders exist, cannot hard delete
            const { data, error } = await db
                .from('results_checker_types')
                .update({ is_active: false, updated_at: new Date().toISOString() })
                .eq('id', id)
                .select()
                .single()

            if (error) throw error

            return NextResponse.json({
                success:  true,
                archived: true,
                message:  `Type archived (${orderCount} orders exist). It will no longer appear in storefronts.`,
                type:     data,
            })
        }

        // Hard delete — no orders
        const { error } = await db
            .from('results_checker_types')
            .delete()
            .eq('id', id)

        if (error) throw error

        return NextResponse.json({ success: true, deleted: true })
    } catch (error) {
        console.error('[RC Admin Types DELETE] Error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
