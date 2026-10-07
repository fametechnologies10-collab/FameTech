import { NextRequest, NextResponse } from 'next/server'
import { validateAdminAccess } from '@/lib/auth-utils'
import { createServerClient } from '@/lib/supabase'

export interface PendingRow {
  reference: string
  source: 'main' | 'shop' | 'results_checker'
  status: string
  amount: number
  customer: string
  createdAt: string
  orderId?: string
}

const PER_SOURCE_LIMIT = 100

export async function GET(request: NextRequest) {
  const access = await validateAdminAccess(false)
  if (access.error || !access.user) return NextResponse.json({ success: false, error: access.error }, { status: access.status })

  const { searchParams } = new URL(request.url)
  const source = (searchParams.get('source') || 'all') as 'all' | 'main' | 'shop' | 'results_checker'
  const q = (searchParams.get('q') || '').trim().toLowerCase()
  // Service-role client: RLS-bypassed intentionally — admin-only aggregate view across all users.
  const db = createServerClient() as any
  const rows: PendingRow[] = []

  if (source === 'all' || source === 'main') {
    const { data, error } = await db
      .from('wallet_payments')
      .select('reference, status, total_amount, created_at, users(phone_number, email)')
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(PER_SOURCE_LIMIT)
    if (error) return NextResponse.json({ success: false, error: 'Failed to load pending payments' }, { status: 500 })
    for (const r of data || []) {
      rows.push({
        reference: r.reference, source: 'main', status: r.status,
        amount: Number(r.total_amount) || 0,
        customer: r.users?.phone_number || r.users?.email || '—',
        createdAt: r.created_at,
      })
    }
  }

  if (source === 'all' || source === 'shop') {
    const { data, error } = await db
      .from('shop_orders')
      .select('id, paystack_reference, status, selling_price, guest_phone, created_at')
      .in('status', ['pending', 'processing'])
      .order('created_at', { ascending: false })
      .limit(PER_SOURCE_LIMIT)
    if (error) return NextResponse.json({ success: false, error: 'Failed to load pending payments' }, { status: 500 })
    for (const r of data || []) {
      rows.push({
        reference: r.paystack_reference, source: 'shop', status: r.status,
        amount: Number(r.selling_price) || 0, customer: r.guest_phone || '—',
        createdAt: r.created_at, orderId: r.id,
      })
    }
  }

  if (source === 'all' || source === 'results_checker') {
    const { data, error } = await db
      .from('results_checker_orders')
      .select('id, reference_code, status, payment_status, total_paid, customer_phone, customer_email, created_at')
      .eq('status', 'pending')
      .eq('payment_status', 'completed')
      .order('created_at', { ascending: false })
      .limit(PER_SOURCE_LIMIT)
    if (error) return NextResponse.json({ success: false, error: 'Failed to load pending payments' }, { status: 500 })
    for (const r of data || []) {
      rows.push({
        reference: r.reference_code, source: 'results_checker', status: r.status,
        amount: Number(r.total_paid) || 0,
        customer: r.customer_phone || r.customer_email || '—',
        createdAt: r.created_at, orderId: r.id,
      })
    }
  }

  let result = rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  // NOTE: search is scoped to the rows fetched above (100 most-recent per source).
  // To resolve a specific reference a customer provides, use the reference-lookup bar,
  // which verifies any reference against Paystack directly (settled or not).
  if (q) {
    result = result.filter(r =>
      (r.reference || '').toLowerCase().includes(q) ||
      (r.customer || '').toLowerCase().includes(q),
    )
  }

  return NextResponse.json({ success: true, data: result })
}
