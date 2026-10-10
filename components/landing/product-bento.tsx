import Link from 'next/link'
import type { LucideIcon } from 'lucide-react'
import {
    ArrowRight,
    BadgeCheck,
    Boxes,
    Code2,
    Crown,
    GraduationCap,
    MessageSquare,
    Smartphone,
    Store,
    Users,
    Wallet,
    Zap,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { NetworkIcon } from '@/components/network-icon'

interface Tile {
    title: string
    desc: string
    href: string
    icon: LucideIcon
    className?: string
    networks?: boolean
}

const NETWORK_CHIPS = [
    { key: 'MTN', label: 'MTN' },
    { key: 'Telecel', label: 'Telecel' },
    { key: 'AT', label: 'AirtelTigo' },
]

const TILES: Tile[] = [
    {
        title: 'Data bundles',
        desc: 'High-speed MTN, Telecel, and AT data packages at wholesale reseller rates.',
        href: '/dashboard/data-packages',
        icon: Boxes,
        className: 'lg:col-span-3 lg:row-span-2',
        networks: true,
    },
    {
        title: 'Airtime top-up',
        desc: 'Instant VTU airtime recharge for all networks with direct phone delivery.',
        href: '/dashboard/airtime',
        icon: Smartphone,
        className: 'lg:col-span-3',
    },
    {
        title: 'Result checkers',
        desc: 'Purchase WAEC BECE and WASSCE results check vouchers instantly.',
        href: '/dashboard/results-checker',
        icon: GraduationCap,
        className: 'lg:col-span-3',
    },
    {
        title: 'Bill payment',
        desc: 'Pay ECG, Ghana Water, and other utility bills instantly from your wallet.',
        href: '/dashboard/utilities',
        icon: Zap,
        className: 'lg:col-span-2',
    },
    {
        title: 'Bulk SMS',
        desc: 'Bulk & transactional SMS for OTPs, alerts, and campaigns, sent in seconds.',
        href: '/sms',
        icon: MessageSquare,
        className: 'lg:col-span-2',
    },
    {
        title: 'AFA registration',
        desc: 'Seamless MTN AFA registration and renewals for community field agents.',
        href: '/dashboard/upgrade',
        icon: BadgeCheck,
        className: 'lg:col-span-2',
    },
]

const MORE: Omit<Tile, 'className'>[] = [
    { title: 'MTN Mashup', desc: 'Custom voice and data combination bundles on any MTN line.', href: '/dashboard/data-packages', icon: Crown },
    { title: 'Reseller shops', desc: 'Set up your own branded online shop.', href: '/dashboard/shop', icon: Store },
    { title: 'Developer API', desc: 'Automate and scale purchases via our REST API.', href: '/developers', icon: Code2 },
    { title: 'Send & claim', desc: 'Wallet-to-wallet transfers to share platform balance.', href: '/dashboard/wallet', icon: Wallet },
    { title: 'Sub-agent program', desc: 'Recruit sub-agents and earn from their sales.', href: '/dashboard/recruit', icon: Users },
]

function IconBadge({ icon: Icon }: { icon: LucideIcon }) {
    return (
        <span className="ft-clay flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl">
            <Icon className="h-6 w-6" aria-hidden="true" />
        </span>
    )
}

export function ProductBento() {
    return (
        <section id="products" aria-labelledby="products-heading" className="ft-lazy scroll-mt-24 px-4 py-16 sm:px-6 lg:px-8">
            <div className="mx-auto max-w-7xl">
                <h2 id="products-heading" className="ft-display max-w-2xl text-3xl font-extrabold tracking-tight text-ft-ink sm:text-4xl">
                    Everything you top up, in one place.
                </h2>
                <p className="mt-3 max-w-2xl text-base text-[color:var(--ft-muted)]">
                    Fully automated digital services, paid straight from your wallet.
                </p>

                <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-6">
                    {TILES.map(tile => (
                        <Link
                            key={tile.title}
                            href={tile.href}
                            className={cn(
                                'ft-raised group flex min-w-0 flex-col justify-between gap-6 p-6 text-ft-ink transition-colors hover:text-ft-blue dark:hover:text-[color:var(--ft-cyan)]',
                                tile.className
                            )}
                        >
                            <div className="min-w-0">
                                <IconBadge icon={tile.icon} />
                                <h3 className="ft-display mt-4 text-xl font-extrabold">{tile.title}</h3>
                                <p className="mt-2 text-sm leading-relaxed text-[color:var(--ft-muted)]">{tile.desc}</p>
                            </div>
                            {tile.networks && (
                                <ul className="flex flex-wrap gap-3">
                                    {NETWORK_CHIPS.map(n => (
                                        <li key={n.key} className="ft-raised flex min-h-12 items-center gap-3 rounded-full px-4 py-2 font-semibold text-ft-ink">
                                            <NetworkIcon network={n.key} size={32} />
                                            {n.label}
                                        </li>
                                    ))}
                                </ul>
                            )}
                            <span className="inline-flex items-center gap-1 text-sm font-semibold underline-offset-4 group-hover:underline">
                                Open
                                <ArrowRight className="h-4 w-4" aria-hidden="true" />
                            </span>
                        </Link>
                    ))}
                </div>

                <h3 className="ft-display mt-12 text-lg font-extrabold text-ft-ink">More from FameTech</h3>
                <div className="ft-raised mt-4 grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-5">
                    {MORE.map(item => (
                        <Link
                            key={item.title}
                            href={item.href}
                            className="ft-raised flex min-h-12 min-w-0 flex-col gap-2 p-4 text-ft-ink transition-colors hover:text-ft-blue hover:underline dark:hover:text-[color:var(--ft-cyan)]"
                        >
                            <span className="flex items-center gap-2">
                                <item.icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                                <span className="font-semibold">{item.title}</span>
                            </span>
                            <span className="text-xs leading-relaxed text-[color:var(--ft-muted)]">{item.desc}</span>
                        </Link>
                    ))}
                </div>
            </div>
        </section>
    )
}
