import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { cookies } from 'next/headers'
import { z } from 'zod'
import { validateAccountName, MOOLRE_CHANNEL_MAP } from '@/lib/moolre-transfer-service'
import { resolveNameSingle } from '@/lib/momo-verify'
import { normalizeGhanaPhone } from '@/lib/sms-service'
import { phoneSchema } from '@/lib/validation'
import { consumeNameLookupQuota } from '@/lib/payout-name-lookup-quota'

const validateSchema = z.object({
    phone: z.string().min(8, 'Number is too short').max(30, 'Number is too long').regex(/^\d+$/, 'Must contain only digits'),
    network: z.string().min(1, 'Network is required'),
    bankId: z.string().optional(),
}).superRefine((data, ctx) => {
    if (data.network !== 'Bank') {
        if (!phoneSchema.safeParse(data.phone).success) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['phone'],
                message: 'Must be a valid Ghanaian MoMo number (e.g. 0241234567)'
            })
        }
    }
})

export async function POST(req: NextRequest) {
    try {
        // 1. Auth check — any authenticated shop owner (any role) can validate their payout account
        const cookieStore = await cookies()
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const { data: dbUser } = await supabase
            .from('users')
            .select('role')
            .eq('id', user.id)
            .single()

        if (!dbUser) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }

        // 2. Validate input shape
        const body = await req.json()
        const parsed = validateSchema.safeParse(body)
        if (!parsed.success) {
            return NextResponse.json(
                { error: 'Invalid request', details: parsed.error.errors.map(e => e.message) },
                { status: 400 }
            )
        }

        const { phone, network, bankId } = parsed.data

        // 2b. Per-user daily cap (A8). Counts valid-shape attempts so probing
        //     burns quota too. Shared with /api/shop/payment-details.
        if (!(await consumeNameLookupQuota(user.id))) {
            return NextResponse.json(
                { success: false, error: 'Daily account-verification limit reached. Please try again tomorrow or contact support.' },
                { status: 429 }
            )
        }

        // 2c. Attributable audit trail — who resolved which number (masked).
        //     Makes any abuse detectable and tied to a specific account.
        console.info('[validate-account][audit]', JSON.stringify({
            userId: user.id,
            network,
            phoneLast4: phone.slice(-4),
            at: new Date().toISOString(),
        }))

        // 3. Map network string to Moolre channel ID
        const channel = MOOLRE_CHANNEL_MAP[network]
        if (channel === undefined) {
            return NextResponse.json({ error: `Unsupported network: ${network}` }, { status: 400 })
        }

        // 4a. MoMo numbers: multi-provider resolution (Moolre first, Paystack
        //     fallback) so a Moolre outage no longer forces manual name entry.
        if (network !== 'Bank') {
            const normalized = normalizeGhanaPhone(phone)
            if (normalized) {
                const resolved = await resolveNameSingle(normalized)
                if (resolved?.fullName) {
                    return NextResponse.json({ success: true, name: resolved.fullName })
                }
            }
            return NextResponse.json(
                { success: false, error: 'Could not verify account name. Please check the number and try again.' },
                { status: 200 } // Return 200 so client handles it as a validation failure, not a crash
            )
        }

        // 4b. Bank accounts: Moolre only (Paystack fallback covers MoMo prefixes,
        //     not Ghanaian bank account numbers).
        const result = await validateAccountName(phone, channel, bankId)

        if (!result.success || !result.name) {
            // The service has already mapped upstream errors to safe,
            // user-facing strings (timeouts, rejections, etc.), so we can
            // forward result.error directly here.
            return NextResponse.json(
                { success: false, error: result.error || 'Could not verify account name. Please check the number and try again.' },
                { status: 200 }
            )
        }

        // 5. Return only the verified name — never the raw provider response
        return NextResponse.json({ success: true, name: result.name })

    } catch (error: any) {
        console.error('[validate-account API]', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
