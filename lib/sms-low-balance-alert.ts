import { sendEmail } from '@/lib/email-service'

/**
 * Fires one low-balance email when a debit drops the account below its
 * threshold, then stays quiet (low_balance_notified_at is set) until a
 * top-up clears the flag via clearLowBalanceFlag. Best-effort — never
 * throws, never blocks the debit path that calls it.
 */
export async function maybeNotifyLowBalance(
    db: any,
    accountId: string,
    userId: string,
    balanceAfter: number
): Promise<void> {
    try {
        const { data: account } = await db.from('sms_accounts')
            .select('low_balance_threshold, low_balance_notified_at')
            .eq('id', accountId).maybeSingle()
        if (!account) return
        if (balanceAfter >= account.low_balance_threshold) return
        if (account.low_balance_notified_at) return // fast pre-check, still racy alone — the atomic claim below is what actually prevents the double-send

        // Atomic claim: only proceeds if low_balance_notified_at is STILL null
        // at the moment of this UPDATE — closes the race between the read
        // above and here. Concurrent callers all fail this .is(...) filter
        // except the one that wins, so at most one email ever sends per
        // "crossed below threshold" episode.
        const { data: claimed } = await db.from('sms_accounts')
            .update({ low_balance_notified_at: new Date().toISOString() })
            .eq('id', accountId)
            .is('low_balance_notified_at', null)
            .select('id')
            .maybeSingle()
        if (!claimed) return // another concurrent call already claimed it

        const { data: userRow } = await db.from('users')
            .select('email, first_name').eq('id', userId).maybeSingle()
        if (!userRow?.email) return

        await sendEmail({
            to: userRow.email,
            toName: userRow.first_name || undefined,
            subject: 'Your KFT SMS credit balance is low',
            htmlContent: `<p>Hi ${userRow.first_name || 'there'},</p>
<p>Your SMS credit balance has dropped to <strong>${balanceAfter}</strong>, below your alert threshold of ${account.low_balance_threshold}.</p>
<p>Top up on the <a href="https://kingflexygh.com/dashboard/sms/credits">SMS credits page</a> to avoid interrupted sends.</p>`,
        })
    } catch (e: any) {
        console.error('[SMS Low Balance Alert] error:', e?.message)
    }
}

export async function clearLowBalanceFlag(db: any, accountId: string): Promise<void> {
    try {
        await db.from('sms_accounts')
            .update({ low_balance_notified_at: null })
            .eq('id', accountId)
            .not('low_balance_notified_at', 'is', null) // no-op write avoidance
    } catch (e: any) {
        console.error('[SMS Low Balance Alert] clear error:', e?.message)
    }
}
