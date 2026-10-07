import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { hasTrustedRequestOrigin } from '@/lib/site-url'
import { z } from 'zod'

// Invite join endpoint (spec §9).
//   GET  ?code=... : PUBLIC brand preview for the de-branded /join page. Returns ONLY
//                    the upline Lead's public brand (name/logo/colour) and validity —
//                    never any internal data. Rate-limited (joinRedeem) in middleware.
//   POST { code }  : AUTHENTICATED redeem -> creates a PENDING sub_agents membership
//                    via redeem_sub_invite (all rule checks live in the RPC).

const codeSchema = z.string().min(4).max(40).regex(/^[A-Za-z0-9_-]+$/)

export async function GET(request: NextRequest) {
    try {
        const code = codeSchema.safeParse(new URL(request.url).searchParams.get('code'))
        if (!code.success) return NextResponse.json({ success: true, data: { valid: false } })

        const admin: any = createServerClient()
        const { data: invite } = await (admin.from('shop_invites') as any)
            .select('shop_id, max_uses, used_count, expires_at, revoked_at')
            .eq('code', code.data)
            .maybeSingle()

        const valid = !!invite
            && !invite.revoked_at
            && (!invite.expires_at || new Date(invite.expires_at) > new Date())
            && (invite.max_uses == null || invite.used_count < invite.max_uses)
        if (!valid) return NextResponse.json({ success: true, data: { valid: false } })

        const { data: shop } = await (admin.from('shop_profiles') as any)
            .select('shop_name, logo_url, brand_color')
            .eq('id', invite.shop_id)
            .maybeSingle()

        return NextResponse.json({
            success: true,
            data: { valid: true, shopName: shop?.shop_name ?? 'this shop', logoUrl: shop?.logo_url ?? null, brandColor: shop?.brand_color ?? null },
        })
    } catch (err) {
        console.error('[join GET]', err)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}

export async function POST(request: NextRequest) {
    try {
        if (!hasTrustedRequestOrigin(request)) return NextResponse.json({ success: false, error: 'Invalid request origin' }, { status: 403 })
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ success: false, error: 'Please sign in to continue' }, { status: 401 })

        const body = await request.json().catch(() => ({}))
        const code = codeSchema.safeParse(body?.code)
        if (!code.success) return NextResponse.json({ success: false, error: 'Invalid invite code' }, { status: 400 })

        const admin: any = createServerClient()
        const { data, error } = await (admin as any).rpc('redeem_sub_invite', { p_code: code.data, p_user_id: user.id })
        if (error) return NextResponse.json({ success: false, error: 'Failed to join' }, { status: 500 })

        const res = data as any
        if (!res?.ok) {
            const map: Record<string, [number, string]> = {
                invite_not_found: [404, 'This invite link is not valid'],
                invite_revoked: [410, 'This invite link has been revoked'],
                invite_expired: [410, 'This invite link has expired'],
                invite_exhausted: [410, 'This invite link has reached its limit'],
                already_shop_owner: [409, 'You already run your own shop and cannot join as a sub-agent'],
                cannot_self_recruit: [409, 'You cannot join your own shop'],
            }
            const [status, msg] = map[res?.error] ?? [400, 'Could not join']
            return NextResponse.json({ success: false, error: msg }, { status })
        }
        return NextResponse.json({ success: true, data: { status: res.status, alreadyMember: !!res.already_member } })
    } catch (err) {
        console.error('[join POST]', err)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}
