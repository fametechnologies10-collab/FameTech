import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { z } from 'zod'
import { parsePhoneNumbersFromRows } from '@/lib/phone-import'
import { consumeRateLimit } from '@/lib/simple-rate-limit'

const MAX_GROUPS_PER_SHOP = 20
const MAX_MEMBERS_PER_GROUP = 2000

const numberEntrySchema = z.union([
    z.string(),
    z.object({ phone: z.string(), name: z.string().max(100).optional() }),
])

const createGroupSchema = z.object({
    name: z.string().trim().min(1, 'Group name is required').max(60, 'Group name max 60 chars'),
    numbers: z.array(numberEntrySchema).min(1, 'Add at least one number').max(MAX_MEMBERS_PER_GROUP + 1000),
})

async function getShopId(supabase: Awaited<ReturnType<typeof createRouteClient>>, userId: string) {
    const { data } = await supabase.from('shop_profiles').select('id').eq('owner_id', userId).maybeSingle()
    return (data as any)?.id as string | null
}

// GET — list the shop's saved groups with member counts (no member list — see [id]/route.ts for that)
export async function GET() {
    try {
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const shopId = await getShopId(supabase, user.id)
        if (!shopId) return NextResponse.json({ success: false, error: 'Shop not found' }, { status: 404 })

        // Embedded PostgREST count on the related table in the SAME query —
        // avoids a separate query that downloads every member row (that was
        // hitting PostgREST's ~1000-row cap once a shop's groups collectively
        // held more than 1000 members, silently under-counting some groups).
        const { data: groups, error } = await supabase
            .from('shop_sms_groups')
            .select('id, name, created_at, shop_sms_group_members(count)')
            .eq('shop_id', shopId)
            .order('created_at', { ascending: false })
        if (error) throw error

        const data = ((groups as any[]) || []).map(g => ({
            id: g.id,
            name: g.name,
            memberCount: g.shop_sms_group_members?.[0]?.count ?? 0,
            createdAt: g.created_at,
        }))
        return NextResponse.json({ success: true, data })
    } catch (err) {
        console.error('[ShopSMSGroups] GET error:', err)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}

// POST — create a new group from pasted/uploaded numbers. Server re-normalizes
// every number (never trusts the client's preview parse) and enforces the
// per-shop group cap and per-group member cap before any write.
export async function POST(req: NextRequest) {
    try {
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const rl = consumeRateLimit(`shop-sms-groups-create:${user.id}`, 20, 60 * 60 * 1000)
        if (!rl.allowed) {
            return NextResponse.json({ success: false, error: 'Too many requests. Try again later.' }, { status: 429 })
        }

        const shopId = await getShopId(supabase, user.id)
        if (!shopId) return NextResponse.json({ success: false, error: 'Shop not found' }, { status: 404 })

        const body = await req.json()
        const parsed = createGroupSchema.safeParse(body)
        if (!parsed.success) {
            return NextResponse.json(
                { success: false, error: parsed.error.errors[0]?.message || 'Invalid request' },
                { status: 400 },
            )
        }

        const { count: groupCount } = await supabase
            .from('shop_sms_groups')
            .select('id', { count: 'exact', head: true })
            .eq('shop_id', shopId)
        if ((groupCount ?? 0) >= MAX_GROUPS_PER_SHOP) {
            return NextResponse.json(
                { success: false, error: `Maximum ${MAX_GROUPS_PER_SHOP} groups per shop. Delete one to add more.` },
                { status: 400 },
            )
        }

        const rows = parsed.data.numbers.map(n => (typeof n === 'string' ? { phone: n } : n))
        const result = parsePhoneNumbersFromRows(rows)
        if (result.valid.length === 0) {
            return NextResponse.json({ success: false, error: 'No valid Ghanaian phone numbers found' }, { status: 400 })
        }

        const truncated = result.valid.length > MAX_MEMBERS_PER_GROUP
        const kept = truncated ? result.valid.slice(0, MAX_MEMBERS_PER_GROUP) : result.valid

        // Writes use the service-role client — shop_sms_groups/members have
        // owner-SELECT-only RLS, same lead-intake pattern as shop_customers.
        const adminDb = createServerClient()
        const { data: group, error: groupErr } = await (adminDb as any)
            .from('shop_sms_groups')
            .insert({ shop_id: shopId, name: parsed.data.name })
            .select('id, name, created_at')
            .single()
        if (groupErr) {
            if (groupErr.code === '23505') {
                return NextResponse.json({ success: false, error: 'You already have a group with this name' }, { status: 409 })
            }
            throw groupErr
        }

        const memberRows = kept.map(entry => ({
            group_id: group.id,
            shop_id: shopId,
            phone: entry.phone,
            name: entry.name || null,
        }))
        const { error: membersErr } = await (adminDb as any).from('shop_sms_group_members').insert(memberRows)
        if (membersErr) {
            // Roll back the orphaned group rather than leaving an empty one behind.
            await (adminDb as any).from('shop_sms_groups').delete().eq('id', group.id)
            throw membersErr
        }

        return NextResponse.json({
            success: true,
            data: {
                id: group.id,
                name: group.name,
                memberCount: kept.length,
                truncated,
                duplicateCount: result.duplicateCount,
                invalidCount: result.invalidCount,
            },
        })
    } catch (err) {
        console.error('[ShopSMSGroups] POST error:', err)
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
}
