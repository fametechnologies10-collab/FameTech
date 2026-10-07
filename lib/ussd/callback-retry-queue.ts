/**
 * Pure decision logic for the ussd_callback_retry_queue recovery mechanism.
 * DB/network side effects live in lib/ussd/hubtel-callback.ts (enqueue on failure) and
 * app/api/ussd/status-check/route.ts (drain + retry cron) — kept out of this module so
 * the timing/dedup rules stay independently testable (scripts/test-callback-retry-queue.ts).
 */

export const CALLBACK_RETRY_ESCALATION_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * True once a queue row has been failing for MORE than 24h since its first failure —
 * at that point the cron gives up auto-retrying and escalates (one final admin alert).
 * Exactly 24h is NOT yet escalated (must exceed, not just reach, the window).
 */
export function shouldEscalateCallbackRetry(firstFailedAt: string | Date, now: Date): boolean {
    const first = firstFailedAt instanceof Date ? firstFailedAt : new Date(firstFailedAt)
    return now.getTime() - first.getTime() > CALLBACK_RETRY_ESCALATION_WINDOW_MS
}

/**
 * Whether sendHubtelCallback's give-up path should fire its immediate admin push.
 * Only the FIRST failure for a session pages immediately — once a queue row exists for
 * it (unresolved and not yet escalated), subsequent cron-retry failures stay quiet;
 * the cron's own 24h escalation is the next alert. A resolved row failing again is a
 * NEW incident (e.g. re-fulfilled later) and pages immediately, same as a fresh failure.
 * An already-escalated row never re-alerts on every further failed retry.
 */
export function shouldSendImmediateCallbackAlert(
    existingRow: { resolved: boolean; escalated: boolean } | null,
): boolean {
    if (!existingRow) return true
    if (existingRow.resolved) return true
    return false
}
