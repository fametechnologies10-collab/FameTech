'use client'

import { useEffect, useState } from 'react'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Bell, BellOff, Loader2 } from 'lucide-react'
import { toast } from '@/lib/toast'
import { usePushNotifications } from '@/hooks/usePushNotifications'
import {
    CATEGORY_ORDER, CATEGORY_LABEL, CATEGORY_DESCRIPTION, type NotificationCategory,
} from '@/lib/notification-categories'

export default function NotificationSettings() {
    const { permission, isSupported, isSubscribing, isUnsubscribing, requestPermission, unsubscribe } = usePushNotifications()
    const [muted, setMuted] = useState<Record<NotificationCategory, boolean>>({
        orders: false, payments: false, support: false, announcements: false, system: false,
    })
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState<NotificationCategory | null>(null)

    useEffect(() => {
        ;(async () => {
            try {
                const res = await fetch('/api/user/notification-prefs')
                const data = await res.json()
                const m = data?.notification_prefs?.muted ?? {}
                setMuted({
                    orders: !!m.orders, payments: !!m.payments, support: !!m.support,
                    announcements: !!m.announcements, system: !!m.system,
                })
            } catch { /* keep defaults */ } finally { setLoading(false) }
        })()
    }, [])

    const persist = async (next: Record<NotificationCategory, boolean>) => {
        const mutedCategories = CATEGORY_ORDER.filter(c => next[c])
        const res = await fetch('/api/user/notification-prefs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mutedCategories }),
        })
        if (!res.ok) throw new Error('save failed')
    }

    const toggleCategory = async (cat: NotificationCategory, value: boolean) => {
        const prev = muted
        const next = { ...muted, [cat]: value }
        setMuted(next); setSaving(cat)
        try { await persist(next) }
        catch { setMuted(prev); toast.error('Failed to save preference') }
        finally { setSaving(null) }
    }

    return (
        <div className="space-y-6 max-w-2xl">
            {/* Master push */}
            <section className="rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 sm:p-5">
                <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center flex-shrink-0">
                        <Bell className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Push notifications</h3>
                        {!isSupported ? (
                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Your browser doesn&apos;t support push notifications.</p>
                        ) : permission === 'denied' ? (
                            <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">Blocked in your browser settings. Re-allow notifications for this site to enable.</p>
                        ) : permission === 'granted' ? (
                            <>
                                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">You&apos;re receiving real-time alerts on this device.</p>
                                <Button size="sm" variant="outline" className="mt-3 gap-1.5" disabled={isUnsubscribing} onClick={async () => { await unsubscribe(); toast.success('Push disabled on this device') }}>
                                    {isUnsubscribing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <BellOff className="w-3.5 h-3.5" />} Disable on this device
                                </Button>
                            </>
                        ) : (
                            <>
                                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Get instant alerts for orders, payments, and announcements.</p>
                                <Button size="sm" className="mt-3 gap-1.5" disabled={isSubscribing} onClick={async () => { await requestPermission() }}>
                                    {isSubscribing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Bell className="w-3.5 h-3.5" />} Enable push
                                </Button>
                            </>
                        )}
                    </div>
                </div>
            </section>

            {/* Per-category mutes */}
            <section className="rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 sm:p-5">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Notification categories</h3>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Muting a category stops device push alerts. You&apos;ll still see them in your inbox.</p>
                <div className="mt-4 divide-y divide-gray-100 dark:divide-gray-800">
                    {loading ? (
                        <div className="py-6 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-gray-400" /></div>
                    ) : CATEGORY_ORDER.map(cat => (
                        <div key={cat} className="flex items-center justify-between py-3">
                            <div className="min-w-0 pr-4">
                                <p className="text-sm font-medium text-gray-800 dark:text-gray-200">{CATEGORY_LABEL[cat]}</p>
                                <p className="text-[11px] text-gray-500 dark:text-gray-400">{CATEGORY_DESCRIPTION[cat]}</p>
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0">
                                {saving === cat && <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-400" />}
                                {/* Switch ON = receiving (not muted) */}
                                <Switch checked={!muted[cat]} onCheckedChange={(on) => toggleCategory(cat, !on)} />
                            </div>
                        </div>
                    ))}
                </div>
            </section>
        </div>
    )
}
