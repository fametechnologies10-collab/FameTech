import { getAdminSettings } from '@/lib/admin-settings-cache'
import { FloatingWhatsApp } from '@/components/floating-whatsapp'
import { CopyrightFooter } from '@/components/CopyrightFooter'
import React from 'react'

export const dynamic = 'force-dynamic'

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
    // EGRESS: this layout runs on EVERY auth page view. It was previously an
    // uncached admin_settings round-trip per view — see lib/admin-settings-cache.ts.
    // 5-minute TTL (product decision, 2026-09-24) — every key here is pure
    // display copy an admin changes rarely.
    const adminSettings = await getAdminSettings([
        'whatsapp_admin_number',
        'whatsapp_community_link',
        'whatsapp_channel_link',
        'footer_copyright_text',
        'footer_branding_text',
        'guest_storefront_url',
    ], 5 * 60 * 1000)

    const whatsappAdminNumber = adminSettings.whatsapp_admin_number || ''
    const whatsappCommunityLink = adminSettings.whatsapp_community_link || 'https://chat.whatsapp.com/FC6jYV3VDEQ4MmdTXiFqDV?mode=gi_t'
    const whatsappChannelLink = adminSettings.whatsapp_channel_link || 'https://whatsapp.com/channel/0029Vb7HTfx47XeIZz7ht232'
    const guestUrl = adminSettings.guest_storefront_url || 'https://kingflexygh.com/shop/felix-s-shop'

    return (
        <div className="relative min-h-screen w-full flex flex-col items-center justify-center overflow-y-auto">
            <div className="w-full flex-1 flex flex-col">
                <FloatingWhatsApp phoneNumber={whatsappAdminNumber} variant="auth" />
                {React.Children.map(children, child => {
                    if (React.isValidElement(child)) {
                        return React.cloneElement(child, { guestUrl, whatsappCommunityLink, whatsappChannelLink } as any)
                    }
                    return child
                })}
            </div>
            <CopyrightFooter adminSettings={adminSettings} className="bg-transparent relative z-20 w-full" />
        </div>
    )
}
