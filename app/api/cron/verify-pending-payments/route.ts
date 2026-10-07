import { NextRequest, NextResponse } from 'next/server'
import { validateCronAuth } from '@/lib/cron-utils'
import { runPendingPaymentCheck } from '@/lib/pending-payment-runner'

export async function GET(request: NextRequest) {
  const authError = validateCronAuth(request)
  if (authError) return authError

  try {
    const result = await runPendingPaymentCheck({
      limit: 20,
      olderThanMinutes: 5,
      concurrency: 5,
      // ageOutHours resolved from admin_settings (default 24)
    })
    // Surface systemic failures as non-200 so the external scheduler (cronjob.org) flags them
    // instead of seeing a perpetual green run with verified:0.
    return NextResponse.json(
      { success: !result.hadSystemicError, ...result },
      { status: result.hadSystemicError ? 500 : 200 },
    )
  } catch (error) {
    console.error('[cron/verify-pending-payments]', error)
    return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 })
  }
}
