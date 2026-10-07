import { createServerClient } from '@supabase/ssr'
import { createServerClient as createAdminClient } from '@/lib/supabase'
import { getAdminSettings } from '@/lib/admin-settings-cache'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import DashboardLayoutClient from './dashboard-layout-client'

export const dynamic = 'force-dynamic'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
    const cookieStore = await cookies()

    // Verify session and get user ID via the cookie-aware SSR client.
    const authClient = createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
            cookies: {
                getAll() { return cookieStore.getAll() },
                setAll() { /* read-only in layout */ },
            },
        }
    )
    const { data: { user } } = await authClient.auth.getUser()

    if (!user) {
        redirect('/auth')
    }

    const admin = createAdminClient()

    // Run both queries in parallel: admin settings (cached — this layout runs on
    // EVERY dashboard page view, see lib/admin-settings-cache.ts) + profile
    // completeness check (per-user, never cached). 5-minute TTL (product
    // decision, 2026-09-24) — every key here is pure display copy an admin
    // changes rarely.
    const [adminSettings, profileResult] = await Promise.all([
        getAdminSettings([
            'footer_copyright_text', 'footer_branding_text', 'whatsapp_community_link',
            'signup_promo_role', 'terms_current_version', 'terms_min_acceptable_version',
            'terms_effective_date',
        ], 5 * 60 * 1000),
        (admin.from('users') as any)
            .select('phone_number, phone_verified, role')
            .eq('id', user.id)
            .single(),
    ])

    // Users who signed up via Google before the phone+password requirement
    // are sent here to complete their profile before accessing the dashboard.
    if (!profileResult.data?.phone_number) {
        redirect('/auth/complete-profile')
    }

    // Mandatory phone verification gate (2026-09-30) — every authenticated
    // user must verify the number on file (or recover a new one) before
    // reaching any dashboard page. Runs on every request, so it retroactively
    // catches already-logged-in sessions on their next navigation.
    if (!profileResult.data?.phone_verified) {
        redirect('/auth/verify-phone-required')
    }

    // Removed 2026-09-30 (owner decision): sub-agents used to be forced to
    // change their access key into a self-chosen password on first login.
    // Now that access keys are delivered over SMS (already a real, private
    // channel to the sub-agent's own phone), the forced change added no real
    // security beyond what SMS delivery already provides, and it broke
    // ordinary dashboard actions — the API-level backstop
    // (middleware.ts, removed in the same change) blocked EVERY /api/** call
    // for a flagged sub-agent outside a 4-path allowlist, which is why a
    // sub-agent trying to use "MTN Number Registration" (or any other
    // feature) got "You must change your password before continuing"
    // instead of the feature working. The `sub_agents.must_change_password`
    // column and lib/sub-agent-account.ts's fetchMustChangePassword/
    // clearMustChangePasswordIfSubAgent helpers are left in place, unused —
    // harmless, and this is trivially reversible if the requirement comes
    // back. /auth/change-password-required still exists as an optional,
    // self-service page (nothing links to it automatically anymore).

    const communityLink = adminSettings.whatsapp_community_link || 'https://chat.whatsapp.com/GY8X8nUkNgYATUiOY5gXAb'
    const signupPromoRole: 'dealer' | 'agent' | null =
        adminSettings.signup_promo_role === 'dealer' || adminSettings.signup_promo_role === 'agent'
            ? adminSettings.signup_promo_role
            : null

    return (
        <DashboardLayoutClient adminSettings={adminSettings} communityLink={communityLink} signupPromoRole={signupPromoRole}>
            {children}
        </DashboardLayoutClient>
    )
}
