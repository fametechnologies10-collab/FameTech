import { NextRequest, NextResponse, after } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { z } from 'zod'
import { phoneSchema } from '@/lib/validation'
import { validateAccountName, MOOLRE_CHANNEL_MAP } from '@/lib/moolre-transfer-service'
import { computeCommissionWithdrawalFee, getCommissionMinWithdrawal } from '@/lib/commission-wallet'
import { sendAdminShopWithdrawalRequestAlert } from '@/lib/email-service'
import { consumeRateLimit } from '@/lib/simple-rate-limit'

// Manual name fallback — same allowlist as app/api/shop/withdraw/route.ts, used
// ONLY when Moolre's live name lookup fails, so this feature has the same
// verify-then-manual-fallback shape as the sibling shop withdrawal flow. There is
// no Paystack name-verification endpoint anywhere in this codebase — Paystack
// Transfers only registers a recipient with a name YOU supply, it never confirms
// one; Moolre is the sole live name-verification source, same as it is for shops.
const MANUAL_NAME_REGEX = /^[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ '.\-]{1,99}$/
const MANUAL_NAME_BLOCK = /(script|javascript:|onerror|onload|onclick|onmouseover|eval\(|data:|<|>|&lt|&gt)/i
const manualAccountNameSchema = z.string()
    .trim()
    .min(2, 'Name must be at least 2 characters')
    .max(100, 'Name must be 100 characters or less')
    .regex(MANUAL_NAME_REGEX, 'Only letters, spaces, hyphens, apostrophes and periods allowed')
    .refine((v: string) => !/\s{2,}/.test(v), 'No consecutive spaces allowed')
    .refine((v: string) => !MANUAL_NAME_BLOCK.test(v), 'Invalid characters detected')

// MoMo-only — no bank branch. Paystack Transfers (lib/paystack-transfer-service.ts)
// only supports mobile_money recipients, so there is nothing to route a bank
// payout through even if we accepted one here.
const withdrawSchema = z.object({
    amount: z.union([z.number().positive(), z.string().regex(/^\d+(\.\d{1,2})?$/).transform(Number)]),
    momoNumber: z.string().min(8).max(30),
    network: z.enum(['MTN MoMo', 'Telecel Cash', 'AirtelTigo Money']),
    manualAccountName: manualAccountNameSchema.optional(),
}).superRefine((data, ctx) => {
    if (!/^\d+$/.test(data.momoNumber)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['momoNumber'], message: 'MoMo number must contain only digits' })
    } else if (!phoneSchema.safeParse(data.momoNumber).success) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['momoNumber'], message: 'Must be a valid Ghanaian MoMo number' })
    }
    // M4: the regex above only guards the string branch of the amount union —
    // z.number().positive() lets a raw sub-pesewa value like 10.005 through.
    // Reject anything that doesn't round cleanly to whole pesewas.
    const cents = data.amount * 100
    if (Math.abs(cents - Math.round(cents)) > 1e-9) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['amount'], message: 'Amount must have at most 2 decimal places' })
    }
})

export async function POST(req: NextRequest) {
    try {
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const rl = consumeRateLimit(`commission-withdraw:${user.id}`, 5, 60_000)
        if (!rl.allowed) {
            return NextResponse.json({ success: false, error: `Rate limit exceeded. Retry in ${Math.ceil(rl.retryAfterMs / 1000)}s` }, { status: 429 })
        }

        const body = await req.json()
        const validation = withdrawSchema.safeParse(body)
        if (!validation.success) {
            return NextResponse.json({ success: false, error: validation.error.errors.map(e => e.message).join('; ') }, { status: 400 })
        }
        // M4: round to the nearest pesewa (the superRefine above already rejected anything
        // that doesn't round cleanly) so the exact same value flows into the fee calc and
        // the RPC — no drift between what the user was quoted and what gets debited.
        const amountNum = Math.round(validation.data.amount * 100) / 100
        const momoNumber = validation.data.momoNumber.trim()
        const network = validation.data.network
        const manualAccountName = validation.data.manualAccountName
            ? validation.data.manualAccountName.replace(/\s+/g, ' ')
            : undefined

        const admin = createServerClient() as any
        const [walletRes, settingsRes] = await Promise.all([
            // M5: pull the owner's name off this existing query (join, not a new round trip)
            // so the admin withdrawal alert can identify who requested the payout.
            admin.from('commission_wallets').select('id, balance, users:owner_id(first_name, last_name)').eq('owner_id', user.id).single(),
            admin.from('admin_settings').select('key, value').in('key', ['commission_withdrawal_fee_percent', 'commission_withdrawal_fee_flat', 'commission_min_withdrawal_amount']),
        ])
        if (!walletRes.data) return NextResponse.json({ success: false, error: 'You do not have a commission wallet yet' }, { status: 404 })
        const wallet = walletRes.data
        const ownerName = `${wallet.users?.first_name || ''} ${wallet.users?.last_name || ''}`.trim()

        const settingsMap: Record<string, any> = {}
        for (const s of (settingsRes.data || [])) settingsMap[s.key] = s.value
        const minWithdrawal = getCommissionMinWithdrawal(settingsMap)
        if (amountNum < minWithdrawal) {
            return NextResponse.json({ success: false, error: `Minimum withdrawal is GH₵${minWithdrawal.toFixed(2)}` }, { status: 400 })
        }
        if (amountNum > wallet.balance) {
            return NextResponse.json({ success: false, error: 'Insufficient commission wallet balance' }, { status: 400 })
        }

        const { fee, netAmount } = computeCommissionWithdrawalFee(amountNum, settingsMap)
        if (netAmount <= 0) {
            return NextResponse.json({ success: false, error: `Amount too low to cover the GH₵${fee.toFixed(2)} processing fee` }, { status: 400 })
        }

        // Resolve the account name: Moolre live lookup first; a manual fallback
        // (flagged unverified for admin review) only when Moolre fails and the
        // caller supplied one — mirrors app/api/shop/withdraw/route.ts exactly.
        const channel = MOOLRE_CHANNEL_MAP[network]
        const nameValidation = await validateAccountName(momoNumber, channel)
        let verifiedAccountName: string
        let isNameVerified: boolean
        if (nameValidation.success && nameValidation.name) {
            verifiedAccountName = nameValidation.name
            isNameVerified = true
        } else if (manualAccountName) {
            verifiedAccountName = manualAccountName
            isNameVerified = false
            console.warn(`[commission/withdraw] User ${user.id} used manual name fallback after Moolre rejection:`, nameValidation.error)
        } else {
            return NextResponse.json({ success: false, error: nameValidation.error || 'Could not verify account name' }, { status: 400 })
        }

        const { data: rpcResult, error: rpcError } = await admin.rpc('process_commission_withdrawal', {
            p_wallet_id: wallet.id,
            p_amount: amountNum,
            p_fee: fee,
            p_net_amount: netAmount,
            p_account_name: verifiedAccountName,
            p_momo_number: momoNumber,
            p_network: network,
            p_description: isNameVerified
                ? `Commission withdrawal request — ${network}: ${momoNumber}`
                : `[UNVERIFIED-NAME] Commission withdrawal request — ${network}: ${momoNumber}`,
            p_owner_id: user.id,
            p_name_verified: isNameVerified,
        })
        if (rpcError) {
            // Thrown/DB-level error — never business logic. Log server-side, 500.
            console.error('[Commission Withdraw] RPC error:', rpcError)
            return NextResponse.json({ success: false, error: 'Failed to process withdrawal' }, { status: 500 })
        }
        if (!rpcResult?.success) {
            // RPC-returned business failure — map each known code distinctly.
            const code = rpcResult?.error
            const msg = code === 'wallet_not_found'
                ? 'Commission wallet not found'
                : code === 'invalid_amount'
                    ? 'Invalid withdrawal amount'
                    : code === 'insufficient_balance'
                        ? 'Insufficient commission wallet balance'
                        : 'Failed to process withdrawal'
            return NextResponse.json({ success: false, error: msg }, { status: 400 })
        }

        after(async () => {
            try {
                await sendAdminShopWithdrawalRequestAlert({
                    shopName: 'Commission Wallet',
                    shopId: wallet.id,
                    ownerName,
                    accountName: verifiedAccountName,
                    amount: amountNum,
                    momoNumber,
                    network,
                    balanceSnapshot: wallet.balance - amountNum,
                    date: new Date().toLocaleString('en-GB'),
                    isResubmission: false,
                })
            } catch (err) {
                console.error('[Commission Withdraw] admin alert failed:', err)
            }
        })

        // M6: the RPC doesn't return a post-debit balance, and `wallet.balance` here is a
        // pre-RPC read — returning `wallet.balance - amountNum` would be a computed guess on
        // a money endpoint (a concurrent debit/credit could make it wrong). Omit it instead.
        return NextResponse.json({ success: true, data: { verified_name: verifiedAccountName } })
    } catch (error: any) {
        console.error('[Commission Withdraw] Exception:', error.message)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}
