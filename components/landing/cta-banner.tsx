import Link from 'next/link'
import { ArrowRight, Download, LifeBuoy, MessageSquare } from 'lucide-react'
import { ClayButton, NeuCard } from '@/components/ft'

interface CtaBannerProps {
    whatsappHref: string
    adminPhone: string
}

export function CtaBanner({ whatsappHref, adminPhone }: CtaBannerProps) {
    const external = adminPhone
        ? { target: '_blank', rel: 'noopener noreferrer' }
        : { target: undefined, rel: undefined }

    return (
        <section id="get-started" aria-labelledby="cta-heading" className="ft-lazy scroll-mt-24 px-4 py-16 sm:px-6 lg:px-8">
            <div className="mx-auto max-w-4xl">
                <div className="ft-clay p-8 text-center sm:p-12">
                    <h2 id="cta-heading" className="ft-display text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
                        Ready to buy, resell or become an agent?
                    </h2>
                    <p className="mx-auto mt-3 max-w-xl text-base text-white">
                        One platform for instant purchases, reseller growth and agent opportunities.
                    </p>
                    <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row sm:flex-wrap">
                        <ClayButton asChild variant="soft">
                            <Link href="/auth?tab=signup">
                                Create free account
                                <ArrowRight className="h-5 w-5 shrink-0" aria-hidden="true" />
                            </Link>
                        </ClayButton>
                        <ClayButton asChild variant="soft">
                            <a href={whatsappHref} {...external}>Contact us on WhatsApp</a>
                        </ClayButton>
                        <ClayButton asChild variant="soft">
                            <Link href="/download">
                                <Download className="h-5 w-5 shrink-0" aria-hidden="true" />
                                Get the app
                            </Link>
                        </ClayButton>
                    </div>
                </div>

                <div className="mt-8 grid gap-5 md:grid-cols-2">
                    <NeuCard className="min-w-0 p-6">
                        <span className="ft-clay flex h-11 w-11 items-center justify-center rounded-xl">
                            <LifeBuoy className="h-5 w-5" aria-hidden="true" />
                        </span>
                        <h3 className="ft-display mt-4 text-xl font-extrabold text-ft-ink">Easy support</h3>
                        <p className="mt-2 text-sm leading-relaxed text-[color:var(--ft-muted)]">
                            Get support through WhatsApp and in-app help channels whenever you need guidance.
                        </p>
                        <ClayButton asChild variant="soft" className="mt-5">
                            <a href={whatsappHref} {...external}>Talk to support</a>
                        </ClayButton>
                    </NeuCard>
                    <NeuCard className="min-w-0 p-6">
                        <span className="ft-clay flex h-11 w-11 items-center justify-center rounded-xl">
                            <MessageSquare className="h-5 w-5" aria-hidden="true" />
                        </span>
                        <h3 className="ft-display mt-4 text-xl font-extrabold text-ft-ink">Complaint tracking</h3>
                        <p className="mt-2 text-sm leading-relaxed text-[color:var(--ft-muted)]">
                            Report order issues, follow your complaint status, and get clear updates from your dashboard.
                        </p>
                        <ClayButton asChild variant="soft" className="mt-5">
                            <Link href="/auth">Track complaints</Link>
                        </ClayButton>
                    </NeuCard>
                </div>
            </div>
        </section>
    )
}
