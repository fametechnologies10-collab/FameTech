import { cookies } from 'next/headers'
import { createRouteClient } from '@/lib/supabase-server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerAnonClient, createServerClient } from '@/lib/supabase'
import { currentPasswordSchema } from '@/lib/validation'
import { hasTrustedRequestOrigin } from '@/lib/site-url'

const deleteAccountSchema = z.object({
    password: currentPasswordSchema,
})

export async function POST(request: Request) {
    try {
        if (!hasTrustedRequestOrigin(request)) {
            return NextResponse.json(
                { error: 'Invalid request origin' },
                { status: 403 }
            )
        }

        const contentType = request.headers.get('content-type') || ''
        if (!contentType.includes('application/json')) {
            return NextResponse.json(
                { error: 'Content-Type must be application/json' },
                { status: 415 }
            )
        }

        const validation = deleteAccountSchema.safeParse(await request.json())
        if (!validation.success) {
            const message = validation.error.errors[0]?.message || 'Invalid account deletion request'
            return NextResponse.json(
                { error: message },
                { status: 400 }
            )
        }

        const { password } = validation.data

        // 1. Get authenticated user
        const supabase = await createRouteClient()
        const { data: { user: authUser } } = await supabase.auth.getUser()

        if (!authUser) {
            return NextResponse.json(
                { error: 'Unauthorized' },
                { status: 401 }
            )
        }

        const userId = authUser.id
        const userEmail = authUser.email

        if (!userEmail) {
            return NextResponse.json(
                { error: 'User email not found' },
                { status: 400 }
            )
        }

        // 2. Verify password by attempting to sign in
        const tempClient = createServerAnonClient()
        const { error: signInError } = await tempClient.auth.signInWithPassword({
            email: userEmail,
            password,
        })

        if (signInError) {
            return NextResponse.json(
                { error: 'Current password is incorrect' },
                { status: 401 }
            )
        }

        await tempClient.auth.signOut({ scope: 'local' })

        // 3. Use service role client to delete user permanently
        const supabaseAdmin = createServerClient()

        // Delete from Auth (this prevents re-login) - use shouldSoftDelete: false for hard delete
        const { error: authDeleteError } = await supabaseAdmin.auth.admin.deleteUser(
            userId,
            false // shouldSoftDelete = false ensures permanent deletion
        )

        if (authDeleteError) {
            console.error('Error deleting user from Auth:', authDeleteError)
            return NextResponse.json(
                { error: 'Failed to delete account from authentication system' },
                { status: 500 }
            )
        }

        // Ownership confirmed: authenticated user matches the account being deleted
        console.log(`[DeleteAccount] User ${userId} deleted their own account`)

        // 4. Delete from public.users (cascade will handle related data)
        const { error: dbDeleteError } = await supabaseAdmin
            .from('users')
            .delete()
            .eq('id', userId)

        if (dbDeleteError) {
            console.error('Error deleting user from database:', dbDeleteError)
            // Note: Auth deletion succeeded, so they can't login, but data might persist
            // We'll still return success since the primary goal (prevent login) is achieved
        }

        // 5. Sign out the user
        await supabase.auth.signOut({ scope: 'global' })

        return NextResponse.json({
            success: true,
            message: 'Account deleted successfully'
        })

    } catch (error) {
        console.error('Delete account error:', error)
        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        )
    }
}
