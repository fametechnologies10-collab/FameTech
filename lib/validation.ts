import { z } from 'zod'
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_REQUIREMENTS_MESSAGE,
  passwordStrengthRegex,
} from '@/lib/password-validation'

const htmlBlockRegex = /[<>&]/
const scriptBlockRegex = /script|javascript:|onclick|onerror|onload|onmouseover|eval\(|data:/i

// User-facing schemas — strict, block all HTML and script patterns
export const nameSchema = z.string()
  .min(1, 'This field is required')
  .max(50, 'Must be 50 characters or less')
  .refine(val => !htmlBlockRegex.test(val), 'Invalid characters detected')
  .refine(val => !scriptBlockRegex.test(val), 'Invalid characters detected')

export const phoneSchema = z.string()
  .regex(/^(0|\+233)[2-9][0-9]{8}$/, 'Must be a valid Ghanaian phone number (e.g. 0241234567)')

export const emailSchema = z.string()
  .email('Must be a valid email address')
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Must be a valid email address with a domain (e.g. .com)')

// Root cause, 2026-09-29: three orphaned auth.users rows were found with
// domains that are syntactically "valid" under emailSchema's regex (has an
// @ and a dot) but aren't real, deliverable email providers — e.g.
// "petabenney@8" (no dot at all — actually predates even that check) and
// others on unrecognized domains. emailSchema alone can't catch a
// plausible-but-fake domain like "user@notreal.xyz".
//
// Deliberately an ALLOWLIST, not a blocklist — a blocklist only ever grows
// reactively after another bad domain shows up. Scoped to LOGIN identities
// only (signup, sub-agent creation/reset, forgot-password,
// resend-confirmation, check-availability) — NOT to shop owner_email
// (app/api/shop/profile) or results-checker recipient email, which are
// business/receipt contact addresses where a real shop legitimately may use
// a custom domain (e.g. owner@theirshop.com).
const ALLOWED_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com',
  'icloud.com', 'me.com', 'mac.com',
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'yahoo.co.uk',
  'aol.com',
  'protonmail.com', 'proton.me',
])

export const accountEmailSchema = emailSchema.refine(
  (val) => {
    const domain = val.split('@')[1]?.toLowerCase()
    return !!domain && ALLOWED_EMAIL_DOMAINS.has(domain)
  },
  'Please use a real email address (e.g. Gmail, Outlook, iCloud, Yahoo).',
)

export const currentPasswordSchema = z.string()
  .min(1, 'Password is required')
  .max(PASSWORD_MAX_LENGTH, `Password must be ${PASSWORD_MAX_LENGTH} characters or less`)

export const passwordSchema = z.string()
  .min(PASSWORD_MIN_LENGTH, PASSWORD_REQUIREMENTS_MESSAGE)
  .max(PASSWORD_MAX_LENGTH, `Password must be ${PASSWORD_MAX_LENGTH} characters or less`)
  .regex(passwordStrengthRegex, PASSWORD_REQUIREMENTS_MESSAGE)

export const messageSchema = z.string()
  .min(1, 'Message cannot be empty')
  .max(1000, 'Message must be 1000 characters or less')
  .refine(val => !htmlBlockRegex.test(val), 'Invalid characters detected')
  .refine(val => !scriptBlockRegex.test(val), 'Invalid characters detected')

export const shortTextSchema = z.string()
  .max(200, 'Must be 200 characters or less')
  .refine(val => !htmlBlockRegex.test(val), 'Invalid characters detected')
  .refine(val => !scriptBlockRegex.test(val), 'Invalid characters detected')

export const longTextSchema = z.string()
  .max(5000, 'Must be 5000 characters or less')
  .refine(val => !htmlBlockRegex.test(val), 'Invalid characters detected')
  .refine(val => !scriptBlockRegex.test(val), 'Invalid characters detected')

// Shop-specific schemas
export const slugSchema = z.string()
  .min(3, 'Must be at least 3 characters')
  .max(50, 'Must be 50 characters or less')
  .regex(/^[a-z0-9-]+$/, 'Only lowercase letters, numbers, and hyphens allowed')
  .refine(val => !scriptBlockRegex.test(val), 'Invalid characters detected')

export const whatsappSchema = z.string()
  .regex(/^233\d{9}$/, 'Must be a valid Ghanaian WhatsApp number starting with 233 (e.g. 233244123456)')

export const urlSchema = z.string()
  .max(500, 'Must be 500 characters or less')
  .url('Must be a valid URL')
  .refine(val => val.startsWith('https://'), 'Must be a secure HTTPS link')
  .refine(val => !scriptBlockRegex.test(val), 'Invalid characters detected')

export const colorSchema = z.string()
  .regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a valid hex color (e.g. #2563eb)')
  .or(z.literal(''))

// Admin-only schemas — allow > and < for math/comparisons but still block script injection
export const adminLongTextSchema = z.string()
  .max(5000, 'Must be 5000 characters or less')
  .refine(val => !scriptBlockRegex.test(val), 'Script injection detected')

export const adminShortTextSchema = z.string()
  .max(200, 'Must be 200 characters or less')
  .refine(val => !scriptBlockRegex.test(val), 'Script injection detected')
