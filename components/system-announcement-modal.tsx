'use client'

import { useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useModalQueue } from '@/contexts/modal-queue-context'
import { useUI } from '@/contexts/ui-context'
import { Megaphone } from 'lucide-react'
import { SystemAnnouncement } from '@/types/supabase'
import { cn } from '@/lib/utils'
import { AnnouncementCTAButtons } from '@/components/announcements/AnnouncementCTAButtons'

const COUNTDOWN_SECONDS = 5

export function SystemAnnouncementModal() {
    const [announcement, setAnnouncement] = useState<SystemAnnouncement | null>(null)
    const [hasSeen, setHasSeen] = useState(false)
    const [countdown, setCountdown] = useState(0)
    const { setActiveAnnouncement, announcementReopenTick } = useUI()

    useEffect(() => {
        checkAnnouncements()
    }, [])

    // Let the dashboard carousel know an announcement exists, and clear it if this unmounts.
    useEffect(() => {
        setActiveAnnouncement(announcement ? { id: announcement.id, title: announcement.title ?? '' } : null)
        return () => setActiveAnnouncement(null)
    }, [announcement, setActiveAnnouncement])

    // Re-show on request (e.g. the carousel's "Read Announcement" button), even if already seen.
    // The tick lives in the root UIProvider and outlives this component, so compare against the
    // value at mount — otherwise coming back to the dashboard would re-open a notice already read.
    const handledReopenTick = useRef(announcementReopenTick)
    useEffect(() => {
        if (announcementReopenTick === handledReopenTick.current) return
        handledReopenTick.current = announcementReopenTick
        setHasSeen(false)
    }, [announcementReopenTick])

    const checkAnnouncements = async () => {
        try {
            const { data, error } = await supabase
                .from('system_announcements')
                .select('id, title, message, cta_primary_label, cta_primary_url, cta_secondary_label, cta_secondary_url')
                .eq('is_active', true)
                .in('visible_on', ['main_site', 'both'])
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle()

            if (error) {
                console.error('Error fetching announcement:', error)
                return
            }

            if (data) {
                const seenKey = `announcement_seen_${(data as any).id}`
                const seen = !!sessionStorage.getItem(seenKey)
                setAnnouncement(data as SystemAnnouncement)
                setHasSeen(seen)
            }
        } catch (err) {
            console.error('Failed to check announcements', err)
        }
    }

    const shouldShow = !!announcement && !hasSeen
    const { canShow, onDismiss: queueDismiss } = useModalQueue('ANNOUNCEMENT', shouldShow)
    const isOpen = canShow

    useEffect(() => {
        if (!isOpen) { setCountdown(0); return }
        setCountdown(COUNTDOWN_SECONDS)
    }, [isOpen])

    useEffect(() => {
        if (countdown <= 0) return
        const t = setTimeout(() => setCountdown(c => c - 1), 1000)
        return () => clearTimeout(t)
    }, [countdown])

    const handleDismiss = () => {
        if (countdown > 0) return
        if (announcement) {
            sessionStorage.setItem(`announcement_seen_${announcement.id}`, 'true')
            setHasSeen(true)
            queueDismiss()
        }
    }

    if (!isOpen || !announcement) return null

    return (
        <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center">
            {/* Backdrop — no dismiss on click, user must read */}
            <div className="absolute inset-0 bg-black/70 backdrop-blur-md animate-in fade-in duration-200" />

            {/* Card — bottom-sheet on mobile, centred dialog on sm+ */}
            <div className={cn(
                "relative w-full sm:max-w-md sm:mx-4",
                "bg-white dark:bg-gray-950",
                "rounded-t-[2.5rem] sm:rounded-[2.5rem]",
                "shadow-[0_-20px_80px_rgba(0,0,0,0.3)] sm:shadow-2xl",
                "overflow-hidden border border-white/10 dark:border-white/5",
                "animate-in slide-in-from-bottom sm:zoom-in-95 fade-in duration-300"
            )}>
                {/* Drag handle pill (mobile only) */}
                <div className="sm:hidden flex justify-center pt-3 pb-1">
                    <div className="w-10 h-1 rounded-full bg-gray-300 dark:bg-gray-700" />
                </div>

                {/* Gradient header */}
                <div className="relative overflow-hidden px-6 pt-6 pb-7 text-center bg-gradient-to-br from-amber-400 via-amber-500 to-orange-500">
                    <div className="absolute -right-10 -top-10 w-36 h-36 rounded-full bg-white/10 pointer-events-none" />
                    <div className="absolute -left-6 bottom-0 w-24 h-24 rounded-full bg-black/5 pointer-events-none" />

                    <div className="relative inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-white/20 backdrop-blur-sm border border-white/30 mb-4">
                        <Megaphone className="w-8 h-8 text-white" />
                    </div>

                    <div className="inline-block px-3 py-1 rounded-full bg-black/15 text-white text-[10px] font-medium tracking-wide mb-2">
                        Official Platform Notice
                    </div>

                    <h3 className="text-base sm:text-lg font-semibold text-white leading-tight">
                        {announcement.title || 'Important Update'}
                    </h3>
                </div>

                {/* Scrollable message body */}
                <div className="overflow-y-auto max-h-[38vh] sm:max-h-[45vh] px-6 py-5 text-center kfg-scrollbar">
                    <p className="text-[15px] text-gray-600 dark:text-gray-300 leading-relaxed whitespace-pre-wrap font-normal text-left">
                        {announcement.message}
                    </p>
                    <AnnouncementCTAButtons row={announcement} variant="modal" className="mt-5" />
                </div>

                {/* Footer with countdown button */}
                <div className="px-6 pb-[calc(env(safe-area-inset-bottom,0px)+20px)] sm:pb-6 pt-4 border-t border-gray-100 dark:border-gray-800 bg-gray-50/80 dark:bg-gray-900/40">
                    <button
                        type="button"
                        onClick={handleDismiss}
                        disabled={countdown > 0}
                        className={cn(
                            "w-full py-4 rounded-2xl font-medium text-sm transition-all duration-200",
                            "flex items-center justify-center gap-2.5 active:scale-[0.98]",
                            countdown > 0
                                ? "bg-gray-200 dark:bg-gray-800 text-gray-400 dark:text-gray-500 cursor-not-allowed"
                                : "bg-gray-900 dark:bg-white text-white dark:text-gray-900 hover:opacity-90 shadow-lg"
                        )}
                    >
                        {countdown > 0 ? (
                            <>
                                <span className="inline-flex items-center justify-center w-6 h-6 rounded-full border-2 border-gray-400 dark:border-gray-500 text-xs font-semibold tabular-nums">
                                    {countdown}
                                </span>
                                Please read…
                            </>
                        ) : (
                            'Got it, thanks!'
                        )}
                    </button>
                </div>
            </div>

            <style jsx global>{`
                .kfg-scrollbar::-webkit-scrollbar { width: 5px; }
                .kfg-scrollbar::-webkit-scrollbar-track { background: transparent; }
                .kfg-scrollbar::-webkit-scrollbar-thumb { background: rgba(156,163,175,0.3); border-radius: 10px; }
            `}</style>
        </div>
    )
}
