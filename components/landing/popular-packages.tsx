'use client'

import { useState } from 'react'
import { NeuCard } from '@/components/ft'
import { SegmentedControl } from '@/components/ft/segmented-control'
import { NetworkIcon } from '@/components/network-icon'
import type { LandingDataPackage } from '@/components/landing/helpers'

export function PopularPackages({ entries }: { entries: [string, LandingDataPackage[]][] }) {
    const [active, setActive] = useState<string>(entries[0]?.[0] ?? '')

    if (entries.length === 0) return null
    const current = entries.find(([network]) => network === active) ?? entries[0]
    const [network, packages] = current

    return (
        <section aria-labelledby="packages-heading" className="ft-lazy px-4 py-16 sm:px-6 lg:px-8">
            <div className="mx-auto max-w-7xl">
                <h2 id="packages-heading" className="ft-display max-w-2xl text-3xl font-extrabold tracking-tight text-ft-ink sm:text-4xl">
                    Popular data packages.
                </h2>
                <p className="mt-3 max-w-2xl text-base text-[color:var(--ft-muted)]">
                    Prices are updated by our team.
                </p>

                <div className="mt-8 overflow-x-auto">
                    <SegmentedControl
                        ariaLabel="Network"
                        value={network}
                        onChange={setActive}
                        options={entries.map(([name]) => ({ value: name, label: name }))}
                        className="w-max min-w-full"
                    />
                </div>

                <ul className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                    {packages.map((pkg, index) => (
                        <li key={`${network}-${pkg.volume}-${pkg.price}-${index}`} className="min-w-0">
                            <NeuCard className="flex flex-col items-center p-6 text-center">
                                <NetworkIcon network={network} size={48} />
                                <p className="ft-display mt-3 break-words text-lg font-extrabold text-ft-ink">{pkg.volume}</p>
                                <p className="mt-2 text-sm text-[color:var(--ft-muted)]">for as low as</p>
                                <p className="ft-display break-words text-xl font-extrabold text-ft-ink">GHS {pkg.price}</p>
                            </NeuCard>
                        </li>
                    ))}
                </ul>
            </div>
        </section>
    )
}
