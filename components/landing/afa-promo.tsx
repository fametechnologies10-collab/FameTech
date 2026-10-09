import Link from 'next/link'
import { ArrowRight, BadgeCheck } from 'lucide-react'
import { ClayButton, NeuCard } from '@/components/ft'

const POINTS = ['Permanent agent membership', 'Wallet-funded application']

export function AfaPromo() {
    return (
        <section id="afa" aria-labelledby="afa-heading" className="ft-lazy scroll-mt-24 px-4 py-16 sm:px-6 lg:px-8">
            <div className="mx-auto grid max-w-7xl items-center gap-8 lg:grid-cols-[1.2fr_1fr]">
                <div className="min-w-0">
                    <h2 id="afa-heading" className="ft-display text-3xl font-extrabold tracking-tight text-ft-ink sm:text-4xl">
                        Become an authorized field agent.
                    </h2>
                    <p className="mt-3 text-base text-[color:var(--ft-muted)]">
                        Join the MTN AFA registration program through your dashboard. Submit your details, pay from your wallet, and track your application status.
                    </p>
                    <ul className="mt-6 space-y-3">
                        {POINTS.map(point => (
                            <li key={point} className="flex items-start gap-3 font-semibold text-ft-ink">
                                <BadgeCheck className="mt-0.5 h-5 w-5 shrink-0 text-ft-blue dark:text-[color:var(--ft-cyan)]" aria-hidden="true" />
                                <span>{point}</span>
                            </li>
                        ))}
                    </ul>
                    <ClayButton asChild className="mt-8">
                        <Link href="/auth?tab=signup">
                            Apply now
                            <ArrowRight className="h-4 w-4 shrink-0" aria-hidden="true" />
                        </Link>
                    </ClayButton>
                </div>
                <NeuCard className="min-w-0 p-6">
                    <span className="ft-clay flex h-12 w-12 items-center justify-center rounded-2xl">
                        <BadgeCheck className="h-6 w-6" aria-hidden="true" />
                    </span>
                    <h3 className="ft-display mt-4 text-xl font-extrabold text-ft-ink">AFA pathway</h3>
                    <p className="mt-2 text-sm leading-relaxed text-[color:var(--ft-muted)]">
                        Designed for users who want field-level credibility and a clear registration process with permanent membership status.
                    </p>
                </NeuCard>
            </div>
        </section>
    )
}
