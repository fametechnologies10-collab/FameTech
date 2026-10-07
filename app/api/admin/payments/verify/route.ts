import { NextRequest, NextResponse } from 'next/server'
import { validateAdminAccess } from '@/lib/auth-utils'
import {
  verifyAndProcessReference, isValidReferenceShape, logAdminPaymentAction,
} from '@/lib/payment-reconciliation'

const rl = new Map<string, { count: number; resetAt: number }>()
function allow(adminId: string, limit = 30): boolean {
  const now = Date.now()
  const e = rl.get(adminId) || { count: 0, resetAt: now + 60_000 }
  if (e.resetAt < now) { e.count = 0; e.resetAt = now + 60_000 }
  e.count++; rl.set(adminId, e)
  return e.count <= limit
}

export async function POST(request: NextRequest) {
  const access = await validateAdminAccess(false)
  if (access.error || !access.user) return NextResponse.json({ success: false, error: access.error }, { status: access.status })

  if (!allow(access.user.id)) {
    return NextResponse.json({ success: false, error: 'Too many requests, slow down' }, { status: 429 })
  }

  let reference = ''
  try { reference = String((await request.json())?.reference || '').trim() } catch { /* noop */ }
  if (!isValidReferenceShape(reference)) {
    return NextResponse.json({ success: false, error: 'Invalid reference' }, { status: 400 })
  }

  const result = await verifyAndProcessReference(reference)

  const outcome = result.processed
    ? (result.alreadyProcessed ? 'already_processed' : 'processed')
    : (result.paystackStatus === 'success' ? 'failed' : 'not_paid')
  await logAdminPaymentAction(access.user.id, 'verify',
    { reference, source: result.source, outcome, detail: { paystackStatus: result.paystackStatus, error: result.error } })

  return NextResponse.json({ success: result.ok, data: result, error: result.ok ? undefined : result.error })
}
