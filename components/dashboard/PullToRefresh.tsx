'use client'

import { useRef, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { RefreshCw } from 'lucide-react'

interface PullToRefreshProps {
    children: React.ReactNode
    /** Minimum pull distance in px before refresh triggers (default: 72) */
    threshold?: number
}

/**
 * PullToRefresh
 *
 * Wraps dashboard content with a native-feeling pull-down-to-refresh gesture
 * for PWA / mobile users.
 *
 * - Touch-only: does nothing on desktop (mouse events are ignored)
 * - On a successful pull (≥ threshold), calls router.refresh() to re-fetch
 *   all server component data without a full page reload
 * - Smooth spring animation on the spinner indicator
 */
export default function PullToRefresh({ children, threshold = 72 }: PullToRefreshProps) {
    const router = useRouter()
    const containerRef = useRef<HTMLDivElement>(null)
    const startYRef = useRef<number>(0)
    const [pullDistance, setPullDistance] = useState(0)
    const [isRefreshing, setIsRefreshing] = useState(false)
    const [refreshDone, setRefreshDone] = useState(false)
    const pullingRef = useRef(false)

    const handleTouchStart = useCallback((e: React.TouchEvent) => {
        // Only activate pull when the user is at the very top of the scroll container
        const el = containerRef.current
        if (!el) return
        if (el.scrollTop > 0) return
        startYRef.current = e.touches[0].clientY
        pullingRef.current = true
    }, [])

    const handleTouchMove = useCallback((e: React.TouchEvent) => {
        if (!pullingRef.current || isRefreshing) return
        const delta = e.touches[0].clientY - startYRef.current
        if (delta <= 0) {
            setPullDistance(0)
            return
        }
        // Apply rubber-band resistance: less movement as you pull further
        const clamped = Math.min(delta * 0.45, threshold * 1.6)
        setPullDistance(clamped)
        // Prevent default scroll while pulling down
        if (delta > 5) e.preventDefault()
    }, [isRefreshing, threshold])

    const handleTouchEnd = useCallback(async () => {
        if (!pullingRef.current) return
        pullingRef.current = false

        if (pullDistance >= threshold && !isRefreshing) {
            setIsRefreshing(true)
            setPullDistance(threshold) // lock indicator at threshold height
            try {
                router.refresh()
                // Dispatch a global event so Client Components can also refresh their state
                window.dispatchEvent(new CustomEvent('app-refresh'))
                await new Promise(r => setTimeout(r, 1200)) // Give server time to re-fetch
                setRefreshDone(true)
                await new Promise(r => setTimeout(r, 600))
            } finally {
                setIsRefreshing(false)
                setRefreshDone(false)
                setPullDistance(0)
            }
        } else {
            setPullDistance(0)
        }
    }, [pullDistance, isRefreshing, threshold, router])

    const indicatorOpacity = Math.min(pullDistance / threshold, 1)
    const indicatorScale = 0.4 + Math.min(pullDistance / threshold, 1) * 0.6
    const indicatorRotation = (pullDistance / threshold) * 360

    return (
        <>
            <style dangerouslySetInnerHTML={{ __html: `
                .ptr-container { 
                    touch-action: ${pullDistance > 0 ? 'none' : 'pan-y'}; 
                    -webkit-overflow-scrolling: touch;
                }
                .ptr-indicator-wrap { height: ${pullDistance}px; opacity: ${indicatorOpacity}; }
                .ptr-indicator { transform: scale(${indicatorScale}) rotate(${isRefreshing ? 0 : indicatorRotation}deg); }
                .ptr-content { 
                    transform: ${pullDistance > 0 ? `translateY(${pullDistance}px)` : 'none'}; 
                    transition: ${pullingRef.current ? 'none' : 'transform 0.3s cubic-bezier(0.34,1.56,0.64,1)'}; 
                }
            `}} />
            <div
                ref={containerRef}
                className="ptr-container relative h-full overflow-y-auto overflow-x-hidden"
                onTouchStart={handleTouchStart}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
            >
                {/* Pull indicator */}
                <div
                    className="ptr-indicator-wrap absolute top-0 left-0 right-0 flex items-center justify-center pointer-events-none z-50 transition-all duration-150"
                >
                    <div
                        className={`ptr-indicator w-9 h-9 rounded-full flex items-center justify-center shadow-lg border-2
                            ${refreshDone
                                ? 'bg-emerald-500 border-emerald-400 text-white'
                                : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300'
                            }`}
                    >
                        <RefreshCw
                            className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`}
                        />
                    </div>
                </div>

                {/* Main content shifts down during pull */}
                <div className="ptr-content">
                    {children}
                </div>
            </div>
        </>
    )
}
