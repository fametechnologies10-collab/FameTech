import { Redis } from '@upstash/redis'
import { Ratelimit } from '@upstash/ratelimit'
import { consumeRateLimit } from './simple-rate-limit'

// /api/payments/charge triggers a real MoMo prompt on the supplied phone. The existing
// middleware limiter is keyed per-user+IP, so a single account can still fire up to its
// per-minute cap at an arbitrary third-party number indefinitely over time. This limiter
// is keyed by the PHONE itself (global across every caller) so no single number can be
// prompt-spammed regardless of which account is doing it. Upstash Redis when configured
// (GLOBAL across Vercel instances); falls back to the in-memory limiter only when Redis
// env is absent (local/dev) — never fail-open. Same env names as middleware.ts.
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
const redis = (REDIS_URL && REDIS_TOKEN) ? new Redis({ url: REDIS_URL, token: REDIS_TOKEN }) : null

const MAX = 5
const WINDOW_MS = 10 * 60 * 1000
const limiter = redis
    ? new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(MAX, '10 m'), prefix: 'charge-phone' })
    : null

/** True = allowed, false = over the limit. Phone-keyed (not user), 5 / 10 min, global. */
export async function checkChargePhoneLimit(phone: string): Promise<boolean> {
    if (limiter) {
        try {
            const { success } = await limiter.limit(phone)
            return success
        } catch {
            // Redis hiccup — degrade to the per-instance limiter rather than fail-open.
            return consumeRateLimit(`charge-phone:${phone}`, MAX, WINDOW_MS).allowed
        }
    }
    return consumeRateLimit(`charge-phone:${phone}`, MAX, WINDOW_MS).allowed
}
