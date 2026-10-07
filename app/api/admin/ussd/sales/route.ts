import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'

// =============================================================================
// GET /api/admin/ussd/sales — actual USSD orders across all three services
//
// Unlike /api/admin/ussd/orders (which reads ussd_pending_orders and only
// captures the MoMo lifecycle), this reads the REAL order tables so both
// MoMo- and wallet-paid USSD orders show up, each with its payment_method.
//
//   data            → orders                  (source IN ussd, ussd_shop)
//   results_checker → results_checker_orders  (source IN ussd, ussd_shop)
//   afa             → afa_orders              (source IN ussd, ussd_shop)
//
// Query params:
//   payment = all | momo | wallet
//   service = all | data | results_checker | afa
//   limit   = up to 200 (default 100, applied per-table then to merged set)
// =============================================================================

const USSD_SOURCES = ['ussd', 'ussd_shop']

type Service = 'data' | 'results_checker' | 'afa'

interface USSDSale {
    id: string
    service: Service
    created_at: string
    customer_phone: string
    description: string
    amount: number
    payment_method: 'momo' | 'wallet'
    status: string
    source: string
    reference_code: string | null
    shop_name: string | null
    registered: boolean
}

async function requireAdmin() {
    const supabaseUser = await createRouteClient()
    const { data: { user }, error } = await supabaseUser.auth.getUser()
    if (error || !user) return null
    const { data: userData } = await supabaseUser.from('users').select('role').eq('id', user.id).single()
    if ((userData as any)?.role !== 'admin') return null
    return user
}

export async function GET(request: NextRequest) {
    const user = await requireAdmin()
    if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const { searchParams } = new URL(request.url)
    const payment = (searchParams.get('payment') ?? 'all').toLowerCase()
    const service = (searchParams.get('service') ?? 'all').toLowerCase()
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '100', 10) || 100, 200)

    const paymentFilter = payment === 'momo' || payment === 'wallet' ? payment : null

    const db = createServerClient() as any
    const wants = (s: Service) => service === 'all' || service === s

    try {
        const tasks: Promise<USSDSale[]>[] = []

        if (wants('data')) {
            tasks.push((async () => {
                let q = db.from('orders')
                    .select('id, phone_number, network, size, price, status, payment_method, source, reference_code, shop_name, user_id, created_at')
                    .in('source', USSD_SOURCES)
                    .order('created_at', { ascending: false })
                    .limit(limit)
                if (paymentFilter) q = q.eq('payment_method', paymentFilter)
                const { data, error } = await q
                if (error) throw error
                return (data ?? []).map((o: any): USSDSale => ({
                    id: o.id,
                    service: 'data',
                    created_at: o.created_at,
                    customer_phone: o.phone_number ?? '—',
                    description: [o.network, o.size].filter(Boolean).join(' ') || 'Data Bundle',
                    amount: Number(o.price ?? 0),
                    payment_method: o.payment_method === 'wallet' ? 'wallet' : 'momo',
                    status: o.status ?? 'pending',
                    source: o.source,
                    reference_code: o.reference_code ?? null,
                    shop_name: o.shop_name ?? null,
                    registered: !!o.user_id,
                }))
            })())
        }

        if (wants('results_checker')) {
            tasks.push((async () => {
                let q = db.from('results_checker_orders')
                    .select('id, customer_phone, type_name, quantity, unit_price, total_paid, status, payment_method, source, reference_code, shop_name, user_id, created_at')
                    .in('source', USSD_SOURCES)
                    .order('created_at', { ascending: false })
                    .limit(limit)
                if (paymentFilter) q = q.eq('payment_method', paymentFilter)
                const { data, error } = await q
                if (error) throw error
                return (data ?? []).map((o: any): USSDSale => ({
                    id: o.id,
                    service: 'results_checker',
                    created_at: o.created_at,
                    customer_phone: o.customer_phone ?? '—',
                    description: `${o.quantity ?? 1}x ${o.type_name ?? 'Results Checker'}`,
                    amount: Number(o.total_paid ?? (Number(o.unit_price ?? 0) * Number(o.quantity ?? 0))),
                    payment_method: o.payment_method === 'wallet' ? 'wallet' : 'momo',
                    status: o.status ?? 'pending',
                    source: o.source,
                    reference_code: o.reference_code ?? null,
                    shop_name: o.shop_name ?? null,
                    registered: !!o.user_id,
                }))
            })())
        }

        if (wants('afa')) {
            tasks.push((async () => {
                let q = db.from('afa_orders')
                    .select('id, phone, full_name, payment_amount, status, payment_method, source, reference_code, user_id, created_at')
                    .in('source', USSD_SOURCES)
                    .order('created_at', { ascending: false })
                    .limit(limit)
                if (paymentFilter) q = q.eq('payment_method', paymentFilter)
                const { data, error } = await q
                if (error) throw error
                return (data ?? []).map((o: any): USSDSale => ({
                    id: o.id,
                    service: 'afa',
                    created_at: o.created_at,
                    customer_phone: o.phone ?? '—',
                    description: o.full_name ? `AFA: ${o.full_name}` : 'AFA Registration',
                    amount: Number(o.payment_amount ?? 0),
                    payment_method: o.payment_method === 'wallet' ? 'wallet' : 'momo',
                    status: o.status ?? 'pending',
                    source: o.source,
                    reference_code: o.reference_code ?? null,
                    shop_name: null,
                    registered: !!o.user_id,
                }))
            })())
        }

        const merged = (await Promise.all(tasks))
            .flat()
            .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
            .slice(0, limit)

        const totalAmount = merged.reduce((sum, s) => sum + s.amount, 0)
        const walletAmount = merged.filter(s => s.payment_method === 'wallet').reduce((sum, s) => sum + s.amount, 0)

        return NextResponse.json({
            sales: merged,
            summary: {
                count: merged.length,
                totalAmount,
                walletAmount,
                momoAmount: totalAmount - walletAmount,
            },
        })
    } catch (err) {
        console.error('[Admin USSD Sales] fetch error:', err)
        return NextResponse.json({ error: 'Failed to fetch USSD sales' }, { status: 500 })
    }
}
