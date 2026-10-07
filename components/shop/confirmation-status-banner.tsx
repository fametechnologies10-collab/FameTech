'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, Info, X, ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils'

// Shop-overview warning banner for Task F4 (KFT SMS v2). Task F3 made shop
// customer order confirmations suppress-until-ready — they only send once a
// shop has SMS activated + an admin-approved sender ID + spare credits. 182
// live shops will otherwise silently stop getting confirmations sent, so
// this banner must be impossible to misread: it shows the single
// highest-priority reason confirmations are off, with a fix-it CTA.
//
// Renders nothing while loading, on fetch error, or once every gate is
// clear (activated && approved sender && not low on credits && the owner's
// own confirmations toggle is on).

interface ConfirmationStatus {
    activated: boolean
    senderStatus: string | null
    hasApprovedSender: boolean
    credits: number
    lowCredits: boolean
    confirmationsEnabled: boolean
}

interface Gap {
    tier: 'warning' | 'neutral'
    title: string
    body: string
}

const SESSION_KEY = 'shop-confirmation-banner-dismissed'

// The dismissal is scoped to the exact combination of gates that produced
// it — sessionStorage stores this fingerprint, not a bare boolean, so if the
// underlying shop state changes (e.g. sender gets approved, then credits run
// low) the fingerprint changes and the banner reappears for the new gap.
function fingerprint(s: ConfirmationStatus): string {
    return [
        'csb',
        s.activated ? 1 : 0,
        s.hasApprovedSender ? 1 : 0,
        s.senderStatus ?? 'none',
        s.lowCredits ? 1 : 0,
        s.confirmationsEnabled ? 1 : 0,
    ].join(':')
}

// Highest-priority gap first: an unactivated shop is the loudest problem, a
// missing/pending sender is next, low credits (a ticking clock) after that,
// and the owner's own "I turned this off myself" choice is quietest of all.
function resolveGap(s: ConfirmationStatus): Gap {
    if (!s.activated) {
        return {
            tier: 'warning',
            title: 'Customer order confirmations are OFF',
            body: 'Activate SMS on your shop to start texting customers an order confirmation automatically.',
        }
    }

    if (!s.hasApprovedSender) {
        const body = s.senderStatus === 'under_review'
            ? 'Your sender ID is awaiting admin approval — confirmations will start as soon as it is approved.'
            : s.senderStatus === 'rejected'
                ? 'Your sender ID request was rejected. Request a new one so customers get order confirmations.'
                : s.senderStatus === 'revoked'
                    ? 'Your sender ID was revoked. Request a new one so customers get order confirmations.'
                    : 'Request a sender ID so customers get order confirmations — shops need their own approved sender before we can text customers.'
        return { tier: 'warning', title: 'Customer order confirmations are paused', body }
    }

    if (s.lowCredits) {
        return {
            tier: 'warning',
            title: `Low SMS credits (${s.credits} left)`,
            body: 'Confirmations pause automatically at 0 credits. Top up now to keep customers informed.',
        }
    }

    return {
        tier: 'neutral',
        title: 'Customer order confirmations are off',
        body: 'You turned off order-confirmation SMS in your shop settings. Customers won’t get a text when they order.',
    }
}

export function ConfirmationStatusBanner() {
    const [status, setStatus] = useState<ConfirmationStatus | null>(null)
    const [dismissed, setDismissed] = useState(false)

    useEffect(() => {
        let cancelled = false
        fetch('/api/shop/confirmation-status')
            .then((res) => (res.ok ? res.json() : null))
            .then((json) => {
                if (cancelled || !json?.success) return
                setStatus(json.data as ConfirmationStatus)
            })
            .catch(() => { /* silent — banner just stays hidden */ })
        return () => { cancelled = true }
    }, [])

    if (!status) return null

    const fullyHealthy = status.activated && status.hasApprovedSender && !status.lowCredits && status.confirmationsEnabled
    if (fullyHealthy) return null

    const key = fingerprint(status)
    if (dismissed) return null
    if (typeof window !== 'undefined' && window.sessionStorage.getItem(SESSION_KEY) === key) return null

    const gap = resolveGap(status)
    const isWarning = gap.tier === 'warning'

    const handleDismiss = () => {
        try { window.sessionStorage.setItem(SESSION_KEY, key) } catch { /* private mode etc — dismiss still works for this render */ }
        setDismissed(true)
    }

    return (
        <div
            className={cn(
                'relative rounded-2xl border p-4 pr-10',
                isWarning
                    ? 'bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-900/50'
                    : 'bg-gray-50 dark:bg-zinc-900/40 border-gray-200 dark:border-gray-800',
            )}
        >
            <button
                type="button"
                onClick={handleDismiss}
                aria-label="Dismiss"
                className={cn(
                    'absolute top-3 right-3 w-6 h-6 rounded-full flex items-center justify-center transition-colors',
                    isWarning
                        ? 'text-amber-500 hover:bg-amber-100 dark:hover:bg-amber-900/40'
                        : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-zinc-800',
                )}
            >
                <X className="w-3.5 h-3.5" />
            </button>

            <div className="flex items-start gap-3">
                {isWarning ? (
                    <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                ) : (
                    <Info className="w-5 h-5 text-gray-400 flex-shrink-0 mt-0.5" />
                )}
                <div className="min-w-0 flex-1">
                    <p className={cn('text-sm font-semibold', isWarning ? 'text-amber-900 dark:text-amber-200' : 'text-gray-700 dark:text-gray-300')}>
                        {gap.title}
                    </p>
                    <p className={cn('text-xs mt-0.5', isWarning ? 'text-amber-800/90 dark:text-amber-300/90' : 'text-gray-500 dark:text-gray-400')}>
                        {gap.body}
                    </p>
                    <Link
                        href="/dashboard/shop/sms"
                        className={cn(
                            'inline-flex items-center gap-1 mt-2 text-xs font-semibold',
                            isWarning
                                ? 'text-amber-700 dark:text-amber-300 hover:text-amber-900 dark:hover:text-amber-200'
                                : 'text-gray-600 dark:text-gray-300 hover:text-gray-800 dark:hover:text-gray-100',
                        )}
                    >
                        {isWarning ? 'Fix in Shop SMS' : 'Manage in Shop SMS'} <ArrowRight className="w-3 h-3" />
                    </Link>
                </div>
            </div>
        </div>
    )
}
