import { NextRequest, NextResponse, after } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createAdminClient } from '@/lib/supabase-admin'
import { roleFeeSettingKeys, resolveRoleFeeSetting } from '@/lib/pricing/shop-fee-resolver'
import { sendAdminShopWithdrawalRequestAlert, sendShopWithdrawalRequestedOwnerEmail } from '@/lib/email-service'
import { resolveNameSingle } from '@/lib/momo-verify'
import { normalizeGhanaPhone } from '@/lib/sms-service'
import { checkUserPin } from '@/lib/pin-verify'
import { withdrawSchema, checkWithdrawEligibility, roundMoney } from '@/lib/shop-withdraw-validation'

// Messages the RPC raises on purpose. Anything else is an unexpected database
// error and is never echoed to the client.
const SAFE_RPC_MESSAGES = [
    'Insufficient shop wallet balance',
    'Withdrawal amount too low to cover the processing fee',
    'You already have an identical withdrawal waiting to be processed',
    'Your account is not active',
    'Your shop is not active',
]

export async function POST(req: NextRequest) {
    try {
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        // 1. Validate caller is authenticated — shop ownership is verified via wallet lookup below
        const { data: dbUser } = await supabase
            .from('users')
            .select('role, id, status, first_name, email')
            .eq('id', user.id)
            .single()

        if (!dbUser) {
            return NextResponse.json({ error: 'Forbidden. User not found.' }, { status: 403 })
        }

        const body = await req.json().catch(() => null)

        // 2. Validate input shape with Zod. Withdrawals are mobile-money only.
        const validation = withdrawSchema.safeParse(body)
        if (!validation.success) {
            const errorDetails = validation.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`)
            // SEC-W10: log field names only — never the submitted values — to avoid leaking PII to logs
            const fieldNames = validation.error.errors.map((e) => e.path.join('.')).join(', ')
            console.warn(`[Security] Withdrawal input rejected for User: ${user.id} — fields: ${fieldNames}`)
            return NextResponse.json({ error: 'Invalid input', details: errorDetails }, { status: 400 })
        }

        const amountNum = validation.data.amount
        // These may be overridden below if savedDetailId is provided.
        let momoNumber = validation.data.momoNumber
        let network: string = validation.data.network
        const saveForLater = validation.data.saveForLater
        const savedDetailId = validation.data.savedDetailId
        // Already trimmed by the schema. Collapse any inner whitespace defensively.
        const manualAccountName = validation.data.manualAccountName
            ? validation.data.manualAccountName.replace(/\s+/g, ' ')
            : undefined

        const supabaseAdmin = createAdminClient()

        // 3. Fetch wallet and shop profile
        const [walletRes, shopProfileRes] = await Promise.all([
            supabase
                .from('shop_wallets')
                .select('id, balance, total_withdrawn')
                .eq('owner_id', user.id)
                .single(),
            supabase
                .from('shop_profiles')
                .select('shop_name, approval_status, paystack_fee_percent, withdrawal_fee_percent, withdrawal_fee_flat, min_withdrawal_amount')
                .eq('owner_id', user.id)
                .maybeSingle(),
        ])

        // 3b. Server-side eligibility. Suspension is otherwise enforced only in the
        // browser, so a suspended user (or a rejected/suspended shop) could call
        // this endpoint directly. The RPC re-checks inside the wallet lock.
        const eligibility = checkWithdrawEligibility({
            userStatus: dbUser.status,
            shopApproval: shopProfileRes.data?.approval_status,
        })
        if (!eligibility.ok) {
            return NextResponse.json({ error: eligibility.reason }, { status: 403 })
        }

        // 3c. Step-up: when the user has an app-lock PIN, a withdrawal needs it.
        // A stolen session cookie alone can then no longer cash out the wallet.
        const pinCheck = await checkUserPin(supabaseAdmin, user.id, validation.data.pin)
        if (pinCheck.status === 'required') {
            return NextResponse.json({ error: 'Enter your PIN to confirm this withdrawal.', code: 'PIN_REQUIRED' }, { status: 403 })
        }
        if (pinCheck.status === 'locked') {
            return NextResponse.json(
                { error: 'PIN locked after too many wrong attempts. Reset it with your account password, then try again.', code: 'PIN_LOCKED' },
                { status: 423 }
            )
        }
        if (pinCheck.status === 'wrong') {
            return NextResponse.json(
                { error: `Wrong PIN. ${pinCheck.attemptsRemaining} attempt${pinCheck.attemptsRemaining === 1 ? '' : 's'} remaining.`, code: 'PIN_INVALID' },
                { status: 401 }
            )
        }

        if (!walletRes.data) return NextResponse.json({ error: 'Shop wallet not found' }, { status: 404 })
        const wallet = walletRes.data
        const shopProfile = shopProfileRes.data

        // 4. Fetch global settings
        // Resolution (see lib/pricing/shop-fee-resolver.ts): per-shop override ->
        // role-tagged global -> (subagent only) customer-tagged global -> legacy
        // untagged global -> hardcoded default.
        const ownerRole = dbUser.role || 'customer'
        const { data: settingsRows } = await supabase
            .from('shop_global_settings')
            .select('key, value')
            .in('key', [
                ...roleFeeSettingKeys(ownerRole, 'withdrawal_fee_percent'),
                ...roleFeeSettingKeys(ownerRole, 'withdrawal_fee_flat'),
                ...roleFeeSettingKeys(ownerRole, 'min_withdrawal_amount'),
            ])

        const globalMap: Record<string, string> = {}
        for (const row of (settingsRows || [])) {
            globalMap[row.key] = row.value
        }

        const settings = {
            min_withdrawal_amount: resolveRoleFeeSetting(
                globalMap, ownerRole, 'min_withdrawal_amount', 50, shopProfile?.min_withdrawal_amount
            ),
            withdrawal_fee_percent: resolveRoleFeeSetting(
                globalMap, ownerRole, 'withdrawal_fee_percent', 2, shopProfile?.withdrawal_fee_percent
            ),
            withdrawal_fee_flat: resolveRoleFeeSetting(
                globalMap, ownerRole, 'withdrawal_fee_flat', 0, shopProfile?.withdrawal_fee_flat
            ),
        }

        // 5. Basic balance and minimum checks
        if (amountNum < settings.min_withdrawal_amount) {
            return NextResponse.json(
                { error: `Minimum withdrawal is GH₵${settings.min_withdrawal_amount.toFixed(2)}` },
                { status: 400 }
            )
        }
        if (amountNum > wallet.balance) {
            return NextResponse.json({ error: 'Insufficient shop wallet balance' }, { status: 400 })
        }

        // 6. Server-side account name verification — NEVER trust a client-submitted name.
        // Resolution is Paystack first (Moolre only as a fallback while it is unconfigured).
        // Priority:
        //   1. Saved payment detail — stored verified name + number from the DB, no lookup.
        //   2. New entry + provider resolves — use the provider's name.
        //   3. New entry + lookup fails + manual fallback supplied — flagged for admin review.
        //   4. Otherwise — reject.
        let verifiedAccountName: string
        let isNameVerified: boolean

        if (savedDetailId) {
            // Fetch ALL stored fields server-side — never trust the client's number/network
            // when a savedDetailId is supplied (prevents saving a verified method and then
            // swapping the number in the request body).
            const { data: savedDetail } = await supabase
                .from('shop_payment_details')
                .select('account_name, momo_number, network, payment_type')
                .eq('id', savedDetailId)
                .eq('shop_owner_id', user.id)
                .single()

            if (!savedDetail) {
                return NextResponse.json({ error: 'Saved payment detail not found.' }, { status: 404 })
            }
            // Legacy bank rows can no longer be paid out.
            if (savedDetail.payment_type && savedDetail.payment_type !== 'momo') {
                return NextResponse.json({ error: 'Bank payouts are no longer supported. Use a mobile money number.' }, { status: 400 })
            }
            const savedNumber = normalizeGhanaPhone(savedDetail.momo_number)
            if (!savedNumber) {
                return NextResponse.json({ error: 'Saved payment detail is invalid. Please add it again.' }, { status: 400 })
            }
            verifiedAccountName = savedDetail.account_name
            isNameVerified = true

            // Override client-provided fields with trusted DB values
            momoNumber = '0' + savedNumber.slice(3)
            network = savedDetail.network || network
        } else {
            const normalized = normalizeGhanaPhone(momoNumber)
            const resolved = normalized ? await resolveNameSingle(normalized) : null

            if (resolved?.fullName?.trim()) {
                verifiedAccountName = resolved.fullName.trim()
                isNameVerified = true
            } else if (manualAccountName) {
                verifiedAccountName = manualAccountName
                isNameVerified = false
                console.warn(`[shop/withdraw] User ${user.id} used manual name fallback — name lookup returned nothing`)
            } else {
                return NextResponse.json(
                    { error: 'Could not verify account name. Please check the number and try again.' },
                    { status: 400 }
                )
            }
        }

        // 7. Calculate fees. Round to pesewas so the ledger and the payout agree.
        const totalFee = roundMoney((amountNum * settings.withdrawal_fee_percent) / 100 + settings.withdrawal_fee_flat)
        const netAmount = roundMoney(amountNum - totalFee)

        // Guard against negative net amount (fees exceed withdrawal amount)
        if (netAmount <= 0) {
            return NextResponse.json(
                { error: `Withdrawal amount is too low to cover the processing fee of GH₵${totalFee.toFixed(2)}. Please enter a higher amount.` },
                { status: 400 }
            )
        }

        // Prefix with an admin-visible tag when the name bypassed the lookup — admins
        // should double-check the name before approving the payout.
        const description = isNameVerified
            ? `Withdrawal request — ${network}: ${momoNumber}`
            : `[UNVERIFIED-NAME] Withdrawal request — ${network}: ${momoNumber}`

        // 8. Process the withdrawal atomically via PostgreSQL RPC to prevent race conditions.
        // SECURITY (C1): call the RPC with a SERVICE-ROLE client and pass the
        // server-trusted p_owner_id (this user, already authenticated above) +
        // the real p_name_verified flag. Direct EXECUTE is revoked from `authenticated`
        // (migration 20260624h) so a shop owner cannot call it through PostgREST to
        // forge the payout name. The RPC also re-checks account status and rejects an
        // identical in-flight withdrawal (double-submit / retry-after-timeout) under the
        // wallet lock.
        const { data: rpcResult, error: rpcError } = await supabaseAdmin.rpc('process_shop_withdrawal', {
            p_wallet_id: wallet.id,
            p_amount: amountNum,
            p_fee: totalFee,
            p_net_amount: netAmount,
            p_account_name: verifiedAccountName,
            p_momo_number: momoNumber,
            p_account_number: null,
            p_network: network,
            p_payment_type: 'momo',
            p_bank_id: null,
            p_bank_name: null,
            p_branch: null,
            p_description: description,
            p_owner_id: user.id,
            p_name_verified: isNameVerified,
        })

        if (rpcError) {
            console.error('[Withdrawal RPC Error]', rpcError)
            const known = SAFE_RPC_MESSAGES.find(m => rpcError.message?.includes(m))
            if (known) {
                return NextResponse.json({ error: known }, { status: known.startsWith('Your ') ? 403 : 400 })
            }
            return NextResponse.json({ error: 'Failed to process withdrawal' }, { status: 400 })
        }

        const newBalance = rpcResult.newBalance

        // Move ALL non-critical post-withdrawal work into after() so the 200 response
        // is sent IMMEDIATELY. Previously the email alert and payment-detail save ran
        // before the response, causing Vercel to hit its execution timeout and send a
        // 504 — even though the balance deduction had already committed.
        after(async () => {
            try {
                // Save payment detail for later if requested.
                // shop_payment_details is server-write-only (a saved row is trusted as
                // name-verified), so both writes below use the service role.
                if (saveForLater && isNameVerified && !savedDetailId) {
                    const { error: saveErr } = await (supabaseAdmin as any).rpc('save_shop_payment_detail_if_under_limit', {
                        p_owner_id:       user.id,
                        p_account_name:   verifiedAccountName,
                        p_momo_number:    momoNumber,
                        p_account_number: null,
                        p_network:        network,
                        p_payment_type:   'momo',
                        p_bank_id:        null,
                        p_limit:          5,
                    })
                    if (saveErr) console.warn('[Withdraw] save payment detail failed:', saveErr)
                } else if (isNameVerified && !savedDetailId) {
                    // Auto-update the saved detail if the verified name differs
                    const { data: existingSaved } = await (supabaseAdmin as any)
                        .from('shop_payment_details')
                        .select('id, account_name')
                        .eq('shop_owner_id', user.id)
                        .eq('momo_number', momoNumber)
                        .maybeSingle()

                    if (existingSaved && existingSaved.account_name !== verifiedAccountName) {
                        await (supabaseAdmin as any)
                            .from('shop_payment_details')
                            .update({ account_name: verifiedAccountName })
                            .eq('id', existingSaved.id)
                            .eq('shop_owner_id', user.id)
                    }
                }

                // Admin email alert — sub-agent withdrawals go straight to the admin queue
                // like any other shop withdrawal (no Lead/parent approval step).
                const shopName = shopProfile?.shop_name || 'Unknown Shop'
                const ownerName = dbUser.first_name || ''
                await sendAdminShopWithdrawalRequestAlert({
                    shopName,
                    shopId: wallet.id,
                    ownerName,
                    accountName: verifiedAccountName,
                    amount: amountNum,
                    momoNumber,
                    network,
                    balanceSnapshot: newBalance,
                    date: new Date().toLocaleString('en-GB'),
                    isResubmission: false,
                }).catch(err => console.warn('[ShopAlert Email Hook Error]:', err))

                // Security notice to the owner so an unauthorised request is noticed early.
                if (dbUser.email) {
                    await sendShopWithdrawalRequestedOwnerEmail(
                        dbUser.email, ownerName || shopName, shopName, amountNum, netAmount, momoNumber, network
                    ).catch(err => console.warn('[Withdraw] owner notice email failed:', err))
                }
            } catch (afterErr) {
                // Non-fatal — the withdrawal itself already succeeded.
                console.error('[Withdraw after() error]:', afterErr)
            }
        })

        return NextResponse.json({ success: true, newBalance, verifiedName: verifiedAccountName })

    } catch (error: any) {
        console.error('[Shop Withdraw API]', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
