import { NextRequest, NextResponse } from 'next/server'
import { validateAdminAccess } from '@/lib/auth-utils'
import { reconcileAgentPortalDeliveries } from '@/lib/agentportal-reconcile'

export async function POST(request: NextRequest) {
    const authResult = await validateAdminAccess(true, request)
    if (authResult.error) {
        return NextResponse.json({ error: authResult.error }, { status: authResult.status })
    }

    try {
        const result = await reconcileAgentPortalDeliveries()
        // Response shape matches the other sync-* routes (checked/updated/failed) so the
        // admin UI's existing generic handler pattern works unchanged. `updated` now reflects
        // orders actually resolved (completed/failed) via polling AgentPortal's items
        // endpoint — not the (separate, secondary) webhook-delivery resend count.
        return NextResponse.json({
            checked: result.checked,
            updated: result.resolved,
            failed: result.stillStuck,
            errors: result.errors,
        })
    } catch (err: any) {
        return NextResponse.json({ error: err.message || 'Reconciliation failed' }, { status: 500 })
    }
}
