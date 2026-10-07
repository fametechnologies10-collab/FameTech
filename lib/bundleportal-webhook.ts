// lib/bundleportal-webhook.ts
//
// Pure HMAC verification helper for the Bundle Portal webhook. Deliberately has ZERO other
// dependencies (no Supabase import, nothing) — importable without any env vars being set, and
// safe to unit-test in a clean shell. Moved out of app/api/webhooks/bundleportal/route.ts
// because Next.js 15's route-file type checker only allows specific named exports (HTTP method
// handlers + a few config values); any other named export on a route.ts file fails `next build`.
import { timingSafeEqual, createHmac } from 'crypto'

// ─── Signature Verification ────────────────────────────────────────────────────
// Bundle Portal signs the raw request body with HMAC-SHA256 and sends the result as
// X-BundlePortal-Signature: sha256=<hex>. Exported for scripts/test-bundleportal-webhook-signature.ts
// and for app/api/webhooks/bundleportal/route.ts.
export function verifyBundlePortalSignature(rawBody: string, signatureHeader: string, secret: string): boolean {
    try {
        const provided = signatureHeader.replace(/^sha256=/, '')
        const expected = createHmac('sha256', secret).update(rawBody).digest('hex')

        const expectedBuf = Buffer.from(expected)
        const providedBuf = Buffer.from(provided)
        return expectedBuf.length === providedBuf.length && timingSafeEqual(expectedBuf, providedBuf)
    } catch {
        return false
    }
}
