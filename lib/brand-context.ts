// lib/brand-context.ts
// =============================================================================
// White-label brand resolution (spec §12, Phase 11). ONE server-side source of
// truth for "what brand does this user see?" so no KiNG FLEXY chrome leaks to a
// sub-agent. A sub sees THEIR OWN storefront brand (or a neutral fallback); every
// other user sees the platform brand.
//
// Usage: resolve on the server (layout / server component) and thread the result
// into the dashboard shell. Never trust a client-declared brand.
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js'

export interface BrandContext {
    /** true when the viewer is a sub-agent → hide all KiNG FLEXY chrome. */
    debranded: boolean
    /** Display name shown in the shell (the sub's own shop name, or the platform name). */
    name: string
    /** Logo URL (sub's own logo, else null → neutral mark). */
    logoUrl: string | null
    /** Accent colour for the shell. */
    accent: string
    /** Neutral "powered by" label for de-branded surfaces (never "KiNG FLEXY"). */
    poweredBy: string
}

export const PLATFORM_BRAND: BrandContext = {
    debranded: false,
    name: 'KiNG FLEXY GH',
    logoUrl: null,
    accent: '#2563eb',
    poweredBy: '',
}

/**
 * Resolve the brand for a user. If they are a sub-agent, return their own storefront
 * brand (de-branded); otherwise the platform brand. `db` may be an RLS or service client.
 */
export async function resolveBrandContext(db: SupabaseClient, userId: string): Promise<BrandContext> {
    const anyDb = db as any
    const { data: sub } = await anyDb
        .from('sub_agents')
        .select('id')
        .eq('user_id', userId)
        .maybeSingle()

    if (!sub) return PLATFORM_BRAND

    const { data: shop } = await anyDb
        .from('shop_profiles')
        .select('shop_name, logo_url, brand_color')
        .eq('owner_id', userId)
        .maybeSingle()

    return {
        debranded: true,
        name: shop?.shop_name || 'My Store',
        logoUrl: shop?.logo_url ?? null,
        accent: shop?.brand_color || '#2563eb',
        // Neutral attribution — deliberately NOT the platform name (spec §12 de-brand).
        poweredBy: 'Powered by our partner network',
    }
}

/** Quick synchronous check used by client guards where the sub flag is already known. */
export function isDebranded(ctx: BrandContext | null | undefined): boolean {
    return !!ctx?.debranded
}
