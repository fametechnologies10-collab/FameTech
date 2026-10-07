'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { StorefrontTermsGate } from './StorefrontTermsGate'
import { storefrontNeedsAccept, recordStorefrontAccept } from '@/lib/storefront-terms'
import type { CurrentTerms } from '@/lib/terms'

/**
 * Page-load acceptance boundary for shop storefronts. On the first visit (per browser),
 * it mounts a BLOCKING gate over the storefront — the same way the dashboard's TermsGate
 * blocks the main site — until the guest accepts the current agreement. Already-accepted
 * guests never see it (the check is false, so nothing renders / no flash). Decline leaves.
 */
export function StorefrontTermsBoundary({
  brandName,
  onGateResolved,
}: {
  brandName: string
  /** Fires once the gate is out of the way — guest already accepted, the check
   *  failed (fail-open, no gate renders), or the guest accepts. Lets the
   *  storefront hold other popups (announcements) until the agreement is dealt
   *  with, mirroring the dashboard's TERMS_ACCEPTANCE modal-queue priority. */
  onGateResolved?: () => void
}) {
  const router = useRouter()
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
        const needs = storefrontNeedsAccept(j.data.minAcceptableVersion)
        setNeedsAccept(needs)
        if (!needs) resolvedRef.current?.()
      })
      .catch(() => { if (alive) resolvedRef.current?.() })
    return () => { alive = false }
  }, [])

  if (!needsAccept || !terms) return null

  return (
    <StorefrontTermsGate
      open
      blocking
      terms={terms}
      brandName={brandName}
      onAccept={() => { recordStorefrontAccept(terms.version); setNeedsAccept(false); onGateResolved?.() }}
      onCancel={() => { router.back() }}
    />
  )
}
