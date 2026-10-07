import { NextRequest, NextResponse } from 'next/server'
import { validateCronAuth } from '@/lib/cron-utils'
import { alertStaleBundlePortalOrders } from '@/lib/bundleportal-stale-alert'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function GET(request: NextRequest) {
    const authError = validateCronAuth(request)
    if (authError) return authError

    try {
        const result = await alertStaleBundlePortalOrders()
        return NextResponse.json({ success: true, ...result })
    } catch (error: any) {
        console.error('[cron/alert-bundleportal-stuck]', error)
        return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 })
    }
}
