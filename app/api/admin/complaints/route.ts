import { createServerClient } from '@/lib/supabase'
import { validateAdminAccess } from '@/lib/auth-utils'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
    try {
        // SEC-021: in-handler authorization (don't rely on middleware alone — a
        // middleware bypass would otherwise expose customer complaint PII).
        // Admin-only: complaints are not under the sub-admin orders allowlist.
        const access = await validateAdminAccess(false, request)
        if (access.error) return NextResponse.json({ error: access.error }, { status: access.status })

        const supabase = createServerClient()

        // Honest window: default 30 days (matches the UI's widest preset), cap 90.
        // The old hard 3-day window silently broke the page's own date filters.
        const url = new URL(request.url)
        const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '30', 10) || 30, 1), 90)

        const { data, error } = await supabase
            .from('complaints')
            .select(`
                *,
                users (first_name, last_name, email),
                orders (reference_code, phone_number, network, size, shop_name, created_at, status, fulfillment_method, download_batch_id)
            `)
            .gte('created_at', new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString())
            .order('created_at', { ascending: false })

        if (error) throw error

        return NextResponse.json(data)
    } catch (error) {
        console.error('Error fetching complaints:', error)
        return NextResponse.json(
            { error: 'Failed to fetch complaints' },
            { status: 500 }
        )
    }
}
