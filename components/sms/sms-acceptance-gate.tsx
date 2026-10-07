'use client'

/**
 * Reusable per-login disallowed-content acceptance gate for SMS surfaces.
 *
 * Blocks the wrapped page behind a non-dismissible modal (no overlay-click,
 * no Escape, no close button) until the current login has explicitly
 * accepted the acceptable-use list for the given product. Acceptance is
 * `sessionStorage`-only — it dies with the browser session and is keyed by
 * `userId` so a different account on the same device is re-prompted.
 *
 * Mirrors the non-dismissible Dialog pattern used by
 * `components/terms/terms-acceptance-modal.tsx` and the cert-skip
 * acceptance dialog in `app/dashboard/sms/business/page.tsx` (Task D1).
 */

import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
    ArrowLeft, Check, AlertTriangle, Landmark, ShieldAlert, Gift, KeyRound,
    UserX, Megaphone, Ban, Link2Off,
} from 'lucide-react'

export type SmsAcceptanceProduct = 'kft' | 'shop'

interface DisallowedItem {
    icon: React.ComponentType<{ className?: string }>
    label: string
}

const KFT_DISALLOWED: DisallowedItem[] = [
    { icon: Landmark, label: 'Impersonating a telco, bank, or MoMo service — including fake "Cash In received" style receipts' },
    { icon: ShieldAlert, label: 'Fraud, scam, or phishing content of any kind' },
    { icon: Gift, label: 'Prize, lottery, or "you have won" bait messages' },
    { icon: KeyRound, label: 'Requesting a PIN, OTP, or password from the recipient' },
    { icon: UserX, label: 'Harassment or threats directed at recipients' },
    { icon: Megaphone, label: 'Unsolicited bulk spam to purchased or no-consent contact lists' },
    { icon: Ban, label: 'Misleading or impersonated sender names' },
    { icon: Link2Off, label: 'Links outside the approved domain allowlist (platform mode)' },
]

const SHOP_DISALLOWED: DisallowedItem[] = [
    { icon: Landmark, label: 'Impersonating a telco or MoMo service — including fake payment / receipt confirmations' },
    { icon: ShieldAlert, label: 'Phishing, scam, or fraud content of any kind' },
    { icon: Gift, label: 'Prize, lottery, or "you have won" bait messages' },
    { icon: KeyRound, label: 'Requesting a PIN, OTP, or password from a customer' },
    { icon: UserX, label: 'Harassment or threats directed at customers' },
    { icon: Megaphone, label: 'Spam to customers who never bought from your shop' },
    { icon: Ban, label: 'Misleading sender identity — pretending to be a different business' },
]

const COPY: Record<SmsAcceptanceProduct, { heading: string; intro: string; items: DisallowedItem[]; warning: string }> = {
    kft: {
        heading: 'Before you send with KFT SMS',
        intro: 'KFT SMS may never be used to send:',
        items: KFT_DISALLOWED,
        warning: 'Abuse of KFT SMS can lead to suspension of your KFT account.',
    },
    shop: {
        heading: 'Before you message your customers',
        intro: 'Shop SMS may never be used to send:',
        items: SHOP_DISALLOWED,
        warning: 'Abuse of Shop SMS can lead to suspension of your shop and account.',
    },
}

function storageKeyFor(userId: string, product: SmsAcceptanceProduct) {
    return `sms-ack:${userId}:${product}`
}

export function SmsAcceptanceGate({
    userId,
    product,
    children,
}: {
    userId: string
    product: SmsAcceptanceProduct
    children: React.ReactNode
}) {
    const router = useRouter()
    // Undecided until the mount effect resolves sessionStorage — never flash
    // real content before we know whether this login has already accepted.
    const [status, setStatus] = useState<'checking' | 'accepted' | 'blocked'>('checking')

    useEffect(() => {
        try {
            const ack = sessionStorage.getItem(storageKeyFor(userId, product))
            setStatus(ack === '1' ? 'accepted' : 'blocked')
        } catch {
            // sessionStorage unavailable (private mode, etc.) — fail closed to the
            // gate; the user can still Accept, it just won't persist this tab.
            setStatus('blocked')
        }
    }, [userId, product])

    const handleAccept = () => {
        try {
            sessionStorage.setItem(storageKeyFor(userId, product), '1')
        } catch {
            // ignore — worst case the gate re-prompts next mount
        }
        setStatus('accepted')
    }

    if (status === 'checking') return null
    if (status === 'accepted') return <>{children}</>

    const copy = COPY[product]

    return (
        <Dialog open>
            <DialogContent
                hideCloseButton
                aria-describedby={undefined}
                onEscapeKeyDown={(e) => e.preventDefault()}
                onInteractOutside={(e) => e.preventDefault()}
                onPointerDownOutside={(e) => e.preventDefault()}
                className="p-0 gap-0 w-full sm:max-w-md max-h-[92dvh] overflow-hidden rounded-t-[2.5rem] sm:rounded-[2.5rem] border border-white/10 bg-white dark:bg-gray-950"
            >
                {/* Header */}
                <div className="bg-gradient-to-br from-red-500 via-rose-500 to-orange-500 px-6 pt-5 pb-6 text-white">
                    <div className="sm:hidden w-10 h-1 rounded-full bg-white/50 mx-auto mb-3" />
                    <span className="inline-block bg-black/20 border border-white/30 rounded-full px-2.5 py-0.5 text-[10px] font-black uppercase tracking-widest">
                        Acceptable Use
                    </span>
                    <DialogTitle className="mt-2 text-xl font-black tracking-tight text-white">
                        {copy.heading}
                    </DialogTitle>
                    <p className="text-[12.5px] font-bold text-white/90">{copy.intro}</p>
                </div>

                {/* Scrollable disallowed-content list */}
                <div className="overflow-y-auto max-h-[46vh] px-6 py-5 overscroll-contain scroll-smooth kfg-scrollbar space-y-2.5">
                    {copy.items.map((item, i) => {
                        const Icon = item.icon
                        return (
                            <div
                                key={i}
                                className="flex items-start gap-3 rounded-xl border border-red-100 dark:border-red-900/40 bg-red-50/60 dark:bg-red-900/10 p-3"
                            >
                                <Icon className="w-4 h-4 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
                                <p className="text-[13px] leading-relaxed text-gray-700 dark:text-gray-300">
                                    {item.label}
                                </p>
                            </div>
                        )
                    })}
                </div>

                {/* Warning + actions — always visible, never scrolled away */}
                <div className="border-t border-gray-100 dark:border-gray-800 bg-gray-50/80 dark:bg-gray-900/40 px-5 pt-3 pb-[calc(16px+env(safe-area-inset-bottom,0px))]">
                    <div className="flex items-start gap-2 text-xs text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl p-3 mb-3">
                        <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                        <span>{copy.warning}</span>
                    </div>
                    <div className="flex gap-2.5">
                        <Button variant="ghost" className="flex-1 h-11" onClick={() => router.back()}>
                            <ArrowLeft className="w-4 h-4 mr-1.5" /> Go back
                        </Button>
                        <Button
                            onClick={handleAccept}
                            className="flex-1 h-11 bg-red-600 hover:bg-red-700 text-white gap-1.5"
                        >
                            <Check className="w-4 h-4" /> I Understand &amp; Accept
                        </Button>
                    </div>
                </div>

                <style jsx global>{`
                    .kfg-scrollbar::-webkit-scrollbar { width: 5px; }
                    .kfg-scrollbar::-webkit-scrollbar-thumb { background: rgba(156,163,175,.35); border-radius: 10px; }
                `}</style>
            </DialogContent>
        </Dialog>
    )
}
