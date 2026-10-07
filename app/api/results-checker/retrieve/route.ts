import { NextResponse } from 'next/server'
import { getResultsCheckerOrderForGuest } from '@/lib/results-checker-retrieval'
import {
    isValidResultsCheckerPhone,
    normalizeResultsCheckerPhone,
} from '@/lib/results-checker-utils'
import { checkRcRetrieveLimit } from '@/lib/rc-retrieve-ratelimit'

function getClientIp(request: Request): string {
    const forwardedFor = request.headers.get('x-forwarded-for') || ''
    return forwardedFor.split(',')[0]?.trim() || 'unknown'
}

export async function POST(req: Request) {
    try {
        const ip = getClientIp(req)
        const allowed = await checkRcRetrieveLimit(ip)

        if (!allowed) {
            return NextResponse.json(
                { error: 'Too many retrieval attempts. Please try again later.' },
                { status: 429 }
            )
        }

        const { reference, phone } = await req.json()

        if (!reference || !phone) {
            return NextResponse.json({ error: 'Reference and phone number are required' }, { status: 400 })
        }

        const normalizedPhone = normalizeResultsCheckerPhone(String(phone))
        if (!isValidResultsCheckerPhone(normalizedPhone)) {
            return NextResponse.json({ error: 'Enter a valid Ghana phone number' }, { status: 400 })
        }

        const normalizedReference = String(reference).trim()
        if (!normalizedReference) {
            return NextResponse.json({ error: 'Reference code is required' }, { status: 400 })
        }

        const result = await getResultsCheckerOrderForGuest(normalizedReference, normalizedPhone)
        if (!result) {
            return NextResponse.json(
                { error: 'Order not found or details do not match' },
                { status: 404 }
            )
        }

        return NextResponse.json(result)
    } catch (err) {
        console.error('[RC Retrieve API] Error:', err)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
