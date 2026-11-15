import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { validateAdminAccess } from '@/lib/auth-utils'
import { syncKingflexyProcessingOrders } from '@/lib/kingflexy-sync'

export const maxDuration = 60

/**
 * Admin-triggered twin of app/api/cron/sync-kingflexy-status/route.ts. Both are thin wrappers
 * over syncKingflexyProcessingOrders (checklist item 23) — no logic of its own here.
 */
export async function POST(request: NextRequest) {
    const authResult = await validateAdminAccess(true, request)
    if (authResult.error) {
        return NextResponse.json({ error: authResult.error }, { status: authResult.status })
    }

    const { checked, updated, failed, errors } = await syncKingflexyProcessingOrders(createServerClient())
    return NextResponse.json({ checked, updated, failed, errors })
}
