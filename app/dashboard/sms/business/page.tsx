'use client'

/**
 * KFT SMS — Business Registration + Sender-ID wizard.
 * Fintech-style onboarding: status stepper, draft/submit flow with review
 * lock, rejection/revocation re-edit, pool sender picker and own Sender-ID
 * requests with a live status timeline. KYC documents (Ghana Card, business
 * certificate) are sent to the admin over WhatsApp, not uploaded here — an
 * admin manually verifies them before approving the profile.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import {
    Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { toast } from '@/lib/toast'
import { validateSenderText } from '@/lib/sms-sender-validation'
import type { SmsAccountMode, SmsSenderStatus, SmsBusinessProfileStatus } from '@/lib/sms-platform-types'
import {
    ArrowLeft, RefreshCcw, Loader2, Building2, Hourglass, BadgeCheck, Send,
    FileText, Check, AlertCircle,
    ShieldAlert, ShieldCheck, PartyPopper, Globe, Lock, Info, Sparkles,
    MessageSquare, Radio, XCircle, Ban,
} from 'lucide-react'

// ── Types ────────────────────────────────────────────────────────────────────

interface SenderRow {
    id?: string
    sender_text: string
    status: SmsSenderStatus
    is_default: boolean
    rejection_reason?: string | null
    requested_at?: string
}

interface AccountInfo {
    id: string
    mode: SmsAccountMode
    status: 'active' | 'suspended'
    suspended_reason?: string | null
    default_sender: string | null
}

interface ProfileRow {
    business_name: string
    description: string
    domain_link: string | null
    ghana_card_number_masked?: string | null
    contact_whatsapp_number: string | null
    status: SmsBusinessProfileStatus
    review_notes: string | null
}

// ── Constants ────────────────────────────────────────────────────────────────

// Ghana Card format: GHA-XXXXXXXXX-X (9 digits + 1 check digit), dashes and
// spaces optional. Mirrors app/api/sms/business/route.ts exactly.
const GHANA_CARD_RE = /^GHA-?\d{9}-?\d$/

function maskGhanaCardForDisplay(normalized: string): string {
    if (normalized.length < 4) return normalized
    return `GHA-*****${normalized.slice(-4)}`
}

const fadeUp = {
    initial: { opacity: 0, y: 10 },
    animate: { opacity: 1, y: 0 },
}

// ── Small components ─────────────────────────────────────────────────────────

/** Own sender-ID lifecycle: Under review → Submitted to network → Approved. */
function SenderTimeline({ status, reason }: { status: SmsSenderStatus; reason?: string | null }) {
    const steps = [
        { key: 'under_review',        label: 'Under review' },
        { key: 'submitted_to_hubtel', label: 'Submitted to network' },
        { key: 'approved',            label: 'Approved' },
    ]
    const progress = status === 'under_review' ? 0 : status === 'submitted_to_hubtel' ? 1 : status === 'approved' ? 2 : -1
    const terminal = status === 'rejected' || status === 'revoked'

    return (
        <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
                {steps.map((s, i) => {
                    const reached = !terminal && progress >= i
                    const current = !terminal && progress === i && status !== 'approved'
                    return (
                        <React.Fragment key={s.key}>
                            {i > 0 && <span className={cn('h-px w-3', reached ? 'bg-emerald-400' : 'bg-border')} />}
                            <span className={cn(
                                'inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full border',
                                reached && status === 'approved' && i === 2 && 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-800',
                                reached && !(status === 'approved' && i === 2) && 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-400 dark:border-emerald-900',
                                !reached && 'bg-muted/40 text-muted-foreground/60 border-transparent',
                                terminal && 'opacity-50',
                            )}>
                                {reached && !current ? <Check className="w-2.5 h-2.5" /> : current ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : null}
                                {s.label}
                            </span>
                        </React.Fragment>
                    )
                })}
                {status === 'rejected' && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-red-100 text-red-700 border border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-900">
                        <XCircle className="w-2.5 h-2.5" /> Rejected
                    </span>
                )}
                {status === 'revoked' && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-red-100 text-red-700 border border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-900">
                        <Ban className="w-2.5 h-2.5" /> Revoked
                    </span>
                )}
            </div>
            {status === 'rejected' && reason && (
                <p className="text-[11px] text-red-600 dark:text-red-400">{reason}</p>
            )}
        </div>
    )
}

/**
 * WhatsApp document CTA — shared between the editable form, the "in review"
 * banner and the locked/approved summary, since documents should be
 * sendable from draft onward, including while a profile is under review
 * (Fix I3). Renders nothing when the admin number isn't configured yet,
 * instead of a fallback claim that was simply false (the number comes from
 * GET regardless of profile status).
 */
function WhatsAppDocsCta({ whatsappAdminNumber, id = 'kyc-docs' }: { whatsappAdminNumber: string; id?: string }) {
    if (!whatsappAdminNumber) return null
    return (
        <div id={id} className="rounded-xl border-2 border-dashed border-emerald-200 dark:border-emerald-900 p-3.5 space-y-1.5 bg-emerald-50/40 dark:bg-emerald-900/10">
            <p className="text-xs font-semibold flex items-center gap-1.5">
                <MessageSquare className="w-3.5 h-3.5 text-emerald-600" /> Send your documents on WhatsApp
            </p>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
                Send a photo of your Ghana Card and your business registration certificate to us on WhatsApp:
            </p>
            <a
                href={`https://wa.me/${whatsappAdminNumber}`}
                target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-700 dark:text-emerald-400 hover:underline"
            >
                <MessageSquare className="w-3.5 h-3.5" /> wa.me/{whatsappAdminNumber}
            </a>
        </div>
    )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function SmsBusinessPage() {
    const [loading, setLoading]     = useState(true)
    const [loadError, setLoadError] = useState<string | null>(null)

    const [account, setAccount]         = useState<AccountInfo | null>(null)
    const [senders, setSenders]         = useState<SenderRow[]>([])
    const [poolSenders, setPoolSenders] = useState<string[]>([])
    const [profile, setProfile]         = useState<ProfileRow | null>(null)

    // ── Form state
    const [businessName, setBusinessName] = useState('')
    const [description, setDescription]   = useState('')
    const [domain, setDomain]             = useState('')
    const [ghanaCard, setGhanaCard]       = useState('')
    const [contactWhatsapp, setContactWhatsapp] = useState('')
    const [whatsappAdminNumber, setWhatsappAdminNumber] = useState('')

    const [saving, setSaving]               = useState<'save' | 'submit' | null>(null)
    const [submitConfirm, setSubmitConfirm] = useState(false)
    const [lockNotice, setLockNotice]       = useState<string | null>(null)
    // Non-409 save/submit failures — a toast alone can be missed, so the
    // exact server message also lands here as a visible inline banner next
    // to the Save/Submit buttons.
    const [submitError, setSubmitError]     = useState<string | null>(null)

    // ── Sender request state
    const [senderText, setSenderText]             = useState('')
    const [senderError, setSenderError]           = useState<string | null>(null)
    const [requestingSender, setRequestingSender] = useState(false)
    const [patchingSender, setPatchingSender]     = useState<string | null>(null)

    // ── Fetch ─────────────────────────────────────────────────────────────────

    const fetchAll = useCallback(async () => {
        setLoadError(null)
        try {
            const [accRes, bizRes, sendRes] = await Promise.all([
                fetch('/api/sms/account').then(r => r.json()),
                fetch('/api/sms/business').then(r => r.json()),
                fetch('/api/sms/sender-ids').then(r => r.json()),
            ])
            if (!accRes.success) throw new Error(accRes.error || 'Failed to load your SMS account')
            setAccount(accRes.data.account)
            setPoolSenders(accRes.data.poolSenders || [])
            // Prefer the detailed sender-ids list — it carries id + rejection_reason
            // (the account payload only has sender_text/status/is_default).
            setSenders(sendRes?.success ? (sendRes.data.senders || []) : (accRes.data.senders || []))

            const prof: ProfileRow | null = bizRes.success ? (bizRes.data.profile ?? null) : null
            setProfile(prof)
            setWhatsappAdminNumber(bizRes.success ? (bizRes.data.whatsappAdminNumber || '') : '')

            // Prefill the form when the profile is (re-)editable — both
            // rejected AND revoked profiles are resubmittable.
            if (prof && (prof.status === 'draft' || prof.status === 'rejected' || prof.status === 'revoked')) {
                setBusinessName(prof.business_name || '')
                setDescription(prof.description || '')
                setDomain(prof.domain_link || '')
                setContactWhatsapp(prof.contact_whatsapp_number || '')
            }
        } catch (err: any) {
            setLoadError(err.message || 'Failed to load')
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { fetchAll() }, [fetchAll])

    // ── Derived ───────────────────────────────────────────────────────────────

    const status: SmsBusinessProfileStatus | 'none' = profile?.status ?? 'none'
    const editable         = status === 'none' || status === 'draft' || status === 'rejected' || status === 'revoked'
    const profileSubmitted = status === 'under_review' || status === 'approved'
    const suspended        = account?.status === 'suspended'
    const isBusinessMode   = account?.mode === 'business'

    const approvedSenders  = useMemo(() => senders.filter(s => s.status === 'approved'), [senders])
    const hasApprovedSender = approvedSenders.length > 0
    // Users may now hold MULTIPLE sender IDs (up to 200). Count only the live ones
    // (rejected/revoked don't count toward the cap) to mirror the server gate.
    const MAX_SENDERS = 200
    const liveSenderCount = useMemo(
        () => senders.filter(s => s.status === 'under_review' || s.status === 'submitted_to_hubtel' || s.status === 'approved').length,
        [senders],
    )
    const maxSendersReached = liveSenderCount >= MAX_SENDERS

    const nameOk   = businessName.trim().length >= 2 && businessName.trim().length <= 120
    const descOk   = description.trim().length >= 10 && description.trim().length <= 2000
    const domainOk = domain.trim().length >= 3 && domain.trim().includes('.')

    // Ghana Card: required to submit — format-valid, no document check
    // (documents are verified over WhatsApp now, not uploaded).
    const ghanaCardNormalized = ghanaCard.trim().toUpperCase()
    const ghanaCardProvided   = ghanaCardNormalized.length > 0
    const ghanaCardFormatOk   = ghanaCardProvided && GHANA_CARD_RE.test(ghanaCardNormalized)

    const contactWhatsappDigits = contactWhatsapp.replace(/\D/g, '')
    const contactWhatsappOk = contactWhatsappDigits.length >= 9 && contactWhatsappDigits.length <= 12

    const canSaveDraft = nameOk && descOk && !saving
    const canSubmit    = nameOk && descOk && domainOk && ghanaCardFormatOk && contactWhatsappOk && !saving

    // Sender ID requests in business mode are gated purely on the business
    // profile being approved — admin already verified Ghana Card + docs over
    // WhatsApp before approving, so no separate per-request doc check.
    const ghanaCardAttached = isBusinessMode ? status === 'approved' : true

    const senderValidation = useMemo(
        () => (senderText.trim().length >= 3 ? validateSenderText(senderText.trim()) : null),
        [senderText],
    )

    // Stepper: Register business → Under review → Approved (Business Mode) → Own Sender ID
    const stepIndex = status === 'approved'
        ? (hasApprovedSender ? 4 : 3)
        : status === 'under_review' ? 1 : 0

    // ── Handlers ─────────────────────────────────────────────────────────────

    const doSave = async (action: 'save' | 'submit') => {
        setSaving(action)
        setLockNotice(null)
        setSubmitError(null)
        try {
            const res  = await fetch('/api/sms/business', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action,
                    businessName: businessName.trim(),
                    description: description.trim(),
                    domainLink: domain.trim() || undefined,
                    ghanaCardNumber: ghanaCard.trim() || undefined,
                    contactWhatsapp: contactWhatsapp.trim() || undefined,
                }),
            })
            const json = await res.json()
            if (!json.success) {
                if (res.status === 409) {
                    setLockNotice(json.error || 'Profile is locked while under review or approved')
                    toast.error(json.error || 'Profile is locked')
                    setSubmitConfirm(false)
                    await fetchAll()
                    return
                }
                // Non-409 failures (validation, rate limit, server error) —
                // a toast alone can be missed, so surface the exact server
                // message inline near the buttons too.
                const msg = json.error || 'Could not save profile'
                setSubmitError(msg)
                toast.error(msg)
                setSubmitConfirm(false)
                return
            }
            setSubmitConfirm(false)
            toast.success(action === 'submit'
                ? 'Business profile submitted for review — we will notify you'
                : 'Draft saved')
            await fetchAll()
        } catch (err: any) {
            const msg = err.message || 'Network error — could not save profile'
            setSubmitError(msg)
            toast.error(msg)
        } finally {
            setSaving(null)
        }
    }

    const handleSubmitClick = () => setSubmitConfirm(true)

    const handleRequestSender = async () => {
        const text = senderText.trim()
        setSenderError(null)
        setRequestingSender(true)
        try {
            const res  = await fetch('/api/sms/sender-ids', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ senderText: text }),
            })
            const json = await res.json()
            if (!json.success) {
                // 400 invalid/reserved-brand + all 409 gates surface inline.
                setSenderError(json.error || 'Could not submit sender ID request')
                toast.error(json.error || 'Could not submit sender ID request')
                return
            }
            toast.success(`Sender ID "${text}" submitted for review`)
            setSenderText('')
            await fetchAll()
        } catch (err: any) {
            setSenderError(err.message || 'Could not submit sender ID request')
        } finally {
            setRequestingSender(false)
        }
    }

    const chooseSender = async (name: string) => {
        setPatchingSender(name)
        try {
            const res  = await fetch('/api/sms/account', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ defaultSender: name }),
            })
            const json = await res.json()
            if (!json.success) throw new Error(json.error || 'Could not update sender')
            setAccount(prev => (prev ? { ...prev, default_sender: json.data.default_sender } : prev))
            toast.success(`Now sending as "${json.data.default_sender}"`)
        } catch (err: any) {
            toast.error(err.message || 'Could not update sender')
        } finally {
            setPatchingSender(null)
        }
    }

    // ── Loading / error states ───────────────────────────────────────────────

    if (loading) {
        return (
            <div className="space-y-5 pb-20 md:pb-6 max-w-3xl mx-auto">
                <div className="space-y-2">
                    <Skeleton className="h-8 w-48" />
                    <Skeleton className="h-4 w-72" />
                </div>
                <Skeleton className="h-20 w-full rounded-2xl" />
                <Skeleton className="h-72 w-full rounded-2xl" />
                <Skeleton className="h-48 w-full rounded-2xl" />
            </div>
        )
    }

    if (loadError || !account) {
        return (
            <div className="max-w-md mx-auto text-center py-20 space-y-4">
                <div className="w-14 h-14 mx-auto rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
                    <AlertCircle className="w-6 h-6 text-red-500" />
                </div>
                <div>
                    <p className="font-semibold">Could not load business registration</p>
                    <p className="text-sm text-muted-foreground mt-1">{loadError || 'Something went wrong.'}</p>
                </div>
                <Button onClick={() => { setLoading(true); fetchAll() }} variant="outline" className="h-10 gap-2">
                    <RefreshCcw className="w-4 h-4" /> Try again
                </Button>
            </div>
        )
    }

    // ── Stepper meta ─────────────────────────────────────────────────────────

    const STEPS = [
        { label: 'Register',   sub: 'Business details', icon: Building2 },
        { label: 'In review',  sub: 'Admin verifies',   icon: Hourglass },
        { label: 'Approved',   sub: 'Business Mode',    icon: BadgeCheck },
        { label: 'Sender ID',  sub: 'Your brand name',  icon: Send },
    ]

    return (
        <div className="space-y-5 pb-20 md:pb-6 max-w-3xl mx-auto">

            {/* ── Header ── */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                    <Link href="/dashboard/sms">
                        <Button variant="ghost" size="sm" className="w-fit gap-2 -ml-2 h-10 text-muted-foreground hover:text-emerald-600">
                            <ArrowLeft className="w-4 h-4" /> Back to KFT SMS
                        </Button>
                    </Link>
                    <h1 className="text-xl font-bold flex items-center gap-2 mt-1">
                        <Building2 className="w-5 h-5 text-emerald-600" /> Business &amp; Sender ID
                    </h1>
                    <p className="text-muted-foreground text-sm mt-0.5">
                        Register your business to unlock Business Mode and send with your own brand name.
                    </p>
                </div>
                <Button variant="outline" size="sm" onClick={() => fetchAll()} className="gap-1.5 w-fit shrink-0 h-10">
                    <RefreshCcw className="w-3.5 h-3.5" /> Refresh
                </Button>
            </div>

            {/* ── Suspended banner ── */}
            {suspended && (
                <div className="flex items-start gap-2.5 px-4 py-3 rounded-xl bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900">
                    <ShieldAlert className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                    <div className="text-xs text-red-700 dark:text-red-400">
                        <p className="font-bold">Your SMS account is suspended</p>
                        <p className="mt-0.5">{account.suspended_reason || 'Sending is disabled while suspended.'} Contact support if you believe this is a mistake.</p>
                    </div>
                </div>
            )}

            {/* ── Status stepper ── */}
            <motion.div {...fadeUp} transition={{ duration: 0.3 }}>
                <Card className="rounded-2xl">
                    <CardContent className="p-4 sm:p-5">
                        <div className="flex items-start">
                            {STEPS.map((s, i) => {
                                const done   = stepIndex > i
                                const active = stepIndex === i
                                const Icon   = done ? Check : s.icon
                                return (
                                    <React.Fragment key={s.label}>
                                        {i > 0 && (
                                            <div className="flex-1 h-0.5 mt-5 mx-1 rounded-full bg-muted overflow-hidden">
                                                <motion.div
                                                    className="h-full bg-emerald-500"
                                                    initial={{ width: 0 }}
                                                    animate={{ width: stepIndex >= i ? '100%' : '0%' }}
                                                    transition={{ duration: 0.5, delay: 0.1 * i }}
                                                />
                                            </div>
                                        )}
                                        <div className="flex flex-col items-center text-center w-16 sm:w-20 shrink-0">
                                            <div className={cn(
                                                'w-10 h-10 rounded-full flex items-center justify-center border-2 transition-colors',
                                                done   && 'bg-emerald-500 border-emerald-500 text-white',
                                                active && 'bg-emerald-50 dark:bg-emerald-900/30 border-emerald-500 text-emerald-600',
                                                !done && !active && 'bg-muted/40 border-border text-muted-foreground/50',
                                            )}>
                                                <Icon className="w-4 h-4" />
                                            </div>
                                            <p className={cn(
                                                'text-[10px] sm:text-[11px] font-bold mt-1.5 leading-tight',
                                                done || active ? 'text-foreground' : 'text-muted-foreground/60',
                                            )}>
                                                {s.label}
                                            </p>
                                            <p className="text-[9px] sm:text-[10px] text-muted-foreground/60 leading-tight hidden sm:block">{s.sub}</p>
                                        </div>
                                    </React.Fragment>
                                )
                            })}
                        </div>
                    </CardContent>
                </Card>
            </motion.div>

            {/* ── Rejected callout ── */}
            {status === 'rejected' && (
                <div className="flex items-start gap-2.5 px-4 py-3 rounded-xl bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900">
                    <XCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                    <div className="text-xs text-red-700 dark:text-red-400">
                        <p className="font-bold">Your registration was rejected</p>
                        <p className="mt-0.5 whitespace-pre-wrap">{profile?.review_notes || 'Please review your details and submit again.'}</p>
                        <p className="mt-1 font-semibold">Update the form below and resubmit for review.</p>
                    </div>
                </div>
            )}

            {/* ── Revoked callout ── */}
            {status === 'revoked' && (
                <div className="flex items-start gap-2.5 px-4 py-3 rounded-xl bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900">
                    <Ban className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                    <div className="text-xs text-red-700 dark:text-red-400">
                        <p className="font-bold">Your business registration was revoked</p>
                        <p className="mt-0.5 whitespace-pre-wrap">{profile?.review_notes || 'Contact us on WhatsApp if you have questions.'}</p>
                        <p className="mt-1 font-semibold">Update the form below and resubmit for review.</p>
                    </div>
                </div>
            )}

            {/* ── Lock notice (409) ── */}
            {lockNotice && (
                <div className="flex items-start gap-2.5 px-4 py-3 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
                    <Lock className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-800 dark:text-amber-300">{lockNotice}</p>
                </div>
            )}

            {/* ══ EDITABLE FORM (none / draft / rejected) ══ */}
            {editable && (
                <motion.div {...fadeUp} transition={{ duration: 0.3, delay: 0.05 }}>
                    <Card className="rounded-2xl">
                        <CardContent className="p-4 sm:p-6 space-y-5">
                            <div>
                                <h3 className="text-sm font-semibold flex items-center gap-1.5">
                                    <Building2 className="w-4 h-4 text-emerald-500" /> Register your business
                                </h3>
                                <p className="text-[11px] text-muted-foreground mt-0.5">
                                    Once approved, Business Mode unlocks higher limits, any links and your own Sender ID.
                                </p>
                            </div>

                            {/* Business name */}
                            <div className="space-y-1">
                                <label htmlFor="biz-name" className="text-xs font-semibold text-muted-foreground">Business name</label>
                                <Input
                                    id="biz-name"
                                    value={businessName}
                                    onChange={e => setBusinessName(e.target.value.slice(0, 120))}
                                    placeholder="e.g. Flexy Data Hub"
                                    maxLength={120}
                                    autoComplete="organization"
                                    className="h-11"
                                />
                                <p className="text-[10px] text-muted-foreground/60">{businessName.length}/120 · min 2 characters</p>
                            </div>

                            {/* Description */}
                            <div className="space-y-1">
                                <label htmlFor="biz-desc" className="text-xs font-semibold text-muted-foreground">What does your business do?</label>
                                <Textarea
                                    id="biz-desc"
                                    value={description}
                                    onChange={e => setDescription(e.target.value.slice(0, 2000))}
                                    placeholder="Describe your business, your customers and the kind of SMS you plan to send…"
                                    rows={4}
                                    maxLength={2000}
                                    className="resize-none"
                                />
                                <p className="text-[10px] text-muted-foreground/60">{description.length}/2000 · min 10 characters</p>
                            </div>

                            {/* Domain link */}
                            <div className="space-y-1">
                                <label htmlFor="biz-domain" className="text-xs font-semibold text-muted-foreground">Business website / domain</label>
                                <div className="flex">
                                    <span className="inline-flex items-center gap-1 px-3 rounded-l-md border border-r-0 bg-muted/50 text-xs text-muted-foreground font-mono select-none">
                                        <Globe className="w-3 h-3" /> https://
                                    </span>
                                    <Input
                                        id="biz-domain"
                                        value={domain}
                                        onChange={e => setDomain(e.target.value.replace(/^https?:\/\//i, '').replace(/\s/g, '').slice(0, 200))}
                                        placeholder="yourbusiness.com"
                                        maxLength={200}
                                        autoComplete="url"
                                        inputMode="url"
                                        className="h-11 rounded-l-none font-mono text-sm"
                                    />
                                </div>
                                <p className="text-[10px] text-muted-foreground/60">Required to submit for review — where customers can verify your business.</p>
                            </div>

                            {/* Ghana Card number */}
                            <div className="space-y-1">
                                <label htmlFor="biz-card" className="text-xs font-semibold text-muted-foreground">
                                    Ghana Card number <span className="text-red-500">*</span>
                                </label>
                                <Input
                                    id="biz-card"
                                    value={ghanaCard}
                                    onChange={e => setGhanaCard(e.target.value.replace(/[^A-Za-z0-9-]/g, '').slice(0, 30))}
                                    placeholder="GHA-XXXXXXXXX-X"
                                    maxLength={30}
                                    autoComplete="off"
                                    className="h-11 font-mono text-sm"
                                />
                                {ghanaCardProvided && !ghanaCardFormatOk ? (
                                    <p className="text-[11px] text-red-600 font-medium flex items-start gap-1">
                                        <AlertCircle className="w-3 h-3 flex-shrink-0 mt-px" /> Format: GHA-123456789-0
                                    </p>
                                ) : (
                                    <p className="text-[10px] text-muted-foreground/60 flex items-start gap-1">
                                        <ShieldCheck className="w-3 h-3 flex-shrink-0 mt-px text-emerald-500" />
                                        Required to submit. For your privacy only the last 4 digits are stored (shown as GHA-*****1234).
                                    </p>
                                )}
                                {profile?.ghana_card_number_masked && (
                                    <p className="text-[10px] text-muted-foreground">On file: <span className="font-mono">{profile.ghana_card_number_masked}</span></p>
                                )}
                            </div>

                            {/* Applicant WhatsApp number */}
                            <div className="space-y-1">
                                <label htmlFor="biz-whatsapp" className="text-xs font-semibold text-muted-foreground">
                                    Your WhatsApp number <span className="text-red-500">*</span>
                                </label>
                                <Input
                                    id="biz-whatsapp"
                                    value={contactWhatsapp}
                                    onChange={e => setContactWhatsapp(e.target.value.replace(/[^\d]/g, '').slice(0, 12))}
                                    placeholder="e.g. 233244123456"
                                    maxLength={12}
                                    inputMode="numeric"
                                    autoComplete="tel"
                                    className="h-11 font-mono text-sm"
                                />
                                <p className="text-[10px] text-muted-foreground/60">
                                    We may reach out here if we need anything else during review.
                                </p>
                            </div>

                            {/* ── WhatsApp document submission ── */}
                            <WhatsAppDocsCta whatsappAdminNumber={whatsappAdminNumber} />

                            {/* Non-409 save/submit failure — exact server message, always visible
                                (not just a toast) so "it doesn't go through" is never mysterious. */}
                            {submitError && (
                                <div className="flex items-start gap-2.5 px-3.5 py-3 rounded-xl bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900">
                                    <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                                    <p className="text-xs text-red-700 dark:text-red-400">{submitError}</p>
                                </div>
                            )}

                            {/* Actions */}
                            <div className="flex flex-col sm:flex-row gap-2 pt-1">
                                <Button
                                    variant="outline"
                                    onClick={() => doSave('save')}
                                    disabled={!canSaveDraft}
                                    className="h-11 flex-1 gap-2 font-semibold"
                                >
                                    {saving === 'save' ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
                                    {saving === 'save' ? 'Saving…' : 'Save draft'}
                                </Button>
                                <Button
                                    onClick={handleSubmitClick}
                                    disabled={!canSubmit}
                                    className="h-11 flex-1 gap-2 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold"
                                >
                                    {saving === 'submit' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                                    {saving === 'submit' ? 'Submitting…' : 'Submit for review'}
                                </Button>
                            </div>
                            {!canSubmit && !saving && (
                                <p className="text-[10px] text-muted-foreground/70 flex items-start gap-1">
                                    <Info className="w-3 h-3 flex-shrink-0 mt-px" />
                                    Submit needs a valid business name, a description of at least 10 characters, your website domain, a valid Ghana Card number, and your WhatsApp number.
                                </p>
                            )}
                        </CardContent>
                    </Card>
                </motion.div>
            )}

            {/* ══ IN REVIEW ══ */}
            {status === 'under_review' && (
                <motion.div {...fadeUp} transition={{ duration: 0.3, delay: 0.05 }} className="space-y-3">
                    <div className="flex items-start gap-2.5 px-4 py-3 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
                        <Hourglass className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                        <div className="text-xs text-amber-800 dark:text-amber-300">
                            <p className="font-bold">Your business profile is in review</p>
                            <p className="mt-0.5">Our team is verifying your details. Your profile is locked until the review completes — we will notify you.</p>
                        </div>
                    </div>
                    <WhatsAppDocsCta whatsappAdminNumber={whatsappAdminNumber} />
                </motion.div>
            )}

            {/* ══ APPROVED — celebrate ══ */}
            {status === 'approved' && (
                <motion.div {...fadeUp} transition={{ duration: 0.3, delay: 0.05 }}>
                    <Card className="rounded-2xl border-0 overflow-hidden bg-gradient-to-br from-emerald-600 via-emerald-600 to-teal-700 text-white shadow-lg">
                        <CardContent className="p-5 sm:p-6 relative">
                            <div className="pointer-events-none absolute -top-14 -right-14 w-44 h-44 rounded-full bg-white/10 blur-2xl" />
                            <div className="relative flex items-start gap-3">
                                <div className="w-11 h-11 rounded-2xl bg-white/15 backdrop-blur-sm flex items-center justify-center shrink-0">
                                    <PartyPopper className="w-5 h-5" />
                                </div>
                                <div className="min-w-0">
                                    <h3 className="text-lg font-bold flex items-center gap-2 flex-wrap">
                                        {isBusinessMode ? 'Business Mode active' : 'Business profile approved'}
                                        <BadgeCheck className="w-5 h-5 text-emerald-200" />
                                    </h3>
                                    <p className="text-sm text-emerald-50/90 mt-1">
                                        <strong>{profile?.business_name}</strong> is verified.
                                        {isBusinessMode
                                            ? ' You now enjoy higher sending limits, any links in your messages and relaxed content filtering — fraud is still blocked.'
                                            : ' Business Mode is being activated on your account — higher limits and relaxed filtering are moments away.'}
                                    </p>
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                </motion.div>
            )}

            {/* ══ Locked profile summary (under_review / approved) ══ */}
            {profileSubmitted && profile && (
                <motion.div {...fadeUp} transition={{ duration: 0.3, delay: 0.1 }}>
                    <Card className="rounded-2xl">
                        <CardContent className="p-4 sm:p-5 space-y-3">
                            <div className="flex items-center justify-between">
                                <h3 className="text-sm font-semibold flex items-center gap-1.5">
                                    <Building2 className="w-4 h-4 text-emerald-500" /> Registered business
                                </h3>
                                <span className={cn(
                                    'inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full',
                                    status === 'approved'
                                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                                        : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
                                )}>
                                    {status === 'approved' ? <BadgeCheck className="w-3 h-3" /> : <Lock className="w-3 h-3" />}
                                    {status === 'approved' ? 'Approved' : 'In review'}
                                </span>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2.5 text-sm">
                                <div>
                                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">Business name</p>
                                    <p className="font-semibold mt-0.5">{profile.business_name}</p>
                                </div>
                                <div>
                                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">Domain</p>
                                    <p className="font-medium mt-0.5 flex items-center gap-1.5 break-all">
                                        <Globe className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                                        {profile.domain_link ? `https://${profile.domain_link}` : '—'}
                                    </p>
                                </div>
                                <div className="sm:col-span-2">
                                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">Description</p>
                                    <p className="text-xs text-muted-foreground mt-0.5 line-clamp-3 whitespace-pre-wrap">{profile.description}</p>
                                </div>
                                <div>
                                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">Ghana Card</p>
                                    <p className="font-mono text-xs mt-0.5">{profile.ghana_card_number_masked || 'Not provided'}</p>
                                </div>
                                <div>
                                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">Your WhatsApp</p>
                                    <p className="font-mono text-xs mt-0.5">{profile.contact_whatsapp_number || 'Not provided'}</p>
                                </div>
                            </div>

                            {status === 'approved' ? (
                                <div id="kyc-docs" className="flex items-start gap-2 text-[11px] text-muted-foreground bg-muted/40 border rounded-xl p-3">
                                    <MessageSquare className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0 mt-0.5" />
                                    <span>Documents are verified over WhatsApp — our team will reach out if anything else is needed.</span>
                                </div>
                            ) : (
                                // Not yet approved (under_review): still able to send/resend
                                // documents. The IN REVIEW banner above already shows this
                                // CTA with id="kyc-docs" — give this one a distinct id so the
                                // page never carries two elements with the same id.
                                <WhatsAppDocsCta whatsappAdminNumber={whatsappAdminNumber} id="kyc-docs-summary" />
                            )}
                        </CardContent>
                    </Card>
                </motion.div>
            )}

            {/* ══ SENDING IDENTITY ══ */}
            {/* Feature-wave5 Task 3: shown whenever the account exists — no longer
                gated behind a submitted/approved business profile. ANY active KFT
                SMS account (platform or business) can request its own Sender ID;
                only the Ghana Card KYC doc (see the amber notice below) is required. */}
            <motion.div {...fadeUp} transition={{ duration: 0.3, delay: 0.15 }} className="space-y-4">

                    {/* Sending identity — business accounts pick which name sends go out under */}
                    {isBusinessMode && (
                        <Card className="rounded-2xl border-emerald-200 dark:border-emerald-900">
                            <CardContent className="p-4 sm:p-5 space-y-3">
                                <div>
                                    <h3 className="text-sm font-semibold flex items-center gap-1.5">
                                        <MessageSquare className="w-4 h-4 text-emerald-500" /> Sending identity
                                    </h3>
                                    <p className="text-xs text-muted-foreground mt-0.5">
                                        The name every message goes out under. Pick one of your approved Sender IDs or a platform pool ID — change it anytime.
                                    </p>
                                </div>

                                <div className="space-y-2">
                                    {[
                                        ...approvedSenders.map(s => ({ name: s.sender_text, source: 'Your brand' as const })),
                                        ...poolSenders
                                            .filter(p => !approvedSenders.some(s => s.sender_text.toLowerCase() === p.toLowerCase()))
                                            .map(p => ({ name: p, source: 'Platform pool' as const })),
                                    ].map(opt => {
                                        const selected = (account.default_sender || '').toLowerCase() === opt.name.toLowerCase()
                                        const busy = patchingSender === opt.name
                                        return (
                                            <button
                                                key={`${opt.source}-${opt.name}`}
                                                type="button"
                                                onClick={() => !selected && !patchingSender && chooseSender(opt.name)}
                                                disabled={!!patchingSender}
                                                className={cn(
                                                    'w-full flex items-center justify-between gap-3 px-3.5 py-3 rounded-xl border text-left transition-colors min-h-[52px]',
                                                    selected
                                                        ? 'border-emerald-400 dark:border-emerald-700 bg-emerald-50/60 dark:bg-emerald-900/15 ring-1 ring-emerald-200 dark:ring-emerald-900'
                                                        : 'hover:border-emerald-200 dark:hover:border-emerald-900 hover:bg-muted/30',
                                                )}
                                            >
                                                <span className="flex items-center gap-2.5 min-w-0">
                                                    <span className={cn(
                                                        'w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0',
                                                        selected ? 'border-emerald-500 bg-emerald-500' : 'border-muted-foreground/30',
                                                    )}>
                                                        {selected && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
                                                    </span>
                                                    <span className="font-mono text-sm font-bold truncate">{opt.name}</span>
                                                </span>
                                                <span className="flex items-center gap-2 shrink-0">
                                                    {busy && <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-600" />}
                                                    <span className={cn(
                                                        'text-[10px] font-semibold px-2 py-0.5 rounded-full',
                                                        opt.source === 'Your brand'
                                                            ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                                                            : 'bg-muted text-muted-foreground',
                                                    )}>
                                                        {opt.source}
                                                    </span>
                                                </span>
                                            </button>
                                        )
                                    })}
                                    {approvedSenders.length === 0 && poolSenders.length === 0 && (
                                        <p className="text-xs text-muted-foreground text-center py-4">
                                            No sender IDs available yet — request your own below.
                                        </p>
                                    )}
                                </div>
                            </CardContent>
                        </Card>
                    )}

                    {/* Own Sender IDs — a user may hold several (up to 200) */}
                    <Card className="rounded-2xl">
                        <CardContent className="p-4 sm:p-5 space-y-4">
                            <div>
                                <h3 className="text-sm font-semibold flex items-center gap-1.5">
                                    <Radio className="w-4 h-4 text-emerald-500" /> Your Sender IDs
                                </h3>
                                <p className="text-xs text-muted-foreground mt-0.5">
                                    Register your own brand name to send under. Add up to {MAX_SENDERS} — each is reviewed by our team, then registered with the network.
                                    {!isBusinessMode && ' Platform Mode accounts can request one KYC-free — no documents needed. Once approved, pick it from the sender dropdown in Compose, or enable it as your order-confirmation sender from KFT SMS settings.'}
                                </p>
                            </div>

                            {/* Existing sender IDs with status timeline */}
                            {senders.length > 0 && (
                                <div className="space-y-2">
                                    <p className="text-[11px] font-semibold text-muted-foreground">
                                        Requested ({liveSenderCount}/{MAX_SENDERS})
                                    </p>
                                    {senders.map((s, i) => {
                                        const inUse = s.status === 'approved'
                                            && (account.default_sender || '').toLowerCase() === s.sender_text.toLowerCase()
                                        return (
                                            <div key={s.id ?? `${s.sender_text}-${i}`} className="rounded-xl border p-3.5 space-y-2">
                                                <div className="flex items-center justify-between gap-2">
                                                    <p className="font-mono text-sm font-bold">{s.sender_text}</p>
                                                    {inUse && (
                                                        <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                                                            <Check className="w-2.5 h-2.5" /> In use
                                                        </span>
                                                    )}
                                                </div>
                                                <SenderTimeline status={s.status} reason={s.rejection_reason} />
                                            </div>
                                        )
                                    })}
                                </div>
                            )}

                            {/* Request another — stays open until the max-10 cap is hit */}
                            {maxSendersReached ? (
                                <div className="flex items-start gap-2 text-xs text-muted-foreground bg-muted/40 border rounded-xl p-3">
                                    <BadgeCheck className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-emerald-500" />
                                    <span>You&apos;ve reached the maximum of {MAX_SENDERS} sender IDs. Ask support to revoke one to free up a slot.</span>
                                </div>
                            ) : (
                                <div className="space-y-2.5">
                                    {isBusinessMode && !ghanaCardAttached && (
                                        <div className="flex items-start gap-2 text-xs text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl p-3">
                                            <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                                            <span>
                                                A <strong>Ghana Card document</strong> is required for sender ID approval —{' '}
                                                <a href="#kyc-docs" className="underline font-semibold">check your documents section</a>.
                                                {!editable && ' If it is missing from your submitted profile, contact support.'}
                                            </span>
                                        </div>
                                    )}
                                    {!isBusinessMode && (
                                        <div className="flex items-start gap-2 text-xs text-emerald-800 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 rounded-xl p-3">
                                            <ShieldCheck className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                                            <span>Request a sender ID for your platform messages — no documents needed.</span>
                                        </div>
                                    )}

                                    <div className="space-y-1">
                                        <label htmlFor="sender-text" className="text-xs font-semibold text-muted-foreground">
                                            {senders.length > 0 ? 'Request another sender name' : 'Requested sender name'}
                                        </label>
                                        <div className="flex gap-2">
                                            <div className="relative flex-1">
                                                <Input
                                                    id="sender-text"
                                                    value={senderText}
                                                    onChange={e => {
                                                        setSenderError(null)
                                                        setSenderText(e.target.value.replace(/[^A-Za-z0-9 ]/g, '').slice(0, 11))
                                                    }}
                                                    placeholder="e.g. FLEXYHUB"
                                                    maxLength={11}
                                                    autoComplete="off"
                                                    className="h-11 font-mono text-sm pr-12"
                                                />
                                                <span className={cn(
                                                    'absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-bold tabular-nums',
                                                    senderText.length === 11 ? 'text-amber-600' : 'text-muted-foreground/60',
                                                )}>
                                                    {senderText.length}/11
                                                </span>
                                            </div>
                                            <Button
                                                onClick={handleRequestSender}
                                                disabled={
                                                    requestingSender
                                                    || (isBusinessMode && !ghanaCardAttached)
                                                    || senderText.trim().length < 3
                                                    || !(senderValidation?.ok)
                                                }
                                                className="h-11 gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold shrink-0"
                                            >
                                                {requestingSender ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                                                Request
                                            </Button>
                                        </div>
                                        {senderValidation && !senderValidation.ok ? (
                                            <p className="text-[11px] text-red-600 font-medium flex items-start gap-1">
                                                <AlertCircle className="w-3 h-3 flex-shrink-0 mt-px" /> {senderValidation.error}
                                            </p>
                                        ) : senderText.trim().length > 0 && senderText.trim().length < 3 ? (
                                            // Disabled-reason: too short to validate yet — say exactly how many more
                                            // characters are needed instead of leaving the button silently disabled.
                                            <p className="text-[11px] text-amber-600 font-medium flex items-start gap-1">
                                                <AlertCircle className="w-3 h-3 flex-shrink-0 mt-px" /> Enter at least 3 characters — {3 - senderText.trim().length} more needed.
                                            </p>
                                        ) : (
                                            <p className="text-[10px] text-muted-foreground/70">
                                                3–11 characters · letters, numbers and spaces · must include a letter · protected brand names (MTN, MoMo, banks…) are not allowed.
                                            </p>
                                        )}
                                        {senderError && (
                                            <p className="text-[11px] text-red-600 font-medium flex items-start gap-1">
                                                <AlertCircle className="w-3 h-3 flex-shrink-0 mt-px" /> {senderError}
                                            </p>
                                        )}
                                    </div>
                                </div>
                            )}
                        </CardContent>
                    </Card>
            </motion.div>

            {/* ── Modes comparison ── */}
            <motion.div {...fadeUp} transition={{ duration: 0.3, delay: 0.2 }}>
                <Card className="rounded-2xl">
                    <CardContent className="p-4 sm:p-5">
                        <h3 className="text-sm font-semibold flex items-center gap-1.5 mb-3">
                            <Info className="w-4 h-4 text-emerald-500" /> Platform vs Business mode
                        </h3>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                            <div className={cn(
                                'rounded-xl border p-3.5 space-y-1.5',
                                !isBusinessMode && 'border-emerald-300 dark:border-emerald-800 bg-emerald-50/30 dark:bg-emerald-900/10',
                            )}>
                                <p className="text-xs font-bold flex items-center gap-1.5">
                                    <Sparkles className="w-3.5 h-3.5 text-emerald-500" /> Platform mode
                                    {!isBusinessMode && <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">Current</span>}
                                </p>
                                <ul className="text-[11px] text-muted-foreground space-y-1">
                                    <li className="flex gap-1.5"><Check className="w-3 h-3 text-emerald-500 flex-shrink-0 mt-0.5" /> Send instantly, no paperwork</li>
                                    <li className="flex gap-1.5"><Check className="w-3 h-3 text-emerald-500 flex-shrink-0 mt-0.5" /> KINGFLEXY pool sender ID</li>
                                    <li className="flex gap-1.5"><Check className="w-3 h-3 text-emerald-500 flex-shrink-0 mt-0.5" /> kingflexygh links only</li>
                                    <li className="flex gap-1.5"><ShieldCheck className="w-3 h-3 text-emerald-500 flex-shrink-0 mt-0.5" /> Standard content filtering</li>
                                </ul>
                            </div>
                            <div className={cn(
                                'rounded-xl border p-3.5 space-y-1.5',
                                isBusinessMode && 'border-emerald-300 dark:border-emerald-800 bg-emerald-50/30 dark:bg-emerald-900/10',
                            )}>
                                <p className="text-xs font-bold flex items-center gap-1.5">
                                    <Building2 className="w-3.5 h-3.5 text-emerald-500" /> Business mode
                                    {isBusinessMode && <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">Current</span>}
                                </p>
                                <ul className="text-[11px] text-muted-foreground space-y-1">
                                    <li className="flex gap-1.5"><Check className="w-3 h-3 text-emerald-500 flex-shrink-0 mt-0.5" /> Your own brand Sender ID</li>
                                    <li className="flex gap-1.5"><Check className="w-3 h-3 text-emerald-500 flex-shrink-0 mt-0.5" /> Any links in your messages</li>
                                    <li className="flex gap-1.5"><Check className="w-3 h-3 text-emerald-500 flex-shrink-0 mt-0.5" /> Relaxed content filtering + higher limits</li>
                                    <li className="flex gap-1.5"><ShieldAlert className="w-3 h-3 text-amber-500 flex-shrink-0 mt-0.5" /> Fraud and scam content is still blocked</li>
                                </ul>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            </motion.div>

            {/* ── Submit confirm (explicit-choice dialog, never native confirm) ── */}
            <Dialog open={submitConfirm} onOpenChange={open => { if (!saving) setSubmitConfirm(open) }}>
                <DialogContent className="max-w-sm" aria-describedby={undefined} hideCloseButton>
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <Send className="w-4 h-4 text-emerald-600" /> Submit for review?
                        </DialogTitle>
                    </DialogHeader>
                    <div className="space-y-3">
                        <p className="text-sm text-muted-foreground">
                            Your business profile will be <strong className="text-foreground">locked</strong> while our team reviews it.
                            Don't forget to send your Ghana Card and business documents to us on WhatsApp.
                        </p>
                        <div className="rounded-xl bg-muted/40 p-3.5 space-y-1.5 text-xs">
                            <p className="flex justify-between gap-3">
                                <span className="text-muted-foreground">Business</span>
                                <span className="font-semibold text-right truncate">{businessName.trim() || '—'}</span>
                            </p>
                            <p className="flex justify-between gap-3">
                                <span className="text-muted-foreground">Domain</span>
                                <span className="font-mono text-right truncate">https://{domain.trim() || '—'}</span>
                            </p>
                            <p className="flex justify-between gap-3">
                                <span className="text-muted-foreground">Ghana Card</span>
                                <span className="font-mono text-right truncate">
                                    {ghanaCardFormatOk ? maskGhanaCardForDisplay(ghanaCardNormalized) : 'Missing'}
                                </span>
                            </p>
                            <p className="flex justify-between gap-3">
                                <span className="text-muted-foreground">Your WhatsApp</span>
                                <span className="font-mono text-right truncate">{contactWhatsapp.trim() || '—'}</span>
                            </p>
                        </div>
                    </div>
                    <DialogFooter className="gap-2">
                        <Button variant="ghost" className="h-11" disabled={!!saving} onClick={() => setSubmitConfirm(false)}>
                            Cancel
                        </Button>
                        <Button
                            onClick={() => doSave('submit')}
                            disabled={!!saving}
                            className="h-11 bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5"
                        >
                            {saving === 'submit' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                            {saving === 'submit' ? 'Submitting…' : 'Submit for review'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

        </div>
    )
}
