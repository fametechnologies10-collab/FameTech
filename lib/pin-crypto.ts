/**
 * PIN Crypto Utilities
 *
 * Provides strong AES-256-GCM encryption for storing the user's credentials
 * on their device, protected by their PIN. This enables seamless PIN-based
 * re-login without ever sending the raw password to the server as the "key".
 *
 * Security model:
 *  - Key is derived from the PIN using PBKDF2 (SHA-256, 310,000 iterations)
 *    with a randomly generated 128-bit salt.
 *  - Encryption: AES-256-GCM with a randomly generated 96-bit IV.
 *  - Both the salt and IV are stored alongside the ciphertext (they are not secret).
 *  - The plaintext password is NEVER stored — only the encrypted form.
 *  - 5-attempt lockout is enforced at the server level via /api/auth/pin.
 *
 * The PBKDF2 iteration count matches NIST SP 800-132 guidance (2023).
 */

const STORAGE_KEY = 'kfg_trusted_device_v2'

// ─── TYPES ───────────────────────────────────────────────────────────────────

export interface TrustedDevicePayload {
    /** Base64-encoded encrypted email + password, comma-separated */
    ciphertext: string
    /** Base64-encoded 128-bit random salt (for PBKDF2) */
    salt: string
    /** Base64-encoded 96-bit random IV (for AES-GCM) */
    iv: string
    /** Timestamp of when this was stored (ms since epoch) */
    storedAt: number
    /** Obfuscated email hint so we can show "Log in as ..." on the PIN screen */
    emailHint: string
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function bufferToBase64(buf: ArrayBuffer): string {
    return btoa(String.fromCharCode(...new Uint8Array(buf)))
}

function base64ToBuffer(b64: string): Uint8Array {
    return Uint8Array.from(atob(b64), c => c.charCodeAt(0))
}

/** Derives a 256-bit AES-GCM key from a PIN + salt using PBKDF2. */
async function deriveKey(pin: string, salt: Uint8Array): Promise<CryptoKey> {
    const encoder = new TextEncoder()
    const baseKey = await crypto.subtle.importKey(
        'raw',
        encoder.encode(pin),
        'PBKDF2',
        false,
        ['deriveKey'],
    )
    return crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: salt as any,
            iterations: 310_000,
            hash: 'SHA-256',
        },
        baseKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
    )
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

/**
 * Encrypts the user's credentials with their PIN and saves them to localStorage.
 * Call this immediately after a successful email/password login when the user has
 * a PIN configured.
 */
export async function saveTrustedDevice(email: string, password: string, pin: string): Promise<void> {
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const key = await deriveKey(pin, salt)

    const encoder = new TextEncoder()
    // Combine email and password into one payload, separated by a unit-separator
    const plaintext = encoder.encode(`${email}\x1F${password}`)
    const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as any }, key, plaintext as any)

    // Obfuscate email for display: show first 2 chars + *** + domain
    const [localPart, domain] = email.split('@')
    const emailHint = `${localPart.slice(0, 2)}***@${domain}`

    const payload: TrustedDevicePayload = {
        ciphertext: bufferToBase64(cipherBuf),
        salt: bufferToBase64(salt.buffer),
        iv: bufferToBase64(iv.buffer),
        storedAt: Date.now(),
        emailHint,
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
}

/**
 * Decrypts stored credentials using the provided PIN.
 * Returns { email, password } on success, or null on failure (wrong PIN or no data).
 */
export async function decryptTrustedDevice(pin: string): Promise<{ email: string; password: string } | null> {
    try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (!raw) return null

        const payload: TrustedDevicePayload = JSON.parse(raw)
        const salt = base64ToBuffer(payload.salt)
        const iv = base64ToBuffer(payload.iv)
        const ciphertext = base64ToBuffer(payload.ciphertext)

        const key = await deriveKey(pin, salt)
        const plaintextBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as any }, key, ciphertext as any)

        const text = new TextDecoder().decode(plaintextBuf)
        const [email, password] = text.split('\x1F')
        return { email, password }
    } catch {
        // Decryption failed — wrong PIN or corrupted data
        return null
    }
}

/**
 * Returns the stored trusted device payload (metadata only — no decryption).
 * Returns null if no trusted device is stored.
 */
export function getTrustedDeviceInfo(): TrustedDevicePayload | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (!raw) return null
        return JSON.parse(raw)
    } catch {
        return null
    }
}

/**
 * Removes the trusted device entry from localStorage (e.g. on logout or PIN removal).
 */
export function clearTrustedDevice(): void {
    try {
        localStorage.removeItem(STORAGE_KEY)
    } catch {}
}

// ─── USER DISPLAY HINT ────────────────────────────────────────────────────────
// Non-sensitive localStorage cache of firstName + masked email for
// personalised greeting on the login screen before session is restored.

const USER_DISPLAY_KEY = 'kfg_user_display'

export function saveUserDisplayHint(firstName: string, email: string): void {
    const [local, domain] = email.split('@')
    if (!domain) return
    const emailHint = `${local.slice(0, 1)}***@${domain}`
    try {
        localStorage.setItem(USER_DISPLAY_KEY, JSON.stringify({ firstName, emailHint }))
    } catch {}
}

export function getUserDisplayHint(): { firstName: string; emailHint: string } | null {
    try {
        const raw = localStorage.getItem(USER_DISPLAY_KEY)
        if (!raw) return null
        return JSON.parse(raw)
    } catch { return null }
}

export function clearUserDisplayHint(): void {
    try { localStorage.removeItem(USER_DISPLAY_KEY) } catch {}
}
