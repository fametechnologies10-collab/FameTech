'use client'

import Link from 'next/link'
import { motion, useReducedMotion } from 'framer-motion'
import { Code2, ArrowRight, PhoneCall } from 'lucide-react'

export interface ActiveWebsiteRequest {
    id: string
    status: 'new' | 'contacted' | 'closed'
    request_type: 'full_request' | 'call_request'
    created_at: string
}

// Display-only highlights for the banner — a teaser, not the canonical list.
// The full set of categories lives in lib/website-request-categories.ts and is
// what the request form itself renders.
const HIGHLIGHTS = ['Online store', 'Booking site', 'Business site', 'Mobile app']

export function WebsiteRequestBanner({ activeRequest }: { activeRequest: ActiveWebsiteRequest | null }) {
    const reduceMotion = useReducedMotion()

    const shell =
        'relative overflow-hidden rounded-2xl border p-5 shadow-sm ' +
        'border-indigo-200/70 bg-gradient-to-br from-indigo-50 via-card to-card ' +
        'dark:border-indigo-900/50 dark:from-indigo-950/40 dark:via-card dark:to-card'

    // Already has a request in flight — a calm status card, no competing CTA.
    if (activeRequest) {
        const isNew = activeRequest.status === 'new'
        return (
            <div className={shell}>
                <div className="flex items-start gap-3.5">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-100 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-400">
                        <PhoneCall className="h-5 w-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                            <span className="relative flex h-2 w-2">
                                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-indigo-400 opacity-60" />
                                <span className="relative inline-flex h-2 w-2 rounded-full bg-indigo-500" />
                            </span>
                            <p className="text-sm font-semibold text-foreground">
                                {isNew ? 'Request received' : 'Our team is on it'}
                            </p>
                        </div>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                            {isNew
                                ? 'We’re reviewing your project now. Expect a call or WhatsApp message from our team shortly.'
                                : 'We’ve been in touch about your project. Reply on WhatsApp any time to keep things moving.'}
                        </p>
                    </div>
                </div>
            </div>
        )
    }

    return (
        <motion.div
            initial={reduceMotion ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: 'spring', stiffness: 240, damping: 28 }}
            className={shell}
        >
            {/* Header: what this is */}
            <div className="flex items-start gap-3.5">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-100 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-400">
                    <Code2 className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] font-bold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">
                        Software development
                        <span className="rounded-full bg-indigo-600 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white dark:bg-indigo-500">
                            New
                        </span>
                    </p>
                    <p className="mt-1 text-base font-bold leading-snug text-foreground">
                        Websites &amp; apps, built for your business
                    </p>
                </div>
            </div>

            {/* What we actually build — the informative part */}
            <div className="mt-3.5 flex flex-wrap gap-1.5">
                {HIGHLIGHTS.map(item => (
                    <span
                        key={item}
                        className="rounded-full border border-indigo-200/70 bg-white/70 px-2.5 py-1 text-[11px] font-medium text-indigo-900 dark:border-indigo-900/50 dark:bg-indigo-950/40 dark:text-indigo-200"
                    >
                        {item}
                    </span>
                ))}
            </div>

            {/* Action */}
            <div className="mt-4 flex flex-col gap-3 border-t border-indigo-200/60 pt-3.5 dark:border-indigo-900/40 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs leading-relaxed text-muted-foreground">
                    Projects start from <span className="font-semibold text-foreground">GHS 1,000</span>.
                    Tell us what you need — we&apos;ll call to talk it through.
                </p>
                <Link href="/dashboard/website-request" className="shrink-0">
                    <span className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:bg-indigo-500 dark:hover:bg-indigo-400 sm:w-auto">
                        Start a request
                        <ArrowRight className="h-4 w-4" />
                    </span>
                </Link>
            </div>
        </motion.div>
    )
}
