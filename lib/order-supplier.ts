// Pure supplier-resolution logic for the Admin Fulfillment Center — no I/O.
// Derives which supplier fulfilled an order (or whether it was manually
// exported, or never touched at all) from data already recorded on
// `orders` and `mtn_fulfillment_tracking`. No DB migration involved.
// See docs/superpowers/specs/2026-07-28-fulfillment-supplier-tag-design.md.

export type SupplierTag = 'datakazina' | 'codecraft' | 'xpress' | 'ghdata' | 'agentportal' | 'datagod' | 'bundleportal' | 'hendylinks' | 'atishare_console' | 'spfastit' | 'exported'

export interface TrackingRowForSupplier {
    api_response?: { supplier?: string | null } | null
    created_at?: string | null
}

const KNOWN_SUPPLIERS: ReadonlySet<string> = new Set(['datakazina', 'codecraft', 'xpress', 'ghdata', 'agentportal', 'datagod', 'bundleportal', 'hendylinks', 'atishare_console', 'spfastit'])

// Real suppliers `orders.fulfillment_method` can hold (its CHECK constraint also allows
// 'auto' / 'manual', which are dispatch-mode markers, not supplier identities — never
// treated as a resolved supplier here).
const KNOWN_FULFILLMENT_METHODS: ReadonlySet<string> = new Set(['datakazina', 'codecraft', 'xpress', 'ghdata', 'agentportal', 'datagod', 'bundleportal', 'hendylinks', 'atishare_console', 'spfastit'])

/**
 * Resolves the supplier tag for an order. There is no default supplier: every
 * real fulfillment attempt tags its own `supplier` in `api_response` or stamps
 * `orders.fulfillment_method`, and a manually exported order is linked via
 * `download_batch_id`. An order with none of those — including a tracking row
 * that exists but carries no `supplier` field — was never actually fulfilled
 * by anything identifiable, so it resolves to `null` (rendered as "N/A" by
 * callers).
 *
 * ## Precedence: `fulfillmentMethod` first, tracking rows as fallback
 *
 * This order is deliberate and answers "what if an order was fulfilled by
 * supplier A, failed/was retried, and later actually fulfilled by supplier B —
 * does this show the old or the new supplier?" It must always show the latest.
 *
 * `orders.fulfillment_method` is a single column that every dispatch path
 * (lib/fulfillment-trigger.ts, lib/shop-order-processor.ts, and the admin
 * ghdata/datagod manual-fulfill routes) OVERWRITES on every dispatch attempt,
 * atomically, before calling the supplier. That makes it — uniquely among the
 * signals available here — always the *latest* attempted supplier, by
 * construction, with no ambiguity about ordering.
 *
 * `mtn_fulfillment_tracking`, by contrast, is insert-only: every attempt for
 * the same order_id (e.g. an auto-refulfill retry that lands on a different
 * supplier the second time) adds ANOTHER row rather than replacing the old
 * one. A naive "first row with a supplier tag" lookup can return a STALE
 * attempt from earlier in the order's history instead of what actually
 * fulfilled it. So when `fulfillmentMethod` resolves the answer, tracking rows
 * are not consulted at all. Tracking rows are only used as a fallback for
 * orders where `fulfillment_method` doesn't identify a supplier (still
 * 'auto'/'manual'/null — i.e. never actually dispatched by any of the above
 * paths) — and even there, the LATEST tracking row by `created_at` wins, not
 * just the first one found, for the same "always latest" reason.
 *
 * DataGod's failure path writes `datagod_failed` instead of `datagod` — that
 * variant is normalized to `datagod` since the order's own `status` field
 * already communicates failed/pending/etc. Any other unrecognized supplier
 * string (a future supplier this file doesn't know about yet) is treated as
 * not identified, so it degrades to `null` ("N/A") instead of being cast
 * into `SupplierTag` and crashing a `SUPPLIER_META` lookup downstream.
 *
 * `fulfillmentMethod` is gated on `orderStatus`: the atomic pre-dispatch claim
 * stamps `fulfillment_method` BEFORE calling the supplier, and a failed
 * dispatch reverts only `status` back to 'pending' — `fulfillment_method` is
 * deliberately left holding the name of the supplier that FAILED, so a
 * retry's webhook matching still works. That means on a 'pending' or 'failed'
 * order, `fulfillment_method` means "last supplier attempted," not "supplier
 * that fulfilled it," so it's only trusted once the order has reached a
 * status only reachable via a completed/successful dispatch.
 */
export function resolveSupplier(
    trackingRows: TrackingRowForSupplier[] | null | undefined,
    downloadBatchId: string | null | undefined,
    fulfillmentMethod?: string | null,
    orderStatus?: string | null
): SupplierTag | null {
    const dispatchSucceeded = orderStatus === 'processing' || orderStatus === 'completed' || orderStatus === 'refunded'
    if (dispatchSucceeded && fulfillmentMethod && KNOWN_FULFILLMENT_METHODS.has(fulfillmentMethod)) {
        return fulfillmentMethod as SupplierTag
    }

    const taggedRows = (trackingRows ?? []).filter(t => {
        const s = t?.api_response?.supplier
        return !!s && (KNOWN_SUPPLIERS.has(s) || s === 'datagod_failed')
    })
    if (taggedRows.length > 0) {
        // Latest by created_at wins — a row with no created_at, or an unparseable one,
        // sorts as oldest (Date.parse's NaN is folded into -Infinity) so it never
        // shadows a validly-dated row.
        const parseTime = (t: TrackingRowForSupplier): number => {
            if (!t.created_at) return -Infinity
            const ms = Date.parse(t.created_at)
            return Number.isNaN(ms) ? -Infinity : ms
        }
        const latest = taggedRows.reduce((a, b) => (parseTime(b) > parseTime(a) ? b : a))
        const raw = latest.api_response!.supplier as string
        return (raw === 'datagod_failed' ? 'datagod' : raw) as SupplierTag
    }

    if (downloadBatchId) return 'exported'
    return null
}

export const SUPPLIER_META: Record<SupplierTag | 'na', { label: string; badgeClass: string }> = {
    datakazina: { label: 'DataKazina', badgeClass: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-400 dark:border-emerald-900/40' },
    codecraft: { label: 'CodeCraft', badgeClass: 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-900/40' },
    xpress: { label: 'Xpress', badgeClass: 'bg-violet-100 text-violet-700 border-violet-200 dark:bg-violet-900/20 dark:text-violet-400 dark:border-violet-900/40' },
    ghdata: { label: 'GhData', badgeClass: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/20 dark:text-amber-400 dark:border-amber-900/40' },
    agentportal: { label: 'AgentPortal', badgeClass: 'bg-rose-100 text-rose-700 border-rose-200 dark:bg-rose-900/20 dark:text-rose-400 dark:border-rose-900/40' },
    datagod: { label: 'DataGod', badgeClass: 'bg-cyan-100 text-cyan-700 border-cyan-200 dark:bg-cyan-900/20 dark:text-cyan-400 dark:border-cyan-900/40' },
    bundleportal: { label: 'Bundle Portal', badgeClass: 'bg-fuchsia-100 text-fuchsia-700 border-fuchsia-200 dark:bg-fuchsia-900/20 dark:text-fuchsia-400 dark:border-fuchsia-900/40' },
    hendylinks: { label: 'HendyLinks', badgeClass: 'bg-teal-100 text-teal-700 border-teal-200 dark:bg-teal-900/20 dark:text-teal-400 dark:border-teal-900/40' },
    atishare_console: { label: 'AT-iShare Console', badgeClass: 'bg-indigo-100 text-indigo-700 border-indigo-200 dark:bg-indigo-900/20 dark:text-indigo-400 dark:border-indigo-900/40' },
    spfastit: { label: 'SPFastIT', badgeClass: 'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-900/20 dark:text-orange-400 dark:border-orange-900/40' },
    exported: { label: 'Exported', badgeClass: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800/40 dark:text-slate-400 dark:border-slate-700' },
    na: { label: 'N/A', badgeClass: 'bg-muted text-muted-foreground border-transparent' },
}

export const SUPPLIER_FILTERS: Array<{ key: 'all' | SupplierTag | 'na'; label: string }> = [
    { key: 'all', label: 'All' },
    { key: 'datakazina', label: 'DataKazina' },
    { key: 'codecraft', label: 'CodeCraft' },
    { key: 'xpress', label: 'Xpress' },
    { key: 'ghdata', label: 'GhData' },
    { key: 'agentportal', label: 'AgentPortal' },
    { key: 'datagod', label: 'DataGod' },
    { key: 'bundleportal', label: 'Bundle Portal' },
    { key: 'hendylinks', label: 'HendyLinks' },
    { key: 'atishare_console', label: 'AT-iShare Console' },
    { key: 'spfastit', label: 'SPFastIT' },
    { key: 'exported', label: 'Exported' },
    { key: 'na', label: 'N/A' },
]

// ─── Shared supplier registry ────────────────────────────────────────────────────────
// Single source of truth for "which suppliers can be enabled per network", replacing
// the hand-written lists that previously lived in four dispatch guards plus the admin
// UI toggle. One of those five (lib/api-handlers/data-purchase.ts) silently omitted
// HendyLinks, which is exactly the drift this registry exists to make impossible.
//
// `datagod` and `exported` are deliberately absent: DataGod is manual-fulfill only and
// has no per-network settings map, and `exported` is not a supplier at all.
export const SUPPLIER_NETWORK_SETTING_KEYS = {
    datakazina: 'networks',
    codecraft: 'codecraft_networks',
    xpress: 'xpress_networks',
    ghdata: 'ghdata_networks',
    agentportal: 'agentportal_networks',
    bundleportal: 'bundleportal_networks',
    hendylinks: 'hendylinks_networks',
    atishare_console: 'atishare_console_networks',
    spfastit: 'spfastit_networks',
} as const

export type SupplierKey = keyof typeof SUPPLIER_NETWORK_SETTING_KEYS
export type SupplierSettingKey = (typeof SUPPLIER_NETWORK_SETTING_KEYS)[SupplierKey]

export type FulfillmentNetworkSettings = Partial<
    Record<SupplierSettingKey, Record<string, boolean> | null | undefined>
>

/**
 * Returns every supplier enabled for `network`, in registry order.
 *
 * Callers treat `length > 1` as a conflict (halt + alert), `length === 0` as
 * "no active supplier" (keep pending + alert), and `[0]` as the supplier to
 * dispatch to. The strict `=== true` comparison preserves the behaviour of the
 * per-site checks this replaces — a stringified "true" from a JSON settings blob
 * must NOT count as enabled.
 */
export function resolveEnabledSuppliers(
    settings: FulfillmentNetworkSettings | null | undefined,
    network: string
): SupplierKey[] {
    if (!settings || !network) return []
    return (Object.keys(SUPPLIER_NETWORK_SETTING_KEYS) as SupplierKey[])
        .filter(key => settings[SUPPLIER_NETWORK_SETTING_KEYS[key]]?.[network] === true)
}
