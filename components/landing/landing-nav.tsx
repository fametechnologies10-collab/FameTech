'use client'

import { useState } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { Menu, X } from 'lucide-react'
import { BrandLogo, BrandTitle } from '@/components/ui/brand'
import { ClayButton } from '@/components/ft'
import { useAuth } from '@/contexts/auth-context'

const PWAInstallButton = dynamic(() => import('@/components/pwa-install-prompt').then(m => ({ default: m.PWAInstallButton })), { ssr: false })

interface LandingNavProps {
    whatsappHref: string
    adminPhone: string
}

const LINK_CLASS =
    'inline-flex min-h-12 items-center rounded-full px-3 text-sm font-semibold text-ft-ink transition-colors hover:text-ft-blue hover:underline dark:hover:text-[color:var(--ft-cyan)]'

export function LandingNav({ whatsappHref, adminPhone }: LandingNavProps) {
    const { user } = useAuth()
    const [open, setOpen] = useState(false)
    const close = () => setOpen(false)
    const external = adminPhone
        ? { target: '_blank', rel: 'noopener noreferrer' }
        : { target: undefined, rel: undefined }

    const links = (
        <>
            <a href="#products" className={LINK_CLASS} onClick={close}>Products</a>
            <a href="#resell" className={LINK_CLASS} onClick={close}>Resell</a>
            <Link href="/developers" className={LINK_CLASS} onClick={close}>Developers</Link>
            <a href="#community" className={LINK_CLASS} onClick={close}>Community</a>
            <Link href="/sms" className={LINK_CLASS} onClick={close}>SMS</Link>
            <Link href="/dashboard/utilities" className={LINK_CLASS} onClick={close}>Utilities</Link>
            <Link href="/dashboard/recruit" className={LINK_CLASS} onClick={close}>Sub-agent</Link>
            <a href={whatsappHref} className={LINK_CLASS} onClick={close} {...external}>Support</a>
        </>
    )

    const cta = user ? (
        <ClayButton asChild className="min-w-0 px-5">
            <Link href="/dashboard" onClick={close}>Dashboard</Link>
        </ClayButton>
    ) : (
        <>
            <Link href="/auth" className={LINK_CLASS} onClick={close}>Sign in</Link>
            <ClayButton asChild className="min-w-0 px-5">
                <Link href="/auth?tab=signup" onClick={close}>Get started</Link>
            </ClayButton>
        </>
    )

    return (
        <header className="sticky top-3 z-50 px-3 sm:px-6">
            <nav aria-label="Main" className="ft-raised mx-auto max-w-7xl !rounded-2xl px-3 py-2 sm:px-4">
                <div className="flex min-w-0 items-center justify-between gap-2">
                    <Link href="/" className="flex min-h-12 min-w-0 items-center gap-2 rounded-full pr-2" onClick={close}>
                        <BrandLogo width={36} height={36} className="h-9 w-9" />
                        <BrandTitle className="truncate text-lg sm:text-xl" />
                    </Link>

                    <div className="hidden items-center gap-0.5 xl:flex">{links}</div>

                    <div className="flex shrink-0 items-center gap-1">
                        <div className="hidden items-center gap-1 xl:flex">
                            <PWAInstallButton />
                            {cta}
                        </div>
                        <button
                            type="button"
                            className="ft-raised inline-flex h-12 w-12 items-center justify-center rounded-full text-ft-ink xl:hidden"
                            aria-expanded={open}
                            aria-controls="landing-mobile-menu"
                            aria-label={open ? 'Close menu' : 'Open menu'}
                            onClick={() => setOpen(o => !o)}
                        >
                            {open ? <X className="h-5 w-5" aria-hidden="true" /> : <Menu className="h-5 w-5" aria-hidden="true" />}
                        </button>
                    </div>
                </div>

                {open && (
                    <div id="landing-mobile-menu" className="ft-raised mt-2 flex flex-col gap-1 p-3 xl:hidden">
                        <div className="grid grid-cols-2 gap-1">{links}</div>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                            <PWAInstallButton />
                            {cta}
                        </div>
                    </div>
                )}
            </nav>
        </header>
    )
}
