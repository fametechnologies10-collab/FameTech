import { NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'

// ============================================================================
// User API usage stats — aggregates over `orders` (source='api') + `api_logs`
// ============================================================================

const SIZE_TO_GB: Record<string, number> = {}

function parseSizeToGb(size: string | null): number {
    if (!size) return 0
    const s = String(size).trim().toUpperCase()
    if (SIZE_TO_GB[s] !== undefined) return SIZE_TO_GB[s]
    const m = s.match(/([\d.]+)\s*(GB|MB|TB)?/)
    if (!m) return (SIZE_TO_GB[s] = 0)
    const n = parseFloat(m[1])
    const unit = m[2] || 'GB'
    const gb = unit === 'MB' ? n / 1024 : unit === 'TB' ? n * 1024 : n
    return (SIZE_TO_GB[s] = isFinite(gb) ? gb : 0)
}

export async function GET() {
    try {
        const supabaseAuth = await createRouteClient()
        const { data: { user: authUser } } = await supabaseAuth.auth.getUser()
        if (!authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const supabase = createServerClient()
        const userId = authUser.id

        // ── Find the user's STANDARD API key id (so we can count api_logs) ─
        // Scoped to key_type='standard': this endpoint aggregates the
        // `orders` table (source='api'), which only standard keys create.
        // Commission keys are utilities-only and write to `utility_orders`
        // instead, so they have no rows here to aggregate. Without this
        // scope, a user holding BOTH key types would make this query return
        // 2 rows and .maybeSingle() would error.
        const { data: keyRow } = await (supabase.from('api_keys') as any)
            .select('id, last_used_at')
            .eq('user_id', userId)
            .eq('key_type', 'standard')
            .maybeSingle()

        const apiKeyId = (keyRow as any)?.id || null

        // ── Order aggregates (source='api') ───────────────────────────────
        // Pull a bounded set; if a user ever exceeds 10k API orders we'll switch
        // to a SQL RPC. Today this is well within Postgres' single-query budget.
        const { data: orders } = await (supabase.from('orders') as any)
            .select('price, status, size, created_at')
            .eq('user_id', userId)
            .eq('source', 'api')
            .limit(10000)

        let totalSpent = 0
        let totalOrders = 0
        let successOrders = 0
        let failedOrders = 0
        let pendingOrders = 0
        let totalGb = 0
        let weekSpent = 0
        let weekOrders = 0

        const weekAgoMs = Date.now() - 7 * 86400_000
        for (const o of (orders as any[]) || []) {
            totalOrders++
            const price = Number(o.price) || 0
            const status = o.status as string
            const created = o.created_at ? new Date(o.created_at).getTime() : 0

            if (status === 'completed') {
                successOrders++
                totalSpent += price
                totalGb += parseSizeToGb(o.size)
                if (created >= weekAgoMs) { weekSpent += price; weekOrders++ }
            } else if (status === 'failed') {
                failedOrders++
            } else {
                pendingOrders++
            }
        }

        // ── API log counts (last 24h, last 7d) ────────────────────────────
        let requests24h = 0
        let requests7d = 0
        if (apiKeyId) {
            const since24h = new Date(Date.now() - 86400_000).toISOString()
            const since7d = new Date(weekAgoMs).toISOString()

            const [r24, r7] = await Promise.all([
                (supabase.from('api_logs') as any)
                    .select('id', { count: 'exact', head: true })
                    .eq('api_key_id', apiKeyId)
                    .gte('created_at', since24h),
                (supabase.from('api_logs') as any)
                    .select('id', { count: 'exact', head: true })
                    .eq('api_key_id', apiKeyId)
                    .gte('created_at', since7d),
            ])
            requests24h = (r24 as any)?.count || 0
            requests7d = (r7 as any)?.count || 0
        }

        const successRate = totalOrders > 0
            ? Math.round((successOrders / totalOrders) * 1000) / 10
            : 0

        return NextResponse.json({
            total_spent: Math.round(totalSpent * 100) / 100,
            total_orders: totalOrders,
            success_orders: successOrders,
            failed_orders: failedOrders,
            pending_orders: pendingOrders,
            success_rate: successRate,
            total_gb: Math.round(totalGb * 100) / 100,
            requests_24h: requests24h,
            requests_7d: requests7d,
            week_spent: Math.round(weekSpent * 100) / 100,
            week_orders: weekOrders,
            last_used_at: (keyRow as any)?.last_used_at || null,
        })
    } catch (error: any) {
        console.error('[API Keys Stats GET] Exception:', error.message)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
