import { CreditCard, ShoppingCart, UserPlus, type LucideIcon } from 'lucide-react'
import { NeuCard } from '@/components/ft'

const STEPS: { title: string; desc: string; icon: LucideIcon }[] = [
    { title: 'Create an account', desc: 'Sign up with your phone and basic details.', icon: UserPlus },
    { title: 'Fund your wallet', desc: 'Top up once and stay ready to buy any time.', icon: CreditCard },
    { title: 'Buy', desc: 'Choose a bundle, enter the number, and get it delivered.', icon: ShoppingCart },
]

export function HowItWorks() {
    return (
        <section aria-labelledby="how-heading" className="ft-lazy px-4 py-16 sm:px-6 lg:px-8">
            <div className="mx-auto max-w-7xl">
                <h2 id="how-heading" className="ft-display max-w-2xl text-3xl font-extrabold tracking-tight text-ft-ink sm:text-4xl">
                    Start in minutes, buy in seconds.
                </h2>
                <ol className="mt-10 grid gap-5 md:grid-cols-3">
                    {STEPS.map((step, i) => (
                        <li key={step.title} className="min-w-0">
                            <NeuCard className="h-full p-6">
                                <div className="flex items-center gap-4">
                                    <span className="ft-clay ft-display flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-xl font-extrabold">
                                        <span className="sr-only">Step </span>
                                        {i + 1}
                                    </span>
                                    <step.icon className="h-6 w-6 shrink-0 text-ft-ink" aria-hidden="true" />
                                </div>
                                <h3 className="ft-display mt-4 break-words text-xl font-extrabold text-ft-ink">{step.title}</h3>
                                <p className="mt-2 text-sm leading-relaxed text-[color:var(--ft-muted)]">{step.desc}</p>
                            </NeuCard>
                        </li>
                    ))}
                </ol>
            </div>
        </section>
    )
}
