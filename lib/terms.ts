export type TermsTone = 'red' | 'amber' | 'gold' | 'green' | 'u' | 'none'

export interface TermsSection {
  id: string
  title: string
  /** Body text with inline [[tone: …]] markup. May contain the {{brand}} token. */
  body: string
  /** Optional right-side status badge, e.g. "Upcoming". */
  badge?: string
  /** 'dashboard' = platform-only (hidden from shop storefronts). Defaults to 'all'. */
  scope?: 'all' | 'dashboard'
  /** Optional buyer-worded body used on shop storefronts (falls back to `body`). */
  storefront?: string
}

export interface TermsChangeEntry {
  version: string
  date: string
  summary: string[]
}

export interface CurrentTerms {
  version: string
  effectiveDate: string
  minAcceptableVersion: string
  changelog: TermsChangeEntry[]
  sections: TermsSection[]
}

// Hard fallback if the DB read ever fails (keeps the app usable).
export const FALLBACK_TERMS_VERSION = '2026-07-02'
export const FALLBACK_EFFECTIVE_DATE = 'July 2, 2026'

/** Lexicographic compare — safe because versions are zero-padded YYYY-MM-DD. */
export function compareVersions(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** True when the user must (re-)accept: never accepted, or accepted an older version. */
export function needsReacceptance(accepted: string | null | undefined, min: string): boolean {
  if (!accepted) return true
  return compareVersions(accepted, min) < 0
}

/** The platform brand name that {{brand}} resolves to on the main site / dashboard. */
export const PLATFORM_BRAND = 'KiNG FLEXY GH'

/** A section resolved for a specific audience — brand token substituted, ready to render. */
export interface RenderedSection {
  id: string
  title: string
  body: string
  badge?: string
}

/** Replace the {{brand}} token with the audience's brand (platform name or shop name). */
export function renderBrand(text: string, brand: string): string {
  return text.split('{{brand}}').join(brand)
}

/**
 * Resolve which sections to render for an audience, with the {{brand}} token
 * substituted. On a storefront, drops `scope: 'dashboard'` sections and prefers
 * each section's buyer-worded `storefront` body when present.
 */
export function sectionsForAudience(
  sections: TermsSection[],
  opts: { storefront: boolean; brand: string }
): RenderedSection[] {
  return sections
    .filter((s) => (opts.storefront ? s.scope !== 'dashboard' : true))
    .map((s) => ({
      id: s.id,
      title: renderBrand(s.title, opts.brand),
      body: renderBrand(opts.storefront ? (s.storefront ?? s.body) : s.body, opts.brand),
      badge: s.badge,
    }))
}
