import { NextRequest, NextResponse, after } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createAdminClient } from '@/lib/supabase-admin'
import { cookies } from 'next/headers'
import { z } from 'zod'
import { phoneSchema } from '@/lib/validation'
import { validateAccountName, MOOLRE_CHANNEL_MAP, getBanks } from '@/lib/moolre-transfer-service'
import { roleFeeSettingKeys, resolveRoleFeeSetting } from '@/lib/pricing/shop-fee-resolver'
import { sendAdminShopWithdrawalRequestAlert } from '@/lib/email-service'

// Manual fallback name — strict allowlist to prevent injection/abuse.
// Allowed: letters (incl. accented), spaces, hyphen, apostrophe, period.
// Length 2-100. No leading/trailing whitespace, no consecutive whitespace,
// no HTML/script tokens (defence-in-depth on top of the allowlist).
const MANUAL_NAME_REGEX = /^[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ '.\-]{1,99}$/
const MANUAL_NAME_BLOCK = /(script|javascript:|onerror|onload|onclick|onmouseover|eval\(|data:|<|>|&lt|&gt)/i
const manualAccountNameSchema = z.string()
    .trim()
    .min(2, 'Name must be at least 2 characters')
    .max(100, 'Name must be 100 characters or less')
    .regex(MANUAL_NAME_REGEX, 'Only letters, spaces, hyphens, apostrophes and periods allowed')
    .refine((v: string) => !/\s{2,}/.test(v), 'No consecutive spaces allowed')
    .refine((v: string) => !MANUAL_NAME_BLOCK.test(v), 'Invalid characters detected')

const withdrawSchema = z.object({
    amount: z.union([
        z.number().positive(),
        z.string().regex(/^\d+(\.\d{1,2})?$/).transform(Number)
    ]),
    momoNumber: z.string().min(8, 'Number is too short').max(30, 'Number is too long'),
    network: z.enum(['MTN MoMo', 'Telecel Cash', 'AirtelTigo Money', 'Bank']),
    payment_type: z.enum(['momo', 'bank']).default('momo'),
    bankId: z.string().regex(/^[A-Za-z0-9_-]+$/, 'Invalid bank ID format').optional(),
    branch: z.string().max(100).optional(),
    saveForLater: z.boolean().optional(),
    manualAccountName: manualAccountNameSchema.optional(),
    // When a saved payment detail is selected the server fetches the stored
    // verified name from DB — Moolre is not called.
    savedDetailId: z.string().uuid('Invalid saved detail ID').optional(),
}).superRefine((data: any, ctx: z.RefinementCtx) => {
    if (data.network === 'Bank') {
        // Bank account numbers: allow digits, letters, hyphens (some banks use alphanumeric)
        if (!/^[A-Za-z0-9-]+$/.test(data.momoNumber)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['momoNumber'],
                message: 'Must be a valid bank account number (digits, letters, or hyphens)'
            })
        }
    } else {
        // MoMo numbers: digits only + Ghanaian phone format
        if (!/^\d+$/.test(data.momoNumber)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['momoNumber'],
                message: 'MoMo number must contain only digits'
            })
        } else if (!phoneSchema.safeParse(data.momoNumber).success) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['momoNumber'],
                message: 'Must be a valid Ghanaian MoMo number (e.g. 0241234567)'
            })
        }
    }
})

export async function POST(req: NextRequest) {
    try {
        const cookieStore = await cookies()
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        // 1. Validate caller is authenticated — shop ownership is verified via wallet lookup below
        const { data: dbUser } = await supabase
            .from('users')
            .select('role, id')
            .eq('id', user.id)
            .single()

        if (!dbUser) {
            return NextResponse.json({ error: 'Forbidden. User not found.' }, { status: 403 })
        }

        const body = await req.json()

        // 2. Validate input shape with Zod
        const validation = withdrawSchema.safeParse(body)
        if (!validation.success) {
            const errorDetails = validation.error.errors.map((e: z.ZodIssue) => `${e.path.join('.')}: ${e.message}`)
            // SEC-W10: log field names only — never the submitted values — to avoid leaking PII to logs
            const fieldNames = validation.error.errors.map((e: z.ZodIssue) => e.path.join('.')).join(', ')
            console.warn(`[Security] Withdrawal input rejected for User: ${user.id} — fields: ${fieldNames}`)
            return NextResponse.json({ error: 'Invalid input', details: errorDetails }, { status: 400 })
        }

        // Apply .trim() to all string inputs after Zod validation
        const amountNum = validation.data.amount
        // These may be overridden below if savedDetailId is provided.
        let momoNumber = validation.data.momoNumber.trim()
        let network = validation.data.network.trim()
        let payment_type = validation.data.payment_type.trim()
        let bankId = validation.data.bankId ? validation.data.bankId.trim() : undefined
        const branch = validation.data.branch ? validation.data.branch.trim() : undefined
        const saveForLater = validation.data.saveForLater
        const savedDetailId = validation.data.savedDetailId
        // Already trimmed by the schema. Collapse any inner whitespace defensively.
        const manualAccountName = validation.data.manualAccountName
            ? validation.data.manualAccountName.replace(/\s+/g, ' ')
            : undefined

        // 3. Fetch wallet and shop profile
        const [walletRes, shopProfileRes] = await Promise.all([
            supabase
                .from('shop_wallets')
                .select('id, balance, total_withdrawn')
                .eq('owner_id', user.id)
                .single(),
            supabase
                .from('shop_profiles')
                .select('shop_name, paystack_fee_percent, withdrawal_fee_percent, withdrawal_fee_flat, min_withdrawal_amount')
                .eq('owner_id', user.id)
                .single(),
        ])

        if (!walletRes.data) return NextResponse.json({ error: 'Shop wallet not found' }, { status: 404 })
        const wallet = walletRes.data
        const shopProfile = shopProfileRes.data

        // 4. Fetch global settings
        // Resolution (see lib/pricing/shop-fee-resolver.ts): per-shop override ->
        // role-tagged global -> (subagent only) customer-tagged global -> legacy
        // untagged global -> hardcoded default. A sub-agent has no `_subagent`-tagged
        // row today (no admin UI has ever created one), so without the customer
        // fallback they silently landed on the legacy/untagged rate instead of the
        // customer rate (2026-09-17 finding).
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

        // 6. Server-side account name validation via Moolre — NEVER trust client-submitted name
        const channel = MOOLRE_CHANNEL_MAP[network]
        if (channel === undefined) {
            return NextResponse.json({ error: `Unsupported network: ${network}` }, { status: 400 })
        }

        // Resolve the account name to record on the withdrawal.
        // Priority:
        //   1. Saved payment detail — fetch stored verified name from DB, skip Moolre entirely.
        //   2. New entry + Moolre succeeds — use Moolre-verified name.
        //   3. New entry + Moolre fails + manual fallback supplied — flag for admin review.
        //   4. Otherwise — reject.
        let verifiedAccountName: string
        let isNameVerified: boolean

        if (savedDetailId) {
            // SECURITY FIX: Fetch ALL stored fields server-side — never trust
            // client-provided momoNumber/network/payment_type when a savedDetailId
            // is supplied. This prevents a malicious user from saving a verified
            // payment method and then swapping the number in the JSON body.
            const { data: savedDetail } = await supabase
                .from('shop_payment_details')
                .select('account_name, momo_number, account_number, network, payment_type, bank_id')
                .eq('id', savedDetailId)
                .eq('shop_owner_id', user.id)
                .single()

            if (!savedDetail) {
                return NextResponse.json({ error: 'Saved payment detail not found.' }, { status: 404 })
            }
            verifiedAccountName = savedDetail.account_name
            isNameVerified = true

            // Override ALL client-provided fields with trusted DB values
            momoNumber = savedDetail.momo_number || savedDetail.account_number || momoNumber
            network = savedDetail.network || network
            payment_type = savedDetail.payment_type || payment_type
            bankId = savedDetail.bank_id || undefined
        } else {
            const nameValidation = await validateAccountName(momoNumber, channel, bankId)

            if (nameValidation.success && nameValidation.name) {
                verifiedAccountName = nameValidation.name
                isNameVerified = true
            } else if (manualAccountName) {
                verifiedAccountName = manualAccountName
                isNameVerified = false
                console.warn(
                    `[shop/withdraw] User ${user.id} used manual name fallback after Moolre rejection:`,
                    nameValidation.error
                )
            } else {
                return NextResponse.json(
                    { error: nameValidation.error || 'Could not verify account name. Please check the number and try again.' },
                    { status: 400 }
                )
            }
        }

        // 7b. Resolve bank_name server-side from Moolre banks cache (never trust client)
        let resolvedBankName: string | null = null
        if (payment_type === 'bank' && bankId) {
            try {
                const banks = await getBanks()
                const match = banks.find(b => b.id === bankId)
                resolvedBankName = match?.name ?? null
            } catch {
                // Non-blocking — bank_name will be null if lookup fails
            }
        }

        // 8. Calculate fees and new balance
        const feePercent = (amountNum * settings.withdrawal_fee_percent) / 100
        const totalFee = feePercent + settings.withdrawal_fee_flat
        const netAmount = amountNum - totalFee

        // Guard against negative net amount (fees exceed withdrawal amount)
        if (netAmount <= 0) {
            return NextResponse.json(
                { error: `Withdrawal amount is too low to cover the processing fee of GH₵${totalFee.toFixed(2)}. Please enter a higher amount.` },
                { status: 400 }
            )
        }

        // Define our separated account string fields
        const safeMomoNumber = payment_type === 'momo' ? momoNumber : null
        const safeAccountNumber = payment_type === 'bank' ? momoNumber : null
        // Prefix with an admin-visible tag when the name bypassed Moolre — admins
        // should double-check the name before approving the payout.
        const description = isNameVerified
            ? `Withdrawal request — ${network}: ${momoNumber}`
            : `[UNVERIFIED-NAME] Withdrawal request — ${network}: ${momoNumber}`

        // 9. Process the withdrawal atomically via PostgreSQL RPC to prevent race conditions.
        // SECURITY (C1): call the RPC with a SERVICE-ROLE client and pass the
        // server-trusted p_owner_id (this user, already authenticated above) +
        // the real p_name_verified flag. This lets us REVOKE direct EXECUTE from
        // `authenticated` (migration 20260624h) so a shop owner can no longer
        // call the RPC straight through PostgREST to forge the payout name. The
        // RPC's COALESCE(auth.uid(), p_owner_id) ownership check accepts the
        // service-role caller (auth.uid() = NULL) only for the supplied owner.
        const supabaseAdmin = createAdminClient()
        const { data: rpcResult, error: rpcError } = await supabaseAdmin.rpc('process_shop_withdrawal', {
            p_wallet_id: wallet.id,
            p_amount: amountNum,
            p_fee: totalFee,
            p_net_amount: netAmount,
            p_account_name: verifiedAccountName,
            p_momo_number: safeMomoNumber,
            p_account_number: safeAccountNumber,
            p_network: network,
            p_payment_type: payment_type,
            p_bank_id: bankId ?? null,
            p_bank_name: resolvedBankName,
            p_branch: branch ?? null,
            p_description: description,
            p_owner_id: user.id,
            p_name_verified: isNameVerified,
        })

        if (rpcError) {
            console.error('[Withdrawal RPC Error]', rpcError)
            return NextResponse.json({ error: rpcError.message || 'Failed to process withdrawal' }, { status: 400 })
        }

        const newBalance = rpcResult.newBalance

        // ── TIMEOUT FIX ──────────────────────────────────────────────────────
        // Move ALL non-critical post-withdrawal work into after() so the 200
        // response is sent to the client IMMEDIATELY. Previously, the email
        // alert and payment-detail save ran before the response was returned,
        // causing Vercel to hit its execution timeout and send a 504 to the
        // client — even though the balance deduction had already committed.
        after(async () => {
            try {
                // 9c. Save payment detail for later if requested
                // shop_payment_details is server-write-only (a saved row is trusted as
                // name-verified), so both writes below use the service role.
                if (saveForLater && isNameVerified) {
                    await (createAdminClient() as any).rpc('save_shop_payment_detail_if_under_limit', {
                        p_owner_id:      user.id,
                        p_account_name:  verifiedAccountName,
                        p_momo_number:   safeMomoNumber,
                        p_account_number: safeAccountNumber,
                        p_network:       network,
                        p_payment_type:  payment_type,
                        p_bank_id:       bankId ?? null,
                        p_limit:         5,
                    }).then(() => {}).catch((err: any) => console.warn('[Withdraw] save payment detail failed:', err))
                } else if (isNameVerified) {
                    // Auto-update saved detail if the Moolre-verified name differs
                    const { data: existingSaved } = await (supabase as any)
                        .from('shop_payment_details')
                        .select('id, account_name')
                        .eq('shop_owner_id', user.id)
                        .or(`momo_number.eq.${momoNumber},account_number.eq.${momoNumber}`)
                        .single()

                    if (existingSaved && existingSaved.account_name !== verifiedAccountName) {
                        await (createAdminClient() as any)
                            .from('shop_payment_details')
                            .update({ account_name: verifiedAccountName })
                            .eq('id', existingSaved.id)
                            .eq('shop_owner_id', user.id)
                    }
                }

                // 10. Fire admin email alert — sub-agent withdrawals go straight to the
                // admin queue like any other shop withdrawal (no Lead/parent approval step).
                const shopName = shopProfile?.shop_name || 'Unknown Shop'
                await sendAdminShopWithdrawalRequestAlert({
                    shopName,
                    shopId: wallet.id,
                    ownerName: '',
                    accountName: verifiedAccountName,
                    amount: amountNum,
                    momoNumber: momoNumber,
                    network,
                    balanceSnapshot: newBalance,
                    date: new Date().toLocaleString('en-GB'),
                    isResubmission: false,
                }).catch(err => console.warn('[ShopAlert Email Hook Error]:', err))
            } catch (afterErr) {
                // Non-fatal — the withdrawal itself already succeeded.
                console.error('[Withdraw after() error]:', afterErr)
            }
        })

        return NextResponse.json({ success: true, newBalance, verifiedName: verifiedAccountName })

    } catch (error: any) {
        console.error('[Shop Withdraw API]', error)
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
    }
}
