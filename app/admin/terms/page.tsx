'use client'

import { useEffect, useState } from 'react'
import { ToneText } from '@/components/terms/tone-text'
import { renderBrand, PLATFORM_BRAND } from '@/lib/terms'
import { Plus, Trash2, Save, Eye, ShieldCheck } from 'lucide-react'

interface Section { id: string; title: string; body: string; badge?: string; scope?: 'all' | 'dashboard'; storefront?: string }
interface Version {
  id: string; version: string; effective_date: string; sections: Section[]
  changelog: { version: string; date: string; summary: string[] }[]
  requires_reacceptance: boolean; is_current: boolean; published_at: string | null
}

const CHEATSHEET = '[[red: prohibited]] · [[amber: caution]] · [[gold: important]] · [[green: reassurance]] · [[u: key term]]'

export default function AdminTermsPage() {
  const [versions, setVersions] = useState<Version[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  // Editor state
  const [version, setVersion] = useState('')
  const [effectiveDate, setEffectiveDate] = useState('')
  const [effectiveLabel, setEffectiveLabel] = useState('')
  const [requires, setRequires] = useState(true)
  const [changelog, setChangelog] = useState('')
  const [sections, setSections] = useState<Section[]>([])

  const loadInto = (v: Version) => {
    setVersion(v.version)
    setEffectiveDate(v.effective_date)
    setEffectiveLabel(v.changelog?.[0]?.date || v.effective_date)
    setRequires(v.requires_reacceptance)
    setChangelog((v.changelog?.[0]?.summary || []).join('\n'))
    setSections(v.sections || [])
  }

  const load = async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/admin/terms')
      const j = await r.json()
      if (j?.success) {
        setVersions(j.data)
        const cur = j.data.find((v: Version) => v.is_current) || j.data[0]
        if (cur) loadInto(cur)
      }
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  const updateSection = (i: number, patch: Partial<Section>) =>
    setSections((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)))
  const addSection = () =>
    setSections((prev) => [...prev, { id: `section-${prev.length + 1}`, title: 'New section', body: '' }])
  const removeSection = (i: number) => setSections((prev) => prev.filter((_, idx) => idx !== i))

  const publish = async () => {
    setSaving(true); setMsg(null)
    try {
      const summary = changelog.split('\n').map((l) => l.trim()).filter(Boolean)
      const r = await fetch('/api/admin/terms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: version.trim(),
          effective_date: effectiveDate,
          effective_date_label: effectiveLabel,
          requires_reacceptance: requires,
          changelog: [{ version: version.trim(), date: effectiveLabel, summary }],
          sections,
        }),
      })
      const j = await r.json()
      if (j?.success) {
        setMsg({ ok: true, text: `Published v${j.data.version}${j.data.requires_reacceptance ? ' — all users must re-accept' : ' (minor update, no re-prompt)'}` })
        await load()
      } else {
        setMsg({ ok: false, text: j?.error || 'Failed to publish' })
      }
    } catch {
      setMsg({ ok: false, text: 'Network error' })
    } finally { setSaving(false) }
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center text-white">
          <ShieldCheck className="w-5 h-5" />
        </div>
        <div>
          <h1 className="text-xl font-black tracking-tight text-gray-900 dark:text-white">Terms Manager</h1>
          <p className="text-xs text-gray-500 dark:text-gray-400">Edit and publish the agreement — no redeploy needed.</p>
        </div>
      </div>

      {msg && (
        <div className={`rounded-xl px-4 py-3 text-sm font-medium ${msg.ok ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' : 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300'}`}>
          {msg.text}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : (
        <div className="grid lg:grid-cols-2 gap-6">
          {/* Editor */}
          <div className="space-y-4">
            <div className="rounded-2xl border border-gray-200 dark:border-gray-800 p-4 space-y-3 bg-white dark:bg-gray-950">
              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs font-bold text-gray-600 dark:text-gray-300">Version (YYYY-MM-DD)
                  <input value={version} onChange={(e) => setVersion(e.target.value)}
                    className="mt-1 w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent px-2 text-sm" placeholder="2026-07-03" />
                </label>
                <label className="text-xs font-bold text-gray-600 dark:text-gray-300">Effective date
                  <input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)}
                    className="mt-1 w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent px-2 text-sm" />
                </label>
              </div>
              <label className="text-xs font-bold text-gray-600 dark:text-gray-300 block">Effective date label (shown to users)
                <input value={effectiveLabel} onChange={(e) => setEffectiveLabel(e.target.value)}
                  className="mt-1 w-full h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent px-2 text-sm" placeholder="July 3, 2026" />
              </label>
              <label className="flex items-center gap-2 text-xs font-bold text-gray-700 dark:text-gray-200">
                <input type="checkbox" checked={requires} onChange={(e) => setRequires(e.target.checked)} className="w-4 h-4 accent-amber-500" />
                Requires re-acceptance (force every user to re-accept — leave OFF for a minor fix)
              </label>
              <label className="text-xs font-bold text-gray-600 dark:text-gray-300 block">What changed (one line each)
                <textarea value={changelog} onChange={(e) => setChangelog(e.target.value)} rows={3}
                  className="mt-1 w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent px-2 py-1.5 text-sm" />
              </label>
              <p className="text-[11px] text-gray-400">Highlight markup: <code className="text-[10px]">{CHEATSHEET}</code></p>
            </div>

            <div className="space-y-3">
              {sections.map((s, i) => (
                <div key={i} className="rounded-2xl border border-gray-200 dark:border-gray-800 p-3 space-y-2 bg-white dark:bg-gray-950">
                  <div className="flex gap-2">
                    <input value={s.title} onChange={(e) => updateSection(i, { title: e.target.value })}
                      className="flex-1 h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent px-2 text-sm font-bold" placeholder="Section title" />
                    <input value={s.badge || ''} onChange={(e) => updateSection(i, { badge: e.target.value || undefined })}
                      className="w-24 h-9 rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent px-2 text-xs" placeholder="Badge" />
                    <button onClick={() => removeSection(i)} className="w-9 h-9 rounded-lg border border-gray-200 dark:border-gray-700 flex items-center justify-center text-red-500" aria-label="Remove section">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                  <input value={s.id} onChange={(e) => updateSection(i, { id: e.target.value })}
                    className="w-full h-8 rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent px-2 text-[11px] text-gray-500" placeholder="id (stable slug)" />
                  <textarea value={s.body} onChange={(e) => updateSection(i, { body: e.target.value })} rows={4}
                    className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent px-2 py-1.5 text-sm" placeholder="Body text with [[tone: …]] markup" />
                  <label className="flex items-center gap-2 text-[11px] font-bold text-gray-600 dark:text-gray-300">
                    <input type="checkbox" checked={s.scope !== 'dashboard'} onChange={(e) => updateSection(i, { scope: e.target.checked ? 'all' : 'dashboard' })} className="w-3.5 h-3.5 accent-emerald-500" />
                    Show on shop storefronts
                  </label>
                  {s.scope !== 'dashboard' && (
                    <textarea value={s.storefront || ''} onChange={(e) => updateSection(i, { storefront: e.target.value || undefined })} rows={3}
                      className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent px-2 py-1.5 text-[12px]"
                      placeholder="Storefront wording (optional — shop-facing version; {{brand}} = shop name)" />
                  )}
                </div>
              ))}
              <button onClick={addSection} className="w-full h-10 rounded-xl border border-dashed border-gray-300 dark:border-gray-700 text-sm font-bold text-gray-600 dark:text-gray-300 flex items-center justify-center gap-2">
                <Plus className="w-4 h-4" /> Add section
              </button>
            </div>

            <button onClick={publish} disabled={saving}
              className="w-full h-12 rounded-xl bg-[#FFCC00] text-black font-black flex items-center justify-center gap-2 disabled:opacity-50">
              <Save className="w-4 h-4" /> {saving ? 'Publishing…' : 'Publish'}
            </button>
          </div>

          {/* Live preview */}
          <div className="space-y-4">
            <div className="rounded-2xl border border-gray-200 dark:border-gray-800 overflow-hidden bg-white dark:bg-gray-950 sticky top-20">
              <div className="bg-gradient-to-br from-amber-400 via-amber-500 to-orange-500 px-5 py-4 text-white flex items-center gap-2">
                <Eye className="w-4 h-4" />
                <div>
                  <p className="font-black text-sm">Live preview</p>
                  <p className="text-[11px] text-white/90">Effective {effectiveLabel || effectiveDate} · v{version}</p>
                </div>
              </div>
              <div className="max-h-[60vh] overflow-y-auto px-5 py-4 space-y-4">
                {sections.map((s, i) => (
                  <div key={i}>
                    <h3 className="text-sm font-black text-gray-900 dark:text-white mb-1">
                      {i + 1}. {renderBrand(s.title, PLATFORM_BRAND)}
                      {s.badge ? <span className="ml-2 text-[9px] font-black uppercase text-yellow-600 border border-yellow-600 rounded px-1.5 py-0.5">{s.badge}</span> : null}
                      {s.scope === 'dashboard' ? <span className="ml-2 text-[9px] font-bold uppercase text-gray-400 border border-gray-300 dark:border-gray-600 rounded px-1.5 py-0.5">dashboard only</span> : null}
                    </h3>
                    <p className="text-[13px] leading-relaxed text-gray-700 dark:text-gray-300"><ToneText text={renderBrand(s.body, PLATFORM_BRAND)} /></p>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-gray-200 dark:border-gray-800 p-4 bg-white dark:bg-gray-950">
              <p className="text-xs font-bold text-gray-600 dark:text-gray-300 mb-2">Published versions</p>
              <ul className="space-y-1.5">
                {versions.map((v) => (
                  <li key={v.id}>
                    <button onClick={() => loadInto(v)} className="w-full flex items-center justify-between text-left text-xs px-2 py-1.5 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-900">
                      <span className="font-mono">{v.version}</span>
                      <span className="flex items-center gap-2">
                        {v.requires_reacceptance ? <span className="text-amber-600">re-accept</span> : <span className="text-gray-400">minor</span>}
                        {v.is_current ? <span className="text-[10px] font-black uppercase text-emerald-600 bg-emerald-50 dark:bg-emerald-500/10 rounded px-1.5 py-0.5">current</span> : null}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
