import { NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { consumeRateLimit } from '@/lib/simple-rate-limit'

export async function GET() {
    const supabase = await createRouteClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

    const rl = consumeRateLimit(`sms-api-usage:${user.id}`, 20, 60_000)
    if (!rl.allowed) return NextResponse.json({ success: false, error: 'Too many requests' }, { status: 429 })

    const { data: account } = await (supabase.from('sms_accounts') as any)
        .select('id, mode').eq('user_id', user.id).maybeSingle()
    if (!account || account.mode !== 'business') {
        return NextResponse.json({ success: false, error: 'Usage analytics require business mode' }, { status: 403 })
    }

    const { data: smsKey } = await (supabase.from('api_keys') as any)
        .select('id, last_used_at')
        .eq('user_id', user.id).eq('key_type', 'sms').maybeSingle()

    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000).toISOString()

    let requests30d = 0
    let success30d = 0
    if (smsKey) {
        const { data: logs } = await (supabase.from('api_logs') as any)
            .select('status_code')
            .eq('api_key_id', smsKey.id)
            .gte('created_at', thirtyDaysAgo)
        requests30d = (logs as any[])?.length ?? 0
        success30d = ((logs as any[]) || []).filter(l => l.status_code >= 200 && l.status_code < 300).length
    }

    const { data: campaigns } = await (supabase.from('sms_campaigns') as any)
        .select('source, credits_charged')
        .eq('account_id', account.id)
        .gte('created_at', thirtyDaysAgo)

    const creditsViaApi30d = ((campaigns as any[]) || [])
        .filter(c => c.source === 'api').reduce((s, c) => s + (c.credits_charged || 0), 0)
    const creditsViaDashboard30d = ((campaigns as any[]) || [])
        .filter(c => c.source === 'dashboard').reduce((s, c) => s + (c.credits_charged || 0), 0)

    return NextResponse.json({
        success: true,
        data: {
            requests30d,
            successRate: requests30d > 0 ? Math.round((success30d / requests30d) * 100) : null,
            creditsViaApi30d,
            creditsViaDashboard30d,
            lastUsedAt: smsKey?.last_used_at ?? null,
        },
    })
}
