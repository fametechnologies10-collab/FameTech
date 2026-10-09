'use client'

import { useEffect, useRef, useState } from 'react'
import { StorefrontTermsGate } from './StorefrontTermsGate'
import { storefrontNeedsAccept, recordStorefrontAccept } from '@/lib/storefront-terms'
import type { CurrentTerms } from '@/lib/terms'

// Per-tab memory of a dismissed popup, so closing it (tap outside, Esc, X, Decline)
// keeps it away on refresh/navigation. A new tab/visit shows it once again.
const DISMISSED_KEY = 'kfg_storefront_terms_dismissed'

function wasDismissed(): boolean {
  try { return sessionStorage.getItem(DISMISSED_KEY) === '1' } catch { return false }
}
function rememberDismissed(): void {
  try { sessionStorage.setItem(DISMISSED_KEY, '1') } catch { /* storage unavailable — just closes for now */ }
}

/**
 * Page-load terms popup for shop storefronts. It is informational, NOT a gate: a guest can
 * close it any way they like (tap outside, Esc, X, Decline) and keep browsing and buying
 * whether or not they accept. Once closed it does not reappear in that tab.
 */
export function StorefrontTermsBoundary({
  brandName,
  onGateResolved,
}: {
  brandName: string
  /** Fires once the popup is out of the way — guest already accepted, dismissed it, the
   *  check failed (no popup renders), or the guest accepts. Lets the storefront hold
   *  other popups (announcements) until the terms popup is dealt with. */
  onGateResolved?: () => void
}) {
  const [terms, setTerms] = useState<CurrentTerms | null>(null)
  const [needsAccept, setNeedsAccept] = useState(false)
  // Ref keeps the fetch effect independent of the callback's identity.
  const resolvedRef = useRef(onGateResolved)
  resolvedRef.current = onGateResolved

  useEffect(() => {
    let alive = true
    fetch('/api/terms/current')
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return
        if (!j?.success) { resolvedRef.current?.(); return }
        setTerms(j.data)
        const needs = storefrontNeedsAccept(j.data.minAcceptableVersion) && !wasDismissed()
        setNeedsAccept(needs)
        if (!needs) resolvedRef.current?.()
      })
      .catch(() => { if (alive) resolvedRef.current?.() })
    return () => { alive = false }
  }, [])

  if (!needsAccept || !terms) return null

  const dismiss = () => { rememberDismissed(); setNeedsAccept(false); onGateResolved?.() }

  return (
    <StorefrontTermsGate
      open
      terms={terms}
      brandName={brandName}
      onAccept={() => { recordStorefrontAccept(terms.version); setNeedsAccept(false); onGateResolved?.() }}
      onCancel={dismiss}
    />
  )
}
