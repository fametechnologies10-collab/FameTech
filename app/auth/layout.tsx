import { getAdminSettings } from '@/lib/admin-settings-cache'
import { FloatingWhatsApp } from '@/components/floating-whatsapp'
import { CopyrightFooter } from '@/components/CopyrightFooter'
import { ftFonts } from '@/lib/ft-fonts'
import React from 'react'

export const dynamic = 'force-dynamic'

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
    // EGRESS: this layout runs on EVERY auth page view. It was previously an
    // uncached admin_settings round-trip per view — see lib/admin-settings-cache.ts.
    // 5-minute TTL (product decision, 2026-09-24) — every key here is pure
    // display copy an admin changes rarely.
    const adminSettings = await getAdminSettings([
        'whatsapp_admin_number',
        'footer_copyright_text',
        'footer_branding_text',
    ], 5 * 60 * 1000)

    const whatsappAdminNumber = adminSettings.whatsapp_admin_number || ''

    return (
        <div className={`ft ${ftFonts.className} ${ftFonts.variable} relative min-h-screen w-full flex flex-col items-center justify-center overflow-y-auto`}>
            <div className="w-full flex-1 flex flex-col">
                <FloatingWhatsApp phoneNumber={whatsappAdminNumber} variant="auth" />
                {children}
            </div>
            <CopyrightFooter adminSettings={adminSettings} className="bg-transparent relative z-20 w-full" />
        </div>
    )
}
