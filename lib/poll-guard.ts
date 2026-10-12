/**
 * Guards async polling loops against stale results. Each `begin()` invalidates
 * all earlier tokens; `cancel()` invalidates the latest one too.
 */
export function createPollGuard(): { begin(): number; isCurrent(token: number): boolean; cancel(): void } {
    let current = 0
    return {
        begin() {
            current += 1
            return current
        },
        isCurrent(token: number) {
            return token === current
        },
        cancel() {
            current += 1
        },
    }
}
