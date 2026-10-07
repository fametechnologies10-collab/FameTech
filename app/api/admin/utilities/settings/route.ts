import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { UTILITY_BILLER_KEYS } from '@/lib/hubtel-utility/billers'

/**
 * Admin Utilities Settings — mirrors app/api/admin/airtime/settings/route.ts's
 * gating, client construction, and settings-upsert idiom.
 *
 * NOTE on the admin gate: the task brief for this route named `validateAdminAccess`
 * (lib/auth-utils) as the helper to match. Reading app/api/admin/airtime/settings/route.ts
 * and every sibling app/api/admin/airtime/* route in full shows none of them import
 * lib/auth-utils — they all use an identical LOCAL `verifyAdmin()` helper (auth.getUser()
 * then a `users.role` lookup, allowing 'admin' and 'sub-admin' uniformly, no path
 * restriction). `validateAdminAccess`'s `allowSubAdmin` branch additionally hard-restricts
 * sub-admins to paths starting with `/api/admin/orders` or `/api/admin/batches` — using it
 * here verbatim would silently 403 every sub-admin on `/api/admin/utilities/*`, which is
 * NOT what the airtime sibling routes do. Per the Global Constraint to mirror the airtime
 * routes' gating EXACTLY, this file copies their actual local `verifyAdmin()` pattern
 * instead of the brief's assumed helper. Flagged in the task report.
 */

// The 8 utility settings keys (ALLOWLIST for writes via the generic key path).
// `hubtel_commission_paused` is intentionally NOT in this list: it is a flag SHARED
// with airtime auto-fulfillment (see lib/utility-fulfillment.ts's pauseFloat() and
// lib/airtime-fulfillment.ts), so this route only ever CLEARS it via the dedicated
// `resume` action below — never sets it arbitrarily. (Airtime's settings route treats
// it as an ordinary allowlisted key instead; this route deliberately narrows that,
// per this task's brief.)
const UTILITY_SETTING_KEYS = [
    'utility_bills_enabled',
    'utility_auto_fulfillment_enabled',
    'hubtel_utility_billers',
    'storefront_utilities_enabled',
    'ussd_utility_enabled',
    'utility_commission_partner_percent',
    'utility_min_amount',
    'utility_max_amount',
    'commission_withdrawal_fee_percent',
    'commission_withdrawal_fee_flat',
    'commission_min_withdrawal_amount',
    'commission_transfer_enabled',
    'hubtel_receive_enabled_utility',
] as const

// Subset of UTILITY_SETTING_KEYS that governs real Paystack payout economics —
// full-admin only (see the POST gate below), unlike every other key in the list.
const COMMISSION_PAYOUT_SETTING_KEYS = new Set<string>([
    'commission_withdrawal_fee_percent',
    'commission_withdrawal_fee_flat',
    'commission_min_withdrawal_amount',
    'commission_transfer_enabled',
])

const TOGGLE_KEYS = new Set<string>([
    'utility_bills_enabled',
    'utility_auto_fulfillment_enabled',
    'storefront_utilities_enabled',
    'ussd_utility_enabled',
    'commission_transfer_enabled',
    'hubtel_receive_enabled_utility',
])

async function verifyAdmin(supabaseUserClient: any) {
    const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()
    if (authError || !authUser) return null
    const supabase = createServerClient()
    const { data: user } = await supabase.from('users').select('role').eq('id', authUser.id).single()
    const role = (user as any)?.role
    if (!['admin', 'sub-admin'].includes(role)) return null
    return { userId: authUser.id, role }
}

function toToggleString(value: unknown): 'true' | 'false' | null {
    if (value === true || value === 'true') return 'true'
    if (value === false || value === 'false') return 'false'
    return null
}

function toFiniteNumber(value: unknown): number | null {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null
    if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value)
        return Number.isFinite(n) ? n : null
    }
    return null
}

/** Object with EXACTLY the 5 biller keys and boolean values — no extra/missing keys. */
function isValidBillersMap(value: unknown): value is Record<string, boolean> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const v = value as Record<string, unknown>
    if (Object.keys(v).length !== UTILITY_BILLER_KEYS.length) return false
    return UTILITY_BILLER_KEYS.every((k) => typeof v[k] === 'boolean')
}

export async function GET(request: NextRequest) {
    try {
        const supabaseUserClient = await createRouteClient()
        const admin = await verifyAdmin(supabaseUserClient)
        if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const supabase = createServerClient()
        const { data, error } = await (supabase.from('admin_settings') as any)
            .select('key, value')
            .in('key', [...UTILITY_SETTING_KEYS, 'hubtel_commission_paused'])

        if (error) return NextResponse.json({ error: error.message }, { status: 500 })

        const settings: Record<string, any> = {}
        for (const row of (data || [])) settings[row.key] = row.value

        return NextResponse.json({ settings })
    } catch (error) {
        console.error('[Admin Utilities Settings] GET error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

export async function POST(request: NextRequest) {
    try {
        const supabaseUserClient = await createRouteClient()
        const admin = await verifyAdmin(supabaseUserClient)
        if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const supabase = createServerClient()
        let body: any
        try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
            return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
        }

        // Dedicated resume action — the ONLY way this route ever writes
        // hubtel_commission_paused, and it only ever clears it. Takes priority over
        // any other keys present in the same body.
        if (body.action !== undefined) {
            if (body.action !== 'resume') {
                return NextResponse.json({ error: "Invalid action (only 'resume' is supported)" }, { status: 400 })
            }
            const { error } = await (supabase.from('admin_settings') as any)
                .upsert({ key: 'hubtel_commission_paused', value: 'false' }, { onConflict: 'key' })
            if (error) {
                console.error('[Admin Utilities Settings] Resume error:', error)
                return NextResponse.json({ error: error.message }, { status: 500 })
            }
            return NextResponse.json({ success: true })
        }

        const bodyKeys = Object.keys(body)
        if (bodyKeys.length === 0) return NextResponse.json({ error: 'No valid settings provided' }, { status: 400 })

        // ALLOWLIST ONLY — reject the whole request on the first unrecognized key
        // (airtime's settings route silently filters instead; this route rejects,
        // per this task's brief: "Reject any other key").
        for (const key of bodyKeys) {
            if (!(UTILITY_SETTING_KEYS as readonly string[]).includes(key)) {
                return NextResponse.json({ error: `Unknown setting key: ${key}` }, { status: 400 })
            }
        }

        // Commission WITHDRAWAL/PAYOUT economics (fee %, flat fee, minimum, transfer
        // kill-switch) are full-admin only — a sub-admin can already move the bigger
        // lever (utility_commission_partner_percent, unrestricted below), but these
        // four directly govern real Paystack payout amounts and are gated tighter.
        if (bodyKeys.some((k) => COMMISSION_PAYOUT_SETTING_KEYS.has(k)) && admin.role !== 'admin') {
            return NextResponse.json({ error: 'Forbidden — commission payout settings require full admin' }, { status: 403 })
        }

        const updates: { key: string; value: any }[] = []

        for (const key of bodyKeys) {
            const raw = body[key]
            if (TOGGLE_KEYS.has(key)) {
                const v = toToggleString(raw)
                if (v === null) return NextResponse.json({ error: `${key} must be true or false` }, { status: 400 })
                updates.push({ key, value: v })
                continue
            }
            if (key === 'hubtel_utility_billers') {
                if (!isValidBillersMap(raw)) {
                    return NextResponse.json({
                        error: `hubtel_utility_billers must be an object with exactly these keys: ${UTILITY_BILLER_KEYS.join(', ')} (boolean values)`,
                    }, { status: 400 })
                }
                // Real JSONB object — NOT string-wrapped. lib/utility-fulfillment.ts's
                // isUtilityAutoFulfillmentEnabled reads this key via direct property
                // access (`billers[biller] === true`), not JSON.parse.
                updates.push({ key, value: raw })
                continue
            }
            if (key === 'utility_commission_partner_percent') {
                const n = toFiniteNumber(raw)
                if (n === null || n < 0 || n > 100) {
                    return NextResponse.json({ error: 'utility_commission_partner_percent must be a number between 0 and 100' }, { status: 400 })
                }
                updates.push({ key, value: String(n) })
                continue
            }
            if (key === 'commission_withdrawal_fee_percent') {
                const n = toFiniteNumber(raw)
                if (n === null || n < 0 || n > 100) {
                    return NextResponse.json({ error: 'commission_withdrawal_fee_percent must be a number between 0 and 100' }, { status: 400 })
                }
                updates.push({ key, value: String(n) })
                continue
            }
            if (key === 'commission_withdrawal_fee_flat' || key === 'commission_min_withdrawal_amount') {
                const n = toFiniteNumber(raw)
                if (n === null || n < 0) {
                    return NextResponse.json({ error: `${key} must be a non-negative number` }, { status: 400 })
                }
                updates.push({ key, value: String(n) })
                continue
            }
            // utility_min_amount / utility_max_amount — validated together below
            // (cross-field constraint needs both values).
        }

        // Cross-field validation: 1 ≤ min ≤ max ≤ 10000. Whichever side isn't present
        // in this request is read from its current stored value.
        if (bodyKeys.includes('utility_min_amount') || bodyKeys.includes('utility_max_amount')) {
            let newMin: number | null = null
            let newMax: number | null = null

            if (bodyKeys.includes('utility_min_amount')) {
                newMin = toFiniteNumber(body.utility_min_amount)
                if (newMin === null) return NextResponse.json({ error: 'utility_min_amount must be a number' }, { status: 400 })
            }
            if (bodyKeys.includes('utility_max_amount')) {
                newMax = toFiniteNumber(body.utility_max_amount)
                if (newMax === null) return NextResponse.json({ error: 'utility_max_amount must be a number' }, { status: 400 })
            }

            if (newMin === null || newMax === null) {
                const { data: existing } = await (supabase.from('admin_settings') as any)
                    .select('key, value')
                    .in('key', ['utility_min_amount', 'utility_max_amount'])
                const existingMap: Record<string, any> = {}
                for (const row of (existing || [])) existingMap[row.key] = row.value
                if (newMin === null) newMin = toFiniteNumber(existingMap['utility_min_amount']) ?? 1
                if (newMax === null) newMax = toFiniteNumber(existingMap['utility_max_amount']) ?? 1000
            }

            if (!(newMin >= 1 && newMin <= newMax && newMax <= 10000)) {
                return NextResponse.json({ error: 'Amounts must satisfy 1 ≤ min ≤ max ≤ 10000' }, { status: 400 })
            }

            if (bodyKeys.includes('utility_min_amount')) updates.push({ key: 'utility_min_amount', value: String(newMin) })
            if (bodyKeys.includes('utility_max_amount')) updates.push({ key: 'utility_max_amount', value: String(newMax) })
        }

        if (updates.length === 0) return NextResponse.json({ error: 'No valid settings provided' }, { status: 400 })

        const { error } = await (supabase.from('admin_settings') as any)
            .upsert(updates, { onConflict: 'key' })

        if (error) {
            console.error('[Admin Utilities Settings] Save error:', error)
            return NextResponse.json({ error: error.message }, { status: 500 })
        }

        return NextResponse.json({ success: true })
    } catch (error) {
        console.error('[Admin Utilities Settings] POST error:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
