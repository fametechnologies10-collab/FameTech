'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import { supabase } from '@/lib/supabase'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { collectSavedButtons } from '@/lib/announcement-cta'
import { PenSquare, History as HistoryIcon } from 'lucide-react'
import { ComposeTab, type EditingAnnouncement } from '@/components/admin/announcements/ComposeTab'
import { HistoryTab } from '@/components/admin/announcements/HistoryTab'
import type { SystemAnnouncement } from '@/types/supabase'

export default function AdminAnnouncementsPage() {
    const [tab, setTab] = useState<'compose' | 'history'>('compose')
    const [announcements, setAnnouncements] = useState<SystemAnnouncement[]>([])
    const [loading, setLoading] = useState(true)
    const [editing, setEditing] = useState<EditingAnnouncement>(null)

    // Distinct buttons used on past announcements (newest first) — offered for reuse
    // in Compose so the admin never re-types a repeated button.
    const savedButtons = useMemo(() => collectSavedButtons(announcements), [announcements])

    const fetchAnnouncements = useCallback(async () => {
        setLoading(true)
        try {
            // RLS lets admins read all rows (incl. drafts/scheduled) via the
            // select_combined policy; reads stay on the cookie/RLS client.
            const { data, error } = await supabase
                .from('system_announcements')
                .select('*')
                .order('created_at', { ascending: false })
            if (error) throw error
            setAnnouncements((data ?? []) as SystemAnnouncement[])
        } catch (e) {
            console.error('[admin-announcements] fetch error', e)
            toast.error('Failed to load announcements')
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { fetchAnnouncements() }, [fetchAnnouncements])

    function handleEdit(a: SystemAnnouncement) {
        setEditing(a)
        setTab('compose')
    }

    function handleDuplicate(a: SystemAnnouncement) {
        // No id → ComposeTab saves it as a brand-new row.
        setEditing({
            title: `${a.title} (copy)`,
            message: a.message,
            visible_on: a.visible_on,
            cta_primary_label: a.cta_primary_label,
            cta_primary_url: a.cta_primary_url,
            cta_secondary_label: a.cta_secondary_label,
            cta_secondary_url: a.cta_secondary_url,
        })
        setTab('compose')
    }

    function handleSaved() {
        setEditing(null)
        fetchAnnouncements()
        setTab('history')
    }

    const tabBtn = (active: boolean) => cn(
        'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors',
        active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
    )

    return (
        <div className="space-y-4 sm:space-y-6">
            <div>
                <h1 className="text-lg font-semibold text-gray-800 dark:text-white">Announcements</h1>
                <p className="text-sm text-muted-foreground">
                    Compose alerts with optional action buttons, or manage past announcements.
                </p>
            </div>

            {/* Tabs */}
            <div className="inline-flex rounded-lg border border-gray-200 dark:border-gray-700 p-1">
                <button type="button" onClick={() => setTab('compose')} className={tabBtn(tab === 'compose')}>
                    <PenSquare className="w-3.5 h-3.5" /> Compose
                </button>
                <button type="button" onClick={() => setTab('history')} className={tabBtn(tab === 'history')}>
                    <HistoryIcon className="w-3.5 h-3.5" /> History
                    <span className="ml-0.5 rounded-full bg-black/10 dark:bg-white/10 px-1.5 text-[10px] tabular-nums">
                        {announcements.length}
                    </span>
                </button>
            </div>

            {tab === 'compose' ? (
                <ComposeTab editing={editing} onSaved={handleSaved} onCancelEdit={() => setEditing(null)} savedButtons={savedButtons} />
            ) : (
                <HistoryTab
                    announcements={announcements}
                    loading={loading}
                    onEdit={handleEdit}
                    onDuplicate={handleDuplicate}
                    onRefresh={fetchAnnouncements}
                />
            )}
        </div>
    )
}
