import { Shield, ShieldCheck, Gem, Award, Users, UserCircle, LucideIcon } from 'lucide-react'

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
        icon: Shield,
        label: 'Admin',
        rank: '#1',
        color: '#CA8A04',
        bgColor: 'rgba(202, 138, 4, 0.1)',
        textColor: '#CA8A04'
    },
    'sub-admin': {
        icon: ShieldCheck,
        label: 'Sub-Admin',
        rank: '#2',
        color: '#DB2777',
        bgColor: 'rgba(219, 39, 119, 0.1)',
        textColor: '#DB2777'
    },
    'dealer': {
        icon: Gem,
        label: 'Dealer',
        rank: '#3',
        color: '#C2410C',
        bgColor: 'rgba(194, 65, 12, 0.1)',
        textColor: '#C2410C'
    },
    'agent': {
        icon: Award,
        label: 'Agent',
        rank: '#4',
        color: '#059669',
        bgColor: 'rgba(5, 150, 105, 0.1)',
        textColor: '#059669'
    },
    'subagent': {
        icon: Users,
        label: 'Sub-Agent',
        rank: '#5',
        color: '#65A30D',
        bgColor: 'rgba(101, 163, 13, 0.1)',
        textColor: '#65A30D'
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
        ring: '#CA8A04',
        dot: '#CA8A04',
        chipLight: { bg: '#F0DEB0', text: '#7A4A05' },
        chipDark: { bg: '#3A2A0C', text: '#F2B84B' }
    },
    'sub-admin': {
        ring: '#DB2777',
        dot: '#DB2777',
        chipLight: { bg: '#F7D3E3', text: '#9D174D' },
        chipDark: { bg: '#3B0D22', text: '#F472B6' }
    },
    'dealer': {
        ring: '#C2410C',
        dot: '#C2410C',
        chipLight: { bg: '#F5D9C4', text: '#7C2D12' },
        chipDark: { bg: '#341207', text: '#FB923C' }
    },
    'agent': {
        ring: '#059669',
        dot: '#059669',
        chipLight: { bg: '#C7EDDD', text: '#065F46' },
        chipDark: { bg: '#0B2F24', text: '#34D399' }
    },
    'subagent': {
        ring: '#65A30D',
        dot: '#65A30D',
        chipLight: { bg: '#E1EDBE', text: '#3F5F0B' },
        chipDark: { bg: '#222B0C', text: '#BEF264' }
    },
    'customer': {
        ring: '#0057FF',
        dot: '#0057FF',
        chipLight: { bg: '#C4D6F7', text: '#0040C0' },
        chipDark: { bg: '#0C224D', text: '#6B9CFF' }
    }
}
