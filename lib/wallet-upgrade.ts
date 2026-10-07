/**
 * Wallet-based role upgrade processor.
 * Deducts from wallet balance atomically and applies agent/dealer role upgrade.
 * Used by the wallet upgrade API route and the auto-upgrade cron job.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js'

export type UpgradeType = 'agent' | 'dealer'
export type AgentPlan = '3d' | '14d' | '30d' | 'permanent'
export type DealerPlan = '1m' | '3m' | '6m'
export type PlanType = AgentPlan | DealerPlan

interface UpgradeParams {
    userId: string
    upgradeType: UpgradeType
    plan: PlanType
    /** Pre-fetched price — must be verified server-side, never trust client */
    price: number
    planLabel: string
    /** Whether this is triggered by the auto-upgrade cron (affects notifications) */
    isAutoUpgrade?: boolean
}

interface UpgradeResult {
    success: boolean
    error?: string
    insufficientBalance?: boolean
    currentBalance?: number
    requiredAmount?: number
    newExpiry?: string | null
}

function buildAdminClient(): SupabaseClient {
    return createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
        { auth: { autoRefreshToken: false, persistSession: false } }
    )
}

/**
 * Compute agent expiry given current expiry and plan days.
 * Returns null for permanent plans.
 */
function computeAgentExpiry(currentExpiry: Date | null, planDays: number | null): Date | null {
    if (planDays === null) return null
    const now = new Date()
    const base = currentExpiry && currentExpiry > now ? currentExpiry : now
    return new Date(base.getTime() + planDays * 24 * 60 * 60 * 1000)
}

/**
 * Compute dealer expiry given current dealer expiry.
 * Extensions stack from existing expiry if still in future.
 */
function computeDealerExpiry(currentDealerExpiry: Date | null, months: number): Date {
    const now = new Date()
    const base = currentDealerExpiry && currentDealerExpiry > now ? currentDealerExpiry : now
    const expiry = new Date(base)
    expiry.setMonth(expiry.getMonth() + months)
    return expiry
}

export function planDaysFromType(plan: AgentPlan): number | null {
    if (plan === 'permanent') return null
    if (plan === '3d') return 3
    if (plan === '14d') return 14
    return 30
}

export function dealerMonthsFromPlan(plan: DealerPlan): number {
    if (plan === '1m') return 1
    if (plan === '3m') return 3
    return 6
}

/**
 * Process a wallet-funded role upgrade for a user.
 *
 * Security guarantees:
 * - Balance check and deduction happen in a single atomic RPC (`deduct_wallet_balance`)
 *   which uses `FOR UPDATE` row lock and raises INSUFFICIENT_BALANCE on failure.
 * - Price is resolved from `admin_settings` server-side — never from client input.
 * - Idempotency is not needed here (no payment record) but the role update uses
 *   an atomic DB write that is safe to retry.
 */
export async function processWalletUpgrade(params: UpgradeParams): Promise<UpgradeResult> {
    const { userId, upgradeType, plan, price, planLabel, isAutoUpgrade = false } = params
    const supabase = buildAdminClient()

    // 1. Fetch user + wallet in parallel
    const [userRes, walletRes] = await Promise.all([
        supabase
            .from('users')
            .select('role, agent_expires_at, dealer_expires_at, email, first_name, phone_number')
            .eq('id', userId)
            .single(),
        supabase
            .from('wallets')
            .select('id, balance')
            .eq('user_id', userId)
            .single(),
    ])

    if (userRes.error || !userRes.data) {
        return { success: false, error: 'User not found' }
    }
    if (walletRes.error || !walletRes.data) {
        return { success: false, error: 'Wallet not found' }
    }

    const user = userRes.data as any
    const wallet = walletRes.data as any

    // 2. Pre-check balance (optimistic — the RPC does the authoritative atomic check)
    if (wallet.balance < price) {
        return {
            success: false,
            insufficientBalance: true,
            currentBalance: wallet.balance,
            requiredAmount: price,
            error: 'Insufficient wallet balance',
        }
    }

    // 3. Validate eligibility
    if (upgradeType === 'dealer') {
        const isLifetimeAgent = user.role === 'agent' && user.agent_expires_at === null
        const isCurrentDealer = user.role === 'dealer'
        if (!isLifetimeAgent && !isCurrentDealer) {
            return { success: false, error: 'Dealer upgrade requires Lifetime Agent or current Dealer status' }
        }
    } else {
        if (user.role !== 'customer' && user.role !== 'agent') {
            return { success: false, error: 'Agent upgrade is only available to customers and existing agents' }
        }
    }

    // 4. Atomic wallet deduction via SECURITY DEFINER RPC
    const { data: deductResult, error: deductError } = await supabase.rpc(
        'deduct_wallet_balance',
        { p_user_id: userId, p_amount: price }
    )

    if (deductError) {
        if (deductError.message?.includes('INSUFFICIENT_BALANCE')) {
            return {
                success: false,
                insufficientBalance: true,
                currentBalance: wallet.balance,
                requiredAmount: price,
                error: 'Insufficient wallet balance',
            }
        }
        console.error('[WalletUpgrade] Deduction error:', deductError)
        return { success: false, error: 'Failed to deduct wallet balance' }
    }

    const newBalance = (deductResult as any)?.[0]?.new_balance ?? wallet.balance - price

    // 5. Log wallet transaction
    await (supabase.from('wallet_transactions') as any).insert({
        wallet_id: wallet.id,
        user_id: userId,
        type: 'debit',
        amount: price,
        description: isAutoUpgrade
            ? `Auto-upgrade: ${planLabel}`
            : `Upgrade purchase: ${planLabel}`,
        reference: `upgrade_${upgradeType}_${Date.now()}`,
        source: 'purchase',
        status: 'completed',
    })

    // 6. Compute new role/expiry and update user
    let newExpiry: Date | null = null
    let updatePayload: Record<string, any>

    if (upgradeType === 'dealer') {
        const currentDealerExpiry = user.dealer_expires_at ? new Date(user.dealer_expires_at) : null
        const months = dealerMonthsFromPlan(plan as DealerPlan)
        newExpiry = computeDealerExpiry(currentDealerExpiry, months)
        updatePayload = {
            role: 'dealer',
            dealer_expires_at: newExpiry.toISOString(),
            updated_at: new Date().toISOString(),
        }
    } else {
        const planDays = planDaysFromType(plan as AgentPlan)
        const currentAgentExpiry = user.agent_expires_at ? new Date(user.agent_expires_at) : null
        newExpiry = computeAgentExpiry(currentAgentExpiry, planDays)
        updatePayload = {
            role: 'agent',
            agent_expires_at: newExpiry ? newExpiry.toISOString() : null,
            updated_at: new Date().toISOString(),
        }
    }

    const { error: updateUserError } = await (supabase.from('users') as any)
        .update(updatePayload)
        .eq('id', userId)

    if (updateUserError) {
        console.error('[WalletUpgrade] User update error:', updateUserError)
        // Wallet already deducted — log the failure for manual review but don't bubble up
        // as a user-facing error. In practice this should never happen.
        return { success: false, error: 'Role update failed after deduction — contact support' }
    }

    const expiryISO = newExpiry?.toISOString() ?? null
    const expiryFormatted = newExpiry
        ? newExpiry.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
        : null
    const isPermanent = plan === 'permanent'
    const isExtension = upgradeType === 'dealer'
        ? user.role === 'dealer'
        : user.role === 'agent' && user.agent_expires_at && new Date(user.agent_expires_at) > new Date()

    // 7. In-app notification
    const notifTitle = isPermanent
        ? 'Permanent Agent Unlocked!'
        : isAutoUpgrade
            ? `Auto-Upgrade Successful`
            : isExtension
                ? `${upgradeType === 'dealer' ? 'Dealer' : 'Agent'} Membership Extended!`
                : `${upgradeType === 'dealer' ? 'Dealer' : 'Agent'} Status Activated!`

    const notifMessage = isPermanent
        ? 'You now have lifetime access to all Agent benefits. Congratulations!'
        : isAutoUpgrade
            ? `Your ${planLabel} was auto-renewed from your wallet. ${expiryFormatted ? `Active until ${expiryFormatted}.` : ''} Balance: GHS ${newBalance.toFixed(2)}.`
            : `Your ${planLabel} is now active${expiryFormatted ? ` until ${expiryFormatted}` : ''}. GHS ${price.toFixed(2)} deducted from wallet.`

    await (supabase.from('notifications') as any).insert({
        user_id: userId,
        title: notifTitle,
        message: notifMessage,
        type: 'system',
        action_url: '/dashboard',
    })

    // 8. Background: push + SMS + email notifications
    ;(async () => {
        try {
            const { sendPushNotification } = await import('@/lib/push-service')
            await sendPushNotification(userId, {
                title: notifTitle,
                body: notifMessage,
                url: '/dashboard',
            }).catch(() => null)

            const {
                sendAgentUpgradeSuccessSMS,
                sendAgentExtensionSuccessSMS,
                sendPermanentAgentUpgradeSuccessSMS,
                sendDealerActivationSuccessSMS,
                sendDealerExtensionSuccessSMS,
                sendAutoUpgradeSuccessSMS,
            } = await import('@/lib/sms-service')

            const {
                sendPermanentAgentUpgradeSuccessEmail,
                sendDealerActivationSuccessEmail,
                sendDealerExtensionSuccessEmail,
            } = await import('@/lib/email-service')

            if (user.phone_number) {
                if (isAutoUpgrade && newExpiry) {
                    await sendAutoUpgradeSuccessSMS(user.phone_number, user.first_name || 'User', planLabel, newExpiry, newBalance)
                        .catch(() => null)
                } else if (upgradeType === 'dealer' && newExpiry) {
                    if (isExtension) {
                        await sendDealerExtensionSuccessSMS(user.phone_number, newExpiry).catch(() => null)
                    } else {
                        await sendDealerActivationSuccessSMS(user.phone_number, user.first_name || 'Dealer', newExpiry).catch(() => null)
                    }
                } else if (isPermanent) {
                    await sendPermanentAgentUpgradeSuccessSMS(user.phone_number).catch(() => null)
                } else if (newExpiry) {
                    const now = new Date()
                    const currentAgentExpiry = user.agent_expires_at ? new Date(user.agent_expires_at) : null
                    if (currentAgentExpiry && currentAgentExpiry > now) {
                        await sendAgentExtensionSuccessSMS(user.phone_number, newExpiry).catch(() => null)
                    } else {
                        const remainingDays = Math.ceil((newExpiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
                        await sendAgentUpgradeSuccessSMS(user.phone_number, user.first_name || 'Agent', planLabel, remainingDays, newExpiry.toISOString()).catch(() => null)
                    }
                }
            }

            if (user.email) {
                if (isPermanent) {
                    await sendPermanentAgentUpgradeSuccessEmail(user.email, user.first_name || 'User').catch(() => null)
                } else if (upgradeType === 'dealer' && newExpiry) {
                    if (isExtension) {
                        await sendDealerExtensionSuccessEmail(user.email, user.first_name || 'Dealer', newExpiry).catch(() => null)
                    } else {
                        await sendDealerActivationSuccessEmail(user.email, user.first_name || 'Dealer', newExpiry).catch(() => null)
                    }
                }
            }
        } catch (err) {
            console.error('[WalletUpgrade] Notification error:', err)
        }
    })()

    return { success: true, newExpiry: expiryISO }
}

/**
 * Fetch upgrade price from admin_settings.
 * Returns the price and human-readable label for the given plan.
 */
export async function fetchUpgradePrice(
    upgradeType: UpgradeType,
    plan: PlanType,
    supabase: SupabaseClient
): Promise<{ price: number; planLabel: string; planDays: number | null }> {
    const keys = [
        'agent_upgrade_price_3d',
        'agent_upgrade_price_14d',
        'agent_upgrade_price_30d',
        'agent_upgrade_price_permanent',
        'dealer_upgrade_price_1m',
        'dealer_upgrade_price_3m',
        'dealer_upgrade_price_6m',
    ]
    const { data: settings } = await supabase
        .from('admin_settings')
        .select('key, value')
        .in('key', keys)

    const get = (key: string, def: number) => {
        const s = settings?.find((s: any) => s.key === key)
        return s ? Number(s.value) : def
    }

    if (upgradeType === 'dealer') {
        const dealerPlanMap: Record<DealerPlan, { key: string; def: number; label: string; days: number }> = {
            '1m': { key: 'dealer_upgrade_price_1m', def: 99.99,  label: '1 Month Dealer Pass',  days: 30  },
            '3m': { key: 'dealer_upgrade_price_3m', def: 199.99, label: '3 Months Dealer Pass', days: 90  },
            '6m': { key: 'dealer_upgrade_price_6m', def: 299.99, label: '6 Months Dealer Pass', days: 180 },
        }
        const entry = dealerPlanMap[plan as DealerPlan] ?? dealerPlanMap['6m']
        return { price: get(entry.key, entry.def), planLabel: entry.label, planDays: entry.days }
    }

    const planMap: Record<AgentPlan, { key: string; def: number; label: string; days: number | null }> = {
        '3d':        { key: 'agent_upgrade_price_3d',        def: 9.99,   label: '3 Days Agent Pass',   days: 3  },
        '14d':       { key: 'agent_upgrade_price_14d',       def: 49.99,  label: '14 Days Agent Pass',  days: 14 },
        '30d':       { key: 'agent_upgrade_price_30d',       def: 99.99,  label: '30 Days Agent Pass',  days: 30 },
        'permanent': { key: 'agent_upgrade_price_permanent', def: 149.99, label: 'Permanent Agent Pass', days: null },
    }

    const entry = planMap[plan as AgentPlan] ?? planMap['30d']
    return { price: get(entry.key, entry.def), planLabel: entry.label, planDays: entry.days }
}
