'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ToneText } from './tone-text'
import { sectionsForAudience, type TermsSection } from '@/lib/terms'

/**
 * Renders the current platform agreement from the single DB source (/api/terms/current).
 * Drop-in for any storefront/shop page so all surfaces stay in sync with one edit in
 * the Admin Terms Manager. Works in both server and client pages (it's a client component).
 */
export function TermsSectionsLive({ className, brandName = 'this store' }: { className?: string; brandName?: string }) {
  const [data, setData] = useState<{ sections: TermsSection[]; effectiveDate: string } | null>(null)

  useEffect(() => {
    let alive = true
    fetch('/api/terms/current')
      .then((r) => r.json())
      .then((j) => { if (alive && j?.success) setData({ sections: j.data.sections, effectiveDate: j.data.effectiveDate }) })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  if (!data) {
    return <p className="text-sm text-gray-400 dark:text-gray-500">Loading terms…</p>
  }

  // Storefront audience: buyer-relevant sections only, {{brand}} → shop name.
  const rows = sectionsForAudience(data.sections, { storefront: true, brand: brandName })

  return (
    <div className={className ?? 'space-y-6'}>
      {rows.map((s, i) => (
        <div key={s.id}>
          <h3 className="text-sm font-black text-gray-900 dark:text-white mb-1">
            {i + 1}. {s.title}
            {s.badge ? (
              <span className="ml-2 align-middle text-[9px] font-black uppercase tracking-wide text-yellow-600 border border-yellow-600 rounded px-1.5 py-0.5">
                {s.badge}
              </span>
            ) : null}
          </h3>
          <p className="text-sm font-medium text-gray-500 dark:text-gray-400 leading-relaxed">
            <ToneText text={s.body} />
          </p>
        </div>
      ))}
      <p className="text-xs text-gray-400 pt-2">
        Last updated: {data.effectiveDate} ·{' '}
        <Link href="/terms" className="underline hover:text-gray-600 dark:hover:text-gray-300">Full terms</Link>
      </p>
    </div>
  )
}
