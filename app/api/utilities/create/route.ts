import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { waitUntil } from '@vercel/functions'
import { consumeRateLimit } from '@/lib/simple-rate-limit'
import { parseSettingNumber } from '@/lib/paystack-fees'
import { isUtilityBiller, UTILITY_BILLERS, makeUtilityReference } from '@/lib/hubtel-utility/billers'
import { toMsisdn233 } from '@/lib/hubtel-commission-service'
import { dispatchUtilityFulfillment } from '@/lib/utility-fulfillment'

export const dynamic = 'force-dynamic'

const MAX_ACCOUNT_LEN = 30
const MAX_PHONE_LEN = 30
const MAX_ACCOUNT_NAME_LEN = 80
const MAX_SNAPSHOT_BYTES = 8 * 1024

export async function POST(request: NextRequest) {
    try {
        const supabaseUserClient = await createRouteClient()
        const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()

        if (authError || !authUser) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
        }

        const userId = authUser.id

        // ── Rate limit ───────────────────────────────────────────────────────
        // Runs immediately after the auth guard, before any DB read — an attacker
        // spamming this route can't burn Supabase reads/RPCs before being throttled.
        const rl = consumeRateLimit(`util-create:${userId}`, 6, 60_000)
        if (!rl.allowed) {
            return NextResponse.json(
                { success: false, error: `Too many requests. Try again in ${Math.ceil(rl.retryAfterMs / 1000)}s.` },
                { status: 429 },
            )
        }

        const supabase = createServerClient()

        let body: any
        try {
            body = await request.json()
        } catch {
            return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 })
        }

        const { biller, account, phone, amount, accountName, lookupSnapshot, client_reference } = body || {}

        // ── Structural validation (no DB access) ────────────────────────────
        if (!isUtilityBiller(biller)) {
            return NextResponse.json({ success: false, error: 'Invalid biller' }, { status: 400 })
        }
        const def = UTILITY_BILLERS[biller]

        const trimmedAccount = typeof account === 'string' ? account.trim() : ''
        if (!trimmedAccount) {
            return NextResponse.json({ success: false, error: `${def.accountLabel} is required` }, { status: 400 })
        }
        if (trimmedAccount.length > MAX_ACCOUNT_LEN) {
            return NextResponse.json({ success: false, error: `${def.accountLabel} is too long` }, { status: 400 })
        }

        const trimmedPhone = typeof phone === 'string' ? phone.trim() : ''
        if (trimmedPhone.length > MAX_PHONE_LEN) {
            return NextResponse.json({ success: false, error: 'Phone number is too long' }, { status: 400 })
        }
        if ((biller === 'ecg' || biller === 'ghana_water') && !trimmedPhone) {
            return NextResponse.json({ success: false, error: `${def.label} requires a customer phone number` }, { status: 400 })
        }
        const normalizedPhone = trimmedPhone ? toMsisdn233(trimmedPhone) : null

        let trimmedAccountName: string | null = null
        if (accountName !== undefined && accountName !== null) {
            if (typeof accountName !== 'string') {
                return NextResponse.json({ success: false, error: 'Invalid account name' }, { status: 400 })
            }
            trimmedAccountName = accountName.trim().slice(0, MAX_ACCOUNT_NAME_LEN) || null
        }

        let snapshot: Record<string, unknown> | null = null
        if (lookupSnapshot !== undefined && lookupSnapshot !== null) {
            if (typeof lookupSnapshot !== 'object' || Array.isArray(lookupSnapshot)) {
                return NextResponse.json({ success: false, error: 'Invalid lookup snapshot' }, { status: 400 })
            }
            if (Buffer.byteLength(JSON.stringify(lookupSnapshot), 'utf8') > MAX_SNAPSHOT_BYTES) {
                return NextResponse.json({ success: false, error: 'Lookup snapshot too large' }, { status: 400 })
            }
            // Defense-in-depth: never persist a client-supplied sessionId, forged or otherwise —
            // the dispatch pipeline always fetches its own fresh Ghana Water session at pay-time.
            const { sessionId: _sessionId, ...rest } = lookupSnapshot as Record<string, unknown>
            snapshot = rest
        }

        // Optional client replay reference — an idempotency key so a client that timed out
        // waiting for a response can safely retry without triggering a second debit.
        // Empty string is treated as absent; anything else must be ≤64 chars of [A-Za-z0-9._-].
        let clientRef: string | null = null
        if (client_reference !== undefined && client_reference !== null) {
            if (typeof client_reference !== 'string') {
                return NextResponse.json({ success: false, error: 'Invalid client reference' }, { status: 400 })
            }
            const trimmedRef = client_reference.trim()
            if (trimmedRef) {
                if (trimmedRef.length > 64 || !/^[A-Za-z0-9._-]+$/.test(trimmedRef)) {
                    return NextResponse.json({ success: false, error: 'Invalid client reference' }, { status: 400 })
                }
                clientRef = trimmedRef
            }
        }

        const parsedAmount = Number(amount)
        if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
            return NextResponse.json({ success: false, error: 'Invalid amount' }, { status: 400 })
        }
        const roundedAmount = Math.round(parsedAmount * 100) / 100

        // ── User status + gates + amount-limit settings (single round trip) ──
        const [userResult, settingsResult] = await Promise.all([
            (supabase.from('users') as any).select('status, email').eq('id', userId).single(),
            (supabase.from('admin_settings') as any).select('key, value').in('key', [
                'utility_bills_enabled', 'hubtel_utility_billers', 'utility_min_amount', 'utility_max_amount',
            ]),
        ])

        if (userResult.error || !userResult.data) {
            return NextResponse.json({ success: false, error: 'User not found' }, { status: 404 })
        }
        // Server-side suspension enforcement — the dashboard gate alone is bypassable.
        if ((userResult.data as any)?.status === 'suspended') {
            return NextResponse.json(
                { success: false, error: 'Your account is currently suspended. Please contact support.' },
                { status: 403 },
            )
        }

        const settingsMap: Record<string, any> = {}
        for (const s of (settingsResult.data || [])) settingsMap[s.key] = s.value

        if (settingsMap['utility_bills_enabled'] !== 'true') {
            return NextResponse.json({ success: false, error: 'Utility bill payments are currently unavailable' }, { status: 503 })
        }
        const billersMap = settingsMap['hubtel_utility_billers']
        if (!billersMap || typeof billersMap !== 'object' || Array.isArray(billersMap) || billersMap[biller] !== true) {
            return NextResponse.json({ success: false, error: `${def.label} is currently unavailable` }, { status: 503 })
        }

        const minAmount = parseSettingNumber(settingsMap['utility_min_amount'], 1)
        const maxAmount = parseSettingNumber(settingsMap['utility_max_amount'], 1000)
        if (roundedAmount < minAmount) {
            return NextResponse.json({ success: false, error: `Minimum amount is GHS ${minAmount.toFixed(2)}` }, { status: 400 })
        }
        if (roundedAmount > maxAmount) {
            return NextResponse.json({ success: false, error: `Maximum amount is GHS ${maxAmount.toFixed(2)}` }, { status: 400 })
        }

        // ── 30-second duplicate-order guard ───────────────────────────────────
        // Mirrors app/api/airtime/create/route.ts lines 141-156 (same window, same
        // no-status-filter semantics, 409 + isDuplicate), keyed on this feature's
        // identity tuple: user + biller + account + amount. Runs BEFORE the debit.
        // .limit(1) keeps the guard closed even if 2+ recent duplicates exist
        // (.maybeSingle() alone errors on multi-row and would fail the guard open).
        const thirtySecondsAgo = new Date(Date.now() - 30000).toISOString()
        const { data: recentOrder } = await (supabase as any).from('utility_orders')
            .select('id, reference_code')
            .eq('user_id', userId)
            .eq('biller', biller)
            .eq('account_number', trimmedAccount)
            .eq('amount', roundedAmount)
            .gte('created_at', thirtySecondsAgo)
            .limit(1)
            .maybeSingle()

        if (recentOrder) {
            return NextResponse.json({
                success: false,
                error: 'Duplicate order detected. Please wait 30 seconds before placing the same order again.',
                isDuplicate: true,
            }, { status: 409 })
        }

        // ── Client replay reference (idempotency) ─────────────────────────────
        // Mirrors app/api/airtime/create/route.ts lines 158-172, with one deliberate
        // hardening: the check is SCOPED TO THE CALLER (user_id) — never a global
        // reference probe. On a hit, return the existing order and do NOT debit again.
        // Runs BEFORE the debit.
        if (clientRef) {
            const walletRef = `WALLET-${clientRef}`
            const { data: existingOrder } = await (supabase as any).from('utility_orders')
                .select('id, reference_code, status')
                .eq('user_id', userId)
                .eq('payment_reference', walletRef)
                .limit(1)
                .maybeSingle()

            if (existingOrder) {
                return NextResponse.json({
                    success: true,
                    data: {
                        reference: existingOrder.reference_code,
                        order_id: existingOrder.id,
                        status: existingOrder.status,
                        already_processed: true,
                    },
                })
            }
        }

        // ── Atomic wallet deduction ───────────────────────────────────────────
        const { data: deductResult, error: deductError } = await (supabase as any).rpc('deduct_wallet_balance', {
            p_user_id: userId,
            p_amount: roundedAmount,
        })

        if (deductError) {
            if (deductError.message?.includes('INSUFFICIENT_BALANCE')) {
                return NextResponse.json({ success: false, error: 'Insufficient wallet balance' }, { status: 400 })
            }
            console.error('[Utilities Create] Wallet deduction error:', deductError)
            return NextResponse.json({ success: false, error: 'Failed to process payment' }, { status: 500 })
        }

        const walletRow = deductResult?.[0] || deductResult
        const walletId = walletRow?.wallet_id
        const newBalance = walletRow?.new_balance

        if (!walletId) {
            // deduct_wallet_balance RAISES INSUFFICIENT_BALANCE whenever no wallet row was
            // updated (covers both no-wallet and low balance — see 20260219_atomic_wallet_deduction.sql),
            // so reaching here with a non-error result means the debit COMMITTED but the returned
            // row didn't parse: a debit with no order. Compensating refund (same RPC as the
            // insert-failure path) before returning, or the user silently loses the money.
            const { error: refundError } = await (supabase as any).rpc('credit_wallet_balance', {
                p_user_id: userId,
                p_amount: roundedAmount,
            })
            if (refundError) {
                console.error('[Utilities Create] CRITICAL: refund failed after walletless deduction; manual reconciliation required:', refundError)
            }
            return NextResponse.json({ success: false, error: 'Wallet not found' }, { status: 404 })
        }

        const referenceCode = makeUtilityReference(biller)

        // ── Create utility order ───────────────────────────────────────────────
        const { data: order, error: orderError } = await (supabase as any).from('utility_orders')
            .insert({
                user_id: userId,
                source: 'dashboard',
                biller,
                account_number: trimmedAccount,
                account_name: trimmedAccountName,
                destination_phone: normalizedPhone,
                customer_email: (userResult.data as any)?.email || null,
                amount: roundedAmount,
                payment_method: 'wallet',
                payment_status: 'paid',
                status: 'pending',
                reference_code: referenceCode,
                // WALLET-<client_reference> namespaces wallet replay keys away from real
                // payment-gateway references; NULL when the client sent no idempotency key.
                payment_reference: clientRef ? `WALLET-${clientRef}` : null,
                lookup_snapshot: snapshot,
            })
            .select()
            .single()

        if (orderError) {
            console.error('[Utilities Create] Order creation error:', orderError)
            // Atomic compensating refund — never a raw absolute write from a cached snapshot
            // (mirrors app/api/airtime/create/route.ts's insert-failure recovery path).
            const { error: refundError } = await (supabase as any).rpc('credit_wallet_balance', {
                p_user_id: userId,
                p_amount: roundedAmount,
            })
            if (refundError) {
                console.error('[Utilities Create] CRITICAL: refund failed after order-insert failure; manual reconciliation required:', refundError)
            }
            return NextResponse.json({ success: false, error: 'Failed to create order' }, { status: 500 })
        }

        const orderId = (order as any).id

        // ── Wallet transaction record (fire-and-forget) ────────────────────────
        // source: 'utility' — wallet_transactions_source_check was widened to include 'utility' by
        // migration 20260710_utility_hardening; the developer-API pay route
        // (lib/api-handlers/utilities-pay.ts) already uses it. Matches the ledger source to the
        // actual product instead of the stale 'purchase' fallback.
        ;(supabase.from('wallet_transactions') as any).insert({
            wallet_id: walletId,
            user_id: userId,
            type: 'debit',
            amount: roundedAmount,
            description: `${def.label}: GHS ${roundedAmount.toFixed(2)} for ${trimmedAccount}`,
            reference: referenceCode,
            source: 'utility',
            status: 'completed',
        }).then(() => {}).catch((e: any) => console.error('[Utilities Create] Tx insert error:', e))

        // ── B7 auto-save ("My Accounts") — fire-and-forget, MUST NEVER block or fail the
        // purchase. Failures are logged only; the order above is already committed. ──────
        waitUntil((async () => {
            try {
                const { error: saveError } = await (supabase as any).from('utility_saved_accounts')
                    .upsert(
                        {
                            user_id: userId,
                            biller,
                            account_number: trimmedAccount,
                            account_name: trimmedAccountName,
                            destination_phone: normalizedPhone,
                            last_paid_at: new Date().toISOString(),
                            last_amount: roundedAmount,
                        },
                        { onConflict: 'user_id,biller,account_number' },
                    )
                if (saveError) console.error('[Utilities Create] Auto-save failed (non-blocking):', saveError)
            } catch (e) {
                console.error('[Utilities Create] Auto-save threw (non-blocking):', e)
            }
        })())

        // ── Auto-fulfill via Hubtel Commission Services (no-op if kill-switch off) ──────
        waitUntil((async () => {
            try {
                await dispatchUtilityFulfillment(orderId)
            } catch (e) {
                console.error('[Utilities Create] auto-dispatch failed:', e)
            }
        })())

        return NextResponse.json({
            success: true,
            data: {
                reference: referenceCode,
                order_id: orderId,
                new_balance: newBalance,
                status: 'pending',
            },
        })
    } catch (error) {
        console.error('[Utilities Create] Unexpected error:', error)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}
