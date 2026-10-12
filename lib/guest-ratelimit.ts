import { Redis } from '@upstash/redis'
import { Ratelimit } from '@upstash/ratelimit'
import { consumeRateLimit } from './simple-rate-limit'

// Redis-backed (GLOBAL across Vercel instances) limiter for guest routes that trigger
// real-world side effects — MoMo prompts to a third party's phone, OTP SMS to an
// arbitrary number. The per-instance in-memory limiter (simple-rate-limit) is only a
// fallback: serverless fan-out gives every instance its own counter, so on its own it
// does not bind an attacker. Never fail-open: a Redis outage degrades to the
// per-instance limiter, it does not remove the limit.
// Same env names as middleware.ts / charge-phone-ratelimit.ts.
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
const redis = (REDIS_URL && REDIS_TOKEN) ? new Redis({ url: REDIS_URL, token: REDIS_TOKEN }) : null

const limiters = new Map<string, Ratelimit>()

function getLimiter(prefix: string, max: number, windowSec: number): Ratelimit | null {
    if (!redis) return null
    const id = `${prefix}:${max}:${windowSec}`
    let l = limiters.get(id)
    if (!l) {
        l = new Ratelimit({
            redis,
            limiter: Ratelimit.slidingWindow(max, `${windowSec} s`),
            prefix: `ft:guest:${id}`,
        })
        limiters.set(id, l)
    }
    return l
}

/** True = allowed, false = over the limit. `prefix` namespaces the bucket; `key` is the subject (IP, phone…). */
export async function checkGuestLimit(prefix: string, key: string, max: number, windowSec: number): Promise<boolean> {
    const limiter = getLimiter(prefix, max, windowSec)
    if (limiter) {
        try {
            const { success } = await limiter.limit(key)
            return success
        } catch {
            // Redis hiccup — degrade to the per-instance limiter rather than fail-open.
        }
    }
    return consumeRateLimit(`guest:${prefix}:${key}`, max, windowSec * 1000).allowed
}
