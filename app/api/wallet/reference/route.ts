import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'

// ── Dictionary of natural-looking payment reference words ─────
// These look like legitimate merchant payment references to
// prevent network providers from flagging them as suspicious.
const REFERENCE_WORDS = [
    'BOOK', 'GIFT', 'ITEM', 'PAY', 'BUY', 'RENT', 'BILL',
    'SHOP', 'CART', 'ORDER', 'FOOD', 'CASH', 'SEND', 'LOAD',
    'TOP', 'FUND', 'SAVE', 'PLAN', 'CARD', 'FUEL', 'FARE',
    'FEE', 'TIP', 'DEAL', 'SALE', 'PASS', 'TICKET', 'WATER',
    'LIGHT', 'DATA', 'AIRTIME', 'GOODS', 'SUPPLY', 'STOCK',
    'TRADE', 'OFFER', 'CREDIT', 'DEBIT', 'TRANSFER',
]

function generateCandidateCode(): string {
    const word = REFERENCE_WORDS[Math.floor(Math.random() * REFERENCE_WORDS.length)]
    // Format is fixed by REFERENCE_CODE_REGEX in app/api/webhooks/sms-forward/route.ts — keep the shape.
    // Generate a 2-3 digit number (10-999)
    const num = Math.floor(Math.random() * 900) + 10 // 10..909 → mostly 2-3 digits
    // Randomly place number before or after the word
    return Math.random() < 0.5 ? `${num}${word}` : `${word}${num}`
}

// ── GET: Fetch the authenticated user's reference code ───────
export async function GET() {
    try {
        const supabaseAuth = await createRouteClient()
        const { data: { user: authUser } } = await supabaseAuth.auth.getUser()

        if (!authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const supabaseAdmin = createServerClient()

        const { data: refData, error } = await (supabaseAdmin
            .from('user_payment_references') as any)
            .select('reference_code, is_active, created_at')
            .eq('user_id', authUser.id)
            .single()

        if (error && error.code !== 'PGRST116') {
            // PGRST116 = "no rows returned" — expected when user has no ref yet
            console.error('[Reference GET] DB error:', error.message)
            return NextResponse.json({ error: 'Failed to fetch reference' }, { status: 500 })
        }

        if (!refData) {
            // User has no reference yet
            return NextResponse.json({ reference: null })
        }

        return NextResponse.json({
            reference: {
                code: (refData as any).reference_code,
                is_active: (refData as any).is_active,
                created_at: (refData as any).created_at,
            }
        })
    } catch (error: any) {
        console.error('[Reference GET] Exception:', error.message)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

// ── POST: Generate a new reference code for the authenticated user ──
export async function POST() {
    try {
        const supabaseAuth = await createRouteClient()
        const { data: { user: authUser } } = await supabaseAuth.auth.getUser()

        if (!authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const supabaseAdmin = createServerClient()

        // Block if user already has an active reference
        const { data: existing } = await (supabaseAdmin
            .from('user_payment_references') as any)
            .select('reference_code, is_active')
            .eq('user_id', authUser.id)
            .single()

        if (existing) {
            return NextResponse.json({
                reference: {
                    code: (existing as any).reference_code,
                    is_active: (existing as any).is_active,
                }
            })
        }

        // ── Generate a unique code (bounded retry) ────────────
        // Each round: generate a candidate, probe for an existing owner, insert.
        // Capacity is only ~70k codes (39 words x ~900 numbers x 2 orderings), so
        // collisions are NOT negligible and get likelier as the user base grows.
        // The format cannot simply be widened: incoming SMS are matched against
        // REFERENCE_CODE_REGEX in app/api/webhooks/sms-forward/route.ts
        // (letters+digits, digits+letters, or 5 alphanumerics), so any code
        // must still satisfy that regex. Rounds are bounded, never recursive.
        const MAX_ROUNDS = 3

        for (let round = 0; round < MAX_ROUNDS; round++) {
            const candidate = generateCandidateCode()

            const { data: clash } = await (supabaseAdmin
                .from('user_payment_references') as any)
                .select('id')
                .eq('reference_code', candidate)
                .single()

            if (clash) {
                console.warn(`[Reference POST] Code "${candidate}" already taken (round ${round + 1}/${MAX_ROUNDS}), retrying...`)
                continue
            }

            // ── Insert the new reference ──────────────────────
            const { error: insertError } = await (supabaseAdmin
                .from('user_payment_references') as any)
                .insert({
                    user_id:        authUser.id,
                    reference_code: candidate,
                    is_active:      true,
                })

            if (insertError) {
                if (insertError.code === '23505') {
                    // VULN-07 fix: Distinguish which unique constraint was violated
                    const isUserDuplicate = insertError.message?.includes('user_id') ||
                        insertError.details?.includes('user_id')

                    if (isUserDuplicate) {
                        // Another concurrent request for the SAME user already inserted — fetch and return it
                        const { data: raceData } = await (supabaseAdmin
                            .from('user_payment_references') as any)
                            .select('reference_code, is_active')
                            .eq('user_id', authUser.id)
                            .single()

                        if (raceData) {
                            return NextResponse.json({
                                reference: {
                                    code: (raceData as any).reference_code,
                                    is_active: (raceData as any).is_active,
                                }
                            })
                        }
                    }

                    // reference_code collision with another user (lost a race after the
                    // probe) — move on to the next round with a fresh candidate.
                    console.warn(`[Reference POST] Insert collision for "${candidate}" (round ${round + 1}/${MAX_ROUNDS}), retrying...`)
                    continue
                }
                console.error('[Reference POST] Insert error:', insertError.message)
                return NextResponse.json({ error: 'Failed to save reference. Please try again.' }, { status: 500 })
            }

            console.log(`[Reference POST] Generated code ${candidate} for user ${authUser.id}`)
            return NextResponse.json({
                reference: {
                    code: candidate,
                    is_active: true,
                }
            })
        }

        console.error('[Reference POST] Could not generate unique code after', MAX_ROUNDS, 'rounds')
        return NextResponse.json({ error: 'Failed to generate a unique reference. Please try again.' }, { status: 500 })
    } catch (error: any) {
        console.error('[Reference POST] Exception:', error.message)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
