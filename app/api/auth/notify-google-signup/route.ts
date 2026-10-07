import { createServerClient } from '@supabase/ssr'
import { createServerClient as createAdminClient } from '@/lib/supabase'
import { sendAdminPushNotification } from '@/lib/push-service'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'

export async function POST() {
    const cookieStore = await cookies()

    // Verify the caller has a valid session
    const authClient = createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
            cookies: {
                getAll() { return cookieStore.getAll() },
                setAll() { /* read-only */ },
            },
        }
    )
    const { data: { user } } = await authClient.auth.getUser()
    if (!user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const admin = createAdminClient()
    const { data: profile } = await (admin.from('users') as any)
        .select('first_name, last_name, phone_number, phone_verified')
        .eq('id', user.id)
        .single()

    if (!profile) {
        return NextResponse.json({ error: 'Profile not found' }, { status: 404 })
    }

    const name = [profile.first_name, profile.last_name].filter(Boolean).join(' ') || user.email
    const phone = profile.phone_number ?? 'N/A'
    const phoneStatus = profile.phone_verified ? 'verified' : 'not verified'

    await sendAdminPushNotification({
        title: 'New Google Sign-Up',
        body: `${name} (${phone}) registered via Google — phone ${phoneStatus}.`,
        url: '/admin/users',
    }).catch(e => console.error('[notify-google-signup] Push failed:', e))

    return NextResponse.json({ success: true })
}
