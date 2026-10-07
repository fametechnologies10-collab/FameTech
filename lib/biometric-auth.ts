/**
 * WebAuthn-based biometric authentication.
 *
 * Flow:
 *  Register  — user provides password → random 32-byte key is generated and
 *              stored as the WebAuthn credential's userHandle (inside the device
 *              secure enclave). That key encrypts (email+password) in localStorage.
 *
 *  Authenticate — WebAuthn assertion returns the userHandle (key) → we decrypt
 *                 localStorage and call signIn normally. No server round-trip needed.
 *
 * Security model mirrors the existing PIN trusted-device mechanism but the
 * "PIN" is the device biometric (Face ID / fingerprint) held in the secure enclave.
 */

const BIOMETRIC_CREDS_KEY = 'kfg_biometric_creds_v1'
const BIOMETRIC_REG_KEY = 'kfg_biometric_registered_v1'

// ─── capability checks ────────────────────────────────────────────────────────

export function isWebAuthnSupported(): boolean {
    return (
        typeof window !== 'undefined' &&
        typeof window.PublicKeyCredential !== 'undefined'
    )
}

export async function isPlatformAuthenticatorAvailable(): Promise<boolean> {
    if (!isWebAuthnSupported()) return false
    try {
        return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
    } catch {
        return false
    }
}

export function isBiometricRegistered(): boolean {
    try {
        return !!localStorage.getItem(BIOMETRIC_REG_KEY)
    } catch {
        return false
    }
}

// ─── crypto helpers ───────────────────────────────────────────────────────────

async function importKey(raw: Uint8Array): Promise<CryptoKey> {
    // SubtleCrypto expects ArrayBuffer; slice creates a fresh one regardless of byteOffset
    return crypto.subtle.importKey('raw', raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

async function encryptCreds(key: CryptoKey, email: string, password: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const encoded = new TextEncoder().encode(JSON.stringify({ email, password }))
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded)
    const out = new Uint8Array(12 + cipher.byteLength)
    out.set(iv)
    out.set(new Uint8Array(cipher), 12)
    return btoa(String.fromCharCode(...out))
}

async function decryptCreds(key: CryptoKey, b64: string): Promise<{ email: string; password: string }> {
    const buf = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
    const iv = buf.slice(0, 12)
    const cipher = buf.slice(12)
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher)
    return JSON.parse(new TextDecoder().decode(plain))
}

// ─── registration ─────────────────────────────────────────────────────────────

export async function registerBiometric(
    userId: string,
    email: string,
    password: string,
): Promise<{ success: boolean; error?: string }> {
    if (!isWebAuthnSupported()) return { success: false, error: 'WebAuthn not supported on this device.' }

    // 32-byte random key — stored in the WebAuthn credential's userHandle
    const keyBytes = crypto.getRandomValues(new Uint8Array(32))
    const challenge = crypto.getRandomValues(new Uint8Array(32))

    let credential: PublicKeyCredential | null = null
    try {
        credential = (await navigator.credentials.create({
            publicKey: {
                challenge,
                rp: {
                    name: 'KiNG FLEXY GH',
                    id: window.location.hostname,
                },
                user: {
                    // userHandle = our encryption key — returned verbatim during authentication
                    id: keyBytes,
                    name: email,
                    displayName: email,
                },
                pubKeyCredParams: [
                    { alg: -7, type: 'public-key' },   // ES256
                    { alg: -257, type: 'public-key' },  // RS256
                ],
                authenticatorSelection: {
                    authenticatorAttachment: 'platform',
                    userVerification: 'required',
                    // 'preferred' keeps broader iOS/Safari compatibility while still
                    // requesting a discoverable credential when the platform supports it.
                    residentKey: 'preferred',
                },
                timeout: 60000,
            },
        })) as PublicKeyCredential | null
    } catch (err: any) {
        if (err?.name === 'NotAllowedError') return { success: false, error: 'Biometric prompt was dismissed.' }
        return { success: false, error: 'Biometric registration failed. Please try again.' }
    }

    if (!credential) return { success: false, error: 'No credential returned.' }

    try {
        const cryptoKey = await importKey(keyBytes)
        const encrypted = await encryptCreds(cryptoKey, email, password)

        localStorage.setItem(BIOMETRIC_CREDS_KEY, JSON.stringify({
            credentialId: btoa(String.fromCharCode(...new Uint8Array(credential.rawId))),
            encrypted,
            userId,
        }))
        localStorage.setItem(BIOMETRIC_REG_KEY, '1')

        return { success: true }
    } catch {
        return { success: false, error: 'Failed to save biometric credentials.' }
    }
}

// ─── authentication ───────────────────────────────────────────────────────────

export async function authenticateWithBiometric(): Promise<
    { email: string; password: string } | { error: string }
> {
    if (!isWebAuthnSupported()) return { error: 'WebAuthn not supported.' }

    const storedRaw = localStorage.getItem(BIOMETRIC_CREDS_KEY)
    if (!storedRaw) return { error: 'No biometric credential found. Please re-register.' }

    let stored: { credentialId: string; encrypted: string; userId: string }
    try {
        stored = JSON.parse(storedRaw)
    } catch {
        return { error: 'Biometric data is corrupted. Please re-register.' }
    }

    const challenge = crypto.getRandomValues(new Uint8Array(32))

    // Decode the stored credential ID back into bytes for allowCredentials.
    // Passing allowCredentials is required on Safari/iOS — without it, Face ID
    // cannot discover which passkey to use and the prompt silently fails.
    const credIdBytes = Uint8Array.from(atob(stored.credentialId), c => c.charCodeAt(0))

    let assertion: PublicKeyCredential | null = null
    try {
        assertion = (await navigator.credentials.get({
            publicKey: {
                challenge,
                rpId: window.location.hostname,
                userVerification: 'required',
                timeout: 60000,
                allowCredentials: [{
                    id: credIdBytes.buffer as ArrayBuffer,
                    type: 'public-key',
                    transports: ['internal'],
                }],
            },
        })) as PublicKeyCredential | null
    } catch (err: any) {
        if (err?.name === 'NotAllowedError') return { error: 'Biometric prompt was dismissed.' }
        return { error: 'Biometric authentication failed.' }
    }

    if (!assertion) return { error: 'No assertion returned.' }

    const response = assertion.response as AuthenticatorAssertionResponse
    if (!response.userHandle) return { error: 'Credential does not support biometric login. Please re-register.' }

    try {
        const keyBytes = new Uint8Array(response.userHandle)
        const cryptoKey = await importKey(keyBytes)
        const creds = await decryptCreds(cryptoKey, stored.encrypted)
        return creds
    } catch {
        return { error: 'Could not decrypt credentials. Please re-register biometrics.' }
    }
}

// ─── removal ─────────────────────────────────────────────────────────────────

export function removeBiometric(): void {
    try {
        localStorage.removeItem(BIOMETRIC_CREDS_KEY)
        localStorage.removeItem(BIOMETRIC_REG_KEY)
    } catch {}
}
