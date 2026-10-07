import { NextResponse } from 'next/server'
import { validateCronAuth } from '@/lib/cron-utils'
import { processRefulfillment } from '@/lib/refulfillment-service'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: Request) {
    try {
        const authError = validateCronAuth(request)
        if (authError) {
            return authError
        }

        // Call the shared service for cron refulfillment (isCron: true)
        const result = await processRefulfillment(true)

        return NextResponse.json(result)
    } catch (error: any) {
        console.error('[Cron] Refulfill Pending Orders Error:', error)
        return NextResponse.json(
            { error: error.message || 'Internal server error' },
            { status: 500 }
        )
    }
}
