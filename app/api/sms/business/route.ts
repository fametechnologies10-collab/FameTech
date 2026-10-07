/**
 * /api/sms/business — business registration (KFT SMS).
 *
 * GET : own profile + the admin WhatsApp number to send KYC documents to.
 * POST: save draft / submit for review. Domain + description unlock business
 *       mode on ADMIN approval (mode flip happens in the admin route, never
 *       here). Ghana Card number is masked server-side before storage.
 *       Ghana Card / business-registration documents are sent to the admin
 *       over WhatsApp, not uploaded — admin marks whatsapp_verified before
 *       approving (see app/api/admin/sms-platform/route.ts).
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { consumeRateLimit } from '@/lib/simple-rate-limit'
import { getSmsAccountContext } from '@/lib/sms-campaign-pipeline'
import { sendAdminPushNotification } from '@/lib/push-service'
import { getAdminSettings } from '@/lib/admin-settings-cache'
import { whatsappSchema } from '@/lib/validation'
import { normalizeWhatsAppNumber } from '@/lib/utils'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
    action: z.enum(['save', 'submit']),
    businessName: z.string().min(2).max(120),
    description: z.string().min(10).max(2000),
    domainLink: z.string().max(200).optional().nullable(),
    ghanaCardNumber: z.string().max(30).optional().nullable(),
    // Applicant's own WhatsApp number — required to submit, so admin can
    // reach out directly instead of only waiting to be messaged.
    contactWhatsapp: z.string().max(20).optional().nullable(),
})

// Ghana Card format: GHA-XXXXXXXXX-X (9 digits + 1 check digit), dashes and
// spaces optional. Validated against the normalized (spaces stripped,
// uppercased) value.
const GHANA_CARD_RE = /^GHA-?\d{9}-?\d$/

function normalizeGhanaCard(raw: string | null | undefined): string {
    return (raw || '').replace(/\s/g, '').toUpperCase()
}

function isValidGhanaCard(normalized: string): boolean {
    return GHANA_CARD_RE.test(normalized)
}

function maskGhanaCard(raw: string | null | undefined): string | null {
    const s = (raw || '').replace(/\s/g, '')
    if (!s) return null
    const last4 = s.slice(-4)
    return `GHA-*****${last4}`
}

function normalizeDomain(raw: string | null | undefined): string | null {
    const s = (raw || '').trim().toLowerCase()
    if (!s) return null
    return s.replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0].slice(0, 100) || null
}

export async function GET() {
    try {
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const adminSettings = await getAdminSettings(['whatsapp_admin_number'])
        const whatsappAdminNumber = adminSettings.whatsapp_admin_number || ''

        const db = createServerClient() as any
        const { data: account } = await db.from('sms_accounts').select('id').eq('user_id', user.id).maybeSingle()
        if (!account) return NextResponse.json({ success: true, data: { profile: null, whatsappAdminNumber } })

        const { data: profile } = await db.from('sms_business_profiles')
            .select('business_name, description, domain_link, ghana_card_number_masked, contact_whatsapp_number, status, review_notes, reviewed_at, created_at')
            .eq('account_id', (account as any).id).maybeSingle()
        return NextResponse.json({ success: true, data: { profile: profile ?? null, whatsappAdminNumber } })
    } catch (e: any) {
        console.error('[SMS Business GET] error:', e?.message)
        return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 })
    }
}

export async function POST(request: NextRequest) {
    try {
        const supabase = await createRouteClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const rl = consumeRateLimit(`sms-business:${user.id}`, 10, 60_000)
        if (!rl.allowed) return NextResponse.json({ success: false, error: 'Too many requests' }, { status: 429 })

        const parsed = bodySchema.safeParse(await request.json().catch(() => null))
        if (!parsed.success) {
            return NextResponse.json({ success: false, error: 'Invalid request: ' + parsed.error.issues[0]?.message }, { status: 400 })
        }
        const input = parsed.data

        const db = createServerClient() as any
        const ctxRes = await getSmsAccountContext(db, user.id)
        if (!ctxRes.ok) return NextResponse.json({ success: false, error: ctxRes.error }, { status: ctxRes.status })
        const accountId = ctxRes.ctx.account.id

        const { data: existing } = await db.from('sms_business_profiles')
            .select('id, status').eq('account_id', accountId).maybeSingle()
        if (existing && ['under_review', 'approved'].includes((existing as any).status)) {
            return NextResponse.json({ success: false, error: 'Profile is locked while under review or approved' }, { status: 409 })
        }

        const nextStatus = input.action === 'submit' ? 'under_review' : 'draft'
        const ghanaCardNormalized = normalizeGhanaCard(input.ghanaCardNumber)
        const ghanaCardProvided = ghanaCardNormalized.length > 0
        const ghanaCardValid = ghanaCardProvided && isValidGhanaCard(ghanaCardNormalized)
        const contactWhatsappParsed = whatsappSchema.safeParse(normalizeWhatsAppNumber(input.contactWhatsapp || ''))
        if (input.action === 'submit') {
            if (!normalizeDomain(input.domainLink)) {
                return NextResponse.json({ success: false, error: 'A business domain link is required to submit for review' }, { status: 400 })
            }
            if (!ghanaCardValid) {
                return NextResponse.json({ success: false, error: 'Enter a valid Ghana Card number (GHA-XXXXXXXXX-X)' }, { status: 400 })
            }
            if (!contactWhatsappParsed.success) {
                return NextResponse.json({ success: false, error: 'Enter a valid WhatsApp number (e.g. 233244123456) so we can reach you' }, { status: 400 })
            }
        } else if (ghanaCardProvided && !ghanaCardValid) {
            // Draft save: Ghana Card stays optional, but a partially-typed
            // value must still be well-formed so it can't get silently
            // saved and masked wrong.
            return NextResponse.json({ success: false, error: 'Enter a valid Ghana Card number (GHA-XXXXXXXXX-X)' }, { status: 400 })
        }

        const row = {
            account_id: accountId,
            business_name: input.businessName.trim(),
            description: input.description.trim(),
            domain_link: normalizeDomain(input.domainLink),
            ghana_card_number_masked: maskGhanaCard(input.ghanaCardNumber),
            contact_whatsapp_number: contactWhatsappParsed.success ? contactWhatsappParsed.data : null,
            status: nextStatus,
            review_notes: null,
            // Any save/submit means the user is providing fresh information
            // that hasn't been WhatsApp-verified yet — reset verification so
            // a prior admin sign-off never silently carries forward onto
            // edited/resubmitted content (Fix C1).
            whatsapp_verified: false,
            whatsapp_verification_note: null,
            updated_at: new Date().toISOString(),
        }

        const { error } = existing
            ? await db.from('sms_business_profiles').update(row).eq('id', (existing as any).id)
            : await db.from('sms_business_profiles').insert(row)
        if (error) {
            console.error('[SMS Business POST] write error:', error.message)
            return NextResponse.json({ success: false, error: 'Could not save profile' }, { status: 500 })
        }

        if (input.action === 'submit') {
            sendAdminPushNotification({
                title: 'New SMS business registration',
                body: `${row.business_name} submitted a business profile for review (domain: ${row.domain_link || 'n/a'}).`,
                url: '/admin/sms-platform',
            }).catch((err) => console.error('[SMS Business POST] admin push failed:', err?.message))
        }

        return NextResponse.json({ success: true, data: { status: nextStatus } })
    } catch (e: any) {
        console.error('[SMS Business POST] error:', e?.message)
        return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 })
    }
}
