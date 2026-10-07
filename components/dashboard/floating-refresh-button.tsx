'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { RefreshCcw } from 'lucide-react'
import { cn } from '@/lib/utils'

const SIZE = 56          // h-14 w-14
const EDGE = 12          // min gap from any viewport edge
const DRAG_THRESHOLD = 5 // px of movement before it counts as a drag (not a tap)
const STORAGE_KEY = 'kfg_refresh_fab_pos'

type Pos = { x: number; y: number }

export function FloatingRefreshButton() {
    const [isRefreshing, setIsRefreshing] = useState(false)
    const [mounted, setMounted] = useState(false)
    const [pos, setPos] = useState<Pos | null>(null)
    const drag = useRef<{ startX: number; startY: number; origX: number; origY: number; moved: boolean } | null>(null)

    const clamp = useCallback((p: Pos): Pos => ({
        x: Math.min(Math.max(EDGE, p.x), window.innerWidth - SIZE - EDGE),
        y: Math.min(Math.max(EDGE, p.y), window.innerHeight - SIZE - EDGE),
    }), [])

    // Restore saved position, or default to bottom-right (clear of the mobile nav bar).
    useEffect(() => {
        setMounted(true)
        try {
            const saved = localStorage.getItem(STORAGE_KEY)
            if (saved) { setPos(clamp(JSON.parse(saved))); return }
        } catch { /* ignore */ }
        const isDesktop = window.innerWidth >= 768
        setPos(clamp({
            x: window.innerWidth - SIZE - (isDesktop ? 32 : 20),
            y: window.innerHeight - SIZE - (isDesktop ? 32 : 144),
        }))
    }, [clamp])

    // Keep it on-screen when the viewport resizes/rotates.
    useEffect(() => {
        if (!mounted) return
        const onResize = () => setPos(p => (p ? clamp(p) : p))
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
    }, [mounted, clamp])

    const onPointerDown = useCallback((e: React.PointerEvent) => {
        if (!pos) return
        drag.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y, moved: false }
        e.currentTarget.setPointerCapture?.(e.pointerId)
    }, [pos])

    const onPointerMove = useCallback((e: React.PointerEvent) => {
        const d = drag.current
        if (!d) return
        const dx = e.clientX - d.startX
        const dy = e.clientY - d.startY
        if (!d.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) d.moved = true
        if (d.moved) setPos(clamp({ x: d.origX + dx, y: d.origY + dy }))
    }, [clamp])

    const onPointerUp = useCallback(() => {
        const d = drag.current
        drag.current = null
        if (!d) return
        if (d.moved) {
            // Persist the dropped position.
            setPos(p => { if (p) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(p)) } catch { /* ignore */ } } return p })
        } else {
            // No movement → treat as a tap: refresh.
            setIsRefreshing(true)
            window.location.reload()
        }
    }, [])

    if (!mounted || !pos) return null

    return createPortal(
        <button
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            disabled={isRefreshing}
            style={{ left: pos.x, top: pos.y, touchAction: 'none' }}
            className={cn(
                "fixed z-[9999] flex h-14 w-14 items-center justify-center rounded-full",
                "bg-white dark:bg-slate-800 text-slate-900 dark:text-white",
                "shadow-lg dark:shadow-black/40 border border-slate-200 dark:border-slate-700",
                "transition-colors hover:bg-slate-100 dark:hover:bg-slate-700 active:scale-95",
                "disabled:opacity-80 cursor-grab active:cursor-grabbing select-none touch-none"
            )}
            aria-label="Refresh (drag to move)"
            title="Tap to refresh · drag to move"
        >
            <RefreshCcw className={cn("h-6 w-6 pointer-events-none", isRefreshing && "animate-spin")} />
        </button>,
        document.body
    )
}
