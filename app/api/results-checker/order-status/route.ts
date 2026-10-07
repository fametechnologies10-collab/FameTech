import { NextResponse } from 'next/server'
import { getResultsCheckerOrderForGuest } from '@/lib/results-checker-retrieval'
import {
    isValidResultsCheckerPhone,
    normalizeResultsCheckerPhone,
} from '@/lib/results-checker-utils'
import { consumeRateLimit } from '@/lib/simple-rate-limit'

const RATE_LIMIT_WINDOW = 10 * 60 * 1000
const MAX_REQUESTS = 5

function getClientIp(request: Request): string {
    const forwardedFor = request.headers.get('x-forwarded-for') || ''
    return forwardedFor.split(',')[0]?.trim() || 'unknown'
}

export async function POST(req: Request) {
    try {
        const ip = getClientIp(req)
        const rateLimit = consumeRateLimit(`rc-order-status:${ip}`, MAX_REQUESTS, RATE_LIMIT_WINDOW)
        if (!rateLimit.allowed) {
            return NextResponse.json({ error: 'Too many requests. Please try again later.' }, { status: 429 })
        }

        const { reference, phone } = await req.json()
        if (!reference || !phone) {
            return NextResponse.json({ error: 'Reference and phone number are required' }, { status: 400 })
        }

        const normalizedPhone = normalizeResultsCheckerPhone(String(phone))
        if (!isValidResultsCheckerPhone(normalizedPhone)) {
            return NextResponse.json({ error: 'Enter a valid Ghana phone number' }, { status: 400 })
        }

        const result = await getResultsCheckerOrderForGuest(String(reference).trim(), normalizedPhone)
        if (!result) {
            return NextResponse.json({ error: 'Order not found or invalid details' }, { status: 404 })
        }

        // SECURITY: this is a STATUS endpoint — it must NEVER return PINs/serials or inventory_ids.
        // The PIN reveal goes ONLY through /api/results-checker/retrieve (one rate-limited surface).
        // Previously this returned the full result incl. `vouchers`, giving an attacker a second
        // PIN-returning endpoint with its own rate-limit budget.
        const { order } = result
        return NextResponse.json({
            reference_code: order.reference_code,
            type_name:      order.type_name,
            quantity:       order.quantity,
            status:         order.status,
            payment_status: order.payment_status,
            created_at:     order.created_at,
        })
    } catch (err) {
        console.error('[RC Order Status API] Error:', err)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
