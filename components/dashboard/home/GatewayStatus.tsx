'use client'

import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useGatewayStatus } from '@/hooks/use-gateway-status'
import { BAND_LABEL, type GatewayNetwork } from '@/lib/gateway-health'
import {
  BAND_FILL_CLASS,
  BAND_HEADLINE,
  BAND_TEXT_CLASS,
  formatClockTime,
  formatMinutes,
} from '@/lib/gateway-status-format'

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ft-blue focus-visible:ring-offset-2 focus-visible:ring-offset-background'
const SKELETON = 'bg-muted rounded-xl motion-safe:animate-pulse'
const CARD = 'rounded-xl border border-border bg-card'

// Simple brand-tinted initial avatars (no image assets).
const AVATAR_CLASS: Record<string, string> = {
  MTN: 'bg-yellow-400 text-black',
  Telecel: 'bg-red-600 text-white',
  'AT-iShare': 'bg-blue-600 text-white',
  'AT-BigTime': 'bg-sky-600 text-white',
}

function Avatar({ network }: { network: GatewayNetwork }) {
  const cls = AVATAR_CLASS[network.key] ?? 'bg-muted text-foreground'
  return (
    <span
      aria-hidden="true"
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-bold ${cls}`}
    >
      {network.label.charAt(0).toUpperCase()}
    </span>
  )
}

function DeliveryCard({ network, generatedAt }: { network: GatewayNetwork; generatedAt: string }) {
  const hasDelivery = network.band !== 'none'
  const showLast = hasDelivery && network.lastMinutes !== null
  const showTimes = hasDelivery && !!network.lastPlacedAt && !!network.lastDeliveredAt
  const updated = generatedAt ? formatClockTime(generatedAt) : ''

  return (
    <div className="flex flex-col gap-1.5 rounded-lg bg-muted/50 p-3">
      <div className="flex items-center gap-2">
        <Avatar network={network} />
        <span className="text-sm font-medium truncate">{network.label}</span>
      </div>
      <p className={`text-base font-semibold ${BAND_TEXT_CLASS[network.band]}`}>
        {BAND_HEADLINE[network.band]}
      </p>
      {hasDelivery && network.medianMinutes !== null && (
        <p className="text-sm">Current processing time: {formatMinutes(network.medianMinutes)}</p>
      )}
      {showLast && (
        <p className="text-sm text-muted-foreground">
          Last delivery took {formatMinutes(network.lastMinutes)}
        </p>
      )}
      {showTimes && (
        <p className="text-sm text-muted-foreground">
          Placed {formatClockTime(network.lastPlacedAt)} → Delivered{' '}
          {formatClockTime(network.lastDeliveredAt)}
        </p>
      )}
      <p className="text-[11px] text-muted-foreground">
        Based on recent deliveries{updated && updated !== '—' ? ` · Updated ${updated}` : ''}
      </p>
    </div>
  )
}

function StrengthRow({
  network,
  selected,
  onSelect,
}: {
  network: GatewayNetwork
  selected: boolean
  onSelect: () => void
}) {
  const pct = Math.max(0, Math.min(100, network.barPct))
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
          <Avatar network={network} />
          <span className="text-sm font-medium truncate">{network.label}</span>
        </span>
        {network.band !== 'none' && network.lastMinutes !== null && (
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
            Last delivery took {formatMinutes(network.lastMinutes)}
          </span>
        )}
      </span>
      <span
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${network.label} delivery health: ${BAND_LABEL[network.band]}`}
        className="block h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <span
          className={`block h-full rounded-full motion-safe:transition-[width] motion-safe:duration-500 ${BAND_FILL_CLASS[network.band]}`}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className={`text-[11px] ${BAND_TEXT_CLASS[network.band]}`}>{BAND_LABEL[network.band]}</span>
    </button>
  )
}

export function GatewayStatus() {
  const { data, isLoading, error, refresh } = useGatewayStatus()
  const [selectedKey, setSelectedKey] = useState('MTN')
  const [refreshing, setRefreshing] = useState(false)

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      await refresh()
    } finally {
      setRefreshing(false)
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
          onClick={() => void handleRefresh()}
          className={`min-h-[44px] rounded-xl bg-ft-blue px-4 text-sm font-medium text-white ${FOCUS_RING}`}
        >
          Try again
        </button>
      </div>
    )
  }

  const networks = data.networks
  const selected = networks.find((n) => n.key === selectedKey) ?? networks[0]

  return (
    <section aria-label="Delivery status" className={`${CARD} p-3 sm:p-4`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Delivery Status</h2>
        <button
          type="button"
          onClick={() => void handleRefresh()}
          aria-label="Refresh delivery status"
          className={`flex h-11 w-11 items-center justify-center rounded-xl text-muted-foreground hover:bg-muted ${FOCUS_RING}`}
        >
          <RefreshCw
            className={`h-4 w-4 ${refreshing ? 'motion-safe:animate-spin' : ''}`}
            aria-hidden="true"
          />
        </button>
      </div>

      {selected ? (
        <DeliveryCard network={selected} generatedAt={data.generatedAt} />
      ) : (
        <p className="text-sm text-muted-foreground">No recent orders</p>
      )}

      <h3 className="mb-1 mt-3 text-sm font-semibold">Gateway Strength</h3>
      <div className="flex flex-col gap-1">
        {networks.map((n) => (
          <StrengthRow
            key={n.key}
            network={n}
            selected={selected?.key === n.key}
            onSelect={() => setSelectedKey(n.key)}
          />
        ))}
      </div>
    </section>
  )
}
