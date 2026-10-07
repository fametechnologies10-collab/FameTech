'use client'

import { useEffect, useState } from 'react'
import { useAuth, anyTabActiveWithin } from '@/contexts/auth-context'
import { Clock, LogOut, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'

const WARNING_SECONDS = 60 * 60 // 60 minutes countdown

export function SessionExpiryModal() {
    const { sessionExpiring, extendSession, signOut } = useAuth()
    const [secondsLeft, setSecondsLeft] = useState(WARNING_SECONDS)

    // Reset countdown whenever the modal appears
    useEffect(() => {
        if (!sessionExpiring) { setSecondsLeft(WARNING_SECONDS); return }
        setSecondsLeft(WARNING_SECONDS)
    }, [sessionExpiring])

    // Tick down while visible; sign out immediately when it hits zero
    useEffect(() => {
        if (!sessionExpiring) return
        const t = setInterval(() => {
            setSecondsLeft(s => {
                if (s <= 1) {
                    clearInterval(t)
                    // Last-second cross-tab check: if the user became active in a
                    // sibling tab within the last minute (before the 30s inactivity
                    // sweep could clear sessionExpiring), don't sign them out —
                    // extend instead. Prevents an idle tab killing an active one.
                    if (anyTabActiveWithin(60_000)) {
                        extendSession()
                        return WARNING_SECONDS
                    }
                    signOut()
                    return 0
                }
                return s - 1
            })
        }, 1000)
        return () => clearInterval(t)
    }, [sessionExpiring, signOut, extendSession])

    if (!sessionExpiring) return null

    const mins = Math.floor(secondsLeft / 60)
    const secs = secondsLeft % 60
    const timeStr = `${mins}:${String(secs).padStart(2, '0')}`
    const urgency = secondsLeft <= 60

    return (
        <div className="fixed inset-0 z-[200] flex items-end sm:items-center justify-center">
            {/* Backdrop */}
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200" />

            {/* Sheet */}
            <div className={cn(
                "relative w-full sm:max-w-sm sm:mx-4",
                "bg-white dark:bg-gray-950",
                "rounded-t-[2.5rem] sm:rounded-[2.5rem]",
                "shadow-[0_-20px_80px_rgba(0,0,0,0.3)] sm:shadow-2xl",
                "overflow-hidden border border-white/10",
                "animate-in slide-in-from-bottom sm:zoom-in-95 fade-in duration-300"
            )}>
                {/* Drag handle */}
                <div className="sm:hidden flex justify-center pt-3 pb-1">
                    <div className="w-10 h-1 rounded-full bg-gray-300 dark:bg-gray-700" />
                </div>

                {/* Header */}
                <div className={cn(
                    "relative overflow-hidden px-6 pt-6 pb-7 text-center",
                    urgency
                        ? "bg-gradient-to-br from-red-500 via-red-600 to-rose-700"
                        : "bg-gradient-to-br from-amber-400 via-amber-500 to-orange-500"
                )}>
                    <div className="absolute -right-8 -top-8 w-32 h-32 rounded-full bg-white/10 pointer-events-none" />
                    <div className="absolute -left-4 bottom-0 w-20 h-20 rounded-full bg-black/5 pointer-events-none" />

                    <div className="relative inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-white/20 backdrop-blur-sm border border-white/30 mb-4">
                        <Clock className={cn("w-8 h-8 text-white", urgency && "animate-pulse")} />
                    </div>

                    <div className="inline-block px-3 py-1 rounded-full bg-black/15 text-white text-[10px] font-black uppercase tracking-widest mb-2">
                        Session Expiring
                    </div>

                    <h3 className="text-2xl font-black text-white tabular-nums">{timeStr}</h3>
                    <p className="text-white/80 text-sm mt-1">until automatic sign-out</p>
                </div>

                {/* Body */}
                <div className="px-6 py-5">
                    <p className="text-sm text-gray-600 dark:text-gray-300 text-center leading-relaxed">
                        You have been inactive for a while. For your security, your session will expire soon. Stay signed in or sign out now.
                    </p>
                </div>

                {/* Footer */}
                <div className="px-6 pb-[calc(env(safe-area-inset-bottom,0px)+20px)] sm:pb-6 pt-0 space-y-2 border-t border-gray-100 dark:border-gray-800 bg-gray-50/80 dark:bg-gray-900/40">
                    <button
                        type="button"
                        onClick={extendSession}
                        className="w-full py-4 rounded-2xl font-bold text-sm flex items-center justify-center gap-2.5 active:scale-[0.98] transition-all bg-gray-900 dark:bg-white text-white dark:text-gray-900 hover:opacity-90 shadow-lg mt-4"
                    >
                        <RefreshCw className="w-4 h-4" />
                        Stay Signed In
                    </button>
                    <button
                        type="button"
                        onClick={() => signOut()}
                        className="w-full py-2.5 rounded-2xl font-semibold text-xs text-gray-500 dark:text-gray-400 hover:text-red-600 dark:hover:text-red-400 transition-colors flex items-center justify-center gap-2"
                    >
                        <LogOut className="w-3.5 h-3.5" />
                        Sign Out Now
                    </button>
                </div>
            </div>
        </div>
    )
}
