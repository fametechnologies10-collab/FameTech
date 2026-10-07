import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { normalizeGhanaPhone } from '@/lib/sms-service'
import { resolveNameSingle, getNetworkMeta } from '@/lib/momo-verify'

async function requireAdmin() {
    const client = await createRouteClient()
    const { data: { user }, error } = await client.auth.getUser()
    if (error || !user) return { error: 'Unauthorized', status: 401 }
    const { data } = await client.from('users').select('role').eq('id', user.id).single()
    if (data?.role !== 'admin') return { error: 'Forbidden - Admin only', status: 403 }
    return { user }
}

/**
 * GET /api/admin/sms-contacts/verify?phone=0244000001
 *
 * Resolves the registered MoMo account name for a Ghana phone number.
 * Tries Moolre first (native Ghana gateway), then Paystack as fallback.
 * Returns which provider resolved it so the UI can display the badge correctly.
 *
 * Response (valid):
 *   { valid: true, name, firstName, lastName, network, provider, phone }
 * Response (not found):
 *   { valid: false, network, phone, error }
 * Response (bad number):
 *   { valid: false, error }
 */
export async function GET(request: NextRequest) {
    try {
        const auth = await requireAdmin()
        if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

        const rawPhone = request.nextUrl.searchParams.get('phone')?.trim() ?? ''
        if (!rawPhone) return NextResponse.json({ error: 'phone query param is required' }, { status: 400 })

        const normalized = normalizeGhanaPhone(rawPhone)
        if (!normalized) {
            return NextResponse.json({ valid: false, error: 'Invalid Ghana phone number format' })
        }

        const meta = getNetworkMeta(normalized)
        if (!meta) {
            return NextResponse.json({
                valid: false,
                phone: normalized,
                error: 'Unrecognised network prefix — only MTN, Telecel, and AT supported',
            })
        }

        // Try Moolre → Paystack → (Hubtel when available)
        const result = await resolveNameSingle(normalized)

        if (result) {
            return NextResponse.json({
                valid:     true,
                name:      result.fullName,
                firstName: result.firstName,
                lastName:  result.lastName,
                network:   result.network,
                provider:  result.provider,
                phone:     normalized,
            })
        }

        return NextResponse.json({
            valid:   false,
            network: meta.label,
            phone:   normalized,
            error:   'Could not resolve account name — number may not have a registered MoMo wallet',
        })
    } catch (e: any) {
        console.error('[SMS Verify]', e)
        return NextResponse.json({ error: e.message || 'Internal server error' }, { status: 500 })
    }
}
