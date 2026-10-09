import { isStrongPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './password-validation'

export type StrengthLevel = 'empty' | 'weak' | 'fair' | 'good' | 'strong'

export interface StrengthResult {
    level: StrengthLevel
    score: 0 | 1 | 2 | 3 | 4
    rules: { length: boolean; upper: boolean; lower: boolean; number: boolean }
}

const LEVELS: StrengthLevel[] = ['weak', 'weak', 'fair', 'good', 'strong']

function hasCommonPattern(password: string): boolean {
    const lower = password.toLowerCase()
    if (lower.includes('password') || lower.includes('1234') || lower.includes('qwerty')) return true
    const chars = Array.from(password)
    return chars.length > 1 && chars.every((c) => c === chars[0])
}

export function evaluatePasswordStrength(password: string): StrengthResult {
    const rules = {
        length: password.length >= PASSWORD_MIN_LENGTH && password.length <= PASSWORD_MAX_LENGTH,
        upper: /[A-Z]/.test(password),
        lower: /[a-z]/.test(password),
        number: /\d/.test(password),
    }

    if (password === '') return { level: 'empty', score: 0, rules }

    let points = [rules.length, rules.upper, rules.lower, rules.number].filter(Boolean).length
    if (password.length >= 12) points += 1
    if (/[^A-Za-z0-9\s]/.test(password)) points += 1

    const common = hasCommonPattern(password)
    if (common) points -= 1

    let score = Math.min(4, Math.max(0, points - 1))
    if (common) score = Math.min(score, 3)
    if (!isStrongPassword(password)) score = Math.min(score, 2)

    const s = score as StrengthResult['score']
    return { level: LEVELS[s], score: s, rules }
}
