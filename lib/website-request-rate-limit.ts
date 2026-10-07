import { Redis } from '@upstash/redis'
import { Ratelimit } from '@upstash/ratelimit'
import { consumeRateLimit } from './simple-rate-limit'

// Same env vars as lib/support-rate-limit.ts / middleware.ts — global across
// Vercel instances when configured, falls back to the per-instance in-memory
// limiter only when Redis env is absent (never fail-open).
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
const redis = (REDIS_URL && REDIS_TOKEN) ? new Redis({ url: REDIS_URL, token: REDIS_TOKEN }) : null

export const WEBSITE_REQUEST_CREATE_MAX = 5
const WEBSITE_REQUEST_CREATE_WINDOW_MS = 60 * 60 * 1000

const createLimiter = redis
    ? new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(WEBSITE_REQUEST_CREATE_MAX, '1 h'), prefix: 'website-request' })
    : null

/** True = allowed. User-keyed, 5 submissions / hour. */
export async function checkWebsiteRequestCreateLimit(userId: string): Promise<boolean> {
    if (createLimiter) {
        try {
            const { success } = await createLimiter.limit(userId)
            return success
        } catch {
            return consumeRateLimit(`website-request:${userId}`, WEBSITE_REQUEST_CREATE_MAX, WEBSITE_REQUEST_CREATE_WINDOW_MS).allowed
        }
    }
    return consumeRateLimit(`website-request:${userId}`, WEBSITE_REQUEST_CREATE_MAX, WEBSITE_REQUEST_CREATE_WINDOW_MS).allowed
}
