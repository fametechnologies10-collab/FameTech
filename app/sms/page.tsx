'use client'

import { useState } from 'react'
import Link from 'next/link'
import { motion, useReducedMotion } from 'framer-motion'
import {
    MessageSquare,
    Send,
    BadgeCheck,
    ListChecks,
    CalendarClock,
    LayoutTemplate,
    Users,
    ShieldCheck,
    Code2,
    Coins,
    ArrowRight,
    ArrowLeft,
    ExternalLink,
    Copy,
    Check,
    CheckCircle2,
    Sparkles,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { BrandLogo } from '@/components/ui/brand'
import { CopyrightFooter } from '@/components/CopyrightFooter'
import { cn } from '@/lib/utils'
import { SMS_API_ENDPOINTS } from '@/content/sms-api-docs'

// ── API sample content (matches /developers SMS API section) ───────────────────
const SEND_CURL = SMS_API_ENDPOINTS.find(e => e.path === '/api/v2/sms/send')!.codeSamples['cURL']
const STATUS_CURL = SMS_API_ENDPOINTS.find(e => e.path === '/api/v2/sms/messages/{campaignId}')!.codeSamples['cURL']
const KEY = 'kf_sms_live_your_api_key_here'

// ── Motion helper (respects reduced-motion) ────────────────────────────────────
function Reveal({
    children,
    className,
    delay = 0,
}: {
    children: React.ReactNode
    className?: string
    delay?: number
}) {
    const reduce = useReducedMotion()
    return (
        <motion.div
            className={className}
            initial={reduce ? false : { opacity: 0, y: 22 }}
            whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-60px' }}
            transition={{ duration: 0.5, ease: 'easeOut', delay }}
        >
            {children}
        </motion.div>
    )
}

// ── Copy-to-clipboard button (self-contained, no deps) ─────────────────────────
function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
    const [copied, setCopied] = useState(false)
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(text)
        } catch {
            const el = Object.assign(document.createElement('textarea'), { value: text })
            document.body.appendChild(el)
            el.select()
            try { document.execCommand('copy') } catch { /* clipboard unavailable */ }
            el.remove()
        }
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }
    return (
        <button
            type="button"
            onClick={copy}
            aria-label={copied ? 'Copied to clipboard' : 'Copy to clipboard'}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-xs font-semibold bg-slate-700 hover:bg-slate-600 text-slate-100 border border-slate-600 transition-colors"
        >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? 'Copied' : label}
        </button>
    )
}

// ── Delivery-report card (the product's signature element) ─────────────────────
const DELIVERY_ROWS: { phone: string; status: 'Delivered' | 'Sent' | 'Undelivered'; time: string }[] = [
    { phone: '024 •• •• 512', status: 'Delivered', time: '2s' },
    { phone: '055 •• •• 907', status: 'Delivered', time: '3s' },
    { phone: '020 •• •• 143', status: 'Sent', time: '4s' },
    { phone: '027 •• •• 668', status: 'Undelivered', time: '—' },
]

const STATUS_STYLES: Record<string, string> = {
    Delivered: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
    Sent: 'bg-[#0056B3]/10 text-[#0056B3] dark:text-[#4da6ff] border-[#0056B3]/25 dark:border-[#4da6ff]/30',
    Undelivered: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30',
}

function DeliveryReportCard() {
    const reduce = useReducedMotion()
    return (
        <div className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl overflow-hidden">
            {/* header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/30">
                <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-9 h-9 rounded-xl bg-[#0056B3]/10 text-[#0056B3] dark:text-[#4da6ff] flex items-center justify-center flex-shrink-0">
                        <MessageSquare className="w-5 h-5" />
                    </div>
                    <div className="min-w-0">
                        <p className="text-sm font-bold text-slate-900 dark:text-white truncate">Sender: AcmeGH</p>
                        <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">Order updates · 1,204 recipients</p>
                    </div>
                </div>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-widest bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 flex-shrink-0">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    Live
                </span>
            </div>

            {/* per-recipient rows */}
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
                {DELIVERY_ROWS.map((row) => (
                    <div key={row.phone} className="flex items-center justify-between gap-3 px-5 py-3">
                        <div className="flex items-center gap-2.5 min-w-0">
                            <span className="font-mono text-xs text-slate-600 dark:text-slate-300 truncate">{row.phone}</span>
                            <span className="text-[10px] text-slate-400 dark:text-slate-500">{row.time}</span>
                        </div>
                        <span className={cn('inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold border tracking-wide', STATUS_STYLES[row.status])}>
                            {row.status}
                        </span>
                    </div>
                ))}
            </div>

            {/* delivery rollup */}
            <div className="px-5 py-4 bg-slate-50/70 dark:bg-slate-800/30 border-t border-slate-100 dark:border-slate-800">
                <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Delivery rate</span>
                    <span className="text-sm font-black text-emerald-600 dark:text-emerald-400">98.7%</span>
                </div>
                <div className="h-2 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
                    <motion.div
                        className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-400"
                        initial={reduce ? false : { width: 0 }}
                        whileInView={reduce ? undefined : { width: '98.7%' }}
                        viewport={{ once: true }}
                        transition={{ duration: 1.1, ease: 'easeOut' }}
                        style={reduce ? { width: '98.7%' } : undefined}
                    />
                </div>
            </div>
        </div>
    )
}

// ── Feature data ───────────────────────────────────────────────────────────────
const FEATURES = [
    { icon: BadgeCheck, title: 'Your own sender ID', desc: 'Send under your brand name once your business is verified — not a shared shortcode.' },
    { icon: ListChecks, title: 'Per-recipient reports', desc: 'Track every number from Sent to Delivered or Undelivered, in real time.' },
    { icon: Coins, title: 'Clear credit pricing', desc: 'Buy SMS credits up front. 160 GSM characters = 1 credit per recipient. No surprises.' },
    { icon: CalendarClock, title: 'Schedule sends', desc: 'Queue campaigns for the exact time your customers are most likely to read them.' },
    { icon: LayoutTemplate, title: 'Reusable templates', desc: 'Save the messages you send often and reuse them in one tap.' },
    { icon: Users, title: 'Contact groups', desc: 'Organise customers into groups and message a whole segment at once.' },
    { icon: ShieldCheck, title: 'Anti-fraud built in', desc: 'Content screening blocks impersonation and scam patterns before they send.' },
    { icon: Code2, title: 'Developer REST API', desc: 'Fire OTPs, order alerts, and campaigns from your own app with kf_sms_live_ keys.' },
]

const MODES = [
    {
        badge: 'Platform mode',
        title: 'Send today, no paperwork',
        desc: 'Start immediately under our shared, trusted sender with strong anti-fraud screening. Ideal for OTPs, order alerts, and quick campaigns.',
        points: ['No business registration needed', 'Shared verified sender', 'Strict content screening'],
        accent: 'blue' as const,
    },
    {
        badge: 'Business mode',
        title: 'Send as your own brand',
        desc: 'Register your business and get approved to send under your own sender ID, with the freedom to include links to your site.',
        points: ['Your own sender ID / brand name', 'Link freedom for verified brands', 'Ghana Card KYC, one-time'],
        accent: 'emerald' as const,
    },
]

export default function SmsPage() {
    return (
        <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col overflow-x-hidden">

            {/* ── Top bar ─────────────────────────────────────────────────────── */}
            <header className="sticky top-0 z-40 bg-white/80 dark:bg-slate-950/80 backdrop-blur-md border-b border-slate-200 dark:border-slate-800">
                <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-3">
                    <Link href="/" className="flex items-center gap-2 flex-shrink-0">
                        <BrandLogo width={36} height={36} className="w-8 h-8 sm:w-9 sm:h-9" />
                        <span className="font-black tracking-tight text-slate-900 dark:text-white text-sm sm:text-base">
                            KFT <span className="text-[#0056B3] dark:text-[#4da6ff]">SMS</span>
                        </span>
                    </Link>
                    <div className="flex items-center gap-1.5 sm:gap-2">
                        <Link href="/" className="hidden sm:inline-flex items-center gap-1.5 h-10 px-3 rounded-lg text-sm font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">
                            <ArrowLeft className="w-4 h-4" /> Home
                        </Link>
                        <Link href="/developers" className="hidden sm:inline-flex items-center h-10 px-3 rounded-lg text-sm font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">
                            API docs
                        </Link>
                        <Link href="/dashboard/sms">
                            <Button className="h-10 bg-[#0056B3] hover:bg-[#004494] text-white font-bold px-4">Get started</Button>
                        </Link>
                    </div>
                </div>
            </header>

            {/* ── Hero ────────────────────────────────────────────────────────── */}
            <section className="relative px-4 sm:px-6 lg:px-8 pt-14 pb-16 sm:pt-20 sm:pb-24 overflow-hidden">
                {/* ambient brand glow */}
                <div className="absolute inset-0 -z-10 pointer-events-none" aria-hidden="true">
                    <div className="absolute -top-24 left-[8%] w-72 h-72 rounded-full bg-[#0056B3]/15 dark:bg-[#0056B3]/20 blur-[90px]" />
                    <div className="absolute top-10 right-[6%] w-80 h-80 rounded-full bg-[#00B4D8]/15 dark:bg-[#00B4D8]/15 blur-[90px]" />
                </div>

                <div className="max-w-6xl mx-auto grid lg:grid-cols-[1.05fr_1fr] gap-10 lg:gap-14 items-center">
                    <Reveal>
                        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#0056B3]/10 text-[#0056B3] dark:text-[#4da6ff] text-[11px] font-black uppercase tracking-widest mb-5">
                            <Sparkles className="w-3.5 h-3.5" /> KFT SMS · Bulk &amp; transactional
                        </div>
                        <h1 className="text-4xl sm:text-5xl lg:text-[3.4rem] font-black tracking-tight leading-[1.05] text-slate-900 dark:text-white">
                            Reach every customer<br className="hidden sm:block" /> by SMS, in seconds
                        </h1>
                        <p className="mt-5 text-base sm:text-lg text-slate-600 dark:text-slate-300 leading-relaxed max-w-xl">
                            Bulk and transactional SMS for Ghana businesses — campaigns, OTPs, and order alerts under your own
                            sender ID, with a delivery report on every single number.
                        </p>
                        <div className="mt-8 flex flex-col sm:flex-row gap-3">
                            <Link href="/dashboard/sms" className="w-full sm:w-auto">
                                <Button size="xl" className="w-full bg-[#0056B3] hover:bg-[#004494] text-white font-bold">
                                    Get started <ArrowRight className="w-5 h-5 ml-2" />
                                </Button>
                            </Link>
                            <Link href="/developers" className="w-full sm:w-auto">
                                <Button size="xl" variant="outline" className="w-full font-bold border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-100">
                                    <Code2 className="w-5 h-5 mr-2" /> View API docs
                                </Button>
                            </Link>
                        </div>
                        <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs font-semibold text-slate-500 dark:text-slate-400">
                            {['Delivery reports', 'Own sender ID', 'Credit-based pricing', 'Developer API'].map((t) => (
                                <span key={t} className="inline-flex items-center gap-1.5">
                                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" /> {t}
                                </span>
                            ))}
                        </div>
                    </Reveal>

                    <Reveal delay={0.12}>
                        <DeliveryReportCard />
                    </Reveal>
                </div>
            </section>

            {/* ── Two modes ───────────────────────────────────────────────────── */}
            <section className="px-4 sm:px-6 lg:px-8 py-16 bg-white/60 dark:bg-slate-900/40 border-y border-slate-200 dark:border-slate-800">
                <div className="max-w-6xl mx-auto">
                    <Reveal className="text-center mb-10">
                        <span className="text-xs sm:text-sm font-bold tracking-[0.2em] text-[#0056B3] dark:text-[#FFCC00]/90 uppercase block mb-2">Two ways to send</span>
                        <h2 className="text-3xl md:text-4xl font-black text-slate-900 dark:text-white tracking-tight">Start shared, grow into your brand</h2>
                        <p className="text-slate-600 dark:text-slate-400 max-w-2xl mx-auto mt-3">Send under our trusted platform sender today, then unlock your own sender ID when you register your business.</p>
                    </Reveal>

                    <div className="grid md:grid-cols-2 gap-5">
                        {MODES.map((mode, i) => (
                            <Reveal key={mode.badge} delay={i * 0.08}>
                                <div className={cn(
                                    'h-full rounded-2xl border p-6 sm:p-7 bg-white dark:bg-slate-900',
                                    mode.accent === 'blue'
                                        ? 'border-[#0056B3]/25 dark:border-[#4da6ff]/25'
                                        : 'border-emerald-300/50 dark:border-emerald-800/50'
                                )}>
                                    <span className={cn(
                                        'inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-widest mb-4',
                                        mode.accent === 'blue'
                                            ? 'bg-[#0056B3]/10 text-[#0056B3] dark:text-[#4da6ff]'
                                            : 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                                    )}>
                                        {mode.badge}
                                    </span>
                                    <h3 className="text-xl font-black text-slate-900 dark:text-white mb-2">{mode.title}</h3>
                                    <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed mb-5">{mode.desc}</p>
                                    <ul className="space-y-2.5">
                                        {mode.points.map((p) => (
                                            <li key={p} className="flex items-start gap-2.5 text-sm text-slate-700 dark:text-slate-300">
                                                <CheckCircle2 className={cn('w-4 h-4 mt-0.5 flex-shrink-0', mode.accent === 'blue' ? 'text-[#0056B3] dark:text-[#4da6ff]' : 'text-emerald-500')} />
                                                <span>{p}</span>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            </Reveal>
                        ))}
                    </div>
                </div>
            </section>

            {/* ── Features grid ───────────────────────────────────────────────── */}
            <section className="px-4 sm:px-6 lg:px-8 py-16">
                <div className="max-w-6xl mx-auto">
                    <Reveal className="text-center mb-12">
                        <span className="text-xs sm:text-sm font-bold tracking-[0.2em] text-[#0056B3] dark:text-[#FFCC00]/90 uppercase block mb-2">Everything included</span>
                        <h2 className="text-3xl md:text-4xl font-black text-slate-900 dark:text-white tracking-tight">Built for how you actually message</h2>
                        <p className="text-slate-600 dark:text-slate-400 max-w-2xl mx-auto mt-3">From a one-off order alert to a campaign for thousands — the same clean tools, in the dashboard or over the API.</p>
                    </Reveal>

                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                        {FEATURES.map((f, i) => (
                            <Reveal key={f.title} delay={(i % 4) * 0.06}>
                                <div className="group h-full rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-sm transition-all duration-300 hover:-translate-y-1 hover:shadow-lg">
                                    <div className="w-11 h-11 rounded-xl bg-[#0056B3]/10 text-[#0056B3] dark:text-[#4da6ff] flex items-center justify-center transition-transform duration-300 group-hover:scale-110">
                                        <f.icon className="w-5 h-5" />
                                    </div>
                                    <h3 className="mt-4 font-bold text-slate-900 dark:text-white">{f.title}</h3>
                                    <p className="mt-1.5 text-sm text-slate-600 dark:text-slate-400 leading-relaxed">{f.desc}</p>
                                </div>
                            </Reveal>
                        ))}
                    </div>
                </div>
            </section>

            {/* ── Two ways to use it (Dashboard vs API) ───────────────────────── */}
            <section className="px-4 sm:px-6 lg:px-8 py-16 bg-white/60 dark:bg-slate-900/40 border-y border-slate-200 dark:border-slate-800">
                <div className="max-w-6xl mx-auto">
                    <Reveal className="text-center mb-10">
                        <span className="text-xs sm:text-sm font-bold tracking-[0.2em] text-[#0056B3] dark:text-[#FFCC00]/90 uppercase block mb-2">Dashboard or API</span>
                        <h2 className="text-3xl md:text-4xl font-black text-slate-900 dark:text-white tracking-tight">Two ways to use it</h2>
                    </Reveal>

                    <div className="grid md:grid-cols-2 gap-5">
                        <Reveal>
                            <div className="h-full rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 sm:p-7 flex flex-col">
                                <div className="w-11 h-11 rounded-xl bg-[#0056B3]/10 text-[#0056B3] dark:text-[#4da6ff] flex items-center justify-center mb-4">
                                    <MessageSquare className="w-5 h-5" />
                                </div>
                                <h3 className="text-xl font-black text-slate-900 dark:text-white mb-2">From the dashboard</h3>
                                <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed mb-5">Compose in the browser, pick a contact group, schedule the send, and watch delivery come back per recipient.</p>
                                <ul className="space-y-2.5 mb-6">
                                    {['Compose with saved templates', 'Contact groups & scheduling', 'Live delivery reports'].map((p) => (
                                        <li key={p} className="flex items-start gap-2.5 text-sm text-slate-700 dark:text-slate-300">
                                            <CheckCircle2 className="w-4 h-4 mt-0.5 text-emerald-500 flex-shrink-0" />
                                            <span>{p}</span>
                                        </li>
                                    ))}
                                </ul>
                                <div className="mt-auto">
                                    <Link href="/dashboard/sms">
                                        <Button className="bg-[#0056B3] hover:bg-[#004494] text-white font-bold">
                                            Open the SMS dashboard <ArrowRight className="w-4 h-4 ml-2" />
                                        </Button>
                                    </Link>
                                </div>
                            </div>
                        </Reveal>

                        <Reveal delay={0.08}>
                            <div className="h-full rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 sm:p-7 flex flex-col">
                                <div className="w-11 h-11 rounded-xl bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 flex items-center justify-center mb-4">
                                    <Code2 className="w-5 h-5" />
                                </div>
                                <h3 className="text-xl font-black text-slate-900 dark:text-white mb-2">From your code</h3>
                                <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed mb-5">Send OTPs, order alerts, and campaigns straight from your app with a <span className="font-mono text-xs text-emerald-600 dark:text-emerald-400">kf_sms_live_</span> key and an idempotency reference.</p>
                                <ul className="space-y-2.5 mb-6">
                                    {['One POST to send to thousands', 'Idempotency keys, no double-sends', 'Poll delivery status by message'].map((p) => (
                                        <li key={p} className="flex items-start gap-2.5 text-sm text-slate-700 dark:text-slate-300">
                                            <CheckCircle2 className="w-4 h-4 mt-0.5 text-emerald-500 flex-shrink-0" />
                                            <span>{p}</span>
                                        </li>
                                    ))}
                                </ul>
                                <div className="mt-auto">
                                    <Link href="/developers">
                                        <Button variant="outline" className="border-emerald-500 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 font-bold">
                                            Read the API docs <ExternalLink className="w-4 h-4 ml-2" />
                                        </Button>
                                    </Link>
                                </div>
                            </div>
                        </Reveal>
                    </div>
                </div>
            </section>

            {/* ── Developer API quickstart ────────────────────────────────────── */}
            <section className="px-4 sm:px-6 lg:px-8 py-16">
                <div className="max-w-6xl mx-auto">
                    <Reveal className="mb-8">
                        <span className="text-xs sm:text-sm font-bold tracking-[0.2em] text-[#0056B3] dark:text-[#FFCC00]/90 uppercase block mb-2">Quickstart</span>
                        <div className="flex flex-wrap items-end justify-between gap-4">
                            <div>
                                <h2 className="text-3xl md:text-4xl font-black text-slate-900 dark:text-white tracking-tight">Send your first SMS</h2>
                                <p className="text-slate-600 dark:text-slate-400 mt-3 max-w-xl">Authenticate with your API key, POST a message to one or many numbers, then check delivery by campaign ID.</p>
                            </div>
                            <Link href="/developers" className="inline-flex items-center gap-1.5 text-sm font-bold text-[#0056B3] dark:text-[#4da6ff] hover:underline">
                                Full API reference <ArrowRight className="w-4 h-4" />
                            </Link>
                        </div>
                    </Reveal>

                    <Reveal delay={0.05}>
                        <div className="rounded-2xl border border-slate-800 bg-[#0d1117] overflow-hidden shadow-xl">
                            {/* auth line */}
                            <div className="flex items-center justify-between gap-3 px-4 sm:px-5 py-3 border-b border-slate-800 bg-slate-900/60">
                                <div className="flex items-center gap-2 min-w-0 overflow-x-auto">
                                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest flex-shrink-0">Auth</span>
                                    <code className="text-xs font-mono text-slate-300 whitespace-nowrap">
                                        Authorization: <span className="text-emerald-400">{KEY}</span>
                                    </code>
                                </div>
                                <CopyButton text={`Authorization: ${KEY}`} />
                            </div>

                            {/* POST /sms/send */}
                            <div className="px-4 sm:px-5 py-3 flex items-center justify-between gap-3 border-b border-slate-800">
                                <div className="flex items-center gap-2.5 min-w-0">
                                    <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold border tracking-wide font-mono bg-blue-500/15 text-blue-400 border-blue-500/30">POST</span>
                                    <code className="text-xs sm:text-sm font-mono font-semibold text-slate-200 truncate">/api/v2/sms/send</code>
                                </div>
                                <CopyButton text={SEND_CURL} />
                            </div>
                            <div className="overflow-x-auto p-4 sm:p-5">
                                <pre className="text-[12.5px] font-mono text-slate-300 leading-relaxed whitespace-pre">{SEND_CURL}</pre>
                            </div>

                            {/* GET status */}
                            <div className="px-4 sm:px-5 py-3 flex items-center justify-between gap-3 border-y border-slate-800 bg-slate-900/40">
                                <div className="flex items-center gap-2.5 min-w-0">
                                    <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold border tracking-wide font-mono bg-emerald-500/15 text-emerald-400 border-emerald-500/30">GET</span>
                                    <code className="text-xs sm:text-sm font-mono font-semibold text-slate-200 truncate">/api/v2/sms/messages/{'{id}'}</code>
                                </div>
                                <CopyButton text={STATUS_CURL} />
                            </div>
                            <div className="overflow-x-auto p-4 sm:p-5">
                                <pre className="text-[12.5px] font-mono text-slate-300 leading-relaxed whitespace-pre">{STATUS_CURL}</pre>
                            </div>
                        </div>
                    </Reveal>

                    <Reveal delay={0.1}>
                        <p className="mt-4 text-xs text-slate-500 dark:text-slate-400">
                            Also available: <code className="font-mono text-[11px] text-slate-600 dark:text-slate-300">GET /sms/balance</code> for your credit balance and{' '}
                            <code className="font-mono text-[11px] text-slate-600 dark:text-slate-300">GET /sms/senders</code> to list the sender IDs your key may use.
                        </p>
                    </Reveal>
                </div>
            </section>

            {/* ── Closing CTA band ────────────────────────────────────────────── */}
            <section className="px-4 sm:px-6 lg:px-8 pb-16">
                <div className="max-w-5xl mx-auto">
                    <Reveal>
                        <div className="relative overflow-hidden rounded-3xl bg-gradient-to-r from-[#0056B3] to-[#00B4D8] p-8 sm:p-12 text-center shadow-2xl">
                            <div className="absolute inset-0 opacity-[0.12] bg-[linear-gradient(rgba(255,255,255,.6)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.6)_1px,transparent_1px)] bg-[size:44px_44px]" aria-hidden="true" />
                            <div className="relative z-10">
                                <div className="w-14 h-14 mx-auto rounded-2xl bg-white/15 border border-white/25 flex items-center justify-center mb-5">
                                    <Send className="w-7 h-7 text-white" />
                                </div>
                                <h2 className="text-3xl md:text-4xl font-black text-white mb-3">Start sending with KFT SMS</h2>
                                <p className="text-white/90 max-w-xl mx-auto mb-8">Buy your first credits, add a contact group, and send in minutes — or wire it into your app over the API.</p>
                                <div className="flex flex-col sm:flex-row justify-center gap-3">
                                    <Link href="/dashboard/sms" className="w-full sm:w-auto">
                                        <Button size="xl" className="w-full bg-white text-[#0056B3] hover:bg-white/90 font-bold shadow-lg">
                                            Get started <ArrowRight className="w-5 h-5 ml-2" />
                                        </Button>
                                    </Link>
                                    <Link href="/developers" className="w-full sm:w-auto">
                                        <Button size="xl" variant="outline" className="w-full bg-transparent border-white/60 text-white hover:bg-white/15 font-bold">
                                            View API docs
                                        </Button>
                                    </Link>
                                </div>
                            </div>
                        </div>
                    </Reveal>
                </div>
            </section>

            <CopyrightFooter className="mt-auto bg-white/50 dark:bg-slate-900/50 border-slate-200 dark:border-slate-800" />
        </div>
    )
}
