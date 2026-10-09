import { Crown, Star, BadgeCheck, UserCircle, Gem, UserCheck, LucideIcon } from 'lucide-react'

export type UserRole = 'admin' | 'sub-admin' | 'dealer' | 'agent' | 'subagent' | 'customer'

interface RoleConfigItem {
    icon: LucideIcon
    label: string
    rank: string
    color: string
    bgColor: string
    textColor: string
}

export const roleConfig: Record<UserRole, RoleConfigItem> = {
    'admin': {
        icon: Crown,
        label: 'Admin',
        rank: '#1',
        color: '#E60000',
        bgColor: 'rgba(230, 0, 0, 0.1)',
        textColor: '#E60000'
    },
    'sub-admin': {
        icon: Star,
        label: 'Sub-Admin',
        rank: '#2',
        color: '#FACC15',
        bgColor: 'rgba(250, 204, 21, 0.15)',
        textColor: '#B59410'
    },
    'dealer': {
        icon: Gem,
        label: 'Dealer',
        rank: '#3',
        color: '#7C3AED',
        bgColor: 'rgba(124, 58, 237, 0.1)',
        textColor: '#7C3AED'
    },
    'agent': {
        icon: BadgeCheck,
        label: 'Agent',
        rank: '#4',
        color: '#25D366',
        bgColor: 'rgba(37, 211, 102, 0.1)',
        textColor: '#25D366'
    },
    'subagent': {
        icon: UserCheck,
        label: 'Sub-Agent',
        rank: '#5',
        color: '#0D9488',
        bgColor: 'rgba(13, 148, 136, 0.1)',
        textColor: '#0D9488'
    },
    'customer': {
        icon: UserCircle,
        label: 'Customer',
        rank: '#6',
        color: '#0057FF',
        bgColor: 'rgba(0, 87, 255, 0.1)',
        textColor: '#0057FF'
    }
}

/**
 * Role identity accents for the unified clay shell. `ring`/`dot` are the role hue;
 * chip pairs are solid, contrast-safe (>= 4.5:1) text/background combinations for
 * light (clay #E6ECF5) and dark (#0F1626) surfaces. Guarded by scripts/test-role-theme.ts.
 */
export const roleTheme: Record<UserRole, {
    ring: string
    dot: string
    chipLight: { bg: string; text: string }
    chipDark: { bg: string; text: string }
}> = {
    'admin': {
        ring: '#E60000',
        dot: '#E60000',
        chipLight: { bg: '#E6C9D0', text: '#9E0000' },
        chipDark: { bg: '#36121F', text: '#F26B6B' }
    },
    'sub-admin': {
        ring: '#FACC15',
        dot: '#FACC15',
        chipLight: { bg: '#E9E7D3', text: '#5C4A06' },
        chipDark: { bg: '#393723', text: '#FACC15' }
    },
    'dealer': {
        ring: '#7C3AED',
        dot: '#7C3AED',
        chipLight: { bg: '#D6D1F4', text: '#5B21B6' },
        chipDark: { bg: '#231C4A', text: '#B08CF5' }
    },
    'agent': {
        ring: '#25D366',
        dot: '#25D366',
        chipLight: { bg: '#C9E8E0', text: '#0F5F2C' },
        chipDark: { bg: '#133832', text: '#25D366' }
    },
    'subagent': {
        ring: '#0D9488',
        dot: '#0D9488',
        chipLight: { bg: '#C5DFE5', text: '#0B5A52' },
        chipDark: { bg: '#0F2D38', text: '#45B5AB' }
    },
    'customer': {
        ring: '#0057FF',
        dot: '#0057FF',
        chipLight: { bg: '#C4D6F7', text: '#0040C0' },
        chipDark: { bg: '#0C224D', text: '#6B9CFF' }
    }
}
