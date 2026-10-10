import Link from 'next/link'
import { ArrowRight, BadgeCheck, CheckCircle2, Code2, MessageSquare, Send, Shield, type LucideIcon } from 'lucide-react'
import { ClayButton, NeuCard, NeuTray } from '@/components/ft'

const POINTS = [
    'Start on our shared trusted sender, or send under your own brand',
    'Per-recipient Sent to Delivered tracking on every message',
    'Buy SMS credits: 160 characters = 1 credit per recipient',
]

const REPORT = [
    { phone: '024 •• •• 512', status: 'Delivered' },
    { phone: '055 •• •• 907', status: 'Delivered' },
    { phone: '020 •• •• 143', status: 'Sent' },
    { phone: '027 •• •• 668', status: 'Undelivered' },
]

const HIGHLIGHTS: { icon: LucideIcon; title: string; desc: string }[] = [
    { icon: BadgeCheck, title: 'Your own sender ID', desc: 'Send under your brand name once your business is verified.' },
    { icon: CheckCircle2, title: 'Delivery reports', desc: 'Track every number from Sent to Delivered or Undelivered.' },
    { icon: Send, title: 'Bulk, scheduling and templates', desc: 'Message contact groups, schedule sends, and reuse templates.' },
    { icon: Code2, title: 'Developer API', desc: 'Fire OTPs and order alerts from your app with kf_live_ keys.' },
]

export function SmsPromo() {
    return (
        <section id="sms" aria-labelledby="sms-heading" className="ft-lazy scroll-mt-24 px-4 py-16 sm:px-6 lg:px-8">
            <div className="mx-auto max-w-7xl">
                <p className="text-sm font-semibold text-[color:var(--ft-muted)]">New: KFT SMS</p>
                <h2 id="sms-heading" className="ft-display mt-1 max-w-3xl text-3xl font-extrabold tracking-tight text-ft-ink sm:text-4xl">
                    Send SMS to your customers, at scale.
                </h2>
                <p className="mt-3 max-w-2xl text-base text-[color:var(--ft-muted)]">
                    Bulk and transactional SMS for Ghana businesses. Campaigns, OTPs, and order alerts, under your own sender ID, with a delivery report on every number.
                </p>

                <div className="mt-10 grid items-center gap-8 lg:grid-cols-[1.05fr_1fr] lg:gap-10">
                    <div className="min-w-0">
                        <ul className="mb-6 flex flex-wrap gap-2">
                            <li className="ft-raised inline-flex min-h-12 items-center gap-2 px-4 text-sm font-semibold text-ft-ink">
                                <Shield className="h-4 w-4 shrink-0" aria-hidden="true" />
                                Platform mode
                            </li>
                            <li className="ft-raised inline-flex min-h-12 items-center gap-2 px-4 text-sm font-semibold text-ft-ink">
                                <BadgeCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
                                Business mode: your own sender ID
                            </li>
                        </ul>
                        <ul className="mb-8 space-y-3">
                            {POINTS.map(point => (
                                <li key={point} className="flex items-start gap-3 font-semibold text-ft-ink">
                                    <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-ft-blue dark:text-[color:var(--ft-cyan)]" aria-hidden="true" />
                                    <span>{point}</span>
                                </li>
                            ))}
                        </ul>
                        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                            <ClayButton asChild>
                                <Link href="/sms">
                                    Explore KFT SMS
                                    <ArrowRight className="h-4 w-4 shrink-0" aria-hidden="true" />
                                </Link>
                            </ClayButton>
                            <ClayButton asChild variant="soft">
                                <Link href="/developers">
                                    <Code2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                                    Read the API docs
                                </Link>
                            </ClayButton>
                        </div>
                    </div>

                    <NeuCard className="min-w-0 p-5" role="group" aria-label="Example delivery report">
                        <div className="flex items-center gap-3">
                            <span className="ft-clay flex h-10 w-10 shrink-0 items-center justify-center rounded-xl">
                                <MessageSquare className="h-5 w-5" aria-hidden="true" />
                            </span>
                            <div className="min-w-0">
                                <p className="truncate text-sm font-semibold text-ft-ink">Sender: AcmeGH</p>
                                <p className="truncate text-xs text-[color:var(--ft-muted)]">Example delivery report</p>
                            </div>
                        </div>
                        <NeuTray className="mt-4 p-2">
                            <ul className="space-y-2">
                                {REPORT.map(row => (
                                    <li key={row.phone} className="ft-raised flex min-h-12 items-center justify-between gap-3 px-4 py-2 !rounded-2xl">
                                        <span className="truncate font-mono text-xs text-[color:var(--ft-muted)]">{row.phone}</span>
                                        <span className="text-xs font-semibold text-ft-ink">{row.status}</span>
                                    </li>
                                ))}
                            </ul>
                        </NeuTray>
                    </NeuCard>
                </div>

                <ul className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
                    {HIGHLIGHTS.map(f => (
                        <li key={f.title} className="min-w-0">
                            <NeuCard className="h-full p-5">
                                <span className="ft-clay flex h-11 w-11 items-center justify-center rounded-xl">
                                    <f.icon className="h-5 w-5" aria-hidden="true" />
                                </span>
                                <h3 className="ft-display mt-4 font-extrabold text-ft-ink">{f.title}</h3>
                                <p className="mt-1.5 text-sm leading-relaxed text-[color:var(--ft-muted)]">{f.desc}</p>
                            </NeuCard>
                        </li>
                    ))}
                </ul>
            </div>
        </section>
    )
}
