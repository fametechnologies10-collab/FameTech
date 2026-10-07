import { NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createAdminClient } from '@/lib/supabase-admin'
import { validateGhanaianPhone } from '@/lib/phone-validation'
import { signRecoveryToken } from '@/lib/phone-recovery'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
    const supabase = await createRouteClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
        return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json().catch(() => null)
    const guess = typeof body?.guess === 'string' ? body.guess : ''
    const validation = validateGhanaianPhone(guess)
    if (!validation.isValid) {
        return NextResponse.json({ success: false, error: 'Enter a valid Ghanaian phone number' }, { status: 400 })
    }

    const admin = createAdminClient()
    const { data: profile } = await (admin.from('users') as any)
        .select('phone_number')
        .eq('id', user.id)
        .single()

    if (!profile?.phone_number) {
        return NextResponse.json({ success: false, error: 'No phone number on file' }, { status: 400 })
    }

    const isCorrect = profile.phone_number === validation.normalizedNumber

    const { data: outcome, error: rpcError } = await admin.rpc('record_phone_recovery_attempt', {
        p_user_id: user.id,
        p_correct: isCorrect,
    })

    if (rpcError) {
        return NextResponse.json({ success: false, error: 'Could not process attempt. Please try again.' }, { status: 500 })
    }

    if (outcome.outcome === 'hard_locked') {
        return NextResponse.json(
            { success: false, error: 'Too many attempts. Please wait an hour and try again, or message an admin for help.', data: { hard_locked: true } },
            { status: 429 }
        )
    }
    if (outcome.outcome === 'locked') {
        return NextResponse.json(
            { success: false, error: 'Too many attempts. Please try again later.', data: { retry_at: outcome.retry_at } },
            { status: 429 }
        )
    }
    if (outcome.outcome === 'wrong') {
        return NextResponse.json(
            { success: false, error: 'That number does not match our records.', data: { attempt_count: outcome.attempt_count } },
            { status: 400 }
        )
    }

    // outcome.outcome === 'ok'
    return NextResponse.json({ success: true, data: { token: signRecoveryToken(user.id) } })
}
