'use client'

import { useEffect, useState } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { useModalQueue } from '@/contexts/modal-queue-context'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Gem, Sparkles, CheckCircle2, Loader2 } from 'lucide-react'
import { toast } from '@/lib/toast'

interface SignupPromoModalProps {
    promoRole: 'dealer' | 'agent' | null
}

export function SignupPromoModal({ promoRole }: SignupPromoModalProps) {
    const { dbUser, isLoading, refreshUser } = useAuth()
    const [isClaiming, setIsClaiming] = useState(false)

    const isEligible =
        promoRole !== null &&
        !isLoading &&
        dbUser !== null &&
        dbUser.role === 'customer' &&
        dbUser.signup_promo_shown === false

    const { canShow, onDismiss } = useModalQueue('SIGNUP_PROMO', isEligible)
    const isOpen = canShow

    const handleClaim = async () => {
        setIsClaiming(true)
        try {
            const res = await fetch('/api/user/claim-signup-promo', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'claim' }),
            })
            const data = await res.json()

            if (res.status === 409) {
                onDismiss()
                return
            }

            if (!res.ok) {
                toast.error(data.error || 'Could not claim promo. Please try again.')
                return
            }

            await refreshUser()
            onDismiss()

            const roleLabel = promoRole === 'dealer' ? 'Dealer' : 'Agent'
            const expiry = new Date(data.expiresAt).toLocaleDateString('en-GB', {
                day: 'numeric', month: 'long', year: 'numeric'
            })
            toast.success(`Welcome! Your free ${roleLabel} access is active until ${expiry}.`)
        } catch {
            toast.error('Something went wrong. Please try again.')
        } finally {
            setIsClaiming(false)
        }
    }

    const handleSkip = async () => {
        onDismiss()
        // Fire-and-forget: mark as shown so it never reappears
        fetch('/api/user/claim-signup-promo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'skip' }),
        }).catch(() => null)
    }

    if (!isEligible) return null

    const isDealer = promoRole === 'dealer'

    const config = isDealer
        ? {
            icon: <Gem className="w-8 h-8 text-violet-200" />,
            gradient: 'bg-gradient-to-br from-violet-600 to-purple-700',
            accentBg: 'bg-gradient-to-br from-violet-50 to-purple-50 dark:from-violet-950 dark:to-purple-950',
            accentBorder: 'border-violet-200 dark:border-violet-800',
            accentText: 'text-violet-900 dark:text-violet-100',
            accentMuted: 'text-violet-700 dark:text-violet-300',
            btnClass: 'bg-violet-600 hover:bg-violet-700',
            badgeBorder: 'border-violet-300',
            badgeText: 'text-violet-700 dark:text-violet-300',
            title: 'Free Dealer Access',
            duration: '1 month',
            description: 'Welcome! As a new member, you can activate a free 1-month Dealer account — no payment required.',
            benefits: [
                'Reseller API access for automated orders',
                'Dealer pricing on all data & airtime bundles',
                'Priority order processing & dedicated support',
            ],
        }
        : {
            icon: <Sparkles className="w-8 h-8 text-blue-200" />,
            gradient: 'bg-gradient-to-br from-blue-500 to-indigo-600',
            accentBg: 'bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-950 dark:to-indigo-950',
            accentBorder: 'border-blue-200 dark:border-blue-800',
            accentText: 'text-blue-900 dark:text-blue-100',
            accentMuted: 'text-blue-700 dark:text-blue-300',
            btnClass: 'bg-blue-600 hover:bg-blue-700',
            badgeBorder: 'border-blue-300',
            badgeText: 'text-blue-700 dark:text-blue-300',
            title: 'Free Agent Access',
            duration: '3 days',
            description: 'Welcome! As a new member, you can activate a free 3-day Agent trial — no payment required.',
            benefits: [
                'Agent pricing on all data & airtime bundles',
                'Set up your own digital storefront',
                'Earn commissions on every sale you make',
            ],
        }

    return (
        <Dialog open={isOpen} onOpenChange={(open) => { if (!open) return }}>
            <DialogContent
                aria-describedby={undefined}
                className="sm:max-w-md w-[95vw] p-0 overflow-hidden rounded-3xl"
                onInteractOutside={(e) => e.preventDefault()}
            >
                {/* Gradient header banner */}
                <div className={`${config.gradient} px-6 pt-6 pb-5`}>
                    <div className="flex items-center gap-3 mb-2">
                        {config.icon}
                        <DialogTitle className="text-2xl font-bold text-white">
                            {config.title}
                        </DialogTitle>
                    </div>
                    <DialogDescription className="text-white/80 text-sm">
                        {config.description}
                    </DialogDescription>
                </div>

                {/* Body */}
                <div className="px-6 py-5 space-y-4">
                    {/* Duration badge */}
                    <div className={`${config.accentBg} border ${config.accentBorder} rounded-xl p-4`}>
                        <div className="flex items-center justify-between mb-3">
                            <span className={`font-semibold ${config.accentText}`}>What you get</span>
                            <Badge variant="outline" className={`${config.badgeBorder} ${config.badgeText} font-semibold`}>
                                Free • {config.duration}
                            </Badge>
                        </div>
                        <ul className="space-y-2">
                            {config.benefits.map((benefit) => (
                                <li key={benefit} className={`flex items-start gap-2 text-sm ${config.accentMuted}`}>
                                    <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" />
                                    {benefit}
                                </li>
                            ))}
                        </ul>
                    </div>

                    <p className="text-xs text-center text-muted-foreground">
                        This offer is available once per account and expires automatically after {config.duration}.
                    </p>
                </div>

                <DialogFooter className="px-6 pb-6 flex-col gap-2">
                    <Button
                        onClick={handleClaim}
                        disabled={isClaiming}
                        className={`w-full h-11 font-semibold text-white ${config.btnClass}`}
                        size="lg"
                    >
                        {isClaiming ? (
                            <>
                                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                Activating…
                            </>
                        ) : (
                            'Claim Free Access'
                        )}
                    </Button>
                    <Button
                        variant="ghost"
                        onClick={handleSkip}
                        disabled={isClaiming}
                        className="w-full text-muted-foreground text-sm"
                    >
                        No thanks, skip
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
