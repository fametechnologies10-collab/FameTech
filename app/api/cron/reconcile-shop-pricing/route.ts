import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { validateCronAuth } from '@/lib/cron-utils'
import { sendAdminPushNotification } from '@/lib/push-service'

const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
)

// R-2 safety net (spec §16). Reprice on role change is non-blocking everywhere, so a
// silent failure could leave a shop selling at/below cost — or a Lead's wholesale
// sub_price below their own cost. This cron surfaces any such drifted rows so a human
// can reconcile. It does NOT auto-fix (auto-bumping prices without owner consent is a
// worse failure mode than a visible alert). Recommended cadence: daily on cron-job.org.
export async function GET(request: Request) {
    const authError = validateCronAuth(request)
    if (authError) return authError

    try {
        const { data: drifted, error } = await (supabaseAdmin as any).rpc('find_drifted_shop_pricing')

        if (error) {
            console.error('[ReconcileShopPricing] RPC error:', error)
            return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
        }

        const count = drifted?.length ?? 0
        if (count > 0) {
            // Loud log for the operator; the payload is small (one row per drifted price).
            console.error(`[ReconcileShopPricing] 🚨 ${count} shop_pricing row(s) drifted underwater — manual reconcile needed:`, drifted)
            // A log line alone went unseen; page admins. The USSD and storefront charge
            // paths already refuse to sell these rows, so this is a fix-the-price prompt.
            const shops = new Set((drifted as any[]).map((r: any) => r.shop_id)).size
            await sendAdminPushNotification({
                title: 'Shop prices at or below cost',
                body: `${count} price row(s) across ${shops} shop(s) are at or below the owner's cost. Those bundles are blocked at checkout until repriced.`,
            }).catch((e: any) => console.error('[ReconcileShopPricing] admin push failed:', e))
        }

        return NextResponse.json({ success: true, drifted: count, rows: drifted ?? [] })
    } catch (error: any) {
        console.error('[ReconcileShopPricing]', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
