'use client'

import { useEffect, useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import {
    Webhook, Loader2, Save, Trash2, Copy, Check, AlertTriangle,
    CheckCircle2, XCircle, RefreshCw, Eye, EyeOff,
} from 'lucide-react'

// ── Webhook Configuration Card ──────────────────────────────────────────────
// One instance per key_type ('standard' | 'commission') that has a key. Talks
// to GET/PUT/DELETE /api/user/api-keys/webhook (see that route for the SSRF
// validation, secret rotation, and cache-invalidation contract this UI relies
// on). Rendered only when the caller already has a key of this type — a
// webhook without a key to attach it to isn't a state this UI needs to model.
//
// This is a DIFFERENT feature from the SMS webhook config at
// /dashboard/sms/api (which targets sms_accounts.webhook_url for inbound SMS
// delivery reports). This one fires order.completed/order.failed events for
// Data API and Utility Bills orders — see app/developers's Webhooks section.
export function WebhookConfigCard({ keyType }: { keyType: 'standard' | 'commission' }) {
    const [loading, setLoading] = useState(true)
    const [webhookUrl, setWebhookUrl] = useState('')
    const [savedUrl, setSavedUrl] = useState<string | null>(null)
    const [hasSecret, setHasSecret] = useState(false)
    const [saving, setSaving] = useState(false)
    const [removing, setRemoving] = useState(false)
    const [newSecret, setNewSecret] = useState<string | null>(null)
    const [showSecret, setShowSecret] = useState(false)
    const [copiedSecret, setCopiedSecret] = useState(false)

    const load = useCallback(async () => {
        try {
            const res = await fetch('/api/user/api-keys/webhook')
            if (!res.ok) return
            const json = await res.json()
            const row = (json.webhooks || []).find((w: any) => w.keyType === keyType)
            setWebhookUrl(row?.webhookUrl || '')
            setSavedUrl(row?.webhookUrl || null)
            setHasSecret(!!row?.hasSecret)
        } catch (err) {
            console.error('[WebhookConfigCard] load failed:', err)
        } finally {
            setLoading(false)
        }
    }, [keyType])

    useEffect(() => { load() }, [load])

    const save = async (rotateSecret = false) => {
        if (!webhookUrl.trim()) {
            toast.error('Enter a webhook URL first')
            return
        }
        setSaving(true)
        setNewSecret(null)
        try {
            const res = await fetch('/api/user/api-keys/webhook', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ keyType, webhookUrl: webhookUrl.trim(), rotateSecret }),
            })
            const json = await res.json()
            if (!res.ok) { toast.error(json.error || 'Failed to save webhook'); return }
            setSavedUrl(json.webhookUrl)
            setHasSecret(true)
            if (json.signingSecret) {
                setNewSecret(json.signingSecret)
                setShowSecret(true)
                toast.success('Webhook saved — copy your signing secret now.')
            } else {
                toast.success('Webhook URL updated')
            }
        } catch (err) {
            console.error('[WebhookConfigCard] save failed:', err)
            toast.error('Failed to save webhook')
        } finally {
            setSaving(false)
        }
    }

    const remove = async () => {
        setRemoving(true)
        try {
            const res = await fetch(`/api/user/api-keys/webhook?keyType=${keyType}`, { method: 'DELETE' })
            const json = await res.json()
            if (!res.ok) { toast.error(json.error || 'Failed to disable webhook'); return }
            setWebhookUrl('')
            setSavedUrl(null)
            setHasSecret(false)
            setNewSecret(null)
            toast.success('Webhook disabled')
        } catch (err) {
            console.error('[WebhookConfigCard] remove failed:', err)
            toast.error('Failed to disable webhook')
        } finally {
            setRemoving(false)
        }
    }

    const copySecret = async () => {
        if (!newSecret) return
        try { await navigator.clipboard.writeText(newSecret) }
        catch {
            const el = document.createElement('textarea')
            el.value = newSecret; document.body.appendChild(el); el.select()
            document.execCommand('copy'); document.body.removeChild(el)
        }
        setCopiedSecret(true)
        toast.success('Signing secret copied')
        setTimeout(() => setCopiedSecret(false), 3000)
    }

    const isDirty = webhookUrl.trim() !== (savedUrl || '')

    if (loading) {
        return (
            <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 flex items-center justify-center h-40">
                <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
            </div>
        )
    }

    return (
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
            <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-100 dark:border-slate-800">
                <Webhook className="w-5 h-5 text-slate-500" />
                <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                    {keyType === 'standard' ? 'Data API' : 'Commission Services'} Webhook
                </h2>
                {savedUrl && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-emerald-100 dark:bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-500/30">
                        Active
                    </span>
                )}
            </div>

            <div className="p-5 space-y-4">
                <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                    Get notified the instant an order reaches <code className="font-mono">completed</code> or{' '}
                    <code className="font-mono">failed</code>, instead of polling{' '}
                    <code className="font-mono">GET /orders/{'{reference}'}</code>. Must be a public HTTPS URL —
                    localhost and private/internal addresses are rejected.
                </p>

                <div>
                    <label className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest mb-1.5 block">
                        Webhook URL
                    </label>
                    <Input
                        type="url"
                        placeholder="https://your-app.com/webhooks/kingflexy"
                        value={webhookUrl}
                        onChange={e => setWebhookUrl(e.target.value)}
                        className="h-10 font-mono text-sm"
                    />
                </div>

                {newSecret && (
                    <div className="rounded-xl border-2 border-emerald-400/40 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-950/20 overflow-hidden">
                        <div className="flex items-center gap-2.5 px-4 py-2.5 bg-emerald-500/10 border-b border-emerald-400/20">
                            <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />
                            <p className="text-xs font-semibold text-emerald-800 dark:text-emerald-200">
                                Save this signing secret now — it will never be shown again.
                            </p>
                        </div>
                        <div className="p-3.5 space-y-2.5">
                            <div className="flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-2.5 font-mono text-sm overflow-x-auto">
                                <code className="flex-1 text-slate-200 break-all text-[12px]">
                                    {showSecret ? newSecret : '•'.repeat(Math.min(newSecret.length, 48))}
                                </code>
                                <button onClick={() => setShowSecret(s => !s)} className="p-1 rounded hover:bg-white/10 text-slate-400 hover:text-white flex-shrink-0">
                                    {showSecret ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                                </button>
                                <button onClick={copySecret} className="p-1 rounded hover:bg-white/10 text-slate-400 hover:text-white flex-shrink-0">
                                    {copiedSecret ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                                </button>
                            </div>
                            <p className="text-[11px] text-slate-500 dark:text-slate-400">
                                Verify each request with HMAC-SHA256 against the <code className="font-mono">X-KFT-Signature</code> header before trusting the payload.
                            </p>
                        </div>
                    </div>
                )}

                {!newSecret && hasSecret && (
                    <div className="flex items-center justify-between rounded-xl bg-slate-50 dark:bg-slate-800/50 px-4 py-3">
                        <div className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
                            <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                            Signing secret configured — hidden after creation.
                        </div>
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-7 text-[11px] gap-1"
                            disabled={saving || !savedUrl}
                            onClick={() => save(true)}
                        >
                            <RefreshCw className="w-3 h-3" /> Rotate
                        </Button>
                    </div>
                )}

                <div className="flex items-center gap-2 pt-1">
                    <Button
                        onClick={() => save(false)}
                        disabled={saving || !isDirty}
                        className="gap-2 h-9 text-sm flex-1"
                    >
                        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                        {savedUrl ? 'Update Webhook' : 'Save Webhook'}
                    </Button>
                    {savedUrl && (
                        <Button
                            variant="outline"
                            onClick={remove}
                            disabled={removing}
                            className="gap-2 h-9 text-sm text-red-600 hover:text-red-700 border-red-200 hover:bg-red-50 dark:border-red-800/50 dark:hover:bg-red-950/20"
                        >
                            {removing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                            Disable
                        </Button>
                    )}
                </div>
            </div>
        </div>
    )
}
