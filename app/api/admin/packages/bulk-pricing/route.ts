import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'

const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
)

const PRICE_ROLES = ['price', 'agent_price', 'dealer_price', 'ussd_price', 'cost_price'] as const

const bulkPricingSchema = z.object({
    network: z.enum(['MTN', 'Telecel', 'AT-iShare', 'AT-BigTime']),
    role: z.enum(PRICE_ROLES),
    rate: z.number().positive(),
    package_ids: z.array(z.string().uuid()).min(1).max(100),
})

// Parses size string to GB. Must stay in sync with BulkPricingTab.tsx parseSizeToGB.
function parseSizeToGB(size: string): number | null {
    const mb = size.match(/^(\d+(?:\.\d+)?)\s*MB$/i)
    if (mb) return parseFloat(mb[1]) / 1024

    const gb = size.match(/^(\d+(?:\.\d+)?)\s*GB$/i)
    if (gb) return parseFloat(gb[1])

    return null
}

export async function POST(request: NextRequest) {
    const supabase = await createRouteClient()
    const { data: { user: authUser } } = await supabase.auth.getUser()

    if (!authUser) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: user } = await supabase
        .from('users')
        .select('role')
        .eq('id', authUser.id)
        .single()

    if ((user as any)?.role !== 'admin') {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const body = await request.json()
    const parsed = bulkPricingSchema.safeParse(body)

    if (!parsed.success) {
        return NextResponse.json(
            { error: 'Invalid input', details: parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`) },
            { status: 400 }
        )
    }

    const { network, role, rate, package_ids } = parsed.data

    // Fetch requested packages, verifying they belong to the declared network
    const { data: pkgs, error: fetchError } = await supabaseAdmin
        .from('data_packages')
        .select('id, size, cost_price')
        .in('id', package_ids)
        .eq('network', network)

    if (fetchError) {
        return NextResponse.json({ error: fetchError.message }, { status: 500 })
    }

    if (!pkgs || pkgs.length === 0) {
        return NextResponse.json({ error: 'No matching packages found' }, { status: 404 })
    }

    let updated = 0

    for (const pkg of pkgs) {
        const gbSize = parseSizeToGB(pkg.size)
        if (gbSize === null) continue

        const newPrice = Math.round(gbSize * rate * 100) / 100

        // Server-side guard: agent/dealer price must not fall below cost price
        const costPrice = (pkg as any).cost_price ?? 0
        if ((role === 'agent_price' || role === 'dealer_price') && costPrice > 0 && newPrice < costPrice) {
            continue
        }
        // cost_price has no lower-bound guard — it sets the floor itself

        const { error: updateError } = await supabaseAdmin
            .from('data_packages')
            .update({ [role]: newPrice, updated_at: new Date().toISOString() })
            .eq('id', pkg.id)

        if (!updateError) updated++
    }

    return NextResponse.json({ success: true, updated })
}
