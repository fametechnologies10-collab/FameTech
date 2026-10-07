import { NextRequest, NextResponse } from 'next/server'
import { validateAdminAccess } from '@/lib/auth-utils'
import { createServerClient } from '@/lib/supabase'

function rangeToFrom(range: string | null): string {
  const now = Date.now()
  switch (range) {
    case 'today': { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString() }
    case '7d':  return new Date(now - 7  * 24 * 60 * 60 * 1000).toISOString()
    case '30d': return new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString()
    case 'all':
    default:    return new Date('2000-01-01T00:00:00.000Z').toISOString()
  }
}

export async function GET(request: NextRequest) {
  const access = await validateAdminAccess(false)
  if (access.error || !access.user) return NextResponse.json({ success: false, error: access.error }, { status: access.status })

  const { searchParams } = new URL(request.url)
  const fromTs = rangeToFrom(searchParams.get('range'))

  const db = createServerClient() as any
  const { data, error } = await db.rpc('admin_payment_stats', { from_ts: fromTs })
  if (error) {
    console.error('[admin/payments/stats] RPC error:', error)
    return NextResponse.json({ success: false, error: 'Failed to load stats' }, { status: 500 })
  }
  return NextResponse.json({ success: true, data })
}
