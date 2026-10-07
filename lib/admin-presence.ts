import { createServerClient } from '@/lib/supabase'

// "Active" window for the customer-facing green/amber support badge — not a
// real presence system, just a heartbeat last-seen check.
export const ADMIN_ACTIVE_WINDOW_MS = 3 * 60 * 1000

export async function touchAdminPresence(adminId: string): Promise<void> {
    const supabase = createServerClient() as any
    await supabase
        .from('admin_presence')
        .upsert({ admin_id: adminId, last_seen_at: new Date().toISOString() })
}

export async function isSupportActive(): Promise<boolean> {
    const supabase = createServerClient() as any
    const since = new Date(Date.now() - ADMIN_ACTIVE_WINDOW_MS).toISOString()
    const { count } = await supabase
        .from('admin_presence')
        .select('admin_id', { count: 'exact', head: true })
        .gte('last_seen_at', since)
    return (count || 0) > 0
}
