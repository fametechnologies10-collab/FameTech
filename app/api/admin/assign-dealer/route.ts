import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: NextRequest) {
    try {
        const supabaseUserClient = await createRouteClient()
        const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const { data: adminData } = await supabaseUserClient
            .from('users')
            .select('role')
            .eq('id', authUser.id)
            .single()

        if (adminData?.role !== 'admin') {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }

        const { userId } = await request.json()
        if (!userId) {
            return NextResponse.json({ error: 'userId is required' }, { status: 400 })
        }
        if (!UUID_RE.test(userId)) {
            return NextResponse.json({ error: 'Invalid userId' }, { status: 400 })
        }

        const supabase = createServerClient()

        // Validate target user is a lifetime agent
        const { data: targetUser, error: fetchError } = await (supabase as any)
            .from('users')
            .select('id, role, agent_expires_at, dealer_expires_at')
            .eq('id', userId)
            .single()

        if (fetchError || !targetUser) {
            return NextResponse.json({ error: 'User not found' }, { status: 404 })
        }

        if (targetUser.role !== 'agent' || targetUser.agent_expires_at !== null) {
            return NextResponse.json(
                { error: 'Only Lifetime Agents (role=agent, no expiry) can be upgraded to Dealer' },
                { status: 422 }
            )
        }

        // Assign dealer role for 6 months
        const expiresAt = new Date()
        expiresAt.setMonth(expiresAt.getMonth() + 6)

        const { error: updateError } = await (supabase as any)
            .from('users')
            .update({
                role: 'dealer',
                dealer_expires_at: expiresAt.toISOString(),
            })
            .eq('id', userId)

        if (updateError) throw new Error(updateError.message)

        // Audit log (non-blocking — requires admin_audit_log table from migration)
        ;(supabase as any).from('admin_audit_log').insert({
            admin_id: authUser.id,
            action: 'assign_dealer',
            target_user_id: userId,
            old_value: { role: targetUser.role, dealer_expires_at: targetUser.dealer_expires_at },
            new_value: { role: 'dealer', dealer_expires_at: expiresAt.toISOString() },
        }).then(() => {}).catch((e: any) => console.error('[AuditLog] assign_dealer insert failed:', e))

        return NextResponse.json({
            success: true,
            message: 'Dealer status updated successfully',
            expiresAt: expiresAt.toISOString(),
        })
    } catch (error: any) {
        console.error('[AssignDealer]', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
