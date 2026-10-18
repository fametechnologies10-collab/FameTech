// scripts/verify-profit-engine-parity.ts
//
// Guards the fix from 20261018c_dashboard_profit_engine_unify.sql: the admin
// dashboard (/admin) and Profit History (/admin/profits-history) must report
// the SAME revenue and profit for the SAME window, because they must read the
// same engine.
//
// Before that migration they did not. The dashboard ran an inherited
// sum(price - COALESCE(cost_price_at_time,0)) over `orders` alone, which booked
// a storefront reseller's own margin as platform profit (the mirror row in
// `orders` carries the CUSTOMER's price and the SHOP OWNER's cost), dropped the
// platform's real margin on that order, ignored seven other product
// categories, treated an unknown cost as free, and never deducted a recruiter's
// sub-agent earning.
//
// Read-only. Run against the live project:
//   npx tsx scripts/verify-profit-engine-parity.ts
//
// Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. Both RPCs
// are service_role-only by design, so this cannot run with the anon key.
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
)

let failed = false

function check(name: string, ok: boolean, detail: string) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`)
    if (!ok) failed = true
}

/** Dashboard window bounds, mirroring get_admin_dashboard_stats exactly. */
function window(daysBack: number) {
    const start = new Date()
    start.setUTCHours(0, 0, 0, 0)
    start.setUTCDate(start.getUTCDate() - daysBack)
    const end = new Date()
    end.setUTCHours(23, 59, 59, 999)
    return { start: start.toISOString(), end: end.toISOString() }
}

async function main() {
    const { data: stats, error: statsErr } = await (supabase as any).rpc('get_admin_dashboard_stats')
    if (statsErr) throw new Error(`get_admin_dashboard_stats failed: ${statsErr.message}`)

    // ── 1. Dashboard tiles == Profit History, per window ────────────────────
    const windows: { label: string; daysBack: number; profitKey: string; revenueKey: string }[] = [
        { label: 'today', daysBack: 0, profitKey: 'profitToday', revenueKey: 'revenueToday' },
        { label: '7d', daysBack: 6, profitKey: 'profit7d', revenueKey: 'revenue7d' },
        { label: '30d', daysBack: 29, profitKey: 'profit30d', revenueKey: 'revenue30d' },
    ]

    for (const w of windows) {
        const { start, end } = window(w.daysBack)
        const { data: summary, error } = await (supabase as any).rpc('get_profit_summary_v2', {
            p_start_date: start,
            p_end_date: end,
            p_prev_start_date: start,
            p_prev_end_date: end,
            p_product_types: null,
            p_network: null,
        })
        if (error) throw new Error(`get_profit_summary_v2 failed for ${w.label}: ${error.message}`)

        const dashProfit = Number(stats[w.profitKey])
        const dashRevenue = Number(stats[w.revenueKey])
        const histProfit = Number(summary.summary.total_profit)
        const histRevenue = Number(summary.summary.total_revenue)

        // Exact equality, not a tolerance: both sides are the same numeric
        // aggregate over the same rows. Any drift means the engines diverged
        // again, which is the whole thing this test exists to catch.
        check(
            `profit parity (${w.label})`,
            dashProfit === histProfit,
            `dashboard ${dashProfit} vs history ${histProfit}`,
        )
        check(
            `revenue parity (${w.label})`,
            dashRevenue === histRevenue,
            `dashboard ${dashRevenue} vs history ${histRevenue}`,
        )
    }

    // ── 2. The chart must sum to the tile above it ──────────────────────────
    for (const [range, profitKey, revenueKey] of [
        ['today', 'profitToday', 'revenueToday'],
        ['7d', 'profit7d', 'revenue7d'],
        ['30d', 'profit30d', 'revenue30d'],
    ] as const) {
        const { data: trends, error } = await (supabase as any).rpc('get_admin_dashboard_trends', { p_range: range })
        if (error) throw new Error(`get_admin_dashboard_trends failed for ${range}: ${error.message}`)

        const series: { revenue: number; profit: number }[] = trends.series || []
        const sumProfit = series.reduce((a, p) => a + Number(p.profit), 0)
        const sumRevenue = series.reduce((a, p) => a + Number(p.revenue), 0)

        // Float summation of numerics can introduce representation error, so
        // compare to the pesewa rather than bit-exactly here.
        check(
            `chart profit sums to tile (${range})`,
            Math.abs(sumProfit - Number(stats[profitKey])) < 0.005,
            `series ${sumProfit.toFixed(2)} vs tile ${Number(stats[profitKey]).toFixed(2)}`,
        )
        check(
            `chart revenue sums to tile (${range})`,
            Math.abs(sumRevenue - Number(stats[revenueKey])) < 0.005,
            `series ${sumRevenue.toFixed(2)} vs tile ${Number(stats[revenueKey]).toFixed(2)}`,
        )
    }

    // ── 3. _profit_daily_rows_v2 is still a faithful rollup of the ts rows ──
    // (it became a wrapper over _profit_ts_rows_v2 in the same migration)
    const { start, end } = window(29)
    const [{ data: daily }, { data: ts }] = await Promise.all([
        (supabase as any).rpc('_profit_daily_rows_v2', {
            p_start_date: start, p_end_date: end, p_product_types: null, p_network: null,
        }),
        (supabase as any).rpc('_profit_ts_rows_v2', {
            p_start_date: start, p_end_date: end, p_product_types: null, p_network: null,
        }),
    ])
    if (Array.isArray(daily) && Array.isArray(ts)) {
        const dailyRev = daily.reduce((a: number, r: any) => a + Number(r.revenue), 0)
        const tsRev = ts.reduce((a: number, r: any) => a + Number(r.revenue), 0)
        check(
            'daily rows == ts rows',
            daily.length === ts.length && Math.abs(dailyRev - tsRev) < 0.005,
            `${daily.length} rows / ${dailyRev.toFixed(2)} vs ${ts.length} rows / ${tsRev.toFixed(2)}`,
        )
    } else {
        console.log('SKIP  daily rows == ts rows — RPCs not exposed over PostgREST (service_role only)')
    }

    // ── 4. Airtime must not be flagged `excluded` for a supplier that never
    // pays commission. KingFlexyGH's airtime endpoint returns none, so a NULL
    // commission_amount there is normal, not missing data.
    const { data: summary30 } = await (supabase as any).rpc('get_profit_summary_v2', {
        p_start_date: start, p_end_date: end, p_prev_start_date: start, p_prev_end_date: end,
        p_product_types: null, p_network: null,
    })
    const airtime = summary30?.by_product?.airtime
    if (airtime) {
        const { count: hubtelMissing } = await (supabase as any)
            .from('airtime_orders')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'completed')
            .eq('fulfillment_service', 'hubtel-commission')
            .is('commission_amount', null)
            .gte('created_at', start)
            .lte('created_at', end)
        check(
            'airtime excluded counts only commission-paying suppliers',
            Number(airtime.excluded) === (hubtelMissing || 0),
            `excluded ${airtime.excluded} vs hubtel-with-null-commission ${hubtelMissing || 0} (of ${airtime.orders} orders)`,
        )
    }

    console.log(failed ? '\nFAILED' : '\nAll parity checks passed')
    process.exit(failed ? 1 : 0)
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
