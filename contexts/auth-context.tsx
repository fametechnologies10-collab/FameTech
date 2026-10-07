'use client'

import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react'
import { User, Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import { User as DBUser } from '@/types/supabase'
import { useRouter } from 'next/navigation'
import { clearTrustedDevice } from '@/lib/pin-crypto'
import { toast } from '@/lib/toast'
import { resolveLoginIdentifier } from '@/lib/login-identifier'

interface AuthContextType {
    user: User | null
    dbUser: DBUser | null
    session: Session | null
    isLoading: boolean
    isAdmin: boolean
    isSubAdmin: boolean
    isDealer: boolean
    /** True when the user has been idle for ≥60 min (60 min warning before auto-logout). */
    sessionExpiring: boolean
    /** `identifier` is an email or phone number (resolved via resolveLoginIdentifier).
     *  Returns the error (null on success), plus the HTTP status and a stable
     *  machine-readable `code` (e.g. 'email_not_confirmed') so callers can branch
     *  on the failure kind — a transient 429/500 vs a genuine 401 credential
     *  rejection — without brittle message-string matching. */
    signIn: (identifier: string, password: string) => Promise<{ error: Error | null; status?: number; code?: string }>
    signUp: (data: SignUpData) => Promise<{ error: any, data: { user: User | null, session: Session | null } | null }>
    signOut: () => Promise<void>
    refreshUser: () => Promise<void>
    /**
     * Reads the current Supabase session and synchronises all auth context state
     * (session, user, dbUser). Returns true if a session was found.
     * Use after external session establishment (e.g. passkey sign-in) to ensure
     * React state is fully updated before navigating to the dashboard.
     */
    syncSession: () => Promise<boolean>
    /** True from the moment a sign-out is initiated until the page navigates away. */
    isSigningOut: boolean
    /** Resets the inactivity timer — call when the user clicks "Stay logged in". */
    extendSession: () => void
    /** Short-lived credentials stored only in memory after a successful login.
     *  Used by PinContext to encrypt and save trusted device data on PIN setup.
     *  Automatically cleared after 5 minutes. */
    getPendingCredentials: () => { email: string; password: string } | null
    clearPendingCredentials: () => void
}

interface SignUpData {
    email: string
    password: string
    firstName: string
    lastName: string
    phoneNumber: string
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

// 2026-09-24: raised from 120min per user complaints of frequent logout/login
// churn, and closing/relaunching the browser no longer signs out immediately
// either (see the close-detection block in initAuth below) — both closed-tab
// time and foreground inactivity now share this single 6h budget.
// session-expiry-modal.tsx independently hardcodes a 60-minute warning
// countdown (WARNING_SECONDS) — keep INACTIVITY_WARN exactly 60 minutes below
// this value or that modal's countdown silently drifts out of sync with the
// real sign-out time.
const INACTIVITY_TIMEOUT  = 6 * 60 * 60 * 1000  // 6 hours — hard logout
const INACTIVITY_WARN     = INACTIVITY_TIMEOUT - 60 * 60 * 1000  // 60-min countdown to logout
const CLOSE_EXPIRY_KEY    = 'kfg_close_time'
// sessionStorage key — survives same-tab reloads (F5) but is cleared on true tab
// close. Used to distinguish a reload (keep session) from a fresh tab after close
// (sign out). localStorage cannot make this distinction — both events fire the same
// visibilitychange(hidden) / pagehide, so CLOSE_EXPIRY_KEY alone is ambiguous.
const SESSION_ALIVE_KEY   = 'kfg_session_alive'
// Cross-tab coordination keys (shared localStorage).
// LAST_SEEN — a liveness heartbeat any live tab writes every ~10s. A fresh tab
//   uses it to tell "the app was truly closed" from "a second tab was opened
//   while another is still alive", so opening a link in a new tab no longer
//   signs the user out.
// LAST_ACTIVITY — the last real user interaction, shared across tabs so an idle
//   background tab does not fire the inactivity sign-out while the user is
//   actively working in a sibling tab.
const LAST_SEEN_KEY          = 'kfg_last_seen'
const LAST_ACTIVITY_KEY      = 'kfg_last_activity'
const SIBLING_ALIVE_WINDOW_MS = 90 * 1000   // a heartbeat newer than this ⇒ another tab is alive
const ACTIVITY_SHARE_THROTTLE_MS = 10 * 1000 // min gap between shared-activity writes

function readSharedTimestamp(key: string): number {
    try {
        const raw = localStorage.getItem(key)
        return raw ? parseInt(raw, 10) || 0 : 0
    } catch {
        return 0
    }
}

/** True if ANY tab recorded real user activity within the last `ms` (reads the
 *  shared cross-tab timestamp). Used by the session-expiry modal to abort a
 *  sign-out at the last second when the user just became active in another tab. */
export function anyTabActiveWithin(ms: number): boolean {
    const last = readSharedTimestamp(LAST_ACTIVITY_KEY)
    return last > 0 && Date.now() - last < ms
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
    const [user, setUser] = useState<User | null>(null)
    const [dbUser, setDbUser] = useState<DBUser | null>(null)
    const [session, setSession] = useState<Session | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const [isSigningOut, setIsSigningOut] = useState(false)
    // Ref avoids stale-closure issues in intervals and skips unnecessary re-renders
    const lastActivityRef = useRef(Date.now())
    const [sessionExpiring, setSessionExpiring] = useState(false)
    // Mirrors sessionExpiring state so the inactivity interval can read it without a
    // stale closure (the interval closure captures the ref, not the state value).
    const sessionExpiringRef = useRef(false)
    const router = useRouter()

    // Short-lived in-memory credentials — cleared after 5 minutes for security.
    // The timer in `pendingCredentialsTimerRef` actively wipes the ref even if
    // nothing ever reads it (e.g., user closes the PIN dialog without
    // configuring a PIN). Without the active timer, the password could linger
    // in memory until the tab was closed.
    const pendingCredentialsRef = useRef<{ email: string; password: string; expiresAt: number } | null>(null)
    const pendingCredentialsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    // Throttles how often user activity is broadcast to sibling tabs (E2).
    const lastActivityShareRef = useRef(0)

    // Tracks the latest fetchDbUser invocation. Concurrent calls (from initAuth and
    // onAuthStateChange) both run, but only the most recent result is applied to state.
    const fetchDbUserCallId = useRef(0)

    const getPendingCredentials = useCallback(() => {
        const c = pendingCredentialsRef.current
        if (!c) return null
        if (Date.now() > c.expiresAt) {
            pendingCredentialsRef.current = null
            return null
        }
        return { email: c.email, password: c.password }
    }, [])

    const clearPendingCredentials = useCallback(() => {
        pendingCredentialsRef.current = null
        if (pendingCredentialsTimerRef.current) {
            clearTimeout(pendingCredentialsTimerRef.current)
            pendingCredentialsTimerRef.current = null
        }
    }, [])

    const isAdmin = dbUser?.role === 'admin'
    const isSubAdmin = dbUser?.role === 'sub-admin'
    const isDealer = dbUser?.role === 'dealer'

    const fetchDbUser = useCallback(async (userId: string) => {
        const callId = ++fetchDbUserCallId.current
        try {
            const timeout = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Database timeout')), 15000)
            )

            const query = supabase
                .from('users')
                .select(`
                    id,
                    email,
                    first_name,
                    last_name,
                    phone_number,
                    role,
                    status,
                    suspended_until,
                    agent_expires_at,
                    dealer_expires_at,
                    signup_promo_shown,
                    auto_upgrade_enabled,
                    auto_upgrade_plan,
                    order_success_sms_enabled,
                    terms_accepted_version,
                    created_at,
                    updated_at
                `)
                .eq('id', userId)
                .single()

            const { data, error } = await Promise.race([query, timeout]) as any

            // Discard result if a newer fetchDbUser call has started
            if (callId !== fetchDbUserCallId.current) return

            if (error) {
                // PostgreSQL error 42703 = "column does not exist" — migration has not been run
                // yet on this database. Fall back gracefully so the dashboard still loads.
                if (error.code === '42703' || error.message?.includes('dealer_expires_at') || error.message?.includes('signup_promo_shown') || error.message?.includes('terms_accepted_version')) {
                    console.warn('[AuthContext] missing column — run pending migrations')
                    const fallback = supabase
                        .from('users')
                        .select(`
                            id,
                            email,
                            first_name,
                            last_name,
                            phone_number,
                            role,
                            status,
                            agent_expires_at,
                            created_at,
                            updated_at
                        `)
                        .eq('id', userId)
                        .single()
                    const { data: fallbackData, error: fallbackError } = await Promise.race([fallback, timeout]) as any
                    if (callId !== fetchDbUserCallId.current) return
                    if (!fallbackError && fallbackData) {
                        setDbUser({ ...fallbackData, dealer_expires_at: null, signup_promo_shown: true, auto_upgrade_enabled: false, auto_upgrade_plan: null, order_success_sms_enabled: true, terms_accepted_version: null })
                    } else {
                        console.error('Error fetching user data (fallback):', fallbackError)
                    }
                    return
                }
                console.error('Error fetching user data:', error)
                return
            }

            if (data) {
                setDbUser(data)
            }
        } catch (error) {
            console.error('Error fetching user data:', error)
        }
    }, [])

    // Auto-downgrade expired agents → customer, and expired dealers → lifetime agent
    useEffect(() => {
        const checkAndDowngradeExpired = async () => {
            const now = new Date()

            if (dbUser?.role === 'dealer' && dbUser?.dealer_expires_at) {
                const expiryDate = new Date((dbUser as any).dealer_expires_at)
                if (expiryDate < now) {
                    console.log('[AuthContext] Dealer expired, auto-downgrading to lifetime agent')
                    try {
                        const response = await fetch('/api/dealer/downgrade', { method: 'POST' })
                        if (response.ok) {
                            console.log('[AuthContext] Dealer auto-downgrade successful')
                            await refreshUser()
                        } else {
                            console.error('[AuthContext] Dealer auto-downgrade failed:', await response.text())
                        }
                    } catch (error) {
                        console.error('[AuthContext] Dealer auto-downgrade error:', error)
                    }
                }
            } else if (dbUser?.role === 'agent' && dbUser?.agent_expires_at) {
                const expiryDate = new Date(dbUser.agent_expires_at)
                if (expiryDate < now) {
                    console.log('[AuthContext] Agent expired, auto-downgrading to customer')
                    try {
                        const response = await fetch('/api/agent/downgrade', { method: 'POST' })
                        if (response.ok) {
                            console.log('[AuthContext] Auto-downgrade successful')
                            await refreshUser()
                        } else {
                            console.error('[AuthContext] Auto-downgrade failed:', await response.text())
                        }
                    } catch (error) {
                        console.error('[AuthContext] Auto-downgrade error:', error)
                    }
                }
            }
        }

        checkAndDowngradeExpired()
    }, [dbUser?.role, dbUser?.agent_expires_at, (dbUser as any)?.dealer_expires_at])

    const refreshUser = useCallback(async () => {
        if (user) {
            await fetchDbUser(user.id)
        }
    }, [user, fetchDbUser])

    // Reads the current Supabase session and pushes it into React state.
    // Must be awaited before navigating post-login so the dashboard renders
    // with user + dbUser already populated (prevents the BrandLoader loop).
    const syncSession = useCallback(async (): Promise<boolean> => {
        const { data: { session: fresh } } = await supabase.auth.getSession()
        setSession(fresh)
        setUser(fresh?.user ?? null)
        if (fresh?.user) {
            try { sessionStorage.setItem(SESSION_ALIVE_KEY, '1') } catch {}
            await fetchDbUser(fresh.user.id)
            return true
        }
        return false
    }, [fetchDbUser])

    const signIn = async (identifier: string, password: string) => {
        const resolved = resolveLoginIdentifier(identifier)

        if (resolved.type === 'invalid') {
            return { error: { message: 'Invalid email, phone number, or password.' } as Error }
        }

        const response = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
                resolved.type === 'email'
                    ? { email: resolved.value, password }
                    : { phone: resolved.value, password }
            )
        })

        if (response.status === 429) {
            const retryAfter = response.headers.get('Retry-After')
            const minutes = retryAfter ? Math.ceil(parseInt(retryAfter) / 60) : 10
            return { error: { message: `TOO_MANY_ATTEMPTS:${minutes}` } as Error, status: 429, code: 'over_request_rate_limit' }
        }

        const data = await response.json().catch(() => ({}))

        if (!response.ok) {
            // status + code let callers distinguish a genuine 401 credential
            // rejection (safe to wipe a trusted device) from a transient 500,
            // and detect email_not_confirmed to offer a resend.
            return { error: { message: data.error || 'Sign-in failed.' } as Error, status: response.status, code: data.code }
        }

        // Refresh the Supabase client session from the server-set cookie, then
        // pre-fetch dbUser so the dashboard renders immediately without a skeleton.
        const { data: { session: freshSession } } = await supabase.auth.getSession()
        setSession(freshSession)
        setUser(freshSession?.user ?? null)
        if (freshSession?.user) {
            await fetchDbUser(freshSession.user.id)
        }

        // Store credentials in memory for 5 minutes so PinContext can save
        // trusted device on PIN setup. Use the ACCOUNT'S email from the
        // resolved session — not the raw identifier — since a phone-number
        // login never has an email to hand otherwise. The active timer
        // ensures the ref is wiped even if no code path ever calls
        // getPendingCredentials() — e.g., the user closes the PIN setup
        // dialog without finishing.
        if (pendingCredentialsTimerRef.current) {
            clearTimeout(pendingCredentialsTimerRef.current)
        }
        const accountEmail = freshSession?.user?.email ?? (resolved.type === 'email' ? resolved.value : '')
        pendingCredentialsRef.current = { email: accountEmail, password, expiresAt: Date.now() + 5 * 60 * 1000 }
        pendingCredentialsTimerRef.current = setTimeout(() => {
            pendingCredentialsRef.current = null
            pendingCredentialsTimerRef.current = null
        }, 5 * 60 * 1000)

        return { error: null, status: 200 }
    }

    const signUp = async (data: SignUpData) => {
        const response = await fetch('/api/auth/signup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        })

        if (response.status === 429) {
            const retryAfter = response.headers.get('Retry-After')
            const minutes = retryAfter ? Math.ceil(parseInt(retryAfter) / 60) : 10
            return { error: { message: `TOO_MANY_ATTEMPTS:${minutes}` } as Error, data: null }
        }

        if (response.status === 503) {
            return { error: { message: 'Registration is temporarily unavailable. Please try again in a few minutes.' } as Error, data: null }
        }

        const responseData = await response.json()

        if (!response.ok) {
            return { error: { message: responseData.error, details: responseData.details }, data: null }
        }

        // Refresh the Supabase client session from the server-set cookie AND push
        // it into React state before returning — mirrors signIn()/passkey login.
        // Without this, DashboardLayoutClient renders with user=null/dbUser=null
        // and the caller's router.push('/dashboard') races the eventual
        // onAuthStateChange callback, leaving new users stuck on BrandLoader.
        await syncSession()

        return { error: null, data: { user: responseData.user, session: responseData.session } }
    }

    const signOut = async () => {
        setIsSigningOut(true)
        try {
            // Clear the session-alive marker so the next fresh tab open correctly
            // triggers the close-detection sign-out in initAuth.
            sessionStorage.removeItem(SESSION_ALIVE_KEY)
            localStorage.removeItem('kfg_pin_verified')
            localStorage.removeItem('kfg_pin_verified_at')
            // Clear cross-tab coordination so the next login can't inherit a stale
            // "sibling alive" / "recently active" timestamp.
            localStorage.removeItem(LAST_SEEN_KEY)
            localStorage.removeItem(LAST_ACTIVITY_KEY)
            // Do NOT clearTrustedDevice() here — PIN/biometric login on next visit needs it
        } catch {}

        // Defer navigation by one frame so React can flush isSigningOut=true to the
        // DOM (spinning icon, disabled button) before the page starts unloading.
        // Navigate to the server-side signout route which revokes the refresh token
        // AND clears the HTTP-only auth cookie in the same response.
        setTimeout(() => {
            window.location.href = '/api/auth/signout'
        }, 80)
    }

    // Track user activity — uses ref to avoid re-running the inactivity interval on every event
    useEffect(() => {
        if (!user) return

        const updateActivity = () => {
            const now = Date.now()
            lastActivityRef.current = now
            // If another tab was recently closed, clear the stale close timestamp
            try { localStorage.removeItem(CLOSE_EXPIRY_KEY) } catch {}
            // Broadcast activity to sibling tabs (throttled) so an idle background
            // tab won't fire the inactivity sign-out while the user is active here.
            if (now - lastActivityShareRef.current > ACTIVITY_SHARE_THROTTLE_MS) {
                lastActivityShareRef.current = now
                try { localStorage.setItem(LAST_ACTIVITY_KEY, now.toString()) } catch {}
            }
        }

        const events = ['mousedown', 'keydown', 'scroll', 'touchstart', 'click']
        events.forEach(event => window.addEventListener(event, updateActivity))
        return () => events.forEach(event => window.removeEventListener(event, updateActivity))
    }, [user])

    // Liveness heartbeat — every live authenticated tab stamps a shared timestamp
    // so a freshly-opened tab can tell "the app was truly closed" from "a second
    // tab was opened while another is alive" (see initAuth close-detection).
    // SEC: deliberately does NOT stamp on 'pagehide' — that event fires on a true
    // browser close too, which would make the NEXT tab (e.g. the next person on a
    // shared device) see a fresh heartbeat and wrongly treat User A's session as
    // still alive, skipping the close-detection sign-out. visibilitychange (tab
    // switch/app backgrounded) is the only "still alive" signal worth stamping early.
    useEffect(() => {
        if (!user) return
        const beat = () => { try { localStorage.setItem(LAST_SEEN_KEY, Date.now().toString()) } catch {} }
        beat()
        const hb = setInterval(beat, 10000)
        const onHide = () => { if (document.visibilityState === 'hidden') beat() }
        document.addEventListener('visibilitychange', onHide)
        return () => {
            clearInterval(hb)
            document.removeEventListener('visibilitychange', onHide)
        }
    }, [user])

    // Extend session — resets the inactivity timer
    const extendSession = useCallback(() => {
        lastActivityRef.current = Date.now()
        sessionExpiringRef.current = false
        setSessionExpiring(false)
    }, [])

    // Auto logout on inactivity — reads ref directly so the interval is never
    // recreated on activity events (avoids the "interval resets on every click" bug)
    useEffect(() => {
        if (!user) return

        const checkInactivity = setInterval(() => {
            // Consider activity in ANY tab: an idle background tab must not sign
            // out a user who is active in a sibling tab (reads the shared
            // last-activity timestamp written by whichever tab they're using).
            const lastActive = Math.max(lastActivityRef.current, readSharedTimestamp(LAST_ACTIVITY_KEY))
            const idle = Date.now() - lastActive

            if (idle >= INACTIVITY_TIMEOUT) {
                // If the warning modal is already visible its countdown owns the signout.
                // Firing here too would send two simultaneous requests to /api/auth/signout.
                if (!sessionExpiringRef.current) {
                    try {
                        localStorage.removeItem('kfg_pin_verified')
                        localStorage.removeItem('kfg_pin_verified_at')
                        localStorage.removeItem(CLOSE_EXPIRY_KEY)
                    } catch {}
                    // Use the server-side signout route so it revokes the refresh token
                    // AND clears the HTTP-only auth cookie in the same response.
                    window.location.href = '/api/auth/signout?reason=session_expired'
                }
                return
            }

            const nowExpiring = idle >= INACTIVITY_WARN
            // Keep the ref in sync so the interval reads fresh state next tick
            // without needing to be recreated (avoids stale closure on every render).
            sessionExpiringRef.current = nowExpiring
            // React 18 bails out of re-render when boolean state value is unchanged
            setSessionExpiring(nowExpiring)
        }, 30000)

        return () => clearInterval(checkInactivity)
    }, [user])

    // Handle tab visibility, 10-min close detection, and session stale check
    useEffect(() => {
        const handleVisibilityChange = async () => {
            if (document.visibilityState === 'hidden') {
                // Record close time so we can detect prolonged absence on return
                if (user) {
                    try { localStorage.setItem(CLOSE_EXPIRY_KEY, Date.now().toString()) } catch {}
                }
                return
            }

            if (document.visibilityState === 'visible' && user) {
                // App was backgrounded (still alive — this is a tab switch / brief minimize,
                // not a kill) OR the browser was fully closed and relaunched within the
                // budget (see initAuth's close-detection block, which handles the
                // "relaunched after INACTIVITY_TIMEOUT has elapsed" case on load — this
                // effect only runs for a tab that was ALREADY mounted and is becoming
                // visible again). Shares the same INACTIVITY_TIMEOUT budget as the
                // foreground inactivity timer, rather than a separate shorter window, so
                // "how long was I away" means one consistent thing everywhere.
                try {
                    const closeTimeStr = localStorage.getItem(CLOSE_EXPIRY_KEY)
                    if (closeTimeStr) {
                        const closeTime = parseInt(closeTimeStr)
                        if (Date.now() - closeTime > INACTIVITY_TIMEOUT) {
                            localStorage.removeItem(CLOSE_EXPIRY_KEY)
                            try {
                                localStorage.removeItem('kfg_pin_verified')
                                localStorage.removeItem('kfg_pin_verified_at')
                            } catch {}
                            window.location.href = '/api/auth/signout?reason=session_expired'
                            return
                        }
                        // Back within grace period — clear the timestamp
                        localStorage.removeItem(CLOSE_EXPIRY_KEY)
                    }
                } catch {}

                // Validate session server-side — getUser() makes a network round-trip
                // to verify the JWT, so a remotely revoked session is caught here.
                // getSession() only reads the local cache and would miss revocations.
                const { data: { user: currentUser }, error } = await supabase.auth.getUser()
                if (error || !currentUser || currentUser.id !== user.id) {
                    window.location.reload()
                } else {
                    const { data: { session: refreshedSession } } = await supabase.auth.getSession()
                    setSession(refreshedSession)
                    setUser(currentUser)
                }
            }
        }

        // pagehide fires on mobile/PWA close more reliably than beforeunload
        const handlePageHide = () => {
            if (user) {
                try { localStorage.setItem(CLOSE_EXPIRY_KEY, Date.now().toString()) } catch {}
            }
        }

        document.addEventListener('visibilitychange', handleVisibilityChange)
        window.addEventListener('pagehide', handlePageHide)
        return () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange)
            window.removeEventListener('pagehide', handlePageHide)
        }
    }, [user])

    // Initialize auth state
    useEffect(() => {
        const initAuth = async () => {
            try {
                // Add 15 second total timeout for initialization
                const timeout = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Auth initialization timeout')), 15000)
                )

                const init = async () => {
                    const { data: { session } } = await supabase.auth.getSession()

                    if (session) {
                        // Detect true tab-close vs same-tab reload:
                        // visibilitychange(hidden) and pagehide fire for BOTH scenarios,
                        // so CLOSE_EXPIRY_KEY in localStorage is set in both cases.
                        // sessionStorage survives F5/reload within the same tab but is
                        // wiped when the tab is actually closed — use it to tell them apart.
                        try {
                            const closeTimeStr = localStorage.getItem(CLOSE_EXPIRY_KEY)
                            if (closeTimeStr) {
                                const isReload = sessionStorage.getItem(SESSION_ALIVE_KEY) === '1'
                                // A fresh tab (empty sessionStorage) is not necessarily a
                                // true app closure — it may be a SECOND tab opened (or a link
                                // followed) while another tab is still alive. Only consider
                                // signing out when NO sibling tab has posted a recent
                                // liveness heartbeat. This preserves the fix for the
                                // "opening a 2nd tab kills my session" false positive.
                                const siblingAlive = Date.now() - readSharedTimestamp(LAST_SEEN_KEY) < SIBLING_ALIVE_WINDOW_MS
                                // 2026-09-24: previously signed out INSTANTLY here on any true
                                // closure, regardless of how briefly the browser was shut —
                                // the #1 cause of "logged out too often" complaints. Now
                                // treats time-while-closed the same as foreground idle time:
                                // sign out only once it exceeds the same INACTIVITY_TIMEOUT
                                // budget everything else uses. A closure under 6h is
                                // indistinguishable from a reload as far as the user is
                                // concerned — the session just continues.
                                const closedTooLong = Date.now() - parseInt(closeTimeStr) > INACTIVITY_TIMEOUT
                                if (!isReload && !siblingAlive && closedTooLong) {
                                    // True closure that exceeded the inactivity budget.
                                    localStorage.removeItem(CLOSE_EXPIRY_KEY)
                                    try {
                                        localStorage.removeItem('kfg_pin_verified')
                                        localStorage.removeItem('kfg_pin_verified_at')
                                    } catch {}
                                    // scope:'local' — this defensive close-detection sign-out
                                    // must not revoke the shared refresh token and kill a
                                    // genuinely-alive session on another device.
                                    await supabase.auth.signOut({ scope: 'local' })
                                    window.location.href = '/auth?reason=session_expired'
                                    return
                                }
                                // Same-tab reload (F5), a sibling tab alive, or a closure still
                                // within budget — discard the stale timestamp and continue.
                                //
                                // SEC (2026-09-24, security review finding): a closure within
                                // budget used to fall straight through to setSession() below,
                                // trusting the locally-cached session with no server round-trip —
                                // unlike handleVisibilityChange's tab-backgrounding path, which
                                // already calls getUser(). That gap meant a suspended/revoked
                                // account reopening the browser within the 6h window would see a
                                // stale dashboard until its first API call failed, rather than
                                // bouncing to /auth immediately. Every real money-moving action is
                                // still gated by middleware's own getUser() check regardless — this
                                // closes a UI-freshness gap, not an auth bypass — but a genuine
                                // "was this closure a true close at all" (isReload/siblingAlive
                                // false, just under the time budget) gets the same server check the
                                // backgrounding path already gets, so both paths agree.
                                if (!isReload && !siblingAlive) {
                                    const { data: { user: verifiedUser }, error: verifyError } = await supabase.auth.getUser()
                                    if (verifyError || !verifiedUser) {
                                        localStorage.removeItem(CLOSE_EXPIRY_KEY)
                                        try {
                                            localStorage.removeItem('kfg_pin_verified')
                                            localStorage.removeItem('kfg_pin_verified_at')
                                        } catch {}
                                        await supabase.auth.signOut({ scope: 'local' })
                                        window.location.href = '/auth?reason=session_expired'
                                        return
                                    }
                                }
                                localStorage.removeItem(CLOSE_EXPIRY_KEY)
                            }
                        } catch {}

                        // Mark session alive so the next reload is recognized as such
                        try { sessionStorage.setItem(SESSION_ALIVE_KEY, '1') } catch {}

                        setSession(session)
                        setUser(session.user)
                        await fetchDbUser(session.user.id)
                    }
                }

                await Promise.race([init(), timeout])
            } catch (error) {
                console.error('Auth initialization error:', error)
                // Continue anyway - allow user to proceed without full auth
            } finally {
                // ALWAYS set loading to false, even on error
                setIsLoading(false)
            }
        }

        initAuth()

        const { data: { subscription } } = supabase.auth.onAuthStateChange(
            async (event, session) => {
                setSession(session)
                setUser(session?.user ?? null)

                if (session?.user) {
                    // Keep the session-alive marker current for every auth event
                    // (SIGNED_IN, TOKEN_REFRESHED, etc.) so that a reload triggered
                    // any time after sign-in still passes the sessionStorage check.
                    try { sessionStorage.setItem(SESSION_ALIVE_KEY, '1') } catch {}
                    await fetchDbUser(session.user.id)

                    if (event === 'SIGNED_IN') {
                        try {
                            const pinNotice = localStorage.getItem('kfg_pin_notice')
                            if (pinNotice === 'setup') {
                                localStorage.removeItem('kfg_pin_notice')
                                setTimeout(() => {
                                    toast.info('Your app-lock PIN has been removed. You can set up a new one anytime in Profile → Security.', { duration: 8000 })
                                }, 1500)
                            }
                        } catch {}
                    }
                } else {
                    setDbUser(null)
                }
            }
        )

        return () => subscription.unsubscribe()
    }, [fetchDbUser])

    return (
        <AuthContext.Provider
            value={{
                user,
                dbUser,
                session,
                isLoading,
                isAdmin,
                isSubAdmin,
                isDealer,
                sessionExpiring,
                isSigningOut,
                signIn,
                signUp,
                signOut,
                refreshUser,
                syncSession,
                extendSession,
                getPendingCredentials,
                clearPendingCredentials,
            }}
        >
            {children}
        </AuthContext.Provider>
    )
}

export function useAuth() {
    const context = useContext(AuthContext)
    if (context === undefined) {
        throw new Error('useAuth must be used within an AuthProvider')
    }
    return context
}
