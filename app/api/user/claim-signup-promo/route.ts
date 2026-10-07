import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'

export async function POST(request: NextRequest) {
    try {
        const supabaseUserClient = await createRouteClient()
        const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const body = await request.json().catch(() => ({}))
        const action: 'claim' | 'skip' = body?.action === 'skip' ? 'skip' : 'claim'

        const supabase = createServerClient()

        // Fetch caller's current profile
        const { data: currentUser, error: fetchError } = await (supabase as any)
            .from('users')
            .select('id, role, signup_promo_shown')
            .eq('id', authUser.id)
            .single()

        if (fetchError || !currentUser) {
            return NextResponse.json({ error: 'User not found' }, { status: 404 })
        }

        if (currentUser.signup_promo_shown === true) {
            return NextResponse.json({ error: 'Promo already dismissed' }, { status: 409 })
        }

        if (currentUser.role !== 'customer') {
            return NextResponse.json({ error: 'Not eligible' }, { status: 422 })
        }

        // Skip: just mark modal as shown, no role change
        if (action === 'skip') {
            await (supabase as any)
                .from('users')
                .update({ signup_promo_shown: true })
                .eq('id', authUser.id)
                .eq('signup_promo_shown', false)
            return NextResponse.json({ success: true, action: 'skipped' })
        }

        // Claim: fetch active promo setting
        const { data: promoSetting } = await (supabase as any)
            .from('admin_settings')
            .select('value')
            .eq('key', 'signup_promo_role')
            .single()

        const promoRole: string | null = promoSetting?.value ?? null

        if (!promoRole || (promoRole !== 'dealer' && promoRole !== 'agent')) {
            return NextResponse.json({ error: 'No active promo' }, { status: 410 })
        }

        // Build role update
        const expiresAt = new Date()
        const updatePayload: Record<string, unknown> = { signup_promo_shown: true }

        if (promoRole === 'dealer') {
            expiresAt.setMonth(expiresAt.getMonth() + 1)
            updatePayload.role = 'dealer'
            updatePayload.dealer_expires_at = expiresAt.toISOString()
        } else {
            expiresAt.setDate(expiresAt.getDate() + 3)
            updatePayload.role = 'agent'
            updatePayload.agent_expires_at = expiresAt.toISOString()
        }

        // Race-condition-safe update: only succeeds if signup_promo_shown is still false
        const { data: updatedRows, error: updateError } = await (supabase as any)
            .from('users')
            .update(updatePayload)
            .eq('id', authUser.id)
            .eq('signup_promo_shown', false)
            .select('id')

        if (updateError) throw new Error(updateError.message)

        if (!updatedRows || updatedRows.length === 0) {
            return NextResponse.json({ error: 'Promo already dismissed' }, { status: 409 })
        }

        // Non-blocking: adjust shop pricing for the new role
        try {
            await (supabase as any).rpc('adjust_shop_pricing_for_role_change', {
                p_user_id: authUser.id,
                p_old_role: 'customer',
                p_new_role: promoRole,
            })
        } catch {
            // intentional no-op — pricing adjustment is non-blocking
        }

        return NextResponse.json({
            success: true,
            grantedRole: promoRole,
            expiresAt: expiresAt.toISOString(),
        })
    } catch (error: any) {
        console.error('[ClaimSignupPromo]', error)
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
    }
}
