import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { validateCronAuth } from '@/lib/cron-utils'
import { syncKingflexyProcessingOrders } from '@/lib/kingflexy-sync'

export const maxDuration = 60

/**
 * Safety net for a dropped/never-sent KingFlexy data webhook. Deliberately logic-free: the
 * admin twin (app/api/admin/fulfillment/sync-kingflexy) calls the exact same sweep so the
 * two cannot drift (fametech-fulfillment checklist item 23).
 */
export async function GET(request: NextRequest) {
    const authError = validateCronAuth(request)
    if (authError) return authError

    let checked = 0, updated = 0, failed = 0
    const errors: string[] = []
    try {
        const r = await syncKingflexyProcessingOrders(createServerClient())
        checked = r.checked; updated = r.updated; failed = r.failed
        errors.push(...r.errors)
    } catch (e: any) {
        console.error('[CronSyncKingflexy] Fatal:', e?.message || 'unknown')
        errors.push(`Fatal: ${e?.message || 'unknown'}`)
    }
    console.log(`[CronSyncKingflexy] Done. checked=${checked}, updated=${updated}, failed=${failed}`)
    return NextResponse.json({ success: true, checked, updated, failed, errors })
}
