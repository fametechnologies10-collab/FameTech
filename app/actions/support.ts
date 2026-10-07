'use server'

import { getAdminSettings } from '@/lib/admin-settings-cache'

export interface SupportContacts {
    whatsapp: string
    email: string
    phone: string
    groupLink: string
    channelLink: string
    communityLink: string
}

const CONTACT_KEYS = [
    'whatsapp_admin_number',
    'support_email',
    'support_phone',
    'whatsapp_group_link',
    'whatsapp_channel_link',
    'whatsapp_community_link',
] as const

const EMPTY: SupportContacts = {
    whatsapp: '', email: '', phone: '',
    groupLink: '', channelLink: '', communityLink: '',
}

// Display-only contact details: 5-minute shared cache, the TTL already accepted
// for the footer/terms content in the root layouts (lib/admin-settings-cache.ts).
const CONTACTS_TTL_MS = 5 * 60_000

export async function getSupportContacts(): Promise<SupportContacts> {
    try {
        const rows = await getAdminSettings(CONTACT_KEYS, CONTACTS_TTL_MS)

        const map: Record<string, string> = {}
        for (const [key, raw] of Object.entries(rows) as [string, unknown][]) {
            // admin_settings.value is JSONB — strings may arrive quoted.
            map[key] = typeof raw === 'string' ? raw.replace(/^"|"$/g, '') : String(raw ?? '')
        }

        return {
            whatsapp: map['whatsapp_admin_number'] || '',
            email: map['support_email'] || '',
            phone: map['support_phone'] || '',
            groupLink: map['whatsapp_group_link'] || '',
            channelLink: map['whatsapp_channel_link'] || '',
            communityLink: map['whatsapp_community_link'] || '',
        }
    } catch (error) {
        console.error('Error fetching support contacts:', error)
        return { ...EMPTY }
    }
}
