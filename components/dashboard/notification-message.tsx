'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

// Shared notification body renderer for BOTH notification surfaces:
//   * components/dashboard/notifications/NotificationsInbox.tsx (the full page)
//   * components/dashboard/NotificationModal.tsx                (the header bell panel)
//
// Both previously rendered the message with a bare `line-clamp-2` and no way to
// see the rest. Row clicks only mark-as-read and navigate when `action_url` is
// set — and `action_url` is nullable, so for announcements/greetings/promos
// (exactly the long ones) everything past two lines was unreachable anywhere in
// the app. This component is the single place that decides how a message is
// clamped and revealed, so the two surfaces cannot drift apart again.

interface NotificationMessageProps {
    message: string | null | undefined
    /** Typography for the paragraph. The clamp itself is owned by this component. */
    className?: string
    /** Lines shown while collapsed. */
    clampLines?: 2 | 3
}

export function NotificationMessage({ message, className, clampLines = 2 }: NotificationMessageProps) {
    const [expanded, setExpanded] = useState(false)
    const [overflows, setOverflows] = useState(false)
    const ref = useRef<HTMLParagraphElement>(null)

    // Only measure while COLLAPSED. Once expanded the element is its own full
    // height, so scrollHeight === clientHeight and a naive re-measure would flip
    // `overflows` to false and yank the "Show less" control out from under the
    // user mid-read. Skipping the measurement while expanded keeps the last
    // known (true) value.
    useEffect(() => {
        if (expanded) return
        const el = ref.current
        if (!el) return

        // +1 absorbs sub-pixel rounding: some zoom levels/fonts report a
        // scrollHeight a fraction taller than clientHeight for text that is not
        // actually clipped, which would show "Show more" that reveals nothing.
        const check = () => setOverflows(el.scrollHeight > el.clientHeight + 1)
        check()

        // Width changes (rotation, panel resize, sidebar collapse) change how
        // many lines the text needs, so re-check rather than trusting mount.
        if (typeof ResizeObserver === 'undefined') return
        const ro = new ResizeObserver(check)
        ro.observe(el)
        return () => ro.disconnect()
    }, [message, expanded, clampLines])

    const toggle = useCallback((e: React.MouseEvent) => {
        // The parent row navigates and marks-as-read on click. Reading the rest
        // of a message must never do either of those.
        e.stopPropagation()
        setExpanded(v => !v)
    }, [])

    if (!message) return null

    return (
        <>
            <p
                ref={ref}
                className={cn(className, !expanded && (clampLines === 3 ? 'line-clamp-3' : 'line-clamp-2'))}
            >
                {message}
            </p>
            {overflows && (
                <button
                    type="button"
                    onClick={toggle}
                    aria-expanded={expanded}
                    className="mt-1 text-[11px] font-semibold text-blue-600 dark:text-blue-400 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 rounded"
                >
                    {expanded ? 'Show less' : 'Show more'}
                </button>
            )}
        </>
    )
}
