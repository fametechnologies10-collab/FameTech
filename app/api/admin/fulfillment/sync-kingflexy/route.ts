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

    let checked = 0, updated = 0, failed = 0
    const errors: string[] = []
    try {
        const r = await syncKingflexyProcessingOrders(createServerClient())
        checked = r.checked; updated = r.updated; failed = r.failed
        errors.push(...r.errors)
    } catch (e: any) {
        console.error('[AdminSyncKingflexy] Fatal:', e?.message || 'unknown')
        errors.push(`Fatal: ${e?.message || 'unknown'}`)
    }
    return NextResponse.json({ checked, updated, failed, errors })
}
