import { CreditCard, Wallet, Zap, type LucideIcon } from 'lucide-react'
import { NeuCard, NeuTray } from '@/components/ft'

const ITEMS: { title: string; desc: string; icon: LucideIcon }[] = [
    { title: 'Top up', desc: 'Add funds quickly with trusted payment options.', icon: CreditCard },
    { title: 'Store balance', desc: 'Your wallet stays ready for purchases any time.', icon: Wallet },
    { title: 'Buy instantly', desc: 'Check out in seconds for data and airtime.', icon: Zap },
]

const EXTRAS = [
    'A clear transaction trail on every wallet payment',
    'Order statuses and full history in your dashboard',
    'Buy, manage and track orders at any time of day',
]

export function WalletSection() {
    return (
        <section id="wallet" aria-labelledby="wallet-heading" className="ft-lazy scroll-mt-24 px-4 py-16 sm:px-6 lg:px-8">
            <div className="mx-auto max-w-7xl">
                <h2 id="wallet-heading" className="ft-display max-w-2xl text-3xl font-extrabold tracking-tight text-ft-ink sm:text-4xl">
                    One wallet pays for everything.
                </h2>
                <p className="mt-3 max-w-2xl text-base text-[color:var(--ft-muted)]">
                    Fund once and check out faster.
                </p>
                <div className="mt-10 grid gap-5 sm:grid-cols-3">
                    {ITEMS.map(item => (
                        <NeuCard key={item.title} className="min-w-0 p-6">
                            <span className="ft-clay flex h-12 w-12 items-center justify-center rounded-2xl">
                                <item.icon className="h-6 w-6" aria-hidden="true" />
                            </span>
                            <h3 className="ft-display mt-4 text-xl font-extrabold text-ft-ink">{item.title}</h3>
                            <p className="mt-2 text-sm leading-relaxed text-[color:var(--ft-muted)]">{item.desc}</p>
                        </NeuCard>
                    ))}
                </div>
                <NeuTray className="mt-6 p-4 sm:p-5">
                    <ul className="grid gap-3 sm:grid-cols-3">
                        {EXTRAS.map(text => (
                            <li key={text} className="flex min-w-0 items-start gap-2 text-sm font-semibold text-ft-ink">
                                <span aria-hidden="true" className="ft-clay mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full" />
                                <span>{text}</span>
                            </li>
                        ))}
                    </ul>
                </NeuTray>
            </div>
        </section>
    )
}
