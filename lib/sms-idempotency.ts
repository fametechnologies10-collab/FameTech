import { createHash } from 'crypto'

/**
 * Stable v5-style UUID from a seed — makes developer-API sends idempotent:
 * the same (account, client reference) always maps to the same campaign id, so
 * a retry hits the debit-ledger key `debit:{id}` (ON CONFLICT DO NOTHING) and
 * is a no-op instead of a second charge/send. Dependency-free so it is unit-
 * testable without loading the DB layer.
 */
export function deterministicUuid(seed: string): string {
    const h = createHash('sha256').update('kfg-sms:' + seed).digest('hex')
    const y = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${y}${h.slice(17, 20)}-${h.slice(20, 32)}`
}
