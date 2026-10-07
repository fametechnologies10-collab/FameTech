'use client'

import { BadgeCheck, Smartphone, Info } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Reusable "what is a sender ID" explainer for KFT SMS.
 *
 * - `compact`: a single-line info strip — used inline in wizards / banners
 *   where space is tight (e.g. shop setup wizard final step).
 * - `full`: the complete explanation with an example phone preview and a
 *   short rule list — used on dedicated request pages.
 */
export function SenderIdExplainer({
    variant = 'full',
    className,
}: {
    variant?: 'compact' | 'full'
    className?: string
}) {
    if (variant === 'compact') {
        return (
            <div className={cn(
                'flex items-start gap-2.5 rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50/60 dark:bg-emerald-900/10 p-3',
                className,
            )}>
                <BadgeCheck className="w-4 h-4 text-emerald-600 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-emerald-800 dark:text-emerald-300 leading-relaxed">
                    A <strong>sender ID</strong> is the name customers see instead of a phone number when you SMS
                    them — e.g. <span className="font-mono font-semibold">&quot;KFT Shop&quot;</span> (max 11 characters).
                    Request your own so order confirmations arrive from <strong>your brand</strong>, not KINGFLEXY.
                </p>
            </div>
        )
    }

    return (
        <div className={cn('rounded-xl border bg-muted/30 p-4 space-y-3', className)}>
            <div className="flex items-center gap-2">
                <BadgeCheck className="w-4 h-4 text-emerald-600" />
                <p className="text-sm font-semibold">What is a sender ID?</p>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
                A sender ID is the name that shows up as the sender on your customer&apos;s phone when they receive an
                SMS from you — instead of a random phone number, they see <strong>your brand name</strong>.
                It can be up to <strong>11 characters</strong> (letters, numbers and spaces only).
            </p>

            {/* Phone preview mock */}
            <div className="rounded-xl border bg-white dark:bg-zinc-900 p-3">
                <div className="flex items-center gap-1.5 mb-2">
                    <Smartphone className="w-3 h-3 text-muted-foreground" />
                    <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">On your customer&apos;s phone</p>
                </div>
                <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center text-[10px] font-black text-emerald-700 dark:text-emerald-400 flex-shrink-0">
                        KS
                    </div>
                    <div>
                        <p className="text-xs font-bold">KFT Shop</p>
                        <p className="text-[10px] text-muted-foreground">Your order of GHS 25 MTN data is confirmed. Thank you!</p>
                    </div>
                </div>
            </div>

            <div className="flex items-start gap-2 pt-1">
                <Info className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0 mt-0.5" />
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                    Why it matters: customers trust messages from <strong>your brand</strong> more than a generic
                    number. Every sender ID request is reviewed before it goes live to prevent impersonation.
                </p>
            </div>
        </div>
    )
}
