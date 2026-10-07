'use client'

/**
 * /dashboard/sms/api — SMS API key management + embedded docs + webhook
 * config + usage analytics. Business-mode only; platform-mode users see a
 * locked state pointing at /dashboard/sms/business.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useAuth } from '@/contexts/auth-context'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/lib/toast'
import { ApiKeyCard, type ApiKeyMeta } from '@/components/api/ApiKeyCard'
import { ApiEndpointBlock } from '@/components/api/ApiEndpointBlock'
import { SMS_API_ENDPOINTS, SMS_BUSINESS_MODE_NOTICE } from '@/content/sms-api-docs'
import {
    ArrowLeft, Lock, Webhook, Activity, Loader2, Save,
} from 'lucide-react'

interface UsageData {
    requests30d: number; successRate: number | null
    creditsViaApi30d: number; creditsViaDashboard30d: number
    lastUsedAt: string | null
}

export default function SmsApiPage() {
    const { dbUser } = useAuth()
    const [mode, setMode] = useState<'loading' | 'platform' | 'business'>('loading')
    const [smsKey, setSmsKey] = useState<ApiKeyMeta | null>(null)
    const [usage, setUsage] = useState<UsageData | null>(null)
    const [webhookUrl, setWebhookUrl] = useState('')
    const [savingWebhook, setSavingWebhook] = useState(false)

    const load = useCallback(async () => {
        const [acctRes, keysRes, usageRes, webhookRes] = await Promise.all([
            fetch('/api/sms/account'),
            fetch('/api/user/api-keys'),
            fetch('/api/sms/api-usage'),
            fetch('/api/sms/webhook-config'),
        ])
        const acct = acctRes.ok ? await acctRes.json() : null
        setMode(acct?.data?.account?.mode === 'business' ? 'business' : 'platform')
        if (keysRes.ok) {
            const kj = await keysRes.json()
            setSmsKey(kj?.api_keys?.sms ?? null)
        }
        if (usageRes.ok) setUsage((await usageRes.json())?.data ?? null)
        if (webhookRes.ok) {
            const wj = await webhookRes.json()
            setWebhookUrl(wj?.data?.webhookUrl ?? '')
        }
    }, [])

    useEffect(() => { if (dbUser) load() }, [dbUser, load])

    const saveWebhook = async () => {
        setSavingWebhook(true)
        try {
            const res = await fetch('/api/sms/webhook-config', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ webhookUrl: webhookUrl.trim() || null }),
            })
            const json = await res.json()
            if (!res.ok) { toast.error(json.error || 'Failed to save webhook'); return }
            if (json.data?.secret) {
                toast.success('Webhook saved — copy your signing secret now, it will not be shown again')
                await navigator.clipboard.writeText(json.data.secret).catch(() => {})
            } else {
                toast.success('Webhook removed')
            }
        } finally {
            setSavingWebhook(false)
        }
    }

    if (mode === 'loading') {
        return <div className="flex items-center justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-muted-foreground" /></div>
    }

    if (mode === 'platform') {
        return (
            <div className="max-w-xl mx-auto space-y-4 py-10 text-center">
                <div className="w-16 h-16 rounded-2xl bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center mx-auto">
                    <Lock className="w-7 h-7 text-amber-500" />
                </div>
                <h2 className="text-lg font-semibold">Business Mode Required</h2>
                <p className="text-sm text-muted-foreground">{SMS_BUSINESS_MODE_NOTICE}</p>
                <Link href="/dashboard/sms/business">
                    <Button className="mt-2">Register Your Business</Button>
                </Link>
            </div>
        )
    }

    return (
        <div className="space-y-6 max-w-3xl mx-auto pb-20">
            <div className="flex items-center gap-3">
                <Link href="/dashboard/sms"><Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button></Link>
                <div>
                    <h1 className="text-lg font-bold">SMS API & Docs</h1>
                    <p className="text-xs text-muted-foreground">Manage your SMS API key, webhook, and usage — all in one place</p>
                </div>
            </div>

            <ApiKeyCard
                keyType="sms"
                apiKey={smsKey}
                userName={`${(dbUser as any)?.first_name || ''} ${(dbUser as any)?.last_name || ''}`.trim() || 'User'}
                userEmail={(dbUser as any)?.email || ''}
                userPhone={(dbUser as any)?.phone_number || ''}
                onGenerated={load}
            />

            {usage && (
                <div className="rounded-2xl border bg-card p-5 space-y-3">
                    <div className="flex items-center gap-2"><Activity className="w-4 h-4" /><h2 className="text-sm font-semibold">API Usage (30 days)</h2></div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                        <div><p className="text-muted-foreground text-xs">Requests</p><p className="font-semibold">{usage.requests30d}</p></div>
                        <div><p className="text-muted-foreground text-xs">Success Rate</p><p className="font-semibold">{usage.successRate ?? '—'}%</p></div>
                        <div><p className="text-muted-foreground text-xs">Credits via API</p><p className="font-semibold">{usage.creditsViaApi30d}</p></div>
                        <div><p className="text-muted-foreground text-xs">Credits via Dashboard</p><p className="font-semibold">{usage.creditsViaDashboard30d}</p></div>
                    </div>
                </div>
            )}

            <div className="rounded-2xl border bg-card p-5 space-y-3">
                <div className="flex items-center gap-2"><Webhook className="w-4 h-4" /><h2 className="text-sm font-semibold">Delivery Webhook</h2></div>
                <p className="text-xs text-muted-foreground">Get a signed POST when a campaign's delivery status resolves. HTTPS only.</p>
                <div className="flex gap-2">
                    <Input value={webhookUrl} onChange={e => setWebhookUrl(e.target.value)} placeholder="https://yourapp.com/webhooks/kft-sms" />
                    <Button onClick={saveWebhook} disabled={savingWebhook} className="gap-2">
                        {savingWebhook ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
                    </Button>
                </div>
            </div>

            <div className="space-y-4">
                <h2 className="text-sm font-semibold">API Reference</h2>
                {SMS_API_ENDPOINTS.map(ep => (
                    <ApiEndpointBlock
                        key={ep.path}
                        method={ep.method}
                        path={ep.path}
                        description={ep.description}
                        queryParams={ep.queryParams}
                        requestBody={ep.requestBody}
                        responseBody={ep.responseBody}
                        notes={ep.notes}
                        samples={ep.codeSamples}
                    />
                ))}
            </div>
        </div>
    )
}
