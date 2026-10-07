import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { cookies } from 'next/headers'
import { getBanks } from '@/lib/moolre-transfer-service'

export async function GET(req: NextRequest) {
    try {
        // Auth check — must be a logged-in agent/shop owner
        const cookieStore = await cookies()
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const { data: dbUser } = await supabase
            .from('users')
            .select('role')
            .eq('id', user.id)
            .single()

        // Any authenticated user who owns a shop can fetch the bank list
        if (!dbUser) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }

        // Fetch bank list (cached in service layer for 1 hour)
        const banks = await getBanks()

        return NextResponse.json({ banks })

    } catch (error: any) {
        console.error('[banks API]', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
