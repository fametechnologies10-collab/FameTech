import { NextRequest, NextResponse } from 'next/server'
import { validateAdminAccess } from '@/lib/auth-utils'
import { createAdminClient } from '@/lib/supabase-admin'
import { logAdminAction } from '@/lib/admin-audit'
import { buildChannelView, type DownSnapshot } from '@/lib/gateway-estimate'
import { fetchGatewaySignals, invalidateGatewayStatusCache } from '@/lib/gateway-status'
import { applyOverride, getOverrideRow, listOverrides, parseOverrideBody } from '@/lib/gateway-overrides'

// Admin-only (NOT sub-admin): this changes what customers are told about each network.
// Admin responses include the free-text reason; the public status API never does.

export async function GET(request: NextRequest) {
    const auth = await validateAdminAccess(false, request)
    if (auth.error) {
        return NextResponse.json({ success: false, error: auth.error }, { status: auth.status })
    }
    try {
        const data = await listOverrides(createAdminClient() as any)
        return NextResponse.json({ success: true, data })
    } catch (error) {
        console.error('[gateway-override] list failed:', error instanceof Error ? error.message : 'unknown')
        return NextResponse.json({ success: false, error: 'Failed to update network status' }, { status: 500 })
    }
}

export async function POST(request: NextRequest) {
    const auth = await validateAdminAccess(false, request)
    if (auth.error || !auth.user) {
        return NextResponse.json({ success: false, error: auth.error || 'Unauthorized' }, { status: auth.status || 401 })
    }

    let body: unknown
    try {
        body = await request.json()
    } catch {
        return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 })
    }
    const parsed = parseOverrideBody(body)
    if (!parsed.ok) {
        return NextResponse.json({ success: false, error: parsed.error }, { status: 400 })
    }
    const { channel, down, reason } = parsed.value
    const adminId = auth.user.id

    try {
        const admin = createAdminClient() as any
        const previous = await getOverrideRow(admin, channel)

        // Fresh live numbers, computed as if the channel were not down so a stale override can't hide them.
        const makeSnapshot = async (): Promise<DownSnapshot | null> => {
            const rows = await fetchGatewaySignals()
            const row = rows.find((r) => r.key === channel)
            const view = buildChannelView(row ? { ...row, is_manually_down: false } : undefined, channel, Date.now())
            return {
                lastSeconds: view.lastDelivery?.seconds ?? null,
                lastPlacedAt: view.lastDelivery?.placedAt ?? null,
                lastDeliveredAt: view.lastDelivery?.deliveredAt ?? null,
            }
        }

        const row = await applyOverride(admin, { channel, down, reason, adminId, makeSnapshot })
        await invalidateGatewayStatusCache()

        await logAdminAction(admin, {
            adminId,
            action: 'gateway_status_override',
            targetUserId: adminId,
            oldValue: { channel, down: previous?.is_manually_down ?? false },
            newValue: { channel, down: row.is_manually_down, hasReason: row.reason !== null },
        })

        return NextResponse.json({ success: true, data: row })
    } catch (error) {
        console.error('[gateway-override] update failed:', error instanceof Error ? error.message : 'unknown')
        return NextResponse.json({ success: false, error: 'Failed to update network status' }, { status: 500 })
    }
}
