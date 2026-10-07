type RateLimitEntry = {
    count: number
    resetAt: number
}

const rateLimitStore = new Map<string, RateLimitEntry>()

export function consumeRateLimit(
    key: string,
    limit: number,
    windowMs: number
): { allowed: boolean; remaining: number; retryAfterMs: number } {
    const now = Date.now()
    const entry = rateLimitStore.get(key)

    if (!entry || entry.resetAt <= now) {
        rateLimitStore.set(key, {
            count: 1,
            resetAt: now + windowMs,
        })

        return {
            allowed: true,
            remaining: Math.max(0, limit - 1),
            retryAfterMs: windowMs,
        }
    }

    if (entry.count >= limit) {
        return {
            allowed: false,
            remaining: 0,
            retryAfterMs: Math.max(0, entry.resetAt - now),
        }
    }

    entry.count += 1
    rateLimitStore.set(key, entry)

    return {
        allowed: true,
        remaining: Math.max(0, limit - entry.count),
        retryAfterMs: Math.max(0, entry.resetAt - now),
    }
}
