import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { cookies } from 'next/headers'
import { getPasswordRecoveryUrl } from '@/lib/site-url'

export async function POST(request: NextRequest) {
    try {
        const cookieStore = await cookies()
        const supabaseUserClient = await createRouteClient()
        const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        // Only admin and sub-admin can reset other users' passwords
        const { data: callerData } = await supabaseUserClient
            .from('users')
            .select('role')
            .eq('id', authUser.id)
            .single()

        // SEC-023: password resets (account-recovery → takeover vector) are admin-only.
        if (!callerData || callerData.role !== 'admin') {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }

        const body = await request.json()
        const { userId } = body

        if (!userId) {
            return NextResponse.json({ error: 'userId is required' }, { status: 400 })
        }

        // Use the service role client to look up the target user's email
        const supabase = createServerClient()

        const { data: targetUser, error: userLookupError } = await (supabase
            .from('users') as any)
            .select('email, first_name, last_name')
            .eq('id', userId)
            .single()

        if (userLookupError || !targetUser) {
            console.error('[AdminResetPassword] User lookup error:', userLookupError)
            return NextResponse.json({ error: 'User not found' }, { status: 404 })
        }

        if (!targetUser.email) {
            return NextResponse.json({ error: 'Target user has no email address' }, { status: 422 })
        }

        // Trigger the standard Supabase password reset email
        // This sends the user an email with a link pointing to our /auth/update-password page
        const redirectTo = getPasswordRecoveryUrl()

        const { error: resetError } = await supabase.auth.resetPasswordForEmail(
            targetUser.email,
            { redirectTo }
        )

        if (resetError) {
            console.error('[AdminResetPassword] Reset error:', resetError)
            return NextResponse.json({ error: resetError.message || 'Failed to send reset email' }, { status: 500 })
        }

        console.log(`[AdminResetPassword] Reset email sent for user ${userId} (${targetUser.email}) by admin ${authUser.id}`)

        return NextResponse.json({
            success: true,
            message: `Password reset email sent to ${targetUser.email}`
        })
    } catch (error: any) {
        console.error('[AdminResetPassword] Unexpected error:', error)
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
    }
}
