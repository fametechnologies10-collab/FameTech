// lib/admin-audit.ts
// Fire-and-forget audit logging for admin actions on users.
// Writes to public.admin_audit_log (admin_id, action, target_user_id, old_value, new_value).
import type { SupabaseClient } from '@supabase/supabase-js'

export type AdminUserAction =
    | 'suspend'
    | 'unsuspend'
    | 'role_change'
    | 'wallet_credit'
    | 'wallet_debit'
    | 'delete'
    | 'reset_password'
    | 'view_momo_details'
    | 'afa_status_change'

export async function logAdminAction(
    supabaseAdmin: SupabaseClient,
    params: {
        adminId: string
        action: AdminUserAction
        targetUserId: string
        oldValue?: unknown
        newValue?: unknown
    },
): Promise<void> {
    try {
        const { error } = await (supabaseAdmin.from('admin_audit_log') as any).insert({
            admin_id: params.adminId,
            action: params.action,
            target_user_id: params.targetUserId,
            old_value: params.oldValue ?? null,
            new_value: params.newValue ?? null,
        })
        // supabase-js RETURNS errors rather than throwing, so the catch below never
        // saw them — a failed audit write (e.g. a NOT NULL violation on
        // target_user_id) used to vanish with no trace at all.
        if (error) {
            console.error('[admin-audit] insert rejected for', params.action, error)
        }
    } catch (e) {
        // Never let audit failure break the primary action.
        console.error('[admin-audit] failed to log', params.action, e)
    }
}
