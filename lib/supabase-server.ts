import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { Database } from '@/types/supabase'
import { getAuthCookieOptions } from '@/lib/cookie-domain'

// ─────────────────────────────────────────────────────────────────────────────
// createRouteClient — for API Route Handlers (app/api/**/route.ts)
// Reads the logged-in user's session from request cookies.
// ─────────────────────────────────────────────────────────────────────────────
export const createRouteClient = async () => {
    const cookieStore = await cookies()

    return createServerClient<any>(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
            cookieOptions: getAuthCookieOptions(),
            cookies: {
                getAll() {
                    return cookieStore.getAll()
                },
                setAll(cookiesToSet) {
                    try {
                        cookiesToSet.forEach(({ name, value, options }) =>
                            cookieStore.set(name, value, options)
                        )
                    } catch {
                        // setAll called from a Server Component — cookies are read-only.
                        // Middleware handles refreshing the session in this case.
                    }
                },
            },
        }
    )
}

// ─────────────────────────────────────────────────────────────────────────────
// createServerComponentClient — for Server Components (page.tsx, layout.tsx)
// Reads the session without setting cookies (read-only context).
// ─────────────────────────────────────────────────────────────────────────────
export const createServerComponentClient = async () => {
    const cookieStore = await cookies()

    return createServerClient<any>(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
            cookieOptions: getAuthCookieOptions(),
            cookies: {
                getAll() {
                    return cookieStore.getAll()
                },
                setAll() {
                    // Read-only: server components cannot set cookies.
                },
            },
        }
    )
}
