import { NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createAdminClient } from '@/lib/supabase-admin'
import {
    processWalletUpgrade,
    fetchUpgradePrice,
    isPlanValidForType,
    normalizeIdempotencyKey,
    pricesMatch,
    UpgradePriceError,
} from '@/lib/wallet-upgrade'
import type { UpgradeType, PlanType, UpgradeFailureCode } from '@/lib/wallet-upgrade'

const FAILURE_STATUS: Record<UpgradeFailureCode, number> = {
    insufficient_balance: 402,
    already_permanent: 409,
    not_eligible: 400,
    account_inactive: 403,
    not_due: 409,
    invalid_request: 400,
    user_not_found: 404,
    wallet_not_found: 404,
    rpc_error: 503,
}

export async function POST(request: Request) {
    try {
        const supabase = await createRouteClient()
        const { data: { user: authUser }, error: authError } = await supabase.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const body = await request.json().catch(() => ({}))
        const upgradeType: UpgradeType = body.upgrade_type === 'dealer' ? 'dealer' : 'agent'

        // Strict plan check — an unknown plan is an error, never silently priced as a default plan.
        if (!isPlanValidForType(upgradeType, body.plan)) {
            return NextResponse.json({ error: 'Invalid plan' }, { status: 400 })
        }
        const plan = body.plan as PlanType

        // Price must ALWAYS come from admin_settings — never trust client-supplied price
        let price: number
        let planLabel: string
        try {
            ;({ price, planLabel } = await fetchUpgradePrice(upgradeType, plan, createAdminClient()))
        } catch (err) {
            if (err instanceof UpgradePriceError) {
                console.error('[WalletUpgradeRoute] Price unavailable:', err.message)
                return NextResponse.json(
                    { error: 'Upgrade pricing is temporarily unavailable. Please try again shortly.' },
                    { status: 503 }
                )
            }
            throw err
        }

        // Consent: the user confirmed a specific price. If it changed since they loaded the page,
        // charge nothing and make them re-confirm.
        if (!pricesMatch(body.expected_price, price)) {
            return NextResponse.json(
                {
                    error: 'The price for this plan has changed. Please review the new price and confirm again.',
                    priceChanged: true,
                    currentPrice: price,
                },
                { status: 409 }
            )
        }

        // One key per confirm click → a double-submit / network retry can never charge twice.
        const idempotencyKey = normalizeIdempotencyKey(
            body.idempotency_key ?? request.headers.get('idempotency-key') ?? undefined
        )

        const result = await processWalletUpgrade({
            userId: authUser.id,
            upgradeType,
            plan,
            price,
            planLabel,
            isAutoUpgrade: false,
            idempotencyKey,
        })

        if (!result.success) {
            if (result.insufficientBalance) {
                return NextResponse.json(
                    {
                        error: 'Insufficient wallet balance',
                        insufficientBalance: true,
                        currentBalance: result.currentBalance,
                        requiredAmount: result.requiredAmount,
                        shortfall: (result.requiredAmount ?? 0) - (result.currentBalance ?? 0),
                    },
                    { status: 402 }
                )
            }
            return NextResponse.json(
                { error: result.error ?? 'Upgrade failed', code: result.code },
                { status: FAILURE_STATUS[result.code ?? 'rpc_error'] ?? 400 }
            )
        }

        return NextResponse.json({
            success: true,
            newExpiry: result.newExpiry,
            planLabel,
            alreadyProcessed: result.alreadyProcessed === true,
        })
    } catch (err: any) {
        console.error('[WalletUpgradeRoute] Error:', err)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
