import { NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'

// GET — everything the SMS page needs in one call.
export async function GET() {
    try {
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const adminDb = createServerClient()

        const { data: shop } = await supabase
            .from('shop_profiles')
            .select('id, shop_name, shop_slug, owner_phone, whatsapp_number, approval_status, sms_order_confirmation_enabled, sms_sender_status')
            .eq('owner_id', user.id)
            .maybeSingle()

        if (!shop) {
            return NextResponse.json({ success: false, error: 'Create your shop first' }, { status: 404 })
        }

        const shopId = (shop as any).id

        const [
            settingsRes,
            activationRes,
            walletRes,
            bundlesRes,
            logsRes,
            usageRes,
            profitWalletRes,
            mainWalletRes,
            adminTemplatesRes,
            shopTemplatesRes,
        ] = await Promise.all([
            supabase.from('shop_global_settings').select('key, value').in('key', [
                'sms_feature_enabled', 'sms_activation_fee',
                'sms_max_recipients_per_send', 'sms_sends_per_hour', 'sms_recipients_per_day',
                'sms_welcome_bonus_credits',
            ]),
            supabase.from('shop_sms_activations')
                .select('id, amount_paid, paid_from, bonus_claimed, bonus_claimed_at, created_at')
                .eq('shop_id', shopId).maybeSingle(),
            supabase.from('shop_sms_wallets').select('credits, total_purchased, total_used').eq('shop_id', shopId).maybeSingle(),
            supabase.from('shop_sms_bundles').select('id, name, credits, price').eq('is_active', true).order('sort_order'),
            supabase.from('shop_sms_logs').select('id, message, recipients_count, segments, credits_used, status, source, created_at, delivered_count, undelivered_count, pending_count')
                .eq('shop_id', shopId).order('created_at', { ascending: false }).limit(20),
            // Usage breakdown by source, over the shop's FULL history — via a
            // Postgres-side aggregate (shop_sms_usage_breakdown RPC) rather
            // than fetching every shop_sms_logs row and reducing in JS, which
            // would grow unbounded with a shop's history (the egress
            // anti-pattern perf/reduce-supabase-egress targeted). The RPC is
            // SECURITY INVOKER, so it must be called on the RLS-aware
            // `supabase` client (not `adminDb`) for the caller's RLS on
            // shop_sms_logs to apply.
            supabase.rpc('shop_sms_usage_breakdown', { p_shop_id: shopId }),
            // profit wallet
            adminDb.from('shop_wallets').select('balance').eq('owner_id', user.id).maybeSingle(),
            // main wallet
            adminDb.from('wallets').select('balance').eq('user_id', user.id).maybeSingle(),
            // global (admin) SMS templates
            supabase.from('sms_templates').select('id, name, body').order('name'),
            // shop-owned templates (table created by migration 20260613)
            supabase.from('shop_sms_templates').select('id, name, body, created_at')
                .eq('shop_id', shopId).order('created_at', { ascending: false }),
        ])

        const settings: Record<string, string> = {}
        for (const row of ((settingsRes.data as any[]) || [])) settings[row.key] = String(row.value)

        const bonusCreditCount = parseInt(settings['sms_welcome_bonus_credits'] || '10', 10)
        const activationData = activationRes.data as any

        // Usage breakdown by source, over the shop's FULL history. The RPC
        // only returns rows for sources that actually occurred, so missing
        // sources default to 0 here; `credits` comes back as Postgres
        // `bigint`, which supabase-js can surface as a string, so coerce
        // with Number(...) to keep the JSON response numeric.
        const usageBreakdown = { manual: 0, auto_confirmation: 0, reconciliation: 0, total: 0 }
        for (const row of ((usageRes.data as { source: string; credits: number | string }[]) || [])) {
            const used = Number(row.credits) || 0
            if (row.source === 'manual' || row.source === 'auto_confirmation' || row.source === 'reconciliation') {
                usageBreakdown[row.source] += used
            }
            usageBreakdown.total += used
        }

        return NextResponse.json({
            success: true,
            data: {
                enabled: settings['sms_feature_enabled'] !== 'false',
                activationFee: parseFloat(settings['sms_activation_fee'] || '0'),
                maxRecipientsPerSend: parseInt(settings['sms_max_recipients_per_send'] || '100', 10),
                activated: !!activationData,
                activation: activationData || null,
                bonusClaimed: activationData?.bonus_claimed ?? false,
                bonusCreditCount,
                credits: (walletRes.data as any)?.credits ?? 0,
                totalPurchased: (walletRes.data as any)?.total_purchased ?? 0,
                totalUsed: (walletRes.data as any)?.total_used ?? 0,
                bundles: bundlesRes.data || [],
                recentLogs: logsRes.data || [],
                usageBreakdown,
                // wallet balances for pay-source display
                profitBalance: parseFloat((profitWalletRes.data as any)?.balance ?? '0') || 0,
                mainBalance:   parseFloat((mainWalletRes.data as any)?.balance   ?? '0') || 0,
                // shop identity for quick-insert snippets
                shopName:      (shop as any).shop_name    || '',
                shopSlug:      (shop as any).shop_slug    || '',
                shopPhone:     (shop as any).owner_phone  || null,
                shopWhatsapp:  (shop as any).whatsapp_number || null,
                // Automatic order-confirmation SMS: the owner's own opt-out
                // (shop_profiles.sms_order_confirmation_enabled, DEFAULT true —
                // hence `!== false`, matching lib/shop-order-processor.ts and
                // both USSD fulfillment paths), plus whether an approved sender
                // exists at all. Without an approved sender confirmations are
                // suppressed regardless of the toggle (see
                // resolveShopSenderFromRow in lib/sms-confirmation-sender.ts),
                // so the page needs both to explain the real state. Costs no
                // extra query — shop_profiles is already SELECTed above.
                confirmationsEnabled: (shop as any).sms_order_confirmation_enabled !== false,
                hasApprovedSender:    (shop as any).sms_sender_status === 'approved',
                // templates
                adminTemplates: adminTemplatesRes.data || [],
                shopTemplates:  shopTemplatesRes.data  || [],
            },
        })
    } catch (err) {
        console.error('[ShopSMS] Status error:', err)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}
