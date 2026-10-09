'use client'

import Link from 'next/link'
import { MessageCircle, Radio, Users2 } from 'lucide-react'
import { BrandLogo, BrandTitle } from '@/components/ui/brand'
import { cn } from '@/lib/utils'
import { DEVELOPER_PRODUCTS } from '@/lib/developer-products'

interface FooterLink {
    label: string
    href: string
}

const PRODUCT_LINKS: FooterLink[] = [
    { label: 'Data bundles', href: '#products' },
    { label: 'Airtime top-up', href: '#products' },
    { label: 'SMS platform', href: '/sms' },
    { label: 'Bill pay', href: '/dashboard/utilities' },
    { label: 'AFA registration', href: '#afa' },
    { label: 'Developer API', href: '/developers' },
]

const COMPANY_LINKS: FooterLink[] = [
    { label: 'Wallet', href: '#wallet' },
    { label: 'Reseller shops', href: '#resell' },
    { label: 'Sub-agent program', href: '/dashboard/recruit' },
    { label: 'Community', href: '#community' },
    { label: 'Get the app', href: '/download' },
]

const LEGAL_LINKS: FooterLink[] = [
    { label: 'Terms of service', href: '/terms' },
    { label: 'Privacy policy', href: '/privacy' },
]

const LINK_CLASS = 'inline-flex min-h-12 items-center text-sm font-semibold text-ft-ink hover:text-ft-blue hover:underline dark:hover:text-[color:var(--ft-cyan)]'
const ICON_LINK_CLASS = 'ft-raised inline-flex h-12 w-12 items-center justify-center rounded-full text-ft-ink'

function FooterColumnLink({ href, label }: FooterLink) {
    const isRoute = href.startsWith('/')
    return isRoute ? (
        <Link href={href} className={LINK_CLASS}>{label}</Link>
    ) : (
        <a href={href} className={LINK_CLASS}>{label}</a>
    )
}

interface LandingFooterProps {
    adminSettings?: Record<string, string>
    whatsappHref: string
    adminPhone?: string
    whatsappGroupLink: string
    whatsappChannelLink: string
    className?: string
}

export function LandingFooter({
    adminSettings = {},
    whatsappHref,
    adminPhone,
    whatsappGroupLink,
    whatsappChannelLink,
    className,
}: LandingFooterProps) {
    const footerText = adminSettings?.footer_copyright_text || '2026 Fame Technologies'

    return (
        <footer className={cn('relative mt-auto', className)}>
            <div className="ft-inset rounded-b-none rounded-t-[2rem]">
                <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
                    <div className="grid grid-cols-2 gap-8 md:grid-cols-4 md:gap-6">
                        {/* Brand column — spans full width on mobile */}
                        <div className="col-span-2 min-w-0 md:col-span-1">
                            <Link href="/" className="flex min-h-12 items-center gap-2">
                                <BrandLogo width={32} height={32} className="h-8 w-8" />
                                <BrandTitle className="text-lg" />
                            </Link>
                            <p className="mt-3 max-w-xs text-sm leading-relaxed text-[color:var(--ft-muted)]">
                                Ghana&apos;s all-in-one platform for data, airtime, and reseller tools. Instant delivery, always.
                            </p>
                            <div className="mt-4 flex items-center gap-3">
                                <a
                                    href={whatsappHref}
                                    target={adminPhone ? '_blank' : undefined}
                                    rel={adminPhone ? 'noopener noreferrer' : undefined}
                                    aria-label="Chat with us on WhatsApp"
                                    className={ICON_LINK_CLASS}
                                >
                                    <MessageCircle className="h-5 w-5" aria-hidden="true" />
                                </a>
                                <a
                                    href={whatsappChannelLink}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    aria-label="Follow our WhatsApp channel"
                                    className={ICON_LINK_CLASS}
                                >
                                    <Radio className="h-5 w-5" aria-hidden="true" />
                                </a>
                                <a
                                    href={whatsappGroupLink}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    aria-label="Join our WhatsApp community group"
                                    className={ICON_LINK_CLASS}
                                >
                                    <Users2 className="h-5 w-5" aria-hidden="true" />
                                </a>
                            </div>
                        </div>

                        <div className="min-w-0">
                            <p className="mb-1 text-sm font-semibold text-ft-ink">Products</p>
                            <ul>
                                {PRODUCT_LINKS.map((link) => (
                                    <li key={link.label}><FooterColumnLink {...link} /></li>
                                ))}
                            </ul>
                        </div>

                        <div className="min-w-0">
                            <p className="mb-1 text-sm font-semibold text-ft-ink">Company</p>
                            <ul>
                                {COMPANY_LINKS.map((link) => (
                                    <li key={link.label}><FooterColumnLink {...link} /></li>
                                ))}
                            </ul>
                        </div>

                        <div className="min-w-0">
                            <p className="mb-1 text-sm font-semibold text-ft-ink">Legal</p>
                            <ul>
                                {LEGAL_LINKS.map((link) => (
                                    <li key={link.label}><FooterColumnLink {...link} /></li>
                                ))}
                            </ul>
                        </div>
                    </div>

                    <div className="mt-10 pt-6">
                        <p className="mb-1 text-sm font-semibold text-ft-ink">Developer API</p>
                        <ul className="mb-4 flex flex-wrap gap-x-5">
                            {DEVELOPER_PRODUCTS.map((p) => (
                                <li key={p.slug}>
                                    <FooterColumnLink href={`/developers/${p.slug}`} label={p.name} />
                                </li>
                            ))}
                        </ul>
                        <p className="text-xs text-[color:var(--ft-muted)]">
                            © {footerText}. All rights reserved.
                        </p>
                    </div>
                </div>
            </div>
        </footer>
    )
}
