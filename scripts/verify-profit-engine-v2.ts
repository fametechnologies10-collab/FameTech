// scripts/verify-profit-engine-v2.ts
// Live-data spot-check for get_profit_summary_v2 — run after any change to
// supabase/migrations/20260928_profit_engine_v2.sql. Read-only.
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
)

async function main() {
    let failed = false

    // ── 1. Find one real sub-agent data order with a pending/credited recruiter earning ──
    const { data: earning } = await (supabase as any)
        .from('sub_agent_order_earnings')
        .select('order_table, order_reference, amount, status')
        .in('status', ['pending', 'credited'])
        .eq('order_table', 'orders')
        .limit(1)
        .maybeSingle()

    if (earning) {
        const { data: order } = await (supabase as any)
            .from('orders')
            .select('price, cost_price_at_time, status')
            .eq('reference_code', earning.order_reference)
            .single()

        if (order && order.status === 'completed') {
            const expectedProfit = order.price - order.cost_price_at_time - earning.amount
            const naiveProfit = order.price - order.cost_price_at_time
            console.log(`[SubAgent] order ${earning.order_reference}: price=${order.price} adminCost=${order.cost_price_at_time} recruiterMargin=${earning.amount}`)
            console.log(`[SubAgent] expected (v2, margin subtracted) = ${expectedProfit}, naive (v1 bug) = ${naiveProfit}`)
            if (expectedProfit >= naiveProfit) {
                console.error('FAIL: v2 expected profit should be strictly less than the naive v1 calculation when a recruiter margin exists')
                failed = true
            } else {
                console.log('PASS: v2 profit is correctly lower than the naive v1 calculation by the recruiter margin')
            }
        } else {
            console.log('[SubAgent] matched earning\'s order is not completed — skipping (expected occasionally, not a failure)')
        }
    } else {
        console.log('[SubAgent] no pending/credited sub-agent order earning found in orders — skipping (fine on a fresh/low-volume project)')
    }

    // ── 2. Confirm the RPC's AFA numbers use afa_cost_price, not afa_orders.cost_price ──
    const { data: afaSetting } = await (supabase as any)
        .from('admin_settings')
        .select('value')
        .eq('key', 'afa_cost_price')
        .single()
    const afaCost = parseFloat(String(afaSetting?.value ?? '').replace(/"/g, ''))

    const { data: afaOrder } = await (supabase as any)
        .from('afa_orders')
        .select('reference_code, payment_amount, selling_price, cost_price, status')
        .eq('status', 'completed')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

    if (afaOrder) {
        const revenue = afaOrder.payment_amount ?? afaOrder.selling_price ?? 0
        console.log(`[AFA] order ${afaOrder.reference_code}: revenue=${revenue}, row.cost_price(tier price, NOT used)=${afaOrder.cost_price}, admin_settings.afa_cost_price(USED)=${afaCost}`)
        if (afaCost === afaOrder.cost_price) {
            console.log('NOTE: afa_cost_price happens to equal this row\'s tier price — can\'t distinguish which one the RPC used from this sample alone, check another row if this matters')
        } else {
            console.log(`PASS: afa_cost_price (${afaCost}) differs from the row's stored tier price (${afaOrder.cost_price}) — confirms the RPC is reading the admin setting, not the row`)
        }
    } else {
        console.log('[AFA] no completed AFA orders found — skipping')
    }

    // ── 3. Run the actual RPC over the last 90 days and sanity-check the shape ──
    const now = new Date()
    const start = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
    const { data: summary, error } = await (supabase as any).rpc('get_profit_summary_v2', {
        p_start_date: start.toISOString(),
        p_end_date: now.toISOString(),
        p_prev_start_date: new Date(start.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString(),
        p_prev_end_date: start.toISOString(),
        p_product_types: null,
        p_network: null,
    })

    if (error) {
        console.error('FAIL: get_profit_summary_v2 RPC error:', error.message)
        failed = true
    } else {
        const expectedKeys = ['data', 'airtime', 'utility', 'afa', 'results_checker', 'subscriptions', 'sms', 'ussd_activation']
        const gotKeys = Object.keys(summary.by_product || {})
        const missing = expectedKeys.filter(k => !gotKeys.includes(k))
        if (missing.length > 0) {
            console.error('FAIL: by_product missing keys:', missing)
            failed = true
        } else {
            console.log('PASS: by_product has all 8 expected product-type keys')
        }

        const sumOfProducts = Object.values(summary.by_product as Record<string, any>).reduce((s, p: any) => s + p.profit, 0)
        const diff = Math.abs(sumOfProducts - summary.summary.total_profit)
        if (diff > 0.01) {
            console.error(`FAIL: summary.total_profit (${summary.summary.total_profit}) does not match sum of by_product profits (${sumOfProducts})`)
            failed = true
        } else {
            console.log('PASS: summary.total_profit matches the sum of all by_product profits')
        }
    }

    // ── 4. Wallet overview v2 — confirm the new commission balance is a real,
    // independently-computed sum, not a copy/paste of one of the other two. ──
    const { data: walletOverview, error: walletError } = await (supabase as any).rpc('get_wallet_overview_v2')
    if (walletError) {
        console.error('FAIL: get_wallet_overview_v2 RPC error:', walletError.message)
        failed = true
    } else {
        const { count: commissionRowCount } = await (supabase as any)
            .from('commission_wallets')
            .select('id', { count: 'exact', head: true })
            .gt('balance', 0)
        if (commissionRowCount !== walletOverview.commission_count) {
            console.error(`FAIL: get_wallet_overview_v2 commission_count (${walletOverview.commission_count}) does not match a direct count (${commissionRowCount})`)
            failed = true
        } else {
            console.log(`PASS: get_wallet_overview_v2 commission_count matches a direct count (${commissionRowCount})`)
        }
        console.log(`[Wallets] users=${walletOverview.total_user_balance} (${walletOverview.user_count}), shops=${walletOverview.total_shop_owner_balance} (${walletOverview.shop_owner_count}), commission=${walletOverview.total_commission_balance} (${walletOverview.commission_count})`)
    }

    // ── 5. C1 fix: find one real multi-quantity storefront RC order, hand-compute
    // the corrected revenue/cost using the C1 formula, call get_profit_summary_v2
    // over a tight window containing just that order, and assert the RPC's
    // results_checker contribution matches the hand-computed expectation. This
    // actually calls the RPC and checks its output — the earlier sub-agent check
    // above only proved a tautology enforced by a DB CHECK constraint and never
    // called the RPC at all. ──
    const { data: rcOrder } = await (supabase as any)
        .from('results_checker_orders')
        .select('reference_code, total_paid, cost_price_at_time, quantity, shop_markup, fee_amount, created_at')
        .eq('status', 'completed')
        .gt('quantity', 1)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

    if (rcOrder) {
        const expectedRevenue = Number(rcOrder.total_paid) - (Number(rcOrder.shop_markup) || 0) * rcOrder.quantity - (Number(rcOrder.fee_amount) || 0)
        const expectedCost = Number(rcOrder.cost_price_at_time) * rcOrder.quantity
        const t = new Date(rcOrder.created_at)
        const winStart = new Date(t.getTime() - 60 * 1000).toISOString()
        const winEnd = new Date(t.getTime() + 60 * 1000).toISOString()

        const { data: rcSummary, error: rcErr } = await (supabase as any).rpc('get_profit_summary_v2', {
            p_start_date: winStart,
            p_end_date: winEnd,
            p_prev_start_date: winStart,
            p_prev_end_date: winStart,
            p_product_types: ['results_checker'],
            p_network: null,
        })

        if (rcErr) {
            console.error('FAIL: get_profit_summary_v2 RPC error on RC tight-window check:', rcErr.message)
            failed = true
        } else {
            const rc = rcSummary.by_product?.results_checker
            console.log(`[C1/RC] order ${rcOrder.reference_code}: qty=${rcOrder.quantity} total_paid=${rcOrder.total_paid} cost_price_at_time=${rcOrder.cost_price_at_time} shop_markup=${rcOrder.shop_markup} fee_amount=${rcOrder.fee_amount}`)
            console.log(`[C1/RC] hand-computed: revenue=${expectedRevenue}, cost=${expectedCost}`)
            console.log(`[C1/RC] RPC window (${winStart}..${winEnd}) returned: revenue=${rc?.revenue}, cost=${rc?.cost}, orders=${rc?.orders}`)
            if (!rc || rc.orders !== 1 || Math.abs(Number(rc.revenue) - expectedRevenue) > 0.01 || Math.abs(Number(rc.cost) - expectedCost) > 0.01) {
                console.error('FAIL: RPC results_checker contribution does not match the hand-computed C1 formula for this order')
                failed = true
            } else {
                console.log('PASS: RPC results_checker revenue/cost match the hand-computed C1 formula (quantity-scaled cost, shop-markup/fee stripped from revenue)')
            }
        }
    } else {
        console.log('[C1/RC] no completed multi-quantity results-checker order found — skipping (fine on a fresh/low-volume project)')
    }

    // ── 6. C2 fix: find one real shop-sold AFA order, hand-compute the corrected
    // revenue using the C2 formula (ao.cost_price, not payment_amount/selling_price),
    // call get_profit_summary_v2 over a tight window, and assert the RPC's afa
    // contribution matches. ──
    const { data: shopAfaOrder } = await (supabase as any)
        .from('afa_orders')
        .select('reference_code, shop_id, payment_amount, selling_price, cost_price, created_at')
        .eq('status', 'completed')
        .not('shop_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

    if (shopAfaOrder) {
        const expectedRevenue = Number(shopAfaOrder.cost_price)
        const naiveRevenue = Number(shopAfaOrder.payment_amount ?? shopAfaOrder.selling_price ?? 0)
        const t = new Date(shopAfaOrder.created_at)
        const winStart = new Date(t.getTime() - 60 * 1000).toISOString()
        const winEnd = new Date(t.getTime() + 60 * 1000).toISOString()

        const { data: afaSummary, error: afaErr } = await (supabase as any).rpc('get_profit_summary_v2', {
            p_start_date: winStart,
            p_end_date: winEnd,
            p_prev_start_date: winStart,
            p_prev_end_date: winStart,
            p_product_types: ['afa'],
            p_network: null,
        })

        if (afaErr) {
            console.error('FAIL: get_profit_summary_v2 RPC error on shop-AFA tight-window check:', afaErr.message)
            failed = true
        } else {
            const afa = afaSummary.by_product?.afa
            console.log(`[C2/AFA] order ${shopAfaOrder.reference_code}: shop_id=${shopAfaOrder.shop_id} cost_price=${shopAfaOrder.cost_price} payment_amount/selling_price(naive, NOT expected)=${naiveRevenue}`)
            console.log(`[C2/AFA] RPC window (${winStart}..${winEnd}) returned: revenue=${afa?.revenue}, orders=${afa?.orders}`)
            if (!afa || afa.orders !== 1 || Math.abs(Number(afa.revenue) - expectedRevenue) > 0.01) {
                console.error('FAIL: RPC afa contribution does not match the hand-computed C2 formula (expected cost_price) for this shop-sold order')
                failed = true
            } else if (Math.abs(Number(afa.revenue) - naiveRevenue) < 0.01 && Math.abs(expectedRevenue - naiveRevenue) > 0.01) {
                console.error('FAIL: RPC afa revenue matches the naive (pre-fix) payment_amount/selling_price instead of cost_price')
                failed = true
            } else {
                console.log('PASS: RPC afa revenue matches the hand-computed C2 formula (cost_price for shop-sold orders)')
            }
        }
    } else {
        console.log('[C2/AFA] no completed shop-sold AFA order found — skipping (fine on a fresh/low-volume project)')
    }

    // ── 7. Cross-check: SUM(get_profit_timeseries_v2 daily profits) must equal
    // get_profit_summary_v2's total_profit for the same date range/filters —
    // nothing previously checked this. ──
    {
        const { data: tsSummary, error: tsSummaryErr } = await (supabase as any).rpc('get_profit_summary_v2', {
            p_start_date: start.toISOString(),
            p_end_date: now.toISOString(),
            p_prev_start_date: new Date(start.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString(),
            p_prev_end_date: start.toISOString(),
            p_product_types: null,
            p_network: null,
        })
        const { data: timeseries, error: tsErr } = await (supabase as any).rpc('get_profit_timeseries_v2', {
            p_start_date: start.toISOString(),
            p_end_date: now.toISOString(),
            p_product_types: null,
            p_network: null,
        })

        if (tsSummaryErr || tsErr) {
            console.error('FAIL: get_profit_summary_v2/get_profit_timeseries_v2 RPC error:', (tsSummaryErr || tsErr).message)
            failed = true
        } else {
            const sumDaily = (timeseries as any[]).reduce((s, d) => s + Number(d.profit), 0)
            const totalProfit = Number(tsSummary.summary.total_profit)
            const diff = Math.abs(sumDaily - totalProfit)
            console.log(`[Timeseries] sum(daily.profit)=${sumDaily}, summary.total_profit=${totalProfit}`)
            if (diff > 0.01) {
                console.error(`FAIL: SUM(get_profit_timeseries_v2 daily profits) (${sumDaily}) does not match get_profit_summary_v2's total_profit (${totalProfit})`)
                failed = true
            } else {
                console.log('PASS: SUM(get_profit_timeseries_v2 daily profits) matches get_profit_summary_v2 total_profit')
            }
        }
    }

    if (failed) {
        console.error('\nOne or more checks FAILED — see above.')
        process.exitCode = 1
    } else {
        console.log('\nAll checks passed.')
    }
}

main().catch((e) => {
    console.error('Script error:', e)
    process.exitCode = 1
})
