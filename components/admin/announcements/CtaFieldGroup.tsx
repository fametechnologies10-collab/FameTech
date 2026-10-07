'use client'

import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { MessageCircle, Send, Globe, Phone } from 'lucide-react'
import { sanitizeCtaUrl, getCtaMeta } from '@/lib/announcement-cta'
import { cn } from '@/lib/utils'

type Preset = {
    key: string
    label: string
    starterLabel: string
    starterUrl: string
    icon: typeof MessageCircle
}

const PRESETS: Preset[] = [
    { key: 'whatsapp', label: 'WhatsApp', starterLabel: 'Join WhatsApp Group', starterUrl: 'https://chat.whatsapp.com/', icon: MessageCircle },
    { key: 'telegram', label: 'Telegram', starterLabel: 'Join Telegram', starterUrl: 'https://t.me/', icon: Send },
    { key: 'website', label: 'Website', starterLabel: 'Visit Website', starterUrl: 'https://', icon: Globe },
    { key: 'call', label: 'Call', starterLabel: 'Call Us', starterUrl: 'tel:+233', icon: Phone },
]

const LABEL_MAX = 40

/**
 * One optional CTA button editor: quick presets + label/link inputs, with a live
 * safety/destination hint driven by the same sanitizeCtaUrl used at render time.
 */
export function CtaFieldGroup({ index, label, url, onLabel, onUrl, savedButtons = [] }: {
    index: 1 | 2
    label: string
    url: string
    onLabel: (v: string) => void
    onUrl: (v: string) => void
    savedButtons?: { label: string; url: string }[]
}) {
    const trimmedUrl = url.trim()
    const safe = sanitizeCtaUrl(trimmedUrl)
    const showError = trimmedUrl.length > 0 && !safe
    const meta = safe ? getCtaMeta(safe) : null

    function applyPreset(p: Preset) {
        if (!label.trim()) onLabel(p.starterLabel)
        onUrl(p.starterUrl)
    }

    return (
        <div className="space-y-2 rounded-xl border border-gray-200 dark:border-gray-700 p-3">
            <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium text-muted-foreground">
                    Button {index}{index === 2 ? ' (optional)' : ''}
                </span>
                <div className="flex flex-wrap justify-end gap-1">
                    {PRESETS.map(p => {
                        const Icon = p.icon
                        return (
                            <Button
                                key={p.key}
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => applyPreset(p)}
                                className="h-7 px-2 text-[11px] font-medium gap-1"
                            >
                                <Icon className="w-3 h-3" />
                                {p.label}
                            </Button>
                        )
                    })}
                </div>
            </div>

            {savedButtons.length > 0 && (
                <div className="space-y-1">
                    <label className="text-[11px] font-medium text-muted-foreground">Reuse a previous button</label>
                    <select
                        value=""
                        onChange={e => {
                            const b = savedButtons[Number(e.target.value)]
                            if (b) { onLabel(b.label); onUrl(b.url) }
                        }}
                        className="w-full h-9 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 text-sm text-foreground"
                    >
                        <option value="" disabled>Pick a saved button…</option>
                        {savedButtons.map((b, i) => (
                            <option key={`${b.label}-${i}`} value={i}>
                                {b.label} — {getCtaMeta(b.url).domain}
                            </option>
                        ))}
                    </select>
                </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="space-y-1">
                    <label className="text-[11px] font-medium text-muted-foreground">Label</label>
                    <Input
                        value={label}
                        onChange={e => onLabel(e.target.value.slice(0, LABEL_MAX))}
                        placeholder="e.g. Join WhatsApp Group"
                        className="text-sm"
                    />
                </div>
                <div className="space-y-1">
                    <label className="text-[11px] font-medium text-muted-foreground">Link</label>
                    <Input
                        value={url}
                        onChange={e => onUrl(e.target.value)}
                        placeholder="https://..."
                        className={cn('text-sm', showError && 'border-red-400 focus-visible:ring-red-400')}
                    />
                </div>
            </div>

            {meta && (
                <p className="text-[11px] font-medium text-green-600 dark:text-green-400">
                    Opens: {meta.domain}
                </p>
            )}
            {showError && (
                <p className="text-[11px] text-red-500">Enter a valid https, tel, or mailto link.</p>
            )}
        </div>
    )
}
