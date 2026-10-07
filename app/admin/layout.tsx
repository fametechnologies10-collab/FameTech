import { getAdminSettings } from '@/lib/admin-settings-cache'
import AdminLayoutClient from './admin-layout-client'

// Admin routes must be strictly dynamic.

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
    // EGRESS: this layout runs on EVERY admin page view. It was previously an
    // uncached admin_settings round-trip per view — see lib/admin-settings-cache.ts.
    // 5-minute TTL (product decision, 2026-09-24) — every key here is pure
    // display copy an admin changes rarely.
    const adminSettings = await getAdminSettings([
        'footer_copyright_text', 'footer_branding_text', 'terms_current_version',
        'terms_min_acceptable_version', 'terms_effective_date',
    ], 5 * 60 * 1000)

    return (
        <AdminLayoutClient adminSettings={adminSettings}>
            {children}
        </AdminLayoutClient>
    )
}
