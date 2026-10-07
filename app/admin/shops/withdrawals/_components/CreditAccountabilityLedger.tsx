'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  Copy,
  Check,
  AlertTriangle,
  Loader2,
  Store,
  User,
  Mail,
  Phone,
  ShieldCheck,
  ShieldAlert,
  TrendingDown,
  RefreshCw,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { toast } from '@/lib/toast'
import type { CreditRow, Rollups } from './types'

// ─── Risk-reasons label map ──────────────────────────────────────────────────

const RISK_REASON_LABELS: Record<string, string> = {
  orphan_no_order: 'No backing order (possible manipulation)',
  dangling_order_fk: 'Order link points to a missing order',
  order_status_invalid: 'Backing order is failed/refunded',
  order_unpaid: 'Website order has no payment reference',
  amount_mismatch: 'Credited amount ≠ order profit',
  duplicate_for_order: 'Duplicate credit for one order',
  source_uncross_checked: 'USSD/Results-Checker source not cross-checked',
  ussd_no_paid_order: 'USSD credit with NO confirmed payment — investigate (possible forged callback)',
}

function labelForCode(code: string): string {
  return RISK_REASON_LABELS[code] ?? code
}

// ─── Risk palette helpers ────────────────────────────────────────────────────

type RiskStatus = 'green' | 'amber' | 'red'

const RISK_ROW_CLS: Record<RiskStatus, string> = {
  green:
    'border-l-4 border-l-emerald-500 bg-emerald-50/40 dark:bg-emerald-950/20',
  amber:
    'border-l-4 border-l-amber-500 bg-amber-50/40 dark:bg-amber-950/20',
  red: 'border-l-4 border-l-red-500 bg-red-50/40 dark:bg-red-950/20',
}

const RISK_PILL_CLS: Record<RiskStatus, string> = {
  green:
    'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  amber:
    'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  red: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
}

const RISK_LABELS: Record<RiskStatus, string> = {
  green: 'Clean',
  amber: 'Amber',
  red: 'Suspicious',
}

// ─── Guarded copy button ─────────────────────────────────────────────────────

function CopyBtn({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    try {
      navigator.clipboard.writeText(value).then(
        () => {
          setCopied(true)
          toast.success(label ? `Copied ${label}` : 'Copied')
          setTimeout(() => setCopied(false), 1500)
        },
        () => {
          toast.error('Could not copy — please copy manually')
        },
      )
    } catch {
      toast.error('Could not copy — please copy manually')
    }
  }

  return (
    <button
      type="button"
      onClick={e => {
        e.stopPropagation()
        handleCopy()
      }}
      className="inline-flex items-center text-emerald-600 dark:text-emerald-400 hover:opacity-70 transition-opacity"
      title={`Copy ${label ?? value}`}
    >
      {copied ? (
        <Check className="w-3.5 h-3.5" />
      ) : (
        <Copy className="w-3.5 h-3.5" />
      )}
    </button>
  )
}

// ─── InfoLine ────────────────────────────────────────────────────────────────

function InfoLine({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between items-start gap-3 py-1.5">
      <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground flex-shrink-0 mt-0.5">
        {label}
      </span>
      <span className="text-xs font-medium text-right break-all">{children}</span>
    </div>
  )
}

// ─── Rollup cards ────────────────────────────────────────────────────────────

function RollupCards({ rollups }: { rollups: Rollups }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
      {/* Green */}
      <div className="rounded-xl border border-emerald-200 dark:border-emerald-800/50 bg-emerald-50 dark:bg-emerald-950/30 px-4 py-3 flex items-center gap-3">
        <ShieldCheck className="w-7 h-7 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
            Clean (Green)
          </p>
          <p className="text-xl font-black tabular-nums text-emerald-700 dark:text-emerald-300">
            {formatCurrency(rollups.green_total)}
          </p>
        </div>
      </div>

      {/* Amber */}
      <div className="rounded-xl border border-amber-200 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-950/30 px-4 py-3 flex items-center gap-3">
        <TrendingDown className="w-7 h-7 text-amber-600 dark:text-amber-400 flex-shrink-0" />
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider text-amber-700 dark:text-amber-400">
            Amber
          </p>
          <p className="text-xl font-black tabular-nums text-amber-700 dark:text-amber-300">
            {formatCurrency(rollups.amber_total)}
          </p>
        </div>
      </div>

      {/* Red */}
      <div className="rounded-xl border border-red-200 dark:border-red-800/50 bg-red-50 dark:bg-red-950/30 px-4 py-3 flex items-center gap-3">
        <ShieldAlert className="w-7 h-7 text-red-600 dark:text-red-400 flex-shrink-0" />
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider text-red-700 dark:text-red-400">
            Suspicious (Red)
          </p>
          <p className="text-xl font-black tabular-nums text-red-700 dark:text-red-300">
            {formatCurrency(rollups.red_total)}
          </p>
          <p className="text-[10px] text-red-600 dark:text-red-400 font-semibold">
            {rollups.red_count} {rollups.red_count === 1 ? 'record' : 'records'}
          </p>
        </div>
      </div>
    </div>
  )
}

// ─── Risk filter ─────────────────────────────────────────────────────────────

type RiskFilter = 'all' | RiskStatus

const FILTER_OPTIONS: { value: RiskFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'green', label: 'Green' },
  { value: 'amber', label: 'Amber' },
  { value: 'red', label: 'Red' },
]

function RiskFilterBar({
  value,
  onChange,
}: {
  value: RiskFilter
  onChange: (v: RiskFilter) => void
}) {
  return (
    <div className="flex items-center gap-1 rounded-xl bg-muted/60 p-1 w-fit mb-4" role="group">
      {FILTER_OPTIONS.map(opt => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={cn(
            'px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors',
            value === opt.value
              ? opt.value === 'green'
                ? 'bg-emerald-600 text-white shadow-sm'
                : opt.value === 'amber'
                ? 'bg-amber-500 text-white shadow-sm'
                : opt.value === 'red'
                ? 'bg-red-600 text-white shadow-sm'
                : 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

// ─── Credit row (expandable) ─────────────────────────────────────────────────

function CreditRowItem({ row }: { row: CreditRow }) {
  const [expanded, setExpanded] = useState(false)
  const hasDelta =
    row.expected_amount !== null && row.amount !== row.expected_amount
  const showReasons =
    (row.risk_status === 'red' || row.risk_status === 'amber') &&
    row.risk_reasons.length > 0

  return (
    <div
      className={cn(
        'rounded-xl border mb-2 overflow-hidden transition-colors',
        RISK_ROW_CLS[row.risk_status],
      )}
    >
      {/* ── Summary row (clickable) ── */}
      <button
        type="button"
        className="w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
        onClick={() => setExpanded(prev => !prev)}
      >
        {/* Risk pill */}
        <span
          className={cn(
            'mt-0.5 flex-shrink-0 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full',
            RISK_PILL_CLS[row.risk_status],
          )}
        >
          {RISK_LABELS[row.risk_status]}
        </span>

        {/* Core info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-2 flex-wrap">
            <p className="text-sm font-bold truncate">{row.shop_name}</p>
            <p className="text-sm font-black tabular-nums flex-shrink-0">
              {formatCurrency(row.amount)}
            </p>
          </div>
          <p className="text-xs text-muted-foreground truncate">{row.owner_name}</p>

          {/* Delta warning */}
          {hasDelta && (
            <p className="text-[11px] font-semibold text-amber-700 dark:text-amber-400 mt-0.5 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3 flex-shrink-0" />
              Expected {formatCurrency(row.expected_amount!)} &mdash; delta{' '}
              {formatCurrency(Math.abs(row.amount - row.expected_amount!))}
            </p>
          )}

          {/* Risk reasons inline */}
          {showReasons && (
            <ul className="mt-1 space-y-0.5">
              {row.risk_reasons.map(code => (
                <li
                  key={code}
                  className="text-[11px] text-red-700 dark:text-red-400 flex items-start gap-1"
                >
                  <span className="mt-0.5 flex-shrink-0">&bull;</span>
                  {labelForCode(code)}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Expand toggle */}
        <span className="flex-shrink-0 mt-0.5 text-muted-foreground">
          {expanded ? (
            <ChevronUp className="w-4 h-4" />
          ) : (
            <ChevronDown className="w-4 h-4" />
          )}
        </span>
      </button>

      {/* ── Expanded detail ── */}
      {expanded && (
        <div className="px-4 pb-4 pt-0 border-t border-border/60 bg-background/60 dark:bg-background/20">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 divide-y sm:divide-y-0">
            {/* Left: Shop + Owner */}
            <div className="divide-y">
              <InfoLine label="Shop">
                <span className="flex items-center gap-1">
                  <Store className="w-3 h-3 flex-shrink-0" />
                  {row.shop_name}
                </span>
              </InfoLine>
              <InfoLine label="Owner">
                <span className="flex items-center gap-1">
                  <User className="w-3 h-3 flex-shrink-0" />
                  {row.owner_name}
                </span>
              </InfoLine>
              <InfoLine label="Email">
                {row.owner_email ? (
                  <a
                    href={`mailto:${row.owner_email}`}
                    className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400 hover:underline"
                    onClick={e => e.stopPropagation()}
                  >
                    <Mail className="w-3 h-3 flex-shrink-0" />
                    {row.owner_email}
                  </a>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </InfoLine>
              <InfoLine label="Phone">
                <span className="flex items-center gap-1.5">
                  <Phone className="w-3 h-3 flex-shrink-0" />
                  {row.owner_phone || '—'}
                </span>
              </InfoLine>
            </div>

            {/* Right: Order + Credit details */}
            <div className="divide-y">
              <InfoLine label="Order ref">
                {row.order_ref ? (
                  <span className="flex items-center gap-1.5 font-mono">
                    {row.order_ref}
                    <CopyBtn value={row.order_ref} label="order ref" />
                  </span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </InfoLine>
              <InfoLine label="Product">
                {row.network || row.package_size ? (
                  `${row.network ?? ''}${row.network && row.package_size ? ' · ' : ''}${row.package_size ?? ''}`
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </InfoLine>
              <InfoLine label="Guest phone">
                {row.guest_phone ?? <span className="text-muted-foreground">—</span>}
              </InfoLine>
              <InfoLine label="Source">{row.credit_source}</InfoLine>
              <InfoLine label="Created">{formatDate(row.created_at)}</InfoLine>
              <InfoLine label="Credited">{formatCurrency(row.amount)}</InfoLine>
              {row.expected_amount !== null && (
                <InfoLine label="Expected">
                  <span
                    className={cn(
                      hasDelta
                        ? 'text-amber-700 dark:text-amber-400 font-bold'
                        : '',
                    )}
                  >
                    {formatCurrency(row.expected_amount)}
                  </span>
                </InfoLine>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Main component ──────────────────────────────────────────────────────────

interface ApiResponse {
  success: boolean
  data: { rows: CreditRow[]; total: number; rollups: Rollups }
  error?: string
}

const PAGE_SIZE = 20

export function CreditAccountabilityLedger({
  shopOwnerId,
}: {
  shopOwnerId?: string
}) {
  const [riskFilter, setRiskFilter] = useState<RiskFilter>('all')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [page, setPage] = useState(1)
  const [rows, setRows] = useState<CreditRow[]>([])
  const [total, setTotal] = useState(0)
  const [rollups, setRollups] = useState<Rollups>({
    green_total: 0,
    amber_total: 0,
    red_total: 0,
    red_count: 0,
  })
  const [loading, setLoading] = useState(false)

  // Debounce search → only update debouncedSearch after 300ms idle
  useEffect(() => {
    const id = setTimeout(() => {
      setDebouncedSearch(search)
      setPage(1)
    }, 300)
    return () => clearTimeout(id)
  }, [search])

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
      })
      if (riskFilter !== 'all') params.set('risk', riskFilter)
      if (shopOwnerId) params.set('shopOwnerId', shopOwnerId)
      if (debouncedSearch.trim()) params.set('search', debouncedSearch.trim())

      const res = await fetch(`/api/admin/shop-credits?${params}`, { signal })
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        toast.error(body.error ?? 'Failed to load credit ledger')
        return
      }
      const body = (await res.json()) as ApiResponse
      if (!body.success) {
        toast.error(body.error ?? 'Failed to load credit ledger')
        return
      }
      const ZERO_ROLLUPS: Rollups = { green_total: 0, amber_total: 0, red_total: 0, red_count: 0 }
      setRows(body.data?.rows ?? [])
      setTotal(body.data?.total ?? 0)
      setRollups(body.data?.rollups ?? ZERO_ROLLUPS)
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return
      toast.error('Network error loading credit ledger')
    } finally {
      setLoading(false)
    }
  }, [riskFilter, shopOwnerId, debouncedSearch, page])

  // Re-fetch whenever filters/page change; abort stale requests
  useEffect(() => {
    const controller = new AbortController()
    void fetchData(controller.signal)
    return () => controller.abort()
  }, [fetchData])

  // Reset to page 1 when filter changes
  const handleRiskChange = (v: RiskFilter) => {
    setRiskFilter(v)
    setPage(1)
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="space-y-0">
      {/* ── Rollup header ── */}
      <RollupCards rollups={rollups} />

      {/* ── Controls row ── */}
      <div className="flex flex-wrap items-center gap-3 mb-2">
        <RiskFilterBar value={riskFilter} onChange={handleRiskChange} />

        <div className="flex-1 min-w-[160px]">
          <input
            type="search"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search shop or owner…"
            className={cn(
              'w-full h-9 rounded-lg border bg-background px-3 text-sm',
              'placeholder:text-muted-foreground',
              'focus:outline-none focus:ring-2 focus:ring-emerald-500 dark:focus:ring-emerald-600',
            )}
          />
        </div>

        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 flex-shrink-0"
          onClick={() => void fetchData()}
          title="Refresh"
          disabled={loading}
        >
          <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
        </Button>
      </div>

      {/* ── Row list ── */}
      {loading && rows.length === 0 ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground text-sm">
          <ShieldCheck className="w-10 h-10 mb-2 opacity-30" />
          No credit records found
        </div>
      ) : (
        <div className="relative">
          {loading && (
            <div className="absolute inset-0 bg-background/50 flex items-center justify-center z-10 rounded-xl">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          )}
          {rows.map(row => (
            <CreditRowItem key={row.id} row={row} />
          ))}
        </div>
      )}

      {/* ── Pagination ── */}
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between pt-3 text-sm">
          <span className="text-muted-foreground text-xs">
            {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of{' '}
            {total}
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              disabled={page <= 1 || loading}
              onClick={() => setPage(p => p - 1)}
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <span className="px-2 text-xs font-medium tabular-nums">
              {page} / {totalPages}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              disabled={page >= totalPages || loading}
              onClick={() => setPage(p => p + 1)}
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
