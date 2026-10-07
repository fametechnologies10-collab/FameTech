import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { parseSettingNumber } from '@/lib/paystack-fees'
import { resolveOrderDetails, type CommissionOrderTable } from '@/lib/commission-order-detail'
import { attachSubAgentNames } from '@/lib/commission-subagent-names'

export async function GET(request: NextRequest) {
    const supabase = await createRouteClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

    const typeFilter = request.nextUrl.searchParams.get('type')
    const fromParam = request.nextUrl.searchParams.get('from')
    const toParam = request.nextUrl.searchParams.get('to')

    // Both-or-neither: a partial or invalid pair is a 400, never silently ignored — the
    // caller (full-history view) always sends both, so a lone param means something is wrong.
    let fromDate: Date | null = null
    let toDate: Date | null = null
    if (fromParam || toParam) {
        if (!fromParam || !toParam) {
            return NextResponse.json({ success: false, error: 'Both from and to dates are required' }, { status: 400 })
        }
        fromDate = new Date(fromParam)
        toDate = new Date(toParam)
        if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
            return NextResponse.json({ success: false, error: 'Invalid from/to date' }, { status: 400 })
        }
        // A plain date-only string (e.g. "2026-09-01" from a <input type="date">) parses to UTC
        // midnight — extend it to the end of that day so "to" is genuinely inclusive of the whole
        // day, not just its first instant. A caller passing a full timestamp is left untouched.
        if (/^\d{4}-\d{2}-\d{2}$/.test(toParam)) {
            toDate = new Date(toDate.getTime() + 24 * 60 * 60 * 1000 - 1)
        }
    }

    const admin = createServerClient() as any

    const [walletRes, pctRes, pendingUtilityRes, pendingAirtimeRes] = await Promise.all([
        (supabase.from('commission_wallets') as any).select('id').eq('owner_id', user.id).maybeSingle(),
        admin.from('admin_settings').select('value').eq('key', 'utility_commission_partner_percent').maybeSingle(),
        (supabase.from('utility_orders') as any)
            .select('id, biller, amount, status, created_at')
            .eq('user_id', user.id)
            .eq('source', 'api')
            .in('status', ['pending', 'processing'])
            .order('created_at', { ascending: false })
            .limit(50),
        (supabase.from('airtime_orders') as any)
            .select('id, network, airtime_amount, status, created_at')
            .eq('user_id', user.id)
            .eq('source', 'api')
            .in('status', ['pending', 'processing'])
            .order('created_at', { ascending: false })
            .limit(50),
    ])

    const wallet = walletRes.data
    const commissionSharePercent = parseSettingNumber(pctRes.data?.value, 40)
    const pendingUtilityOrders = pendingUtilityRes.data
    const pendingAirtimeOrders = pendingAirtimeRes.data

    let transactions: any[] = []
    if (wallet) {
        let q = (supabase.from('commission_wallet_transactions') as any)
            .select('id, type, amount, description, status, order_reference, order_table, created_at')
            .eq('commission_wallet_id', wallet.id)
            .order('created_at', { ascending: false })
        if (typeFilter && typeFilter !== 'all') q = q.eq('type', typeFilter)
        if (fromDate && toDate) {
            q = q.gte('created_at', fromDate.toISOString()).lte('created_at', toDate.toISOString())
        } else {
            q = q.limit(200)
        }
        const { data } = await q
        transactions = data || []
    }

    // Enrich sub-agent-margin transactions with the actual item sold (network + bundle size,
    // or "AFA Registration", or the results-checker type) — never a phone number or any other
    // beneficiary-identifying field (lib/commission-order-detail.ts is the single place that
    // decides what's safe to select from each order table).
    const txRefs = transactions
        .filter((t) => t.order_reference && t.order_table)
        .map((t) => ({ orderTable: t.order_table as CommissionOrderTable, orderReference: t.order_reference as string }))
    if (txRefs.length > 0) {
        const detailMap = await resolveOrderDetails(admin, txRefs)
        transactions = transactions.map((t) => {
            if (!t.order_reference || !t.order_table) return t
            const found = detailMap.get(`${t.order_table}:${t.order_reference}`)
            return found ? { ...t, item_detail: found.detail } : t
        })
    }

    // Sub-agent earnings not yet credited to this recruiter — pending (order hasn't completed
    // yet, or completed via a path that never reaches 'completed') or reversed (was credited,
    // then the underlying order got refunded/reversed after the fact). recordPendingSubAgentEarning
    // (lib/sub-agent-earnings.ts) writes the pending row at ORDER CREATION time, before the sale's
    // outcome is known — so this list is a real, live "what hasn't paid out yet" view, not a guess.
    let subAgentPending: any[] = []
    const { data: pendingEarnings } = await (supabase.from('sub_agent_order_earnings') as any)
        .select('id, order_reference, order_table, amount, status, created_at, reversed_at')
        .eq('recruiter_id', user.id)
        .neq('status', 'credited')
        .order('created_at', { ascending: false })
        .limit(50)
    if (pendingEarnings && pendingEarnings.length > 0) {
        const earningRefs = pendingEarnings.map((e: any) => ({
            orderTable: e.order_table as CommissionOrderTable,
            orderReference: e.order_reference as string,
        }))
        const detailMap = await resolveOrderDetails(admin, earningRefs)
        subAgentPending = pendingEarnings.map((e: any) => {
            const found = detailMap.get(`${e.order_table}:${e.order_reference}`)
            return {
                id: e.id,
                amount: e.amount,
                created_at: e.created_at,
                item_detail: found?.detail ?? null,
                // earning_status: 'pending' (order not yet completed) or 'reversed' (was credited,
                // later reversed). order_status: the underlying order's own live status column,
                // when resolvable — gives the UI the pending/processing/failed distinction the
                // earning row alone can't (a dead-on-arrival failed order stays 'pending' forever
                // on the earning side, since the trigger only fires on completion).
                earning_status: e.status,
                order_status: e.status === 'reversed' ? 'refunded' : (found?.orderStatus ?? 'pending'),
            }
        })
    }

    // Resolve sub-agent names for sub_agent_margin / sub_agent_margin_reversal rows so the
    // recruiter's history can show "Ama Owusu's Order" instead of a generic label. Name only —
    // never email/phone/wallet data (lib/commission-subagent-names.ts).
    const enrichedTransactions = await attachSubAgentNames(supabase, transactions)

    const pendingOrders = [
        ...(pendingUtilityOrders || []).map((o: any) => ({
            ...o,
            product: 'utility' as const,
            commission_share_percent_estimate: commissionSharePercent,
        })),
        ...(pendingAirtimeOrders || []).map((o: any) => ({
            id: o.id,
            network: o.network,
            amount: o.airtime_amount,
            status: o.status,
            created_at: o.created_at,
            product: 'airtime' as const,
            commission_share_percent_estimate: commissionSharePercent,
        })),
    ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

    return NextResponse.json({
        success: true,
        data: {
            transactions: enrichedTransactions,
            pending_orders: pendingOrders,
            sub_agent_pending: subAgentPending,
        },
    })
}
