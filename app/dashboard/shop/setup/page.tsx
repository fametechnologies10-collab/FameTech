'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import { motion, AnimatePresence } from 'framer-motion'
import { useAuth } from '@/contexts/auth-context'
import { supabase } from '@/lib/supabase'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
    Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
    Store, Upload, Phone, Mail, MessageCircle, Palette, Eye, Save,
    Loader2, ExternalLink, ArrowLeft, ChevronDown, ChevronUp, Users,
    X, Trash2, CheckCircle2, AlertTriangle, Copy, Check, MessageSquare, Smartphone
} from 'lucide-react'
import { cn, normalizeWhatsAppNumber } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { SenderIdExplainer } from '@/components/sms/sender-id-explainer'


// ─── Brand Presets ────────────────────────────────────────────────────────────
const BRAND_PRESETS = [
    { name: 'Gold', color: '#FFCE00', accent: '#e6b800' },
    { name: 'Green', color: '#25D366', accent: '#1ebc57' },
    { name: 'Red', color: '#E60000', accent: '#cc0000' },
    { name: 'Ocean Blue', color: '#2563eb', accent: '#1e40af' },
    { name: 'Emerald', color: '#059669', accent: '#065f46' },
    { name: 'Purple', color: '#7c3aed', accent: '#5b21b6' },
    { name: 'Orange', color: '#ea580c', accent: '#c2410c' },
    { name: 'Rose', color: '#e11d48', accent: '#be123c' },
    { name: 'Teal', color: '#0d9488', accent: '#0f766e' },
    { name: 'Slate', color: '#475569', accent: '#334155' },
    { name: 'Amber', color: '#d97706', accent: '#b45309' },
]

// ─── Divider Presets ──────────────────────────────────────────────────────────
const DIVIDER_PRESETS: { id: string; label: string; path: string; popular?: boolean }[] = [
    {
        id: 'asymmetric-curve', label: 'Asymmetrical Curve', popular: true,
        path: 'M321.39,56.44c58-10.79,114.16-30.13,172-41.86,82.39-16.72,168.19-17.73,250.45-.39C823.78,31,906.67,72,985.66,92.83c70.05,18.48,146.53,26.09,214.34,3V120H0V0C0,0,0,0,0,0c0,0,0,0,0,0Q160.69,78,321.39,56.44Z'
    },
    {
        id: 'angled', label: 'Angled Divider', popular: true,
        path: 'M0,0 L1200,80 L1200,120 L0,120 Z'
    },
    {
        id: 'zigzag', label: 'Geometric Zig-Zag', popular: true,
        path: 'M0,60 L100,0 L200,60 L300,0 L400,60 L500,0 L600,60 L700,0 L800,60 L900,0 L1000,60 L1100,0 L1200,60 L1200,120 L0,120 Z'
    },
    {
        id: 'concave', label: 'Concave Curve', popular: true,
        path: 'M0,0 Q600,120 1200,0 L1200,120 L0,120 Z'
    },
    {
        id: 'animated-wave', label: 'Animated Wave', popular: true,
        path: 'M0,64 C150,100 350,0 600,60 C850,120 1050,20 1200,64 L1200,120 L0,120 Z'
    },
    {
        id: 'layered-waves', label: 'Layered Waves',
        path: 'M0,80 C200,20 400,100 600,60 C800,20 1000,100 1200,80 L1200,120 L0,120 Z'
    },
    {
        id: 'tilt', label: 'Tilt Divider',
        path: 'M0,40 L1200,0 L1200,120 L0,120 Z'
    },
    {
        id: 'organic-blob', label: 'Organic Blob',
        path: 'M0,80 C100,20 300,100 500,70 C700,40 900,110 1100,60 C1150,45 1180,50 1200,60 L1200,120 L0,120 Z'
    },
    {
        id: 'paper-cut', label: 'Paper Cut',
        path: 'M0,80 L120,40 L240,80 L360,40 L480,80 L600,40 L720,80 L840,40 L960,80 L1080,40 L1200,80 L1200,120 L0,120 Z'
    },
    {
        id: 'torn-edge', label: 'Torn Edge',
        path: 'M0,90 L30,70 L60,95 L90,65 L130,85 L170,60 L210,90 L260,55 L310,80 L370,50 L430,85 L490,58 L560,90 L640,55 L720,85 L800,50 L880,80 L960,45 L1040,75 L1120,50 L1200,70 L1200,120 L0,120 Z'
    },
    {
        id: 'convex', label: 'Convex Curve',
        path: 'M0,120 Q600,0 1200,120 L1200,120 L0,120 Z'
    },
    {
        id: 'slant', label: 'Slant Transition',
        path: 'M0,80 L1200,0 L1200,120 L0,120 Z'
    },
    {
        id: 'skewed', label: 'Skewed Transition',
        path: 'M0,0 L900,0 L1200,120 L0,120 Z'
    },
    {
        id: 'glassmorphic', label: 'Glassmorphic Glow',
        path: 'M0,100 Q600,60 1200,100 L1200,120 L0,120 Z'
    },
    {
        id: 'multi-step-wave', label: 'Multi-Step Wave',
        path: 'M0,60 C100,40 200,80 300,60 C400,40 500,80 600,60 C700,40 800,80 900,60 C1000,40 1100,80 1200,60 L1200,120 L0,120 Z'
    },
]

const POPULAR_DIVIDERS = DIVIDER_PRESETS.filter(d => d.popular)
const EXTRA_DIVIDERS = DIVIDER_PRESETS.filter(d => !d.popular)

// ─── Detect community platform ────────────────────────────────────────────────
function detectPlatform(url: string): { label: string; color: string } | null {
    if (!url) return null
    try {
        const hostname = new URL(url).hostname.toLowerCase()
        if (hostname.includes('whatsapp.com')) return { label: 'WhatsApp', color: '#25D366' }
        if (hostname.includes('t.me') || hostname.includes('telegram')) return { label: 'Telegram', color: '#229ED9' }
        if (hostname.includes('facebook.com') || hostname.includes('fb.com')) return { label: 'Facebook', color: '#1877F2' }
        if (hostname.includes('youtube.com')) return { label: 'YouTube', color: '#FF0000' }
        if (hostname.includes('tiktok.com')) return { label: 'TikTok', color: '#000000' }
        if (hostname.includes('instagram.com')) return { label: 'Instagram', color: '#E1306C' }
        return { label: 'Link', color: '#6b7280' }
    } catch { return null }
}

// ─── Types ────────────────────────────────────────────────────────────────────
interface ShopForm {
    shop_name: string
    shop_slug: string
    description: string
    owner_phone: string
    owner_email: string
    whatsapp_number: string
    community_link: string
    brand_color: string
    brand_accent: string
    divider_style: string
}

// ─── Progress Steps ───────────────────────────────────────────────────────────
const STEPS = [
    { key: 'details', label: 'Details' },
    { key: 'contact', label: 'Contact' },
    { key: 'community', label: 'Community' },
    { key: 'branding', label: 'Branding' },
    { key: 'sms', label: 'SMS' },
    { key: 'ussd', label: 'USSD' },
] as const

const SETUP_PROGRESS_LS_KEY = 'shop-setup-progress'

const SectionHeader = ({
    title, icon
}: {
    title: string; icon: React.ReactNode
}) => (
    <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">{icon}{title}</CardTitle>
    </CardHeader>
)

export default function ShopSetupPage() {
    const { dbUser } = useAuth()
    const router = useRouter()
    const fileInputRef = useRef<HTMLInputElement>(null)
    const pendingNavRef = useRef<string | null>(null)
    const slugCheckSeqRef = useRef(0)
    
    // Hex Color Validator
    const isValidHex = (color: string) => /^#([A-Fa-f0-9]{3}){1,4}$/.test(color)

    const [existingShopId, setExistingShopId] = useState<string | null>(null)
    const [savedIsActive, setSavedIsActive] = useState(true)
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [uploading, setUploading] = useState(false)
    const [logoUrl, setLogoUrl] = useState<string | null>(null)
    const [logoPreview, setLogoPreview] = useState<string | null>(null)
    const [slugTaken, setSlugTaken] = useState(false)
    const [slugChecking, setSlugChecking] = useState(false)
    const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)
    const [showUnsavedModal, setShowUnsavedModal] = useState(false)
    const [showDeleteModal, setShowDeleteModal] = useState(false)
    const [showAllDividers, setShowAllDividers] = useState(false)
    const [communityLinkError, setCommunityLinkError] = useState('')
    const [activeStep, setActiveStep] = useState(0)
    const [completedSteps, setCompletedSteps] = useState<string[]>([])
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
    // Creation-success dialog (new shops only) — sender-ID nudge + pricing handoff
    const [createSuccessOpen, setCreateSuccessOpen] = useState(false)
    const [successLinkCopied, setSuccessLinkCopied] = useState(false)
    // SMS step (Step 5) — thin wrapper around the existing SMS activation
    // endpoints; nothing here is a new backend surface (see Task 4 brief).
    const [smsStatus, setSmsStatus] = useState<{ enabled: boolean; activationFee: number; activated: boolean; mainBalance: number; profitBalance: number } | null>(null)
    const [smsLoading, setSmsLoading] = useState(false)
    const [smsPaySource, setSmsPaySource] = useState<'wallet' | 'profit'>('wallet')
    // USSD step (Step 6) — informational-only until the shop is live: the
    // activate_shop_ussd RPC requires shop_profiles.is_active, which only
    // flips true after pricing is submitted and approved (a separate flow
    // that finishes after this wizard). See Task 5 brief.
    const [shopIsLive, setShopIsLive] = useState(false)
    const [ussdInfo, setUssdInfo] = useState<{ fee: number; walletBalance: number; profitBalance: number } | null>(null)
    const [ussdLoading, setUssdLoading] = useState(false)
    const [ussdPaySource, setUssdPaySource] = useState<'wallet' | 'profit'>('wallet')
    // Synchronous in-flight locks for the two paid activations: the *Loading states
    // only disable their buttons after a re-render, so two rapid taps could
    // otherwise both send a request.
    const smsActivatingRef = useRef(false)
    const ussdActivatingRef = useRef(false)
    const [ussdCode, setUssdCode] = useState<string | null>(null)

    const [form, setForm] = useState<ShopForm>({
        shop_name: '',
        shop_slug: '',
        description: '',
        owner_phone: '',
        owner_email: '',
        whatsapp_number: '',
        community_link: '',
        brand_color: '#2563eb',
        brand_accent: '#1e40af',
        divider_style: 'asymmetric-curve',
    })

    const updateForm = useCallback((updates: Partial<ShopForm>) => {
        setForm(prev => ({ ...prev, ...updates }))
        setHasUnsavedChanges(true)
    }, [])

    // Auto-expand dividers if currently selected is in extra list
    useEffect(() => {
        if (EXTRA_DIVIDERS.some(d => d.id === form.divider_style)) {
            setShowAllDividers(true)
        }
    }, [form.divider_style])

    useEffect(() => {
        if (dbUser) fetchExistingShop()
    }, [dbUser])

    // SMS step status — fetched only when that step becomes active AND the
    // shop already exists (the endpoint 404s otherwise), not on every render.
    useEffect(() => {
        if (STEPS[activeStep]?.key !== 'sms' || !existingShopId) return
        fetch('/api/shop/sms/status').then(r => r.json()).then(res => {
            if (res.success) setSmsStatus(res.data)
        }).catch(() => { /* step still renders with smsStatus null → shows a retry state */ })
    }, [activeStep, existingShopId])

    // USSD step status — same fetch-on-active pattern as SMS above. Fetched
    // even when the shop isn't live yet (the GET route is public/best-effort
    // for balances), so the fee still shows once the shop goes live without
    // requiring a page reload.
    useEffect(() => {
        if (STEPS[activeStep]?.key !== 'ussd' || !existingShopId) return
        fetch('/api/shop/ussd-activate').then(r => r.json()).then(setUssdInfo).catch(() => { /* step still renders with ussdInfo null → shows loading state */ })
    }, [activeStep, existingShopId])

    const fetchExistingShop = async () => {
        const { data } = await ((supabase as any)
            .from('shop_profiles')
            .select('*')
            .eq('owner_id', dbUser!.id)
            .maybeSingle())

        if (data) {
            setExistingShopId(data.id)
            setLogoUrl(data.logo_url)
            setLogoPreview(data.logo_url)
            const normalizedWA = normalizeWhatsAppNumber(data.whatsapp_number || '')
            setSavedIsActive(data.is_active ?? true)
            setShopIsLive(!!data.is_active)
            setForm({
                shop_name: data.shop_name || '',
                shop_slug: data.shop_slug || '',
                description: data.description || '',
                owner_phone: data.owner_phone || '',
                owner_email: data.owner_email || '',
                whatsapp_number: normalizedWA,
                community_link: data.community_link || '',
                brand_color: data.brand_color || '#2563eb',
                brand_accent: data.brand_accent || '#1e40af',
                divider_style: data.divider_style || 'asymmetric-curve',
            })
        }

        // Resume wizard progress — DB first (cross-device), localStorage fallback
        try {
            const dbProgress = data?.setup_progress
            const lsRaw = typeof window !== 'undefined' ? localStorage.getItem(SETUP_PROGRESS_LS_KEY) : null
            const lsProgress = lsRaw ? JSON.parse(lsRaw) : null
            const progress = dbProgress && typeof dbProgress.step === 'number' ? dbProgress : lsProgress
            if (progress && typeof progress.step === 'number') {
                setActiveStep(Math.min(Math.max(progress.step, 0), STEPS.length - 1))
                if (Array.isArray(progress.completed)) setCompletedSteps(progress.completed)
            }
        } catch { /* corrupt progress is non-fatal — start at step 0 */ }

        setLoading(false)
    }

    // ─── Wizard navigation ────────────────────────────────────────────────────
    const persistProgress = (step: number, completed: string[]) => {
        try {
            localStorage.setItem(SETUP_PROGRESS_LS_KEY, JSON.stringify({ step, completed }))
        } catch { /* storage full/blocked — non-fatal */ }
    }

    // Single source of truth for field-level validation rules — validateStep (used
    // for wizard "Continue" gating) and handleSave (used for the final submit) both
    // call this instead of maintaining separate copies that could drift.
    const collectFieldErrors = (): Record<string, string> => {
        const errors: Record<string, string> = {}
        if (!form.shop_name.trim()) errors.shop_name = 'Shop name is required'
        if (!form.shop_slug.trim() || form.shop_slug.length < 3) errors.shop_slug = 'Slug must be at least 3 characters'
        if (slugTaken) errors.shop_slug = 'This slug is already taken'
        if (!form.owner_phone.trim()) errors.owner_phone = 'Owner phone is required'
        if (form.whatsapp_number && !waValid) errors.whatsapp_number = 'Invalid WhatsApp number format'
        if (form.owner_email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.owner_email.trim())) {
            errors.owner_email = 'Must be a valid email address'
        }
        if (form.community_link && !form.community_link.startsWith('https://')) {
            errors.community_link = 'Community link must start with https://'
        }
        return errors
    }

    // Which fields each wizard step is allowed to block "Continue" on. A field
    // missing from a step's list is still enforced at final submit.
    const STEP_FIELDS: Record<number, string[]> = {
        0: ['shop_name', 'shop_slug'],
        1: ['owner_phone', 'whatsapp_number', 'owner_email'],
        2: ['community_link'],
    }

    const validateStep = (stepIdx: number): boolean => {
        const allErrors = collectFieldErrors()
        const relevantKeys = STEP_FIELDS[stepIdx] || []
        const errors: Record<string, string> = {}
        for (const key of relevantKeys) {
            if (allErrors[key]) errors[key] = allErrors[key]
        }
        if (Object.keys(errors).length > 0) {
            setFieldErrors(prev => ({ ...prev, ...errors }))
            return false
        }
        return true
    }

    const goToStep = (stepIdx: number) => {
        const clamped = Math.min(Math.max(stepIdx, 0), STEPS.length - 1)
        setActiveStep(clamped)
        persistProgress(clamped, completedSteps)
        if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' })
    }

    // Navigation reset only — does NOT touch any saved field data or delete
    // the shop. See spec §5: "restart afresh" means going back to Step 0 with
    // everything already saved still pre-filled, not a data wipe (that's the
    // existing separate "Delete Shop" modal).
    const startOver = async () => {
        setCompletedSteps([])
        setActiveStep(0)
        persistProgress(0, [])
        if (existingShopId) await persistProgressToDb(0, [])
        if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' })
    }

    // Step 0 ("Details") creates the shop the first time it's completed — every
    // step after that PUTs an incremental update to the row that now exists
    // (see docs/superpowers/specs/2026-09-10-shop-setup-wizard-redesign-design.md §4).
    // This is the actual fix for the old "Forbidden" logo-upload bug: branding
    // (and its logo upload) now always runs against a shop that already exists.
    // Looks up the caller's shop row by owner_id (same query fetchExistingShop
    // uses on load). Returns true and sets existingShopId only if a row was
    // actually found — callers must not assume success just because this
    // resolved without throwing.
    const lookupAndSetExistingShop = async (): Promise<boolean> => {
        const { data: created } = await ((supabase as any)
            .from('shop_profiles')
            .select('id')
            .eq('owner_id', dbUser!.id)
            .maybeSingle())
        if (created?.id) {
            setExistingShopId(created.id)
            return true
        }
        return false
    }

    const createShopIfNeeded = async (): Promise<boolean> => {
        if (existingShopId) return true
        setSaving(true)
        try {
            const res = await fetch('/api/shop/profile', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    shop_name: form.shop_name.trim(),
                    shop_slug: form.shop_slug.trim(),
                }),
            })
            const data = await res.json()
            if (!res.ok) {
                // A 409 "already have a shop" here means a previous attempt (e.g.
                // the create POST succeeded but the id re-fetch below failed, and
                // the user hit Continue again) actually created the row. Recover
                // by looking it up instead of surfacing this as a hard error.
                if (res.status === 409 && !data.details) {
                    const found = await lookupAndSetExistingShop()
                    if (found) return true
                    toast.error('Shop created, but we couldn\'t confirm it — please refresh and try again')
                    return false
                }
                if (data.details) {
                    const errors: Record<string, string> = {}
                    for (const d of data.details as string[]) {
                        const [field] = d.split(':')
                        if (field) errors[field.trim()] = d
                    }
                    setFieldErrors(prev => ({ ...prev, ...errors }))
                } else {
                    toast.error(data.error || 'Could not create your shop. Please try again.')
                }
                return false
            }
            // POST /api/shop/profile returns { success: true } without the new
            // row's id — re-fetch to pick it up, same call already used on load.
            // If this lookup fails or finds nothing, existingShopId stays falsy
            // — do NOT report success, or every later step's savePartial() would
            // silently no-op (it only PUTs when existingShopId is set) with no
            // indication to the user that nothing is being saved.
            const found = await lookupAndSetExistingShop()
            if (!found) {
                toast.error('Shop created, but we couldn\'t confirm it — please refresh and try again')
                return false
            }
            return true
        } catch {
            toast.error('Could not create your shop. Please try again.')
            return false
        } finally {
            setSaving(false)
        }
    }

    // Fields each step is responsible for persisting on "Continue" — a subset
    // of the full payload `handleSave` used to send all at once. SMS/USSD steps
    // don't PUT shop_profiles fields at all (they call their own activation
    // endpoints directly — see Tasks 4/5), so they're absent here on purpose.
    const STEP_SAVE_FIELDS: Partial<Record<string, () => Record<string, unknown>>> = {
        contact: () => ({
            owner_phone: form.owner_phone.trim(),
            owner_email: form.owner_email.trim() || '',
            whatsapp_number: normalizeWhatsAppNumber(form.whatsapp_number) || '',
        }),
        community: () => ({ community_link: form.community_link.trim() || '' }),
        branding: () => ({
            brand_color: form.brand_color,
            brand_accent: form.brand_accent,
            logo_url: logoUrl || '',
            divider_style: form.divider_style,
        }),
    }

    const savePartial = async (stepKey: string): Promise<boolean> => {
        const build = STEP_SAVE_FIELDS[stepKey]
        if (!build) return true // sms/ussd steps: nothing to PUT here
        setSaving(true)
        try {
            const res = await fetch('/api/shop/profile', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    shop_name: form.shop_name.trim(),
                    shop_slug: form.shop_slug.trim(),
                    ...build(),
                }),
            })
            const data = await res.json()
            if (!res.ok) {
                toast.error(data.error || 'Could not save this step. Please try again.')
                return false
            }
            setHasUnsavedChanges(false)
            return true
        } catch {
            toast.error('Could not save this step. Please try again.')
            return false
        } finally {
            setSaving(false)
        }
    }

    // DB-side progress write — cross-device resume from any step, not just
    // after final save (previously setup_progress was only written by
    // handleSave). Best-effort: a failure here shouldn't block navigation,
    // since persistProgress() already covers same-device resume via localStorage.
    const persistProgressToDb = async (step: number, completed: string[]) => {
        try {
            await fetch('/api/shop/profile', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    shop_name: form.shop_name.trim(),
                    shop_slug: form.shop_slug.trim(),
                    setup_progress: { step, completed },
                }),
            })
        } catch { /* best-effort — localStorage already covers same-device resume */ }
    }

    const goNext = async () => {
        if (!validateStep(activeStep)) return
        if (activeStep === 0) {
            const ok = await createShopIfNeeded()
            if (!ok) return
        } else if (existingShopId) {
            // Steps after Details PUT their own slice of fields incrementally
            // so progress and data are never lost if the user closes the tab.
            const ok = await savePartial(STEPS[activeStep].key)
            if (!ok) return
        }
        const stepKey = STEPS[activeStep].key
        const completed = completedSteps.includes(stepKey) ? completedSteps : [...completedSteps, stepKey]
        setCompletedSteps(completed)
        const next = Math.min(activeStep + 1, STEPS.length - 1)
        setActiveStep(next)
        persistProgress(next, completed)
        if (existingShopId) await persistProgressToDb(next, completed)
        if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' })
    }

    const generateSlug = (name: string) =>
        name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

    const handleNameChange = (value: string) => {
        updateForm({
            shop_name: value,
            shop_slug: existingShopId ? form.shop_slug : generateSlug(value),
        })
    }

    const checkSlug = useCallback(async (slug: string) => {
        if (!slug || slug.length < 3) return
        const seq = ++slugCheckSeqRef.current
        setSlugChecking(true)
        const { data } = await ((supabase as any)
            .from('shop_profiles')
            .select('id')
            .eq('shop_slug', slug)
            .neq('owner_id', dbUser!.id)
            .maybeSingle())
        // Drop out-of-order responses: a slower request for an earlier keystroke
        // must never overwrite the answer for what's currently in the box.
        if (seq !== slugCheckSeqRef.current) return
        setSlugTaken(!!data)
        setSlugChecking(false)
    }, [dbUser])

    // Debounced availability check — fires ~400ms after typing stops instead of
    // on every keystroke. Also covers the slug auto-generated from the shop name
    // (handleNameChange), which the old inline onChange call never checked.
    useEffect(() => {
        if (!form.shop_slug || form.shop_slug.length < 3) {
            setSlugTaken(false)
            return
        }
        const timer = setTimeout(() => { checkSlug(form.shop_slug) }, 400)
        return () => clearTimeout(timer)
    }, [form.shop_slug, checkSlug])

    // ─── Logo Upload ─────────────────────────────────────────────────────────
    const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (!file) return
        if (file.size > 5 * 1024 * 1024) { toast.error('Logo must be under 5MB'); return }
        if (!['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(file.type)) {
            toast.error('Only JPG, PNG, or WEBP images allowed'); return
        }
        const reader = new FileReader()
        reader.onload = (ev) => setLogoPreview(ev.target?.result as string)
        reader.readAsDataURL(file)
        setUploading(true)
        try {
            const form = new FormData()
            form.append('file', file)
            form.append('type', 'logo')
            const res = await fetch('/api/shop/upload', { method: 'POST', body: form })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || 'Upload failed')
            setLogoUrl(data.publicUrl)
            setHasUnsavedChanges(true)
            toast.success('Logo uploaded!')
        } catch (err: any) { toast.error(err.message || 'Upload failed. Please try again.'); setLogoPreview(logoUrl) }
        finally { setUploading(false) }
    }

    // ─── WhatsApp derived state ───────────────────────────────────────────────
    const normalizedWA = normalizeWhatsAppNumber(form.whatsapp_number)
    const waValid = !normalizedWA || /^233\d{9}$/.test(normalizedWA)

    // ─── Save ─────────────────────────────────────────────────────────────────
    const handleSave = async (thenNavigate?: string) => {
        setFieldErrors({}) // clear previous errors

        // Basic frontend guards — same rule set the wizard steps gate on.
        const errors = collectFieldErrors()
        if (Object.keys(errors).length > 0) {
            setFieldErrors(errors)
            return
        }

        setSaving(true)
        try {
            const finalWA = normalizeWhatsAppNumber(form.whatsapp_number)
            const payload = {
                shop_name: form.shop_name.trim(),
                shop_slug: form.shop_slug.trim(),
                description: form.description.trim().slice(0, 400),
                owner_phone: form.owner_phone.trim(),
                owner_email: form.owner_email.trim() || '',
                whatsapp_number: finalWA || '',
                community_link: form.community_link.trim() || '',
                brand_color: form.brand_color,
                brand_accent: form.brand_accent,
                logo_url: logoUrl || '',
                divider_style: form.divider_style,
                // A full save means every wizard step has been completed —
                // pricing remains pending until set on the pricing page.
                setup_progress: {
                    step: STEPS.length - 1,
                    completed: STEPS.map(s => s.key) as unknown as string[],
                },
            }

            const method = existingShopId ? 'PUT' : 'POST'
            const res = await fetch('/api/shop/profile', {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            })

            const data = await res.json()

            if (!res.ok) {
                if (data.details && Array.isArray(data.details)) {
                    const newErrors: Record<string, string> = {}
                    data.details.forEach((err: string) => {
                        const [field, ...rest] = err.split(':')
                        if (field && rest.length) {
                            newErrors[field.trim()] = rest.join(':').trim()
                        }
                    })
                    setFieldErrors(newErrors)
                    throw new Error(data.error || 'Please fix the highlighted fields.')
                }
                throw new Error(data.error || 'Failed to save shop')
            }

            setHasUnsavedChanges(false)
            try { localStorage.removeItem(SETUP_PROGRESS_LS_KEY) } catch { /* non-fatal */ }
            if (thenNavigate) {
                // Explicit user navigation (unsaved-changes modal) — honor it.
                toast.success(existingShopId ? 'Shop updated!' : 'Shop created! Now set your prices to go live.')
                router.push(thenNavigate)
            } else if (!existingShopId) {
                // New shops: success dialog (shop link + optional next steps).
                // Dismissing it leaves the owner on the setup page; only the
                // primary button navigates to pricing.
                setCreateSuccessOpen(true)
            } else {
                toast.success('Shop updated!')
                router.push('/dashboard/shop')
            }
        } catch (err: any) {
            toast.error(err.message || 'Failed to save shop')
        } finally {
            setSaving(false)
        }
    }

    // ─── SMS activation (Step 5) ──────────────────────────────────────────────
    // Own loading/disabled state — deliberately not the shared footer `saving`
    // flag, which Task 3/6 own for step create/save/navigation.
    const handleEnableSms = async () => {
        if (smsActivatingRef.current) return
        smsActivatingRef.current = true
        setSmsLoading(true)
        try {
            const res = await fetch('/api/shop/sms/activate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ paidFrom: smsPaySource }),
            })
            const data = await res.json()
            if (!data.success) {
                toast.error(data.error || 'Could not activate SMS.')
                return
            }
            toast.success('SMS activated!')
            setSmsStatus(prev => prev ? { ...prev, activated: true } : prev)
        } catch {
            toast.error('Could not activate SMS. Please try again.')
        } finally {
            smsActivatingRef.current = false
            setSmsLoading(false)
        }
    }

    // ─── USSD activation (Step 6) ─────────────────────────────────────────────
    // Own loading/disabled state, same rationale as handleEnableSms above.
    // Only reachable once shopIsLive is true — the JSX below never renders
    // the button that calls this while the shop isn't live yet, but the RPC
    // (SHOP_NOT_APPROVED) is the real backstop either way.
    const handleEnableUssd = async () => {
        if (ussdActivatingRef.current) return
        ussdActivatingRef.current = true
        setUssdLoading(true)
        try {
            const res = await fetch('/api/shop/ussd-activate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ paidFrom: ussdPaySource }),
            })
            const data = await res.json()
            if (!res.ok) {
                toast.error(data.error || 'Could not activate USSD.')
                return
            }
            toast.success('USSD activated!')
            setUssdCode(data.code)
        } catch {
            toast.error('Could not activate USSD. Please try again.')
        } finally {
            ussdActivatingRef.current = false
            setUssdLoading(false)
        }
    }

    // ─── Unsaved Changes Navigation Guard ────────────────────────────────────
    useEffect(() => {
        const handleBeforeUnload = (e: BeforeUnloadEvent) => {
            if (hasUnsavedChanges) { e.preventDefault(); e.returnValue = '' }
        }
        window.addEventListener('beforeunload', handleBeforeUnload)
        return () => window.removeEventListener('beforeunload', handleBeforeUnload)
    }, [hasUnsavedChanges])

    const handleNavAway = (href: string) => {
        if (hasUnsavedChanges) {
            pendingNavRef.current = href
            setShowUnsavedModal(true)
        } else {
            router.push(href)
        }
    }

    // Creation-success dialog handoff — new shops always land on pricing
    // (the final setup requirement before the storefront can go live).
    const goToPricing = () => {
        setCreateSuccessOpen(false)
        router.push('/dashboard/shop/pricing?from=setup')
    }

    if (loading) {
        return (
            <div className="flex items-center justify-center py-20">
                <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
        )
    }

    const shopUrl = form.shop_slug ? `https://shop.kingflexygh.com/${form.shop_slug}` : ''
    const dividerList = showAllDividers ? DIVIDER_PRESETS : POPULAR_DIVIDERS
    const platform = detectPlatform(form.community_link)

    return (
        <div className="space-y-6 max-w-5xl mx-auto pb-32 setup-theme">
            {/* Dynamic CSS variables with sanitization */}
            <style dangerouslySetInnerHTML={{ __html: `
                .setup-theme { 
                    --brand-color: ${isValidHex(form.brand_color) ? form.brand_color : '#2563eb'}; 
                    ${platform ? `--platform-color: ${platform.color};` : ''}
                }
                ${BRAND_PRESETS.map((p, i) => `.preset-bg-${i} { background-color: ${p.color}; }`).join('\n')}
            `}} />

            {/* Unsaved Changes Modal */}
            {showUnsavedModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
                    <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 p-6 max-w-sm w-full space-y-4 animate-in zoom-in-95 duration-200">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center flex-shrink-0">
                                <AlertTriangle className="w-5 h-5 text-amber-600" />
                            </div>
                            <div>
                                <p className="font-bold text-gray-900 dark:text-white">You have unsaved changes</p>
                                <p className="text-xs text-muted-foreground mt-0.5">If you leave now, your changes will be lost.</p>
                            </div>
                        </div>
                        <div className="flex gap-3">
                            <Button
                                variant="outline"
                                className="flex-1"
                                onClick={() => {
                                    setShowUnsavedModal(false)
                                    if (pendingNavRef.current) router.push(pendingNavRef.current)
                                    pendingNavRef.current = null
                                }}
                            >
                                Ignore
                            </Button>
                            <Button
                                className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white"
                                disabled={saving}
                                onClick={async () => {
                                    setShowUnsavedModal(false)
                                    await handleSave(pendingNavRef.current || undefined)
                                    pendingNavRef.current = null
                                }}
                            >
                                {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
                                Save &amp; Continue
                            </Button>
                        </div>
                    </div>
                </div>
            )}

            {/* Delete Shop Confirmation Modal */}
            {showDeleteModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
                    <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 p-6 max-w-sm w-full space-y-4 animate-in zoom-in-95 duration-200">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center flex-shrink-0">
                                <AlertTriangle className="w-5 h-5 text-red-600" />
                            </div>
                            <div>
                                <p className="font-bold text-gray-900 dark:text-white">Delete your shop?</p>
                                <p className="text-xs text-muted-foreground mt-0.5">
                                    This permanently deletes your shop, all orders, and your profit wallet.
                                    This cannot be undone.
                                </p>
                            </div>
                        </div>
                        <div className="flex gap-3">
                            <Button
                                variant="outline"
                                className="flex-1"
                                onClick={() => setShowDeleteModal(false)}
                                disabled={saving}
                            >
                                Cancel
                            </Button>
                            <Button
                                variant="destructive"
                                className="flex-1"
                                disabled={saving}
                                onClick={async () => {
                                    setShowDeleteModal(false)
                                    setSaving(true)
                                    try {
                                        const { error } = await supabase.rpc('delete_shop_data')
                                        if (error) throw error
                                        // Leaving the page after a successful delete — clearing the
                                        // guard stops the beforeunload prompt firing on the way out.
                                        setHasUnsavedChanges(false)
                                        toast.success('Shop deleted successfully')
                                        router.replace('/dashboard/shop')
                                    } catch (err: any) {
                                        toast.error(err.message || 'Failed to delete shop')
                                        setSaving(false)
                                    }
                                }}
                            >
                                {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                                Delete Shop
                            </Button>
                        </div>
                    </div>
                </div>
            )}

            {/* Header */}
            <div className="space-y-4">
                <button onClick={() => handleNavAway('/dashboard/shop')}>
                    <span className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-emerald-600 transition-colors -ml-2 px-2 py-1 rounded-lg hover:bg-emerald-50 dark:hover:bg-emerald-900/10">
                        <ArrowLeft className="w-4 h-4" />
                        Back to Shop Dashboard
                    </span>
                </button>
                <div className="mb-2">
                    <h1 className="text-2xl font-black tracking-tight">Shop Setup Wizard</h1>
                    <p className="text-sm text-muted-foreground mt-1">
                        {existingShopId
                            ? "Let's finish getting your KiNGFLEXYGH storefront ready."
                            : "Let's get your KiNGFLEXYGH storefront live."}
                    </p>
                </div>
                {completedSteps.length > 0 && activeStep > 0 && (
                    <button type="button" onClick={startOver} className="text-xs font-semibold text-muted-foreground hover:text-foreground underline mb-4">
                        Start over
                    </button>
                )}

                {/* Progress Stepper — real steps, clickable once completed */}
                <div className="flex items-center gap-1 mb-6 overflow-x-auto pb-2">
                    {STEPS.map((step, i) => {
                        const isDone = completedSteps.includes(step.key) || i < activeStep
                        const isCurrent = i === activeStep
                        const canJump = isDone || i <= activeStep || !!existingShopId
                        return (
                            <button
                                key={step.key}
                                type="button"
                                disabled={!canJump}
                                onClick={() => canJump && goToStep(i)}
                                className={cn(
                                    'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold whitespace-nowrap transition-colors flex-shrink-0',
                                    isCurrent ? 'bg-emerald-600 text-white' :
                                    isDone ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 cursor-pointer' :
                                    canJump ? 'bg-gray-100 dark:bg-gray-800 text-gray-500 cursor-pointer' :
                                    'bg-gray-50 dark:bg-gray-900 text-gray-300 dark:text-gray-700 cursor-not-allowed'
                                )}
                            >
                                {isDone && <Check className="w-3 h-3" />}
                                {i + 1}. {step.label}
                            </button>
                        )
                    })}
                </div>
            </div>

            <AnimatePresence mode="wait">
            <motion.div
                key={STEPS[activeStep].key}
                initial={{ opacity: 0, x: 24 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -24 }}
                transition={{ duration: 0.2 }}
            >
            {/* ── STEP 1: Shop Details ────────────────────────────────────── */}
            {activeStep === 0 && (
            <Card>
                <SectionHeader
                    title="Shop Details"
                    icon={<Store className="w-4 h-4 text-emerald-600" />}
                />
                {(
                    <CardContent className="space-y-4">
                        <div>
                            <Label htmlFor="shop_name">Shop Name *</Label>
                            <Input
                                id="shop_name"
                                value={form.shop_name}
                                onChange={(e) => { 
                                    handleNameChange(e.target.value) 
                                    setFieldErrors(p => ({ ...p, shop_name: '' })) 
                                }}
                                placeholder="e.g. Kofi's Data Shop"
                                className={cn("mt-1", fieldErrors.shop_name && "border-red-500 focus-visible:ring-red-500")}
                            />
                            {fieldErrors.shop_name && <p className="text-xs text-red-500 mt-1">{fieldErrors.shop_name}</p>}
                            <p className="text-xs text-muted-foreground mt-1">This will be the browser title on your shop page.</p>
                        </div>

                        <div>
                            <Label htmlFor="shop_slug">Shop URL Slug *</Label>
                            <div className="flex items-center gap-2 mt-1">
                                <span className="text-sm text-muted-foreground whitespace-nowrap">shop.kingflexygh.com/</span>
                                <Input
                                    id="shop_slug"
                                    value={form.shop_slug}
                                    onChange={(e) => {
                                        const slug = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '')
                                        updateForm({ shop_slug: slug })
                                        setFieldErrors(p => ({ ...p, shop_slug: '' }))
                                    }}
                                    placeholder="kofi-data-shop"
                                    className={cn((slugTaken || fieldErrors.shop_slug) && 'border-red-500 focus-visible:ring-red-500')}
                                />
                                {slugChecking && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
                            </div>
                            {slugTaken && <p className="text-xs text-red-500 mt-1">This slug is already taken. Choose another.</p>}
                            {fieldErrors.shop_slug && !slugTaken && <p className="text-xs text-red-500 mt-1">{fieldErrors.shop_slug}</p>}
                            {form.shop_slug && !slugTaken && !fieldErrors.shop_slug && (
                                <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                                    Preview: <span className="font-mono">{shopUrl}</span>
                                    <a href={shopUrl} target="_blank" rel="noopener noreferrer" className="ml-1" title="Open storefront" aria-label="Open storefront">
                                        <ExternalLink className="w-3 h-3" />
                                    </a>
                                </p>
                            )}
                        </div>

                        <div>
                            <div className="flex items-center justify-between mb-1">
                                <Label htmlFor="description">Description</Label>
                                <span className={cn(
                                    'text-xs font-medium tabular-nums',
                                    form.description.length > 380 ? 'text-red-500' :
                                        form.description.length > 300 ? 'text-amber-500' : 'text-muted-foreground'
                                )}>{form.description.length}/400</span>
                            </div>
                            <Textarea
                                id="description"
                                value={form.description}
                                onChange={(e) => {
                                    updateForm({ description: e.target.value })
                                    setFieldErrors(p => ({ ...p, description: '' }))
                                }}
                                placeholder="Describe your shop (shown as subtitle and meta description)"
                                rows={3}
                                maxLength={400}
                                className={cn("mt-0", fieldErrors.description && "border-red-500 focus-visible:ring-red-500")}
                            />
                            {fieldErrors.description && <p className="text-xs text-red-500 mt-1">{fieldErrors.description}</p>}
                        </div>

                        {/* Shop Status — read-only. is_active is server-controlled: it can never be
                            set by the client (see app/api/shop/profile/route.ts shopProfileSchema),
                            and the shop actually goes live automatically once pricing is submitted
                            and approved. This card used to render an interactive Open/Closed toggle
                            that had no effect at all — removed rather than fixed, since there is
                            nothing for the owner to control here. */}
                        <div className="rounded-xl border p-4 space-y-2">
                            <div className="flex items-center justify-between">
                                <p className="text-sm font-semibold">Shop Status</p>
                                <span className={cn(
                                    'text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full',
                                    savedIsActive ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' :
                                        'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                                )}>
                                    Currently: {savedIsActive ? 'OPEN' : 'CLOSED'}
                                </span>
                            </div>
                            <p className="text-xs text-muted-foreground">
                                {existingShopId
                                    ? 'Your shop goes live automatically once your prices are submitted and approved — there\'s nothing to toggle here.'
                                    : 'New shops start closed. Set your prices after creating your shop to go live automatically.'}
                            </p>
                        </div>
                    </CardContent>
                )}
            </Card>
            )}

            {/* ── STEP 2: Contact Information ─────────────────────────────── */}
            {activeStep === 1 && (
            <Card>
                <SectionHeader
                    title="Contact Information"
                    icon={<Phone className="w-4 h-4 text-blue-500" />}
                />
                {(
                    <CardContent className="space-y-4">
                        <div>
                            <Label htmlFor="owner_phone" className="flex items-center gap-1.5">
                                <Phone className="w-3.5 h-3.5" /> Owner Phone *
                            </Label>
                            <Input
                                id="owner_phone"
                                value={form.owner_phone}
                                onChange={(e) => {
                                    updateForm({ owner_phone: e.target.value })
                                    setFieldErrors(p => ({ ...p, owner_phone: '' }))
                                }}
                                placeholder="0244123456"
                                className={cn("mt-1", fieldErrors.owner_phone && "border-red-500 focus-visible:ring-red-500")}
                            />
                            {fieldErrors.owner_phone && <p className="text-xs text-red-500 mt-1">{fieldErrors.owner_phone}</p>}
                            <p className="text-xs text-muted-foreground mt-1">Displayed as contact on your shop page.</p>
                        </div>

                        <div>
                            <Label htmlFor="owner_email" className="flex items-center gap-1.5">
                                <Mail className="w-3.5 h-3.5" /> Email (Optional)
                            </Label>
                            <Input
                                id="owner_email"
                                type="text"
                                value={form.owner_email}
                                onChange={(e) => {
                                    updateForm({ owner_email: e.target.value })
                                    setFieldErrors(p => ({ ...p, owner_email: '' }))
                                }}
                                placeholder="yourname@email.com"
                                className={cn("mt-1", fieldErrors.owner_email && "border-red-500 focus-visible:ring-red-500")}
                            />
                            {fieldErrors.owner_email && <p className="text-xs text-red-500 mt-1">{fieldErrors.owner_email}</p>}
                        </div>

                        <div>
                            <Label htmlFor="whatsapp_number" className="flex items-center gap-1.5">
                                <MessageCircle className="w-3.5 h-3.5" /> WhatsApp Number (Optional)
                            </Label>
                            <Input
                                id="whatsapp_number"
                                value={form.whatsapp_number}
                                onChange={(e) => {
                                    updateForm({ whatsapp_number: e.target.value })
                                    setFieldErrors(p => ({ ...p, whatsapp_number: '' }))
                                }}
                                placeholder="0244123456 or +233244123456"
                                className={cn("mt-1", fieldErrors.whatsapp_number && "border-red-500 focus-visible:ring-red-500")}
                            />
                            {fieldErrors.whatsapp_number && <p className="text-xs text-red-500 mt-1">{fieldErrors.whatsapp_number}</p>}
                            {form.whatsapp_number.trim() !== '' && !fieldErrors.whatsapp_number && (
                                <p className={cn('text-xs mt-1 flex items-center gap-1', waValid ? 'text-emerald-600' : 'text-red-500')}>
                                    {waValid ? (
                                        <><CheckCircle2 className="w-3 h-3" /> Will be saved as: <span className="font-mono">{normalizedWA}</span>
                                            {' · '}
                                            <a href={`https://wa.me/${normalizedWA}`} target="_blank" rel="noopener noreferrer" className="underline">Test link</a>
                                        </>
                                    ) : (
                                        <><AlertTriangle className="w-3 h-3" /> Invalid format — must be a valid Ghana number</>
                                    )}
                                </p>
                            )}
                            {!form.whatsapp_number && !fieldErrors.whatsapp_number && (
                                <p className="text-xs text-muted-foreground mt-1">
                                    Format: <span className="font-mono">0244123456</span> → becomes a floating WhatsApp button on your shop.
                                </p>
                            )}
                        </div>
                    </CardContent>
                )}
            </Card>
            )}

            {/* ── STEP 3: Community Link ──────────────────────────────────── */}
            {activeStep === 2 && (
            <Card>
                <SectionHeader
                    title="Community Link (Optional)"
                    icon={<Users className="w-4 h-4 text-violet-500" />}
                />
                {(
                    <CardContent className="space-y-3">
                        <div>
                            <Label htmlFor="community_link" className="flex items-center gap-1.5">
                                <Users className="w-3.5 h-3.5" /> Community / Group Link
                                {platform && (
                                    <span className="ml-1 text-[10px] font-black px-2 py-0.5 rounded-full text-white bg-[var(--platform-color)]" title={`${platform.label} community`}>
                                        {platform.label}
                                    </span>
                                )}
                            </Label>
                            <Input
                                id="community_link"
                                type="url"
                                value={form.community_link}
                                onChange={(e) => { 
                                    updateForm({ community_link: e.target.value }); 
                                    setCommunityLinkError('');
                                    setFieldErrors(p => ({ ...p, community_link: '' }))
                                }}
                                onBlur={() => {
                                    if (form.community_link && !form.community_link.startsWith('https://')) {
                                        setCommunityLinkError('Link must start with https://')
                                    }
                                }}
                                placeholder="https://chat.whatsapp.com/... or https://t.me/... or https://fb.com/groups/..."
                                className={cn('mt-1', (communityLinkError || fieldErrors.community_link) && 'border-red-500 focus-visible:ring-red-500')}
                            />
                            {communityLinkError && <p className="text-xs text-red-500 mt-1">{communityLinkError}</p>}
                            {fieldErrors.community_link && <p className="text-xs text-red-500 mt-1">{fieldErrors.community_link}</p>}
                            <p className="text-xs text-muted-foreground mt-1">
                                Share your WhatsApp group, Telegram channel, Facebook group, or any community link where customers can follow your updates.
                            </p>
                        </div>
                    </CardContent>
                )}
            </Card>
            )}

            {/* ── STEP 4: Branding ────────────────────────────────────────── */}
            {activeStep === 3 && (
            <Card>
                <SectionHeader
                    title="Branding"
                    icon={<Palette className="w-4 h-4 text-pink-500" />}
                />
                {(
                    <CardContent className="space-y-6">

                        {/* Logo Upload */}
                        <div>
                            <Label>Shop Logo (Max 5MB — JPG, PNG, WEBP)</Label>
                            <div
                                className="mt-2 border-2 border-dashed rounded-xl p-6 text-center cursor-pointer hover:border-emerald-500 hover:bg-emerald-50/50 dark:hover:bg-emerald-900/10 transition-colors"
                                onClick={() => fileInputRef.current?.click()}
                            >
                                {logoPreview ? (
                                    <div className="flex flex-col items-center gap-3">
                                        <div className="relative w-20 h-20 rounded-xl overflow-hidden border">
                                            <Image src={logoPreview} alt="Logo preview" fill className="object-contain" />
                                        </div>
                                        <p className="text-xs text-muted-foreground">Click to change logo</p>
                                    </div>
                                ) : (
                                    <div className="flex flex-col items-center gap-2 text-muted-foreground">
                                        {uploading ? <Loader2 className="w-8 h-8 animate-spin text-emerald-600" /> : <Upload className="w-8 h-8" />}
                                        <p className="text-sm font-medium">{uploading ? 'Uploading...' : 'Click to upload logo'}</p>
                                        <p className="text-xs">JPG, PNG, WEBP up to 5MB</p>
                                    </div>
                                )}
                            </div>
                            {logoPreview && (
                                <Button variant="ghost" size="sm" className="mt-1 text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/10 gap-1.5 text-xs"
                                    onClick={() => { setLogoPreview(null); setLogoUrl(null); setHasUnsavedChanges(true) }}>
                                    <Trash2 className="w-3.5 h-3.5" /> Remove Logo
                                </Button>
                            )}
                            <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={handleLogoUpload} title="Upload shop logo" aria-label="Upload shop logo" />
                        </div>

                        {/* Color Presets */}
                        <div>
                            <Label>Brand Color</Label>
                            <div className="grid grid-cols-4 gap-2 mt-2">
                                {BRAND_PRESETS.map((preset, idx) => (
                                    <button
                                        key={preset.name}
                                        type="button"
                                        onClick={() => updateForm({ brand_color: preset.color, brand_accent: preset.accent })}
                                        className={cn(
                                            'flex flex-col items-center gap-1.5 p-2 rounded-xl border-2 transition-all',
                                            form.brand_color.toLowerCase() === preset.color.toLowerCase()
                                                ? 'border-gray-900 dark:border-white scale-105 shadow-md'
                                                : 'border-transparent hover:border-gray-300 dark:hover:border-gray-600'
                                        )}
                                    >
                                        <div className={`w-8 h-8 rounded-full shadow-sm preset-bg-${idx}`} title={preset.name} />
                                        <span className="text-[10px] font-medium text-center leading-tight">{preset.name}</span>
                                    </button>
                                ))}
                            </div>
                            {/* Custom color picker */}
                            <div className="mt-3 flex items-center gap-3">
                                <Label className="text-xs text-muted-foreground whitespace-nowrap">Custom color:</Label>
                                <input
                                    type="color"
                                    value={form.brand_color}
                                    onChange={(e) => updateForm({ brand_color: e.target.value, brand_accent: e.target.value })}
                                    className="w-10 h-10 rounded-lg cursor-pointer border border-gray-200 dark:border-gray-700 p-0.5 bg-transparent"
                                    title="Pick a custom brand color"
                                />
                                <span className="text-xs font-mono text-muted-foreground">{form.brand_color}</span>
                            </div>
                        </div>

                        {/* Divider Selector */}
                        <div>
                            <Label>Section Divider Style</Label>
                            <p className="text-xs text-muted-foreground mt-0.5 mb-3">Choose how the hero section blends into the content below.</p>
                            <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                                {dividerList.map((preset) => (
                                    <button
                                        key={preset.id}
                                        type="button"
                                        onClick={() => updateForm({ divider_style: preset.id })}
                                        className={cn(
                                            'flex flex-col items-center gap-1.5 p-2 rounded-xl border-2 transition-all overflow-hidden',
                                            form.divider_style === preset.id
                                                ? 'border-emerald-500 scale-[1.04] shadow-md shadow-emerald-100 dark:shadow-emerald-900/20'
                                                : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                                        )}
                                    >
                                        <div className="w-full h-8 rounded-md overflow-hidden bg-[var(--brand-color)]" title="Divider preview">
                                            <svg viewBox="0 0 1200 120" preserveAspectRatio="none" className="w-full h-full">
                                                <path d={preset.path} fill="white" />
                                            </svg>
                                        </div>
                                        <span className="text-[9px] font-bold text-center leading-tight line-clamp-2">{preset.label}</span>
                                    </button>
                                ))}
                            </div>
                            <button
                                type="button"
                                onClick={() => setShowAllDividers(!showAllDividers)}
                                className="mt-2 w-full flex items-center justify-center gap-1.5 text-xs font-bold text-emerald-600 hover:text-emerald-700 py-2 rounded-xl hover:bg-emerald-50 dark:hover:bg-emerald-900/10 transition-colors"
                            >
                                {showAllDividers ? <><ChevronUp className="w-3.5 h-3.5" /> Show Less</> : <><ChevronDown className="w-3.5 h-3.5" /> Show More (10)</>}
                            </button>
                        </div>

                        {/* Live Preview */}
                        <div>
                            <Label className="flex items-center gap-1.5"><Eye className="w-3.5 h-3.5" /> Preview</Label>
                            <div className="mt-2 rounded-xl border overflow-hidden shadow-sm">
                                <div className="p-6 text-center bg-[var(--brand-color)]">
                                    <div className="flex flex-col items-center gap-3">
                                        {logoPreview ? (
                                            <div className="relative w-16 h-16 rounded-2xl overflow-hidden bg-white shadow-lg flex-shrink-0">
                                                <Image src={logoPreview} alt="Logo" fill className="object-contain" />
                                            </div>
                                        ) : (
                                            <div className="w-16 h-16 rounded-2xl bg-white/20 flex items-center justify-center flex-shrink-0 shadow-lg">
                                                <Store className="w-8 h-8 text-white" />
                                            </div>
                                        )}
                                        <div className="min-w-0">
                                            <p className="text-white font-black text-lg truncate leading-tight">{form.shop_name || 'Your Shop Name'}</p>
                                            <p className="text-white/80 text-xs mt-1 line-clamp-2 max-w-[200px] mx-auto">{form.description || 'Your shop description appears here.'}</p>
                                        </div>
                                    </div>
                                    {/* Divider preview */}
                                    <div className="relative w-full h-8 mt-4 overflow-hidden">
                                        <svg viewBox="0 0 1200 120" preserveAspectRatio="none" className="absolute bottom-0 w-full h-full fill-white dark:fill-gray-900">
                                            <path d={(DIVIDER_PRESETS.find(d => d.id === form.divider_style) || DIVIDER_PRESETS[0]).path} />
                                        </svg>
                                    </div>
                                </div>
                                <div className="p-3 bg-white dark:bg-gray-900 flex items-center justify-between">
                                    <span className="text-xs text-muted-foreground">Buy Now button preview:</span>
                                    <button className="text-xs text-white font-bold px-3 py-1.5 rounded-lg bg-[var(--brand-color)]" title="Action button preview">
                                        Buy Now
                                    </button>
                                </div>
                            </div>
                        </div>
                    </CardContent>
                )}
            </Card>
            )}

            {/* ── STEP 5: SMS Notifications ───────────────────────────────── */}
            {activeStep === 4 && (
            <Card>
                <SectionHeader title="SMS Notifications" icon={<MessageSquare className="w-4 h-4" />} />
                <CardContent className="space-y-4">
                    <p className="text-sm text-muted-foreground">
                        Automatically text your customers when their order is confirmed. Optional — you can enable this any time from your dashboard.
                    </p>
                    {!smsStatus ? (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Loader2 className="w-4 h-4 animate-spin" /> Loading...
                        </div>
                    ) : !smsStatus.enabled ? (
                        <p className="text-sm text-muted-foreground italic">SMS is currently unavailable platform-wide. You can check back later from your dashboard.</p>
                    ) : smsStatus.activated ? (
                        <div className="rounded-xl border border-emerald-200 bg-emerald-50 dark:bg-emerald-900/20 p-4 text-sm font-semibold text-emerald-700 dark:text-emerald-400">
                            SMS is active for your shop.
                        </div>
                    ) : (
                        <div className="space-y-3">
                            <p className="text-sm">One-time activation fee: <strong>GHS {smsStatus.activationFee.toFixed(2)}</strong></p>
                            <div className="flex gap-2">
                                <button type="button" onClick={() => setSmsPaySource('wallet')}
                                    className={cn('flex-1 py-2 rounded-lg border-2 text-sm font-bold', smsPaySource === 'wallet' ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20' : 'border-gray-200 dark:border-gray-700')}>
                                    Wallet (GHS {smsStatus.mainBalance.toFixed(2)})
                                </button>
                                <button type="button" onClick={() => setSmsPaySource('profit')}
                                    className={cn('flex-1 py-2 rounded-lg border-2 text-sm font-bold', smsPaySource === 'profit' ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20' : 'border-gray-200 dark:border-gray-700')}>
                                    Profit (GHS {smsStatus.profitBalance.toFixed(2)})
                                </button>
                            </div>
                            <Button onClick={handleEnableSms} disabled={smsLoading} className="w-full">
                                {smsLoading ? <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Activating...</> : 'Enable SMS'}
                            </Button>
                        </div>
                    )}
                    <a href="/dashboard/shop/sms" target="_blank" rel="noopener noreferrer" className="text-xs font-semibold text-emerald-600 hover:underline inline-block">
                        Configure templates & sender ID →
                    </a>
                </CardContent>
            </Card>
            )}

            {/* ── STEP 6: USSD Shortcode ──────────────────────────────────────
                Informational-only until the shop is live: activate_shop_ussd
                requires shop_profiles.is_active, which only flips true after
                pricing is submitted and approved — strictly after this wizard
                finishes. Do not attempt activation earlier; there is no way
                to trigger it here while shopIsLive is false. */}
            {activeStep === 5 && (
            <Card>
                <SectionHeader title="USSD Shortcode" icon={<Smartphone className="w-4 h-4" />} />
                <CardContent className="space-y-4">
                    <p className="text-sm text-muted-foreground">
                        Give customers a USSD code to order without an app or internet. Optional — you can enable this any time from your dashboard once your shop is live.
                    </p>
                    {!shopIsLive ? (
                        <div className="rounded-xl border border-amber-200 bg-amber-50 dark:bg-amber-900/20 p-4 text-sm text-amber-800 dark:text-amber-300">
                            Your shop needs to be live first — finish this wizard and submit your prices, then come back here (or visit <a href="/dashboard/shop/ussd" className="underline font-semibold">USSD settings</a>) to activate.
                        </div>
                    ) : ussdCode ? (
                        <div className="rounded-xl border border-emerald-200 bg-emerald-50 dark:bg-emerald-900/20 p-4 text-sm font-semibold text-emerald-700 dark:text-emerald-400">
                            Your USSD code is active: {ussdCode}
                        </div>
                    ) : !ussdInfo ? (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Loader2 className="w-4 h-4 animate-spin" /> Loading...
                        </div>
                    ) : (
                        <div className="space-y-3">
                            <p className="text-sm">One-time activation fee: <strong>GHS {ussdInfo.fee.toFixed(2)}</strong></p>
                            <div className="flex gap-2">
                                <button type="button" onClick={() => setUssdPaySource('wallet')}
                                    className={cn('flex-1 py-2 rounded-lg border-2 text-sm font-bold', ussdPaySource === 'wallet' ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20' : 'border-gray-200 dark:border-gray-700')}>
                                    Wallet (GHS {ussdInfo.walletBalance.toFixed(2)})
                                </button>
                                <button type="button" onClick={() => setUssdPaySource('profit')}
                                    className={cn('flex-1 py-2 rounded-lg border-2 text-sm font-bold', ussdPaySource === 'profit' ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20' : 'border-gray-200 dark:border-gray-700')}>
                                    Profit (GHS {ussdInfo.profitBalance.toFixed(2)})
                                </button>
                            </div>
                            <Button onClick={handleEnableUssd} disabled={ussdLoading} className="w-full">
                                {ussdLoading ? <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Activating...</> : 'Enable USSD'}
                            </Button>
                        </div>
                    )}
                </CardContent>
            </Card>
            )}
            </motion.div>
            </AnimatePresence>

            {/* ── Creation Success Dialog (new shops only) ──────────────────────────
                Dismissal (X, overlay, Escape) just closes the dialog — no forced
                redirect. The shop isn't live yet (that happens automatically once
                pricing is submitted and approved), so the copy reflects that instead
                of claiming the store is "ready." */}
            <Dialog open={createSuccessOpen} onOpenChange={setCreateSuccessOpen}>
                <DialogContent className="max-w-md" aria-describedby={undefined}>
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <CheckCircle2 className="w-5 h-5 text-emerald-600" /> Shop created!
                        </DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4">
                        <p className="text-sm text-muted-foreground">
                            A couple of quick things before you&apos;re live — setting your prices is
                            what makes your shop visible to customers.
                        </p>

                        {shopUrl && (
                            <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2">
                                <span className="flex-1 text-xs font-mono truncate">{shopUrl}</span>
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    className="h-7 shrink-0 gap-1 text-[11px]"
                                    onClick={async () => {
                                        try {
                                            await navigator.clipboard.writeText(shopUrl)
                                            setSuccessLinkCopied(true)
                                            toast.success('Shop link copied!')
                                            setTimeout(() => setSuccessLinkCopied(false), 2000)
                                        } catch {
                                            // Clipboard API is unavailable on insecure origins and
                                            // some in-app browsers — say so instead of failing mutely.
                                            toast.error('Could not copy — long-press the link to copy it manually')
                                        }
                                    }}
                                >
                                    {successLinkCopied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                                    {successLinkCopied ? 'Copied' : 'Copy'}
                                </Button>
                            </div>
                        )}

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                            <div className="rounded-xl border p-3 space-y-2">
                                <p className="text-xs font-semibold flex items-center justify-between">
                                    Order confirmations from your brand
                                    <span className="text-[9px] font-medium text-muted-foreground uppercase tracking-wide">Optional</span>
                                </p>
                                <SenderIdExplainer variant="compact" />
                                <Link
                                    href="/dashboard/shop/sms"
                                    className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600 hover:text-emerald-700"
                                >
                                    Request a sender ID →
                                </Link>
                            </div>
                            <div className="rounded-xl border p-3 space-y-2">
                                <p className="text-xs font-semibold flex items-center justify-between">
                                    Dial-code ordering (USSD)
                                    <span className="text-[9px] font-medium text-muted-foreground uppercase tracking-wide">Optional</span>
                                </p>
                                <p className="text-[11px] text-muted-foreground">
                                    Give customers a short dial code to order from your shop without data —
                                    a one-time paid activation.
                                </p>
                                <Link
                                    href="/dashboard/shop/ussd"
                                    className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600 hover:text-emerald-700"
                                >
                                    Set up USSD →
                                </Link>
                            </div>
                        </div>
                    </div>
                    <DialogFooter>
                        <Button
                            onClick={goToPricing}
                            className="w-full h-11 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold gap-2"
                        >
                            <Save className="w-4 h-4" /> Set my prices
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* ── Wizard Navigation Bar ────────────────────────────────────── */}
            <div className="sticky bottom-0 max-md:bottom-[calc(env(safe-area-inset-bottom,0px)+52px)] bg-background/95 backdrop-blur border-t pt-4 mt-6 flex items-center justify-between gap-3">
                <Button
                    type="button"
                    variant="outline"
                    onClick={() => goToStep(activeStep - 1)}
                    disabled={activeStep === 0 || saving}
                    className={cn('h-11 px-4 gap-1.5 font-semibold', activeStep === 0 && 'invisible')}
                >
                    <ArrowLeft className="w-4 h-4" /> Back
                </Button>
                {activeStep < STEPS.length - 1 ? (
                    <Button
                        onClick={goNext}
                        disabled={saving || uploading || slugTaken}
                        className="min-w-[140px] bg-emerald-600 hover:bg-emerald-700 text-white h-11 font-semibold gap-2"
                    >
                        {saving ? <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Saving...</> : 'Continue'}
                    </Button>
                ) : (
                    <Button
                        onClick={() => handleSave()}
                        disabled={saving || uploading || slugTaken}
                        className="min-w-[140px] bg-emerald-600 hover:bg-emerald-700 text-white h-11 font-semibold gap-2"
                    >
                        {saving ? <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Finishing...</> : existingShopId ? 'Save Changes' : 'Create Shop & Set Prices'}
                    </Button>
                )}
            </div>

            {/* Danger Zone */}
            {existingShopId && (
                <div className="pt-8 border-t">
                    <h3 className="text-sm font-medium text-red-600 mb-2">Danger Zone</h3>
                    <div className="flex items-center justify-between p-4 border border-red-200 bg-red-50 dark:bg-red-900/10 dark:border-red-900 rounded-lg">
                        <div>
                            <p className="font-medium text-red-900 dark:text-red-200">Delete Shop</p>
                            <p className="text-xs text-red-700/80 dark:text-red-300/80">
                                Permanently delete your shop, orders, and wallet. This action cannot be undone.
                            </p>
                        </div>
                        <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => setShowDeleteModal(true)}
                            disabled={saving}
                        >
                            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Delete Shop'}
                        </Button>
                    </div>
                </div>
            )}
        </div>
    )
}
