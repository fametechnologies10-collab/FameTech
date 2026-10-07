'use client'

/**
 * StorefrontUtilitiesTab — guest-facing entry point for the storefront's Utilities tab
 * (ECG / Ghana Water / DSTV / GOtv / StarTimes). Structurally organized like
 * StorefrontDataTab: this file owns the biller grid + top-level state, and delegates the
 * purchase flow to a colocated sheet (UtilityFlowSheet).
 *
 * Payment itself runs through the parent's shared <ServiceChargeSheet> — passed down as
 * `onProceedToPayment` — so there is no redirect-return resume state to keep here (the old
 * Hubtel-hosted-checkout-page model needed one; the in-app OTP+poll model does not).
 *
 * Gating is NOT re-derived here — `enabledBillers`/`minAmount`/`maxAmount` and the decision to
 * even mount this tab all come from server-computed props (app/shop/[shopSlug]/page.tsx),
 * mirroring how the utility API routes resolve the same gates server-side.
 */

import { useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { UTILITY_BILLERS, UTILITY_BILLER_KEYS, type UtilityBiller } from '@/lib/hubtel-utility/billers'
import { UTILITY_BILLER_META } from './UtilityBillerMeta'
import { UtilityFlowSheet } from './UtilityFlowSheet'
import type { ChargeDescriptor } from './ServiceChargeSheet'
import { UtilityBillerLogo } from '@/components/utility-biller-logo'
import { Clock, Receipt } from 'lucide-react'

interface Props {
    shopSlug: string
    enabledBillers: Partial<Record<UtilityBiller, boolean>>
    minAmount: number
    maxAmount: number
    onProceedToPayment: (descriptor: ChargeDescriptor) => void
}

export function StorefrontUtilitiesTab({ shopSlug, enabledBillers, minAmount, maxAmount, onProceedToPayment }: Props) {
    const billers = UTILITY_BILLER_KEYS.filter((k) => enabledBillers[k] === true)

    const [flowBiller, setFlowBiller] = useState<UtilityBiller | null>(null)
    const [flowOpen, setFlowOpen] = useState(false)

    const accountInputRef = useRef<HTMLInputElement>(null)

    const openBiller = (biller: UtilityBiller) => {
        setFlowBiller(biller)
        setFlowOpen(true)
        // Focus starts inside this click gesture (double rAF) — iOS drops the keyboard
        // if the focus call is deferred via setTimeout instead.
        requestAnimationFrame(() => {
            requestAnimationFrame(() => { accountInputRef.current?.focus() })
        })
    }

    if (billers.length === 0) {
        return (
            <div className="mb-6 bg-white dark:bg-slate-900 rounded-[2rem] border border-gray-200 dark:border-slate-800 shadow-sm p-8 flex flex-col items-center text-center gap-3 animate-in fade-in slide-in-from-bottom-2 duration-300">
                <div className="w-14 h-14 rounded-full bg-amber-100 dark:bg-amber-950/40 flex items-center justify-center">
                    <Clock className="w-7 h-7 text-amber-600 dark:text-amber-400" />
                </div>
                <p className="text-base font-bold text-gray-900 dark:text-white">Utility bills coming soon</p>
                <p className="text-sm text-muted-foreground max-w-xs">
                    The shop owner has utility bill payments coming soon — check back shortly.
                </p>
            </div>
        )
    }

    return (
        <div className="mb-6 space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div className="bg-white dark:bg-slate-900 rounded-[2rem] border border-gray-200 dark:border-slate-800 shadow-sm overflow-hidden p-5">
                <div className="flex items-center gap-3 mb-5 border-b border-gray-100 dark:border-gray-800 pb-5">
                    <div className="w-12 h-12 rounded-xl flex items-center justify-center text-white bg-slate-700 shadow-sm">
                        <Receipt className="w-6 h-6" />
                    </div>
                    <div className="text-left">
                        <h2 className="text-h2 uppercase">Pay a Bill</h2>
                        <p className="text-label text-gray-500 uppercase mt-1">Instant, secure checkout</p>
                    </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {billers.map((biller) => {
                        const def = UTILITY_BILLERS[biller]
                        const meta = UTILITY_BILLER_META[biller]
                        return (
                            <button
                                key={biller}
                                onClick={() => openBiller(biller)}
                                className="flex flex-col items-center gap-2 p-4 rounded-2xl border-2 border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-950/40 transition-all duration-200 active:scale-95 hover:shadow-md hover:border-gray-200 dark:hover:border-slate-700 text-center"
                            >
                                <UtilityBillerLogo biller={biller} FallbackIcon={meta.Icon} badgeClassName={meta.badge} size={60} />
                                <span className="text-[11px] font-bold text-gray-800 dark:text-gray-200 leading-tight">{def.label}</span>
                                <span className="text-[9px] text-muted-foreground leading-tight">{meta.blurb}</span>
                            </button>
                        )
                    })}
                </div>
            </div>

            <UtilityFlowSheet
                biller={flowBiller}
                open={flowOpen}
                onClose={() => setFlowOpen(false)}
                shopSlug={shopSlug}
                minAmount={minAmount}
                maxAmount={maxAmount}
                accountInputRef={accountInputRef}
                onProceedToPayment={onProceedToPayment}
            />
        </div>
    )
}
