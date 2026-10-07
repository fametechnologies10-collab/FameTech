import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { normalizeGhanaPhone } from '@/lib/sms-service'
import { resolveNameSingle, resolveNamesBulk, BULK_ENRICH_TOTAL_CAP } from '@/lib/momo-verify'

// Allow name-enrichment calls time to complete (Moolre + Paystack run sequentially per phone)
export const maxDuration = 60

async function requireAdmin() {
    const client = await createRouteClient()
    const { data: { user }, error } = await client.auth.getUser()
    if (error || !user) return { error: 'Unauthorized', status: 401 }
    const { data } = await client.from('users').select('role').eq('id', user.id).single()
    if (data?.role !== 'admin') return { error: 'Forbidden - Admin only', status: 403 }
    return { user }
}

// ─── POST /api/admin/sms-contacts — add contacts (single or CSV bulk) ─────────
export async function POST(request: NextRequest) {
    try {
        const auth = await requireAdmin()
        if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

        const body = await request.json()
        const groupId: string = (body.group_id || '').trim()

        if (!groupId) return NextResponse.json({ error: 'group_id is required' }, { status: 400 })

        const supabase = createServerClient()

        // Verify group exists
        const { data: groupCheck } = await (supabase as any)
            .from('sms_groups')
            .select('id')
            .eq('id', groupId)
            .single()
        if (!groupCheck) return NextResponse.json({ error: 'Group not found' }, { status: 404 })

        // ── Single contact ──────────────────────────────────────────────────────
        if (body.contact) {
            const { first_name, last_name, phone_number } = body.contact
            const phone = normalizeGhanaPhone(phone_number || '')
            if (!phone) return NextResponse.json({ error: 'Invalid phone number format' }, { status: 400 })

            let finalFirst = (first_name || '').trim() || null
            let finalLast  = (last_name  || '').trim() || null

            // Auto-enrich name server-side when none provided (Moolre → Paystack)
            if (!finalFirst && !finalLast) {
                const resolved = await resolveNameSingle(phone)
                if (resolved) {
                    finalFirst = resolved.firstName || null
                    finalLast  = resolved.lastName  || null
                }
            }

            const { data, error } = await (supabase as any)
                .from('sms_contacts')
                .insert({
                    group_id:     groupId,
                    first_name:   finalFirst,
                    last_name:    finalLast,
                    phone_number: phone,
                })
                .select()
                .single()

            if (error) throw error
            return NextResponse.json({ success: true, contact: data }, { status: 201 })
        }

        // ── Bulk CSV rows ───────────────────────────────────────────────────────
        if (body.rows && Array.isArray(body.rows)) {
            const rows        = body.rows as Array<{ first_name?: string; last_name?: string; phone_number: string }>
            const enrichNames: boolean = body.enrichNames === true

            if (rows.length === 0) return NextResponse.json({ error: 'No rows provided' }, { status: 400 })
            if (rows.length > 5000) return NextResponse.json({ error: 'Max 5,000 contacts per upload' }, { status: 400 })

            // Normalise + filter invalid numbers
            const valid: Array<{ group_id: string; first_name: string | null; last_name: string | null; phone_number: string }> = []
            const skipped: string[] = []

            for (const row of rows) {
                const phone = normalizeGhanaPhone(row.phone_number || '')
                if (!phone) { skipped.push(row.phone_number || '(empty)'); continue }
                valid.push({
                    group_id:     groupId,
                    first_name:   (row.first_name || '').trim() || null,
                    last_name:    (row.last_name  || '').trim() || null,
                    phone_number: phone,
                })
            }

            if (valid.length === 0) {
                return NextResponse.json({ error: 'No valid phone numbers found', skipped }, { status: 400 })
            }

            // Optional name enrichment via multi-provider parallel resolution
            let enriched    = 0
            let capHit      = false
            let providerMap: Record<string, number> = {}

            if (enrichNames) {
                // Collect only the phones that have no name yet
                const nameless = valid
                    .filter(r => !r.first_name && !r.last_name)
                    .map(r => r.phone_number)

                capHit = nameless.length > BULK_ENRICH_TOTAL_CAP

                // resolveNamesBulk splits nameless across all providers in parallel
                const resolved = await resolveNamesBulk(nameless)

                for (const row of valid) {
                    if (row.first_name || row.last_name) continue
                    const result = resolved.get(row.phone_number)
                    if (result) {
                        row.first_name = result.firstName || null
                        row.last_name  = result.lastName  || null
                        enriched++
                        providerMap[result.provider] = (providerMap[result.provider] ?? 0) + 1
                    }
                }
            }

            const { data, error } = await (supabase as any)
                .from('sms_contacts')
                .upsert(valid, { onConflict: 'group_id,phone_number', ignoreDuplicates: true })
                .select('id')

            if (error) throw error

            return NextResponse.json({
                success:       true,
                inserted:      (data || []).length,
                enriched,
                enrich_cap_hit: capHit,
                enrich_cap:    BULK_ENRICH_TOTAL_CAP,
                providers_used: providerMap,
                skipped_count: skipped.length,
                skipped:       skipped.slice(0, 20),
            }, { status: 201 })
        }

        return NextResponse.json({ error: 'Provide either contact or rows in the request body' }, { status: 400 })
    } catch (e: any) {
        console.error('[SMS Contacts POST]', e)
        return NextResponse.json({ error: e.message || 'Internal server error' }, { status: 500 })
    }
}
