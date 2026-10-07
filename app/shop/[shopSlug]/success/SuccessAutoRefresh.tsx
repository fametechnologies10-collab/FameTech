'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Display-only live refresh for the order-confirmation page. While the order is still
 * in the early "pending" window (row not yet created, or created but fulfillment not
 * yet triggered), it re-reads the server-rendered page on an interval so the status
 * advances on its own (pending → processing / failed) without a manual reload.
 *
 * It does NOT change any order-processing logic — it only calls router.refresh(), which
 * re-runs the success page's server component (revalidate=0 → fresh DB read). Once the
 * status leaves "pending", the parent passes active=false and polling stops. Capped so a
 * stuck order can never poll forever.
 */
export function SuccessAutoRefresh({ active }: { active: boolean }) {
    const router = useRouter()
    const countRef = useRef(0)

    useEffect(() => {
        if (!active) return
        let cancelled = false
        let timer: ReturnType<typeof setTimeout>

        const tick = () => {
            if (cancelled) return
            countRef.current += 1
            if (countRef.current > 30) return // stop after ~5 minutes — never poll forever
            router.refresh()
            timer = setTimeout(tick, countRef.current < 6 ? 6000 : 12000)
        }

        timer = setTimeout(tick, 6000)
        return () => { cancelled = true; clearTimeout(timer) }
    }, [active, router])

    return null
}
