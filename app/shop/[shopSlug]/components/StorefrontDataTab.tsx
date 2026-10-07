'use client'
import { useMemo, useState } from 'react'
import { Search, LayoutGrid, List, Wifi } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatCurrency } from '@/lib/utils'
import { MtnWhitelistInlineCheck } from '@/components/mtn-whitelist-checker'
import { NetworkSelectorCard } from './NetworkSelectorCard'
import { PackageCard, type StorefrontPackage } from './PackageCard'
import { ServiceChargeSheet, type ChargeDescriptor } from './ServiceChargeSheet'

const NETWORK_ORDER = ['MTN', 'Telecel', 'AT-iShare', 'AT-BigTime', 'AT']

export function StorefrontDataTab({ shopSlug, packages, oosNetworks = [], brandName }: { shopSlug: string; packages: StorefrontPackage[]; oosNetworks?: string[]; brandName: string }) {
    // Only show the known Ghana networks. A package whose network is outside this set is a
    // data error and has no fulfillment supplier (it would charge then sit stuck pending),
    // so it must not be sellable on the storefront.
    const networks = NETWORK_ORDER.filter(n => packages.some(p => p.network === n))

    const [network, setNetwork] = useState(networks[0] || '')
    const [search, setSearch] = useState('')
    const [view, setView] = useState<'grid' | 'list'>('grid')
    const [selected, setSelected] = useState<StorefrontPackage | null>(null)
    const [sheetOpen, setSheetOpen] = useState(false)

    const filtered = useMemo(() => packages
        .filter(p => p.network === network)
        .filter(p => !search || `${p.size} ${p.description ?? ''}`.toLowerCase().includes(search.toLowerCase())),
        [packages, network, search])

    const openCheckout = (pkg: StorefrontPackage) => {
        setSelected(pkg); setSheetOpen(true)
    }

    // Memoized so its identity is STABLE across parent re-renders (e.g. the storefront's
    // visibilitychange/bfcache router.refresh()). A fresh object each render would re-fire the
    // sheet's reset effect and wipe an in-progress checkout when the guest returns from
    // approving the MoMo prompt. Only rebuild when the selected package or shop changes.
    const dataDescriptor: ChargeDescriptor | null = useMemo(() => selected ? {
        title: `${selected.network} · ${selected.size}`,
        network: selected.network,
        amountLabel: formatCurrency(selected.selling_price),
        chargeUrl: '/api/shop/charge',
        statusUrl: '/api/shop/charge/status',
        beneficiary: { label: 'Beneficiary number', hint: '(gets the data)' },
        email: { hint: '(for receipt — optional)' },
        successText: ({ beneficiary, momoPhone }) => `${selected.network} ${selected.size} is being delivered to ${beneficiary || momoPhone}.`,
        buildBody: ({ beneficiary, momoPhone, provider, email }) => ({
            shopSlug, packageId: selected.id, guestPhone: beneficiary, guestEmail: email, momoPhone, momoProvider: provider,
        }),
    } : null, [selected, shopSlug])

    return (
        <div className="space-y-4">
            <div className="grid grid-cols-4 gap-2">
                {networks.map(n => (
                    <NetworkSelectorCard key={n} network={n} selected={network === n} onClick={() => setNetwork(n)} />
                ))}
            </div>

            {/* MTN delivery is gated behind a registration list — let the guest check before paying */}
            {network === 'MTN' && <MtnWhitelistInlineCheck />}

            <div className="flex gap-2">
                <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                    <input placeholder="Search packages…" value={search} onChange={e => setSearch(e.target.value)}
                        className="w-full pl-9 h-10 rounded-lg border border-border bg-background text-sm text-foreground" />
                </div>
                <div className="flex border border-border rounded-lg overflow-hidden">
                    <button onClick={() => setView('grid')} title="Grid view"
                        className={cn('px-2.5 py-2 transition-colors', view === 'grid' ? 'bg-foreground text-background' : 'hover:bg-muted text-muted-foreground')}>
                        <LayoutGrid className="w-4 h-4" />
                    </button>
                    <button onClick={() => setView('list')} title="List view"
                        className={cn('px-2.5 py-2 border-l border-border transition-colors', view === 'list' ? 'bg-foreground text-background' : 'hover:bg-muted text-muted-foreground')}>
                        <List className="w-4 h-4" />
                    </button>
                </div>
            </div>

            {oosNetworks.includes(network) ? (
                <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
                    <Wifi className="w-10 h-10 opacity-30" />
                    <p className="text-sm font-semibold">{network} is Out of Stock at the Moment</p>
                </div>
            ) : filtered.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
                    <Wifi className="w-10 h-10 opacity-30" /><p className="text-sm">No packages found</p>
                </div>
            ) : view === 'grid' ? (
                <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
                    {filtered.map(pkg => <PackageCard key={pkg.id} pkg={pkg} view="grid" onClick={() => openCheckout(pkg)} />)}
                </div>
            ) : (
                <div className="space-y-2">
                    {filtered.map(pkg => <PackageCard key={pkg.id} pkg={pkg} view="list" onClick={() => openCheckout(pkg)} />)}
                </div>
            )}

            <ServiceChargeSheet
                open={sheetOpen} onClose={() => setSheetOpen(false)}
                descriptor={dataDescriptor}
                brandName={brandName}
            />
        </div>
    )
}
