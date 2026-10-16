'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ClayButton, NeuCard, Orbit } from '@/components/ft'
import { NetworkIcon } from '@/components/network-icon'
import { isSafeHref, type PackagesByNetwork } from '@/components/landing/helpers'
import { HERO_SLIDES } from '@/components/landing/hero-slides'

interface HeroProps {
    customerCountLabel: string
    guestUrl: string
    packagesByNetwork: PackagesByNetwork
}

const PREVIEW_NETWORKS = [
    { key: 'MTN', label: 'MTN' },
    { key: 'Telecel', label: 'Telecel' },
    { key: 'AT', label: 'AirtelTigo' },
]

const SAMPLE_SIZES = ['1GB', '5GB', '10GB']
const ADVANCE_MS = 6000
const RESUME_AFTER_MS = 5000

export function Hero({ customerCountLabel, guestUrl, packagesByNetwork }: HeroProps) {
    // Prices only appear when the admin supplied real ones; otherwise sizes only.
    const live = (packagesByNetwork.MTN ?? []).slice(0, 3)
    const rows = live.length > 0
        ? live.map(p => ({ size: p.volume, price: p.price }))
        : SAMPLE_SIZES.map(size => ({ size, price: '' }))

    const [activeIndex, setActiveIndex] = useState(0)
    const activeIndexRef = useRef(0)
    const resumeAtRef = useRef(0)
    const reducedMotionRef = useRef(false)
    const sectionRef = useRef<HTMLDivElement>(null)
    const isVisibleRef = useRef(true)

    useEffect(() => {
        const mql = window.matchMedia('(prefers-reduced-motion: reduce)')
        reducedMotionRef.current = mql.matches
        const onChange = (e: MediaQueryListEvent) => { reducedMotionRef.current = e.matches }
        if (typeof mql.addEventListener === 'function') {
            mql.addEventListener('change', onChange)
            return () => mql.removeEventListener('change', onChange)
        }
        mql.addListener(onChange)
        return () => mql.removeListener(onChange)
    }, [])

    useEffect(() => {
        const node = sectionRef.current
        if (!node) return
        const observer = new IntersectionObserver(
            ([entry]) => { isVisibleRef.current = entry.isIntersecting },
            { threshold: 0.4 },
        )
        observer.observe(node)
        return () => observer.disconnect()
    }, [])

    useEffect(() => {
        const id = setInterval(() => {
            if (!isVisibleRef.current) return
            if (Date.now() < resumeAtRef.current) return
            const next = (activeIndexRef.current + 1) % HERO_SLIDES.length
            activeIndexRef.current = next
            setActiveIndex(next)
        }, ADVANCE_MS)
        return () => clearInterval(id)
    }, [])

    const goTo = useCallback((index: number) => {
        const clamped = (index + HERO_SLIDES.length) % HERO_SLIDES.length
        activeIndexRef.current = clamped
        setActiveIndex(clamped)
        resumeAtRef.current = Date.now() + RESUME_AFTER_MS
    }, [])

    const slide = HERO_SLIDES[activeIndex]

    return (
        <section ref={sectionRef} className="relative overflow-hidden px-4 pb-16 pt-10 sm:px-6 sm:pb-24 sm:pt-16 lg:px-8">
            <div className="mx-auto grid max-w-7xl items-center gap-12 lg:grid-cols-[1.1fr_0.9fr]">
                <div className="min-w-0">
                    <span className="ft-raised inline-flex items-center rounded-full px-4 py-1.5 text-sm font-semibold text-[color:var(--ft-muted)]">
                        {slide.badge}
                    </span>

                    <h1
                        key={slide.id}
                        className={cn(
                            'ft-display mt-5 break-words text-4xl font-extrabold leading-[1.08] tracking-tight text-ft-ink sm:text-5xl lg:text-6xl',
                            !reducedMotionRef.current && 'animate-ft-hero-in'
                        )}
                    >
                        {slide.headline}
                    </h1>
                    <p className="mt-5 max-w-xl text-lg leading-relaxed text-[color:var(--ft-muted)]">
                        {slide.body}
                    </p>

                    <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                        <ClayButton asChild>
                            <Link href="/auth?tab=signup">
                                Start buying
                                <ArrowRight className="h-4 w-4 shrink-0" aria-hidden="true" />
                            </Link>
                        </ClayButton>
                        {isSafeHref(guestUrl) && (
                            <ClayButton asChild variant="soft">
                                <a href={guestUrl}>Buy as guest</a>
                            </ClayButton>
                        )}
                    </div>

                    <div className="mt-6 flex items-center gap-1.5" role="tablist" aria-label="Hero highlights">
                        {HERO_SLIDES.map((s, i) => (
                            <button
                                key={s.id}
                                type="button"
                                role="tab"
                                aria-selected={i === activeIndex}
                                aria-label={s.headline}
                                onClick={() => goTo(i)}
                                className={cn(
                                    'h-2 rounded-full transition-all duration-300',
                                    i === activeIndex ? 'w-7 bg-[color:var(--ft-blue)]' : 'w-2 bg-[color:var(--ft-lo)] hover:bg-[color:var(--ft-field-edge)]'
                                )}
                            />
                        ))}
                    </div>

                    <p className="mt-6 text-sm font-semibold text-[color:var(--ft-muted)]">
                        Trusted by {customerCountLabel} customers across Ghana
                    </p>
                </div>

                <div className="relative mx-auto w-full min-w-0 max-w-md">
                    <div aria-hidden="true" className="pointer-events-none absolute left-1/2 top-1/2 w-[140%] -translate-x-1/2 -translate-y-1/2">
                        <Orbit className="w-full" />
                    </div>
                    <NeuCard className="relative z-10 p-6">
                        <div className="flex items-center justify-between gap-3">
                            <h2 className="ft-display text-lg font-extrabold text-ft-ink">Quick buy</h2>
                            <span className="ft-raised px-3 py-1 text-xs font-semibold text-[color:var(--ft-muted)]">Preview</span>
                        </div>
                        <ul className="mt-4 flex flex-wrap gap-2" aria-label="Networks">
                            {PREVIEW_NETWORKS.map(n => (
                                <li key={n.key} className="ft-raised flex min-h-12 items-center gap-2 px-3 text-sm font-semibold text-ft-ink">
                                    <NetworkIcon network={n.key} size={24} />
                                    {n.label}
                                </li>
                            ))}
                        </ul>
                        <ul className="mt-4 space-y-2" aria-label="Sample bundles">
                            {rows.map(row => (
                                <li key={row.size} className="ft-raised flex min-h-12 items-center justify-between gap-3 px-4 text-ft-ink">
                                    <span className="font-semibold">{row.size}</span>
                                    {row.price && <span className="text-sm font-semibold text-[color:var(--ft-muted)]">GH₵ {row.price}</span>}
                                </li>
                            ))}
                        </ul>
                        <ClayButton asChild className="mt-5 w-full">
                            <Link href="/auth?tab=signup">Create account to buy</Link>
                        </ClayButton>
                    </NeuCard>
                </div>
            </div>
        </section>
    )
}
