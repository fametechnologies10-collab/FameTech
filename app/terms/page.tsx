import { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft, BookOpen } from 'lucide-react'
import { createServerAnonClient } from '@/lib/supabase'
import { ToneText } from '@/components/terms/tone-text'
import { FALLBACK_EFFECTIVE_DATE, sectionsForAudience, PLATFORM_BRAND } from '@/lib/terms'

export const metadata: Metadata = {
    title: 'Terms of Service | KiNG FLEXY GH',
    description: 'Read the official Terms of Service for KiNG FLEXY GH Data and Airtime platform.',
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
        <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col pt-16 transition-colors duration-300">
            {/* Header */}
            <div className="fixed top-0 left-0 w-full z-50 shadow-sm bg-slate-900 dark:bg-black h-14 flex items-center px-4">
                <div className="max-w-3xl mx-auto w-full flex items-center gap-3">
                    <Link href="/" className="p-1.5 bg-white/10 hover:bg-white/20 rounded-lg text-white transition-colors">
                        <ArrowLeft className="w-5 h-5" />
                    </Link>
                    <span className="text-white font-bold text-sm tracking-widest uppercase opacity-90">Terms of Service</span>
                </div>
            </div>

            <div className="flex-1 w-full max-w-3xl mx-auto px-4 py-8 space-y-8">
                {/* Hero */}
                <div className="bg-white dark:bg-slate-900 rounded-[2rem] p-6 sm:p-8 shadow-sm border border-slate-100 dark:border-slate-800 text-center relative overflow-hidden">
                    <div className="absolute top-0 left-0 w-full h-24 bg-sky-500 opacity-10" />
                    <div className="relative z-10 flex flex-col items-center">
                        <div className="w-20 h-20 rounded-3xl shadow-xl border-4 border-white mb-4 bg-slate-900 flex items-center justify-center text-white">
                            <BookOpen className="w-8 h-8" />
                        </div>
                        <h1 className="text-2xl font-black text-slate-900 dark:text-white capitalize">Terms &amp; Conditions</h1>
                        <p className="mt-3 text-sm font-medium text-slate-500 dark:text-slate-400 max-w-sm mx-auto leading-relaxed">
                            Welcome to KiNG FLEXY GH. By using our platform, you agree to these fundamental rules governing your account and transactions.
                        </p>
                    </div>
                </div>

                {/* Terms content (single-sourced from the DB) */}
                <div className="bg-white dark:bg-slate-900 rounded-3xl p-6 sm:p-8 shadow-sm border border-slate-100 dark:border-slate-800">
                    <div className="space-y-7">
                        {sections.map((s, i) => (
                            <div key={s.id}>
                                <h3 className="text-base font-black text-slate-900 dark:text-white mb-1">
                                    {i + 1}. {s.title}
                                    {s.badge ? (
                                        <span className="ml-2 align-middle text-[9px] font-black uppercase tracking-wide text-yellow-600 border border-yellow-600 rounded px-1.5 py-0.5">
                                            {s.badge}
                                        </span>
                                    ) : null}
                                </h3>
                                <p className="text-sm font-medium text-slate-500 dark:text-slate-400 leading-relaxed">
                                    <ToneText text={s.body} />
                                </p>
                            </div>
                        ))}
                    </div>
                </div>

                <div className="text-center pb-10">
                    <p className="text-sm text-slate-400">Last updated: {effectiveDate}</p>
                </div>
            </div>
        </div>
    )
}
