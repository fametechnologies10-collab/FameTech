'use client'

import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { cn } from '@/lib/utils'
import { Bell, Settings } from 'lucide-react'
import NotificationsInbox from '@/components/dashboard/notifications/NotificationsInbox'

const NotificationSettings = dynamic(() => import('@/components/dashboard/notifications/NotificationSettings'), { ssr: false })

type Tab = 'inbox' | 'settings'

export default function NotificationsPage() {
    const [tab, setTab] = useState<Tab>('inbox')
    const [highlightId, setHighlightId] = useState<string | null>(null)

    useEffect(() => {
        const params = new URLSearchParams(window.location.search)
        if (params.get('tab') === 'settings') setTab('settings')
        setHighlightId(params.get('highlight'))
    }, [])

    return (
        <div className="max-w-3xl mx-auto space-y-5">
            <div>
                <h1 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white">Notifications</h1>
                <p className="text-sm text-gray-500 dark:text-gray-400">Your alerts and notification preferences</p>
            </div>

            <div className="flex items-center gap-1 p-1 rounded-xl bg-gray-100 dark:bg-gray-800 w-fit">
                {([['inbox', 'Inbox', Bell], ['settings', 'Settings', Settings]] as const).map(([key, label, Icon]) => (
                    <button key={key} type="button" onClick={() => setTab(key)}
                        className={cn('flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium transition-colors',
                            tab === key ? 'bg-white dark:bg-gray-900 text-gray-900 dark:text-white shadow-sm' : 'text-gray-500 dark:text-gray-400')}>
                        <Icon className="w-4 h-4" /> {label}
                    </button>
                ))}
            </div>

            {tab === 'inbox' ? <NotificationsInbox highlightId={highlightId} /> : <NotificationSettings />}
        </div>
    )
}
