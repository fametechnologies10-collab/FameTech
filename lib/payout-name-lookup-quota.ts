import { Redis } from '@upstash/redis'

// A8 — per-user daily cap on number→name lookups. The resolver returns the
// registered holder name for an arbitrary MoMo/bank number; without a cap it is
// a bulk de-anonymization / phone-to-identity oracle. A genuine owner verifies
// only a handful of payout numbers, so a tight daily cap kills bulk harvesting
// while leaving the real withdrawal-setup flow untouched. Shared by
// /api/shop/validate-account and /api/shop/payment-details so both spend ONE quota.
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
const redis = REDIS_URL && REDIS_TOKEN ? new Redis({ url: REDIS_URL, token: REDIS_TOKEN }) : null
export const DAILY_LOOKUP_CAP = 20

/**
 * Consume one name-lookup from the user's daily quota. Returns false when the cap
 * is exceeded. Best-effort: fails open on a Redis outage, since this is a privacy
 * control, not a money gate.
 */
export async function consumeNameLookupQuota(userId: string): Promise<boolean> {
    if (!redis) return true
    try {
        // incr + expire in one pipeline so a Lambda dying mid-way can't leave a
        // TTL-less key that permanently blocks the user (L2).
        const capKey = `valacct:daily:${userId}`
        const [count] = (await redis
            .pipeline()
            .incr(capKey)
            .expire(capKey, 86400)
            .exec()) as [number, number]
        return count <= DAILY_LOOKUP_CAP
    } catch (e) {
        console.error('[name-lookup-quota] daily cap check failed, proceeding:', e)
        return true
    }
}
