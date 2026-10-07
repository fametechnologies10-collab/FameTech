import { Redis } from '@upstash/redis'
import { Ratelimit } from '@upstash/ratelimit'
import { consumeRateLimit } from './simple-rate-limit'

// Voucher PIN reveal (/api/results-checker/retrieve) is the only guest-facing PIN-returning
// surface. Its brute-force protection is only as strong as this limiter, so use Upstash Redis
// (GLOBAL across Vercel instances) when configured. Falls back to the in-memory limiter only when
// Redis env is absent (local/dev) — never fail-open. Same env names as middleware.ts.
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
const redis = (REDIS_URL && REDIS_TOKEN) ? new Redis({ url: REDIS_URL, token: REDIS_TOKEN }) : null

const MAX = 5
const WINDOW_MS = 10 * 60 * 1000
const limiter = redis
    ? new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(MAX, '10 m'), prefix: 'rc-retrieve' })
    : null

/** True = allowed, false = over the limit. IP-keyed, 5 / 10 min. */
export async function checkRcRetrieveLimit(ip: string): Promise<boolean> {
    if (limiter) {
        try {
            const { success } = await limiter.limit(ip)
            return success
        } catch {
            // Redis hiccup — degrade to the per-instance limiter rather than fail-open.
            return consumeRateLimit(`rc-retrieve:${ip}`, MAX, WINDOW_MS).allowed
        }
    }
    return consumeRateLimit(`rc-retrieve:${ip}`, MAX, WINDOW_MS).allowed
}
