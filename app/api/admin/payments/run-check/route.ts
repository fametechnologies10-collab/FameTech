import { NextRequest, NextResponse } from 'next/server'
import { validateAdminAccess } from '@/lib/auth-utils'
import { runPendingPaymentCheck } from '@/lib/pending-payment-runner'
import { logAdminPaymentAction } from '@/lib/payment-reconciliation'

const rl = new Map<string, { count: number; resetAt: number }>()
function allow(adminId: string, limit = 6): boolean {
  const now = Date.now()
  const e = rl.get(adminId) || { count: 0, resetAt: now + 60_000 }
  if (e.resetAt < now) { e.count = 0; e.resetAt = now + 60_000 }
  e.count++; rl.set(adminId, e)
  return e.count <= limit
}

export async function POST(request: NextRequest) {
  const access = await validateAdminAccess(false)
  if (access.error || !access.user) {
    return NextResponse.json({ success: false, error: access.error }, { status: access.status })
  }
  if (!allow(access.user.id)) {
    return NextResponse.json({ success: false, error: 'Too many runs, wait a minute' }, { status: 429 })
  }

  const result = await runPendingPaymentCheck({ limit: 50, olderThanMinutes: 1, concurrency: 5 })
  await logAdminPaymentAction(access.user.id, 'run_check', {
    outcome: result.hadSystemicError ? 'failed' : 'processed',
    detail: result,
  })
  return NextResponse.json({ success: !result.hadSystemicError, data: result })
}
