import { NextRequest, NextResponse } from 'next/server'
import { validateAdminAccess } from '@/lib/auth-utils'
import { createServerClient } from '@/lib/supabase'
import { routeReference, deriveReconState, type DbState, type ReconState } from '@/lib/payment-reconciliation'

const rl = new Map<string, { count: number; resetAt: number }>()
function allow(adminId: string, limit = 10): boolean {
  const now = Date.now()
  const e = rl.get(adminId) || { count: 0, resetAt: now + 60_000 }
  if (e.resetAt < now) { e.count = 0; e.resetAt = now + 60_000 }
  e.count++; rl.set(adminId, e)
  return e.count <= limit
}

interface ReconRow {
  reference: string
  source: 'main' | 'shop' | 'results_checker'
  paystackStatus: string
  amount: number
  customer: string
  channel?: string
  paidAt?: string
  dbState: DbState
  reconState: ReconState
}

async function lookupDbState(db: any, reference: string, source: string): Promise<DbState> {
  if (source === 'shop') {
    const { data } = await db.from('shop_orders').select('status').eq('paystack_reference', reference).maybeSingle()
    if (!data) return 'missing'
    if (data.status === 'failed' || data.status === 'refunded') return 'failed'
    if (data.status === 'completed' || data.status === 'processing') return 'processed'
    return 'pending'
  }
  if (source === 'results_checker') {
    const { data } = await db.from('results_checker_orders').select('status, payment_status').eq('reference_code', reference).maybeSingle()
    if (!data) return 'missing'
    if (data.status === 'failed' || data.status === 'refunded') return 'failed'
    if (data.status === 'completed') return 'processed'
    return 'pending'
  }
  const { data } = await db.from('wallet_payments').select('status').eq('reference', reference).maybeSingle()
  if (!data) return 'missing'
  if (data.status === 'failed') return 'failed'
  if (data.status === 'completed') return 'processed'
  return 'pending'
}

export async function GET(request: NextRequest) {
  const access = await validateAdminAccess(false)
  if (access.error || !access.user) return NextResponse.json({ success: false, error: access.error }, { status: access.status })
  if (!allow(access.user.id)) {
    return NextResponse.json({ success: false, error: 'Too many Paystack pulls, wait a minute' }, { status: 429 })
  }

  const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY
  if (!PAYSTACK_SECRET_KEY) return NextResponse.json({ success: false, error: 'Payment service unavailable' }, { status: 503 })

  const { searchParams } = new URL(request.url)
  const from = (searchParams.get('from') || '').slice(0, 30)
  const to = (searchParams.get('to') || '').slice(0, 30)
  const status = searchParams.get('status') || ''
  const parsedPage = parseInt(searchParams.get('page') || '1', 10)
  const page = Number.isFinite(parsedPage) ? Math.max(1, parsedPage) : 1

  const qs = new URLSearchParams({ perPage: '100', page: String(page) })
  if (from) qs.set('from', from)
  if (to) qs.set('to', to)
  if (status) qs.set('status', status)

  let data: any
  try {
    const res = await fetch(`https://api.paystack.co/transaction?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
    })
    data = await res.json()
  } catch {
    return NextResponse.json({ success: false, error: 'Could not reach Paystack' }, { status: 502 })
  }
  if (!data?.status) {
    return NextResponse.json({ success: false, error: 'Paystack list failed' }, { status: 502 })
  }

  const db = createServerClient() as any
  const txns: any[] = data.data || []
  const rows: ReconRow[] = []
  for (const t of txns) {
    const reference: string = t.reference
    if (!reference) continue
    const { source } = routeReference(reference)
    const dbState = await lookupDbState(db, reference, source)
    rows.push({
      reference, source,
      paystackStatus: t.status,
      amount: typeof t.amount === 'number' ? t.amount / 100 : 0,
      customer: t.customer?.email || t.metadata?.guest_phone || '—',
      channel: t.channel,
      paidAt: t.paid_at || t.paidAt,
      dbState,
      reconState: deriveReconState(t.status, dbState),
    })
  }

  return NextResponse.json({
    success: true,
    data: rows,
    meta: { page, total: data.meta?.total ?? rows.length, pageCount: data.meta?.pageCount },
  })
}
