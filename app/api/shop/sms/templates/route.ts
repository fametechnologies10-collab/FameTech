import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { z } from 'zod'

const templateSchema = z.object({
    name: z.string().trim().min(1, 'Name is required').max(60, 'Name max 60 chars'),
    body: z.string().trim().min(3, 'Message too short').max(1000, 'Message too long'),
})

async function getShopId(supabase: Awaited<ReturnType<typeof createRouteClient>>, userId: string) {
    const { data } = await supabase.from('shop_profiles').select('id').eq('owner_id', userId).maybeSingle()
    return (data as any)?.id as string | null
}

// GET — list shop's own templates
export async function GET() {
    try {
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const shopId = await getShopId(supabase, user.id)
        if (!shopId) return NextResponse.json({ success: false, error: 'Shop not found' }, { status: 404 })

        const { data, error } = await supabase
            .from('shop_sms_templates')
            .select('id, name, body, created_at')
            .eq('shop_id', shopId)
            .order('created_at', { ascending: false })

        if (error) throw error
        return NextResponse.json({ success: true, data: data || [] })
    } catch (err) {
        console.error('[ShopSMSTemplates] GET error:', err)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}

// POST — create a new template
export async function POST(req: NextRequest) {
    try {
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const shopId = await getShopId(supabase, user.id)
        if (!shopId) return NextResponse.json({ success: false, error: 'Shop not found' }, { status: 404 })

        const body = await req.json()
        const parsed = templateSchema.safeParse(body)
        if (!parsed.success) {
            return NextResponse.json(
                { success: false, error: parsed.error.errors[0]?.message || 'Invalid input' },
                { status: 400 }
            )
        }

        // Limit per shop to prevent abuse
        const { count } = await supabase
            .from('shop_sms_templates')
            .select('id', { count: 'exact', head: true })
            .eq('shop_id', shopId)
        if ((count ?? 0) >= 20) {
            return NextResponse.json({ success: false, error: 'Maximum 20 templates per shop. Delete one to add more.' }, { status: 400 })
        }

        const { data, error } = await supabase
            .from('shop_sms_templates')
            .insert({ shop_id: shopId, name: parsed.data.name, body: parsed.data.body })
            .select('id, name, body, created_at')
            .single()

        if (error) throw error
        return NextResponse.json({ success: true, data })
    } catch (err) {
        console.error('[ShopSMSTemplates] POST error:', err)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}

// DELETE — remove a template by id (passed as ?id=)
export async function DELETE(req: NextRequest) {
    try {
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const shopId = await getShopId(supabase, user.id)
        if (!shopId) return NextResponse.json({ success: false, error: 'Shop not found' }, { status: 404 })

        const id = new URL(req.url).searchParams.get('id')
        if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
            return NextResponse.json({ success: false, error: 'Invalid template ID' }, { status: 400 })
        }

        const { error } = await supabase
            .from('shop_sms_templates')
            .delete()
            .eq('id', id)
            .eq('shop_id', shopId) // RLS owns this but double-check in code too

        if (error) throw error
        return NextResponse.json({ success: true })
    } catch (err) {
        console.error('[ShopSMSTemplates] DELETE error:', err)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}
