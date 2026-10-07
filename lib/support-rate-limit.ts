import { Redis } from '@upstash/redis'
import { Ratelimit } from '@upstash/ratelimit'
import { consumeRateLimit } from './simple-rate-limit'

// Support-thread writes are authenticated but still abusable (each new thread
// emails the admin), so limits are enforced server-side with Upstash Redis
// (GLOBAL across Vercel instances) when configured. Falls back to the
// per-instance in-memory limiter only when Redis env is absent (local/dev) —
// never fail-open. Same env names as middleware.ts / rc-retrieve-ratelimit.ts.
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
const redis = (REDIS_URL && REDIS_TOKEN) ? new Redis({ url: REDIS_URL, token: REDIS_TOKEN }) : null

export const THREAD_CREATE_MAX = 3
const THREAD_CREATE_WINDOW_MS = 60 * 60 * 1000

export const MESSAGE_SEND_MAX = 10
const MESSAGE_SEND_WINDOW_MS = 60 * 1000

const threadLimiter = redis
    ? new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(THREAD_CREATE_MAX, '1 h'), prefix: 'support-thread' })
    : null

const messageLimiter = redis
    ? new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(MESSAGE_SEND_MAX, '1 m'), prefix: 'support-msg' })
    : null

async function check(
    limiter: Ratelimit | null,
    fallbackKey: string,
    max: number,
    windowMs: number,
    id: string
): Promise<boolean> {
    if (limiter) {
        try {
            const { success } = await limiter.limit(id)
            return success
        } catch {
            // Redis hiccup — degrade to the per-instance limiter rather than fail-open.
            return consumeRateLimit(`${fallbackKey}:${id}`, max, windowMs).allowed
        }
    }
    return consumeRateLimit(`${fallbackKey}:${id}`, max, windowMs).allowed
}

/** True = allowed. User-keyed, 3 new threads / hour. */
export function checkThreadCreateLimit(userId: string): Promise<boolean> {
    return check(threadLimiter, 'support-thread', THREAD_CREATE_MAX, THREAD_CREATE_WINDOW_MS, userId)
}

/** True = allowed. User-keyed, 10 messages / minute. */
export function checkMessageSendLimit(userId: string): Promise<boolean> {
    return check(messageLimiter, 'support-msg', MESSAGE_SEND_MAX, MESSAGE_SEND_WINDOW_MS, userId)
}
