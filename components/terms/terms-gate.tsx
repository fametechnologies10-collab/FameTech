'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { useAuth } from '@/contexts/auth-context'
import { needsReacceptance, type CurrentTerms } from '@/lib/terms'
import { TermsAcceptanceModal } from './terms-acceptance-modal'
import { useModalQueueContextSafe } from '@/contexts/modal-queue-context'

// Paths where the gate must never block (public / auth / the terms pages themselves).
const EXCLUDED = ['/auth', '/terms', '/privacy', '/download']

/**
 * Global acceptance gate. Reads the cheap version pointer (passed from the server
 * layout's admin_settings) and the user's accepted version; when the user is
 * behind, lazily loads the full agreement and shows a non-dismissible modal.
 * Accept → records + refreshes dbUser. Decline → sign out.
 */
export function TermsGate({ minVersion, effectiveDate }: { minVersion: string; effectiveDate?: string }) {
  const { dbUser, signOut, refreshUser } = useAuth()
  const pathname = usePathname()
  const [terms, setTerms] = useState<CurrentTerms | null>(null)
  const [busy, setBusy] = useState(false)
  const { register, dismiss } = useModalQueueContextSafe()

  const excluded = !pathname || EXCLUDED.some((p) => pathname.startsWith(p))
  const mustAccept =
    !!dbUser && !excluded && !!minVersion && needsReacceptance(dbUser.terms_accepted_version, minVersion)

  // Lazy-load the full agreement only when we actually need to prompt.
  useEffect(() => {
    if (!mustAccept || terms) return
    let alive = true
    fetch('/api/terms/current')
      .then((r) => r.json())
      .then((j) => { if (alive && j?.success) setTerms(j.data) })
      .catch(() => {})
    return () => { alive = false }
  }, [mustAccept, terms])

  // Take absolute priority in the modal queue: while acceptance is pending this
  // registration makes every other queued modal (system announcement, signup
  // promo, agent expiry) non-active, so the gate is the ONLY modal shown until
  // the user accepts. On accept, mustAccept flips false → dismiss → the queue
  // advances and the announcement/promo can then appear.
  useEffect(() => {
    if (mustAccept) register('TERMS_ACCEPTANCE')
    else dismiss('TERMS_ACCEPTANCE')
    return () => dismiss('TERMS_ACCEPTANCE')
  }, [mustAccept, register, dismiss])

  if (!mustAccept || !terms) return null

  const onAccept = async () => {
    setBusy(true)
    try {
      const r = await fetch('/api/user/accept-terms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: terms.version }),
      })
      const j = await r.json()
      if (j?.success) { await refreshUser() } else { setBusy(false) }
    } catch { setBusy(false) }
  }
  const onDecline = async () => { setBusy(true); await signOut() }

  return (
    <TermsAcceptanceModal
      open
      terms={{ ...terms, effectiveDate: effectiveDate || terms.effectiveDate }}
      busy={busy}
      onAccept={onAccept}
      onDecline={onDecline}
    />
  )
}
