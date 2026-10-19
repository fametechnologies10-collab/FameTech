import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { normalizeGhanaPhone } from '@/lib/sms-service'
import { validateAdminAccess } from '@/lib/auth-utils'
import { createAdminSmsBroadcast } from '@/lib/admin-sms-broadcast'

/**
 * POST /api/admin/sms-broadcast
 *
 * Body:
 *   message       - The raw message (may contain [FirstName], [LastName], [Phone])
 *   audience      - 'users' | 'group'
 *   userIds?      - string[] (when audience = 'users')
 *   groupId?      - string   (when audience = 'group')
 *
 * Queues the broadcast for async dispatch instead of sending synchronously —
 * actual sending happens via dispatchAdminSmsBroadcastChunk (lib/admin-sms-broadcast.ts).
 */
export async function POST(request: NextRequest) {
    try {
        const auth = await validateAdminAccess()
        if (auth.error !== null) return NextResponse.json({ error: auth.error }, { status: auth.status })

        const body = await request.json()
        const { message, audience, userIds, groupId } = body

        if (!message || typeof message !== 'string' || !message.trim()) {
            return NextResponse.json({ error: 'message is required' }, { status: 400 })
        }
        if (!['users', 'group'].includes(audience)) {
            return NextResponse.json({ error: 'audience must be "users" or "group"' }, { status: 400 })
        }
        if (audience === 'users' && (!Array.isArray(userIds) || userIds.length === 0)) {
            return NextResponse.json({ error: 'userIds array required when audience = "users"' }, { status: 400 })
        }
        if (audience === 'group' && !groupId) {
            return NextResponse.json({ error: 'groupId required when audience = "group"' }, { status: 400 })
        }

        const supabase = createServerClient()

        // ── Fetch recipients ──────────────────────────────────────────────────
        let recipients: Array<{ first_name: string | null; last_name: string | null; phone_number: string }> = []

        if (audience === 'users') {
            const { data, error } = await (supabase as any)
                .from('users')
                .select('first_name, last_name, phone_number')
                .in('id', userIds)
                .not('phone_number', 'is', null)

            if (error) throw error
            recipients = data || []
        } else {
            const { data, error } = await (supabase as any)
                .from('sms_contacts')
                .select('first_name, last_name, phone_number')
                .eq('group_id', groupId)

            if (error) throw error
            recipients = data || []
        }

        if (recipients.length === 0) {
            return NextResponse.json({ error: 'No recipients with valid phone numbers found' }, { status: 400 })
        }

        // ── Resolve personalized messages ─────────────────────────────────────
        const hasVariables = /\[(FirstName|LastName|Phone)\]/i.test(message)

        const resolved = recipients
            .map(r => {
                const phone = normalizeGhanaPhone(r.phone_number)
                if (!phone) return null
                const msg = hasVariables
                    ? message
                        .replace(/\[FirstName\]/gi, r.first_name || '')
                        .replace(/\[LastName\]/gi,  r.last_name  || '')
                        .replace(/\[Phone\]/gi,      phone)
                    : message
                return { phone, resolvedMessage: msg }
            })
            .filter(Boolean) as Array<{ phone: string; resolvedMessage: string }>

        if (resolved.length === 0) {
            return NextResponse.json({ error: 'No valid phone numbers after normalization' }, { status: 400 })
        }

        // ── Queue for async dispatch ────────────────────────────────────────────
        const { broadcastId, total } = await createAdminSmsBroadcast(supabase, {
            createdBy: auth.user.id,
            message: message.trim(),
            audienceType: audience,
            recipients: resolved,
        })

        return NextResponse.json({ success: true, broadcastId, total })
    } catch (e: any) {
        console.error('[SMSBroadcast] Error:', e)
        return NextResponse.json({ error: e.message || 'Internal server error' }, { status: 500 })
    }
}
