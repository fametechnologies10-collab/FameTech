import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createRouteClient } from '@/lib/supabase-server'
import { revalidateTag } from 'next/cache'
import { createServerClient } from '@/lib/supabase'
import { adminLongTextSchema } from '@/lib/validation'

// Every admin write to shop_profiles' status columns goes through here (service role):
// protect_shop_admin_columns pins approval_status / is_active / approved_* for ANY
// authenticated writer — admins included — so a browser-side update of those columns is
// silently reverted while still returning success. See docs/security-audits/ (F16).

const noteSchema = adminLongTextSchema.transform(s => s.trim())

// Profile approval — the original contract, still used by app/admin/shops/page.tsx.
const approvalSchema = z.object({
    shopId: z.string().uuid(),
    status: z.enum(['approved', 'rejected', 'suspended']),
    note: noteSchema.nullish(),
})

const pricingSchema = z.discriminatedUnion('action', [
    z.object({ shopId: z.string().uuid(), action: z.literal('approve_pricing') }),
    z.object({ shopId: z.string().uuid(), action: z.literal('reject_pricing'), note: noteSchema.pipe(z.string().min(1, 'A rejection note is required')) }),
    z.object({ shopId: z.string().uuid(), action: z.literal('revoke_pricing'), note: noteSchema.pipe(z.string().min(1, 'A revocation reason is required')) }),
])

const fail = (error: string, status: number) => NextResponse.json({ success: false, error }, { status })

export async function PATCH(request: NextRequest) {
    try {
        const supabaseUserClient = await createRouteClient()

        // 1. Authenticate caller
        const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()
        if (authError || !authUser) return fail('Unauthorized', 401)

        // 2. Verify caller is an admin. Sub-admins are orders-only (middleware already
        // blocks them from /api/admin/shops — this is the in-route second check).
        const { data: callerUser } = await supabaseUserClient
            .from('users')
            .select('role')
            .eq('id', authUser.id)
            .single()

        if (!callerUser || callerUser.role !== 'admin') return fail('Forbidden', 403)

        // 3. Parse and validate body
        const body = await request.json().catch(() => null)
        const isPricing = body && typeof body === 'object' && 'action' in body
        const parsed = isPricing ? pricingSchema.safeParse(body) : approvalSchema.safeParse(body)
        if (!parsed.success) return fail(parsed.error.issues[0]?.message || 'Invalid request', 400)

        // 4. Use service role to bypass RLS and the column-pinning trigger
        const supabase = createServerClient() as any

        // 5. Guard against 0-row silent updates — verify shop exists first
        const { data: existing } = await supabase
            .from('shop_profiles')
            .select('id, shop_slug, approval_status, pricing_status')
            .eq('id', parsed.data.shopId)
            .maybeSingle()

        if (!existing) return fail('Shop not found', 404)

        const now = new Date().toISOString()
        const data = parsed.data

        if ('status' in data) {
            const updatePayload: Record<string, any> = {
                approval_status: data.status,
                approved_by: authUser.id,
                approved_at: now,
                updated_at: now,
            }
            // Omitted → leave the note alone; '' / null → clear it.
            if (data.note !== undefined) updatePayload.approval_note = data.note || null

            if (data.status === 'approved') {
                // Allow owner to now configure pricing
                updatePayload.pricing_status = 'not_submitted'
            }
            if (data.status === 'rejected' || data.status === 'suspended') {
                updatePayload.is_active = false
            }

            const { error: updateError } = await supabase
                .from('shop_profiles')
                .update(updatePayload)
                .eq('id', data.shopId)
            if (updateError) throw updateError
        } else if (data.action === 'approve_pricing') {
            // The owner's prices are already in shop_pricing (app/api/shop/pricing writes them
            // and parks the shop offline in 'pending_review'); approving just publishes them.
            // CAS on both statuses: never go live over a suspension, or on a stale review.
            const { data: rows, error } = await supabase
                .from('shop_profiles')
                .update({
                    pricing_status: 'approved',
                    pricing_note: null,
                    pricing_approved_at: now,
                    pricing_approved_by: authUser.id,
                    is_active: true,
                    updated_at: now,
                })
                .eq('id', data.shopId)
                .eq('approval_status', 'approved')
                .eq('pricing_status', 'pending_review')
                .select('id')
            if (error) throw error
            if (!rows?.length) return fail('This shop has no pricing awaiting review', 409)
        } else if (data.action === 'reject_pricing') {
            const { data: rows, error } = await supabase
                .from('shop_profiles')
                .update({
                    pricing_status: 'rejected',
                    pricing_note: data.note,
                    pricing_rejection_acknowledged: false,
                    updated_at: now,
                })
                .eq('id', data.shopId)
                .eq('pricing_status', 'pending_review')
                .select('id')
            if (error) throw error
            if (!rows?.length) return fail('This shop has no pricing awaiting review', 409)
        } else {
            // revoke_pricing: take the shop offline FIRST, then clear its price list — if the
            // delete fails the shop is offline with stale prices (safe), never live without them.
            const { error: updateError } = await supabase
                .from('shop_profiles')
                .update({
                    pricing_status: 'rejected',
                    pricing_note: data.note,
                    pricing_rejection_acknowledged: false,
                    is_active: false,
                    updated_at: now,
                })
                .eq('id', data.shopId)
            if (updateError) throw updateError

            const { error: deleteError } = await supabase
                .from('shop_pricing')
                .delete()
                .eq('shop_id', data.shopId)
            if (deleteError) throw deleteError
        }

        // Invalidate Edge Cache for this shop instantly
        if (existing.shop_slug) {
            revalidateTag(`shop-${existing.shop_slug}`)
        }

        return NextResponse.json({ success: true })

    } catch (error: any) {
        console.error('[AdminShops API]', error)
        return fail(error.message || 'Internal server error', 500)
    }
}
