import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { validateAdminAccess } from '@/lib/auth-utils'
import { consumeRateLimit } from '@/lib/simple-rate-limit'

export async function GET(request: NextRequest) {
    try {
        const authResult = await validateAdminAccess(false, request)
        if (authResult.error) {
            return NextResponse.json({ error: authResult.error }, { status: authResult.status })
        }

        const { searchParams } = new URL(request.url)
        const search = searchParams.get('search')?.trim() || null
        const role = searchParams.get('role') || 'all'
        const status = searchParams.get('status') || 'all'
        const phoneVerified = searchParams.get('phoneVerified') || 'all'
        // "all=true" pulls the entire matching set (for export). Otherwise paginate.
        const wantAll = searchParams.get('all') === 'true'
        if (wantAll) {
            // Full-dataset exports are heavy — cap them per admin.
            const rl = consumeRateLimit(`admin-users-export:${(authResult as any).user?.id}`, 5, 10 * 60_000)
            if (!rl.allowed) {
                return NextResponse.json({ error: 'Too many exports — please wait a few minutes.' }, { status: 429 })
            }
        }
        const limit = wantAll ? 100000 : parseInt(searchParams.get('limit') || '50')
        const offset = wantAll ? 0 : parseInt(searchParams.get('offset') || '0')

        // Service role client to bypass RLS (admin already verified above).
        const supabase = createServerClient()

        // Dynamic search RPC: phone (space/233/0-insensitive) + name-token matching,
        // role + status/expiry segments, wallet balance, and a windowed total_count.
        const { data, error } = await (supabase as any).rpc('admin_search_users', {
            p_term: search,
            p_role: role,
            p_status: status,
            p_limit: limit,
            p_offset: offset,
            p_phone_verified: phoneVerified,
        })

        if (error) {
            console.error('[AdminUsersFetch] RPC error:', error)
            throw new Error(`Database query failed: ${error.message}`)
        }

        const rows = (data || []) as any[]
        const totalCount = rows.length > 0 ? Number(rows[0].total_count) : 0

        // Present each row with a nested wallets shape (back-compat) + flat balance.
        const users = rows.map((r) => ({
            ...r,
            wallets: { balance: r.wallet_balance ?? 0 },
        }))

        return NextResponse.json({ users, totalCount })
    } catch (error: any) {
        console.error('Admin Users Fetch Error:', error)
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
    }
}
