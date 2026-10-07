'use client'

import { useEffect, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Loader2, Megaphone, Maximize2, Minimize2, Plus, X, Bell, Clock, FileText } from 'lucide-react'
import { toast } from '@/lib/toast'
import { CtaFieldGroup } from './CtaFieldGroup'
import { AnnouncementPreview } from './AnnouncementPreview'

const TITLE_MAX = 80
const MESSAGE_MAX = 1000

export type EditingAnnouncement = {
    id?: string
    title?: string
    message?: string
    visible_on?: string | null
    status?: string | null
    scheduled_at?: string | null
    cta_primary_label?: string | null
    cta_primary_url?: string | null
    cta_secondary_label?: string | null
    cta_secondary_url?: string | null
} | null

type VisibleOn = 'main_site' | 'storefronts' | 'both'
type Mode = 'draft' | 'publish' | 'schedule'

const VISIBLE_OPTIONS: { value: VisibleOn; label: string }[] = [
    { value: 'main_site', label: 'Main Site' },
    { value: 'storefronts', label: 'Storefronts' },
    { value: 'both', label: 'Both' },
]

/** ISO timestamp → value for <input type="datetime-local"> in the user's local wall-clock. */
function toLocalDatetimeInput(iso: string): string {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return ''
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    return local.toISOString().slice(0, 16)
}

export function ComposeTab({ editing, onSaved, onCancelEdit, savedButtons = [] }: {
    editing: EditingAnnouncement
    onSaved: () => void
    onCancelEdit: () => void
    savedButtons?: { label: string; url: string }[]
}) {
    const isEditing = !!editing?.id

    const [title, setTitle] = useState('')
    const [message, setMessage] = useState('')
    const [visibleOn, setVisibleOn] = useState<VisibleOn>('main_site')
    const [cta1Label, setCta1Label] = useState('')
    const [cta1Url, setCta1Url] = useState('')
    const [cta2Label, setCta2Label] = useState('')
    const [cta2Url, setCta2Url] = useState('')
    const [showSecond, setShowSecond] = useState(false)
    const [sendPush, setSendPush] = useState(true)
    const [showSchedule, setShowSchedule] = useState(false)
    const [scheduledAt, setScheduledAt] = useState('')
    const [previewSurface, setPreviewSurface] = useState<'dashboard' | 'storefront'>('dashboard')
    const [fullscreen, setFullscreen] = useState(false)
    const [submitting, setSubmitting] = useState<Mode | null>(null)

    const textareaRef = useRef<HTMLTextAreaElement>(null)

    // Hydrate form from the row being edited / duplicated.
    useEffect(() => {
        setTitle(editing?.title ?? '')
        setMessage(editing?.message ?? '')
        setVisibleOn((editing?.visible_on as VisibleOn) ?? 'main_site')
        setCta1Label(editing?.cta_primary_label ?? '')
        setCta1Url(editing?.cta_primary_url ?? '')
        setCta2Label(editing?.cta_secondary_label ?? '')
        setCta2Url(editing?.cta_secondary_url ?? '')
        setShowSecond(!!(editing?.cta_secondary_label || editing?.cta_secondary_url))
        // Preserve an existing schedule when editing a scheduled row, so a quick text edit
        // doesn't silently drop the publish time.
        const isScheduled = editing?.status === 'scheduled' && !!editing?.scheduled_at
        setShowSchedule(isScheduled)
        setScheduledAt(isScheduled ? toLocalDatetimeInput(editing!.scheduled_at!) : '')
    }, [editing])

    // Auto-grow the message textarea to fit content.
    useEffect(() => {
        const el = textareaRef.current
        if (!el || fullscreen) return
        el.style.height = 'auto'
        el.style.height = `${Math.min(el.scrollHeight, 320)}px`
    }, [message, fullscreen])

    const draft = {
        title, message,
        cta_primary_label: cta1Label, cta_primary_url: cta1Url,
        cta_secondary_label: showSecond ? cta2Label : null,
        cta_secondary_url: showSecond ? cta2Url : null,
    }

    function resetForm() {
        setTitle(''); setMessage(''); setVisibleOn('main_site')
        setCta1Label(''); setCta1Url(''); setCta2Label(''); setCta2Url('')
        setShowSecond(false); setSendPush(true); setShowSchedule(false); setScheduledAt('')
    }

    async function submit(mode: Mode) {
        if (!title.trim() || !message.trim()) {
            toast.error('Title and message are required')
            return
        }
        if (mode === 'schedule' && !scheduledAt) {
            toast.error('Pick a date & time to schedule')
            return
        }

        const payload = {
            title: title.trim(),
            message: message.trim(),
            visibleOn,
            mode,
            scheduledAt: mode === 'schedule' ? new Date(scheduledAt).toISOString() : undefined,
            ctaPrimaryLabel: cta1Label.trim() || undefined,
            ctaPrimaryUrl: cta1Url.trim() || undefined,
            ctaSecondaryLabel: showSecond ? (cta2Label.trim() || undefined) : undefined,
            ctaSecondaryUrl: showSecond ? (cta2Url.trim() || undefined) : undefined,
            sendPush,
        }

        setSubmitting(mode)
        try {
            const url = isEditing
                ? `/api/admin/announcements/${editing!.id}`
                : '/api/admin/announcements'
            const res = await fetch(url, {
                method: isEditing ? 'PATCH' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(isEditing ? { action: 'update', ...payload } : payload),
            })
            const json = await res.json()
            if (!res.ok || !json.success) {
                throw new Error(json.error || 'Failed to save announcement')
            }
            toast.success(
                mode === 'publish' ? (isEditing ? 'Updated & published' : 'Announcement published')
                    : mode === 'schedule' ? 'Announcement scheduled'
                        : 'Draft saved'
            )
            resetForm()
            onSaved()
        } catch (e: any) {
            toast.error(e.message || 'Something went wrong')
        } finally {
            setSubmitting(null)
        }
    }

    const messageEditor = (
        <textarea
            ref={fullscreen ? undefined : textareaRef}
            value={message}
            onChange={e => setMessage(e.target.value.slice(0, MESSAGE_MAX))}
            placeholder="Write your announcement… line breaks are preserved."
            className={fullscreen
                ? 'w-full h-full resize-none bg-transparent text-base leading-relaxed outline-none'
                : 'w-full min-h-[120px] max-h-[320px] resize-none rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent px-3 py-2 text-sm leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-primary/40'}
        />
    )

    return (
        <div className="grid gap-5 lg:grid-cols-2">
            {/* ── Form column ── */}
            <div className="space-y-4">
                {isEditing && (
                    <div className="flex items-center justify-between rounded-lg bg-blue-50 dark:bg-blue-950/40 px-3 py-2">
                        <span className="text-[12px] font-medium text-blue-700 dark:text-blue-300">Editing existing announcement</span>
                        <button onClick={() => { resetForm(); onCancelEdit() }} className="text-[12px] font-medium text-blue-600 hover:underline">
                            New instead
                        </button>
                    </div>
                )}

                {/* Title */}
                <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                        <Label className="text-[11px] font-medium text-muted-foreground">Title</Label>
                        <span className="text-[11px] tabular-nums text-muted-foreground">{title.length}/{TITLE_MAX}</span>
                    </div>
                    <Input
                        value={title}
                        onChange={e => setTitle(e.target.value.slice(0, TITLE_MAX))}
                        placeholder="e.g. Join our community"
                        className="text-sm"
                    />
                </div>

                {/* Message */}
                <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                        <Label className="text-[11px] font-medium text-muted-foreground">Message</Label>
                        <div className="flex items-center gap-2">
                            <span className="text-[11px] tabular-nums text-muted-foreground">{message.length}/{MESSAGE_MAX}</span>
                            <button
                                type="button"
                                onClick={() => setFullscreen(true)}
                                className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                            >
                                <Maximize2 className="w-3 h-3" /> Expand
                            </button>
                        </div>
                    </div>
                    {messageEditor}
                </div>

                {/* Visible on */}
                <div className="space-y-1.5">
                    <Label className="text-[11px] font-medium text-muted-foreground">Show on</Label>
                    <div className="grid grid-cols-3 gap-2">
                        {VISIBLE_OPTIONS.map(o => (
                            <Button
                                key={o.value}
                                type="button"
                                variant={visibleOn === o.value ? 'default' : 'outline'}
                                size="sm"
                                onClick={() => setVisibleOn(o.value)}
                                className="h-8 text-xs font-medium"
                            >
                                {o.label}
                            </Button>
                        ))}
                    </div>
                </div>

                {/* CTA buttons */}
                <CtaFieldGroup index={1} label={cta1Label} url={cta1Url} onLabel={setCta1Label} onUrl={setCta1Url} savedButtons={savedButtons} />
                {showSecond ? (
                    <div className="relative">
                        <CtaFieldGroup index={2} label={cta2Label} url={cta2Url} onLabel={setCta2Label} onUrl={setCta2Url} savedButtons={savedButtons} />
                        <button
                            type="button"
                            onClick={() => { setShowSecond(false); setCta2Label(''); setCta2Url('') }}
                            className="absolute -top-2 -right-2 inline-flex items-center justify-center w-6 h-6 rounded-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-muted-foreground hover:text-foreground"
                            aria-label="Remove second button"
                        >
                            <X className="w-3 h-3" />
                        </button>
                    </div>
                ) : (
                    <Button type="button" variant="outline" size="sm" onClick={() => setShowSecond(true)} className="w-full h-8 text-xs font-medium gap-1">
                        <Plus className="w-3.5 h-3.5" /> Add second button
                    </Button>
                )}

                {/* Send push */}
                <div className="flex items-center justify-between rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2.5">
                    <div className="flex items-center gap-2">
                        <Bell className="w-4 h-4 text-primary" />
                        <div>
                            <Label htmlFor="send-push" className="text-sm font-medium">Send push notification</Label>
                            <p className="text-[11px] text-muted-foreground">Off = quiet (shows in-app only)</p>
                        </div>
                    </div>
                    <Switch id="send-push" checked={sendPush} onCheckedChange={setSendPush} />
                </div>

                {/* Schedule */}
                {showSchedule && (
                    <div className="space-y-1.5 rounded-lg border border-gray-200 dark:border-gray-700 p-3">
                        <Label className="text-[11px] font-medium text-muted-foreground">Publish at</Label>
                        <Input type="datetime-local" value={scheduledAt} onChange={e => setScheduledAt(e.target.value)} className="text-sm" />
                    </div>
                )}

                {/* Actions */}
                <div className="grid grid-cols-3 gap-2 pt-1">
                    <Button type="button" variant="outline" onClick={() => submit('draft')} disabled={!!submitting} className="h-9 text-xs font-medium gap-1">
                        {submitting === 'draft' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileText className="w-3.5 h-3.5" />}
                        Save draft
                    </Button>
                    <Button
                        type="button"
                        variant={showSchedule ? 'default' : 'outline'}
                        onClick={() => showSchedule ? submit('schedule') : setShowSchedule(true)}
                        disabled={!!submitting}
                        className="h-9 text-xs font-medium gap-1"
                    >
                        {submitting === 'schedule' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Clock className="w-3.5 h-3.5" />}
                        {showSchedule ? 'Schedule' : 'Schedule…'}
                    </Button>
                    <Button type="button" onClick={() => submit('publish')} disabled={!!submitting} className="h-9 text-xs font-medium gap-1">
                        {submitting === 'publish' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Megaphone className="w-3.5 h-3.5" />}
                        Publish
                    </Button>
                </div>
            </div>

            {/* ── Preview column ── */}
            <div className="space-y-3 lg:sticky lg:top-4 self-start">
                <div className="flex items-center justify-between">
                    <span className="text-[11px] font-medium text-muted-foreground">Live preview</span>
                    <div className="flex gap-1">
                        {(['dashboard', 'storefront'] as const).map(s => (
                            <Button
                                key={s}
                                type="button"
                                variant={previewSurface === s ? 'default' : 'outline'}
                                size="sm"
                                onClick={() => setPreviewSurface(s)}
                                className="h-7 px-2.5 text-[11px] font-medium capitalize"
                            >
                                {s}
                            </Button>
                        ))}
                    </div>
                </div>
                <AnnouncementPreview draft={draft} surface={previewSurface} />
            </div>

            {/* ── Fullscreen message editor ── */}
            {fullscreen && (
                <div className="fixed inset-0 z-[120] flex flex-col bg-white dark:bg-gray-950">
                    <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-800 px-4 py-3">
                        <span className="text-sm font-semibold">Edit message</span>
                        <div className="flex items-center gap-3">
                            <span className="text-[11px] tabular-nums text-muted-foreground">{message.length}/{MESSAGE_MAX}</span>
                            <button onClick={() => setFullscreen(false)} className="inline-flex items-center gap-1 text-[12px] font-medium text-muted-foreground hover:text-foreground">
                                <Minimize2 className="w-3.5 h-3.5" /> Done
                            </button>
                        </div>
                    </div>
                    <div className="flex-1 overflow-y-auto px-4 py-4">{messageEditor}</div>
                </div>
            )}
        </div>
    )
}
