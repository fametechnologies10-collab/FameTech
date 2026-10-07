// app/api/dashboard/subagents/[id]/activity/route.ts
// =============================================================================
// Task 10 — recruiter-facing SAFE ACTIVITY VIEW per sub-agent
// (docs/superpowers/sdd/2026-09-28-subagent-upgrade/task-10-brief.md).
//
// Ownership check mirrors app/api/dashboard/subagents/[id]/pricing/route.ts
// EXACTLY: 404 if no sub_agents row exists for [id] at all, 403 if it exists
// but the caller isn't its upline_user_id.
//
// Deliberately excludes wallet balance, suspension history/reason, and raw
// transaction lists — those stay admin-only per the spec.
// =============================================================================

import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'

/** Copied verbatim from app/api/dashboard/subagents/[id]/pricing/route.ts — same ownership contract. */
async function verifySubOwnership(
    db: ReturnType<typeof createServerClient>,
    callerId: string,
    subUserId: string,
): Promise<{ ok: boolean; status: number; error?: string }> {
    const { data: subRow, error } = await (db as any)
        .from('sub_agents')
        .select('upline_user_id, status, created_at')
        .eq('user_id', subUserId)
        .maybeSingle()

    if (error) return { ok: false, status: 500, error: 'Could not verify sub-agent' }
    if (!subRow) return { ok: false, status: 404, error: 'Sub-agent not found' }
    if (subRow.upline_user_id !== callerId) return { ok: false, status: 403, error: "You are not this sub-agent's recruiter" }
    return { ok: true, status: 200 }
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params
        const supabase = await createRouteClient()
        const { data: { user }, error: authError } = await supabase.auth.getUser()
        if (authError || !user) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
        }

        const admin = createServerClient() as any
        const ownership = await verifySubOwnership(admin, user.id, id)
        if (!ownership.ok) {
            return NextResponse.json({ success: false, error: ownership.error }, { status: ownership.status })
        }

        const [subRow, totalOrdersRes, completedOrdersRes, spentRes, shopRes] = await Promise.all([
            admin.from('sub_agents').select('status, created_at').eq('user_id', id).maybeSingle(),
            admin.from('orders').select('*', { count: 'exact', head: true }).eq('user_id', id),
            admin.from('orders').select('*', { count: 'exact', head: true }).eq('user_id', id).eq('status', 'completed'),
            admin.from('orders').select('price').eq('user_id', id).eq('status', 'completed').limit(5000),
            admin.from('shop_profiles').select('id, shop_name').eq('owner_id', id).maybeSingle(),
        ])

        const totalSpent = (spentRes.data || []).reduce((s: number, r: any) => s + (Number(r.price) || 0), 0)

        return NextResponse.json({
            success: true,
            activity: {
                totalOrders: totalOrdersRes.count || 0,
                completedOrders: completedOrdersRes.count || 0,
                totalSpent,
                hasShop: !!shopRes.data,
                shopName: shopRes.data?.shop_name ?? null,
                status: subRow.data?.status ?? null,
                created_at: subRow.data?.created_at ?? null,
            },
        })
    } catch (error) {
        console.error('[api/dashboard/subagents/[id]/activity] GET failed', error)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}
