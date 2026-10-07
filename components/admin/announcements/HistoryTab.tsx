'use client'

import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Loader2, Pencil, Trash2, Copy, Link2 } from 'lucide-react'
import { toast } from '@/lib/toast'
import { formatDate } from '@/lib/utils'
import { resolveCtas } from '@/lib/announcement-cta'
import { computeShowingIds } from '@/lib/announcement-visibility'
import type { SystemAnnouncement } from '@/types/supabase'

type Filter = 'all' | 'published' | 'scheduled' | 'drafts' | 'off'

const FILTERS: { value: Filter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'published', label: 'Published' },
    { value: 'scheduled', label: 'Scheduled' },
    { value: 'drafts', label: 'Drafts' },
    { value: 'off', label: 'Off' },
]

function matchesFilter(a: SystemAnnouncement, f: Filter): boolean {
    const status = a.status ?? 'published'
    if (f === 'all') return true
    if (f === 'drafts') return status === 'draft'
    if (f === 'scheduled') return status === 'scheduled'
    if (f === 'published') return status === 'published' && a.is_active === true
    if (f === 'off') return status === 'published' && a.is_active !== true
    return true
}

function StatusBadge({ a, showing }: { a: SystemAnnouncement; showing: boolean }) {
    const status = a.status ?? 'published'
    if (status === 'draft') return <Badge variant="secondary" className="text-[10px] font-medium">Draft</Badge>
    if (status === 'scheduled') {
        return <Badge variant="outline" className="text-[10px] font-medium text-blue-600 dark:text-blue-400 border-blue-300 dark:border-blue-800">
            Scheduled{a.scheduled_at ? ` · ${formatDate(a.scheduled_at)}` : ''}
        </Badge>
    }
    if (a.is_active) {
        // "Showing" = the row that actually pops on its surface; a shadowed active row
        // (a newer one wins the same surface) is flagged so the admin isn't misled.
        return showing
            ? <Badge className="text-[10px] font-medium bg-green-600 hover:bg-green-600">Showing</Badge>
            : <Badge variant="outline" className="text-[10px] font-medium text-amber-600 dark:text-amber-400 border-amber-300 dark:border-amber-800">Active · hidden</Badge>
    }
    return <Badge variant="secondary" className="text-[10px] font-medium">Off</Badge>
}

export function HistoryTab({ announcements, loading, onEdit, onDuplicate, onRefresh }: {
    announcements: SystemAnnouncement[]
    loading: boolean
    onEdit: (a: SystemAnnouncement) => void
    onDuplicate: (a: SystemAnnouncement) => void
    onRefresh: () => void
}) {
    const [filter, setFilter] = useState<Filter>('all')
    const [busyId, setBusyId] = useState<string | null>(null)
    // In-app confirm target. Native window.confirm() is unreliable inside an
    // installed iOS PWA (returns false without showing), which silently swallowed
    // every delete — so we drive an in-app dialog instead.
    const [confirmDelete, setConfirmDelete] = useState<SystemAnnouncement | null>(null)

    const filtered = useMemo(
        () => announcements.filter(a => matchesFilter(a, filter)),
        [announcements, filter]
    )

    // Which rows actually pop (newest active per surface) vs. shadowed active rows.
    const showingIds = useMemo(() => computeShowingIds(announcements as any), [announcements])
    const activeCount = useMemo(() => announcements.filter(a => a.is_active).length, [announcements])
    const hiddenActive = useMemo(
        () => announcements.filter(a => a.is_active && !showingIds.has(a.id)),
        [announcements, showingIds]
    )

    async function toggle(a: SystemAnnouncement) {
        setBusyId(a.id)
        try {
            const res = await fetch(`/api/admin/announcements/${a.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'toggle' }),
            })
            const json = await res.json()
            if (!res.ok || !json.success) throw new Error(json.error || 'Toggle failed')
            onRefresh()
        } catch (e: any) {
            toast.error(e.message || 'Could not update status')
        } finally {
            setBusyId(null)
        }
    }

    async function doDelete(a: SystemAnnouncement) {
        setConfirmDelete(null)
        setBusyId(a.id)
        try {
            const res = await fetch(`/api/admin/announcements/${a.id}`, { method: 'DELETE' })
            const json = await res.json()
            if (!res.ok || !json.success) throw new Error(json.error || 'Delete failed')
            toast.success('Announcement deleted')
            onRefresh()
        } catch (e: any) {
            toast.error(e.message || 'Could not delete')
        } finally {
            setBusyId(null)
        }
    }

    return (
        <div className="space-y-4">
            {/* Filter chips */}
            <div className="flex flex-wrap gap-1.5">
                {FILTERS.map(f => (
                    <Button
                        key={f.value}
                        type="button"
                        variant={filter === f.value ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => setFilter(f.value)}
                        className="h-7 px-3 text-[11px] font-medium"
                    >
                        {f.label}
                    </Button>
                ))}
            </div>

            {(activeCount > 0 || hiddenActive.length > 0) && (
                <div className="space-y-1.5">
                    <p className="text-[11px] text-muted-foreground">
                        {activeCount} active {activeCount === 1 ? 'announcement' : 'announcements'}
                    </p>
                    {hiddenActive.length > 0 && (
                        <div className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-[12px] text-amber-700 dark:text-amber-300">
                            {hiddenActive.length} active {hiddenActive.length === 1 ? 'announcement is' : 'announcements are'} hidden — a newer one is showing on the same surface. Only the “Showing” one reaches users; turn it off to reveal the next, or deactivate these.
                        </div>
                    )}
                </div>
            )}

            {loading ? (
                <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
            ) : filtered.length === 0 ? (
                <div className="text-center py-12 text-sm text-muted-foreground">No announcements here yet</div>
            ) : (
                <div className="space-y-2.5">
                    {filtered.map(a => {
                        const ctas = resolveCtas(a)
                        const hasCta = !!(ctas.primary || ctas.secondary)
                        const busy = busyId === a.id
                        return (
                            <div key={a.id} className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-800/40 p-3">
                                <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-2">
                                            <h4 className="truncate text-sm font-medium text-gray-800 dark:text-gray-100">{a.title}</h4>
                                            {hasCta && <Link2 className="w-3.5 h-3.5 shrink-0 text-primary" aria-label="Has action button" />}
                                        </div>
                                        <p className="mt-0.5 line-clamp-2 text-[12px] text-muted-foreground">{a.message}</p>
                                        <p className="mt-1 text-[11px] tabular-nums text-muted-foreground">{formatDate(a.created_at)}</p>
                                    </div>
                                    <div className="flex shrink-0 flex-col items-end gap-1.5">
                                        <StatusBadge a={a} showing={showingIds.has(a.id)} />
                                        <Badge variant="outline" className="text-[9px] font-medium capitalize">
                                            {(a.visible_on ?? 'main_site').replace('_', ' ')}
                                        </Badge>
                                    </div>
                                </div>

                                <div className="mt-2.5 flex items-center justify-between border-t border-gray-200 dark:border-gray-700 pt-2">
                                    <div className="flex items-center gap-2">
                                        <Switch
                                            checked={a.is_active ?? false}
                                            disabled={busy}
                                            onCheckedChange={() => toggle(a)}
                                            className="scale-90"
                                        />
                                        <span className="text-[11px] text-muted-foreground">{a.is_active ? 'On' : 'Off'}</span>
                                    </div>
                                    <div className="flex items-center gap-1">
                                        <Button variant="ghost" size="sm" onClick={() => onEdit(a)} className="h-8 px-2 text-[11px] font-medium gap-1 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20">
                                            <Pencil className="w-3.5 h-3.5" /> Edit
                                        </Button>
                                        <Button variant="ghost" size="sm" onClick={() => onDuplicate(a)} className="h-8 px-2 text-[11px] font-medium gap-1 text-muted-foreground hover:text-foreground">
                                            <Copy className="w-3.5 h-3.5" /> Duplicate
                                        </Button>
                                        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmDelete(a)} className="h-8 px-2 text-[11px] font-medium gap-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20">
                                            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />} Delete
                                        </Button>
                                    </div>
                                </div>
                            </div>
                        )
                    })}
                </div>
            )}

            {/* In-app delete confirmation (replaces native confirm(), which is unreliable in iOS PWAs). */}
            {confirmDelete && (
                <div className="fixed inset-0 z-[130] flex items-center justify-center p-4">
                    <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setConfirmDelete(null)} />
                    <div className="relative w-full max-w-sm rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-5 shadow-xl">
                        <h3 className="text-base font-semibold text-gray-900 dark:text-white">Delete announcement?</h3>
                        <p className="mt-1 text-[13px] text-muted-foreground">
                            “{confirmDelete.title}” will be permanently removed. This can’t be undone.
                        </p>
                        <div className="mt-4 flex items-center justify-end gap-2">
                            <Button variant="outline" size="sm" onClick={() => setConfirmDelete(null)} className="text-xs font-medium">
                                Cancel
                            </Button>
                            <Button size="sm" onClick={() => doDelete(confirmDelete)} className="text-xs font-medium bg-red-600 hover:bg-red-700 text-white">
                                Delete
                            </Button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}
