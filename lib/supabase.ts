import { createClient } from '@supabase/supabase-js'
import { createBrowserClient } from '@supabase/ssr'
import { Database } from '@/types/supabase'
import { getAuthCookieOptions } from '@/lib/cookie-domain'

// ─────────────────────────────────────────────────────────────────────────────
// Browser (client-side) client
// Use this in Client Components (hooks, UI pages).
// It reads/writes the session from browser cookies automatically.
// ─────────────────────────────────────────────────────────────────────────────
export const supabase = createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
        auth: {
            // Explicitly use PKCE so the code_verifier is stored in a cookie
            // before the OAuth redirect, making it readable server-side in
            // the /auth/callback route handler via exchangeCodeForSession.
            flowType: 'pkce',
        },
        // Domain-wide auth cookies in production (unset elsewhere → host-scoped, unchanged)
        cookieOptions: getAuthCookieOptions(),
    }
)

// ─────────────────────────────────────────────────────────────────────────────
// Service-role server client (bypasses RLS — admin operations only)
// Use this only in trusted server-side code. NEVER expose to the browser.
// ─────────────────────────────────────────────────────────────────────────────
export const createServerClient = () => {
    return createClient<Database>(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
        {
            auth: {
                autoRefreshToken: false,
                persistSession: false,
            },
        }
    )
}

// ─────────────────────────────────────────────────────────────────────────────
// Anon server client (respects RLS — public/storefront queries)
// ─────────────────────────────────────────────────────────────────────────────
export const createServerAnonClient = () => {
    return createClient<Database>(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
            auth: {
                autoRefreshToken: false,
                persistSession: false,
            },
        }
    )
}
