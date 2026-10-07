'use client'

import { useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { X } from 'lucide-react'
import { ToneText } from '@/components/terms/tone-text'
import { sectionsForAudience, type CurrentTerms } from '@/lib/terms'

/**
 * Guest storefront acceptance gate. Same scroll-gated UX as the logged-in modal,
 * but a guest who declines simply cancels the purchase (no sign-out) — they can
 * browse, they just can't buy until they accept.
 */
export function StorefrontTermsGate({
  open, terms, brandName, onAccept, onCancel, blocking = false,
}: {
  open: boolean
  terms: CurrentTerms | null
  brandName: string
  onAccept: () => void
  onCancel: () => void
  /** When true the gate cannot be dismissed by outside-click / Esc / X — used as a
   *  page-load boundary that blocks the storefront until the guest accepts. */
  blocking?: boolean
}) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const [reachedEnd, setReachedEnd] = useState(false)
  const [progress, setProgress] = useState(0)

  const check = () => {
    const el = bodyRef.current
    if (!el) return
    const max = el.scrollHeight - el.clientHeight
    setProgress(max <= 0 ? 100 : Math.min(100, Math.round((el.scrollTop / max) * 100)))
    if (max <= 4 || el.scrollHeight - el.scrollTop - el.clientHeight < 24) setReachedEnd(true)
  }

  useEffect(() => {
    if (!open) { setReachedEnd(false); setProgress(0); return }
    const el = bodyRef.current
    if (!el) return
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, terms])

  if (!terms) return null

  // Storefront audience: buyer-relevant sections only, {{brand}} → shop name.
  const rows = sectionsForAudience(terms.sections, { storefront: true, brand: brandName })

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !blocking) onCancel() }}>
      <DialogContent
        hideCloseButton
        onEscapeKeyDown={blocking ? (e) => e.preventDefault() : undefined}
        onInteractOutside={blocking ? (e) => e.preventDefault() : undefined}
        onPointerDownOutside={blocking ? (e) => e.preventDefault() : undefined}
        className="p-0 gap-0 w-full sm:max-w-md max-h-[92dvh] overflow-hidden rounded-t-[2.5rem] sm:rounded-[2.5rem] border border-white/10 bg-white dark:bg-gray-950"
      >
        {/* Header */}
        <div className="relative bg-gradient-to-br from-amber-400 via-amber-500 to-orange-500 px-6 pt-5 pb-6 text-white">
          <div className="sm:hidden w-10 h-1 rounded-full bg-white/50 mx-auto mb-3" />
          {!blocking && (
            <button
              onClick={onCancel}
              aria-label="Close"
              className="absolute right-3 top-4 w-9 h-9 rounded-full bg-black/15 hover:bg-black/25 flex items-center justify-center"
            >
              <X className="w-4 h-4" />
            </button>
          )}
          <span className="inline-block bg-black/20 border border-white/30 rounded-full px-2.5 py-0.5 text-[10px] font-black uppercase tracking-widest">
            Before You Buy
          </span>
          <DialogTitle className="mt-2 text-xl font-black tracking-tight">Terms &amp; Conditions</DialogTitle>
          <p className="text-[12.5px] font-bold text-white/90">
            Effective {terms.effectiveDate} · version {terms.version}
          </p>
        </div>

        {/* Scroll progress */}
        <div className="h-1 bg-gray-100 dark:bg-gray-800">
          <div
            className="h-full bg-gradient-to-r from-amber-400 to-orange-500 transition-[width] duration-150"
            style={{ width: `${progress}%` }}
          />
        </div>

        {/* Body */}
        <div
          ref={bodyRef}
          onScroll={check}
          className="overflow-y-auto max-h-[44vh] px-6 py-5 overscroll-contain scroll-smooth kfg-scrollbar"
        >
          {rows.map((s, i) => (
            <div key={s.id} className="mb-5">
              <h3 className="text-[15px] font-black text-gray-900 dark:text-white tracking-tight mb-1">
                {i + 1}. {s.title}
                {s.badge ? (
                  <span className="ml-2 align-middle text-[9px] font-black uppercase tracking-wide text-yellow-600 border border-yellow-600 rounded px-1.5 py-0.5">
                    {s.badge}
                  </span>
                ) : null}
              </h3>
              <p className="text-[13.5px] leading-relaxed text-gray-700 dark:text-gray-300">
                <ToneText text={s.body} />
              </p>
            </div>
          ))}
          <p className="text-center text-[11.5px] text-gray-400 pt-1">
            Need help? Use this shop's <span className="font-semibold">Need Help</span> or WhatsApp contact.
          </p>
        </div>

        {/* Footer */}
        <div className="border-t border-gray-100 dark:border-gray-800 bg-gray-50/80 dark:bg-gray-900/40 px-5 pt-3 pb-[calc(16px+env(safe-area-inset-bottom,0px))]">
          {!reachedEnd && (
            <p className="text-center text-[11.5px] text-gray-500 mb-2">▼ Scroll to the end to enable Accept</p>
          )}
          <div className="flex gap-2.5">
            <button
              onClick={onCancel}
              className="flex-1 h-11 rounded-xl font-bold border border-gray-200 dark:border-gray-700"
            >
              Decline
            </button>
            <button
              onClick={onAccept}
              disabled={!reachedEnd}
              className="flex-1 h-11 rounded-xl font-black bg-[#FFCC00] text-black transition disabled:opacity-45 disabled:grayscale"
            >
              I Accept &amp; Continue
            </button>
          </div>
        </div>

        <style jsx global>{`
          .kfg-scrollbar::-webkit-scrollbar { width: 5px; }
          .kfg-scrollbar::-webkit-scrollbar-thumb { background: rgba(156,163,175,.35); border-radius: 10px; }
        `}</style>
      </DialogContent>
    </Dialog>
  )
}
