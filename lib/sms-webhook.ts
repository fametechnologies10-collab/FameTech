import { createHash, createHmac, randomBytes } from 'crypto'

/**
 * Fire-and-forget delivery-status webhook for a resolved SMS campaign.
 * Best-effort notification — never throws, never blocks the caller. Signs
 * the JSON body with HMAC-SHA256 over the raw bytes using the account's
 * webhook_secret, sent as X-KFT-Signature. One retry on non-2xx/network
 * failure; failures are logged only.
 */
export async function dispatchCampaignWebhook(db: any, campaignId: string): Promise<void> {
    try {
        const { data: campaign } = await db.from('sms_campaigns')
            .select('id, account_id, status, recipients_count, credits_charged')
            .eq('id', campaignId).maybeSingle()
        if (!campaign) return

        const { data: account } = await db.from('sms_accounts')
            .select('webhook_url, webhook_secret')
            .eq('id', campaign.account_id).maybeSingle()
        if (!account?.webhook_url || !account?.webhook_secret) return

        const { data: rollup } = await db.from('sms_messages')
            .select('status')
            .eq('campaign_id', campaignId)
        const counts = { delivered: 0, undelivered: 0, expired: 0, rejected: 0, other: 0 }
        for (const row of (rollup as any[]) || []) {
            if (row.status in counts) (counts as any)[row.status]++
            else counts.other++
        }

        const payload = JSON.stringify({
            campaignId: campaign.id,
            status: campaign.status,
            recipients: campaign.recipients_count,
            creditsCharged: campaign.credits_charged,
            delivery: counts,
            timestamp: new Date().toISOString(),
        })
        const signature = createHmac('sha256', account.webhook_secret).update(payload).digest('hex')

        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const res = await fetch(account.webhook_url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-KFT-Signature': signature },
                    body: payload,
                    signal: AbortSignal.timeout(8000),
                })
                if (res.ok) return
            } catch {
                // fall through to retry / give up
            }
        }
        console.error(`[SMS Webhook] delivery failed for campaign ${campaignId} after retry`)
    } catch (e: any) {
        console.error('[SMS Webhook] dispatch error:', e?.message)
    }
}

export function generateWebhookSecret(): string {
    return randomBytes(24).toString('hex')
}

export function fingerprintSecret(secret: string): string {
    return createHash('sha256').update(secret).digest('hex').slice(0, 12)
}
