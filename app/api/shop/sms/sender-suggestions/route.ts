import { NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { consumeRateLimit } from '@/lib/simple-rate-limit'
import { generateSenderSuggestions } from '@/lib/shop-sender-suggestions'

// GET — deterministic sender-ID suggestions derived from the caller's shop name.
// Read-only, no DB writes; the same charset/blocklist/collision rules the
// approval path enforces are applied here so a suggestion can never later be
// rejected. See lib/shop-sender-suggestions.ts for the algorithm.
export async function GET() {
    try {
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const rl = consumeRateLimit(`sms-sender-suggestions:${user.id}`, 30, 60 * 1000)
        if (!rl.allowed) {
            return NextResponse.json({ success: false, error: 'Too many requests. Try again later.' }, { status: 429 })
        }

        const adminDb = createServerClient()
        const { data: shop } = await adminDb
            .from('shop_profiles')
            .select('id, shop_name')
            .eq('owner_id', user.id)
            .maybeSingle()
        if (!shop) return NextResponse.json({ success: false, error: 'Create your shop first' }, { status: 404 })
        const s: any = shop

        // Collision set: the shop's own live rows plus every OTHER shop's approved
        // sender — same cross-tenant uniqueness scope the admin approval path
        // checks, so a suggested chip can't be one that would be rejected on review.
        const [ownRes, otherRes] = await Promise.all([
            (adminDb as any).from('shop_sender_ids').select('sender_text').eq('shop_id', s.id).in('status', ['under_review', 'approved']),
            (adminDb as any).from('shop_sender_ids').select('sender_text').eq('status', 'approved').neq('shop_id', s.id),
        ])
        const existing = [
            ...(((ownRes.data as any[]) || []).map((r: any) => r.sender_text)),
            ...(((otherRes.data as any[]) || []).map((r: any) => r.sender_text)),
        ]

        const suggestions = generateSenderSuggestions(s.shop_name || '', { existing })
        return NextResponse.json({ success: true, data: { suggestions } })
    } catch (err) {
        console.error('[ShopSMS SenderSuggestions] GET error:', err)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}
