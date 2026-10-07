// lib/momo-eligibility.ts
//
// Dependency-free BY DESIGN — this file must have ZERO imports. It exists so
// 'use client' pages (app/dashboard/shop/orders/page.tsx,
// app/admin/fulfillment/page.tsx) can decide whether to render the "View
// MoMo" button without dragging server-only code into the browser bundle.
//
// Before this file existed, both pages imported `isMomoLookupEligible` from
// lib/momo-payer-resolver.ts, whose top-level imports pull in
// lib/sms-service.ts (~45 KB, and runs `validateSMSConfig()` at module scope
// — an observable side effect that stops webpack from tree-shaking it) and
// lib/momo-verify.ts. That shipped ~45 KB of dead server code plus
// "[SMS Config] WARNING" console spam to every visitor of two mobile-first
// pages. Keep this file import-free — that is the whole point.
//
// lib/momo-payer-resolver.ts re-exports this function so existing
// server-side importers are unaffected.

/**
 * The ONLY thing that determines whether payer details may be returned.
 * Callers must re-run this against the freshest DB row on every request —
 * a hidden/disabled button on the client is cosmetic, not a security gate.
 */
export function isMomoLookupEligible(order: { status: string | null }): boolean {
    return order.status === 'failed' || order.status === 'refunded'
}
