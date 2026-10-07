'use client'

// ─── MTN whitelist checker ──────────────────────────────────────────────────────
//
// MTN delivery is gated behind a per-account whitelist: only enabled numbers can receive
// data. Checking a number that is NOT enabled automatically submits it to MTN for enabling
// (no fixed turnaround, no automatic retry) — so from the customer's point of view this is one
// action: "check, and register me if I'm not registered yet".
//
// The user picks "Server 1" or "Server 2" and each check queries only that server, so they can
// see which one a number is registered on. The labels are deliberately generic — never show
// supplier names in this UI. Both servers submit an unregistered number for registration.
//
// Two surfaces share this file so the wording and result semantics can never drift:
//   • MtnWhitelistInlineCheck — guest storefront, one number.
//   • MtnWhitelistChecker     — signed-in dashboard, single or bulk up to 1000.
//
// All validation is re-done server-side (lib/agentportal-whitelist.ts). The client-side
// parsing here is purely for a responsive count/preview — it is never trusted.

import { useCallback, useMemo, useRef, useState } from 'react'
import {
    ShieldCheck, Loader2, CheckCircle2, Clock, AlertCircle, X, Upload,
    Copy, Download, ChevronDown, Search,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { toast } from '@/lib/toast'

export const MAX_BULK_NUMBERS = 1000

/** Rows beyond this are still counted and still in the CSV — just not painted into the DOM. */
const MAX_RENDERED_ROWS = 300

interface WhitelistResult {
    input: string
    normalized: string
    allowed: boolean
}

interface InvalidEntry {
    input: string
    reason: string
}

interface CheckData {
    results: WhitelistResult[]
    invalid: InvalidEntry[]
    allowed_count: number
    total: number
    checked: number
}

/**
 * Splits pasted/uploaded text into candidate entries.
 *
 * Splits on newlines, commas, semicolons and tabs — but NOT on spaces, since "024 100 0001"
 * is a single number a user may legitimately paste. Server-side normalization is the
 * authority on what actually counts as valid.
 */
export function parseNumberList(text: string): string[] {
    return text
        .split(/[\n\r,;\t]+/)
        .map(s => s.trim())
        .filter(Boolean)
}

type Server = 1 | 2

async function postCheck(msisdns: string[], server: Server): Promise<CheckData> {
    const response = await fetch('/api/mtn-whitelist/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msisdns, server }),
    })

    let payload: { success?: boolean; error?: string; data?: CheckData } | null = null
    try {
        payload = await response.json()
    } catch {
        throw new Error('The whitelist service returned an unreadable response.')
    }

    if (!response.ok || !payload?.success || !payload.data) {
        throw new Error(payload?.error || 'Could not check that number right now.')
    }
    return payload.data
}

function useWhitelistCheck() {
    const [loading, setLoading] = useState(false)
    const [data, setData] = useState<CheckData | null>(null)
    const [dataServer, setDataServer] = useState<Server>(1)
    const [error, setError] = useState<string | null>(null)

    const run = useCallback(async (msisdns: string[], server: Server) => {
        setLoading(true)
        setError(null)
        setData(null)
        try {
            const result = await postCheck(msisdns, server)
            setDataServer(server)
            setData(result)
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
        } finally {
            setLoading(false)
        }
    }, [])

    const reset = useCallback(() => { setData(null); setError(null) }, [])

    return { loading, data, dataServer, error, run, reset }
}

function ServerTabs({ server, onChange }: { server: Server; onChange: (server: Server) => void }) {
    return (
        <div className="flex bg-muted rounded-xl p-1 gap-1" role="tablist" aria-label="Choose a server to check">
            {([1, 2] as const).map(s => (
                <button
                    key={s}
                    role="tab"
                    aria-selected={server === s}
                    onClick={() => onChange(s)}
                    className={cn(
                        'flex-1 py-2 text-sm font-semibold rounded-lg transition-all duration-150',
                        server === s ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                    )}
                >
                    Server {s}
                </button>
            ))}
        </div>
    )
}

// ─── Inline (storefront, guest, one number) ─────────────────────────────────────

/**
 * Compact MTN-only checker for the storefront. Collapsed by default so it never competes
 * with the packages the guest actually came to buy.
 */
export function MtnWhitelistInlineCheck() {
    const [expanded, setExpanded] = useState(false)
    const [value, setValue] = useState('')
    const [server, setServer] = useState<Server>(1)
    const { loading, data, dataServer, error, run, reset } = useWhitelistCheck()
    const inputRef = useRef<HTMLInputElement>(null)

    const result = data?.results[0] ?? null
    const invalid = data?.invalid[0] ?? null

    const submit = () => {
        const entries = parseNumberList(value)
        if (entries.length === 0) {
            toast.error('Enter your MTN number first')
            return
        }
        run(entries.slice(0, 1), server)
    }

    const toggle = () => {
        const next = !expanded
        setExpanded(next)
        if (next) {
            // Double rAF keeps the focus inside the original gesture chain — a setTimeout
            // here drops the keyboard on iOS.
            requestAnimationFrame(() => requestAnimationFrame(() => inputRef.current?.focus()))
        }
    }

    return (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
            <button
                onClick={toggle}
                aria-expanded={expanded}
                className="w-full flex items-center gap-2.5 p-3 text-left hover:bg-muted/50 transition-colors"
            >
                <span className="flex-shrink-0 w-8 h-8 rounded-lg bg-amber-400/15 flex items-center justify-center">
                    <ShieldCheck className="w-4 h-4 text-amber-600" />
                </span>
                <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-foreground">Check your MTN number</span>
                    <span className="block text-xs text-muted-foreground mt-0.5">
                        Make sure it can receive data before you pay
                    </span>
                </span>
                <ChevronDown className={cn('w-4 h-4 text-muted-foreground transition-transform flex-shrink-0', expanded && 'rotate-180')} />
            </button>

            {expanded && (
                <div className="p-3 pt-0 space-y-3">
                    <ServerTabs server={server} onChange={s => { setServer(s); reset() }} />
                    <div className="flex gap-2">
                        <Input
                            ref={inputRef}
                            value={value}
                            onChange={e => { setValue(e.target.value); if (data || error) reset() }}
                            onKeyDown={e => { if (e.key === 'Enter') submit() }}
                            placeholder="e.g. 0241000001"
                            inputMode="numeric"
                            autoComplete="tel"
                            maxLength={20}
                            aria-label="MTN number to check"
                            className="flex-1 h-10"
                        />
                        <Button onClick={submit} disabled={loading} className="h-10 px-4">
                            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Check'}
                        </Button>
                    </div>

                    {error && <StatusNote tone="error" title={error} />}

                    {invalid && (
                        <StatusNote tone="error" title={invalid.reason} body="Only MTN numbers can be checked here." />
                    )}

                    {result && (
                        result.allowed
                            ? <StatusNote tone="success" title={`Registered on Server ${dataServer}`}
                                body={`${result.normalized} is registered on Server ${dataServer}.`} />
                            : <StatusNote tone="pending" title="Submitted for registration"
                                body={`${result.normalized} isn't registered on Server ${dataServer} yet. We've submitted it for registration — please check again soon.`} />
                    )}
                </div>
            )}
        </div>
    )
}

function StatusNote({ tone, title, body }: { tone: 'success' | 'pending' | 'error'; title: string; body?: string }) {
    const config = {
        success: { Icon: CheckCircle2, wrap: 'border-green-500/30 bg-green-500/10', icon: 'text-green-600' },
        pending: { Icon: Clock, wrap: 'border-amber-500/30 bg-amber-500/10', icon: 'text-amber-600' },
        error: { Icon: AlertCircle, wrap: 'border-red-500/30 bg-red-500/10', icon: 'text-red-600' },
    }[tone]
    const { Icon } = config

    return (
        <div className={cn('flex gap-2.5 rounded-lg border p-3', config.wrap)}>
            <Icon className={cn('w-4 h-4 flex-shrink-0 mt-0.5', config.icon)} />
            <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">{title}</p>
                {body && <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{body}</p>}
            </div>
        </div>
    )
}

// ─── Full checker (dashboard, single + bulk) ────────────────────────────────────

type ResultFilter = 'pending' | 'allowed' | 'invalid'

/**
 * Escapes a cell for CSV.
 *
 * Prefixes anything starting with = + - @ with a single quote so a spreadsheet cannot
 * interpret an echoed input as a formula (CSV injection). Phone numbers are digits only,
 * but rejected entries echo whatever the user pasted.
 */
function csvCell(value: string): string {
    const safe = /^[=+\-@]/.test(value) ? `'${value}` : value
    return `"${safe.replace(/"/g, '""')}"`
}

export function MtnWhitelistChecker({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const [mode, setMode] = useState<'single' | 'bulk'>('single')
    const [server, setServer] = useState<Server>(1)
    const [singleValue, setSingleValue] = useState('')
    const [bulkText, setBulkText] = useState('')
    const [filter, setFilter] = useState<ResultFilter>('pending')
    const [search, setSearch] = useState('')
    const [parsingFile, setParsingFile] = useState(false)
    const fileInputRef = useRef<HTMLInputElement>(null)

    const { loading, data, dataServer, error, run, reset } = useWhitelistCheck()

    const parsedEntries = useMemo(() => parseNumberList(bulkText), [bulkText])
    const overLimit = parsedEntries.length > MAX_BULK_NUMBERS

    const pendingRows = useMemo(() => data?.results.filter(r => !r.allowed) ?? [], [data])
    const allowedRows = useMemo(() => data?.results.filter(r => r.allowed) ?? [], [data])
    const invalidRows = data?.invalid ?? []

    const submit = () => {
        const entries = mode === 'single' ? parseNumberList(singleValue).slice(0, 1) : parsedEntries
        if (entries.length === 0) {
            toast.error(mode === 'single' ? 'Enter an MTN number first' : 'Paste or upload some numbers first')
            return
        }
        if (entries.length > MAX_BULK_NUMBERS) {
            toast.error(`You can check at most ${MAX_BULK_NUMBERS} numbers at a time`)
            return
        }
        // Show the actionable list first — those are the numbers the user has to wait on.
        setFilter('pending')
        setSearch('')
        run(entries, server)
    }

    const handleFile = async (file: File) => {
        setParsingFile(true)
        try {
            let entries: string[]

            if (/\.(csv|txt)$/i.test(file.name)) {
                entries = parseNumberList(await file.text())
            } else {
                // Loaded on demand so xlsx never lands in the storefront bundle.
                const XLSX = await import('xlsx')
                const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' })
                const sheet = workbook.Sheets[workbook.SheetNames[0]]
                if (!sheet) throw new Error('That file has no sheets.')
                const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false })
                entries = rows.flatMap(row =>
                    (Array.isArray(row) ? row : [])
                        .filter(cell => cell !== null && cell !== undefined)
                        .map(cell => String(cell).trim())
                        .filter(Boolean)
                )
            }

            if (entries.length === 0) {
                toast.error('No numbers found in that file')
                return
            }

            setBulkText(entries.slice(0, MAX_BULK_NUMBERS).join('\n'))
            reset()
            toast.success(
                entries.length > MAX_BULK_NUMBERS
                    ? `Loaded the first ${MAX_BULK_NUMBERS} of ${entries.length} numbers`
                    : `Loaded ${entries.length} number${entries.length === 1 ? '' : 's'}`
            )
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Could not read that file')
        } finally {
            setParsingFile(false)
            if (fileInputRef.current) fileInputRef.current.value = ''
        }
    }

    const copyPending = async () => {
        if (pendingRows.length === 0) return
        try {
            await navigator.clipboard.writeText(pendingRows.map(r => r.normalized).join('\n'))
            toast.success(`Copied ${pendingRows.length} number${pendingRows.length === 1 ? '' : 's'}`)
        } catch {
            toast.error('Could not copy — your browser blocked clipboard access')
        }
    }

    const downloadCsv = () => {
        if (!data) return
        const lines = [
            'number,status,detail',
            ...allowedRows.map(r => `${csvCell(r.normalized)},${csvCell('Registered')},${csvCell(`Can receive data now (Server ${dataServer})`)}`),
            ...pendingRows.map(r => `${csvCell(r.normalized)},${csvCell('Submitted for registration')},${csvCell(`Not registered on Server ${dataServer} yet — check again soon`)}`),
            ...invalidRows.map(r => `${csvCell(r.input)},${csvCell('Not checked')},${csvCell(r.reason)}`),
        ]
        const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' }))
        const link = document.createElement('a')
        link.href = url
        link.download = `mtn-whitelist-${new Date().toISOString().slice(0, 10)}.csv`
        // Appended before click and removed after — matches the download pattern used
        // elsewhere in this app (e.g. app/dashboard/afa-orders). A detached <a> click is
        // silently ignored by some browsers, which would look like a dead button.
        document.body.appendChild(link)
        link.click()
        document.body.removeChild(link)
        URL.revokeObjectURL(url)
    }

    const visibleRows = useMemo(() => {
        const query = search.trim()
        const rows: { key: string; label: string; detail: string; tone: ResultFilter }[] =
            filter === 'allowed' ? allowedRows.map(r => ({ key: r.normalized, label: r.normalized, detail: 'Can receive data now', tone: 'allowed' as const }))
            : filter === 'pending' ? pendingRows.map(r => ({ key: r.normalized, label: r.normalized, detail: 'Submitted — check again soon', tone: 'pending' as const }))
            : invalidRows.map((r, i) => ({ key: `${r.input}-${i}`, label: r.input || '(empty)', detail: r.reason, tone: 'invalid' as const }))

        return query ? rows.filter(r => r.label.includes(query)) : rows
    }, [filter, search, allowedRows, pendingRows, invalidRows])

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent hideCloseButton className="max-w-lg p-0 gap-0 max-h-[92vh] flex flex-col">
                <div className="relative flex items-center justify-center px-4 pt-3 pb-1 flex-shrink-0">
                    <div className="w-10 h-1 rounded-full bg-muted-foreground/25" />
                    <DialogClose className="absolute right-3 w-9 h-9 rounded-full flex items-center justify-center hover:bg-muted transition-colors">
                        <X className="w-4 h-4" />
                        <span className="sr-only">Close</span>
                    </DialogClose>
                </div>

                <DialogHeader className="px-5 pt-2 pb-4 flex-shrink-0 text-left space-y-1.5">
                    <DialogTitle className="flex items-center gap-2 text-base">
                        <ShieldCheck className="w-4 h-4 text-amber-500" />
                        MTN Number Registration
                    </DialogTitle>
                    <DialogDescription className="text-xs leading-relaxed">
                        Only registered MTN numbers can receive data. Pick a server and check a number — if it
                        isn&apos;t registered on that server yet, we automatically submit it for registration.
                        Check again soon after.
                    </DialogDescription>
                </DialogHeader>

                <div className="px-5 pb-5 space-y-4 overflow-y-auto flex-1">
                    <ServerTabs server={server} onChange={s => { setServer(s); reset() }} />

                    <div className="flex bg-muted rounded-xl p-1 gap-1">
                        {(['single', 'bulk'] as const).map(m => (
                            <button
                                key={m}
                                onClick={() => { setMode(m); reset() }}
                                className={cn(
                                    'flex-1 py-2 text-sm font-semibold rounded-lg transition-all duration-150',
                                    mode === m ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                                )}
                            >
                                {m === 'single' ? 'One Number' : 'Bulk Check'}
                            </button>
                        ))}
                    </div>

                    {mode === 'single' ? (
                        <Input
                            value={singleValue}
                            onChange={e => { setSingleValue(e.target.value); if (data || error) reset() }}
                            onKeyDown={e => { if (e.key === 'Enter') submit() }}
                            placeholder="e.g. 0241000001"
                            inputMode="numeric"
                            autoComplete="tel"
                            maxLength={20}
                            aria-label="MTN number to check"
                            className="h-11"
                        />
                    ) : (
                        <div className="space-y-2">
                            <textarea
                                value={bulkText}
                                onChange={e => { setBulkText(e.target.value); if (data || error) reset() }}
                                placeholder={`Paste up to ${MAX_BULK_NUMBERS} MTN numbers — one per line\n\n0241000001\n0551617309`}
                                rows={7}
                                aria-label="MTN numbers to check, one per line"
                                className="w-full rounded-xl border border-border bg-background p-3 text-sm font-mono text-foreground placeholder:font-sans placeholder:text-muted-foreground resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            />
                            <div className="flex items-center justify-between gap-2">
                                <p className={cn('text-xs', overLimit ? 'text-red-600 font-medium' : 'text-muted-foreground')}>
                                    {parsedEntries.length} number{parsedEntries.length === 1 ? '' : 's'}
                                    {overLimit && ` — max ${MAX_BULK_NUMBERS}`}
                                </p>
                                <Button
                                    type="button" variant="outline" size="sm" className="h-8 text-xs"
                                    onClick={() => fileInputRef.current?.click()}
                                    disabled={parsingFile}
                                >
                                    {parsingFile
                                        ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                                        : <Upload className="w-3.5 h-3.5 mr-1.5" />}
                                    Upload file
                                </Button>
                                <input
                                    ref={fileInputRef} type="file" accept=".csv,.txt,.xlsx,.xls" className="hidden"
                                    onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
                                />
                            </div>
                        </div>
                    )}

                    <Button onClick={submit} disabled={loading || overLimit} className="w-full h-11">
                        {loading
                            ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Checking…</>
                            : <><ShieldCheck className="w-4 h-4 mr-2" />Check &amp; Register</>}
                    </Button>

                    {error && <StatusNote tone="error" title={error} />}

                    {data && mode === 'single' && (
                        data.results[0]
                            ? (data.results[0].allowed
                                ? <StatusNote tone="success" title={`Registered on Server ${dataServer}`}
                                    body={`${data.results[0].normalized} can receive data right now.`} />
                                : <StatusNote tone="pending" title="Submitted for registration"
                                    body={`${data.results[0].normalized} isn't registered on Server ${dataServer} yet, so we've submitted it for registration. Please check again soon.`} />)
                            : <StatusNote tone="error" title={data.invalid[0]?.reason || 'That number could not be checked'}
                                body="Only MTN numbers (024, 025, 053, 054, 055, 059) can be registered." />
                    )}

                    {data && mode === 'bulk' && (
                        <div className="space-y-3">
                            <div className="grid grid-cols-3 gap-2">
                                <SummaryTile label="Registered" count={allowedRows.length} active={filter === 'allowed'}
                                    tone="success" onClick={() => setFilter('allowed')} />
                                <SummaryTile label="Submitted" count={pendingRows.length} active={filter === 'pending'}
                                    tone="pending" onClick={() => setFilter('pending')} />
                                <SummaryTile label="Not checked" count={invalidRows.length} active={filter === 'invalid'}
                                    tone="error" onClick={() => setFilter('invalid')} />
                            </div>

                            {pendingRows.length > 0 && (
                                <StatusNote tone="pending" title={`${pendingRows.length} number${pendingRows.length === 1 ? '' : 's'} submitted for registration on Server ${dataServer}`}
                                    body="These can't receive data yet. Come back and check again soon." />
                            )}

                            <div className="flex gap-2">
                                <div className="relative flex-1">
                                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                                    <input
                                        value={search} onChange={e => setSearch(e.target.value)}
                                        placeholder="Find a number…" aria-label="Filter results"
                                        className="w-full pl-9 h-9 rounded-lg border border-border bg-background text-sm text-foreground"
                                    />
                                </div>
                                <Button variant="outline" size="sm" className="h-9 px-3" onClick={copyPending}
                                    disabled={pendingRows.length === 0} title="Copy the numbers submitted for registration">
                                    <Copy className="w-3.5 h-3.5" />
                                </Button>
                                <Button variant="outline" size="sm" className="h-9 px-3" onClick={downloadCsv} title="Download full report as CSV">
                                    <Download className="w-3.5 h-3.5" />
                                </Button>
                            </div>

                            <div className="rounded-xl border border-border divide-y divide-border max-h-64 overflow-y-auto">
                                {visibleRows.length === 0 ? (
                                    <p className="p-6 text-center text-sm text-muted-foreground">Nothing here</p>
                                ) : (
                                    visibleRows.slice(0, MAX_RENDERED_ROWS).map(row => (
                                        <div key={row.key} className="flex items-center gap-2.5 px-3 py-2.5">
                                            <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0',
                                                row.tone === 'allowed' ? 'bg-green-500' : row.tone === 'pending' ? 'bg-amber-500' : 'bg-red-500')} />
                                            <span className="font-mono text-sm text-foreground flex-shrink-0">{row.label}</span>
                                            <span className="text-xs text-muted-foreground truncate ml-auto text-right">{row.detail}</span>
                                        </div>
                                    ))
                                )}
                                {visibleRows.length > MAX_RENDERED_ROWS && (
                                    <p className="p-3 text-center text-xs text-muted-foreground">
                                        Showing {MAX_RENDERED_ROWS} of {visibleRows.length} — download the CSV for the full list
                                    </p>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    )
}

function SummaryTile({ label, count, tone, active, onClick }: {
    label: string; count: number; tone: 'success' | 'pending' | 'error'; active: boolean; onClick: () => void
}) {
    const accent = { success: 'text-green-600', pending: 'text-amber-600', error: 'text-red-600' }[tone]
    return (
        <button
            onClick={onClick}
            aria-pressed={active}
            className={cn(
                'rounded-xl border p-2.5 text-center transition-colors',
                active ? 'border-foreground/30 bg-muted' : 'border-border hover:bg-muted/50'
            )}
        >
            <p className={cn('text-lg font-bold leading-none', accent)}>{count}</p>
            <p className="text-[10px] text-muted-foreground mt-1 leading-tight">{label}</p>
        </button>
    )
}
