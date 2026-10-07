import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { cookies } from 'next/headers'
import { z } from 'zod'
import { Database } from '@/types/supabase'
import { createServerAnonClient, createServerClient } from '@/lib/supabase'
import { currentPasswordSchema, passwordSchema } from '@/lib/validation'
import { hasTrustedRequestOrigin } from '@/lib/site-url'

const changePasswordSchema = z.object({
    currentPassword: currentPasswordSchema.min(1, 'Current password is required'),
    newPassword: passwordSchema,
    confirmPassword: currentPasswordSchema.min(1, 'Please confirm your new password'),
})

export async function POST(request: NextRequest) {
    try {
        if (!hasTrustedRequestOrigin(request)) {
            return NextResponse.json(
                { error: 'Invalid request origin', code: 'INVALID_ORIGIN' },
                { status: 403 }
            )
        }

        const contentType = request.headers.get('content-type') || ''
        if (!contentType.includes('application/json')) {
            return NextResponse.json(
                { error: 'Content-Type must be application/json', code: 'INVALID_CONTENT_TYPE' },
                { status: 415 }
            )
        }

        const cookieStore = await cookies()
        const supabase = await createRouteClient()

        const { data: { user: authUser }, error: authError } = await supabase.auth.getUser()

        if (authError || !authUser?.email) {
            return NextResponse.json(
                { error: 'Unauthorized', code: 'UNAUTHORIZED' },
                { status: 401 }
            )
        }

        const body = await request.json()
        const validation = changePasswordSchema.safeParse(body)

        if (!validation.success) {
            const message = validation.error.errors[0]?.message || 'Invalid password change request'
            return NextResponse.json(
                { error: message, code: 'VALIDATION_ERROR' },
                { status: 400 }
            )
        }

        const { currentPassword, newPassword, confirmPassword } = validation.data

        if (newPassword !== confirmPassword) {
            return NextResponse.json(
                { error: 'Passwords do not match', code: 'PASSWORD_MISMATCH' },
                { status: 400 }
            )
        }

        if (currentPassword === newPassword) {
            return NextResponse.json(
                { error: 'New password must be different from your current password', code: 'SAME_PASSWORD' },
                { status: 400 }
            )
        }

        const tempClient = createServerAnonClient()

        const { error: signInError } = await tempClient.auth.signInWithPassword({
            email: authUser.email,
            password: currentPassword,
        })

        if (signInError) {
            return NextResponse.json(
                { error: 'Current password is incorrect', code: 'WRONG_CURRENT_PASSWORD' },
                { status: 401 }
            )
        }

        // Dispose temp session immediately — verification is complete.
        await tempClient.auth.signOut({ scope: 'local' })

        // Use admin API to perform the actual update.
        // Safe: authUser.id is cryptographically verified via getUser() above,
        // and current password ownership was confirmed by signInWithPassword succeeding.
        // This bypasses Supabase v2.91+ AAL reauthentication requirement on updateUser().
        const adminClient = createServerClient()
        const { error: updateError } = await adminClient.auth.admin.updateUserById(
            authUser.id,
            { password: newPassword }
        )

        if (updateError) {
            const errorCode = (updateError as any)?.code || 'PASSWORD_UPDATE_FAILED'

            return NextResponse.json(
                { error: updateError.message || 'Failed to change password', code: errorCode },
                { status: 400 }
            )
        }

        try {
            const { clearMustChangePasswordIfSubAgent } = await import('@/lib/sub-agent-account')
            await clearMustChangePasswordIfSubAgent(adminClient, authUser.id)
        } catch (clearFlagError) {
            console.error('[ChangePassword] clearMustChangePasswordIfSubAgent error:', clearFlagError)
        }

        try {
            await supabase.auth.signOut({ scope: 'global' })
        } catch (signOutError) {
            console.error('[ChangePassword] Global sign-out error:', signOutError)
        }

        return NextResponse.json({
            success: true,
            message: 'Password changed successfully',
            reauthRequired: true,
        })
    } catch (error) {
        console.error('[ChangePassword] Unexpected error:', error)
        return NextResponse.json(
            { error: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' },
            { status: 500 }
        )
    }
}
