import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { ClayButton, NeuCard, Orbit } from '@/components/ft'
import { NetworkIcon } from '@/components/network-icon'
import { isSafeHref, type PackagesByNetwork } from '@/components/landing/helpers'

interface HeroProps {
    customerCountLabel: string
    guestUrl: string
    packagesByNetwork: PackagesByNetwork
}

const PREVIEW_NETWORKS = [
    { key: 'MTN', label: 'MTN' },
    { key: 'Telecel', label: 'Telecel' },
    { key: 'AT', label: 'AirtelTigo' },
]

const SAMPLE_SIZES = ['1GB', '5GB', '10GB']

export function Hero({ customerCountLabel, guestUrl, packagesByNetwork }: HeroProps) {
    // Prices only appear when the admin supplied real ones; otherwise sizes only.
    const live = (packagesByNetwork.MTN ?? []).slice(0, 3)
    const rows = live.length > 0
        ? live.map(p => ({ size: p.volume, price: p.price }))
        : SAMPLE_SIZES.map(size => ({ size, price: '' }))

    return (
        <section className="relative overflow-hidden px-4 pb-16 pt-10 sm:px-6 sm:pb-24 sm:pt-16 lg:px-8">
            <div className="mx-auto grid max-w-7xl items-center gap-12 lg:grid-cols-[1.1fr_0.9fr]">
                <div className="min-w-0">
                    <h1 className="ft-display break-words text-4xl font-extrabold leading-[1.08] tracking-tight text-ft-ink sm:text-5xl lg:text-6xl">
                        Data that lands before you blink.
                    </h1>
                    <p className="mt-5 max-w-xl text-lg leading-relaxed text-[color:var(--ft-muted)]">
                        MTN, Telecel and AirtelTigo bundles, airtime, result checkers and bills. Paid from your wallet in seconds.
                    </p>
                    <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                        <ClayButton asChild>
                            <Link href="/auth?tab=signup">
                                Start buying
                                <ArrowRight className="h-4 w-4 shrink-0" aria-hidden="true" />
                            </Link>
                        </ClayButton>
                        {isSafeHref(guestUrl) && (
                            <ClayButton asChild variant="soft">
                                <a href={guestUrl}>Buy as guest</a>
                            </ClayButton>
                        )}
                    </div>
                    <p className="mt-6 text-sm font-semibold text-[color:var(--ft-muted)]">
                        Trusted by {customerCountLabel} customers across Ghana
                    </p>
                </div>

                <div className="relative mx-auto w-full min-w-0 max-w-md">
                    <div aria-hidden="true" className="pointer-events-none absolute left-1/2 top-1/2 w-[140%] -translate-x-1/2 -translate-y-1/2">
                        <Orbit className="w-full" />
                    </div>
                    <NeuCard className="relative z-10 p-6">
                        <div className="flex items-center justify-between gap-3">
                            <h2 className="ft-display text-lg font-extrabold text-ft-ink">Quick buy</h2>
                            <span className="ft-inset px-3 py-1 text-xs font-semibold text-[color:var(--ft-muted)]">Preview</span>
                        </div>
                        <ul className="mt-4 flex flex-wrap gap-2" aria-label="Networks">
                            {PREVIEW_NETWORKS.map(n => (
                                <li key={n.key} className="ft-inset flex min-h-12 items-center gap-2 px-3 text-sm font-semibold text-ft-ink">
                                    <NetworkIcon network={n.key} size={24} />
                                    {n.label}
                                </li>
                            ))}
                        </ul>
                        <ul className="mt-4 space-y-2" aria-label="Sample bundles">
                            {rows.map(row => (
                                <li key={row.size} className="ft-inset flex min-h-12 items-center justify-between gap-3 px-4 text-ft-ink">
                                    <span className="font-semibold">{row.size}</span>
                                    {row.price && <span className="text-sm font-semibold text-[color:var(--ft-muted)]">GH₵ {row.price}</span>}
                                </li>
                            ))}
                        </ul>
                        <ClayButton asChild className="mt-5 w-full">
                            <Link href="/auth?tab=signup">Create account to buy</Link>
                        </ClayButton>
                    </NeuCard>
                </div>
            </div>
        </section>
    )
}
