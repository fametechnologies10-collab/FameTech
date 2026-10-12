// lib/airtime-transitions.ts
//
// Pure rules for ADMIN-driven airtime_orders status changes. The admin PATCH, the bulk "complete"
// action and the fulfillment batches all used to write `status` with `.eq('id', …)` only, so an
// admin (or a stale batch) could flip a REFUNDED order to 'completed' — the customer then holds a
// refund AND a "delivered" order — or complete one that a provider webhook had just failed.
// Every writer now filters its UPDATE on these source statuses.

export type AirtimeStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'refunded'
export type AdminTargetStatus = 'processing' | 'completed' | 'failed'

const ALLOWED_FROM: Record<AdminTargetStatus, AirtimeStatus[]> = {
    // Only an order nobody has picked up yet, or one that failed, can be (re)started.
    processing: ['pending', 'failed'],
    // 'failed' → 'completed' is legitimate: the provider reported failure but the airtime was
    // confirmed delivered out of band. 'refunded' is deliberately absent — money already went back.
    completed: ['pending', 'processing', 'failed'],
    // A completed order is never failed after the fact; a refunded one is already terminal.
    failed: ['pending', 'processing'],
}

export function isAdminTargetStatus(value: unknown): value is AdminTargetStatus {
    return value === 'processing' || value === 'completed' || value === 'failed'
}

/** Source statuses an UPDATE to `to` may start from (use in `.in('status', …)`). */
export function allowedSourceStatuses(to: AdminTargetStatus): AirtimeStatus[] {
    return ALLOWED_FROM[to]
}

export function canAdminTransition(from: string, to: AdminTargetStatus): boolean {
    return (ALLOWED_FROM[to] as string[]).includes(from)
}
