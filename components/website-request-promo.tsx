'use client'

import Link from 'next/link'
import { motion, useReducedMotion } from 'framer-motion'
import {
    Code2, ArrowRight, ShoppingBag, CalendarCheck,
    Building2, Smartphone, PhoneCall, ShieldCheck, Wallet,
} from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'

const SERVICES = [
    { Icon: ShoppingBag, label: 'Online stores', blurb: 'Products, checkout, Mobile Money' },
    { Icon: CalendarCheck, label: 'Booking systems', blurb: 'Appointments and reminders' },
    { Icon: Building2, label: 'Business sites', blurb: 'Portfolios, schools, churches' },
    { Icon: Smartphone, label: 'Mobile apps', blurb: 'Android and iOS' },
]

const ASSURANCES = [
    { Icon: PhoneCall, text: 'Free consultation call' },
    { Icon: Wallet, text: 'No payment to enquire' },
    { Icon: ShieldCheck, text: 'Built and supported in Ghana' },
]

export function WebsiteRequestPromo() {
    const { dbUser } = useAuth()
    const reduceMotion = useReducedMotion()
    const href = dbUser ? '/dashboard/website-request' : '/auth?next=%2Fdashboard%2Fwebsite-request'

    return (
        <section className="px-4 py-16 sm:px-6 lg:px-8">
            <motion.div
                initial={reduceMotion ? false : { opacity: 0, y: 24 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-60px' }}
                transition={{ type: 'spring', stiffness: 220, damping: 30 }}
                className="mx-auto w-full max-w-4xl overflow-hidden rounded-3xl border border-indigo-200/70 bg-gradient-to-br from-indigo-50 via-white to-white p-6 shadow-lg shadow-indigo-900/5 dark:border-indigo-900/50 dark:from-indigo-950/50 dark:via-gray-950 dark:to-gray-950 dark:shadow-black/20 sm:p-9"
            >
                {/* Thesis */}
                <div className="flex items-start gap-4">
                    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-indigo-600 text-white shadow-sm dark:bg-indigo-500">
                        <Code2 className="h-6 w-6" />
                    </span>
                    <div className="min-w-0">
                        <p className="text-[11px] font-bold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">
                            Software development
                        </p>
                        <h2 className="mt-1 text-2xl font-black leading-tight tracking-tight text-gray-900 dark:text-white sm:text-3xl">
                            Need a website or app for your business?
                        </h2>
                        <p className="mt-2 max-w-xl text-sm leading-relaxed text-gray-600 dark:text-gray-400">
                            We design and build custom websites, online stores and mobile apps for
                            businesses across Ghana — then keep them running after launch.
                        </p>
                    </div>
                </div>

                {/* What we build */}
                <div className="mt-7 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {SERVICES.map(({ Icon, label, blurb }) => (
                        <div
                            key={label}
                            className="flex items-start gap-3 rounded-2xl border border-gray-200 bg-white/70 p-3.5 dark:border-gray-800 dark:bg-white/[0.03]"
                        >
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-400">
                                <Icon className="h-4 w-4" />
                            </span>
                            <div className="min-w-0">
                                <p className="text-sm font-semibold text-gray-900 dark:text-white">{label}</p>
                                <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{blurb}</p>
                            </div>
                        </div>
                    ))}
                </div>

                {/* Assurances */}
                <div className="mt-6 flex flex-wrap gap-x-5 gap-y-2">
                    {ASSURANCES.map(({ Icon, text }) => (
                        <span key={text} className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-600 dark:text-gray-400">
                            <Icon className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" />
                            {text}
                        </span>
                    ))}
                </div>

                {/* Action */}
                <div className="mt-7 flex flex-col gap-3 border-t border-gray-200 pt-6 dark:border-gray-800 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-sm text-gray-600 dark:text-gray-400">
                        Projects start from{' '}
                        <span className="font-bold text-gray-900 dark:text-white">GHS 1,000</span>
                        <span className="block text-xs text-gray-500 dark:text-gray-500 sm:mt-0.5">
                            Share your idea and budget — we&apos;ll quote after we talk.
                        </span>
                    </p>
                    <Link href={href} className="shrink-0">
                        <span className="group inline-flex w-full items-center justify-center gap-2 rounded-full bg-indigo-600 px-6 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-indigo-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:bg-indigo-500 dark:hover:bg-indigo-400 sm:w-auto">
                            Start a request
                            <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
                        </span>
                    </Link>
                </div>
            </motion.div>
        </section>
    )
}
