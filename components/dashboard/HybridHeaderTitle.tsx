'use client'

import { usePathname } from 'next/navigation'
import { FileText } from 'lucide-react'
import { userNavItems, adminNavItems, shopNavItems } from '@/components/dashboard/sidebar'

const ALL_NAV_ITEMS = [
    ...userNavItems,
    ...adminNavItems,
    ...shopNavItems,
]

function resolvePageTitle(pathname: string | null): string {
    if (!pathname) return 'Dashboard'
    const match = ALL_NAV_ITEMS
        .filter(item => {
            if (item.href === '/dashboard' || item.href === '/admin') {
                return pathname === item.href
            }
            return pathname.startsWith(item.href)
        })
        .sort((a, b) => b.href.length - a.href.length)[0]
    return match?.label ?? 'Dashboard'
}

// `role` is kept so callers don't change; the title colour no longer varies by role
export function HybridHeaderTitle({ role }: { role?: string }) {
    const pathname = usePathname()

    return (
        <div className="flex items-center gap-2 flex-1 min-w-0">
            <div className="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-full bg-primary/10">
                <FileText className="w-3.5 h-3.5 text-primary" />
            </div>
            <h1 className="font-display text-base font-bold tracking-tight truncate text-foreground">
                {resolvePageTitle(pathname)}
            </h1>
        </div>
    )
}
