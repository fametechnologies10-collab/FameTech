import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const DURATION_DAYS: Record<string, number | null> = {
    '3d': 3,
    '14d': 14,
    '30d': 30,
    'permanent': null,
}

export async function POST(request: NextRequest) {
    try {
        const supabaseUserClient = await createRouteClient()
        const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()
        if (authError || !authUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const { data: adminData } = await supabaseUserClient
            .from('users')
            .select('role')
            .eq('id', authUser.id)
            .single()
        if (adminData?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

        const { userId, duration } = await request.json()

        if (!userId || !UUID_RE.test(userId)) {
            return NextResponse.json({ error: 'Invalid userId' }, { status: 400 })
        }
        if (!duration || !Object.prototype.hasOwnProperty.call(DURATION_DAYS, duration)) {
            return NextResponse.json({ error: 'Invalid duration. Use 3d, 14d, 30d, or permanent' }, { status: 400 })
        }

        const supabase = createServerClient()
        const { data: targetUser, error: fetchError } = await (supabase as any)
            .from('users')
            .select('id, role, agent_expires_at, dealer_expires_at')
            .eq('id', userId)
            .single()

        if (fetchError || !targetUser) return NextResponse.json({ error: 'User not found' }, { status: 404 })
        if (targetUser.role === 'admin') return NextResponse.json({ error: 'Cannot modify admin users' }, { status: 422 })

        const days = DURATION_DAYS[duration]
        let agentExpiresAt: string | null = null
        if (days !== null) {
            const exp = new Date()
            exp.setDate(exp.getDate() + days)
            agentExpiresAt = exp.toISOString()
        }

        const { error: updateError } = await (supabase as any)
            .from('users')
            .update({
                role: 'agent',
                agent_expires_at: agentExpiresAt,
                dealer_expires_at: null,
            })
            .eq('id', userId)

        if (updateError) throw new Error(updateError.message)

        ;(supabase as any).from('admin_audit_log').insert({
            admin_id: authUser.id,
            action: 'assign_agent',
            target_user_id: userId,
            old_value: { role: targetUser.role, agent_expires_at: targetUser.agent_expires_at },
            new_value: { role: 'agent', agent_expires_at: agentExpiresAt },
        }).then(() => {}).catch((e: any) => console.error('[AuditLog] assign_agent failed:', e))

        return NextResponse.json({ success: true, agentExpiresAt })
    } catch (error: any) {
        console.error('[AssignAgent]', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
