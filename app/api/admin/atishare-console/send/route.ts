import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { createServerClient } from '@/lib/supabase'
import { sendBundle, gbToMb, normalizeConsolePhone } from '@/lib/atishare-console-service'
import { validateAdminAccess } from '@/lib/auth-utils'
import { z } from 'zod'
import { phoneSchema } from '@/lib/validation'

const bodySchema = z.object({
    phone: phoneSchema,
    sizeGb: z.number().positive().max(100),
})

export async function POST(request: NextRequest) {
    // allowSubAdmin = false (the default) — DELIBERATE. This endpoint spends real console
    // balance with no customer order behind it, so it is restricted to full admins even
    // though the read-only sync route allows sub-admins.
    const authResult = await validateAdminAccess(false, request)
    if (authResult.error || !authResult.user) {
        return NextResponse.json({ success: false, error: authResult.error }, { status: authResult.status })
    }
    const authUser = authResult.user

    const parsed = bodySchema.safeParse(await request.json().catch(() => ({})))
    if (!parsed.success) {
        return NextResponse.json({ success: false, error: 'Invalid phone number or bundle size' }, { status: 400 })
    }

    const phone = normalizeConsolePhone(parsed.data.phone)
    const bundleMb = gbToMb(parsed.data.sizeGb)

    // Cast to `any`: `atishare_console_manual_sends` is created by
    // supabase/migrations/20260821c_atishare_console_manual_sends.sql, which this task
    // deliberately does NOT apply (see task brief) — so it is absent from the generated
    // types/supabase.ts Database type until the controller applies the migration and
    // regenerates types. Same convention already used in
    // app/api/admin/fulfillment/sync-atishare-console/route.ts and
    // app/api/admin/payments/retry-fulfillment/route.ts for pre-migration columns/tables.
    const admin = createServerClient() as any

    // ── Double-submit guard: a short recency window, NOT the reference ──────────
    // Pre-flight Ruling 2. The reference must NOT be content-derived here. SPFastIT
    // returns the EXISTING transaction when a reference is replayed with the same phone
    // and bundle, so a stable `MANUAL-<admin>-<phone>-<mb>` would make a legitimate second
    // gift of the same size to the same number return the first transaction and send
    // NOTHING — the recipient gets no data while this route reports success.
    //
    // A repeat gift is a genuinely new operation, unlike the order-dispatch path where the
    // same logical order must always resolve to the same reference.
    const windowStart = new Date(Date.now() - 60_000).toISOString()
    const { data: recent, error: recentError } = await admin
        .from('atishare_console_manual_sends')
        .select('id')
        .eq('admin_id', authUser.id)
        .eq('phone', phone)
        .eq('bundle_mb', bundleMb)
        .gte('created_at', windowStart)
        .limit(1)

    // Fail CLOSED: if we can't verify the dedup window, do not send. A rejected click the
    // admin can retry is far cheaper than a duplicate data gift going out unchecked.
    if (recentError) {
        console.error('[AtiShareConsoleSend] Recency check failed:', recentError.message)
        return NextResponse.json(
            { success: false, error: 'Could not verify duplicate-send protection. Please try again.' },
            { status: 500 }
        )
    }

    if (recent && recent.length > 0) {
        return NextResponse.json(
            { success: false, error: 'An identical send was made in the last minute. Wait a moment before repeating it.' },
            { status: 409 }
        )
    }

    // Unique per send. Still within SPFastIT's 100-char limit and allowed charset
    // (letters, numbers, dot, underscore, colon, hyphen).
    const clientReference = `MANUAL-${randomUUID()}`

    const { error: claimError } = await admin.from('atishare_console_manual_sends').insert({
        admin_id: authUser.id,
        phone,
        bundle_mb: bundleMb,
        client_reference: clientReference,
        status: 'queued',
    })

    if (claimError) {
        return NextResponse.json({ success: false, error: 'Could not record the send' }, { status: 500 })
    }

    const result = await sendBundle({ phone, bundleMb, clientReference })

    await admin
        .from('atishare_console_manual_sends')
        .update({
            transaction_id: result.transactionId ?? null,
            status: result.success ? 'queued' : 'failed',
            response: result.apiResponse ?? { error: result.error ?? null },
        })
        .eq('client_reference', clientReference)

    if (!result.success) {
        return NextResponse.json({ success: false, error: result.error || 'Send failed' }, { status: 502 })
    }

    return NextResponse.json({
        success: true,
        data: { transactionId: result.transactionId, duplicate: result.duplicate === true, phone, bundleMb },
    })
}
