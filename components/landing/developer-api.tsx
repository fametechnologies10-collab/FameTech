import Link from 'next/link'
import { Code2, ExternalLink } from 'lucide-react'
import { ClayButton, NeuCard } from '@/components/ft'

export function DeveloperApi() {
    return (
        <section aria-labelledby="api-heading" className="ft-lazy px-4 py-16 sm:px-6 lg:px-8">
            <NeuCard className="mx-auto flex max-w-5xl flex-col gap-6 p-6 sm:flex-row sm:items-center sm:p-8">
                <span className="ft-clay flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl">
                    <Code2 className="h-7 w-7" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                    <h2 id="api-heading" className="ft-display text-2xl font-extrabold text-ft-ink sm:text-3xl">
                        Build on the Developer API.
                    </h2>
                    <p className="mt-2 max-w-2xl text-base text-[color:var(--ft-muted)]">
                        Integrate FameTech directly into your website or app. Automate data and airtime purchases for your customers via our API.
                    </p>
                </div>
                <ClayButton asChild variant="soft" className="shrink-0">
                    <Link href="/developers">
                        View docs
                        <ExternalLink className="h-4 w-4 shrink-0" aria-hidden="true" />
                    </Link>
                </ClayButton>
            </NeuCard>
        </section>
    )
}
