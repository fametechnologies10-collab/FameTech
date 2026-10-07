import { needsReacceptance } from './terms'

// Guest storefront acceptance is stored client-side (guests aren't logged in).
// We store the accepted VERSION string (not a boolean) so a version bump re-prompts
// automatically, reusing the same compareVersions logic as the logged-in gate.
// Global key: localStorage is per-origin, and the terms are platform-wide identical.
export const STOREFRONT_TERMS_KEY = 'kfg_storefront_terms_accepted'

function store(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

export function getStoredStorefrontVersion(): string | null {
  try {
    return store()?.getItem(STOREFRONT_TERMS_KEY) ?? null
  } catch {
    return null
  }
}

export function recordStorefrontAccept(version: string): void {
  try {
    store()?.setItem(STOREFRONT_TERMS_KEY, version)
  } catch {
    // Private mode / storage disabled — the gate simply prompts again next time.
  }
}

/** True when the guest must accept: never accepted, or accepted an older version. */
export function storefrontNeedsAccept(min: string): boolean {
  return needsReacceptance(getStoredStorefrontVersion(), min)
}
