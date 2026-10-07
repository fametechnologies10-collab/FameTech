import { Redis } from '@upstash/redis'
import { Ratelimit } from '@upstash/ratelimit'
import { consumeRateLimit } from './simple-rate-limit'

// The MTN whitelist verify endpoint is guest-reachable from every storefront, and each
// `allowed: false` number it forwards is auto-submitted to MTN for enabling. Unlimited
// access would let anyone push arbitrary volumes of whitelist requests into MTN's queue
// under our account, so this limiter is the only thing standing between an abuser and that
// side effect — use Upstash Redis (GLOBAL across Vercel instances) when configured, and
// fall back to the per-instance limiter only when Redis env is absent. Never fail open.
// Same env names as lib/rc-retrieve-ratelimit.ts and middleware.ts.
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
const redis = (REDIS_URL && REDIS_TOKEN) ? new Redis({ url: REDIS_URL, token: REDIS_TOKEN }) : null

// Signed-in customers get the bulk allowance (they are the ones legitimately preparing a
// 1000-number upload); guests on a storefront only ever check the number they are about to
// buy for, so their allowance is deliberately tight.
const AUTHED_MAX = 12
const GUEST_MAX = 6
const WINDOW_MS = 10 * 60 * 1000

const authedLimiter = redis
    ? new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(AUTHED_MAX, '10 m'), prefix: 'mtn-wl-user' })
    : null
const guestLimiter = redis
    ? new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(GUEST_MAX, '10 m'), prefix: 'mtn-wl-ip' })
    : null

/** True = allowed, false = over the limit. Keyed by user id when signed in, else by IP. */
export async function checkMtnWhitelistLimit(identifier: string, authenticated: boolean): Promise<boolean> {
    const limiter = authenticated ? authedLimiter : guestLimiter
    const max = authenticated ? AUTHED_MAX : GUEST_MAX
    const fallbackKey = `mtn-wl:${authenticated ? 'user' : 'ip'}:${identifier}`

    if (limiter) {
        try {
            const { success } = await limiter.limit(identifier)
            return success
        } catch {
            // Redis hiccup — degrade to the per-instance limiter rather than fail open.
            return consumeRateLimit(fallbackKey, max, WINDOW_MS).allowed
        }
    }
    return consumeRateLimit(fallbackKey, max, WINDOW_MS).allowed
}
