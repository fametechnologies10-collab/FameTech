/**
 * /api/admin/sms-platform/bundles — admin CRUD for KFT SMS platform bundles.
 *
 * GET: list every `sms_bundles` row (all modes), ordered by mode then
 * sort_order — feeds the admin Bundles panel.
 * PUT: create (no id) or update (id present) a `sms_bundles` row. Mirrors
 * the shop-sms bundle PUT (app/api/admin/shop-sms/route.ts) but targets the
 * KFT `sms_bundles` table and adds the v2 `mode` selector (platform /
 * business / both) that segregates the bundle catalog shown per account mode.
 *
 * Auth: createRouteClient (cookie/RLS-aware) for the session + admin-role
 * check; createServerClient (service-role, no cookies) only for reads/writes —
 * auth already happened above, so no auth.getUser() call on the admin client.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { z } from 'zod'
import { consumeRateLimit } from '@/lib/simple-rate-limit'

async function requireAdmin() {
    const client = await createRouteClient()
    const { data: { user }, error } = await client.auth.getUser()
    if (error || !user) return { error: 'Unauthorized', status: 401 }
    const rl = consumeRateLimit(`admin-sms-bundles:${user.id}`, 30, 60 * 1000)
    if (!rl.allowed) return { error: 'Too many requests', status: 429 }
    const { data } = await client.from('users').select('role').eq('id', user.id).single()
    if ((data as any)?.role !== 'admin') return { error: 'Forbidden - Admin only', status: 403 }
    return { user }
}

const bundleSchema = z.object({
    id: z.string().uuid().optional(),
    name: z.string().trim().min(2).max(50),
    credits: z.number().int().positive().max(1000000),
    price: z.number().positive().max(100000),
    is_active: z.boolean().default(true),
    sort_order: z.number().int().min(0).max(100).default(0),
    mode: z.enum(['platform', 'business', 'both']),
})

const bundleDeleteSchema = z.object({ id: z.string().uuid() })

// ─── GET — list every KFT SMS bundle for the admin bundle panel ───────────────
export async function GET() {
    try {
        const auth = await requireAdmin()
        if ('error' in auth) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status })

        // Service-role read — auth + admin-role check already happened above.
        const db = createServerClient()
        const { data, error } = await (db as any)
            .from('sms_bundles')
            .select('*')
            .order('mode', { ascending: true })
            .order('sort_order', { ascending: true })

        // Degrade rather than 500: the bundle catalog is one panel on the
        // wider SMS Platform admin page (review queues, accounts, flags all
        // live at a different endpoint) — a schema hiccup here (e.g. this
        // panel's `mode` column not yet migrated) shouldn't read to the
        // owner as "the admin page is broken" when only pricing tiers are
        // affected. Surface it as a warning the client can show inline.
        if (error) {
            console.error('[Admin SMS Bundles GET] query failed:', error?.message || error)
            return NextResponse.json({
                success: true,
                data: { bundles: [], warnings: [`Bundles: ${error.message || 'query failed'}`] },
            })
        }

        return NextResponse.json({ success: true, data: { bundles: data || [], warnings: [] } })
    } catch (e: any) {
        console.error('[Admin SMS Bundles GET]', e)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}

// ─── PUT — create or update a KFT SMS bundle tier ─────────────────────────────
export async function PUT(request: NextRequest) {
    try {
        const auth = await requireAdmin()
        if ('error' in auth) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status })

        const body = await request.json()
        const parsed = bundleSchema.safeParse(body)
        if (!parsed.success) {
            return NextResponse.json(
                { success: false, error: parsed.error.errors[0]?.message || 'Invalid bundle' },
                { status: 400 }
            )
        }

        // Service-role write — auth + admin-role check already happened above
        // via the cookie-aware requireAdmin() client. `sms_bundles` has no
        // `created_at` column and `business_price` is a dead column (v2:
        // price is single-sourced from `price` per mode) — neither is written.
        const db = createServerClient()
        const row = {
            name: parsed.data.name,
            credits: parsed.data.credits,
            price: parsed.data.price,
            is_active: parsed.data.is_active,
            sort_order: parsed.data.sort_order,
            mode: parsed.data.mode,
            updated_at: new Date().toISOString(),
        }

        if (parsed.data.id) {
            const { error } = await (db as any).from('sms_bundles').update(row).eq('id', parsed.data.id)
            if (error) throw error
        } else {
            const { error } = await (db as any).from('sms_bundles').insert(row)
            if (error) throw error
        }

        return NextResponse.json({ success: true })
    } catch (e: any) {
        console.error('[Admin SMS Bundles PUT]', e)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}

// ─── DELETE — remove a KFT SMS bundle tier ─────────────────────────────────────
// A bundle referenced by past purchases (sms_purchases.bundle_id) is NEVER
// hard-deleted — that would either throw a FK violation (the column has no
// ON DELETE clause, i.e. RESTRICT) or, if it didn't, silently orphan revenue
// history. Referenced bundles are deactivated instead (is_active=false),
// which purchase_user_sms_credits already enforces at purchase time
// (`WHERE id = p_bundle_id AND is_active = true`) — so the tier stops being
// purchasable immediately, exactly like a hard delete, without touching history.
export async function DELETE(request: NextRequest) {
    try {
        const auth = await requireAdmin()
        if ('error' in auth) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status })

        const body = await request.json().catch(() => null)
        const parsed = bundleDeleteSchema.safeParse(body)
        if (!parsed.success) {
            return NextResponse.json({ success: false, error: 'Invalid request — bundle id required' }, { status: 400 })
        }

        const db = createServerClient()

        const { count, error: countErr } = await (db as any)
            .from('sms_purchases')
            .select('id', { count: 'exact', head: true })
            .eq('bundle_id', parsed.data.id)
        if (countErr) throw countErr

        if ((count ?? 0) > 0) {
            const { data: updated, error } = await (db as any)
                .from('sms_bundles')
                .update({ is_active: false, updated_at: new Date().toISOString() })
                .eq('id', parsed.data.id)
                .select('id')
            if (error) throw error
            if (!updated || updated.length === 0) {
                return NextResponse.json({ success: false, error: 'Bundle not found' }, { status: 404 })
            }
            return NextResponse.json({
                success: true,
                data: { deactivated: true },
                message: `This bundle has ${count} past purchase(s) on record, so it was deactivated instead of deleted — purchase history and revenue totals stay intact.`,
            })
        }

        const { data: deleted, error } = await (db as any)
            .from('sms_bundles')
            .delete()
            .eq('id', parsed.data.id)
            .select('id')
        if (error) throw error
        if (!deleted || deleted.length === 0) {
            return NextResponse.json({ success: false, error: 'Bundle not found' }, { status: 404 })
        }

        return NextResponse.json({ success: true, data: { deactivated: false } })
    } catch (e: any) {
        console.error('[Admin SMS Bundles DELETE]', e)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}
