'use client'
/**
 * Browser-only passkey utilities.
 * Do NOT import from Server Components or API routes.
 */

import {
    startRegistration,
    startAuthentication,
    browserSupportsWebAuthn,
    platformAuthenticatorIsAvailable,
} from '@simplewebauthn/browser'
import type {
    RegistrationResponseJSON,
    AuthenticationResponseJSON,
} from '@simplewebauthn/types'
import { supabase } from '@/lib/supabase'

export { browserSupportsWebAuthn, platformAuthenticatorIsAvailable }

export interface PasskeyRecord {
    id: string
    friendly_name: string
    device_type: 'singleDevice' | 'multiDevice' | null
    backed_up: boolean
    transports: string[] | null
    created_at: string
    last_used_at: string | null
}

// ── Sign in ───────────────────────────────────────────────────────────────────

/**
 * Trigger the browser's passkey picker and sign in.
 * On desktop without a platform authenticator the browser shows its own
 * QR code dialog for cross-device / phone authentication automatically.
 *
 * Returns null on success (session set on the supabase client).
 * Returns an error string on failure. Returns null (no error) when dismissed.
 */
export async function signInWithPasskey(): Promise<string | null> {
    try {
        const optRes = await fetch('/api/auth/passkey/auth-options', { method: 'POST' })
        if (!optRes.ok) {
            const optData = await optRes.json().catch(() => ({}))
            return optData.error || 'Failed to start passkey sign-in. Please try again.'
        }
        const options = await optRes.json()

        let credential: AuthenticationResponseJSON
        try {
            credential = await startAuthentication(options)
        } catch (err: any) {
            if (err?.name === 'NotAllowedError') return null // user dismissed — not an error
            if (err?.name === 'SecurityError') return 'Passkey not available on this domain. If testing on a preview link, register a new passkey here first.'
            console.error('[passkey-client] startAuthentication error:', err?.name, err?.message)
            return 'Passkey authentication was cancelled or failed.'
        }

        const verifyRes = await fetch('/api/auth/passkey/auth-verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ credential }),
        })
        const verifyData = await verifyRes.json()
        if (!verifyRes.ok) return verifyData.error || 'Passkey verification failed.'

        // Hydrate the supabase client with the server-issued session tokens
        const { error: sessionErr } = await supabase.auth.setSession({
            access_token: verifyData.session.access_token,
            refresh_token: verifyData.session.refresh_token,
        })
        if (sessionErr) return 'Failed to establish session after passkey sign-in.'

        return null // success
    } catch (err) {
        console.error('[passkey-client] signInWithPasskey error:', err)
        return 'An unexpected error occurred. Please try again.'
    }
}

// ── Register ──────────────────────────────────────────────────────────────────

/**
 * Register a new passkey for the currently authenticated user.
 * The browser will prompt for biometric / PIN / security key depending
 * on the device and OS.
 */
export async function registerNewPasskey(
    friendlyName?: string
): Promise<{ success: boolean; error?: string; passkey?: PasskeyRecord }> {
    try {
        const optRes = await fetch('/api/auth/passkey/register-options', { method: 'POST' })
        if (!optRes.ok) {
            const optData = await optRes.json().catch(() => ({}))
            return { success: false, error: optData.error || 'Failed to start passkey registration.' }
        }
        const options = await optRes.json()

        let credential: RegistrationResponseJSON
        try {
            credential = await startRegistration(options)
        } catch (err: any) {
            if (err?.name === 'NotAllowedError') return { success: false, error: 'Registration was cancelled.' }
            if (err?.name === 'InvalidStateError') return { success: false, error: 'This authenticator already has a passkey registered.' }
            if (err?.name === 'SecurityError') return { success: false, error: 'Passkey not available on this domain. This may resolve on the next page load.' }
            console.error('[passkey-client] startRegistration error:', err?.name, err?.message)
            return { success: false, error: 'Passkey creation failed. Please try again.' }
        }

        const verifyRes = await fetch('/api/auth/passkey/register-verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ credential, friendlyName }),
        })
        const verifyData = await verifyRes.json()
        if (!verifyRes.ok) return { success: false, error: verifyData.error || 'Registration verification failed.' }

        return { success: true, passkey: verifyData.passkey }
    } catch (err) {
        console.error('[passkey-client] registerNewPasskey error:', err)
        return { success: false, error: 'An unexpected error occurred.' }
    }
}

// ── Management ────────────────────────────────────────────────────────────────

export async function listPasskeys(): Promise<PasskeyRecord[]> {
    try {
        const res = await fetch('/api/passkeys')
        if (!res.ok) return []
        const data = await res.json()
        return data.passkeys ?? []
    } catch {
        return []
    }
}

export async function renamePasskey(id: string, name: string): Promise<boolean> {
    try {
        const res = await fetch(`/api/passkeys/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ friendly_name: name }),
        })
        return res.ok
    } catch {
        return false
    }
}

export async function deletePasskey(
    id: string
): Promise<{ success: boolean; error?: string }> {
    try {
        const res = await fetch(`/api/passkeys/${id}`, { method: 'DELETE' })
        const data = await res.json()
        if (!res.ok) return { success: false, error: data.error }
        return { success: true }
    } catch {
        return { success: false, error: 'Network error.' }
    }
}
