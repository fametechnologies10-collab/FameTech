'use client'

import { useEffect, useState } from 'react'
import { BrandLoader } from './brand-loader'

export function PageReadyLoader() {
    const [visible, setVisible] = useState(true)
    const [fading, setFading] = useState(false)

    useEffect(() => {
        let fadeTimer: ReturnType<typeof setTimeout>

        function hide() {
            setFading(true)
            fadeTimer = setTimeout(() => setVisible(false), 400)
        }

        // DOMContentLoaded fires as soon as HTML is parsed + deferred scripts run —
        // long before images/fonts finish. This gives users the page far sooner than
        // waiting for window.load (which blocks until every asset downloads).
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', hide, { once: true })
            return () => {
                document.removeEventListener('DOMContentLoaded', hide)
                clearTimeout(fadeTimer)
            }
        }

        // readyState is 'interactive' or 'complete' — DOM already ready, hide immediately
        hide()
        return () => clearTimeout(fadeTimer)
    }, [])

    if (!visible) return null

    return (
        <div className={`page-ready-loader ${fading ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}>
            <BrandLoader fullScreen={false} size="lg" />
        </div>
    )
}
