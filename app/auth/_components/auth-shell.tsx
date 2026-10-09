'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { Home, Zap, ShieldCheck, Store } from 'lucide-react'
import { BrandLogo, BrandTitle } from '@/components/ui/brand'
import { ClayButton, NeuCard, Orbit } from '@/components/ft'
import { cn } from '@/lib/utils'

const WhatsAppCommunityButtons = dynamic(() => import('@/components/whatsapp-community-buttons').then(m => ({ default: m.WhatsAppCommunityButtons })), { ssr: false, loading: () => null })

const PROOF_POINTS = [
    { icon: Zap, title: 'Data in seconds', desc: 'MTN, Telecel and AirtelTigo bundles, paid from your wallet.' },
    { icon: ShieldCheck, title: 'Sign in your way', desc: 'Use a PIN, passkey, Google or your password.' },
    { icon: Store, title: 'Built to resell', desc: 'Agent tiers and an API are ready when you want to grow.' },
]

export interface AuthShellProps {
    children: ReactNode
    title?: string
    subtitle?: string
    showBrandPanel?: boolean
    /** Rendered below the form card (secondary calls to action). */
    footer?: ReactNode
}

function LogoTile({ size }: { size: number }) {
    return (
        <span
            className="flex items-center justify-center ft-true-white rounded-full bg-white ring-2 ring-ft-blue dark:ring-[color:var(--ft-cyan)]"
            style={{ width: size + 8, height: size + 8 }}
        >
            <BrandLogo width={size} height={size} />
        </span>
    )
}

export function AuthShell({ children, title, subtitle, showBrandPanel = true, footer }: AuthShellProps) {
    return (
        <div className="relative flex min-h-screen w-full flex-col lg:flex-row">
            {showBrandPanel && (
                <aside className="ft-raised relative m-4 hidden w-[440px] shrink-0 flex-col justify-between overflow-hidden p-10 lg:flex xl:w-[500px] xl:p-12">
                    <div className="relative z-10">
                        <Link href="/" className="inline-flex items-center gap-3">
                            <LogoTile size={48} />
                            <BrandTitle className="text-2xl" />
                        </Link>
                        <p className="ft-display mt-12 max-w-[320px] text-4xl font-extrabold leading-tight text-ft-ink">
                            Top up, resell, repeat.
                        </p>
                        <p className="mt-4 max-w-[340px] text-base leading-relaxed text-[color:var(--ft-muted)]">
                            FameTech is where Ghana buys data, airtime and result vouchers, then starts earning from it.
                        </p>
                    </div>
                    <div aria-hidden="true" className="pointer-events-none relative z-0 min-h-[200px] flex-1 overflow-hidden">
                        <div className="absolute -right-24 top-1/2 w-[260px] -translate-y-1/2 opacity-60">
                            <Orbit className="w-full" />
                        </div>
                    </div>
                    <div className="relative z-10 space-y-5">
                        {PROOF_POINTS.map(({ icon: Icon, title: pointTitle, desc }) => (
                            <div key={pointTitle} className="flex items-start gap-4">
                                <span className="ft-clay flex h-11 w-11 shrink-0 items-center justify-center !rounded-2xl">
                                    <Icon className="h-5 w-5" aria-hidden="true" />
                                </span>
                                <div>
                                    <p className="text-base font-semibold text-ft-ink">{pointTitle}</p>
                                    <p className="mt-0.5 text-sm text-[color:var(--ft-muted)]">{desc}</p>
                                </div>
                            </div>
                        ))}
                    </div>
                </aside>
            )}

            <main className="flex min-w-0 flex-1 flex-col px-4 py-4 sm:px-8">
                <div>
                    <ClayButton asChild variant="ghost" className="px-4">
                        <Link href="/">
                            <Home className="h-5 w-5" aria-hidden="true" />
                            <span>Home</span>
                        </Link>
                    </ClayButton>
                </div>

                <div className="mx-auto flex w-full max-w-[440px] flex-1 flex-col justify-center py-6">
                    <Link href="/" className={cn('mb-6 flex flex-col items-center gap-2', showBrandPanel && 'lg:hidden')}>
                        <LogoTile size={56} />
                        <BrandTitle className="text-xl" />
                    </Link>

                    {(title || subtitle) && (
                        <header className="mb-5 text-center">
                            {title && <h1 className="ft-display text-2xl font-extrabold text-ft-ink sm:text-3xl">{title}</h1>}
                            {subtitle && <p className="mt-1.5 break-words text-sm text-[color:var(--ft-muted)]">{subtitle}</p>}
                        </header>
                    )}

                    <NeuCard className="w-full p-5 sm:p-6">{children}</NeuCard>

                    {footer}

                    {showBrandPanel && (
                        <div className="mt-6 w-full">
                            <WhatsAppCommunityButtons compact />
                        </div>
                    )}
                </div>
            </main>
        </div>
    )
}
