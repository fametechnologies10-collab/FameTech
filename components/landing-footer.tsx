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
    { label: 'Data Bundles', href: '#products' },
    { label: 'Airtime Topup', href: '#products' },
    { label: 'SMS Platform', href: '/sms' },
    { label: 'Bill Pay', href: '/dashboard/utilities' },
    { label: 'AFA Registration', href: '#afa' },
    { label: 'Developer API', href: '/developers' },
]

const COMPANY_LINKS: FooterLink[] = [
    { label: 'Wallet', href: '#wallet' },
    { label: 'Reseller Shops', href: '#resell' },
    { label: 'Sub-Agent Program', href: '/dashboard/recruit' },
    { label: 'Community', href: '#community' },
]

const LEGAL_LINKS: FooterLink[] = [
    { label: 'Terms of Service', href: '/terms' },
    { label: 'Privacy Policy', href: '/privacy' },
]

function FooterColumnLink({ href, label }: FooterLink) {
    const isRoute = href.startsWith('/')
    const className = "text-sm text-slate-600 dark:text-slate-400 hover:text-[#0056B3] dark:hover:text-[#FFCC00] transition-colors"
    return isRoute ? (
        <Link href={href} className={className}>{label}</Link>
    ) : (
        <a href={href} className={className}>{label}</a>
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
    const footerText = adminSettings?.footer_copyright_text || '2026 KiNG FLEXY TECHNOLOGIES LTD'

    return (
        <footer className={cn("relative mt-auto", className)}>
            {/* Brand hairline — the one accent this footer spends */}
            <div className="h-[2px] w-full bg-gradient-to-r from-transparent via-[#0056B3] dark:via-[#FFCC00] to-transparent opacity-40" />

            <div className="bg-slate-50 dark:bg-slate-950 border-t border-slate-200 dark:border-slate-800">
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-8 md:gap-6">
                        {/* Brand column — spans full width on mobile */}
                        <div className="col-span-2 md:col-span-1">
                            <Link href="/" className="flex items-center gap-2">
                                <BrandLogo width={32} height={32} className="w-8 h-8" />
                                <BrandTitle className="text-lg" />
                            </Link>
                            <p className="mt-3 text-sm text-slate-600 dark:text-slate-400 max-w-xs leading-relaxed">
                                Ghana&apos;s all-in-one platform for data, airtime, and reseller tools — instant delivery, always.
                            </p>
                            <div className="flex items-center gap-4 mt-4">
                                <a
                                    href={whatsappHref}
                                    target={adminPhone ? '_blank' : undefined}
                                    rel={adminPhone ? 'noopener noreferrer' : undefined}
                                    aria-label="Chat with us on WhatsApp"
                                    className="text-slate-500 hover:text-[#25D366] transition-colors"
                                >
                                    <MessageCircle className="w-5 h-5" />
                                </a>
                                <a
                                    href={whatsappChannelLink}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    aria-label="Follow our WhatsApp channel"
                                    className="text-slate-500 hover:text-[#25D366] transition-colors"
                                >
                                    <Radio className="w-5 h-5" />
                                </a>
                                <a
                                    href={whatsappGroupLink}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    aria-label="Join our WhatsApp community group"
                                    className="text-slate-500 hover:text-[#25D366] transition-colors"
                                >
                                    <Users2 className="w-5 h-5" />
                                </a>
                            </div>
                        </div>

                        <div>
                            <h4 className="text-sm font-semibold text-slate-900 dark:text-white mb-3">Products</h4>
                            <ul className="space-y-2.5">
                                {PRODUCT_LINKS.map((link) => (
                                    <li key={link.label}><FooterColumnLink {...link} /></li>
                                ))}
                            </ul>
                        </div>

                        <div>
                            <h4 className="text-sm font-semibold text-slate-900 dark:text-white mb-3">Company</h4>
                            <ul className="space-y-2.5">
                                {COMPANY_LINKS.map((link) => (
                                    <li key={link.label}><FooterColumnLink {...link} /></li>
                                ))}
                            </ul>
                        </div>

                        <div>
                            <h4 className="text-sm font-semibold text-slate-900 dark:text-white mb-3">Legal</h4>
                            <ul className="space-y-2.5">
                                {LEGAL_LINKS.map((link) => (
                                    <li key={link.label}><FooterColumnLink {...link} /></li>
                                ))}
                            </ul>
                        </div>
                    </div>

                    <div className="mt-10 pt-6 border-t border-slate-200 dark:border-slate-800">
                        <h4 className="text-sm font-semibold text-slate-900 dark:text-white mb-3">Developer API</h4>
                        <ul className="flex flex-wrap gap-x-5 gap-y-2 mb-6">
                            {DEVELOPER_PRODUCTS.map((p) => (
                                <li key={p.slug}>
                                    <FooterColumnLink href={`/developers/${p.slug}`} label={p.name} />
                                </li>
                            ))}
                        </ul>
                        <p className="text-xs text-slate-500 dark:text-slate-500">
                            © {footerText}. All rights reserved.
                        </p>
                    </div>
                </div>
            </div>
        </footer>
    )
}
