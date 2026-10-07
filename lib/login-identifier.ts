import { validateGhanaianPhone } from './phone-validation'

export type LoginIdentifier =
  | { type: 'email'; value: string }
  | { type: 'phone'; value: string }
  | { type: 'invalid' }

// Detects whether a login-form identifier looks like an email or a
// Ghanaian phone number, and normalizes it accordingly. The client always
// sends an explicit `email` or `phone` field to /api/auth/login — this
// decides which one, it is never re-guessed server-side.
export function resolveLoginIdentifier(raw: string): LoginIdentifier {
  const trimmed = raw.trim()
  if (!trimmed) return { type: 'invalid' }

  if (trimmed.includes('@')) {
    return { type: 'email', value: trimmed }
  }

  const phone = validateGhanaianPhone(trimmed)
  if (phone.isValid) {
    return { type: 'phone', value: phone.normalizedNumber }
  }

  return { type: 'invalid' }
}
