import Link from 'next/link'
import {
  AlertCircle,
  FileText,
  Package,
  Phone,
  ShoppingCart,
  Star,
  Store,
  UserPlus,
  Wallet,
  type LucideIcon,
} from 'lucide-react'

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ft-blue focus-visible:ring-offset-2 focus-visible:ring-offset-background'

interface Tile {
  href: string
  label: string
  Icon: LucideIcon
  id?: string
}

const LARGE_TILES: Tile[] = [
  { href: '/dashboard/data-packages', label: 'Buy data', Icon: Package, id: 'data-packages' },
  { href: '/dashboard/airtime', label: 'Buy airtime', Icon: Phone },
]

const COMPACT_TILES: Tile[] = [
  { href: '/dashboard/my-orders', label: 'Orders', Icon: ShoppingCart, id: 'order-history' },
  { href: '/dashboard/wallet', label: 'Top up', Icon: Wallet },
  { href: '/dashboard/complaints', label: 'Support', Icon: AlertCircle, id: 'complaint-button' },
  { href: '/dashboard/afa-orders', label: 'AFA orders', Icon: Star },
  { href: '/dashboard/results-checker', label: 'Vouchers', Icon: FileText },
  { href: '/dashboard/shop', label: 'My shop', Icon: Store },
]

const SUB_AGENTS_TILE: Tile = {
  href: '/dashboard/recruit',
  label: 'Sub-agents',
  Icon: UserPlus,
}

export function QuickActions({ showSubAgents }: { showSubAgents: boolean }) {
  const compact = showSubAgents ? [...COMPACT_TILES, SUB_AGENTS_TILE] : COMPACT_TILES

  return (
    <section className="flex flex-col gap-2 sm:gap-3 bg-card border border-border rounded-xl p-3 sm:p-4">
      <h2 className="text-sm font-semibold">Quick actions</h2>

      <div className="grid grid-cols-2 gap-2 sm:gap-3">
        {LARGE_TILES.map(({ href, label, Icon, id }) => (
          <Link
            key={href}
            href={href}
            id={id}
            className={`flex min-h-14 min-w-0 items-center justify-center gap-2 rounded-xl bg-ft-blue px-2 text-white transition-colors hover:bg-ft-blue/90 ${FOCUS_RING}`}
          >
            <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 break-words text-sm font-semibold leading-tight">{label}</span>
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-4 gap-2 sm:gap-3">
        {compact.map(({ href, label, Icon, id }) => (
          <Link
            key={href}
            href={href}
            id={id}
            className={`flex min-h-16 min-w-0 flex-col items-center gap-1 rounded-xl border border-border bg-card p-2 px-1 transition-colors hover:bg-muted/60 ${FOCUS_RING}`}
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted">
              <Icon className="h-4 w-4 text-ft-blue" aria-hidden="true" />
            </span>
            <span className="min-w-0 max-w-full break-words text-center text-[11px] leading-tight">
              {label}
            </span>
          </Link>
        ))}
      </div>
    </section>
  )
}
