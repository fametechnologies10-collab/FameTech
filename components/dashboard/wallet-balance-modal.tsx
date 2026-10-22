'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useReducedMotion } from 'framer-motion'
import { Wallet } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { useModalQueue } from '@/contexts/modal-queue-context'
import { isLowBalance } from '@/lib/dashboard-summary'
import { useCountUp } from '@/hooks/use-count-up'
import { cn } from '@/lib/utils'

const TOP_UP_HREF = '/dashboard/wallet'
const SEEN_KEY = 'wallet_balance_modal_seen'

/**
 * Session-start balance check-in. Shows once per browser session, right after
 * the dashboard's wallet balance is known, and sits in the shared modal queue
 * so it never races the terms gate, agent-expiry notice, or an announcement.
 */
export function WalletBalanceModal({ balance }: { balance: number | null }) {
    const [hasSeen, setHasSeen] = useState(true) // default true until sessionStorage is checked, so SSR/first paint never flashes it
    const reduceMotion = useReducedMotion()

    useEffect(() => {
        try {
            setHasSeen(!!sessionStorage.getItem(SEEN_KEY))
        } catch {
            setHasSeen(false)
        }
    }, [])

    const shouldShow = balance !== null && !hasSeen
    const { canShow, onDismiss } = useModalQueue('WALLET_BALANCE', shouldShow)
    const isOpen = canShow

    const animated = useCountUp(reduceMotion ? 0 : (balance ?? 0), reduceMotion ? 0 : 700, 2)
    const shown = balance === null ? '0.00' : reduceMotion || animated === '0' ? balance.toFixed(2) : animated

    const low = isLowBalance(balance)

    const handleDismiss = () => {
        try {
            sessionStorage.setItem(SEEN_KEY, 'true')
        } catch {
            // sessionStorage unavailable (private mode) — modal just won't persist "seen" across reloads
        }
        setHasSeen(true)
        onDismiss()
    }

    return (
        <Dialog open={isOpen} onOpenChange={(open) => { if (!open) handleDismiss() }}>
            <DialogContent className="max-w-sm text-center sm:text-left">
                <div
                    className={cn(
                        'mx-auto sm:mx-0 flex h-12 w-12 items-center justify-center rounded-2xl',
                        low ? 'bg-amber-50 dark:bg-amber-900/20' : 'bg-ft-blue/10'
                    )}
                >
                    <Wallet className={cn('h-6 w-6', low ? 'text-amber-700 dark:text-amber-300' : 'text-ft-blue')} />
                </div>

                <DialogTitle className="text-sm font-medium text-muted-foreground">
                    Wallet balance
                </DialogTitle>

                <p className="flex items-baseline justify-center sm:justify-start gap-2">
                    <span className="text-sm font-medium text-muted-foreground">GHS</span>
                    <span className="text-3xl font-bold tabular-nums text-foreground">{shown}</span>
                </p>

                <DialogDescription className={cn('text-sm', low ? 'text-amber-800 dark:text-amber-200' : 'text-muted-foreground')}>
                    {low
                        ? 'Your balance is low. Top up to keep buying data bundles without interruption.'
                        : "You're all set — this is what's available to spend right now."}
                </DialogDescription>

                <div className="flex flex-col sm:flex-row gap-2 pt-1">
                    {low ? (
                        <Link
                            href={TOP_UP_HREF}
                            onClick={handleDismiss}
                            className="inline-flex h-11 flex-1 items-center justify-center rounded-xl bg-ft-blue px-5 text-sm font-semibold text-white hover:bg-ft-blue/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ft-blue focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                        >
                            Top up now
                        </Link>
                    ) : (
                        <Link
                            href={TOP_UP_HREF}
                            onClick={handleDismiss}
                            className="inline-flex h-11 flex-1 items-center justify-center rounded-xl bg-ft-blue px-5 text-sm font-semibold text-white hover:bg-ft-blue/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ft-blue focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                        >
                            View wallet
                        </Link>
                    )}
                    <button
                        type="button"
                        onClick={handleDismiss}
                        className="inline-flex h-11 items-center justify-center rounded-xl px-5 text-sm font-medium text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        {low ? 'Maybe later' : 'Continue'}
                    </button>
                </div>
            </DialogContent>
        </Dialog>
    )
}
