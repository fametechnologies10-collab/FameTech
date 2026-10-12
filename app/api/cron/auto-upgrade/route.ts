/**
 * Auto-Upgrade Cron Job
 *
 * Runs on a schedule (recommended: every 6 hours, aligned with the dealer-downgrade cron).
 * Finds all users with auto_upgrade_enabled = true whose membership is expiring soon
 * (within 24 hours) or already expired, then:
 *  - Attempts wallet deduction + role upgrade via processWalletUpgrade
 *  - On success: upgrade is applied, user notified via SMS/email/push
 *  - On failure (insufficient balance): sends SMS/email alert, disables auto-upgrade flag
 *    to prevent spamming, and requires the user to manually re-enable it after topping up
 *
 * Security:
 *  - Requires CRON_SECRET Bearer token (validateCronAuth)
 *  - Uses service_role client for DB operations
 *  - Each charge is the atomic `process_wallet_upgrade` RPC: it locks the user row, re-checks that
 *    the membership is still due (so a manual renewal that raced this run is never charged twice),
 *    and is idempotent per user per hour. A failure rolls back, so money is never kept without the
 *    role grant.
 */

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { validateCronAuth } from '@/lib/cron-utils'
import { processWalletUpgrade, fetchUpgradePrice, isPlanValidForType } from '@/lib/wallet-upgrade'
import { sendAutoUpgradeFailedSMS } from '@/lib/sms-service'
import type { UpgradeType, PlanType } from '@/lib/wallet-upgrade'

const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
)

export async function GET(request: Request) {
    const authError = validateCronAuth(request)
    if (authError) return authError

    try {
        const now = new Date()
        const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000)

        // Fetch all users who have auto-upgrade enabled
        // We target users whose role is expiring within 24 hours OR already expired
        // (null agent_expires_at = permanent = doesn't need renewal)
        const { data: candidates, error: fetchError } = await supabaseAdmin
            .from('users')
            .select('id, first_name, phone_number, email, role, agent_expires_at, dealer_expires_at, auto_upgrade_plan')
            .eq('auto_upgrade_enabled', true)
            .in('role', ['agent', 'dealer', 'customer'])

        if (fetchError) {
            console.error('[AutoUpgrade] Fetch error:', fetchError)
            return NextResponse.json({ error: 'Database error' }, { status: 500 })
        }

        if (!candidates || candidates.length === 0) {
            return NextResponse.json({ message: 'No users with auto-upgrade enabled', processed: 0 })
        }

        // Filter to users who are actually due for renewal:
        // - Dealer: dealer_expires_at within 24h or past
        // - Agent (timed): agent_expires_at within 24h or past
        // - Customer: always eligible (first-time upgrade)
        const due = candidates.filter((u: any) => {
            if (u.role === 'dealer') {
                if (!u.dealer_expires_at) return false
                return new Date(u.dealer_expires_at) <= in24h
            }
            if (u.role === 'agent') {
                // Permanent agents (agent_expires_at = null) never need an Agent renewal; only a
                // Dealer plan applies. A leftover Agent plan is passed through on purpose: the RPC
                // answers `already_permanent` (nothing charged) and the handler below switches the
                // stale setting off and tells the user, instead of leaving it inert forever.
                if (!u.agent_expires_at) return true
                return new Date(u.agent_expires_at) <= in24h
            }
            // customer: eligible for any plan
            return true
        })

        if (due.length === 0) {
            return NextResponse.json({ message: 'No users due for auto-upgrade', processed: 0 })
        }

        console.log(`[AutoUpgrade] ${due.length} users due for auto-upgrade`)

        const results: Array<{ id: string; status: string; error?: string }> = []

        // Authoritative prices, resolved once per (type, plan) per run rather than once per user.
        const priceCache = new Map<string, { price: number; planLabel: string }>()
        // One idempotency key per user per hour: a re-fired cron in the same hour can never charge
        // twice, and the RPC's own "still due?" re-check covers every other overlap.
        const runBucket = now.toISOString().slice(0, 13)

        for (const user of due) {
            const plan = user.auto_upgrade_plan as PlanType
            if (!plan) {
                results.push({ id: user.id, status: 'skipped', error: 'No plan configured' })
                continue
            }

            const upgradeType: UpgradeType = ['1m', '3m', '6m'].includes(plan) ? 'dealer' : 'agent'
            if (!isPlanValidForType(upgradeType, plan)) {
                results.push({ id: user.id, status: 'skipped', error: 'Invalid plan configured' })
                continue
            }

            let price: number
            let planLabel: string
            try {
                const cacheKey = `${upgradeType}:${plan}`
                let resolved = priceCache.get(cacheKey)
                if (!resolved) {
                    resolved = await fetchUpgradePrice(upgradeType, plan, supabaseAdmin)
                    priceCache.set(cacheKey, resolved)
                }
                ;({ price, planLabel } = resolved)
            } catch (err) {
                console.error(`[AutoUpgrade] Price unavailable for ${upgradeType}:${plan}:`, err)
                results.push({ id: user.id, status: 'failed', error: 'Price unavailable' })
                continue
            }

            // Attempt upgrade — atomic, re-verifies "due" on the locked user row
            const result = await processWalletUpgrade({
                userId: user.id,
                upgradeType,
                plan,
                price,
                planLabel,
                isAutoUpgrade: true,
                onlyIfDue: true,
                idempotencyKey: `auto_${user.id}_${runBucket}`,
            })

            if (result.success && result.alreadyProcessed) {
                results.push({ id: user.id, status: 'already_upgraded' })
            } else if (result.success) {
                results.push({ id: user.id, status: 'upgraded' })
                console.log(`[AutoUpgrade] User ${user.id} auto-upgraded (${planLabel})`)
            } else if (result.code === 'not_due' || result.code === 'account_inactive') {
                // Renewed meanwhile (manually or by an overlapping run), or the account is on hold.
                results.push({ id: user.id, status: 'skipped', error: result.code })
            } else if (result.code === 'not_eligible' || result.code === 'already_permanent' || result.code === 'invalid_request') {
                // The saved plan can never be bought by this account (role changed, or the setting was
                // tampered with). Nothing was charged — switch the flag off so it isn't retried every run.
                await (supabaseAdmin.from('users') as any)
                    .update({ auto_upgrade_enabled: false, auto_upgrade_plan: null, updated_at: now.toISOString() })
                    .eq('id', user.id)
                await (supabaseAdmin.from('notifications') as any).insert({
                    user_id: user.id,
                    title: 'Auto-Upgrade Turned Off',
                    message: `Your auto-upgrade for ${planLabel} is no longer applicable to your account and has been turned off. You can set it up again from the Upgrade page.`,
                    type: 'system',
                    action_url: '/dashboard/upgrade',
                })
                results.push({ id: user.id, status: 'disabled_ineligible', error: result.code })
            } else if (result.insufficientBalance) {
                console.log(`[AutoUpgrade] User ${user.id} insufficient balance — need GHS ${result.requiredAmount}, have GHS ${result.currentBalance}`)

                // Disable auto-upgrade to prevent repeated failure alerts each cron run.
                // User must manually re-enable after topping up.
                await (supabaseAdmin.from('users') as any)
                    .update({ auto_upgrade_enabled: false, updated_at: now.toISOString() })
                    .eq('id', user.id)

                // In-app notification
                await (supabaseAdmin.from('notifications') as any).insert({
                    user_id: user.id,
                    title: 'Auto-Upgrade Failed — Top Up Required',
                    message: `Your auto-upgrade for ${planLabel} failed. Wallet balance: GHS ${(result.currentBalance ?? 0).toFixed(2)}, needed: GHS ${(result.requiredAmount ?? 0).toFixed(2)}. Auto-upgrade has been disabled. Top up your wallet and re-enable it to continue.`,
                    type: 'system',
                    action_url: '/dashboard/wallet',
                })

                // SMS alert
                if (user.phone_number) {
                    await sendAutoUpgradeFailedSMS(
                        user.phone_number,
                        user.first_name || 'User',
                        planLabel,
                        result.currentBalance ?? 0,
                        result.requiredAmount ?? price
                    ).catch(err => console.error(`[AutoUpgrade] SMS error for ${user.id}:`, err))
                }

                // Email alert
                if (user.email) {
                    const { sendAutoUpgradeFailedEmail } = await import('@/lib/email-service').catch(() => ({ sendAutoUpgradeFailedEmail: null }))
                    if (sendAutoUpgradeFailedEmail) {
                        await sendAutoUpgradeFailedEmail(
                            user.email,
                            user.first_name || 'User',
                            planLabel,
                            result.currentBalance ?? 0,
                            result.requiredAmount ?? price
                        ).catch(() => null)
                    }
                }

                results.push({ id: user.id, status: 'insufficient_balance', error: result.error })
            } else {
                results.push({ id: user.id, status: 'failed', error: result.error })
                console.error(`[AutoUpgrade] Failed for user ${user.id}:`, result.error)
            }
        }

        const upgraded = results.filter(r => r.status === 'upgraded').length
        const failed = results.filter(r => r.status === 'insufficient_balance' || r.status === 'failed').length

        return NextResponse.json({
            message: 'Auto-upgrade cron completed',
            total: due.length,
            upgraded,
            failed,
            results,
        })
    } catch (err: any) {
        console.error('[AutoUpgrade] Exception:', err)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
