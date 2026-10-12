import { NextResponse } from 'next/server'

/**
 * RETIRED. Role upgrades are paid from the FameTech wallet (/api/user/upgrade/wallet); nothing in
 * the app calls this route any more.
 *
 * It used to create a pending Paystack payment for an agent/dealer pass. Left live, it let any
 * signed-in user spawn unlimited pending `wallet_payments` rows, leaked raw error messages, and
 * fed processors that could take payment without granting the role. Payments already in flight
 * are still settled by the Paystack webhook / verify / reconciliation paths (which now refund to
 * the wallet instead of keeping the money if the role can't be granted).
 */
export async function POST() {
    return NextResponse.json(
        { error: 'This endpoint has been retired. Upgrade from your wallet on the Upgrade page.' },
        { status: 410 }
    )
}
