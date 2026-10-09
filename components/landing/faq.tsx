'use client'

import { useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

interface FaqItem {
    question: string
    answer: ReactNode
}

const LINK_CLASS = 'font-semibold text-ft-blue underline underline-offset-2 dark:text-[color:var(--ft-cyan)]'

function getFaqItems(guestUrl: string): FaqItem[] {
    return [
        {
            question: 'How do I buy data or airtime?',
            answer: 'Create an account and fund your wallet. Then buy data or airtime from your dashboard in three clicks. The process is fully automated, and your order reaches the recipient number within seconds.',
        },
        {
            question: 'Can I buy without creating an account?',
            answer: (
                <>
                    Yes. For a quick one-time purchase, use the guest store. <a href={guestUrl} className={LINK_CLASS}>Open the guest store</a> and pay with Mobile Money or card.
                </>
            ),
        },
        {
            question: 'How does the wallet work?',
            answer: 'Your wallet is your personal spending account on FameTech. Top it up once with Mobile Money or bank transfer, and your funds are stored securely. Then use the balance to buy data, airtime or an AFA registration without entering payment details each time.',
        },
        {
            question: 'How do I create an account?',
            answer: (
                <>
                    It is free. Choose <strong>Get started</strong>, enter your name, email, phone number and password, and your account is ready instantly. You land on your dashboard, where you can start buying and reselling.
                </>
            ),
        },
        {
            question: 'How do I get the Developer API?',
            answer: (
                <>
                    The Developer API lets you automate data and airtime purchases from your own website or mobile app. Read the docs on the <strong>Developers</strong> page, or generate your API key in your dashboard under the Developer API tab once you are approved.
                </>
            ),
        },
        {
            question: 'How do I report a failed or delayed order?',
            answer: (
                <>
                    Use the <strong>Complaints</strong> section in your dashboard. If an order is delayed, select the &quot;Report Issue&quot; button next to the transaction. Our system tracks it, our support team resolves it, and you get updates right in your dashboard.
                </>
            ),
        },
        {
            question: 'Can I create my own reseller storefront?',
            answer: 'Yes. As a registered user you can launch your own branded data shop. Set your profit margin on top of our wholesale prices, upload your logo, and share your shop link with customers. You earn a profit every time someone buys from your shop.',
        },
    ]
}

export function Faq({ guestUrl }: { guestUrl: string }) {
    const [openIndex, setOpenIndex] = useState<number | null>(0)
    const items = getFaqItems(guestUrl)

    return (
        <section id="faq" aria-labelledby="faq-heading" className="ft-lazy scroll-mt-24 px-4 py-16 sm:px-6 lg:px-8">
            <div className="mx-auto max-w-3xl">
                <h2 id="faq-heading" className="ft-display text-3xl font-extrabold tracking-tight text-ft-ink sm:text-4xl">
                    Frequently asked questions
                </h2>
                <p className="mt-3 text-base text-[color:var(--ft-muted)]">
                    Quick answers about delivery, support, the wallet and reselling.
                </p>
                <div className="mt-8 space-y-4">
                    {items.map((item, index) => {
                        const open = openIndex === index
                        const buttonId = `faq-button-${index}`
                        const panelId = `faq-panel-${index}`
                        return (
                            <div key={item.question} className={cn(open ? 'ft-inset' : 'ft-raised', 'min-w-0')}>
                                <h3>
                                    <button
                                        type="button"
                                        id={buttonId}
                                        aria-expanded={open}
                                        aria-controls={panelId}
                                        onClick={() => setOpenIndex(open ? null : index)}
                                        className="flex min-h-12 w-full items-center justify-between gap-3 rounded-[1.25rem] px-5 py-3 text-left font-semibold text-ft-ink"
                                    >
                                        <span className="min-w-0 break-words">{item.question}</span>
                                        <ChevronDown aria-hidden="true" className={cn('h-5 w-5 shrink-0', open && 'rotate-180')} />
                                    </button>
                                </h3>
                                <div id={panelId} role="region" aria-labelledby={buttonId} hidden={!open} className="px-5 pb-5 text-base leading-relaxed text-[color:var(--ft-muted)]">
                                    {item.answer}
                                </div>
                            </div>
                        )
                    })}
                </div>
            </div>
        </section>
    )
}
