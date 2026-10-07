import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createClient } from '@supabase/supabase-js'
import { canonicalizePhone } from '@/lib/number-registration'

// Service-role client — number_registrations / number_registration_batches are
// admin-RLS only; all reads here go through the service role after an explicit
// admin role check (same pattern as app/api/admin/orders/batch/route.ts).
const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
)

async function requireAdmin() {
    const supabaseUserClient = await createRouteClient()
    const { data: { user: authUser }, error } = await supabaseUserClient.auth.getUser()
    if (error || !authUser) return { ok: false as const, status: 401, error: 'Unauthorized' }
    const { data: userData } = await supabaseUserClient
        .from('users').select('role, first_name').eq('id', authUser.id).single()
    const role = (userData as any)?.role
    if (role !== 'admin' && role !== 'sub-admin') return { ok: false as const, status: 403, error: 'Forbidden' }
    return { ok: true as const, authUser, adminName: (userData as any)?.first_name?.trim() || 'Admin' }
}

/**
 * GET /api/admin/number-registration
 * Returns the console payload:
 *   - stats: counts for new / submitted / registered numbers + currently-queued orders
 *   - newNumbers: distinct unregistered numbers ('new') with their queued-order counts
 *   - batches: registration batches (history)
 *   - gateEnabled: current toggle state (number_registration_gate_enabled)
 *   - whitelistGateEnabled: current toggle state of the separate AgentPortal
 *     whitelist gate (mtn_agentportal_whitelist_gate_enabled) — shown here for
 *     admin convenience only, no shared logic with the gate above.
 *   - bundlePortalWhitelistEnabled: current toggle state of the separate Bundle
 *     Portal whitelist fallback (mtn_bundleportal_whitelist_gate_enabled) —
 *     shown here for admin convenience only, no shared logic with the gates above.
 * Optional ?search= to look up a single number across the registry (Registry tab).
 */
export async function GET(request: NextRequest) {
    const auth = await requireAdmin()
    if (!auth.ok) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status })

    try {
        const db = supabaseAdmin as any
        const { searchParams } = new URL(request.url)
        const search = searchParams.get('search')?.trim()
        const batchId = searchParams.get('batchId')?.trim()

        // Re-download: return every number attached to a batch (for the Excel).
        if (batchId) {
            const { data: rows } = await db
                .from('number_registrations')
                .select('phone_number, network')
                .eq('batch_id', batchId)
                .order('phone_number', { ascending: true })
                .limit(20000)
            return NextResponse.json({ success: true, data: { batch: true, numbers: rows || [] } })
        }

        // Registry search short-circuits everything else.
        if (search) {
            const digits = search.replace(/\D/g, '')
            const like = `%${digits.slice(-9)}%` // match last 9 digits regardless of 0/233 prefix
            const { data: rows } = await db
                .from('number_registrations')
                .select('phone_number, network, status, source, first_seen_at, submitted_at, registered_at, batch_id')
                .ilike('phone_number', like)
                .order('first_seen_at', { ascending: false })
                .limit(100)
            return NextResponse.json({ success: true, data: { search: true, results: rows || [] } })
        }

        // Stat counts (head:true → count only).
        const [newCount, submittedCount, registeredCount, queuedOrders, queuedShop, gateSetting, whitelistGateSetting, bundlePortalWhitelistSetting] = await Promise.all([
            db.from('number_registrations').select('*', { count: 'exact', head: true }).eq('status', 'new'),
            db.from('number_registrations').select('*', { count: 'exact', head: true }).eq('status', 'submitted'),
            db.from('number_registrations').select('*', { count: 'exact', head: true }).eq('status', 'registered'),
            db.from('orders').select('*', { count: 'exact', head: true }).eq('status', 'queued'),
            db.from('shop_orders').select('*', { count: 'exact', head: true }).eq('status', 'queued'),
            db.from('admin_settings').select('value').eq('key', 'number_registration_gate_enabled').maybeSingle(),
            // Read-only display of the separate, independent AgentPortal whitelist gate
            // (lib/mtn-whitelist-gate.ts) — shown alongside this page's own gate for
            // admin convenience only. No shared state, no shared logic with the gate above.
            db.from('admin_settings').select('value').eq('key', 'mtn_agentportal_whitelist_gate_enabled').maybeSingle(),
            // Read-only display of the separate, independent Bundle Portal whitelist
            // fallback (lib/mtn-whitelist-merge.ts) — shown alongside the gates above
            // for admin convenience only. No shared state, no shared logic with them.
            db.from('admin_settings').select('value').eq('key', 'mtn_bundleportal_whitelist_gate_enabled').maybeSingle(),
        ])

        // New (unregistered) numbers with how many orders each is holding up.
        const { data: newRows } = await db
            .from('number_registrations')
            .select('phone_number, network, first_seen_at')
            .eq('status', 'new')
            .order('first_seen_at', { ascending: true })
            .limit(5000)

        // Count queued orders per new number. Fetch queued rows (orders + shop_orders),
        // canonicalize their phone (0/233 form) in JS, and tally — no extra RPC needed.
        const queuedCountByPhone: Record<string, number> = {}
        const tally = (raw: string | null | undefined) => {
            const c = canonicalizePhone(raw)
            if (c) queuedCountByPhone[c] = (queuedCountByPhone[c] || 0) + 1
        }
        const [{ data: qOrders }, { data: qShop }] = await Promise.all([
            db.from('orders').select('phone_number').eq('status', 'queued').limit(10000),
            db.from('shop_orders').select('guest_phone').eq('status', 'queued').limit(10000),
        ])
        for (const r of (qOrders || [])) tally((r as any).phone_number)
        for (const r of (qShop || [])) tally((r as any).guest_phone)

        const newNumbers = (newRows || []).map((r: any) => ({
            phone_number: r.phone_number,
            network: r.network,
            first_seen_at: r.first_seen_at,
            queued_orders: queuedCountByPhone[r.phone_number] ?? 0,
        }))

        const { data: batches } = await db
            .from('number_registration_batches')
            .select('id, filename, network, number_count, status, created_at, confirmed_at, created_by, confirmed_by')
            .order('created_at', { ascending: false })
            .limit(200)

        const gateVal = (gateSetting?.data as any)?.value
        const gateEnabled = gateVal === true || gateVal === 'true'

        const whitelistGateVal = (whitelistGateSetting?.data as any)?.value
        const whitelistGateEnabled = whitelistGateVal === true || whitelistGateVal === 'true'

        const bundlePortalWhitelistVal = (bundlePortalWhitelistSetting?.data as any)?.value
        const bundlePortalWhitelistEnabled = bundlePortalWhitelistVal === true || bundlePortalWhitelistVal === 'true'

        return NextResponse.json({
            success: true,
            data: {
                stats: {
                    new: newCount.count || 0,
                    submitted: submittedCount.count || 0,
                    registered: registeredCount.count || 0,
                    queuedOrders: (queuedOrders.count || 0) + (queuedShop.count || 0),
                },
                newNumbers,
                batches: batches || [],
                gateEnabled,
                whitelistGateEnabled,
                bundlePortalWhitelistEnabled,
            },
        })
    } catch (error: any) {
        console.error('[NumberRegistration GET] error:', error)
        return NextResponse.json({ success: false, error: error.message || 'Internal server error' }, { status: 500 })
    }
}
