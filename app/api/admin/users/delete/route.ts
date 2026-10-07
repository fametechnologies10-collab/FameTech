import { createRouteClient } from '@/lib/supabase-server'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { logAdminAction } from '@/lib/admin-audit'

export async function POST(request: Request) {
    try {
        const { userId } = await request.json()

        if (!userId) {
            return NextResponse.json(
                { error: 'User ID is required' },
                { status: 400 }
            )
        }

        // 1. Verify requester is admin (not sub-admin — deletion is full-admin only)
        const supabase = await createRouteClient()
        const { data: { user: authUser } } = await supabase.auth.getUser()

        if (!authUser) {
            return NextResponse.json(
                { error: 'Unauthorized' },
                { status: 401 }
            )
        }

        const { data: requesterData, error: requesterError } = await supabase
            .from('users')
            .select('role')
            .eq('id', authUser.id)
            .single()

        if (requesterError || requesterData?.role !== 'admin') {
            return NextResponse.json(
                { error: 'Forbidden - Admin access required' },
                { status: 403 }
            )
        }

        // Prevent self-deletion
        if (userId === authUser.id) {
            return NextResponse.json(
                { error: 'Cannot delete your own account' },
                { status: 400 }
            )
        }

        // 2. Perform deletion using service role client
        // This client relies on SUPABASE_SERVICE_ROLE_KEY in .env.local
        const supabaseAdmin = createServerClient()

        console.log(`[Admin Delete] Attempting to delete user ${userId}`)

        // Audit BEFORE deletion — snapshot identity in old_value so the record
        // survives even if target_user_id cascades away with the user.
        const { data: snap } = await (supabaseAdmin.from('users') as any)
            .select('email, first_name, last_name, phone_number, role, status')
            .eq('id', userId).single()

        // Lockout protection: full admin accounts can never be deleted via this route.
        if (snap?.role === 'admin') {
            return NextResponse.json({ error: 'Admin accounts cannot be deleted from here' }, { status: 403 })
        }

        await logAdminAction(supabaseAdmin, {
            adminId: authUser.id,
            action: 'delete',
            targetUserId: userId,
            oldValue: snap || { id: userId },
        })

        // Step A: Delete from public.users first (Database Layer)
        // Although we have ON DELETE CASCADE, explicit delete ensures we know it worked
        // and handles cases where cascade might fail or be missing
        const { error: dbDeleteError } = await supabaseAdmin
            .from('users')
            .delete()
            .eq('id', userId)

        if (dbDeleteError) {
            console.error('[Admin Delete] Database deletion failed:', dbDeleteError)
            return NextResponse.json(
                { error: `Database deletion failed: ${dbDeleteError.message}` },
                { status: 500 }
            )
        } else {
            console.log('[Admin Delete] Database record deleted (or will be cascaded)')
        }

        // Step B: Delete from Auth (Authentication Layer)
        // This invalidates sessions and removes the auth user
        const { error: authDeleteError } = await supabaseAdmin.auth.admin.deleteUser(
            userId
        )

        if (authDeleteError) {
            console.error('[Admin Delete] Auth deletion failed:', authDeleteError)
            // If DB delete worked but Auth failed, we have an inconsistent state
            // But usually, if DB delete worked, Auth delete is less likely to fail unless ID is wrong
            return NextResponse.json(
                { error: `Auth deletion failed: ${authDeleteError.message}` },
                { status: 500 }
            )
        }

        console.log('[Admin Delete] User successfully deleted from Auth and DB')

        return NextResponse.json({ success: true })

    } catch (error: any) {
        console.error('[Admin Delete] Unexpected error:', error)
        return NextResponse.json(
            { error: error.message || 'Internal server error' },
            { status: 500 }
        )
    }
}
