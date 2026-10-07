import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createAdminClient } from '@/lib/supabase-admin'

// PATCH /api/passkeys/[id] — rename a passkey
export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const supabase = await createRouteClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { id } = await params
    const { friendly_name } = await req.json()

    if (!friendly_name?.trim() || friendly_name.trim().length > 50) {
        return NextResponse.json({ error: 'Name must be 1–50 characters.' }, { status: 400 })
    }

    const admin = createAdminClient()
    const { error } = await (admin as any)
        .from('passkey_credentials')
        .update({ friendly_name: friendly_name.trim() })
        .eq('id', id)
        .eq('user_id', user.id)

    if (error) return NextResponse.json({ error: 'Failed to rename passkey.' }, { status: 500 })
    return NextResponse.json({ success: true })
}

// DELETE /api/passkeys/[id] — remove a passkey
export async function DELETE(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const supabase = await createRouteClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { id } = await params
    const admin = createAdminClient()

    // Count remaining passkeys for safety check
    const { count } = await (admin as any)
        .from('passkey_credentials')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)

    // Fetch Supabase auth identities to determine other auth methods
    const { data: authUser } = await admin.auth.admin.getUserById(user.id)
    const identities = authUser?.user?.identities ?? []
    const hasGoogle = identities.some((i: any) => i.provider === 'google')
    // Email/password users always have an 'email' identity — Supabase never sets
    // a has_password flag automatically, so checking metadata is always false.
    const hasPassword = identities.some((i: any) => i.provider === 'email')

    const hasOtherAuthMethod = hasGoogle || hasPassword

    if ((count ?? 0) <= 1 && !hasOtherAuthMethod) {
        return NextResponse.json(
            { error: 'Cannot delete your only sign-in method. Set a password first.' },
            { status: 400 }
        )
    }

    const { error } = await (admin as any)
        .from('passkey_credentials')
        .delete()
        .eq('id', id)
        .eq('user_id', user.id)

    if (error) return NextResponse.json({ error: 'Failed to delete passkey.' }, { status: 500 })
    return NextResponse.json({ success: true })
}
