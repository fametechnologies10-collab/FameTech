import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { adminShortTextSchema, adminLongTextSchema } from '@/lib/validation'
import { MASHUP_CATEGORY } from '@/lib/mashup'

const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
)

async function requireAdmin() {
    const supabase = await createRouteClient()
    const { data: { user: authUser } } = await supabase.auth.getUser()
    if (!authUser) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
    const { data: user } = await supabase.from('users').select('role').eq('id', authUser.id).single()
    if ((user as any)?.role !== 'admin') return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
    return { ok: true as const }
}

// FIX 1: Explicit allowlist of mutable columns — prevents mass-assignment via raw body spread.
const MUTABLE_FIELDS = ['size', 'description', 'price', 'agent_price', 'dealer_price', 'cost_price', 'is_available', 'sort_order'] as const

function pickFields(src: any): Record<string, any> {
    const out: Record<string, any> = {}
    for (const k of MUTABLE_FIELDS) {
        if (src[k] !== undefined) out[k] = src[k]
    }
    return out
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Validate EVERY field that can reach the DB. Numerics must be finite & non-negative
// (blocks Infinity/NaN price poisoning that flows into SMS/push/wallet math); text is
// length/content-capped via the admin schemas. Unknown keys are stripped (Zod default).
const packageSchema = z.object({
    id: z.string().optional(),
    name: adminShortTextSchema.optional(),
    size: adminShortTextSchema.optional(),
    description: adminLongTextSchema.optional(),
    price: z.number().finite().nonnegative().optional(),
    agent_price: z.number().finite().nonnegative().optional(),
    dealer_price: z.number().finite().nonnegative().optional(),
    cost_price: z.number().finite().nonnegative().optional(),
    is_available: z.boolean().optional(),
    sort_order: z.number().int().optional(),
})

function costGuard(d: any): string | null {
    const cost = Number(d.cost_price) || 0
    const agent = Number(d.agent_price) || 0
    const dealer = Number(d.dealer_price) || 0
    // FIX 2: Reject negative prices before checking agent/dealer vs cost.
    const price = Number(d.price) || 0
    if (price < 0 || cost < 0 || agent < 0 || dealer < 0) return 'Prices cannot be negative'
    if (agent > 0 && agent < cost) return 'Agent price cannot be lower than cost price'
    if (dealer > 0 && dealer < cost) return 'Dealer price cannot be lower than cost price'
    return null
}

export async function GET() {
    const auth = await requireAdmin()
    if (auth.error) return auth.error
    const { data, error } = await supabaseAdmin
        .from('data_packages')
        .select('*')
        .eq('category', MASHUP_CATEGORY)
        .order('sort_order')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json(data)
}

export async function POST(request: NextRequest) {
    const auth = await requireAdmin()
    if (auth.error) return auth.error
    const body = await request.json()
    const validation = packageSchema.safeParse(body)
    if (!validation.success) {
        const details = validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`)
        return NextResponse.json({ error: 'Invalid input', details }, { status: 400 })
    }
    const guard = costGuard(validation.data)
    if (guard) return NextResponse.json({ error: guard }, { status: 400 })

    // Use the VALIDATED, stripped object (not the raw body) as the allowlist source.
    const insert = { ...pickFields(validation.data), category: MASHUP_CATEGORY, network: 'MTN' }
    const { data, error } = await (supabaseAdmin.from('data_packages') as any)
        .insert(insert).select().single()
    if (error) {
        console.error('Create mashup package error:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json(data)
}

export async function PUT(request: NextRequest) {
    const auth = await requireAdmin()
    if (auth.error) return auth.error
    const body = await request.json()
    const validation = packageSchema.safeParse(body)
    if (!validation.success) {
        const details = validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`)
        return NextResponse.json({ error: 'Invalid input', details }, { status: 400 })
    }
    const { id, ...updates } = validation.data as any
    if (!id || !UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid package ID' }, { status: 400 })
    const guard = costGuard(updates)
    if (guard) return NextResponse.json({ error: guard }, { status: 400 })

    // FIX 1: Use pickFields allowlist for the update payload; category + network + updated_at still forced.
    const updatePayload = { ...pickFields(updates), category: MASHUP_CATEGORY, network: 'MTN', updated_at: new Date().toISOString() }
    const { data, error } = await (supabaseAdmin.from('data_packages') as any)
        .update(updatePayload)
        .eq('id', id)
        .eq('category', MASHUP_CATEGORY)
        .select().single()
    if (error) {
        console.error('Update mashup package error:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json(data)
}

export async function DELETE(request: NextRequest) {
    const auth = await requireAdmin()
    if (auth.error) return auth.error
    const id = new URL(request.url).searchParams.get('id')
    if (!id || !UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid package ID' }, { status: 400 })
    const { error } = await supabaseAdmin
        .from('data_packages')
        .delete()
        .eq('id', id)
        .eq('category', MASHUP_CATEGORY)
    if (error) {
        console.error('Delete mashup package error:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ success: true })
}
