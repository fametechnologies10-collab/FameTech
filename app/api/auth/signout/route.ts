import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { getAuthCookieOptions } from '@/lib/cookie-domain'

export async function GET(request: NextRequest) {
    const cookieStore = await cookies()

    // Build redirect response first so setAll can write cleared cookies onto it.
    // Forward ?reason= so callers can surface a message on the auth page.
    const reason = request.nextUrl.searchParams.get('reason')
    // Optional post-signout destination, restricted to a hardcoded allowlist of
    // internal auth paths — NEVER an arbitrary value (open-redirect guard). Lets a
    // logged-in user who forgot their password go straight to the reset flow
    // (which middleware would otherwise bounce for an authenticated session).
    const nextParam = request.nextUrl.searchParams.get('next')
    const ALLOWED_NEXT = new Set(['/auth/reset-password'])
    const target = nextParam && ALLOWED_NEXT.has(nextParam) ? nextParam : '/auth'
    const redirectUrl = new URL(target, request.url)
    if (reason) redirectUrl.searchParams.set('reason', reason)
    const response = NextResponse.redirect(redirectUrl)

    const supabase = createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
            cookies: {
                getAll() {
                    return cookieStore.getAll()
                },
                setAll(cookiesToSet) {
                    cookiesToSet.forEach(({ name, value, options }) => {
                        response.cookies.set(name, value, options)
                    })
                },
            },
            cookieOptions: getAuthCookieOptions(),
        }
    )

    // scope: 'global' (default) — makes API call to revoke the refresh token on
    // the Supabase server AND calls setAll to clear auth cookies on this response.
    // scope: 'local' was used before but is unreliable in server context: "local"
    // has no meaning server-side (no persistent storage), so setAll may not be called.
    await supabase.auth.signOut()

    // Belt-and-suspenders: explicitly delete every Supabase auth cookie that came
    // in on the request, in case setAll above missed any (e.g. chunked tokens).
    // Deletion matches on name+domain+path, so with domain-wide cookies enabled we
    // must emit BOTH deletions. Next's ResponseCookies dedupes by name — the
    // domain-scoped deletion must be appended as a raw Set-Cookie header. And
    // every response.cookies.set() call re-serializes the WHOLE Set-Cookie header
    // from ResponseCookies' internal map, wiping any raw appends made before it —
    // so ALL .cookies.set() deletions must complete before the FIRST raw append.
    const cookieDomain = getAuthCookieOptions()?.domain
    const secureAttr = process.env.NODE_ENV === 'production' ? '; Secure' : ''
    const authCookieNames = cookieStore
        .getAll()
        .map(({ name }) => name)
        .filter((name) => name.startsWith('sb-') && name.includes('auth-token'))

    // Pass 1: host-scoped deletions via ResponseCookies (no Domain attribute).
    authCookieNames.forEach((name) => {
        response.cookies.set(name, '', {
            maxAge: 0,
            path: '/',
            httpOnly: true,
            sameSite: 'lax',
            secure: process.env.NODE_ENV === 'production',
        })
    })

    // Pass 2: domain-scoped deletions as raw headers — AFTER every .cookies.set().
    if (cookieDomain) {
        authCookieNames.forEach((name) => {
            response.headers.append(
                'Set-Cookie',
                `${name}=; Path=/; Max-Age=0; Domain=${cookieDomain}; HttpOnly; SameSite=Lax${secureAttr}`
            )
        })
    }

    return response
}
