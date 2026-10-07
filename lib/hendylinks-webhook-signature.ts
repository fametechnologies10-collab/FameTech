import { createHmac, timingSafeEqual } from 'crypto'

/**
 * Verifies HendyLinks' `X-Webhook-Signature: sha256=<hex>` header, an HMAC-SHA256 over the
 * RAW request body (per their docs' Node.js example:
 * crypto.createHmac('sha256', 'YOUR_API_TOKEN')).
 *
 * Lives here rather than inside app/api/webhooks/hendylinks/route.ts purely so it can be
 * unit-tested — a Next.js App Router `route.ts` may only export route handlers and route
 * config, so a helper exported from it would fail the build's route type check.
 *
 * The secret is passed in (not read from the environment here) so tests can exercise the
 * comparison without depending on process.env. The caller keeps the fail-closed
 * "no secret configured → 503" check.
 *
 * Constant-time compare via timingSafeEqual, never `===`. The length equality test comes
 * FIRST and short-circuits deliberately: timingSafeEqual THROWS on differing buffer lengths,
 * so a signature of the wrong length must never reach it. The surrounding try/catch is a
 * second net so a malformed header can only ever produce `false`, never a 500.
 */
export function verifyHendyLinksSignature(rawBody: string, signatureHeader: string, secret: string): boolean {
    try {
        if (!secret || !signatureHeader) return false

        const provided = signatureHeader.replace(/^sha256=/, '')
        const expected = createHmac('sha256', secret).update(rawBody).digest('hex')

        const expectedBuf = Buffer.from(expected)
        const providedBuf = Buffer.from(provided)
        return expectedBuf.length === providedBuf.length && timingSafeEqual(expectedBuf, providedBuf)
    } catch {
        return false
    }
}
