import { NeuTray } from '@/components/ft'
import { NetworkIcon } from '@/components/network-icon'

const NETWORKS = [
    { key: 'MTN', label: 'MTN' },
    { key: 'Telecel', label: 'Telecel' },
    { key: 'AT', label: 'AirtelTigo' },
]

export function NetworkTrough() {
    return (
        <section aria-labelledby="networks-heading" className="ft-lazy px-4 pb-16 sm:px-6 lg:px-8">
            <NeuTray className="mx-auto max-w-4xl p-4 sm:p-5">
                <h2 id="networks-heading" className="mb-3 text-center text-sm font-semibold text-[color:var(--ft-muted)]">
                    Supported networks
                </h2>
                <ul className="flex flex-wrap items-center justify-center gap-3">
                    {NETWORKS.map(n => (
                        <li key={n.key} className="ft-raised flex min-h-12 items-center gap-3 rounded-full px-5 py-2 font-semibold text-ft-ink">
                            <NetworkIcon network={n.key} size={32} />
                            {n.label}
                        </li>
                    ))}
                </ul>
            </NeuTray>
        </section>
    )
}
