import { Redis } from '@upstash/redis'
import { Ratelimit } from '@upstash/ratelimit'
import { consumeRateLimit } from './simple-rate-limit'

// Per-user limiter for the dashboard delivery-status endpoint. Upstash (global)
// when configured; per-instance in-memory fallback otherwise — never fail-open.
// Same env names as lib/support-rate-limit.ts.
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
const redis = (REDIS_URL && REDIS_TOKEN) ? new Redis({ url: REDIS_URL, token: REDIS_TOKEN }) : null

export const GATEWAY_STATUS_MAX = 30
const GATEWAY_STATUS_WINDOW_MS = 60 * 1000

const limiter = redis
    ? new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(GATEWAY_STATUS_MAX, '1 m'), prefix: 'gateway-status' })
    : null

/** True = allowed. User-keyed, 30 requests / minute. */
export async function checkGatewayStatusLimit(userId: string): Promise<boolean> {
    if (limiter) {
        try {
            const { success } = await limiter.limit(userId)
            return success
        } catch {
            // Redis hiccup — degrade to the per-instance limiter rather than fail-open.
        }
    }
    return consumeRateLimit(`gateway-status:${userId}`, GATEWAY_STATUS_MAX, GATEWAY_STATUS_WINDOW_MS).allowed
}
