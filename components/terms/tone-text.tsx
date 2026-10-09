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

// Darker tones for the FameTech clay surfaces (>= 4.5:1 on #E6ECF5 and #0F1626).
const TONE_CLASS_FT: Record<Exclude<TermsTone, 'none'>, string> = {
  red:   'text-red-700 dark:text-red-300 font-semibold',
  amber: 'text-amber-800 dark:text-amber-300 font-semibold',
  gold:  'text-yellow-800 dark:text-yellow-300 font-semibold',
  green: 'text-emerald-800 dark:text-emerald-300 font-semibold',
  u:     'underline decoration-2 underline-offset-2 decoration-amber-800 dark:decoration-amber-300 font-semibold',
}

/** Renders terms body text with inline [[tone: …]] markup as styled spans. */
export function ToneText({ text, variant = 'default' }: { text: string; variant?: 'default' | 'ft' }) {
  const classes = variant === 'ft' ? TONE_CLASS_FT : TONE_CLASS
  const runs = parseToneMarkup(text)
  return (
    <>
      {runs.map((r, i) =>
        r.tone === 'none'
          ? <span key={i}>{r.text}</span>
          : <span key={i} className={classes[r.tone]}>{r.text}</span>
      )}
    </>
  )
}
