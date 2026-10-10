import { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft, Database, Eye, Share2, Lock } from 'lucide-react'
import { NeuCard } from '@/components/ft'
import { ftFonts } from '@/lib/ft-fonts'

export const metadata: Metadata = {
    title: 'Privacy Policy | FameTech',
    description: 'Read the official Privacy Policy for FameTech Data and Airtime platform.',
}

const BODY = 'mt-2 break-words text-base leading-[1.7] text-[color:var(--ft-muted)]'
const HEADING = 'ft-display text-lg font-extrabold text-ft-ink'
const BADGE = 'ft-inset flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-ft-ink'

export default function PrivacyPage() {
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
                    <span className="ft-display truncate text-base font-extrabold text-ft-ink">Privacy policy</span>
                </div>
            </header>

            <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8 sm:px-6">
                <NeuCard className="p-6 sm:p-8">
                    <h1 className="ft-display text-3xl font-extrabold tracking-tight text-ft-ink">Privacy policy</h1>
                    <p className="mt-3 max-w-prose text-base leading-[1.7] text-[color:var(--ft-muted)]">
                        Your privacy matters to us. Here is how we collect, use and protect your personal information on FameTech.
                    </p>
                </NeuCard>

                <NeuCard className="space-y-8 p-6 sm:p-8">
                    <section className="flex min-w-0 gap-4">
                        <span className={BADGE}>
                            <Database className="h-5 w-5" aria-hidden="true" />
                        </span>
                        <div className="min-w-0 max-w-prose">
                            <h2 className={HEADING}>1. Information We Collect</h2>
                            <p className={BODY}>
                                When you register, we collect your name, email address, and phone number. We also record transaction histories, wallet balances, and the recipient numbers you enter for data/airtime purchases.
                            </p>
                        </div>
                    </section>

                    <section className="flex min-w-0 gap-4">
                        <span className={BADGE}>
                            <Eye className="h-5 w-5" aria-hidden="true" />
                        </span>
                        <div className="min-w-0 max-w-prose">
                            <h2 className={HEADING}>2. How We Use Your Information</h2>
                            <div className={`${BODY} space-y-2`}>
                                <p>We use your data strictly to:</p>
                                <ul className="list-disc space-y-1 pl-5">
                                    <li>Process and fulfill your orders instantly.</li>
                                    <li>Send transactional SMS alerts and emails (e.g., order success, wallet top-ups).</li>
                                    <li>Manage your FameTech Wallet and Agent status.</li>
                                    <li>Provide customer support and resolve disputes.</li>
                                </ul>
                            </div>
                        </div>
                    </section>

                    <section className="flex min-w-0 gap-4">
                        <span className={BADGE}>
                            <Lock className="h-5 w-5" aria-hidden="true" />
                        </span>
                        <div className="min-w-0 max-w-prose">
                            <h2 className={HEADING}>3. Data Protection</h2>
                            <p className={BODY}>
                                We implement strict security measures to protect your personal information. Passwords are cryptographically hashed, and payment information is securely processed by our payment partners (Paystack). We do not store raw credit card details on our servers.
                            </p>
                        </div>
                    </section>

                    <section className="flex min-w-0 gap-4">
                        <span className={BADGE}>
                            <Share2 className="h-5 w-5" aria-hidden="true" />
                        </span>
                        <div className="min-w-0 max-w-prose">
                            <h2 className={HEADING}>4. Third-Party Sharing</h2>
                            <div className={`${BODY} space-y-2`}>
                                <p>We do not sell your personal data. We only share necessary transaction details with:</p>
                                <ul className="list-disc space-y-1 pl-5">
                                    <li>Telecommunication networks (MTN, Telecel, AT) to fulfill your orders.</li>
                                    <li>Payment processors (Paystack, Moolre) to handle deposits and withdrawals.</li>
                                    <li>SMS providers to deliver transaction alerts.</li>
                                </ul>
                            </div>
                        </div>
                    </section>
                </NeuCard>

                <p className="pb-10 text-center text-sm text-[color:var(--ft-muted)]">Last updated: April 2026</p>
            </main>
        </div>
    )
}
