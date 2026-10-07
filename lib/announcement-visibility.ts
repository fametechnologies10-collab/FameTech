// Pure, client-safe helpers for the "one active announcement per surface" model.
// main_site and storefronts are independent popup surfaces; 'both' spans both.
// overlaps(a, b) === a === 'both' || b === 'both' || a === b.

export type VisibleOn = 'main_site' | 'storefronts' | 'both'

/**
 * The set of `visible_on` values whose popup surface overlaps `scope` — i.e. the
 * scopes to deactivate when `scope` becomes the active announcement.
 */
export function overlappingScopes(scope: string): string[] {
    if (scope === 'both') return ['main_site', 'storefronts', 'both']
    if (scope === 'storefronts') return ['storefronts', 'both']
    return ['main_site', 'both'] // main_site + unknown fall back to the main surface
}

export type ShowingRow = {
    id: string
    is_active?: boolean | null
    visible_on?: string | null
    created_at?: string | null
}

/**
 * The ids that actually pop for users: the NEWEST active announcement on each
 * surface. MAIN winner = newest active row with visible_on in {main_site, both};
 * SHOP winner = newest active row with visible_on in {storefronts, both}. A 'both'
 * row can win both surfaces. Any other active row is shadowed (active-but-hidden).
 */
export function computeShowingIds(rows: ShowingRow[]): Set<string> {
    const ts = (r: ShowingRow) => (r.created_at ? new Date(r.created_at).getTime() : 0)
    const newestActiveOn = (scopes: string[]): string | null => {
        let best: ShowingRow | null = null
        for (const r of rows) {
            if (!r.is_active) continue
            if (!scopes.includes(r.visible_on ?? 'main_site')) continue
            if (!best || ts(r) > ts(best)) best = r
        }
        return best ? best.id : null
    }
    const ids = new Set<string>()
    const main = newestActiveOn(['main_site', 'both'])
    const shop = newestActiveOn(['storefronts', 'both'])
    if (main) ids.add(main)
    if (shop) ids.add(shop)
    return ids
}
