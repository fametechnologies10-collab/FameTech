import { NextRequest, NextResponse } from 'next/server'
import { validateCronAuth } from '@/lib/cron-utils'
import { reconcileAgentPortalDeliveries } from '@/lib/agentportal-reconcile'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: NextRequest) {
    const authError = validateCronAuth(request)
    if (authError) return authError

    try {
        const result = await reconcileAgentPortalDeliveries()
        return NextResponse.json({ success: true, ...result })
    } catch (error: any) {
        console.error('[cron/sync-agentportal-status]', error)
        return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 })
    }
}
