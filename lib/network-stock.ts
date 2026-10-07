/**
 * Single source of truth for per-network data-bundle "out of stock" switches.
 *
 *  - Admin (global): admin_settings.data_network_stock — a JSONB object
 *    { "MTN": false, ... } where true = hidden everywhere.
 *  - Shop (per-shop): shop_profiles.oos_networks — a JSONB array of network
 *    names hidden on that shop only.
 *
 * Effective rule: main site uses the admin set; shop surfaces use admin ∪ shop.
 * "Hidden" means the network shows "Out of Stock at the Moment" and cannot be
 * purchased — orthogonal to data_packages.is_available / ussd_enabled.
 */

export const DATA_NETWORKS = ['MTN', 'Telecel', 'AT-iShare', 'AT-BigTime'] as const
export type DataNetwork = (typeof DATA_NETWORKS)[number]

const NETWORK_SET: ReadonlySet<string> = new Set(DATA_NETWORKS)

export function isDataNetwork(v: unknown): v is DataNetwork {
    return typeof v === 'string' && NETWORK_SET.has(v)
}

/** Parse admin_settings.data_network_stock (object) → Set of out-of-stock networks. */
export function parseAdminStock(value: unknown): Set<string> {
    const out = new Set<string>()
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const obj = value as Record<string, unknown>
        for (const net of DATA_NETWORKS) {
            if (obj[net] === true) out.add(net)
        }
    }
    return out
}

/** Parse a shop's oos_networks (array) → Set of out-of-stock networks. */
export function parseShopStock(value: unknown): Set<string> {
    const out = new Set<string>()
    if (Array.isArray(value)) {
        for (const net of value) {
            if (typeof net === 'string' && NETWORK_SET.has(net)) out.add(net)
        }
    }
    return out
}

/** Union the admin set with a shop's raw oos_networks value (does not mutate input). */
export function mergeOOS(adminSet: Set<string>, shopValue: unknown): Set<string> {
    const merged = new Set(adminSet)
    for (const net of parseShopStock(shopValue)) merged.add(net)
    return merged
}

export function isNetworkOOS(oos: Set<string>, network: string): boolean {
    return oos.has(network)
}

/** Read the global admin out-of-stock set from the single admin_settings row. */
export async function getAdminOOSNetworks(db: any): Promise<Set<string>> {
    const { data } = await db
        .from('admin_settings')
        .select('value')
        .eq('key', 'data_network_stock')
        .maybeSingle()
    return parseAdminStock(data?.value)
}
