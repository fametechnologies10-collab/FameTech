'use client'

import { Megaphone } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AnnouncementCTAButtons } from '@/components/announcements/AnnouncementCTAButtons'

export type AnnouncementDraft = {
    title: string
    message: string
    cta_primary_label?: string | null
    cta_primary_url?: string | null
    cta_secondary_label?: string | null
    cta_secondary_url?: string | null
}

/**
 * Faithful, non-interactive preview of the announcement popup the user will see,
 * including the CTA buttons (rendered via the same shared component). `surface`
 * only swaps the header accent so admins can preview both looks.
 */
export function AnnouncementPreview({ draft, surface }: {
    draft: AnnouncementDraft
    surface: 'dashboard' | 'storefront'
}) {
    return (
        <div className="mx-auto w-full max-w-sm overflow-hidden rounded-[2rem] border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 shadow-sm">
            {/* Gradient header */}
            <div className={cn(
                'relative overflow-hidden px-6 pt-6 pb-7 text-center',
                surface === 'dashboard'
                    ? 'bg-gradient-to-br from-amber-400 via-amber-500 to-orange-500'
                    : 'bg-gradient-to-br from-blue-500 via-blue-600 to-indigo-600'
            )}>
                <div className="absolute -right-10 -top-10 w-32 h-32 rounded-full bg-white/10 pointer-events-none" />
                <div className="relative inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-white/20 border border-white/30 mb-3">
                    <Megaphone className="w-7 h-7 text-white" />
                </div>
                <div className="inline-block px-3 py-1 rounded-full bg-black/15 text-white text-[10px] font-medium tracking-wide mb-2">
                    {surface === 'dashboard' ? 'Official Platform Notice' : 'Shop Announcement'}
                </div>
                <h3 className="text-base font-semibold text-white leading-tight">
                    {draft.title || 'Your title preview'}
                </h3>
            </div>

            {/* Body */}
            <div className="px-6 py-5 text-center">
                <p className="text-[15px] text-gray-600 dark:text-gray-300 leading-relaxed whitespace-pre-wrap font-normal text-left">
                    {draft.message || 'Your message preview will appear here as you type…'}
                </p>
                <AnnouncementCTAButtons row={draft} variant="modal" className="mt-5" />
            </div>

            {/* Footer (visual only) */}
            <div className="px-6 pb-5 pt-3 border-t border-gray-100 dark:border-gray-800 bg-gray-50/60 dark:bg-gray-900/40">
                <div className="w-full py-3 rounded-2xl bg-gray-900 dark:bg-white text-center text-sm font-medium text-white dark:text-gray-900">
                    Got it, thanks!
                </div>
            </div>
        </div>
    )
}
