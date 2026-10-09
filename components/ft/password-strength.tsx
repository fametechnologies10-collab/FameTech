import { Check, Circle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { evaluatePasswordStrength, type StrengthLevel } from '@/lib/password-strength'

export interface PasswordStrengthProps {
    password: string
    className?: string
}

type ActiveLevel = Exclude<StrengthLevel, 'empty'>

const LABELS: Record<ActiveLevel, string> = {
    weak: 'Weak',
    fair: 'Fair',
    good: 'Good',
    strong: 'Strong',
}

const FILLS: Record<ActiveLevel, string> = {
    weak: 'linear-gradient(135deg, #E5484D 0%, #F26A6E 100%)',
    fair: 'linear-gradient(135deg, #F5A524 0%, #F7B955 100%)',
    good: 'linear-gradient(135deg, var(--ft-blue) 0%, #0A66FF 100%)',
    strong: 'linear-gradient(135deg, #00C8FF 0%, #12D18E 100%)',
}

export function strengthSegments(level: StrengthLevel): number {
    switch (level) {
        case 'weak': return 1
        case 'fair': return 2
        case 'good': return 3
        case 'strong': return 4
        default: return 0
    }
}

const RULE_ITEMS = [
    { key: 'length', label: '8+ characters' },
    { key: 'upper', label: 'Uppercase letter' },
    { key: 'lower', label: 'Lowercase letter' },
    { key: 'number', label: 'Number' },
] as const

export function PasswordStrength({ password, className }: PasswordStrengthProps) {
    const { level, rules } = evaluatePasswordStrength(password)
    const empty = level === 'empty'
    const active: ActiveLevel = empty ? 'weak' : level
    const filled = strengthSegments(level)
    const fill = FILLS[active]

    // One stable tree: the aria-live label stays mounted (sr-only and empty when
    // there is no password) so screen readers announce the first level change.
    return (
        <div className={empty ? 'sr-only' : cn('space-y-3', className)}>
            <div className="flex items-center gap-3">
                {!empty && (
                    <div className="ft-inset flex flex-1 gap-1.5 p-1.5" aria-hidden="true">
                        {[0, 1, 2, 3].map((i) => (
                            <span
                                key={i}
                                className="h-2 flex-1 rounded-full"
                                style={i < filled ? { background: fill } : undefined}
                            />
                        ))}
                    </div>
                )}
                <span className="flex items-center gap-1.5 text-sm font-semibold text-ft-ink">
                    {!empty && <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full" style={{ background: fill }} />}
                    <span aria-live="polite">{empty ? '' : LABELS[active]}</span>
                </span>
            </div>
            {!empty && (
            <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {RULE_ITEMS.map(({ key, label }) => {
                    const met = rules[key]
                    return (
                        <li key={key} className={cn('flex items-center gap-2 text-sm', met ? 'text-ft-ink' : 'text-[color:var(--ft-muted)]')}>
                            {met ? <Check className="h-4 w-4" aria-hidden="true" /> : <Circle className="h-4 w-4" aria-hidden="true" />}
                            <span>{label}</span>
                            <span className="sr-only">{met ? 'met' : 'not met'}</span>
                        </li>
                    )
                })}
            </ul>
            )}
        </div>
    )
}
