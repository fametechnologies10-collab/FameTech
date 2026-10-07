/**
 * /api/sms/templates — reusable message templates (KFT SMS).
 * GET    list, POST create (cap 30), DELETE ?id= remove. Owner-scoped by
 * account; writes go through the service-role client keyed on the caller's
 * own account id (no cross-tenant access).
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { consumeRateLimit } from '@/lib/simple-rate-limit'

export const dynamic = 'force-dynamic'

const MAX_TEMPLATES = 30

const createSchema = z.object({
    name: z.string().min(1).max(60),
    body: z.string().min(3).max(1000),
})

async function accountId(db: any, userId: string): Promise<string | null> {
    const { data } = await db.from('sms_accounts').select('id').eq('user_id', userId).maybeSingle()
    return data?.id ?? null
}

export async function GET() {
    try {
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const db = createServerClient() as any
        const acc = await accountId(db, user.id)
        if (!acc) return NextResponse.json({ success: true, data: { templates: [] } })

        const { data: templates } = await db.from('sms_user_templates')
            .select('id, name, body, created_at').eq('account_id', acc).order('created_at', { ascending: false })
        return NextResponse.json({ success: true, data: { templates: templates ?? [] } })
    } catch (e: any) {
        console.error('[SMS Templates GET] error:', e?.message)
        return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 })
    }
}

export async function POST(request: NextRequest) {
    try {
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const rl = consumeRateLimit(`sms-template-post:${user.id}`, 30, 60_000)
        if (!rl.allowed) return NextResponse.json({ success: false, error: 'Too many requests' }, { status: 429 })

        const parsed = createSchema.safeParse(await request.json().catch(() => null))
        if (!parsed.success) return NextResponse.json({ success: false, error: 'Invalid template' }, { status: 400 })

        const db = createServerClient() as any
        const acc = await accountId(db, user.id)
        if (!acc) return NextResponse.json({ success: false, error: 'Open the SMS dashboard first' }, { status: 400 })

        const { count } = await db.from('sms_user_templates')
            .select('id', { count: 'exact', head: true }).eq('account_id', acc)
        if ((count ?? 0) >= MAX_TEMPLATES) {
            return NextResponse.json({ success: false, error: `Template limit reached (${MAX_TEMPLATES})` }, { status: 409 })
        }

        const { data, error } = await db.from('sms_user_templates')
            .insert({ account_id: acc, name: parsed.data.name.trim(), body: parsed.data.body })
            .select('id, name, body, created_at').single()
        if (error) throw error
        return NextResponse.json({ success: true, data: { template: data } })
    } catch (e: any) {
        console.error('[SMS Templates POST] error:', e?.message)
        return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 })
    }
}

export async function DELETE(request: NextRequest) {
    try {
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const id = new URL(request.url).searchParams.get('id')
        if (!id) return NextResponse.json({ success: false, error: 'Missing id' }, { status: 400 })

        const db = createServerClient() as any
        const acc = await accountId(db, user.id)
        if (!acc) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

        // Scope the delete to the caller's own account — no cross-tenant delete.
        const { data, error } = await db.from('sms_user_templates')
            .delete().eq('id', id).eq('account_id', acc).select('id')
        if (error) throw error
        if (!data || (data as any[]).length === 0) {
            return NextResponse.json({ success: false, error: 'Template not found' }, { status: 404 })
        }
        return NextResponse.json({ success: true })
    } catch (e: any) {
        console.error('[SMS Templates DELETE] error:', e?.message)
        return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 })
    }
}
