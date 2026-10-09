import { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { createServerAnonClient } from '@/lib/supabase'
import { ToneText } from '@/components/terms/tone-text'
import { NeuCard } from '@/components/ft'
import { ftFonts } from '@/lib/ft-fonts'
import { FALLBACK_EFFECTIVE_DATE, sectionsForAudience, PLATFORM_BRAND } from '@/lib/terms'

export const metadata: Metadata = {
    title: 'Terms of Service | FameTech',
    description: 'Read the official Terms of Service for FameTech Data and Airtime platform.',
}

// Rendered from the DB single source of truth; an admin publish reflects within a minute.
export const revalidate = 60

export default async function TermsPage() {
    const db = createServerAnonClient() as any
    const { data } = await db
        .from('terms_versions')
        .select('version, effective_date, sections')
        .eq('is_current', true)
        .maybeSingle()

    const sections = sectionsForAudience(data?.sections ?? [], { storefront: false, brand: PLATFORM_BRAND })
    const effectiveDate: string = data?.effective_date ?? FALLBACK_EFFECTIVE_DATE

    return (
        <div className={`ft ${ftFonts.className} ${ftFonts.variable} min-h-screen`}>
            <header className="sticky top-3 z-50 px-3 sm:px-6">
                <div className="ft-raised mx-auto flex max-w-3xl items-center gap-2 rounded-[2rem] px-3 py-2">
                    <Link
                        href="/"
                        aria-label="Back to home"
                        className="ft-inset flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-ft-ink"
                    >
                        <ArrowLeft className="h-5 w-5" aria-hidden="true" />
                    </Link>
                    <span className="ft-display truncate text-base font-extrabold text-ft-ink">Terms of service</span>
                </div>
            </header>

            <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8 sm:px-6">
                <NeuCard className="p-6 sm:p-8">
                    <h1 className="ft-display text-3xl font-extrabold tracking-tight text-ft-ink">Terms and conditions</h1>
                    <p className="mt-3 max-w-prose text-base leading-[1.7] text-[color:var(--ft-muted)]">
                        By using FameTech, you agree to these rules for your account and transactions.
                    </p>
                </NeuCard>

                <NeuCard className="space-y-8 p-6 sm:p-8">
                    {sections.map((s, i) => (
                        <section key={s.id} className="min-w-0">
                            <div className="max-w-prose">
                                <h2 className="ft-display text-lg font-extrabold text-ft-ink">
                                    {i + 1}. {s.title}
                                    {s.badge ? (
                                        <span className="ft-inset ml-2 inline-block rounded-full px-2.5 py-0.5 align-middle text-xs font-semibold text-ft-ink">
                                            {s.badge}
                                        </span>
                                    ) : null}
                                </h2>
                                <p className="mt-2 break-words text-base leading-[1.7] text-[color:var(--ft-muted)]">
                                    <ToneText text={s.body} variant="ft" />
                                </p>
                            </div>
                        </section>
                    ))}
                </NeuCard>

                <p className="pb-10 text-center text-sm text-[color:var(--ft-muted)]">Last updated: {effectiveDate}</p>
            </main>
        </div>
    )
}
