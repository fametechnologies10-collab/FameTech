'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import {
    Key, Copy, Check, RefreshCw, AlertTriangle, Clock, CheckCircle2, XCircle,
    Eye, EyeOff, Percent, ShieldAlert, X, MessageCircle, Sparkles,
} from 'lucide-react'

export interface ApiKeyMeta {
    id: string
    prefix: string
    name: string
    status: 'pending' | 'active' | 'revoked'
    key_type: 'standard' | 'commission' | 'sms'
    last_used_at: string | null
    created_at: string
}

interface NewKeyResponse {
    success: boolean
    message: string
    api_key: {
        key: string
        prefix: string
        name: string
        status: string
        key_type: 'standard' | 'commission' | 'sms'
        created_at: string
    }
    warning?: string
}

const STATUS_CONFIG = {
    pending: {
        icon: Clock,
        color: 'text-amber-600 dark:text-amber-400',
        bg: 'bg-amber-50 dark:bg-amber-500/10',
        border: 'border-amber-200 dark:border-amber-500/30',
        dot: 'bg-amber-400',
        label: 'Pending Approval',
    },
    active: {
        icon: CheckCircle2,
        color: 'text-emerald-600 dark:text-emerald-400',
        bg: 'bg-emerald-50 dark:bg-emerald-500/10',
        border: 'border-emerald-200 dark:border-emerald-500/30',
        dot: 'bg-emerald-400',
        label: 'Active',
    },
    revoked: {
        icon: XCircle,
        color: 'text-red-600 dark:text-red-400',
        bg: 'bg-red-50 dark:bg-red-500/10',
        border: 'border-red-200 dark:border-red-500/30',
        dot: 'bg-red-400',
        label: 'Revoked',
    },
}

const KEY_TYPE_LABEL: Record<'standard' | 'commission' | 'sms', string> = {
    standard: 'Standard API Key',
    commission: 'Commission Services Key',
    sms: 'SMS API Key',
}
const KEY_TYPE_DEFAULT_NAME: Record<'standard' | 'commission' | 'sms', string> = {
    standard: 'My API Key',
    commission: 'Commission Services Key',
    sms: 'SMS API Key',
}
const KEY_TYPE_ICON: Record<'standard' | 'commission' | 'sms', any> = {
    standard: Key,
    commission: Percent,
    sms: MessageCircle,
}
const KEY_TYPE_BADGE: Record<'standard' | 'commission' | 'sms', string | null> = {
    standard: null,
    commission: 'Utilities',
    sms: 'Business',
}
const KEY_TYPE_EMPTY_COPY: Record<'standard' | 'commission' | 'sms', string> = {
    standard: 'Generate your first API key to start building integrations. Keys require admin approval before use.',
    commission: 'Generate a commission key to start earning on utility bill endpoints. No shop required — earnings go to your Commission Wallet.',
    sms: 'Generate your SMS API key to start sending programmatically. Active immediately — your business is already approved.',
}

function CopyButton({ text, className }: { text: string; className?: string }) {
    const [copied, setCopied] = useState(false)
    const copy = async () => {
        try { await navigator.clipboard.writeText(text) }
        catch {
            const el = document.createElement('textarea')
            el.value = text; document.body.appendChild(el); el.select()
            document.execCommand('copy'); document.body.removeChild(el)
        }
        setCopied(true)
        toast.success('Copied to clipboard')
        setTimeout(() => setCopied(false), 2500)
    }
    return (
        <button
            onClick={copy}
            className={cn(
                'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all',
                'bg-white/10 hover:bg-white/20 text-slate-300 hover:text-white',
                className
            )}
        >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? 'Copied' : 'Copy'}
        </button>
    )
}

// ── API Key Card ─────────────────────────────────────────────────────────────
// One instance per key_type ('standard' | 'commission' | 'sms'). Each card owns
// its own generate/regenerate + one-time plaintext reveal flow independently —
// generating one key type never touches another (mirrors the per-type delete
// in POST /api/user/api-keys). SMS keys are auto-active (no admin approval —
// see POST /api/user/api-keys), so the post-generation WhatsApp-approval-
// request modal is skipped for that type: there's nothing for an admin to
// approve, and showing it would be actively misleading.
export function ApiKeyCard({
    keyType, apiKey, userName, userEmail, userPhone, onGenerated,
}: {
    keyType: 'standard' | 'commission' | 'sms'
    apiKey: ApiKeyMeta | null
    userName: string
    userEmail: string
    userPhone: string
    onGenerated: () => void
}) {
    const requiresApproval = keyType !== 'sms'
    const [isGenerating, setIsGenerating] = useState(false)
    const [newKey, setNewKey] = useState<string | null>(null)
    const [showKey, setShowKey] = useState(false)
    const [copiedKey, setCopiedKey] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [showConfirmDialog, setShowConfirmDialog] = useState(false)
    const [showWarningModal, setShowWarningModal] = useState(false)
    const [showApprovalModal, setShowApprovalModal] = useState(false)

    const statusCfg = apiKey ? STATUS_CONFIG[apiKey.status] : null
    const TypeIcon = KEY_TYPE_ICON[keyType]
    const badge = KEY_TYPE_BADGE[keyType]

    const handleGenerateKey = async () => {
        setIsGenerating(true)
        setError(null)
        setNewKey(null)
        try {
            const res = await fetch('/api/user/api-keys', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: KEY_TYPE_DEFAULT_NAME[keyType],
                    key_type: keyType,
                }),
            })
            const json = await res.json()
            if (!res.ok) { setError(json.error || 'Failed to generate API key'); return }
            const response = json as NewKeyResponse
            setNewKey(response.api_key.key)
            setShowKey(true)
            setShowConfirmDialog(false)
            setShowWarningModal(false)
            if (requiresApproval) {
                setShowApprovalModal(true)
            } else {
                toast.success('SMS API key generated and active — copy it now, it will not be shown again.')
            }
            onGenerated()
        } catch (err: any) {
            setError(err.message || 'Failed to generate API key')
        } finally {
            setIsGenerating(false)
        }
    }

    const copyNewKey = async () => {
        if (!newKey) return
        try { await navigator.clipboard.writeText(newKey) }
        catch {
            const el = document.createElement('textarea')
            el.value = newKey; document.body.appendChild(el); el.select()
            document.execCommand('copy'); document.body.removeChild(el)
        }
        setCopiedKey(true)
        toast.success('API key copied to clipboard')
        setTimeout(() => setCopiedKey(false), 3000)
    }

    return (
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
            {/* Card header */}
            <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-100 dark:border-slate-800">
                <TypeIcon className="w-5 h-5 text-slate-500" />
                <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                    {KEY_TYPE_LABEL[keyType]}
                </h2>
                {badge && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-violet-100 dark:bg-violet-500/15 text-violet-600 dark:text-violet-400 border border-violet-200 dark:border-violet-500/30">
                        {badge}
                    </span>
                )}
            </div>

            <div className="p-5 space-y-4">
                {keyType === 'commission' && (
                    <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                        For utility bill endpoints. You earn a share of the transaction commission, paid into your shop wallet.
                    </p>
                )}
                {keyType === 'sms' && (
                    <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                        For the SMS API (/api/v2/sms/*). Active immediately — no admin approval needed since your business is already approved.
                    </p>
                )}

                {/* New Key Banner */}
                {newKey && (
                    <div className="rounded-2xl border-2 border-emerald-400/40 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-950/20 overflow-hidden">
                        <div className="flex items-center gap-2.5 px-4 py-3 bg-emerald-500/10 border-b border-emerald-400/20">
                            <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />
                            <p className="text-sm font-semibold text-emerald-800 dark:text-emerald-200">
                                Save your API key — it will never be shown again.
                            </p>
                        </div>
                        <div className="p-4 space-y-3">
                            <p className="text-xs text-slate-600 dark:text-slate-400">
                                Copy and store this key somewhere safe. If you lose it, you must generate a new one, which permanently revokes this key.
                            </p>
                            <div className="flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-3 font-mono text-sm overflow-x-auto">
                                <code className="flex-1 text-slate-200 break-all text-[13px]">
                                    {showKey ? newKey : '•'.repeat(Math.min(newKey.length, 48))}
                                </code>
                                <button
                                    onClick={() => setShowKey(s => !s)}
                                    className="p-1.5 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white transition-colors flex-shrink-0"
                                >
                                    {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                </button>
                                <button
                                    onClick={copyNewKey}
                                    className="p-1.5 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white transition-colors flex-shrink-0"
                                >
                                    {copiedKey ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                                </button>
                            </div>
                            <Button
                                onClick={copyNewKey}
                                className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-semibold h-10 gap-2"
                            >
                                {copiedKey ? <><Check className="w-4 h-4" /> Copied!</> : <><Copy className="w-4 h-4" /> Copy API Key</>}
                            </Button>
                        </div>
                    </div>
                )}

                {apiKey && statusCfg ? (
                    <div className="space-y-5">
                        {/* Status row */}
                        <div className="flex items-center justify-between flex-wrap gap-3">
                            <div className={cn(
                                'inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-semibold border',
                                statusCfg.bg, statusCfg.color, statusCfg.border
                            )}>
                                <span className={cn('w-2 h-2 rounded-full flex-shrink-0', statusCfg.dot,
                                    apiKey.status === 'active' && 'animate-pulse'
                                )} />
                                <statusCfg.icon className="w-4 h-4" />
                                {statusCfg.label}
                            </div>
                            <code className="text-sm font-mono text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 px-3 py-1.5 rounded-lg">
                                {apiKey.prefix}••••••••
                            </code>
                        </div>

                        {/* Meta grid */}
                        <div className="grid grid-cols-2 gap-4">
                            <div className="rounded-xl bg-slate-50 dark:bg-slate-800/50 px-4 py-3">
                                <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest mb-1">Created</p>
                                <p className="text-sm font-semibold text-slate-900 dark:text-white">
                                    {new Date(apiKey.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                                </p>
                            </div>
                            <div className="rounded-xl bg-slate-50 dark:bg-slate-800/50 px-4 py-3">
                                <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest mb-1">Last Used</p>
                                <p className="text-sm font-semibold text-slate-900 dark:text-white">
                                    {apiKey.last_used_at
                                        ? new Date(apiKey.last_used_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
                                        : 'Never'}
                                </p>
                            </div>
                        </div>

                        {/* Status-specific notices */}
                        {apiKey.status === 'pending' && (
                            <div className="flex items-start gap-3 rounded-xl bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800/50 p-4">
                                <Clock className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                                <p className="text-sm text-amber-800 dark:text-amber-200">
                                    <strong>Awaiting approval.</strong> An administrator will review and activate your key. You'll be notified when it's ready.
                                </p>
                            </div>
                        )}
                        {apiKey.status === 'revoked' && (
                            <div className="flex items-start gap-3 rounded-xl bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800/50 p-4">
                                <XCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                                <p className="text-sm text-red-800 dark:text-red-200">
                                    <strong>Key revoked.</strong> This key can no longer be used. Generate a new key to restore API access.
                                </p>
                            </div>
                        )}

                        {/* Rotate key */}
                        <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
                            {!showConfirmDialog ? (
                                <Button
                                    variant="outline"
                                    onClick={() => setShowWarningModal(true)}
                                    className="gap-2 h-9 text-sm"
                                >
                                    <RefreshCw className="w-4 h-4" />
                                    Generate New Key
                                </Button>
                            ) : (
                                <div className="rounded-xl bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800/50 p-4 space-y-3">
                                    <p className="text-sm text-red-800 dark:text-red-200 font-medium leading-snug">
                                        ⚠️ This will <strong>permanently revoke</strong> your current key. All existing integrations using it will stop working immediately.
                                    </p>
                                    <div className="flex gap-2">
                                        <Button
                                            variant="destructive"
                                            size="sm"
                                            onClick={handleGenerateKey}
                                            disabled={isGenerating}
                                            className="gap-2 h-8 text-xs font-semibold"
                                        >
                                            {isGenerating ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Key className="w-3.5 h-3.5" />}
                                            {isGenerating ? 'Generating…' : 'Confirm & Revoke'}
                                        </Button>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={() => setShowConfirmDialog(false)}
                                            className="h-8 text-xs"
                                        >
                                            Cancel
                                        </Button>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                ) : (
                    /* No key yet */
                    <div className="text-center py-10">
                        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-violet-100 to-indigo-100 dark:from-violet-900/20 dark:to-indigo-900/20 flex items-center justify-center mx-auto mb-4 border border-violet-200/60 dark:border-violet-800/30">
                            <TypeIcon className="w-7 h-7 text-violet-500" />
                        </div>
                        <h3 className="text-base font-semibold text-slate-900 dark:text-white mb-2">
                            No {KEY_TYPE_LABEL[keyType]} Yet
                        </h3>
                        <p className="text-sm text-slate-500 dark:text-slate-400 mb-6 max-w-xs mx-auto">
                            {KEY_TYPE_EMPTY_COPY[keyType]}
                        </p>
                        <Button
                            onClick={() => setShowWarningModal(true)}
                            disabled={isGenerating}
                            className="bg-gradient-to-r from-violet-500 to-indigo-600 hover:from-violet-600 hover:to-indigo-700 text-white font-semibold gap-2 shadow-lg shadow-violet-500/20 h-10 px-6"
                        >
                            {isGenerating ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Key className="w-4 h-4" />}
                            {isGenerating ? 'Generating…' : `Generate ${keyType === 'sms' ? 'SMS' : keyType === 'commission' ? 'Commission' : 'API'} Key`}
                        </Button>
                    </div>
                )}

                {error && (
                    <div className="flex items-start gap-3 rounded-xl bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800/50 p-4">
                        <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                        <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
                    </div>
                )}
            </div>

            {/* Pre-generation Warning Modal */}
            {showWarningModal && (
                <DeveloperWarningModal
                    isGenerating={isGenerating}
                    hasExistingKey={!!apiKey}
                    onConfirm={handleGenerateKey}
                    onClose={() => setShowWarningModal(false)}
                />
            )}

            {/* Post-generation Approval Modal — standard/commission only, sms is auto-active */}
            {showApprovalModal && newKey && requiresApproval && (
                <ApprovalModal
                    userName={userName}
                    userEmail={userEmail}
                    userPhone={userPhone}
                    keyPrefix={apiKey?.prefix || newKey.substring(0, 16)}
                    onClose={() => setShowApprovalModal(false)}
                />
            )}
        </div>
    )
}

// ── Modal: Developer Use Only Warning ────────────────────────────────────────
function DeveloperWarningModal({
    isGenerating, hasExistingKey, onConfirm, onClose,
}: {
    isGenerating: boolean
    hasExistingKey: boolean
    onConfirm: () => void
    onClose: () => void
}) {
    const [acknowledged, setAcknowledged] = useState(false)
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-sm overflow-y-auto">
            <div className="relative w-full max-w-lg bg-white dark:bg-slate-900 rounded-2xl sm:rounded-3xl shadow-2xl border border-slate-200 dark:border-slate-700 overflow-hidden my-auto">
                {/* Close */}
                <button
                    type="button"
                    onClick={onClose}
                    aria-label="Close"
                    className="absolute top-3 right-3 p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors z-10"
                >
                    <X className="w-4 h-4" />
                </button>

                {/* Header */}
                <div className="p-5 sm:p-6 bg-gradient-to-br from-amber-50 to-red-50 dark:from-amber-950/30 dark:to-red-950/30 border-b border-amber-200/60 dark:border-amber-800/40">
                    <div className="flex items-start gap-3 sm:gap-4">
                        <div className="w-11 h-11 sm:w-12 sm:h-12 rounded-2xl bg-amber-500/20 flex items-center justify-center flex-shrink-0">
                            <ShieldAlert className="w-5 h-5 sm:w-6 sm:h-6 text-amber-600 dark:text-amber-400" />
                        </div>
                        <div className="min-w-0">
                            <h2 className="text-base sm:text-lg font-semibold text-slate-900 dark:text-white tracking-tight">
                                For Developer Use Only
                            </h2>
                            <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-300 mt-1">
                                Please read carefully before generating a key.
                            </p>
                        </div>
                    </div>
                </div>

                {/* Body */}
                <div className="p-5 sm:p-6 space-y-4 text-sm text-slate-700 dark:text-slate-300">
                    <p>
                        The Developer API is intended for <strong>software developers integrating KiNG FLEXY GH into their own apps or platforms</strong> — not for casual use or for resale of unmodified KiNG FLEXY GH services.
                    </p>

                    <div className="rounded-xl bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800/50 p-4 space-y-2">
                        <p className="font-semibold text-red-700 dark:text-red-300 flex items-center gap-2">
                            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                            Anti-abuse policy
                        </p>
                        <ul className="text-xs sm:text-sm text-red-800 dark:text-red-200 space-y-1.5 list-disc pl-5 leading-relaxed">
                            <li>Do <strong>not</strong> generate keys you don't intend to use.</li>
                            <li>Do <strong>not</strong> share your key with third parties. You are responsible for every request made with it.</li>
                            <li>Abuse, brute-forcing, or fraudulent use will result in <strong>permanent revocation</strong> and account suspension.</li>
                            <li>Each generation request is logged and reviewed by an administrator.</li>
                        </ul>
                    </div>

                    {hasExistingKey && (
                        <div className="rounded-xl bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800/50 p-3 text-xs sm:text-sm text-amber-800 dark:text-amber-200">
                            <strong>⚠ This will permanently revoke your current key.</strong> Any app currently using it will stop working immediately.
                        </div>
                    )}

                    <label className="flex items-start gap-2.5 cursor-pointer select-none pt-1">
                        <input
                            type="checkbox"
                            checked={acknowledged}
                            onChange={e => setAcknowledged(e.target.checked)}
                            className="mt-0.5 w-4 h-4 rounded border-slate-300 dark:border-slate-600 text-violet-600 focus:ring-violet-500/40 cursor-pointer"
                        />
                        <span className="text-xs sm:text-sm text-slate-700 dark:text-slate-300 leading-snug">
                            I understand this is a developer-only feature and I will not abuse the API. I accept that violating the anti-abuse policy may permanently disable my account.
                        </span>
                    </label>
                </div>

                {/* Footer */}
                <div className="px-5 sm:px-6 py-4 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-100 dark:border-slate-800 flex flex-col sm:flex-row gap-2 sm:gap-3">
                    <Button
                        type="button"
                        variant="outline"
                        onClick={onClose}
                        disabled={isGenerating}
                        className="flex-1 h-10 text-sm font-semibold order-2 sm:order-1"
                    >
                        Cancel
                    </Button>
                    <Button
                        type="button"
                        onClick={onConfirm}
                        disabled={!acknowledged || isGenerating}
                        className={cn(
                            'flex-1 h-10 text-sm font-semibold gap-2 order-1 sm:order-2 bg-gradient-to-r from-violet-500 to-indigo-600 hover:from-violet-600 hover:to-indigo-700 text-white shadow-lg shadow-violet-500/20',
                            !acknowledged && 'opacity-50 cursor-not-allowed'
                        )}
                    >
                        {isGenerating ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Key className="w-4 h-4" />}
                        {isGenerating ? 'Generating…' : 'I Agree — Generate Key'}
                    </Button>
                </div>
            </div>
        </div>
    )
}

// ── Modal: Post-generation Approval / WhatsApp Admin ─────────────────────────
function ApprovalModal({
    userName, userEmail, userPhone, keyPrefix, onClose,
}: {
    userName: string
    userEmail: string
    userPhone: string
    keyPrefix: string
    onClose: () => void
}) {
    const ADMIN_WHATSAPP = '233578065809'
    const message = [
        `Hello Admin, please approve my Developer API key.`,
        ``,
        `Name: ${userName}`,
        `Email: ${userEmail}`,
        `Phone: ${userPhone}`,
        `Key prefix: ${keyPrefix}`,
        ``,
        `Thank you.`,
    ].join('\n')
    const waUrl = `https://wa.me/${ADMIN_WHATSAPP}?text=${encodeURIComponent(message)}`

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-sm overflow-y-auto">
            <div className="relative w-full max-w-lg bg-white dark:bg-slate-900 rounded-2xl sm:rounded-3xl shadow-2xl border border-slate-200 dark:border-slate-700 overflow-hidden my-auto">
                <button
                    type="button"
                    onClick={onClose}
                    aria-label="Close"
                    className="absolute top-3 right-3 p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors z-10"
                >
                    <X className="w-4 h-4" />
                </button>

                {/* Header */}
                <div className="p-5 sm:p-6 bg-gradient-to-br from-emerald-50 to-violet-50 dark:from-emerald-950/30 dark:to-violet-950/30 border-b border-emerald-200/60 dark:border-emerald-800/40">
                    <div className="flex items-start gap-3 sm:gap-4">
                        <div className="w-11 h-11 sm:w-12 sm:h-12 rounded-2xl bg-emerald-500/20 flex items-center justify-center flex-shrink-0">
                            <Sparkles className="w-5 h-5 sm:w-6 sm:h-6 text-emerald-600 dark:text-emerald-400" />
                        </div>
                        <div className="min-w-0">
                            <h2 className="text-base sm:text-lg font-semibold text-slate-900 dark:text-white tracking-tight">
                                Key Generated — One Step Left
                            </h2>
                            <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-300 mt-1">
                                Your API key is pending admin approval. Message the admin on WhatsApp to fast-track activation.
                            </p>
                        </div>
                    </div>
                </div>

                {/* Body */}
                <div className="p-5 sm:p-6 space-y-4">
                    <div className="rounded-xl bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800/50 p-3 sm:p-4">
                        <p className="text-xs sm:text-sm text-amber-800 dark:text-amber-200 leading-relaxed">
                            <strong>Save your key first</strong> — it's shown in the page above and won't appear again. After saving, tap the WhatsApp button to notify the admin for approval.
                        </p>
                    </div>

                    <div className="rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 p-3 sm:p-4 space-y-1.5">
                        <p className="text-[10px] sm:text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Message Preview</p>
                        <pre className="text-[11px] sm:text-xs font-mono text-slate-700 dark:text-slate-300 whitespace-pre-wrap break-words leading-relaxed">{message}</pre>
                    </div>

                    <a
                        href={waUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center justify-center gap-2.5 w-full h-11 sm:h-12 rounded-xl bg-[#25D366] hover:bg-[#1fb955] text-white font-semibold text-sm sm:text-base shadow-lg shadow-emerald-500/20 transition-colors"
                    >
                        <MessageCircle className="w-5 h-5" />
                        Message Admin on WhatsApp
                    </a>

                    <p className="text-[11px] text-center text-slate-400 dark:text-slate-500">
                        Or wait — admins review pending keys regularly. You'll get a notification once approved.
                    </p>
                </div>

                {/* Footer */}
                <div className="px-5 sm:px-6 py-3 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-100 dark:border-slate-800">
                    <Button
                        type="button"
                        variant="outline"
                        onClick={onClose}
                        className="w-full h-9 text-xs sm:text-sm font-semibold"
                    >
                        Got it — close
                    </Button>
                </div>
            </div>
        </div>
    )
}
