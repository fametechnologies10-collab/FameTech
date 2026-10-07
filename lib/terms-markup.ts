import type { TermsTone } from './terms'

export interface ToneRun {
  text: string
  tone: TermsTone
}

const VALID: ReadonlySet<string> = new Set(['red', 'amber', 'gold', 'green', 'u'])
// Matches [[tone: content]] with a valid tone and non-greedy content.
const TOKEN = /\[\[(red|amber|gold|green|u):\s?([\s\S]*?)\]\]/g

/**
 * Parses inline tone markup into styled runs. Safe by construction — only a fixed
 * set of tone tokens is recognised; unknown tones or unclosed tokens are left as
 * literal text, so admin-authored content can never inject arbitrary HTML.
 */
export function parseToneMarkup(input: string): ToneRun[] {
  if (!input) return []
  const runs: ToneRun[] = []
  let last = 0
  for (const m of input.matchAll(TOKEN)) {
    const tone = m[1] as TermsTone
    if (!VALID.has(tone)) continue
    const start = m.index ?? 0
    if (start > last) runs.push({ text: input.slice(last, start), tone: 'none' })
    runs.push({ text: m[2], tone })
    last = start + m[0].length
  }
  if (last < input.length) runs.push({ text: input.slice(last), tone: 'none' })
  return runs
}
