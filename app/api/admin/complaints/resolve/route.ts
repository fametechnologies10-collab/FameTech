import { createServerClient } from '@/lib/supabase'
import { validateAdminAccess } from '@/lib/auth-utils'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
    try {
        // SEC-021: in-handler authorization — resolving complaints is an admin action.
        // Admin-only: complaints are not under the sub-admin orders allowlist.
        const access = await validateAdminAccess(false, request)
        if (access.error) return NextResponse.json({ error: access.error }, { status: access.status })

        const body = await request.json()
        const { id, status } = body

        // Only terminal states are valid resolutions; recipient and order ref are
        // derived from the complaint row below — never trusted from the client.
        if (!id || !['resolved', 'rejected'].includes(status)) {
            return NextResponse.json(
                { error: 'Missing or invalid fields' },
                { status: 400 }
            )
        }

        // Coerce to a bounded string — this value flows into an HTML email and
        // the DB column, so reject non-strings and cap the length.
        const resolution_notes = typeof body.resolution_notes === 'string'
            ? body.resolution_notes.trim().slice(0, 2000)
            : ''

        const supabase = createServerClient()

        const { data: complaint, error: fetchError } = await (supabase
            .from('complaints') as any)
            .select('id, user_id, orders (reference_code)')
            .eq('id', id)
            .maybeSingle()
        if (fetchError) throw fetchError
        if (!complaint) {
            return NextResponse.json({ error: 'Complaint not found' }, { status: 404 })
        }
        const user_id = complaint.user_id
        const order_ref = complaint.orders?.reference_code || 'N/A'

        // Update complaint
        const { error: updateError } = await (supabase
            .from('complaints') as any)
            .update({
                status,
                resolution_notes,
                updated_at: new Date().toISOString()
            })
            .eq('id', id)

        if (updateError) throw updateError

        // Create notification
        const { error: notifyError } = await (supabase
            .from('notifications') as any)
            .insert({
                user_id,
                title: `Complaint ${status === 'resolved' ? 'Resolved' : 'Rejected'}`,
                message: `Your complaint regarding order ${order_ref} has been ${status}.`,
                type: 'complaint_resolved',
                action_url: '/dashboard/complaints'
            })

        if (notifyError) {
            console.error('Error creating notification:', notifyError)
        }

        // Send email notification
        try {
            // Fetch user email first
            const { data: userData } = await (supabase
                .from('users') as any)
                .select('email, first_name')
                .eq('id', user_id)
                .single()

            if (userData?.email) {
                const { sendComplaintResolvedEmail } = await import('@/lib/email-service')
                await sendComplaintResolvedEmail(
                    userData.email,
                    userData.first_name || 'User',
                    {
                        orderRef: order_ref,
                        status,
                        resolutionNotes: resolution_notes || ''
                    }
                )
            }
        } catch (emailError) {
            console.error('Failed to send resolution email:', emailError)
            // Don't fail the request
        }

        return NextResponse.json({ success: true })
    } catch (error: any) {
        console.error('Error resolving complaint:', error)
        return NextResponse.json(
            { error: error?.message || 'Failed to resolve complaint' },
            { status: 500 }
        )
    }
}
