/**
 * GET /api/cron/sms-status-reconcile — Hubtel delivery-status poller (KFG SMS).
 * Schedule: every 10 minutes on cronjob.org.
 *
 * Hubtel SMS is PULL-based for delivery receipts (confirmed docs 2026-07-07):
 * a send returns a messageId with status 'Sent', and the final DLR verdict is
 * fetched later from GET https://sms.hubtel.com/v1/messages/{messageId}. This
 * cron is therefore the PRIMARY delivery-tracking mechanism (the DLR webhook
 * is a bonus if Hubtel ever pushes callbacks). Endpoint defaults to the
 * documented URL; HUBTEL_SMS_STATUS_URL can override it. Still a no-op if the
 * Hubtel SMS creds are unset. Commission-services rule: NEVER auto-complete on
 * silence — 'Sent'/'Pending' stay pending and are re-polled.
 *
 * Scope guards: only provider='hubtel' rows WITH a provider_message_id, in
 * status='sent', older than 15 minutes, younger than 72 h (after that the
 * carrier verdict is unknowable — rows stay 'sent').
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { validateCronAuth } from '@/lib/cron-utils'
import { dispatchCampaignWebhook } from '@/lib/sms-webhook'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const HUBTEL_STATUS_URL_DEFAULT = 'https://sms.hubtel.com/v1/messages/{id}'

/**
 * Map Hubtel's DLR status vocabulary → our sms_messages statuses.
 * Returns null for NON-TERMINAL states ('Sent'/'Pending') so the row stays
 * 'sent' and is re-polled next cycle. (Hubtel statuses: Delivered, Sent,
 * Pending, Blacklisted, Undeliverable/Failed, Unrouteable/Error, Rejected,
 * NACK/Invalid Destination|Source Address.)
 */
function mapStatus(raw: string): string | null {
    const s = (raw || '').trim().toLowerCase()
    if (!s) return null
    if (s === 'delivered') return 'delivered'
    if (s === 'sent' || s === 'pending') return null            // still in transit — keep polling
    if (s === 'expired') return 'expired'
    // Terminal failures that mean the message will never arrive.
    if (s.includes('undeliver') || s === 'failed' || s.includes('unrouteable') || s === 'error') return 'undelivered'
    // Recipient/telco refusal or malformed address → rejected.
    if (s === 'rejected' || s === 'blacklisted' || s.includes('nack') || s.includes('invalid destination') || s.includes('invalid source')) return 'rejected'
    return null
}

export async function GET(request: NextRequest) {
    const authError = validateCronAuth(request)
    if (authError) return authError

    // Confirmed Hubtel endpoint; env override optional.
    const statusUrl = process.env.HUBTEL_SMS_STATUS_URL || HUBTEL_STATUS_URL_DEFAULT
    const clientId = process.env.HUBTEL_CLIENT_ID
    const clientSecret = process.env.HUBTEL_CLIENT_SECRET

    if (!clientId || !clientSecret) {
        return NextResponse.json({ success: true, data: { skipped: 'Hubtel SMS credentials not configured' } })
    }

    const db = createServerClient() as any
    const fifteenMinAgo = new Date(Date.now() - 15 * 60_000).toISOString()
    const seventyTwoHoursAgo = new Date(Date.now() - 72 * 3600_000).toISOString()

    try {
        const { data: stuck, error } = await db.from('sms_messages')
            .select('id, provider_message_id, campaign_id')
            .eq('provider', 'hubtel')
            .eq('status', 'sent')
            .not('provider_message_id', 'is', null)
            .lt('status_updated_at', fifteenMinAgo)
            .gt('created_at', seventyTwoHoursAgo)
            .order('status_updated_at', { ascending: true })
            .limit(50)
        if (error) throw error

        const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
        let updated = 0
        let unresolved = 0

        for (const m of (stuck as any[]) || []) {
            try {
                const url = statusUrl.replace('{id}', encodeURIComponent(m.provider_message_id))
                const res = await fetch(url, {
                    headers: { Accept: 'application/json', Authorization: `Basic ${basicAuth}` },
                })
                const data: any = await res.json().catch(() => ({}))
                const raw = String(data?.status ?? data?.data?.status ?? data?.deliveryStatus ?? '')
                const mapped = mapStatus(raw)
                if (res.ok && mapped) {
                    const { data: applied } = await db.rpc('apply_sms_delivery_report', {
                        p_provider_message_id: m.provider_message_id,
                        p_status: mapped,
                        p_detail: `reconcile:${raw}`,
                    })
                    if ((applied as any)?.updated) updated++
                } else {
                    unresolved++
                    // Push status_updated_at forward so the scan doesn't
                    // re-poll the same silent rows every run.
                    await db.from('sms_messages')
                        .update({ status_updated_at: new Date().toISOString() })
                        .eq('id', m.id)
                        .eq('status', 'sent')
                }
            } catch {
                unresolved++
            }
        }

        // Second branch: identical stuck-row scan for shop-SMS delivery
        // receipts (Task 5 of the shop-SMS delivery tracking build). Same
        // 15-min/72-hour windows, same Hubtel status endpoint, same mapping
        // function — the two products share nothing else, so this is a
        // parallel loop rather than a merged query.
        const { data: shopStuck, error: shopStuckErr } = await db.from('shop_sms_delivery_receipts')
            .select('id, provider_message_id')
            .eq('status', 'sent')
            .not('provider_message_id', 'is', null)
            .lt('updated_at', fifteenMinAgo)
            .gt('created_at', seventyTwoHoursAgo)
            .order('updated_at', { ascending: true })
            .limit(50)
        if (shopStuckErr) throw shopStuckErr

        let shopUpdated = 0
        let shopUnresolved = 0
        for (const r of (shopStuck as any[]) || []) {
            try {
                const url = statusUrl.replace('{id}', encodeURIComponent(r.provider_message_id))
                const res = await fetch(url, {
                    headers: { Accept: 'application/json', Authorization: `Basic ${basicAuth}` },
                })
                const data: any = await res.json().catch(() => ({}))
                const raw = String(data?.status ?? data?.data?.status ?? data?.deliveryStatus ?? '')
                const mapped = mapStatus(raw)
                if (res.ok && mapped) {
                    const { data: applied } = await db.rpc('apply_shop_sms_delivery_report', {
                        p_provider_message_id: r.provider_message_id,
                        p_status: mapped,
                        p_detail: `reconcile:${raw}`,
                    })
                    if ((applied as any)?.updated) shopUpdated++
                } else {
                    shopUnresolved++
                    await db.from('shop_sms_delivery_receipts')
                        .update({ updated_at: new Date().toISOString() })
                        .eq('id', r.id)
                        .eq('status', 'sent')
                }
            } catch {
                shopUnresolved++
            }
        }

        // After reconciling, dispatch webhooks for campaigns that just became
        // fully resolved (no more 'sent'/'queued' rows). dispatchCampaignWebhook
        // itself no-ops for any account without both webhook_url and
        // webhook_secret configured — in practice only business-mode accounts
        // that opted in via PUT /api/sms/webhook-config ever have both set.
        // Scoped to campaigns touched in THIS run to bound cost.
        const touchedCampaignIds = Array.from(new Set(((stuck as any[]) || []).map(m => m.campaign_id)))
        for (const cId of touchedCampaignIds) {
            const { count: pendingCount } = await db.from('sms_messages')
                .select('id', { count: 'exact', head: true })
                .eq('campaign_id', cId)
                .in('status', ['queued', 'sent'])
            if ((pendingCount ?? 0) === 0) {
                dispatchCampaignWebhook(db, cId).catch(() => {})
            }
        }

        return NextResponse.json({
            success: true,
            data: {
                scanned: (stuck as any[])?.length ?? 0, updated, unresolved,
                shopScanned: (shopStuck as any[])?.length ?? 0, shopUpdated, shopUnresolved,
            },
        })
    } catch (e: any) {
        console.error('[SMS Reconcile Cron] error:', e?.message)
        return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 })
    }
}
