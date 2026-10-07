// app/dashboard/recruit/page.tsx
// =============================================================================
// Plan 3, Task 8 — recruiter-facing "Sub-Agents" dashboard page (main dashboard,
// not the shop dashboard). Lets an agent/dealer create sub-agents, regenerate
// their access keys, and (Plan 4, Task 6) set default + per-sub-agent pricing.
//
// Consumes (Tasks 4-5, see lib/sub-agent-create.ts / lib/sub-agent-regenerate.ts
// and the routes wrapping them):
//   GET  /api/dashboard/subagents                    -> { success, subAgents, cap, used, remaining }
//   POST /api/dashboard/subagents                     -> { success, subAgent, deliveryStatus }
//   POST /api/dashboard/subagents/[id]/regenerate      -> { success, message }
//
// Pricing (Plan 4, Task 4-5) is wired via <SubagentPricingModal>, shared
// between the account-wide default and each sub-agent's override — see that
// component for the routes it talks to.
// =============================================================================
'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { formatDate, formatCurrency } from '@/lib/utils'
import { getAgentUrl } from '@/lib/site-url'
import { useAuth } from '@/contexts/auth-context'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import {
    Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog'
import {
    Loader2, Users, UserPlus, ShieldAlert, RotateCw, Mail,
    Phone as PhoneIcon, Plus, Tag, ChevronDown, ChevronUp,
} from 'lucide-react'
import { toast } from '@/lib/toast'
import { SubagentPricingModal, type PricingModalTarget } from '@/components/dashboard/subagent-pricing-modal'

interface SubAgentRow {
    id: string
    name: string
    email: string
    phone: string
    status: string
    created_at: string
}

interface SubAgentActivity {
    totalOrders: number
    completedOrders: number
    totalSpent: number
    hasShop: boolean
    shopName: string | null
    status: string | null
    created_at: string | null
}

// final-review Minor (2026-09-14): the live sub_agents.status CHECK constraint
// (20260701_sub_agents.sql) only allows 'pending'|'active'|'suspended' — there
// is no 'revoked' status today. This mapping is forward-compatible-only (in
// case a future status value is added) and harmless as-is: any status not
// listed here (including 'revoked' right now) falls back to the 'outline'
// badge below, never crashes or renders incorrectly.
const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'destructive' | 'outline'> = {
    active: 'success',
    suspended: 'warning',
    revoked: 'destructive',
}

export default function RecruitPage() {
    const { dbUser, isAdmin, isLoading: authLoading } = useAuth()
    const isEligible = isAdmin || dbUser?.role === 'agent' || dbUser?.role === 'dealer'

    const [subAgents, setSubAgents] = useState<SubAgentRow[]>([])
    const [loading, setLoading] = useState(true)
    const [loadError, setLoadError] = useState(false)
    const [capUsage, setCapUsage] = useState({ cap: 0, used: 0, remaining: 0 })

    // Recruit form — button-gated (spec C7): the form itself is unchanged,
    // only whether it's visible. Single phone/email entry (no confirm-typing
    // duplicates) — replaced by a review-and-confirm modal before submit,
    // matching the regenerate flow's own "show the target, then confirm"
    // pattern below, rather than making the recruiter type each value twice.
    const [showCreateForm, setShowCreateForm] = useState(false)
    const [name, setName] = useState('')
    const [email, setEmail] = useState('')
    const [phone, setPhone] = useState('')
    const [creating, setCreating] = useState(false)

    // Review-and-confirm modal shown before the actual create call. The
    // checkbox is a deliberate, explicit acknowledgement of two things at
    // once: the entered details are correct (this is the ONLY point where a
    // typo in phone/email can still be caught — the account is created with
    // exactly what's confirmed here) and that sub-agents can't be deleted
    // afterward (see the "can't be deleted" copy in the form below).
    const [showRecruitConfirm, setShowRecruitConfirm] = useState(false)
    const [recruitConfirmChecked, setRecruitConfirmChecked] = useState(false)

    // Credential-sent confirmation — shown after a successful create. The
    // plaintext access key is never sent to this page (Task 3 removed it from
    // the create response entirely); it's delivered straight to the new
    // sub-agent's own phone/email, so all we can show here is delivery status.
    const [createdConfirmation, setCreatedConfirmation] = useState<{
        name: string
        deliveryStatus: { smsDelivered: boolean; emailDelivered: boolean }
    } | null>(null)

    // Regenerate confirmation
    const [regenerateTarget, setRegenerateTarget] = useState<SubAgentRow | null>(null)
    const [regenerating, setRegenerating] = useState(false)

    // Pricing modal (Plan 4, Task 5) — shared between the account-wide default
    // and any single sub-agent's override, selected by `target`.
    const [pricingTarget, setPricingTarget] = useState<PricingModalTarget | null>(null)

    // Expandable per-row activity panel (Task 10) — safe summary only (order
    // counts, shop existence, status). Cached per sub-agent id in state so
    // re-expanding a row doesn't re-fetch. Wallet balance, suspension fields,
    // and raw transactions are deliberately never fetched here — admin-only.
    const [expandedId, setExpandedId] = useState<string | null>(null)
    const [activityById, setActivityById] = useState<Record<string, SubAgentActivity>>({})
    const [activityLoadingId, setActivityLoadingId] = useState<string | null>(null)
    const [activityErrorId, setActivityErrorId] = useState<string | null>(null)

    const agentLoginDomain = getAgentUrl().replace(/^https?:\/\//, '')

    const fetchSubAgents = useCallback(async () => {
        setLoading(true)
        setLoadError(false)
        try {
            const res = await fetch('/api/dashboard/subagents')
            const data = await res.json()
            if (data.success) {
                setSubAgents(data.subAgents || [])
                setCapUsage({
                    cap: data.cap ?? 0,
                    used: data.used ?? 0,
                    remaining: data.remaining ?? 0,
                })
            } else {
                setLoadError(true)
            }
        } catch {
            setLoadError(true)
        } finally {
            setLoading(false)
        }
    }, [])

    // Don't fire the sub-agents fetch until auth has resolved and we know the
    // caller's role is eligible — an ineligible role (customer, sub-agent, no
    // role) gets the gate UI below instead, and never hits the API.
    useEffect(() => {
        if (authLoading || !isEligible) return
        fetchSubAgents()
    }, [authLoading, isEligible, fetchSubAgents])

    const canSubmit = name.trim().length > 0 && email.trim().length > 0 && phone.trim().length > 0 && !creating

    // Opens the review modal — the actual create call only happens from
    // there, after the checkbox is ticked (handleCreate below).
    const openRecruitConfirm = () => {
        if (!canSubmit) return
        setRecruitConfirmChecked(false)
        setShowRecruitConfirm(true)
    }

    const handleCreate = async () => {
        if (!canSubmit || !recruitConfirmChecked) return

        setCreating(true)
        try {
            const res = await fetch('/api/dashboard/subagents', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: name.trim(), email: email.trim(), phone: phone.trim() }),
            })
            const data = await res.json()
            if (data.success) {
                setCreatedConfirmation({
                    name: data.subAgent?.name || name.trim(),
                    deliveryStatus: data.deliveryStatus || { smsDelivered: false, emailDelivered: false },
                })
                setName('')
                setEmail('')
                setPhone('')
                setShowRecruitConfirm(false)
                setRecruitConfirmChecked(false)
                setShowCreateForm(false)
                fetchSubAgents()
            } else {
                // Back to the form (not left stuck in the confirm modal) so a
                // fixable error — e.g. "An account with this email already
                // exists" — can actually be corrected.
                setShowRecruitConfirm(false)
                setRecruitConfirmChecked(false)
                toast.error(data.error || 'Could not create sub-agent')
            }
        } catch {
            setShowRecruitConfirm(false)
            setRecruitConfirmChecked(false)
            toast.error('Could not create sub-agent')
        } finally {
            setCreating(false)
        }
    }

    const handleRegenerate = async () => {
        if (!regenerateTarget) return
        setRegenerating(true)
        try {
            const res = await fetch(`/api/dashboard/subagents/${regenerateTarget.id}/regenerate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            })
            const data = await res.json()
            if (data.success) {
                toast.success(data.message || 'A new access key is on its way to this sub-agent')
                setRegenerateTarget(null)
            } else {
                toast.error(data.error || 'Could not regenerate access key')
            }
        } catch {
            toast.error('Could not regenerate access key')
        } finally {
            setRegenerating(false)
        }
    }

    // Actual fetch, factored out of the expand/collapse toggle so the Retry
    // button (shown in the error state, when the row is already expanded)
    // can trigger a real re-fetch instead of hitting the collapse branch
    // below. Only a genuine prior success is cached — a prior error never
    // populates activityById, so this always re-fetches on retry.
    const fetchActivity = async (subId: string) => {
        setActivityErrorId(null)
        setActivityLoadingId(subId)
        try {
            const res = await fetch(`/api/dashboard/subagents/${subId}/activity`)
            const data = await res.json()
            if (data.success) {
                setActivityById((prev) => ({ ...prev, [subId]: data.activity }))
            } else {
                setActivityErrorId(subId)
            }
        } catch {
            setActivityErrorId(subId)
        } finally {
            setActivityLoadingId(null)
        }
    }

    const toggleActivity = (subId: string) => {
        if (expandedId === subId) {
            setExpandedId(null)
            return
        }
        setExpandedId(subId)
        if (activityById[subId]) return // already cached from a genuine prior success — no re-fetch
        fetchActivity(subId)
    }

    // Role gate: this page is only for admin/agent/dealer (mirrors the sidebar's
    // nav-item gate). A customer or other ineligible role who lands here — e.g.
    // via the landing page's "Sub-Agent Program" card/nav link — gets a clear
    // upgrade prompt instead of an empty or broken sub-agents list.
    if (!authLoading && !isEligible) {
        return (
            <div className="space-y-4 max-w-4xl mx-auto">
                <Card>
                    <CardContent className="p-6 sm:p-8 flex flex-col items-center text-center gap-3">
                        <div className="w-12 h-12 rounded-full bg-amber-100 dark:bg-amber-900/20 flex items-center justify-center">
                            <ShieldAlert className="w-6 h-6 text-amber-600 dark:text-amber-500" />
                        </div>
                        <div className="space-y-1">
                            <h1 className="text-lg font-bold">Sub-Agent Program</h1>
                            <p className="text-sm text-muted-foreground max-w-sm">
                                Recruiting sub-agents is part of our Sub-Agent Program, available to agents and dealers.
                                Upgrade your role to start building your own team.
                            </p>
                        </div>
                        <Button asChild className="gap-2 mt-1">
                            <Link href="/dashboard/upgrade">
                                <UserPlus className="w-4 h-4" />
                                Upgrade to unlock
                            </Link>
                        </Button>
                    </CardContent>
                </Card>
            </div>
        )
    }

    return (
        <div className="space-y-4 max-w-4xl mx-auto">
            <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                    <h1 className="text-lg sm:text-xl font-bold flex items-center gap-2">
                        <Users className="w-5 h-5 text-emerald-600" />
                        Sub-Agents
                    </h1>
                    <p className="text-muted-foreground text-xs sm:text-sm">
                        Bring on sub-agents who sell under your account. You hand each one an access key —
                        it&apos;s how they sign in.
                    </p>
                    <p className="text-sm text-muted-foreground">
                        {capUsage.used} of {capUsage.cap} sub-agents recruited — {capUsage.remaining} remaining.
                        Your sub-agents log in at {agentLoginDomain}.
                    </p>
                </div>
                <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5 shrink-0"
                    onClick={() => setPricingTarget({ type: 'default' })}
                >
                    <Tag className="w-3.5 h-3.5" />
                    Default Pricing
                </Button>
            </div>

            {/* Recruit a sub-agent — button-gated (spec C7) */}
            {!showCreateForm ? (
                <Button onClick={() => setShowCreateForm(true)} className="gap-2">
                    <Plus className="w-4 h-4" />
                    Add sub-agent
                </Button>
            ) : (
                <Card>
                    <CardHeader className="p-4 pb-0">
                        <CardTitle className="text-sm flex items-center gap-2">
                            <UserPlus className="w-4 h-4 text-emerald-600" />
                            Recruit a sub-agent
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="p-4 space-y-3">
                        <div className="grid gap-3 sm:grid-cols-2">
                            <div className="space-y-1">
                                <Label htmlFor="recruit-name" className="text-xs">Full name</Label>
                                <Input
                                    id="recruit-name"
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    placeholder="e.g. Ama Boateng"
                                    disabled={creating}
                                />
                            </div>
                            <div className="space-y-1">
                                <Label htmlFor="recruit-phone" className="text-xs">Phone number</Label>
                                <Input
                                    id="recruit-phone"
                                    value={phone}
                                    onChange={(e) => setPhone(e.target.value)}
                                    placeholder="e.g. 024 123 4567"
                                    disabled={creating}
                                />
                            </div>
                            <div className="space-y-1 sm:col-span-2">
                                <Label htmlFor="recruit-email" className="text-xs">Email address</Label>
                                <Input
                                    id="recruit-email"
                                    type="email"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    placeholder="e.g. ama@gmail.com"
                                    disabled={creating}
                                />
                            </div>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            We&apos;ll send their access key straight to their phone and email the moment you recruit them.
                        </p>
                        <p className="text-xs text-muted-foreground">
                            Once added, a sub-agent can&apos;t be deleted — you can suspend or regenerate their access key instead.
                        </p>
                        <div className="flex items-center gap-2">
                            <Button onClick={openRecruitConfirm} disabled={!canSubmit} className="gap-2">
                                <UserPlus className="w-4 h-4" />
                                Recruit sub-agent
                            </Button>
                            <Button variant="ghost" onClick={() => setShowCreateForm(false)} disabled={creating}>
                                Cancel
                            </Button>
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* Downline list */}
            <Card>
                <CardHeader className="p-4 pb-0">
                    <CardTitle className="text-sm">Your sub-agents</CardTitle>
                </CardHeader>
                <CardContent className="p-4 space-y-1.5">
                    {loading ? (
                        <div className="flex justify-center py-8">
                            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                        </div>
                    ) : loadError ? (
                        <div className="text-center py-8 space-y-3">
                            <p className="text-sm text-muted-foreground">Couldn&apos;t load your sub-agents.</p>
                            <Button variant="outline" size="sm" onClick={fetchSubAgents}>Retry</Button>
                        </div>
                    ) : subAgents.length === 0 ? (
                        <div className="text-center py-8">
                            <p className="text-sm text-muted-foreground">
                                You haven&apos;t recruited anyone yet. Use "Add sub-agent" above to bring on your first one.
                            </p>
                        </div>
                    ) : (
                        subAgents.map((sub) => {
                            const activity = activityById[sub.id]
                            const isExpanded = expandedId === sub.id
                            const isActivityLoading = activityLoadingId === sub.id
                            const hasActivityError = activityErrorId === sub.id && !activity
                            return (
                                <div key={sub.id} className="rounded-lg border p-2">
                                    {/* Stacks on mobile — three labeled buttons never fit beside
                                        the info column at phone widths, and forcing them onto one
                                        row squeezed the name/email/date text into a sliver, wrapping
                                        it one word per line (found 2026-09-29). */}
                                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                        <div className="min-w-0">
                                            <div className="flex items-center gap-1.5 flex-wrap">
                                                <p className="text-sm font-medium truncate">{sub.name || sub.email}</p>
                                                <Badge variant={STATUS_VARIANT[sub.status] || 'outline'} className="text-[10px] capitalize">
                                                    {sub.status}
                                                </Badge>
                                            </div>
                                            <p className="text-xs text-muted-foreground truncate">{sub.email}</p>
                                            <p className="text-[11px] text-muted-foreground">Recruited {formatDate(sub.created_at)}</p>
                                        </div>
                                        <div className="flex items-center gap-1.5 flex-wrap sm:flex-nowrap sm:shrink-0">
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                className="gap-1 px-2 text-xs"
                                                onClick={() => setPricingTarget({ type: 'sub', subId: sub.id, subName: sub.name || sub.email })}
                                            >
                                                <Tag className="w-3.5 h-3.5" />
                                                <span>Pricing</span>
                                            </Button>
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                className="gap-1 px-2 text-xs"
                                                onClick={() => setRegenerateTarget(sub)}
                                            >
                                                <RotateCw className="w-3.5 h-3.5" />
                                                <span>Regenerate key</span>
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                className="gap-1 px-2 text-xs"
                                                onClick={() => toggleActivity(sub.id)}
                                            >
                                                {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                                                <span>Activity</span>
                                            </Button>
                                        </div>
                                    </div>

                                    {isExpanded && (
                                        isActivityLoading ? (
                                            <div className="flex justify-center py-3 border-t mt-2 pt-2">
                                                <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                                            </div>
                                        ) : hasActivityError ? (
                                            <div className="flex items-center justify-between border-t mt-2 pt-2">
                                                <p className="text-xs text-muted-foreground">Couldn&apos;t load activity.</p>
                                                <Button variant="outline" size="sm" className="text-xs" onClick={() => fetchActivity(sub.id)}>
                                                    Retry
                                                </Button>
                                            </div>
                                        ) : activity ? (
                                            <div className="mt-2 grid grid-cols-2 gap-2 text-sm text-muted-foreground border-t pt-2">
                                                <span>Total orders: {activity.totalOrders}</span>
                                                <span>Completed: {activity.completedOrders}</span>
                                                <span>Total spent: {formatCurrency(activity.totalSpent)}</span>
                                                <span>Shop: {activity.hasShop ? activity.shopName : 'None'}</span>
                                            </div>
                                        ) : null
                                    )}
                                </div>
                            )
                        })
                    )}
                </CardContent>
            </Card>

            {/* Credential-sent confirmation — replaces the old key-reveal dialog.
                The plaintext access key never reaches this page (Task 3
                delivers it directly to the sub-agent via SMS + email), so this
                only reports whether that delivery succeeded on each channel. */}
            {createdConfirmation && (
                <Dialog open onOpenChange={() => setCreatedConfirmation(null)}>
                    <DialogContent className="sm:max-w-md">
                        <DialogHeader>
                            <DialogTitle>Sub-agent added</DialogTitle>
                        </DialogHeader>
                        <p className="text-sm text-muted-foreground">
                            {createdConfirmation.name}&apos;s login details have been sent to
                            {createdConfirmation.deliveryStatus.smsDelivered && createdConfirmation.deliveryStatus.emailDelivered
                                ? ' their phone and email.'
                                : createdConfirmation.deliveryStatus.smsDelivered
                                    ? ' their phone (email delivery failed — ask them to check their phone, or use Regenerate to retry).'
                                    : createdConfirmation.deliveryStatus.emailDelivered
                                        ? ' their email (SMS delivery failed — ask them to check their email, or use Regenerate to retry).'
                                        : ' — delivery failed on both channels. Use Regenerate to retry.'}
                        </p>
                        <DialogFooter>
                            <Button onClick={() => setCreatedConfirmation(null)}>Done</Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
            )}

            {/* Review-and-confirm before recruiting — same "show the target
                details, then confirm" shape as the regenerate dialog below,
                plus an explicit checkbox since this one creates a brand-new
                account rather than acting on an existing one. */}
            <Dialog
                open={showRecruitConfirm}
                onOpenChange={(open) => {
                    if (!open && !creating) {
                        setShowRecruitConfirm(false)
                        setRecruitConfirmChecked(false)
                    }
                }}
            >
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Confirm new sub-agent</DialogTitle>
                        <DialogDescription>
                            Double-check these details — their access key is sent straight to the phone and email below.
                        </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-2 text-sm">
                        <div className="flex items-center gap-2 text-muted-foreground">
                            <UserPlus className="w-3.5 h-3.5 shrink-0" />
                            <span>{name.trim() || 'Full name'}</span>
                        </div>
                        <div className="flex items-center gap-2 text-muted-foreground">
                            <PhoneIcon className="w-3.5 h-3.5 shrink-0" />
                            <span>{phone.trim() || 'Phone number'}</span>
                        </div>
                        <div className="flex items-center gap-2 text-muted-foreground">
                            <Mail className="w-3.5 h-3.5 shrink-0" />
                            <span>{email.trim() || 'Email address'}</span>
                        </div>
                    </div>

                    <div className="flex items-start gap-2 pt-2">
                        <Checkbox
                            id="recruit-confirm-checkbox"
                            checked={recruitConfirmChecked}
                            onCheckedChange={(checked) => setRecruitConfirmChecked(checked === true)}
                            disabled={creating}
                            className="mt-0.5"
                        />
                        <Label htmlFor="recruit-confirm-checkbox" className="text-xs font-normal leading-snug text-muted-foreground">
                            I understand I can&apos;t delete this user and confirm the entered details are correct.
                        </Label>
                    </div>

                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => { setShowRecruitConfirm(false); setRecruitConfirmChecked(false) }}
                            disabled={creating}
                        >
                            Cancel
                        </Button>
                        <Button onClick={handleCreate} disabled={!recruitConfirmChecked || creating} className="gap-2">
                            {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
                            Confirm &amp; recruit
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Regenerate confirmation */}
            <Dialog open={!!regenerateTarget} onOpenChange={(open) => { if (!open && !regenerating) setRegenerateTarget(null) }}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Regenerate access key?</DialogTitle>
                        <DialogDescription>
                            This replaces {regenerateTarget?.name || 'this sub-agent'}'s current access key. Their old key stops working once
                            the new one is used to sign in.
                        </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-2 text-sm">
                        <p className="text-muted-foreground">
                            The new key is sent straight to them — never shown on your screen:
                        </p>
                        <div className="flex items-center gap-2 text-muted-foreground">
                            <PhoneIcon className="w-3.5 h-3.5 shrink-0" />
                            <span>{regenerateTarget?.phone || 'Phone number on file'}</span>
                        </div>
                        <div className="flex items-center gap-2 text-muted-foreground">
                            <Mail className="w-3.5 h-3.5 shrink-0" />
                            <span>{regenerateTarget?.email || 'Email on file'}</span>
                        </div>
                    </div>

                    <DialogFooter>
                        <Button variant="outline" onClick={() => setRegenerateTarget(null)} disabled={regenerating}>
                            Cancel
                        </Button>
                        <Button onClick={handleRegenerate} disabled={regenerating} className="gap-2">
                            {regenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCw className="w-4 h-4" />}
                            Send new key
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Pricing modal — default (account-wide) or per-sub-agent override */}
            <SubagentPricingModal
                target={pricingTarget ?? { type: 'default' }}
                open={!!pricingTarget}
                onOpenChange={(open) => { if (!open) setPricingTarget(null) }}
            />
        </div>
    )
}
