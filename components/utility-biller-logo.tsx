'use client'

import Image from 'next/image'
import { useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { UtilityBiller } from '@/lib/hubtel-utility/billers'

// Real biller logos, mirroring components/network-icon.tsx's pattern for MTN/Telecel/AT:
// a static file per key, loaded via next/image, falling back to a Lucide icon+badge on a
// missing/broken image (`onError`) so the UI never breaks while logo assets are still being
// sourced/added. Deliberately takes the fallback Icon/badge as PROPS rather than importing
// UTILITY_BILLER_META or BILLER_UI itself — those two meta files intentionally stay separate
// (storefront never reaches into app/dashboard, and vice versa; see UtilityBillerMeta.ts's
// header comment), so this shared component must not pick a side.
//
// Each biller maps to its EXACT filename under public/images/utilities/ — a direct lookup,
// not a guessed extension. This used to probe up to 5 candidate extensions per biller
// (png/jpg/jpeg/svg/webp), each a sequential onError-triggered request — since the actual
// files never matched the old `${biller}.<ext>` guess (they arrived as `New_<Biller>_Logo.png`),
// EVERY biller logo was silently 404-ing its way through all 5 candidates before ever
// falling back to the icon+badge, on every render. That was the real "logos take a while to
// load" complaint — not image size, a wasted request waterfall. A direct map is a single
// request per logo, and doubles as the definition of "this is the current logo file."
const BILLER_LOGO_FILE: Record<UtilityBiller, string> = {
    ecg: 'New_ECG_Logo.png',
    ghana_water: 'New_Ghana_Water_Logo.png',
    dstv: 'New_DStv_Logo.png',
    gotv: 'New_GOtv_Logo.png',
    startimes: 'New_Startimes_Logo.png',
}

interface UtilityBillerLogoProps {
    biller: UtilityBiller
    FallbackIcon: LucideIcon
    /** Fallback badge background/fg classes (e.g. UTILITY_BILLER_META[biller].badge) — also used
     * as the real-logo tile's background so a non-square/transparent logo still reads as intentional. */
    badgeClassName: string
    size?: number
    className?: string
    rounded?: 'lg' | 'xl' | 'full'
}

export function UtilityBillerLogo({
    biller, FallbackIcon, badgeClassName, size = 40, className = '', rounded = 'xl',
}: UtilityBillerLogoProps) {
    const [broken, setBroken] = useState(false)
    const roundedClass = rounded === 'full' ? 'rounded-full' : rounded === 'lg' ? 'rounded-lg' : 'rounded-xl'

    if (!broken) {
        return (
            <div
                className={cn('relative overflow-hidden shrink-0', roundedClass, badgeClassName, className)}
                style={{ width: size, height: size }}
            >
                <Image
                    key={biller}
                    src={`/images/utilities/${BILLER_LOGO_FILE[biller]}`}
                    alt=""
                    fill
                    sizes={`${size}px`}
                    className="object-contain p-1"
                    onError={() => setBroken(true)}
                />
            </div>
        )
    }

    return (
        <div
            className={cn('flex items-center justify-center shrink-0', roundedClass, badgeClassName, className)}
            style={{ width: size, height: size }}
        >
            <FallbackIcon style={{ width: size * 0.5, height: size * 0.5 }} />
        </div>
    )
}
