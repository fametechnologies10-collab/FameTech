'use client'

import { useCallback, useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/lib/toast'
import { OVERRIDE_CHANNELS, type OverrideRow } from '@/lib/gateway-override-shared'

const URL_PATH = '/api/admin/gateway-status/override'

const LABELS: Record<string, string> = {
    MTN: 'MTN',
    Telecel: 'Telecel',
    'AT-iShare': 'AT-iShare',
    'AT-BigTime': 'AT-BigTime',
    standard_bundles: 'Standard Bundles',
}

interface Draft { down: boolean; reason: string }

function fmt(iso: string | null): string | null {
    if (!iso) return null
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? null : d.toLocaleString()
}

function OverrideRowView({ channel, saved, busy, onApply }: {
    channel: string
    saved: OverrideRow | undefined
    busy: boolean
    onApply: (channel: string, draft: Draft) => void
}) {
    const label = LABELS[channel] ?? channel
    const savedDown = saved?.is_manually_down ?? false
    const savedReason = saved?.reason ?? ''
    const [draft, setDraft] = useState<Draft>({ down: savedDown, reason: savedReason })

    // Re-sync the draft whenever the saved row changes (initial load, after a successful apply).
    useEffect(() => {
        setDraft({ down: savedDown, reason: savedReason })
    }, [savedDown, savedReason])

    const unchanged = draft.down === savedDown && draft.reason.trim() === savedReason.trim()
    const since = savedDown ? fmt(saved?.since ?? null) : null
    const updated = fmt(saved?.updated_at ?? null)

    return (
        <div className="rounded-lg border bg-background p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold">{label}</span>
                <button
                    type="button"
                    role="switch"
                    aria-checked={draft.down}
                    aria-label={`Mark ${label} as experiencing delays`}
                    disabled={busy}
                    onClick={() => setDraft(d => ({ ...d, down: !d.down }))}
                    className="inline-flex h-11 min-w-11 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                    <span className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${draft.down ? 'bg-destructive' : 'bg-muted'}`}>
                        <span className={`inline-block h-5 w-5 rounded-full bg-background shadow transition-transform ${draft.down ? 'translate-x-5' : 'translate-x-0.5'}`} />
                    </span>
                </button>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                    value={draft.reason}
                    maxLength={200}
                    disabled={!draft.down || busy}
                    placeholder="Reason (admins only, optional)"
                    aria-label={`Reason for ${label} (admins only)`}
                    onChange={e => setDraft(d => ({ ...d, reason: e.target.value }))}
                    className="h-11 sm:h-10"
                />
                <Button
                    type="button"
                    size="sm"
                    className="h-11 sm:h-10"
                    disabled={unchanged || busy}
                    onClick={() => onApply(channel, draft)}
                >
                    {busy ? 'Saving...' : 'Apply'}
                </Button>
            </div>
            {savedDown && (
                <p className="text-xs text-muted-foreground">
                    {since ? `Marked down since ${since}` : 'Marked down'}
                    {savedReason ? ` - ${savedReason}` : ''}
                </p>
            )}
            {updated && <p className="text-[11px] text-muted-foreground/70">Updated {updated}</p>}
        </div>
    )
}

export function GatewayOverrideCard() {
    const [rows, setRows] = useState<Record<string, OverrideRow>>({})
    const [loading, setLoading] = useState(true)
    const [loadError, setLoadError] = useState(false)
    const [busy, setBusy] = useState<Record<string, boolean>>({})

    const load = useCallback(async () => {
        setLoading(true)
        setLoadError(false)
        try {
            const res = await fetch(URL_PATH, { method: 'GET', credentials: 'same-origin', cache: 'no-store' })
            const json = await res.json().catch(() => null)
            if (!res.ok || !json?.success || !Array.isArray(json.data)) throw new Error('load failed')
            const next: Record<string, OverrideRow> = {}
            for (const r of json.data as OverrideRow[]) next[r.channel] = r
            setRows(next)
        } catch {
            setLoadError(true)
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { void load() }, [load])

    const apply = useCallback(async (channel: string, draft: Draft) => {
        const label = LABELS[channel] ?? channel
        setBusy(b => ({ ...b, [channel]: true }))
        try {
            const reason = draft.reason.trim()
            const res = await fetch(URL_PATH, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ channel, down: draft.down, ...(reason ? { reason } : {}) }),
            })
            const json = await res.json().catch(() => null)
            if (!res.ok || !json?.success || !json.data) {
                const msg = typeof json?.error === 'string' && json.error.length <= 120 ? json.error : 'Could not update. Try again.'
                toast.error(msg)
                return
            }
            setRows(r => ({ ...r, [channel]: json.data as OverrideRow }))
            toast.success(`${label} updated`)
        } catch {
            toast.error('Could not update. Try again.')
        } finally {
            setBusy(b => ({ ...b, [channel]: false }))
        }
    }, [])

    return (
        <Card className="rounded-xl border bg-card">
            <CardHeader className="pb-3">
                <CardTitle className="text-base">Dashboard network status</CardTitle>
                <p className="text-xs md:text-sm text-muted-foreground">
                    Mark a network as experiencing delays on customer dashboards. Customers see only &lsquo;Experiencing delays&rsquo;; the reason below is for admins.
                </p>
            </CardHeader>
            <CardContent>
                {loading ? (
                    <div className="grid gap-3 md:grid-cols-2" aria-busy="true">
                        {OVERRIDE_CHANNELS.map(c => (
                            <div key={c} className="h-24 rounded-lg bg-muted motion-safe:animate-pulse" />
                        ))}
                    </div>
                ) : loadError ? (
                    <div className="flex flex-wrap items-center gap-3">
                        <p role="alert" className="text-sm text-destructive">Could not load network status overrides.</p>
                        <Button type="button" variant="outline" size="sm" onClick={() => void load()}>Retry</Button>
                    </div>
                ) : (
                    <div className="grid gap-3 md:grid-cols-2">
                        {OVERRIDE_CHANNELS.map(c => (
                            <OverrideRowView key={c} channel={c} saved={rows[c]} busy={!!busy[c]} onApply={apply} />
                        ))}
                    </div>
                )}
            </CardContent>
        </Card>
    )
}
