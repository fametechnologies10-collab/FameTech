'use client'

import { useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { ToneText } from './tone-text'
import { sectionsForAudience, PLATFORM_BRAND, type CurrentTerms } from '@/lib/terms'

/**
 * Non-dismissible, scroll-gated Terms acceptance modal.
 * - Accept is disabled until the user scrolls to the bottom.
 * - Auto-enables when the content is too short to scroll (short-content + resize fallback).
 * - Decline shows a confirm step (the caller decides what "decline" does).
 */
export function TermsAcceptanceModal({
  open, terms, busy, onAccept, onDecline,
}: {
  open: boolean
  terms: CurrentTerms
  busy: boolean
  onAccept: () => void
  onDecline: () => void
}) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const [reachedEnd, setReachedEnd] = useState(false)
  const [progress, setProgress] = useState(0)
  const [confirmDecline, setConfirmDecline] = useState(false)

  const check = () => {
    const el = bodyRef.current
    if (!el) return
    const max = el.scrollHeight - el.clientHeight
    setProgress(max <= 0 ? 100 : Math.min(100, Math.round((el.scrollTop / max) * 100)))
    // Wider tolerance than a bare scroll-event threshold — momentum/rubber-band
    // scrolling on touch devices can settle a few px short of the true bottom.
    if (max <= 4 || el.scrollHeight - el.scrollTop - el.clientHeight < 48) setReachedEnd(true)
  }

  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    // Address-bar collapse/expand and on-screen-keyboard open/close resize the
    // visual viewport without necessarily firing a scroll event on the body —
    // recheck whenever that happens too.
    const vv = window.visualViewport
    window.addEventListener('resize', check)
    vv?.addEventListener('resize', check)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', check)
      vv?.removeEventListener('resize', check)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terms])

  // Dashboard audience: all sections, {{brand}} → platform name.
  const rows = sectionsForAudience(terms.sections, { storefront: false, brand: PLATFORM_BRAND })

  return (
    <Dialog open={open}>
      <DialogContent
        hideCloseButton
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        className="p-0 gap-0 w-full sm:max-w-md max-h-[92dvh] overflow-hidden rounded-t-[2.5rem] sm:rounded-[2.5rem] border border-white/10 bg-white dark:bg-gray-950"
      >
        {/* Header */}
        <div className="bg-gradient-to-br from-amber-400 via-amber-500 to-orange-500 px-6 pt-5 pb-6 text-white">
          <div className="sm:hidden w-10 h-1 rounded-full bg-white/50 mx-auto mb-3" />
          <span className="inline-block bg-black/20 border border-white/30 rounded-full px-2.5 py-0.5 text-[10px] font-black uppercase tracking-widest">
            Updated Agreement
          </span>
          <DialogTitle className="mt-2 text-xl font-black tracking-tight">Terms &amp; Conditions</DialogTitle>
          <p className="text-[12.5px] font-bold text-white/90">
            Effective {terms.effectiveDate} · version {terms.version}
          </p>
        </div>

        {terms.changelog?.[0]?.summary?.length ? (
          <div className="bg-amber-50 dark:bg-amber-500/10 border-b border-amber-100 dark:border-amber-500/20 px-6 py-2.5 text-[12px] text-amber-800 dark:text-amber-200">
            <b className="font-black">What changed:</b> {terms.changelog[0].summary.join(' · ')}
          </div>
        ) : null}

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
          className="overflow-y-auto max-h-[46vh] px-6 py-5 overscroll-contain scroll-smooth kfg-scrollbar"
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
          <p className="text-center text-[11.5px] text-gray-400 pt-1">— end of agreement —</p>
        </div>

        {/* Footer */}
        <div className="border-t border-gray-100 dark:border-gray-800 bg-gray-50/80 dark:bg-gray-900/40 px-5 pt-3 pb-[calc(16px+env(safe-area-inset-bottom,0px))]">
          {!reachedEnd && (
            <button
              type="button"
              onClick={() => {
                const el = bodyRef.current
                if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
                // Scrolling programmatically guarantees the end state even if
                // the resulting scroll event is throttled/missed on this device.
                setReachedEnd(true)
              }}
              className="w-full text-center text-[11.5px] text-amber-700 dark:text-amber-400 font-bold mb-2 underline underline-offset-2"
            >
              ▼ Tap to jump to the end and enable Accept
            </button>
          )}
          {confirmDecline ? (
            <div className="text-center">
              <p className="text-[12.5px] text-gray-700 dark:text-gray-300 mb-2 font-medium">
                You'll be signed out and can't use your account until you accept. Continue?
              </p>
              <div className="flex gap-2.5">
                <button
                  onClick={() => setConfirmDecline(false)}
                  className="flex-1 h-11 rounded-xl font-bold border border-gray-200 dark:border-gray-700"
                >
                  Go back
                </button>
                <button
                  onClick={onDecline}
                  disabled={busy}
                  className="flex-1 h-11 rounded-xl font-bold bg-red-600 text-white disabled:opacity-60"
                >
                  Sign out
                </button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2.5">
              <button
                onClick={() => setConfirmDecline(true)}
                disabled={busy}
                className="flex-1 h-11 rounded-xl font-bold border border-gray-200 dark:border-gray-700"
              >
                Decline
              </button>
              <button
                onClick={onAccept}
                disabled={!reachedEnd || busy}
                className="flex-1 h-11 rounded-xl font-black bg-[#FFCC00] text-black transition disabled:opacity-45 disabled:grayscale"
              >
                {busy ? 'Saving…' : 'I Accept'}
              </button>
            </div>
          )}
        </div>

        <style jsx global>{`
          .kfg-scrollbar::-webkit-scrollbar { width: 5px; }
          .kfg-scrollbar::-webkit-scrollbar-thumb { background: rgba(156,163,175,.35); border-radius: 10px; }
        `}</style>
      </DialogContent>
    </Dialog>
  )
}
