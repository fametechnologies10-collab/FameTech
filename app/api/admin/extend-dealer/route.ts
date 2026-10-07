import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// POST { userId, days, action } — action='expire' to expire now (cron downgrades role within 6h), else extend/reduce by days
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

        const { userId, days, action } = await request.json()
        if (!userId) {
            return NextResponse.json({ error: 'userId is required' }, { status: 400 })
        }
        if (!UUID_RE.test(userId)) {
            return NextResponse.json({ error: 'Invalid userId' }, { status: 400 })
        }
        if (action !== undefined && !['expire', 'extend', 'reduce'].includes(action)) {
            return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
        }

        const supabase = createServerClient()

        const { data: targetUser, error: fetchError } = await (supabase as any)
            .from('users')
            .select('id, role, dealer_expires_at')
            .eq('id', userId)
            .single()

        if (fetchError || !targetUser) {
            return NextResponse.json({ error: 'User not found' }, { status: 404 })
        }

        if (targetUser.role !== 'dealer') {
            return NextResponse.json({ error: 'User is not a Dealer' }, { status: 422 })
        }

        // Expire: set dealer_expires_at to now; cron auto-downgrades role within 6h
        if (action === 'expire') {
            const expiredAt = new Date().toISOString()
            const { error: expireError } = await (supabase as any)
                .from('users')
                .update({ dealer_expires_at: expiredAt })
                .eq('id', userId)

            if (expireError) throw new Error(expireError.message)

            ;(supabase as any).from('admin_audit_log').insert({
                admin_id: authUser.id,
                action: 'expire_dealer',
                target_user_id: userId,
                old_value: { role: targetUser.role, dealer_expires_at: targetUser.dealer_expires_at },
                new_value: { dealer_expires_at: expiredAt },
            }).then(() => {}).catch((e: any) => console.error('[AuditLog] expire_dealer insert failed:', e))

            return NextResponse.json({
                success: true,
                message: 'Dealer subscription expired. Role will be downgraded automatically within 6 hours.',
                newExpiry: expiredAt,
            })
        }

        const daysNum = parseInt(days)
        if (isNaN(daysNum) || daysNum === 0 || daysNum < -365 || daysNum > 730) {
            return NextResponse.json({ error: 'Days must be a non-zero value between -365 and 730' }, { status: 400 })
        }

        // Calculate new expiry
        const current = targetUser.dealer_expires_at
            ? new Date((targetUser as any).dealer_expires_at)
            : new Date()
        current.setDate(current.getDate() + daysNum)

        const { error: updateError } = await (supabase as any)
            .from('users')
            .update({ dealer_expires_at: current.toISOString() })
            .eq('id', userId)

        if (updateError) throw new Error(updateError.message)

        ;(supabase as any).from('admin_audit_log').insert({
            admin_id: authUser.id,
            action: daysNum > 0 ? 'extend_dealer' : 'reduce_dealer',
            target_user_id: userId,
            old_value: { dealer_expires_at: targetUser.dealer_expires_at },
            new_value: { dealer_expires_at: current.toISOString(), days_adjusted: daysNum },
        }).then(() => {}).catch((e: any) => console.error('[AuditLog] extend_dealer insert failed:', e))

        const isExpired = current < new Date()

        return NextResponse.json({
            success: true,
            newExpiry: current.toISOString(),
            isExpired,
        })
    } catch (error: any) {
        console.error('[ExtendDealer]', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
