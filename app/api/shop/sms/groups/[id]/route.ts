import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { z } from 'zod'
import { parsePhoneNumbersFromRows } from '@/lib/phone-import'
import { consumeRateLimit } from '@/lib/simple-rate-limit'

const MAX_MEMBERS_PER_GROUP = 2000
const UUID_RE = /^[0-9a-f-]{36}$/i

const numberEntrySchema = z.union([
    z.string(),
    z.object({ phone: z.string(), name: z.string().max(100).optional() }),
])

const patchSchema = z.object({
    name: z.string().trim().min(1).max(60).optional(),
    addNumbers: z.array(numberEntrySchema).max(MAX_MEMBERS_PER_GROUP + 1000).optional(),
    removeNumbers: z.array(z.string()).max(MAX_MEMBERS_PER_GROUP + 1000).optional(),
})

async function resolveOwnedGroup(
    supabase: Awaited<ReturnType<typeof createRouteClient>>,
    userId: string,
    groupId: string,
) {
    if (!UUID_RE.test(groupId)) return { shopId: null, group: null }
    const { data: shop } = await supabase.from('shop_profiles').select('id').eq('owner_id', userId).maybeSingle()
    const shopId = (shop as any)?.id as string | null
    if (!shopId) return { shopId: null, group: null }

    const { data: group } = await supabase
        .from('shop_sms_groups')
        .select('id, name')
        .eq('id', groupId)
        .eq('shop_id', shopId)
        .maybeSingle()
    return { shopId, group: group as any }
}

// GET — group details + full member list, for editing or picking into a send
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const { shopId, group } = await resolveOwnedGroup(supabase, user.id, id)
        if (!shopId) return NextResponse.json({ success: false, error: 'Shop not found' }, { status: 404 })
        if (!group) return NextResponse.json({ success: false, error: 'Group not found' }, { status: 404 })

        const { data: members, error } = await supabase
            .from('shop_sms_group_members')
            .select('phone, name')
            .eq('group_id', group.id)
            .order('created_at', { ascending: true })
        if (error) throw error

        return NextResponse.json({
            success: true,
            data: { id: group.id, name: group.name, members: (members as any[]) || [] },
        })
    } catch (err) {
        console.error('[ShopSMSGroup] GET error:', err)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}

// PATCH — rename and/or add/remove members. Ownership re-checked before any write.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const rl = consumeRateLimit(`shop-sms-groups-patch:${user.id}`, 60, 60 * 60 * 1000)
        if (!rl.allowed) {
            return NextResponse.json({ success: false, error: 'Too many requests. Try again later.' }, { status: 429 })
        }

        const { shopId, group } = await resolveOwnedGroup(supabase, user.id, id)
        if (!shopId) return NextResponse.json({ success: false, error: 'Shop not found' }, { status: 404 })
        if (!group) return NextResponse.json({ success: false, error: 'Group not found' }, { status: 404 })

        const body = await req.json()
        const parsed = patchSchema.safeParse(body)
        if (!parsed.success) {
            return NextResponse.json(
                { success: false, error: parsed.error.errors[0]?.message || 'Invalid request' },
                { status: 400 },
            )
        }

        const adminDb = createServerClient()

        if (parsed.data.name) {
            const { error: renameErr } = await (adminDb as any)
                .from('shop_sms_groups')
                .update({ name: parsed.data.name, updated_at: new Date().toISOString() })
                .eq('id', group.id)
            if (renameErr) {
                if (renameErr.code === '23505') {
                    return NextResponse.json({ success: false, error: 'You already have a group with this name' }, { status: 409 })
                }
                throw renameErr
            }
        }

        if (parsed.data.removeNumbers && parsed.data.removeNumbers.length > 0) {
            const normalizedRemovals = parsePhoneNumbersFromRows(
                parsed.data.removeNumbers.map(phone => ({ phone })),
            ).valid.map(v => v.phone)
            if (normalizedRemovals.length > 0) {
                const { error: removeErr } = await (adminDb as any)
                    .from('shop_sms_group_members')
                    .delete()
                    .eq('group_id', group.id)
                    .in('phone', normalizedRemovals)
                if (removeErr) throw removeErr
            }
        }

        if (parsed.data.addNumbers && parsed.data.addNumbers.length > 0) {
            const { count: currentCount } = await (adminDb as any)
                .from('shop_sms_group_members')
                .select('id', { count: 'exact', head: true })
                .eq('group_id', group.id)

            const rows = parsed.data.addNumbers.map(n => (typeof n === 'string' ? { phone: n } : n))
            const result = parsePhoneNumbersFromRows(rows)
            const remaining = Math.max(0, MAX_MEMBERS_PER_GROUP - (currentCount ?? 0))
            const toInsert = result.valid.slice(0, remaining).map(entry => ({
                group_id: group.id,
                shop_id: shopId,
                phone: entry.phone,
                name: entry.name || null,
            }))
            if (toInsert.length > 0) {
                // upsert so re-adding an already-present number is a no-op, not a 23505 error
                const { error: addErr } = await (adminDb as any)
                    .from('shop_sms_group_members')
                    .upsert(toInsert, { onConflict: 'group_id,phone', ignoreDuplicates: true })
                if (addErr) throw addErr
            }
        }

        const { count: memberCount } = await (adminDb as any)
            .from('shop_sms_group_members')
            .select('id', { count: 'exact', head: true })
            .eq('group_id', group.id)

        return NextResponse.json({
            success: true,
            data: { id: group.id, name: parsed.data.name || group.name, memberCount: memberCount ?? 0 },
        })
    } catch (err) {
        console.error('[ShopSMSGroup] PATCH error:', err)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}

// DELETE — remove the group (members cascade via FK)
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const rl = consumeRateLimit(`shop-sms-groups-delete:${user.id}`, 30, 60 * 60 * 1000)
        if (!rl.allowed) {
            return NextResponse.json({ success: false, error: 'Too many requests. Try again later.' }, { status: 429 })
        }

        const { shopId, group } = await resolveOwnedGroup(supabase, user.id, id)
        if (!shopId) return NextResponse.json({ success: false, error: 'Shop not found' }, { status: 404 })
        if (!group) return NextResponse.json({ success: false, error: 'Group not found' }, { status: 404 })

        const adminDb = createServerClient()
        const { error } = await (adminDb as any).from('shop_sms_groups').delete().eq('id', group.id)
        if (error) throw error

        return NextResponse.json({ success: true })
    } catch (err) {
        console.error('[ShopSMSGroup] DELETE error:', err)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}
