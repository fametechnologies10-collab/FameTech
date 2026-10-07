import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { validateAdminAccess } from '@/lib/auth-utils'
import { logAdminAction } from '@/lib/admin-audit'
import { sendSMS } from '@/lib/sms-service'
import { consumeRateLimit } from '@/lib/simple-rate-limit'

/**
 * POST /api/admin/users/update-status  (FULL admin only — sub-admins are rejected)
 * Body: { userId, status: 'active'|'suspended'|'inactive',
 *         durationHours?: number|null, until?: string|null, reason?: string,
 *         sendSms?: boolean }
 *
 * Timed suspension: suspended_until = until (ISO) ?? now()+durationHours ?? null (permanent).
 * Reactivation clears all suspension fields. Optional SMS alert to the user.
 * Full-admin accounts can never be targeted (lockout protection).
 */
export async function POST(request: NextRequest) {
    try {
        // allowSubAdmin = false → only full admins pass.
        const authResult = await validateAdminAccess(false, request)
        if (authResult.error) {
            return NextResponse.json({ error: authResult.error }, { status: authResult.status })
        }
        const adminId = (authResult as any).user?.id as string

        const rl = consumeRateLimit(`admin-status:${adminId}`, 30, 60 * 60_000)
        if (!rl.allowed) {
            return NextResponse.json({ error: 'Too many status changes — please wait a while.' }, { status: 429 })
        }

        const body = await request.json().catch(() => ({}))
        const { userId, status, durationHours, until, reason, sendSms } = body || {}

        if (!userId || !status) {
            return NextResponse.json({ error: 'User ID and status are required' }, { status: 400 })
        }
        if (!['active', 'suspended', 'inactive'].includes(status)) {
            return NextResponse.json({ error: 'Invalid status. Must be active, suspended, or inactive' }, { status: 400 })
        }
        if (userId === adminId) {
            return NextResponse.json({ error: 'Cannot change your own account status' }, { status: 400 })
        }

        const supabaseAdmin = createServerClient()

        // Snapshot the target for audit + SMS.
        const { data: target } = await (supabaseAdmin.from('users') as any)
            .select('status, role, phone_number, first_name, suspended_until')
            .eq('id', userId)
            .single()
        if (!target) {
            return NextResponse.json({ error: 'User not found' }, { status: 404 })
        }

        // Lockout protection: a full admin account can never be suspended/deactivated
        // through this route — a single compromised admin session must not be able to
        // lock every other admin out of the platform.
        if (target.role === 'admin') {
            return NextResponse.json({ error: 'Admin accounts cannot be modified from here' }, { status: 403 })
        }

        // Resolve suspended_until for suspensions.
        const MAX_HOURS = 24 * 365 // custom timed suspensions cap at 1 year; use permanent beyond that
        let suspendedUntil: string | null = null
        if (status === 'suspended') {
            if (until) {
                const d = new Date(until)
                if (isNaN(d.getTime())) {
                    return NextResponse.json({ error: 'Invalid "until" date' }, { status: 400 })
                }
                if (d.getTime() <= Date.now()) {
                    return NextResponse.json({ error: 'Suspension end must be in the future' }, { status: 400 })
                }
                if (d.getTime() > Date.now() + MAX_HOURS * 3600_000) {
                    return NextResponse.json({ error: 'Timed suspension cannot exceed 1 year — use Permanent instead' }, { status: 400 })
                }
                suspendedUntil = d.toISOString()
            } else if (durationHours !== undefined && durationHours !== null) {
                if (typeof durationHours !== 'number' || !Number.isFinite(durationHours)
                    || durationHours <= 0 || durationHours > MAX_HOURS) {
                    return NextResponse.json({ error: `durationHours must be between 1 and ${MAX_HOURS}` }, { status: 400 })
                }
                suspendedUntil = new Date(Date.now() + durationHours * 3600_000).toISOString()
            } // else permanent (null)
        }

        const isSuspending = status === 'suspended' || status === 'inactive'
        const update: Record<string, unknown> = { status, updated_at: new Date().toISOString() }
        if (isSuspending) {
            update.suspended_until = suspendedUntil
            update.suspension_reason = (reason || '').toString().slice(0, 500) || null
            update.suspended_at = new Date().toISOString()
            update.suspended_by = adminId
        } else {
            // Reactivation — clear all suspension state.
            update.suspended_until = null
            update.suspension_reason = null
            update.suspended_at = null
            update.suspended_by = null
        }

        const { error: updateError } = await (supabaseAdmin.from('users') as any).update(update).eq('id', userId)
        if (updateError) {
            console.error('Error updating user status:', updateError)
            return NextResponse.json({ error: `Failed to update user status: ${updateError.message}` }, { status: 500 })
        }

        // Audit.
        await logAdminAction(supabaseAdmin, {
            adminId,
            action: isSuspending ? 'suspend' : 'unsuspend',
            targetUserId: userId,
            oldValue: { status: target.status, suspended_until: target.suspended_until },
            newValue: { status, suspended_until: suspendedUntil, reason: reason || null },
        })

        // SMS alert (strict boolean opt-in) + a web push either way.
        const phone = target.phone_number
        if (sendSms === true && phone) {
            let msg: string
            if (isSuspending) {
                const untilTxt = suspendedUntil
                    ? ` until ${new Date(suspendedUntil).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`
                    : ''
                msg = `KiNG FLEXY GH: Your account has been suspended${untilTxt}.${reason ? ' Reason: ' + reason + '.' : ''} Contact support if you believe this is an error.`
            } else {
                msg = `KiNG FLEXY GH: Your account has been reactivated. Welcome back!`
            }
            await sendSMS({ recipient: phone, message: msg })
                .catch((e) => console.error('[Admin] suspension SMS failed:', e))
        }

        if (isSuspending) {
            const { sendPushNotification } = await import('@/lib/push-service')
            await sendPushNotification(userId, {
                title: 'Account Update',
                body: `Your account has been ${status}${suspendedUntil ? ' until ' + new Date(suspendedUntil).toLocaleDateString() : ''}. Please contact support.`,
                url: '/dashboard',
            }).catch((err) => console.error('[Admin] Push error:', err))
        }

        return NextResponse.json({ success: true, suspended_until: suspendedUntil })
    } catch (error: any) {
        console.error('Update status error:', error)
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
    }
}
