// app/api/user/website-requests/route.ts
import { NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createAdminClient } from '@/lib/supabase-admin'
import { websiteRequestSchema } from '@/lib/website-request-validation'
import { isValidFeatureSet } from '@/lib/website-request-categories'
import { checkWebsiteRequestCreateLimit } from '@/lib/website-request-rate-limit'

export const dynamic = 'force-dynamic'

// No GET handler: the dashboard reads the caller's own open request directly via the
// RLS-aware browser client (owner-SELECT policy + column grant), folded into its existing
// parallel fetch — that avoids putting a serverless round-trip on the dashboard's render path.

// POST /api/user/website-requests — submit a new full_request or call_request.
export async function POST(request: Request) {
    try {
        const supabase = await createRouteClient()
        const { data: { user }, error: authError } = await supabase.auth.getUser()
        if (authError || !user) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
        }

        const body = await request.json().catch(() => null)
        const validation = websiteRequestSchema.safeParse(body)
        if (!validation.success) {
            const details = validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`)
            return NextResponse.json({ success: false, error: 'Invalid input', details }, { status: 400 })
        }
        const input = validation.data

        if (input.request_type === 'full_request' && !isValidFeatureSet(input.category, input.features)) {
            return NextResponse.json({ success: false, error: 'Invalid feature selection for this category' }, { status: 400 })
        }

        if (!(await checkWebsiteRequestCreateLimit(user.id))) {
            return NextResponse.json(
                { success: false, error: 'Too many requests submitted. Please wait a while before trying again.' },
                { status: 429 }
            )
        }

        const adminDb = createAdminClient() as any

        const insertPayload = input.request_type === 'full_request'
            ? {
                user_id: user.id,
                request_type: 'full_request',
                category: input.category,
                budget_ghs: input.budget_ghs,
                features: input.features,
                timeline: input.timeline,
                description: input.description.trim(),
                reference_sites: input.reference_sites?.trim() || null,
                contact_phone: input.contact_phone,
                contact_whatsapp: input.contact_whatsapp || input.contact_phone,
            }
            : {
                user_id: user.id,
                request_type: 'call_request',
                description: input.description.trim(),
                contact_phone: input.contact_phone,
                contact_whatsapp: input.contact_whatsapp || input.contact_phone,
            }

        const { data: row, error: insertError } = await adminDb
            .from('website_requests')
            .insert(insertPayload)
            .select()
            .single()

        if (insertError) {
            if (String(insertError.message).includes('OPEN_WEBSITE_REQUEST_LIMIT')) {
                return NextResponse.json(
                    { success: false, error: 'You already have an active request. We\'ll reach out soon — you can submit a new one once it\'s closed.' },
                    { status: 409 }
                )
            }
            throw insertError
        }

        return NextResponse.json({ success: true, data: row }, { status: 201 })
    } catch (error: any) {
        console.error('[WebsiteRequests] Error creating request:', error)
        return NextResponse.json({ success: false, error: 'Failed to submit request' }, { status: 500 })
    }
}
