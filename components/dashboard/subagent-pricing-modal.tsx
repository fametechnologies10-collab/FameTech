'use client'

// =============================================================================
// Plan 4, Task 5 — Sub-agent pricing modal
// (docs/superpowers/sdd/2026-09-14b-subagent-pricing-and-polish/task-5-brief.md)
//
// Shared between two contexts, selected by `target`:
//   - { type: 'default' } — a recruiter's account-wide default sub-agent pricing
//   - { type: 'sub', subId, subName } — one sub-agent's pricing override
//
// Talks to Task 4's GET/PUT routes:
//   app/api/dashboard/subagents/pricing/route.ts            (default)
//   app/api/dashboard/subagents/[id]/pricing/route.ts        (per-sub)
//
// Three independent sections, each with its own "Save" action and its own
// in-flight/dirty state, matching the PUT routes' one-section-at-a-time shape:
//   - data:    { section: 'data', network, mode: 'package'|'flat', rows }
//   - checker: { section: 'checker', rows: [{ typeId, subPrice }] }
//   - afa:     { section: 'afa', subPrice }
//
// AFA's yourPrice is `number | null` — null means AFA pricing is genuinely
// unconfigured platform-wide (an admin-settings gap), not something the
// recruiter can fix here. We render that as a clear "unavailable" state and
// never show an editable input or a fabricated GHS 0.00 against it.
// =============================================================================

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select'
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { cn, formatCurrency } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { Loader2, Save, Tag, X, AlertTriangle } from 'lucide-react'

// ── Types ────────────────────────────────────────────────────────────────

export type PricingModalTarget =
    | { type: 'default' }
    | { type: 'sub'; subId: string; subName: string }

interface DataRow {
    packageId: string
    sizeLabel: string
    yourPrice: number
    subPrice: number | null
    sortOrder: number | null
}

interface CheckerRow {
    typeId: string
    name: string
    yourPrice: number
    subPrice: number | null
}

interface AfaData {
    yourPrice: number | null
    subPrice: number | null
}

interface PricingData {
    networks: string[]
    dataByNetwork: Record<string, DataRow[]>
    checkerTypes: CheckerRow[]
    afa: AfaData
}

interface SubagentPricingModalProps {
    target: PricingModalTarget
    open: boolean
    onOpenChange: (open: boolean) => void
}

type DataMode = 'package' | 'flat'
type SectionKey = 'data' | 'checker' | 'afa'

// ── Helpers ──────────────────────────────────────────────────────────────

function basePath(target: PricingModalTarget): string {
    return target.type === 'default'
        ? '/api/dashboard/subagents/pricing'
        : `/api/dashboard/subagents/${target.subId}/pricing`
}

/** Margin badge: "+ GHS X.XX" in emerald when non-negative, red warning otherwise. */
function MarginBadge({ yourPrice, subPrice }: { yourPrice: number; subPrice: string }) {
    const parsed = Number(subPrice)
    if (subPrice.trim() === '' || !Number.isFinite(parsed)) {
        return <span className="text-xs text-muted-foreground">—</span>
    }
    const margin = parsed - yourPrice
    const negative = margin < 0
    return (
        <span
            className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums',
                negative
                    ? 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-400'
                    : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400',
            )}
        >
            {negative ? '' : '+ '}GHS {margin.toFixed(2)}
        </span>
    )
}

// ── Component ────────────────────────────────────────────────────────────

export function SubagentPricingModal({ target, open, onOpenChange }: SubagentPricingModalProps) {
    const [loading, setLoading] = useState(false)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [data, setData] = useState<PricingData | null>(null)

    // Data section state
    const [network, setNetwork] = useState<string>('')
    const [mode, setMode] = useState<DataMode>('package')
    const [packageDrafts, setPackageDrafts] = useState<Record<string, string>>({})
    const [flatRateDraft, setFlatRateDraft] = useState('')
    const [savingData, setSavingData] = useState(false)
    const [matchParentData, setMatchParentData] = useState(false)

    // Checker section state
    const [checkerDrafts, setCheckerDrafts] = useState<Record<string, string>>({})
    const [savingChecker, setSavingChecker] = useState(false)
    const [matchParentChecker, setMatchParentChecker] = useState(false)

    // AFA section state
    const [afaDraft, setAfaDraft] = useState('')
    const [savingAfa, setSavingAfa] = useState(false)
    const [matchParentAfa, setMatchParentAfa] = useState(false)

    const title = target.type === 'default' ? 'Default Pricing' : `Pricing — ${target.subName}`
    const description = target.type === 'default'
        ? 'The starting sub prices applied to every new sub-agent, unless they have a custom override.'
        : `Custom pricing for ${target.subName} only. Leave a row blank to fall back to your default pricing.`

    // ── Load ─────────────────────────────────────────────────────────────
    const load = useCallback(async () => {
        setLoading(true)
        setLoadError(null)
        try {
            const res = await fetch(basePath(target), { cache: 'no-store' })
            const json = await res.json().catch(() => ({}))
            if (!res.ok || !json.success) {
                setLoadError(json.error || 'Could not load pricing')
                return
            }
            const payload: PricingData = json.data
            setData(payload)
            setNetwork((prev) => (prev && payload.networks.includes(prev) ? prev : payload.networks[0] ?? ''))
            setCheckerDrafts(
                Object.fromEntries(payload.checkerTypes.map((r) => [r.typeId, r.subPrice != null ? String(r.subPrice) : ''])),
            )
            setAfaDraft(payload.afa.subPrice != null ? String(payload.afa.subPrice) : '')
        } catch {
            setLoadError('Could not load pricing')
        } finally {
            setLoading(false)
        }
    }, [target])

    useEffect(() => {
        if (!open) return
        setMode('package')
        setFlatRateDraft('')
        setMatchParentData(false)
        setMatchParentChecker(false)
        setMatchParentAfa(false)
        load()
    }, [open, load])

    // Re-seed package drafts whenever the selected network's rows change (network switch or reload)
    useEffect(() => {
        if (!data || !network) return
        const rows = data.dataByNetwork[network] ?? []
        setPackageDrafts(Object.fromEntries(rows.map((r) => [r.packageId, r.subPrice != null ? String(r.subPrice) : ''])))
        setMatchParentData(false)
    }, [data, network])

    const currentPackages = useMemo(() => {
        if (!data || !network) return []
        return [...(data.dataByNetwork[network] ?? [])].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    }, [data, network])

    // ── Client-side validation (fast feedback only — server re-validates) ──
    function belowCost(yourPrice: number, raw: string): boolean {
        if (raw.trim() === '') return false
        const n = Number(raw)
        return Number.isFinite(n) && n < yourPrice
    }

    // ── Save: data section ───────────────────────────────────────────────
    async function saveData() {
        if (!network) return

        if (!matchParentData) {
            if (mode === 'flat') {
                const flat = Number(flatRateDraft)
                if (!flatRateDraft.trim() || !Number.isFinite(flat) || flat <= 0) {
                    toast.error('Enter a valid flat rate per GB')
                    return
                }
            } else {
                const invalid = currentPackages.some((row) => belowCost(row.yourPrice, packageDrafts[row.packageId] ?? ''))
                if (invalid) {
                    toast.error('Sub price must be at or above your own price for every package')
                    return
                }
            }
        }

        setSavingData(true)
        try {
            const body = matchParentData
                ? { section: 'data', network, matchParentPrice: true }
                : mode === 'flat'
                    ? { section: 'data', network, mode: 'flat', rows: { flatRatePerGB: Number(flatRateDraft) } }
                    : {
                        section: 'data',
                        network,
                        mode: 'package',
                        rows: currentPackages
                            .filter((row) => (packageDrafts[row.packageId] ?? '').trim() !== '')
                            .map((row) => ({ packageId: row.packageId, subPrice: Number(packageDrafts[row.packageId]) })),
                    }
            const res = await fetch(basePath(target), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            })
            const json = await res.json().catch(() => ({}))
            if (!res.ok || !json.success) {
                toast.error(json.error || 'Could not save pricing')
                return
            }
            toast.success('Data pricing saved')
            await load()
        } catch {
            toast.error('Could not save pricing')
        } finally {
            setSavingData(false)
        }
    }

    // ── Save: checker section ───────────────────────────────────────────
    async function saveChecker() {
        if (!data) return
        if (!matchParentChecker) {
            const invalid = data.checkerTypes.some((row) => belowCost(row.yourPrice, checkerDrafts[row.typeId] ?? ''))
            if (invalid) {
                toast.error('Sub price must be at or above your own price for every product')
                return
            }
        }

        setSavingChecker(true)
        try {
            const body = matchParentChecker
                ? { section: 'checker', matchParentPrice: true }
                : {
                    section: 'checker',
                    rows: data.checkerTypes
                        .filter((row) => (checkerDrafts[row.typeId] ?? '').trim() !== '')
                        .map((row) => ({ typeId: row.typeId, subPrice: Number(checkerDrafts[row.typeId]) })),
                }
            const res = await fetch(basePath(target), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            })
            const json = await res.json().catch(() => ({}))
            if (!res.ok || !json.success) {
                toast.error(json.error || 'Could not save checker prices')
                return
            }
            toast.success('Checker prices saved')
            await load()
        } catch {
            toast.error('Could not save checker prices')
        } finally {
            setSavingChecker(false)
        }
    }

    // ── Save: AFA section ────────────────────────────────────────────────
    async function saveAfa() {
        if (!data || data.afa.yourPrice == null) return
        if (!matchParentAfa) {
            if (belowCost(data.afa.yourPrice, afaDraft)) {
                toast.error('Sub price must be at or above your own price')
                return
            }
            if (afaDraft.trim() === '') {
                toast.error('Enter a sub price')
                return
            }
        }

        setSavingAfa(true)
        try {
            const body = matchParentAfa
                ? { section: 'afa', matchParentPrice: true }
                : { section: 'afa', subPrice: Number(afaDraft) }
            const res = await fetch(basePath(target), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            })
            const json = await res.json().catch(() => ({}))
            if (!res.ok || !json.success) {
                toast.error(json.error || 'Could not save AFA pricing')
                return
            }
            toast.success('AFA pricing saved')
            await load()
        } catch {
            toast.error('Could not save AFA pricing')
        } finally {
            setSavingAfa(false)
        }
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent hideCloseButton className="max-w-2xl max-h-[90vh] overflow-y-auto p-4 sm:p-6">
                <div className="relative flex items-center justify-center">
                    <DialogClose className="absolute right-0 w-9 h-9 rounded-full flex items-center justify-center hover:bg-muted transition-colors">
                        <X className="w-4 h-4" />
                        <span className="sr-only">Close</span>
                    </DialogClose>
                </div>

                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2 text-base sm:text-lg">
                        <Tag className="w-4 h-4 text-primary shrink-0" /> {title}
                    </DialogTitle>
                    <DialogDescription className="text-xs sm:text-sm">{description}</DialogDescription>
                </DialogHeader>

                {loading && (
                    <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
                        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading pricing…
                    </div>
                )}

                {!loading && loadError && (
                    <div className="py-8 text-center text-sm text-muted-foreground space-y-3">
                        <p>{loadError}</p>
                        <Button variant="outline" size="sm" onClick={load}>Try again</Button>
                    </div>
                )}

                {!loading && !loadError && data && (
                    <div className="space-y-6 sm:space-y-8 py-2">
                        {/* ── Data section ──────────────────────────────────────── */}
                        <section className="space-y-3 sm:space-y-4">
                            <div className="flex flex-wrap items-end gap-2 sm:gap-3">
                                <div className="flex-1 min-w-[120px] sm:min-w-[140px] space-y-1.5">
                                    <Label className="text-xs uppercase tracking-wide text-muted-foreground">Service</Label>
                                    <Select value={network} onValueChange={setNetwork}>
                                        <SelectTrigger>
                                            <SelectValue placeholder="Select network" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {data.networks.map((net) => (
                                                <SelectItem key={net} value={net}>{net}</SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>

                                <div className="flex rounded-lg border border-input bg-muted p-1 shrink-0">
                                    <button
                                        type="button"
                                        onClick={() => setMode('package')}
                                        className={cn(
                                            'px-2.5 sm:px-3 h-8 rounded-md text-xs sm:text-sm font-medium transition-colors',
                                            mode === 'package' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground',
                                        )}
                                    >
                                        Package
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setMode('flat')}
                                        className={cn(
                                            'px-2.5 sm:px-3 h-8 rounded-md text-xs sm:text-sm font-medium transition-colors',
                                            mode === 'flat' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground',
                                        )}
                                    >
                                        Flat rate
                                    </button>
                                </div>
                            </div>

                            <div className="flex items-center gap-2.5 rounded-lg border bg-muted/40 px-3 py-2">
                                <Switch
                                    id="match-parent-data"
                                    checked={matchParentData}
                                    onCheckedChange={setMatchParentData}
                                />
                                <Label htmlFor="match-parent-data" className="text-xs sm:text-sm font-normal cursor-pointer">
                                    Use my price — no markup
                                </Label>
                            </div>

                            {mode === 'package' ? (
                                <>
                                    <div className="rounded-xl border overflow-x-auto">
                                        <Table>
                                            <TableHeader>
                                                <TableRow>
                                                    <TableHead className="px-2 py-2 text-xs sm:px-4 sm:h-12 sm:text-sm">Package</TableHead>
                                                    <TableHead className="px-2 py-2 text-xs sm:px-4 sm:h-12 sm:text-sm">Your price</TableHead>
                                                    <TableHead className="px-2 py-2 text-xs sm:px-4 sm:h-12 sm:text-sm min-w-[110px] sm:min-w-[140px]">Sub price</TableHead>
                                                    <TableHead className="px-2 py-2 text-xs sm:px-4 sm:h-12 sm:text-sm min-w-[80px] sm:min-w-[110px]">Margin</TableHead>
                                                </TableRow>
                                            </TableHeader>
                                            <TableBody>
                                                {currentPackages.length === 0 && (
                                                    <TableRow>
                                                        <TableCell colSpan={4} className="text-center text-xs sm:text-sm text-muted-foreground py-6">
                                                            No packages for this network.
                                                        </TableCell>
                                                    </TableRow>
                                                )}
                                                {currentPackages.map((row) => {
                                                    const draft = packageDrafts[row.packageId] ?? ''
                                                    const invalid = belowCost(row.yourPrice, draft)
                                                    return (
                                                        <TableRow key={row.packageId}>
                                                            <TableCell className="px-2 py-1.5 sm:p-4 text-xs sm:text-sm font-medium whitespace-nowrap">{row.sizeLabel}</TableCell>
                                                            <TableCell className="px-2 py-1.5 sm:p-4 text-xs sm:text-sm whitespace-nowrap tabular-nums">{formatCurrency(row.yourPrice)}</TableCell>
                                                            <TableCell className="px-2 py-1.5 sm:p-4">
                                                                <Input
                                                                    type="number"
                                                                    inputMode="decimal"
                                                                    step="0.01"
                                                                    min={0}
                                                                    placeholder={formatCurrency(row.yourPrice)}
                                                                    value={draft}
                                                                    onChange={(e) => setPackageDrafts((prev) => ({ ...prev, [row.packageId]: e.target.value }))}
                                                                    disabled={matchParentData}
                                                                    className={cn('h-8 text-sm sm:h-9', invalid && 'border-red-400 focus-visible:ring-red-400')}
                                                                />
                                                            </TableCell>
                                                            <TableCell className="px-2 py-1.5 sm:p-4">
                                                                <MarginBadge yourPrice={row.yourPrice} subPrice={draft} />
                                                            </TableCell>
                                                        </TableRow>
                                                    )
                                                })}
                                            </TableBody>
                                        </Table>
                                    </div>
                                    <p className="text-xs text-muted-foreground">Must be at or above your own price for this service.</p>
                                </>
                            ) : (
                                <div className="space-y-1.5 max-w-xs">
                                    <Label className="text-xs uppercase tracking-wide text-muted-foreground">Flat rate (GHS per GB)</Label>
                                    <Input
                                        type="number"
                                        inputMode="decimal"
                                        step="0.01"
                                        min={0}
                                        placeholder="e.g. 5.50"
                                        value={flatRateDraft}
                                        onChange={(e) => setFlatRateDraft(e.target.value)}
                                        disabled={matchParentData}
                                        className="h-8 text-sm sm:h-9"
                                    />
                                    <p className="text-xs text-muted-foreground">Applies one rate per GB across every package on this network.</p>
                                </div>
                            )}

                            <div className="flex justify-end">
                                <Button size="sm" onClick={saveData} disabled={savingData || !network} className="text-xs sm:text-sm">
                                    {savingData ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin shrink-0" /> : <Save className="w-4 h-4 mr-1.5 shrink-0" />}
                                    Save pricing
                                </Button>
                            </div>
                        </section>

                        <div className="h-px bg-border" />

                        {/* ── Checker prices section ───────────────────────────── */}
                        <section className="space-y-3 sm:space-y-4">
                            <h3 className="text-sm font-semibold">Checker prices</h3>
                            <div className="flex items-center gap-2.5 rounded-lg border bg-muted/40 px-3 py-2">
                                <Switch
                                    id="match-parent-checker"
                                    checked={matchParentChecker}
                                    onCheckedChange={setMatchParentChecker}
                                />
                                <Label htmlFor="match-parent-checker" className="text-xs sm:text-sm font-normal cursor-pointer">
                                    Use my price — no markup
                                </Label>
                            </div>
                            <div className="rounded-xl border overflow-x-auto">
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead className="px-2 py-2 text-xs sm:px-4 sm:h-12 sm:text-sm">Product</TableHead>
                                            <TableHead className="px-2 py-2 text-xs sm:px-4 sm:h-12 sm:text-sm">Your price</TableHead>
                                            <TableHead className="px-2 py-2 text-xs sm:px-4 sm:h-12 sm:text-sm min-w-[110px] sm:min-w-[140px]">Sub price</TableHead>
                                            <TableHead className="px-2 py-2 text-xs sm:px-4 sm:h-12 sm:text-sm min-w-[80px] sm:min-w-[110px]">Margin</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {data.checkerTypes.length === 0 && (
                                            <TableRow>
                                                <TableCell colSpan={4} className="text-center text-xs sm:text-sm text-muted-foreground py-6">
                                                    No checker products available.
                                                </TableCell>
                                            </TableRow>
                                        )}
                                        {data.checkerTypes.map((row) => {
                                            const draft = checkerDrafts[row.typeId] ?? ''
                                            const invalid = belowCost(row.yourPrice, draft)
                                            return (
                                                <TableRow key={row.typeId}>
                                                    <TableCell className="px-2 py-1.5 sm:p-4 text-xs sm:text-sm font-medium whitespace-nowrap">{row.name}</TableCell>
                                                    <TableCell className="px-2 py-1.5 sm:p-4 text-xs sm:text-sm whitespace-nowrap tabular-nums">{formatCurrency(row.yourPrice)}</TableCell>
                                                    <TableCell className="px-2 py-1.5 sm:p-4">
                                                        <Input
                                                            type="number"
                                                            inputMode="decimal"
                                                            step="0.01"
                                                            min={0}
                                                            placeholder={formatCurrency(row.yourPrice)}
                                                            value={draft}
                                                            onChange={(e) => setCheckerDrafts((prev) => ({ ...prev, [row.typeId]: e.target.value }))}
                                                            disabled={matchParentChecker}
                                                            className={cn('h-8 text-sm sm:h-9', invalid && 'border-red-400 focus-visible:ring-red-400')}
                                                        />
                                                    </TableCell>
                                                    <TableCell className="px-2 py-1.5 sm:p-4">
                                                        <MarginBadge yourPrice={row.yourPrice} subPrice={draft} />
                                                    </TableCell>
                                                </TableRow>
                                            )
                                        })}
                                    </TableBody>
                                </Table>
                            </div>
                            <div className="flex justify-end">
                                <Button size="sm" onClick={saveChecker} disabled={savingChecker || data.checkerTypes.length === 0} className="text-xs sm:text-sm">
                                    {savingChecker ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin shrink-0" /> : <Save className="w-4 h-4 mr-1.5 shrink-0" />}
                                    Save checker prices
                                </Button>
                            </div>
                        </section>

                        <div className="h-px bg-border" />

                        {/* ── AFA section ───────────────────────────────────────── */}
                        <section className="space-y-3 sm:space-y-4">
                            <h3 className="text-sm font-semibold">AFA registration</h3>

                            {data.afa.yourPrice == null ? (
                                <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/30 p-3 sm:p-3.5 text-xs sm:text-sm text-amber-800 dark:text-amber-300">
                                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                                    <p>AFA pricing is currently unavailable — it hasn&apos;t been configured platform-wide yet, so there&apos;s no base price to set a sub price against. This isn&apos;t something you can fix here; check back later.</p>
                                </div>
                            ) : (
                                <>
                                    <div className="flex items-center gap-2.5 rounded-lg border bg-muted/40 px-3 py-2">
                                        <Switch
                                            id="match-parent-afa"
                                            checked={matchParentAfa}
                                            onCheckedChange={setMatchParentAfa}
                                        />
                                        <Label htmlFor="match-parent-afa" className="text-xs sm:text-sm font-normal cursor-pointer">
                                            Use my price — no markup
                                        </Label>
                                    </div>
                                    <div className="rounded-xl border overflow-x-auto">
                                        <Table>
                                            <TableHeader>
                                                <TableRow>
                                                    <TableHead className="px-2 py-2 text-xs sm:px-4 sm:h-12 sm:text-sm">Product</TableHead>
                                                    <TableHead className="px-2 py-2 text-xs sm:px-4 sm:h-12 sm:text-sm">Your price</TableHead>
                                                    <TableHead className="px-2 py-2 text-xs sm:px-4 sm:h-12 sm:text-sm min-w-[110px] sm:min-w-[140px]">Sub price</TableHead>
                                                    <TableHead className="px-2 py-2 text-xs sm:px-4 sm:h-12 sm:text-sm min-w-[80px] sm:min-w-[110px]">Margin</TableHead>
                                                </TableRow>
                                            </TableHeader>
                                            <TableBody>
                                                <TableRow>
                                                    <TableCell className="px-2 py-1.5 sm:p-4 text-xs sm:text-sm font-medium whitespace-nowrap">AFA Registration</TableCell>
                                                    <TableCell className="px-2 py-1.5 sm:p-4 text-xs sm:text-sm whitespace-nowrap tabular-nums">{formatCurrency(data.afa.yourPrice)}</TableCell>
                                                    <TableCell className="px-2 py-1.5 sm:p-4">
                                                        <Input
                                                            type="number"
                                                            inputMode="decimal"
                                                            step="0.01"
                                                            min={0}
                                                            placeholder={formatCurrency(data.afa.yourPrice)}
                                                            value={afaDraft}
                                                            onChange={(e) => setAfaDraft(e.target.value)}
                                                            disabled={matchParentAfa}
                                                            className={cn('h-8 text-sm sm:h-9', belowCost(data.afa.yourPrice, afaDraft) && 'border-red-400 focus-visible:ring-red-400')}
                                                        />
                                                    </TableCell>
                                                    <TableCell className="px-2 py-1.5 sm:p-4">
                                                        <MarginBadge yourPrice={data.afa.yourPrice} subPrice={afaDraft} />
                                                    </TableCell>
                                                </TableRow>
                                            </TableBody>
                                        </Table>
                                    </div>
                                    <div className="flex justify-end">
                                        <Button size="sm" onClick={saveAfa} disabled={savingAfa} className="text-xs sm:text-sm">
                                            {savingAfa ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin shrink-0" /> : <Save className="w-4 h-4 mr-1.5 shrink-0" />}
                                            Save AFA pricing
                                        </Button>
                                    </div>
                                </>
                            )}
                        </section>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    )
}

export default SubagentPricingModal
