import { Store } from 'lucide-react'
import { ClayButton, NeuCard } from '@/components/ft'
import { NetworkIcon } from '@/components/network-icon'
import { isSafeHref } from '@/components/landing/helpers'

const POINTS = ['Upload logo and banner', 'Customize brand colors', 'Preview before publishing', 'Share one clean shop link']

const SAMPLE = [
    { network: 'MTN', size: '1GB', price: '4.30' },
    { network: 'Telecel', size: '2GB', price: '9.00' },
]

export function StorefrontPreview({ guestUrl }: { guestUrl: string }) {
    return (
        <section aria-labelledby="storefront-heading" className="ft-lazy px-4 py-16 sm:px-6 lg:px-8">
            <div className="mx-auto grid max-w-7xl items-center gap-10 lg:grid-cols-[1fr_1.1fr]">
                <div className="min-w-0">
                    <h2 id="storefront-heading" className="ft-display text-3xl font-extrabold tracking-tight text-ft-ink sm:text-4xl">
                        A storefront with your name on it.
                    </h2>
                    <p className="mt-3 text-base text-[color:var(--ft-muted)]">
                        Your shop can look clean, branded and professional, with a banner, logo, custom colors and clear buy actions.
                    </p>
                    <ul className="mt-6 space-y-3">
                        {POINTS.map(point => (
                            <li key={point} className="flex items-start gap-3 font-semibold text-ft-ink">
                                <span aria-hidden="true" className="ft-clay mt-2 h-2.5 w-2.5 shrink-0 rounded-full" />
                                <span>{point}</span>
                            </li>
                        ))}
                    </ul>
                    {isSafeHref(guestUrl) && (
                        <ClayButton asChild variant="soft" className="mt-8">
                            <a href={guestUrl}>See a live example shop</a>
                        </ClayButton>
                    )}
                </div>

                <NeuCard className="min-w-0 overflow-hidden p-0" role="group" aria-label="Example storefront">
                    <div className="ft-clay-bright flex items-center gap-3 px-5 py-6" style={{ borderBottomLeftRadius: 0, borderBottomRightRadius: 0 }}>
                        <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-white" aria-hidden="true">
                            <Store className="h-7 w-7 text-[#0057FF]" />
                        </span>
                    </div>
                    <div className="p-5">
                        <p className="ft-display break-words text-lg font-extrabold text-ft-ink">Felix&apos;s Data Hub</p>
                        <p className="text-sm text-[color:var(--ft-muted)]">Example shop</p>
                        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
                            {SAMPLE.map(pkg => (
                                <li key={pkg.network} className="ft-inset min-w-0 p-3">
                                    <div className="flex items-center gap-2">
                                        <NetworkIcon network={pkg.network} size={30} />
                                        <span className="font-semibold text-ft-ink">{pkg.size}</span>
                                    </div>
                                    <p className="mt-2 text-xs text-[color:var(--ft-muted)]">
                                        from <span className="font-semibold text-ft-ink">GHS {pkg.price}</span>
                                    </p>
                                </li>
                            ))}
                        </ul>
                        <div className="ft-clay mt-4 flex min-h-12 items-center justify-center px-6 py-2 font-semibold" aria-hidden="true">
                            Buy now
                        </div>
                    </div>
                </NeuCard>
            </div>
        </section>
    )
}
