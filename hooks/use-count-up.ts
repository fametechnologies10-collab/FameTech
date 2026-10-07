'use client'

import { useState, useEffect, useRef } from 'react'

export function useCountUp(target: number, duration = 700, decimals = 0): string {
    const [display, setDisplay] = useState('0')
    const frameRef = useRef<number | null>(null)
    const prevTarget = useRef(0)

    useEffect(() => {
        if (target === 0) {
            setDisplay(decimals > 0 ? (0).toFixed(decimals) : '0')
            return
        }

        const start = prevTarget.current
        const startTime = performance.now()

        const step = (now: number) => {
            const elapsed = now - startTime
            const progress = Math.min(elapsed / duration, 1)
            const eased = 1 - Math.pow(1 - progress, 3)
            const current = start + (target - start) * eased

            setDisplay(
                decimals > 0
                    ? current.toFixed(decimals)
                    : Math.floor(current).toLocaleString()
            )

            if (progress < 1) {
                frameRef.current = requestAnimationFrame(step)
            } else {
                prevTarget.current = target
            }
        }

        frameRef.current = requestAnimationFrame(step)

        return () => {
            if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
        }
    }, [target, duration, decimals])

    return display
}
