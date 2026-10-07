'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { PromoSlide, PromoTheme } from '@/lib/promo-carousel/types'

const THEME_GRADIENTS: Record<PromoTheme, string> = {
    amber: 'from-amber-700 via-orange-800 to-amber-950',
    violet: 'from-violet-700 via-purple-800 to-violet-950',
    emerald: 'from-emerald-700 via-emerald-800 to-emerald-950',
    blue: 'from-blue-700 via-blue-800 to-blue-950',
    rose: 'from-rose-700 via-rose-800 to-rose-950',
}

const ADVANCE_MS = 5000
const RESUME_AFTER_MS = 4000

// Readable CTA text on a brand-colour background (YIQ). Unparsable -> white.
function readableTextColor(hex: string): string {
    let h = hex.trim().replace(/^#/, '')
    if (/^[0-9a-f]{3}$/i.test(h)) h = h.split('').map(ch => ch + ch).join('')
    if (!/^[0-9a-f]{6}$/i.test(h)) return '#ffffff'
    const r = parseInt(h.slice(0, 2), 16)
    const g = parseInt(h.slice(2, 4), 16)
    const b = parseInt(h.slice(4, 6), 16)
    return (r * 299 + g * 587 + b * 114) / 1000 >= 128 ? '#111827' : '#ffffff'
}

export function PromoCarousel({ slides }: { slides: PromoSlide[] }) {
    const router = useRouter()
    const trackRef = useRef<HTMLDivElement>(null)
    const [activeIndex, setActiveIndex] = useState(0)
    const hasSlides = slides.length > 0

    // Gate flags read by the single autoplay interval. They're toggled, never
    // used to tear down/rebuild the timer, so there's exactly one setInterval
    // for this component's whole lifetime.
    const isVisibleRef = useRef(true)
    const isTabVisibleRef = useRef(true)
    const resumeAtRef = useRef(0)
    const instantScrollRef = useRef(false)
    const activeIndexRef = useRef(0)

    const scrollToIndex = useCallback((index: number) => {
        const track = trackRef.current
        if (!track || slides.length === 0) return
        track.scrollTo({
            left: index * track.clientWidth,
            behavior: instantScrollRef.current ? 'auto' : 'smooth',
        })
    }, [slides.length])

    // prefers-reduced-motion swaps smooth->instant scroll only. Autoplay keeps
    // running regardless — disabling it outright was explicitly rejected.
    useEffect(() => {
        const mql = window.matchMedia('(prefers-reduced-motion: reduce)')
        instantScrollRef.current = mql.matches
        const onChange = (e: MediaQueryListEvent) => { instantScrollRef.current = e.matches }
        // Safari < 14 only has the deprecated addListener/removeListener
        if (typeof mql.addEventListener === 'function') {
            mql.addEventListener('change', onChange)
            return () => mql.removeEventListener('change', onChange)
        }
        mql.addListener(onChange)
        return () => mql.removeListener(onChange)
    }, [])

    // Keep the active index valid if the slide list shrinks
    useEffect(() => {
        if (slides.length > 0 && activeIndexRef.current >= slides.length) {
            activeIndexRef.current = 0
            setActiveIndex(0)
        }
    }, [slides.length])

    // Pause while off-screen
    useEffect(() => {
        const track = trackRef.current
        if (!track) return
        const observer = new IntersectionObserver(
            ([entry]) => { isVisibleRef.current = entry.isIntersecting },
            { threshold: 0.5 },
        )
        observer.observe(track)
        return () => observer.disconnect()
    }, [hasSlides])

    // Pause while the tab is hidden
    useEffect(() => {
        const onVisibility = () => { isTabVisibleRef.current = document.visibilityState === 'visible' }
        document.addEventListener('visibilitychange', onVisibility)
        return () => document.removeEventListener('visibilitychange', onVisibility)
    }, [])

    // Single autoplay interval, created once, cleared on unmount
    useEffect(() => {
        if (slides.length < 2) return
        const id = setInterval(() => {
            if (!isVisibleRef.current || !isTabVisibleRef.current) return
            if (Date.now() < resumeAtRef.current) return
            const next = (activeIndexRef.current + 1) % slides.length
            activeIndexRef.current = next
            setActiveIndex(next)
            scrollToIndex(next)
        }, ADVANCE_MS)
        return () => clearInterval(id)
    }, [slides.length, scrollToIndex])

    const handleInteractionStart = useCallback(() => {
        resumeAtRef.current = Number.POSITIVE_INFINITY
    }, [])
    const handleInteractionEnd = useCallback(() => {
        resumeAtRef.current = Date.now() + RESUME_AFTER_MS
    }, [])
    // Release outside the track must still resume autoplay. Window listeners are
    // used instead of setPointerCapture, which would retarget clicks away from CTA buttons.
    const handlePointerDown = useCallback(() => {
        resumeAtRef.current = Number.POSITIVE_INFINITY
        const release = () => {
            window.removeEventListener('pointerup', release)
            window.removeEventListener('pointercancel', release)
            resumeAtRef.current = Date.now() + RESUME_AFTER_MS
        }
        window.addEventListener('pointerup', release)
        window.addEventListener('pointercancel', release)
    }, [])

    const handleScroll = useCallback(() => {
        const track = trackRef.current
        if (!track || !track.clientWidth) return
        const index = Math.round(track.scrollLeft / track.clientWidth)
        activeIndexRef.current = index
        setActiveIndex(prev => (prev === index ? prev : index))
    }, [])

    const goTo = useCallback((index: number) => {
        const clamped = (index + slides.length) % slides.length
        activeIndexRef.current = clamped
        setActiveIndex(clamped)
        scrollToIndex(clamped)
        resumeAtRef.current = Date.now() + RESUME_AFTER_MS
    }, [scrollToIndex, slides.length])

    const handleCta = useCallback((slide: PromoSlide) => {
        if (!('href' in slide.cta)) {
            slide.cta.onClick()
            return
        }
        const href = slide.cta.href
        if (/^https?:\/\//i.test(href)) window.open(href, '_blank', 'noopener,noreferrer')
        else if (/^(tel|mailto):/i.test(href)) window.location.href = href
        else router.push(href)
    }, [router])

    if (slides.length === 0) return null

    return (
        <div className="relative">
            <div
                ref={trackRef}
                onScroll={handleScroll}
                onPointerDown={handlePointerDown}
                onTouchStart={handleInteractionStart}
                onTouchEnd={handleInteractionEnd}
                className="flex overflow-x-auto snap-x snap-mandatory rounded-2xl [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
            >
                {slides.map(slide => {
                    const Icon = slide.icon
                    const EyebrowIcon = slide.eyebrowIcon
                    return (
                        <div
                            key={slide.id}
                            className={cn(
                                'snap-center shrink-0 w-full h-44 sm:h-48 rounded-2xl p-5 flex flex-col justify-between text-white bg-gradient-to-br shadow-lg',
                                THEME_GRADIENTS[slide.theme],
                            )}
                        >
                            <div className="flex items-start justify-between gap-3">
                                <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider bg-white/15 rounded-full px-2.5 py-1">
                                    <EyebrowIcon className="w-3 h-3" />
                                    {slide.eyebrow}
                                </span>
                                <div className="w-10 h-10 rounded-xl bg-white/15 flex items-center justify-center flex-shrink-0">
                                    <Icon className="w-5 h-5" />
                                </div>
                            </div>
                            <div className="space-y-1">
                                <p className="text-base font-bold leading-tight">{slide.title}</p>
                                <p className="text-xs text-white/80 leading-snug line-clamp-2">{slide.body}</p>
                            </div>
                            <button
                                onClick={() => handleCta(slide)}
                                style={slide.accentColor ? { backgroundColor: slide.accentColor, color: readableTextColor(slide.accentColor) } : undefined}
                                className={cn(
                                    'self-start text-xs font-bold px-3.5 py-2 rounded-lg transition-transform active:scale-95',
                                    !slide.accentColor && 'bg-white text-gray-900 hover:bg-white/90',
                                )}
                            >
                                {slide.cta.label}
                            </button>
                        </div>
                    )
                })}
            </div>

            {slides.length > 1 && (
                <>
                    <button
                        aria-label="Previous"
                        onClick={() => goTo(activeIndex - 1)}
                        className="hidden sm:flex absolute left-2 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-black/30 hover:bg-black/45 text-white items-center justify-center"
                    >
                        <ChevronLeft className="w-4 h-4" />
                    </button>
                    <button
                        aria-label="Next"
                        onClick={() => goTo(activeIndex + 1)}
                        className="hidden sm:flex absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-black/30 hover:bg-black/45 text-white items-center justify-center"
                    >
                        <ChevronRight className="w-4 h-4" />
                    </button>
                    <div className="flex items-center justify-center gap-1.5 mt-2.5">
                        {slides.map((slide, i) => (
                            <button
                                key={slide.id}
                                aria-label={`Go to slide ${i + 1}`}
                                onClick={() => goTo(i)}
                                className={cn(
                                    'h-1.5 rounded-full transition-all',
                                    i === activeIndex ? 'w-5 bg-foreground/70' : 'w-1.5 bg-foreground/20',
                                )}
                            />
                        ))}
                    </div>
                </>
            )}
        </div>
    )
}
