import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { adminShortTextSchema, adminLongTextSchema } from '@/lib/validation'

// Create admin client directly since createServerClient might not be exported customly
const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
        auth: {
            autoRefreshToken: false,
            persistSession: false
        }
    }
)

export async function GET(request: NextRequest) {
    const supabase = await createRouteClient()
    const { data: { user: authUser } } = await supabase.auth.getUser()

    if (!authUser) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Check if user is admin
    const { data: user } = await supabase
        .from('users')
        .select('role')
        .eq('id', authUser.id)
        .single()

    if ((user as any)?.role !== 'admin') {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { data, error } = await supabaseAdmin
        .from('data_packages')
        .select('*')
        .neq('category', 'mtn_mashup')
        .order('network')
        .order('sort_order')

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json(data)
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

    const packageSchema = z.object({
        name: adminShortTextSchema.optional(),
        description: adminLongTextSchema.optional(),
    }).passthrough()

    const validation = packageSchema.safeParse(body)
    if (!validation.success) {
        const errorDetails = validation.error.errors.map(err => `${err.path.join('.')}: ${err.message}`)
        return NextResponse.json({ error: 'Invalid input', details: errorDetails }, { status: 400 })
    }

    const costPricePost = Number((validation.data as any).cost_price) || 0
    const agentPricePost = Number((validation.data as any).agent_price) || 0
    const dealerPricePost = Number((validation.data as any).dealer_price) || 0
    if (agentPricePost > 0 && agentPricePost < costPricePost) {
        return NextResponse.json({ error: 'Agent price cannot be lower than cost price' }, { status: 400 })
    }
    if (dealerPricePost > 0 && dealerPricePost < costPricePost) {
        return NextResponse.json({ error: 'Dealer price cannot be lower than cost price' }, { status: 400 })
    }

    // Explicitly cast insert to avoid type errors with string enums if mismatch
    // H-1: Force category to 'data' so this endpoint can never create a mashup row.
    const insertData = { ...body, category: 'data' }
    const { data, error } = await (supabaseAdmin
        .from('data_packages') as any)
        .insert(insertData)
        .select()
        .single()

    if (error) {
        console.error('Create package error:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json(data)
}

export async function PUT(request: NextRequest) {
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

    const packageSchema = z.object({
        name: adminShortTextSchema.optional(),
        description: adminLongTextSchema.optional(),
    }).passthrough()

    const validation = packageSchema.safeParse(body)
    if (!validation.success) {
        const errorDetails = validation.error.errors.map(err => `${err.path.join('.')}: ${err.message}`)
        return NextResponse.json({ error: 'Invalid input', details: errorDetails }, { status: 400 })
    }

    const { id, ...updates } = validation.data
    // L-2a: Prevent changing a row's category via this endpoint.
    delete (updates as any).category

    if (!id) {
        return NextResponse.json({ error: 'Package ID required' }, { status: 400 })
    }

    const costPrice = Number((updates as any).cost_price) || 0
    const agentPrice = Number((updates as any).agent_price) || 0
    const dealerPrice = Number((updates as any).dealer_price) || 0
    if (agentPrice > 0 && agentPrice < costPrice) {
        return NextResponse.json({ error: 'Agent price cannot be lower than cost price' }, { status: 400 })
    }
    if (dealerPrice > 0 && dealerPrice < costPrice) {
        return NextResponse.json({ error: 'Dealer price cannot be lower than cost price' }, { status: 400 })
    }

    // L-2b: Prevent targeting a mashup row via the regular packages endpoint.
    const { data, error } = await (supabaseAdmin
        .from('data_packages') as any)
        .update({
            ...updates,
            updated_at: new Date().toISOString()
        })
        .eq('id', id)
        .neq('category', 'mtn_mashup')
        .select()
        .single()

    if (error) {
        console.error('Update package error:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json(data)
}

export async function DELETE(request: NextRequest) {
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

    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')

    if (!id) {
        return NextResponse.json({ error: 'Package ID required' }, { status: 400 })
    }

    // H-2: Prevent deleting a mashup row via the regular packages endpoint.
    const { error } = await supabaseAdmin
        .from('data_packages')
        .delete()
        .eq('id', id)
        .neq('category', 'mtn_mashup')

    if (error) {
        console.error('Delete package error:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ success: true })
}
