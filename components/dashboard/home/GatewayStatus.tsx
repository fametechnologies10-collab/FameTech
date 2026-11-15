'use client'

import { useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { NetworkIcon } from '@/components/network-icon'
import { useGatewayStatus } from '@/hooks/use-gateway-status'
import {
  ageOffsetSeconds,
  DOWN_HEADLINE,
  formatDuration,
  liveEstimate,
  NONE_HEADLINE,
  type ChannelView,
  type StrengthTier,
} from '@/lib/gateway-estimate'
import {
  COOLDOWN_MS,
  cooldownRemainingMs,
  formatClockTime,
  TIER_FILL_CLASS,
  TIER_TEXT_CLASS,
} from '@/lib/gateway-status-format'

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ft-blue focus-visible:ring-offset-2 focus-visible:ring-offset-background'
const SKELETON = 'bg-muted rounded-xl motion-safe:animate-pulse'
const CARD = 'rounded-xl border border-border bg-card'
const TICK_MS = 5_000

// Channels with a real network logo (public/images/networks); others get an initial avatar.
const LOGO_NETWORKS = new Set(['MTN', 'Telecel', 'AT-iShare', 'AT-BigTime'])

/** Visible label for a channel: tier for live, fixed texts for none/down. */
function stateLabel(v: ChannelView): string {
  if (v.state === 'live') return v.tier ?? ''
  return v.state === 'none' ? NONE_HEADLINE : DOWN_HEADLINE
}

/** Key into the TIER_* class maps. */
function styleKey(v: ChannelView): StrengthTier | 'down' | 'none' {
  return v.tier ?? (v.state === 'down' ? 'down' : 'none')
}

function Avatar({ view }: { view: ChannelView }) {
  if (LOGO_NETWORKS.has(view.key)) {
    return (
      <span aria-hidden="true" className="shrink-0">
        <NetworkIcon network={view.key} size={28} />
      </span>
    )
  }
  return (
    <span
      aria-hidden="true"
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-bold text-foreground"
    >
      {view.label.charAt(0).toUpperCase()}
    </span>
  )
}

function DeliveryCard({ view, generatedAt }: { view: ChannelView; generatedAt: string }) {
  const headline =
    view.state === 'live' ? view.headline : view.state === 'none' ? NONE_HEADLINE : DOWN_HEADLINE
  const ce = view.state === 'live' ? view.currentEstimate : null
  const ld = view.lastDelivery
  const updated = formatClockTime(generatedAt)

  return (
    <div className="flex flex-col gap-1.5 rounded-lg bg-muted/50 p-3">
      <div className="flex items-center gap-2">
        <Avatar view={view} />
        <span className="text-sm font-medium truncate">{view.label}</span>
      </div>
      {headline && (
        <p className={`text-base font-semibold ${TIER_TEXT_CLASS[styleKey(view)]}`}>{headline}</p>
      )}
      {ce && <p className="text-sm">Current estimate: {formatDuration(ce.minutes, ce.seconds)}</p>}
      {ld && (
        <p className="text-sm text-muted-foreground">
          Last delivery took {formatDuration(ld.minutes, ld.seconds)}
        </p>
      )}
      {ld && ld.placedAt && ld.deliveredAt && (
        <p className="text-sm text-muted-foreground">
          Placed {formatClockTime(ld.placedAt)} → Delivered {formatClockTime(ld.deliveredAt)}
        </p>
      )}
      {updated !== '—' && <p className="text-[11px] text-muted-foreground">Updated {updated}</p>}
    </div>
  )
}

function StrengthRow({
  view,
  selected,
  onSelect,
}: {
  view: ChannelView
  selected: boolean
  onSelect: () => void
}) {
  const pct = Number.isFinite(view.strengthPct) ? Math.max(0, Math.min(100, view.strengthPct)) : 0
  const label = stateLabel(view)
  const ld = view.lastDelivery
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`flex min-h-[44px] w-full flex-col gap-1 rounded-lg border p-2.5 text-left ${
        selected ? 'border-ft-blue bg-muted/50' : 'border-transparent hover:bg-muted/40'
      } ${FOCUS_RING}`}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <Avatar view={view} />
          <span className="text-sm font-medium truncate">{view.label}</span>
        </span>
        {ld && (
          <span className="shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">
            Last delivery {formatDuration(ld.minutes, ld.seconds)}
          </span>
        )}
      </span>
      <span
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${view.label} delivery health: ${label}`}
        className="block h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <span
          className={`block h-full rounded-full motion-safe:transition-[width] motion-safe:duration-500 ${TIER_FILL_CLASS[styleKey(view)]}`}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className={`text-[11px] ${TIER_TEXT_CLASS[styleKey(view)]}`}>{label}</span>
    </button>
  )
}

export function GatewayStatus() {
  const { data, receivedAtMs, isLoading, error, refresh } = useGatewayStatus()
  const [selectedKey, setSelectedKey] = useState('MTN')
  const [refreshing, setRefreshing] = useState(false)
  const refreshingRef = useRef(false)
  const [fetchEndedAt, setFetchEndedAt] = useState<number | null>(null)
  const [cooldownNow, setCooldownNow] = useState<number>(0)
  // Set inside an effect (never during render) so SSR/hydration never sees a clock value.
  const [now, setNow] = useState<number | null>(null)

  // 5s live tick, only while the tab is visible.
  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null
    const stop = () => {
      if (id !== null) {
        clearInterval(id)
        id = null
      }
    }
    const start = () => {
      stop()
      id = setInterval(() => setNow(Date.now()), TICK_MS)
    }
    const onVisibility = () => {
      if (document.hidden) {
        stop()
      } else {
        setNow(Date.now())
        start()
      }
    }
    setNow(Date.now())
    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  // New data arrived: re-sync the clock so elapsed time never goes negative.
  useEffect(() => {
    if (receivedAtMs !== null) setNow(Date.now())
  }, [receivedAtMs])

  // 1s countdown timer, only while a cooldown is active.
  useEffect(() => {
    if (fetchEndedAt === null) return
    const tick = () => {
      const t = Date.now()
      setCooldownNow(t)
      if (cooldownRemainingMs(t, fetchEndedAt) <= 0) clearInterval(id)
    }
    const id = setInterval(tick, 1_000)
    setCooldownNow(Date.now())
    return () => clearInterval(id)
  }, [fetchEndedAt])

  const cooldownMs = fetchEndedAt === null ? 0 : cooldownRemainingMs(cooldownNow, fetchEndedAt)
  const coolingDown = cooldownMs > 0
  const secondsLeft = Math.min(COOLDOWN_MS / 1000, Math.max(1, Math.ceil(cooldownMs / 1000)))

  const handleRefresh = async (ignoreCooldown = false) => {
    if (refreshingRef.current || (!ignoreCooldown && coolingDown)) return
    refreshingRef.current = true
    setRefreshing(true)
    try {
      await refresh()
    } finally {
      refreshingRef.current = false
      setRefreshing(false)
      setFetchEndedAt(Date.now())
    }
  }

  if (!data && isLoading) {
    return <div className={`${SKELETON} h-[360px]`} aria-hidden="true" />
  }

  if (!data) {
    return (
      <div className={`${CARD} flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-3 p-3 sm:p-4`}>
        <p className="text-sm text-foreground">
          {error ? 'Couldn’t load delivery status' : 'Delivery status isn’t available right now'}
        </p>
        <button
          type="button"
          onClick={() => void handleRefresh(true)}
          className={`min-h-[44px] rounded-xl bg-ft-blue px-4 text-sm font-medium text-white ${FOCUS_RING}`}
        >
          Try again
        </button>
      </div>
    )
  }

  const offset =
    receivedAtMs === null ? null : ageOffsetSeconds(data.generatedAt, data.serverNow, receivedAtMs, Math.max(now ?? receivedAtMs, receivedAtMs))
  const views = data.networks.map((n) => (offset === null ? n : liveEstimate(n, offset)))
  const selected = views.find((n) => n.key === selectedKey) ?? views[0]

  return (
    <section aria-label="Delivery status" className={`${CARD} p-3 sm:p-4`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Delivery Status</h2>
        <button
          type="button"
          onClick={() => void handleRefresh()}
          disabled={coolingDown}
          aria-disabled={coolingDown}
          aria-label={coolingDown ? `Refresh available in ${secondsLeft}s` : 'Refresh delivery status'}
          className={`flex h-11 min-w-[44px] items-center justify-center gap-1 rounded-xl px-2 text-muted-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent ${FOCUS_RING}`}
        >
          <RefreshCw
            className={`h-4 w-4 ${refreshing ? 'motion-safe:animate-spin' : ''}`}
            aria-hidden="true"
          />
          {coolingDown && !refreshing && (
            <span aria-hidden="true" className="text-[11px] tabular-nums">
              {secondsLeft}s
            </span>
          )}
        </button>
      </div>

      {selected ? (
        <DeliveryCard view={selected} generatedAt={data.generatedAt} />
      ) : (
        <p className="text-sm text-muted-foreground">{NONE_HEADLINE}</p>
      )}

      <h3 className="mb-1 mt-3 text-sm font-semibold">Gateway Strength</h3>
      <div className="flex flex-col gap-1">
        {views.map((n) => (
          <StrengthRow
            key={n.key}
            view={n}
            selected={selected?.key === n.key}
            onSelect={() => setSelectedKey(n.key)}
          />
        ))}
      </div>
    </section>
  )
}
