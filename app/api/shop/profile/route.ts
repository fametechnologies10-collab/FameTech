import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { revalidateTag } from 'next/cache'
import { createClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { z } from 'zod'
import {
    shortTextSchema,
    longTextSchema,
    phoneSchema,
    emailSchema,
    slugSchema,
    whatsappSchema,
    urlSchema,
    colorSchema,
} from '@/lib/validation'

// ─── Validation Schema ────────────────────────────────────────────────────────
// Every field a shop owner is allowed to write. Protected fields (owner_id,
// is_active, approval_status) are intentionally absent — they cannot be set here.
const shopProfileSchema = z.object({
    shop_name:       shortTextSchema,
    shop_slug:       slugSchema,
    description:     longTextSchema.or(z.literal('')).optional().nullable(),
    // Optional at write time — the wizard creates the shop on Step 1 with
    // only shop_name/shop_slug (see spec §4). Enforced instead right before
    // go-live, in app/api/shop/pricing/route.ts.
    owner_phone:     phoneSchema.or(z.literal('')).optional().nullable(),
    owner_email:     emailSchema.or(z.literal('')).optional().nullable(),
    whatsapp_number: whatsappSchema.or(z.literal('')).optional().nullable(),
    community_link:  urlSchema.or(z.literal('')).optional().nullable(),
    brand_color:     colorSchema.optional(),
    brand_accent:    colorSchema.optional(),
    logo_url:        urlSchema.or(z.literal('')).optional().nullable(),
    divider_style:   shortTextSchema.optional(),
    // Setup wizard state — strictly shaped, never trusted for anything
    // beyond resuming the wizard UI.
    setup_progress:  z.object({
        step:      z.number().int().min(0).max(5),
        completed: z.array(z.enum(['details', 'contact', 'community', 'branding', 'sms', 'ussd'])).max(6),
    }).optional(),
})

// Helper: convert empty strings to null for optional text fields
function emptyToNull(val: string | undefined | null): string | null {
    if (val === undefined || val === null || val.trim() === '') return null
    return val.trim()
}

// ─── POST — Create shop ───────────────────────────────────────────────────────
export async function POST(request: NextRequest) {
    return handleShopProfileWrite(request, 'create')
}

// ─── PUT — Update shop ────────────────────────────────────────────────────────
export async function PUT(request: NextRequest) {
    return handleShopProfileWrite(request, 'update')
}

// ─── Shared handler ───────────────────────────────────────────────────────────
async function handleShopProfileWrite(request: NextRequest, mode: 'create' | 'update') {
    try {
        // 1. Authenticate
        const cookieStore = await cookies()
        const supabaseUserClient = await createRouteClient()

        const { data: { user: authUser }, error: authError } = await supabaseUserClient.auth.getUser()
        if (authError || !authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const userId = authUser.id
        const body = await request.json()

        // 2. Strict input validation (XSS / format prevention)
        const validation = shopProfileSchema.safeParse(body)
        if (!validation.success) {
            const errorDetails = validation.error.errors.map(
                err => `${err.path.join('.')}: ${err.message}`
            )
            console.warn(`[Security] Shop profile input rejected for user ${userId}: ${errorDetails.join(', ')}`)
            return NextResponse.json({ error: 'Invalid input', details: errorDetails }, { status: 400 })
        }

        // 3. Mass-assignment protection — explicitly destructure only allowed fields
        const data = validation.data as {
            shop_name: string
            shop_slug: string
            description?: string
            owner_phone?: string | null
            owner_email?: string | null
            whatsapp_number?: string | null
            community_link?: string | null
            brand_color?: string
            brand_accent?: string
            logo_url?: string | null
            divider_style?: string
            setup_progress?: { step: number; completed: string[] }
        }

        // Build safe DB payload — empty optional strings become null
        const dbPayload = {
            shop_name:       data.shop_name.trim(),
            shop_slug:       data.shop_slug.trim(),
            description:     emptyToNull(data.description),
            // Omitted (undefined) means "field not sent this request" — leave the
            // key out of the payload entirely (JSON.stringify drops undefined
            // values) so a partial PUT from a later wizard step never clobbers a
            // phone number saved by an earlier step. Only normalize when the key
            // was actually present (mirrors the logo_url pattern below). Applied
            // to every field the wizard's per-step savePartial() PUTs
            // independently (contact/community/branding) — each step's request
            // omits every other step's fields, so all of them need this guard,
            // not just owner_phone/logo_url.
            owner_phone:     data.owner_phone === undefined ? undefined : emptyToNull(data.owner_phone),
            owner_email:     data.owner_email === undefined ? undefined : emptyToNull(data.owner_email),
            whatsapp_number: data.whatsapp_number === undefined ? undefined : emptyToNull(data.whatsapp_number),
            community_link:  data.community_link === undefined ? undefined : emptyToNull(data.community_link),
            brand_color:     data.brand_color?.trim() || undefined,
            brand_accent:    data.brand_accent?.trim() || undefined,
            logo_url:        data.logo_url === undefined ? undefined : (data.logo_url ? data.logo_url.trim() : null),
            divider_style:   data.divider_style?.trim() || undefined,
            setup_progress:  data.setup_progress,
            updated_at:      new Date().toISOString(),
        }

        // 4. Use service role to bypass RLS (same pattern as update-profile)
        const supabaseAdmin = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!
        )

        if (mode === 'create') {
            // Check the user doesn't already have a shop (idempotency guard)
            const { data: existing } = await (supabaseAdmin as any)
                .from('shop_profiles')
                .select('id')
                .eq('owner_id', userId)
                .maybeSingle()

            if (existing) {
                return NextResponse.json(
                    { error: 'You already have a shop. Use PUT to update it.' },
                    { status: 409 }
                )
            }

            // Fetch user role and auto-approve setting
            const { data: userRow } = await (supabaseAdmin as any)
                .from('users')
                .select('role')
                .eq('id', userId)
                .maybeSingle()
            const userRole = userRow?.role || 'customer'

            const { data: autoApproveRow } = await (supabaseAdmin as any)
                .from('shop_global_settings')
                .select('value')
                .eq('key', `auto_approve_profile_${userRole}`)
                .maybeSingle()
            // Default: auto-approve if setting is missing or explicitly true
            const autoApproveProfile =
                autoApproveRow === null ||
                (autoApproveRow?.value !== false &&
                    autoApproveRow?.value !== 'false' &&
                    autoApproveRow?.value !== 0 &&
                    autoApproveRow?.value !== '0')

            const { error: insertError } = await (supabaseAdmin as any)
                .from('shop_profiles')
                .insert({
                    ...dbPayload,
                    owner_id: userId,
                    approval_status: autoApproveProfile ? 'approved' : 'pending',
                    is_active: false,
                })

            if (insertError) {
                console.error('[ShopProfile] Insert error:', insertError)
                // Expose slug conflict specifically for UI feedback
                if (insertError.code === '23505') {
                    return NextResponse.json(
                        { error: 'Invalid input', details: ['shop_slug: This slug is already taken'] },
                        { status: 409 }
                    )
                }
                return NextResponse.json({ error: 'Failed to create shop' }, { status: 500 })
            }
        } else {
            // Verify shop belongs to this authenticated user before updating
            const { data: existing } = await (supabaseAdmin as any)
                .from('shop_profiles')
                .select('id, is_active')
                .eq('owner_id', userId)
                .maybeSingle()

            if (!existing) {
                return NextResponse.json({ error: 'Shop not found' }, { status: 404 })
            }

            // Security gate: owner_phone is optional at write time (the wizard
            // creates a shop with just name+slug), but once a shop is live it
            // must keep a contact number. Block a write that would clear it on
            // an already-active shop. A payload that omits owner_phone entirely
            // (dbPayload.owner_phone === undefined) is untouched by this check —
            // only an explicit attempt to null/empty it while live is rejected.
            if (
                existing.is_active &&
                dbPayload.owner_phone !== undefined &&
                dbPayload.owner_phone === null
            ) {
                return NextResponse.json(
                    { error: 'Contact phone number cannot be removed while your shop is live.' },
                    { status: 400 }
                )
            }

            const { error: updateError } = await (supabaseAdmin as any)
                .from('shop_profiles')
                .update(dbPayload)
                .eq('owner_id', userId)

            if (updateError) {
                console.error('[ShopProfile] Update error:', updateError)
                if (updateError.code === '23505') {
                    return NextResponse.json(
                        { error: 'Invalid input', details: ['shop_slug: This slug is already taken'] },
                        { status: 409 }
                    )
                }
                return NextResponse.json({ error: 'Failed to update shop' }, { status: 500 })
            }
        }

        // Invalidate Edge Cache for this shop instantly
        if (dbPayload.shop_slug) {
            revalidateTag(`shop-${dbPayload.shop_slug}`)
        }

        return NextResponse.json({ success: true }, { status: 200 })

    } catch (e: any) {
        console.error('[ShopProfile] API error:', e)
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }
}
