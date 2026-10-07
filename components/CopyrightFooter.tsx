'use client'

import Link from 'next/link'
import { cn } from '@/lib/utils'

interface CopyrightFooterProps {
    variant?: 'platform' | 'shop'
    shopName?: string
    adminSettings?: Record<string, any>
    className?: string
}

export function CopyrightFooter({
    variant = 'platform',
    shopName,
    adminSettings = {},
    className
}: CopyrightFooterProps) {
    const currentYear = new Date().getFullYear()
    
    // Fallbacks for settings
    const footerText = adminSettings?.footer_copyright_text || `2026 KiNG FLEXY TECHNOLOGIES LTD`
    const brandingText = adminSettings?.footer_branding_text || 'KiNG FLEXY TECHNOLOGIES'

    return (
        <footer className={cn(
            "w-full py-8 mt-auto flex flex-col items-center justify-center gap-2 px-4",
            "border-t border-gray-200/50 dark:border-gray-800/50",
            className
        )}>
            <div className="flex flex-col items-center text-center gap-1">
                <p className="text-sm font-medium text-muted-foreground tracking-tight">
                    {variant === 'platform' ? (
                        <>© {footerText}. All rights reserved.</>
                    ) : (
                        <>© {currentYear} {shopName}. All rights reserved.</>
                    )}
                </p>
                {variant === 'shop' ? (
                    <p className="text-[10px] font-bold text-muted-foreground/60 uppercase tracking-[0.2em]">
                        Powered by {brandingText}
                    </p>
                ) : (
                    <div className="flex items-center gap-3 mt-1 text-xs font-semibold text-slate-500">
                        <Link href="/terms" className="hover:text-slate-800 transition-colors">Terms of Service</Link>
                        <span>•</span>
                        <Link href="/privacy" className="hover:text-slate-800 transition-colors">Privacy Policy</Link>
                    </div>
                )}
            </div>
            
            {/* Subtle premium glass effect indicator or decorative element */}
            <div className="w-12 h-[2px] bg-gradient-to-r from-transparent via-muted-foreground/20 to-transparent rounded-full mt-2" />
        </footer>
    )
}
