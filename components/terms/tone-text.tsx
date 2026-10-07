import { parseToneMarkup } from '@/lib/terms-markup'
import type { TermsTone } from '@/lib/terms'

// Colors chosen for readable contrast in BOTH light and dark themes.
// Weight-600 only, applied to short key phrases (per the "small portion" rule).
const TONE_CLASS: Record<Exclude<TermsTone, 'none'>, string> = {
  red:   'text-red-600 dark:text-red-400 font-semibold',
  amber: 'text-amber-600 dark:text-amber-400 font-semibold',
  gold:  'text-yellow-600 dark:text-yellow-400 font-semibold',
  green: 'text-emerald-600 dark:text-emerald-400 font-semibold',
  u:     'underline decoration-2 underline-offset-2 decoration-amber-500 font-semibold',
}

/** Renders terms body text with inline [[tone: …]] markup as styled spans. */
export function ToneText({ text }: { text: string }) {
  const runs = parseToneMarkup(text)
  return (
    <>
      {runs.map((r, i) =>
        r.tone === 'none'
          ? <span key={i}>{r.text}</span>
          : <span key={i} className={TONE_CLASS[r.tone]}>{r.text}</span>
      )}
    </>
  )
}
