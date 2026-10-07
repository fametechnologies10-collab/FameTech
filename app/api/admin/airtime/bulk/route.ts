import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { manualRefulfillAirtime, manualStatusSyncAirtime, manualRefundAirtime, manualCompleteAirtime } from '@/lib/airtime-fulfillment'

// Bulk admin airtime refulfill / sync / refund. Loops the EXISTING idempotent lib fns
// (manualRefulfillAirtime / manualStatusSyncAirtime / manualRefundAirtime) — each carries a
// double-action guard (unique-ref for dispatch, refund-once for refund), so no order is ever
// topped up or refunded twice. We iterate SEQUENTIALLY (not Promise.all) to pace the metered
// Fixie static-IP proxy that fronts Hubtel. 'refund' is admin-only (sub-admin excluded).

const MAX_BULK = 50

async function verifyAdmin(supabaseUserClient: any): Promise<{ userId: string; role: string } | null> {
    const { data: { user: authUser }, error } = await supabaseUserClient.auth.getUser()
    if (error || !authUser) return null
    const supabase = createServerClient()
    const { data: user } = await supabase.from('users').select('role').eq('id', authUser.id).single()
    const role = (user as any)?.role
    return ['admin', 'sub-admin'].includes(role) ? { userId: authUser.id, role } : null
}

// POST { action: 'refulfill' | 'sync' | 'refund' | 'complete', orderIds: string[] } — bulk (re)dispatch/sync/refund/complete airtime orders.
export async function POST(request: NextRequest) {
    try {
        const supabaseUserClient = await createRouteClient()
        const admin = await verifyAdmin(supabaseUserClient)
        if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        let body: any
        try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }) }

        const action = body?.action
        if (action !== 'refulfill' && action !== 'sync' && action !== 'refund' && action !== 'complete') {
            return NextResponse.json({ error: "action must be 'refulfill', 'sync', 'refund' or 'complete'" }, { status: 400 })
        }
        // Refunds move money — strictly admin-only (sub-admin excluded).
        if (action === 'refund' && admin.role !== 'admin') {
            return NextResponse.json({ error: 'Forbidden — refunds are admin only' }, { status: 403 })
        }

        const rawIds = body?.orderIds
        if (!Array.isArray(rawIds) || rawIds.length === 0 || !rawIds.every((id: any) => typeof id === 'string' && id.length > 0 && id.length <= 100)) {
            return NextResponse.json({ error: 'orderIds must be a non-empty array of strings' }, { status: 400 })
        }

        const orderIds = Array.from(new Set(rawIds as string[]))
        if (orderIds.length > MAX_BULK) {
            return NextResponse.json({ error: 'Select at most 50 orders' }, { status: 400 })
        }

        const results: any[] = []

        // Sequential (for…of with await) — NOT Promise.all — to pace the metered Fixie proxy.
        for (const id of orderIds) {
            try {
                if (action === 'refulfill') {
                    const r = await manualRefulfillAirtime(id)
                    results.push({ orderId: id, ok: r.ok, status: r.status, message: r.message, commission: r.commission })
                } else if (action === 'refund') {
                    const r = await manualRefundAirtime(id, admin.userId)
                    results.push({ orderId: id, ok: r.ok, status: r.status, message: r.message, amount: r.amount })
                } else if (action === 'complete') {
                    const r = await manualCompleteAirtime(id, admin.userId)
                    results.push({ orderId: id, ok: r.ok, status: r.status, message: r.message })
                } else {
                    const r = await manualStatusSyncAirtime(id)
                    results.push({ orderId: id, ok: r.ok, status: r.status, verdict: r.verdict, message: r.message })
                }
            } catch (e: any) {
                results.push({ orderId: id, ok: false, status: 'error', message: String(e?.message || e) })
            }
        }

        // Classify each result: ok (delivered/marked), skipped (business-rule guard refusal,
        // not a real failure), failed (genuine Hubtel rejection or thrown error).
        const summary = { ok: 0, failed: 0, skipped: 0, total: results.length }
        for (const r of results) {
            if (r.ok === true) {
                // A no-op idempotent repeat ("Already refunded") is a skip, not a fresh success.
                if (action === 'refund' && /already refunded/i.test(String(r.message || ''))) summary.skipped++
                else summary.ok++
                continue
            }
            const guardStatus = ['not_found', 'completed', 'processing', 'skipped'].includes(r.status)
            const guardMessage = /already completed|already refunded|airtime only|Exceeds Hubtel|not in a refulfillable state|not refundable|refund via the shop order|still in-flight|not configured|no reference/i.test(String(r.message || ''))
            const guardVerdict = action === 'sync' && ['pending', 'unknown'].includes(r.verdict)
            if (guardStatus || guardMessage || guardVerdict) {
                summary.skipped++
            } else {
                summary.failed++
            }
        }

        return NextResponse.json({ action, summary, results }, { status: 200 })
    } catch (e: any) {
        console.error('[AirtimeBulk] error:', e?.message || e)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
