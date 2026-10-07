'use client'

import { useEffect, useState, useCallback } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
    Key,
    Copy,
    Check,
    RefreshCw,
    AlertTriangle,
    Clock,
    CheckCircle2,
    XCircle,
    Eye,
    EyeOff,
    Code2,
    Shield,
    Zap,
    ExternalLink,
    Terminal,
    BookOpen,
    ArrowRight,
    Wifi,
    Wallet,
    ShoppingCart,
    TrendingUp,
    AlertOctagon,
    Activity,
    Database,
    Percent,
    MessageCircle,
    ShieldAlert,
    Sparkles,
    X,
    ChevronDown,
    ChevronRight,
    Globe,
    List,
    AlertCircle,
    Package,
    Loader2,
    Webhook,
    Menu,
} from 'lucide-react'
import Link from 'next/link'
import { toast } from '@/lib/toast'
import { ApiKeyCard, type ApiKeyMeta } from '@/components/api/ApiKeyCard'
import { ApiCopyBtn } from '@/components/api/ApiCodeBlock'
import { ApiEndpointBlock, type ApiLangTab } from '@/components/api/ApiEndpointBlock'
import { WebhookConfigCard } from '@/components/api/WebhookConfigCard'

interface ApiKeyData {
    feature_enabled: boolean
    is_eligible: boolean
    allowed_roles: string[]
    user_role: string
    api_keys: {
        standard: ApiKeyMeta | null
        commission: ApiKeyMeta | null
        sms: ApiKeyMeta | null
    }
}

interface ApiStats {
    total_spent: number
    total_orders: number
    success_orders: number
    failed_orders: number
    pending_orders: number
    success_rate: number
    total_gb: number
    requests_24h: number
    requests_7d: number
    week_spent: number
    week_orders: number
}

const QUICK_START_TABS = ['cURL', 'Node.js', 'PHP', 'Python'] as const
type QuickStartTab = (typeof QUICK_START_TABS)[number]

const QUICK_START_CODE: Record<QuickStartTab, string> = {
    'cURL': `curl -X POST https://api.kingflexygh.com/api/v2/data/purchase \\
  -H "Authorization: YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "network": "MTN",
    "volume_gb": 5,
    "recipient": "0551617309",
    "reference": "order_001"
  }'`,
    'Node.js': `const res = await fetch('https://api.kingflexygh.com/api/v2/data/purchase', {
  method: 'POST',
  headers: {
    'Authorization': 'YOUR_API_KEY',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    network: 'MTN',
    volume_gb: 5,
    recipient: '0551617309',
    reference: 'order_001',
  }),
});
const data = await res.json();
console.log(data);`,
    'PHP': `<?php
$ch = curl_init('https://api.kingflexygh.com/api/v2/data/purchase');
curl_setopt_array($ch, [
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_POST => true,
  CURLOPT_HTTPHEADER => [
    'Authorization: YOUR_API_KEY',
    'Content-Type: application/json',
  ],
  CURLOPT_POSTFIELDS => json_encode([
    'network' => 'MTN', 'volume_gb' => 5,
    'recipient' => '0551617309', 'reference' => 'order_001',
  ]),
]);
echo curl_exec($ch); curl_close($ch);`,
    'Python': `import requests

r = requests.post(
  'https://api.kingflexygh.com/api/v2/data/purchase',
  headers={
    'Authorization': 'YOUR_API_KEY',
    'Content-Type': 'application/json',
  },
  json={
    'network': 'MTN', 'volume_gb': 5,
    'recipient': '0551617309', 'reference': 'order_001',
  }
)
print(r.json())`,
}

// ── Stat Card ────────────────────────────────────────────────────────────────
function StatCard({
    icon: Icon, label, value, sub, accent, pulse,
}: {
    icon: any
    label: string
    value: string | number
    sub?: string
    accent: 'violet' | 'emerald' | 'red' | 'amber' | 'sky' | 'slate'
    pulse?: boolean
}) {
    const accents = {
        violet: { iconBg: 'bg-violet-500/10', iconText: 'text-violet-600 dark:text-violet-400', text: 'text-violet-600 dark:text-violet-400' },
        emerald: { iconBg: 'bg-emerald-500/10', iconText: 'text-emerald-600 dark:text-emerald-400', text: 'text-emerald-600 dark:text-emerald-400' },
        red: { iconBg: 'bg-red-500/10', iconText: 'text-red-600 dark:text-red-400', text: 'text-red-600 dark:text-red-400' },
        amber: { iconBg: 'bg-amber-500/10', iconText: 'text-amber-600 dark:text-amber-400', text: 'text-amber-600 dark:text-amber-400' },
        sky: { iconBg: 'bg-sky-500/10', iconText: 'text-sky-600 dark:text-sky-400', text: 'text-sky-600 dark:text-sky-400' },
        slate: { iconBg: 'bg-slate-200 dark:bg-slate-700/60', iconText: 'text-slate-600 dark:text-slate-300', text: 'text-slate-900 dark:text-white' },
    }[accent]

    return (
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3 sm:p-4 min-w-0">
            <div className="flex items-start gap-2 sm:gap-2.5">
                <div className={cn('w-7 h-7 sm:w-8 sm:h-8 rounded-xl flex items-center justify-center flex-shrink-0', accents.iconBg)}>
                    <Icon className={cn('w-3.5 h-3.5 sm:w-4 sm:h-4', accents.iconText)} />
                </div>
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                        {pulse && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse flex-shrink-0" />}
                        <p className="text-[10px] sm:text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider truncate">{label}</p>
                    </div>
                    <p className={cn('text-sm sm:text-base lg:text-lg font-semibold mt-0.5 tabular-nums whitespace-nowrap', accents.text)}>{value}</p>
                    {sub && <p className="text-[10px] sm:text-[11px] text-slate-400 dark:text-slate-500 mt-0.5 truncate">{sub}</p>}
                </div>
            </div>
        </div>
    )
}

// ── Copy Button ──────────────────────────────────────────────────────────────
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

// ── Code Block ───────────────────────────────────────────────────────────────
function CodeBlock({ code, label }: { code: string; label?: string }) {
    return (
        <div className="rounded-xl overflow-hidden border border-slate-700/60">
            {label && (
                <div className="flex items-center justify-between px-4 py-2 bg-slate-800/80 border-b border-slate-700/60">
                    <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest">{label}</span>
                    <CopyButton text={code} />
                </div>
            )}
            <div className="bg-slate-900 p-4 overflow-x-auto">
                <pre className="text-[13px] font-mono text-slate-200 leading-relaxed whitespace-pre">{code}</pre>
            </div>
        </div>
    )
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function ApiDashboardPage() {
    const { dbUser } = useAuth()
    const [data, setData] = useState<ApiKeyData | null>(null)
    const [stats, setStats] = useState<ApiStats | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const [activeTab, setActiveTab] = useState<QuickStartTab>('cURL')

    const fetchKeyData = useCallback(async () => {
        try {
            const [keyRes, statsRes] = await Promise.all([
                fetch('/api/user/api-keys'),
                fetch('/api/user/api-keys/stats'),
            ])
            if (keyRes.ok) setData(await keyRes.json())
            if (statsRes.ok) setStats(await statsRes.json())
        } catch (err) {
            console.error('Error fetching API key data:', err)
        } finally {
            setIsLoading(false)
        }
    }, [])

    useEffect(() => { if (dbUser) fetchKeyData() }, [dbUser, fetchKeyData])

    // ── Loading ───────────────────────────────────────────────────────────────
    if (isLoading) {
        return (
            <div className="flex items-center justify-center py-20">
                <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
        )
    }

    // ── Feature disabled ─────────────────────────────────────────────────────
    if (!data?.feature_enabled) {
        return (
            <div className="w-full">
                <PageHeader />
                <div className="mt-6 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-10 text-center max-w-xl mx-auto">
                    <div className="w-16 h-16 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center mx-auto mb-4">
                        <Shield className="w-8 h-8 text-slate-400" />
                    </div>
                    <h2 className="text-lg font-semibold text-slate-900 dark:text-white mb-2">API Temporarily Unavailable</h2>
                    <p className="text-sm text-slate-500 dark:text-slate-400">The Developer API is currently disabled by an administrator. Please check back soon.</p>
                </div>
            </div>
        )
    }

    // ── Not eligible ──────────────────────────────────────────────────────────
    if (!data?.is_eligible) {
        const upgradeableRoles = (data.allowed_roles || ['agent']).filter(r => r !== 'admin' && r !== 'sub-admin')
        const roleLabels = upgradeableRoles.map(r => r.charAt(0).toUpperCase() + r.slice(1))
        const rolesText = roleLabels.length > 0
            ? roleLabels.join(' or ')
            : (data.allowed_roles || []).map(r => r.charAt(0).toUpperCase() + r.slice(1)).join(' or ')
        const showUpgrade = upgradeableRoles.some(r => r === 'agent' || r === 'dealer')
        return (
            <div className="w-full">
                <PageHeader />
                <div className="mt-6 rounded-2xl border border-amber-200/60 dark:border-amber-800/40 bg-amber-50/50 dark:bg-amber-950/20 p-8 text-center max-w-xl mx-auto">
                    <div className="w-16 h-16 rounded-2xl bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center mx-auto mb-4">
                        <Zap className="w-8 h-8 text-amber-500" />
                    </div>
                    <h2 className="text-lg font-semibold text-slate-900 dark:text-white mb-2">{rolesText} Account Required</h2>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mb-6 max-w-xs mx-auto">
                        The Developer API is available to {rolesText.toLowerCase()} accounts only. Upgrade your account to unlock API access.
                    </p>
                    {showUpgrade && (
                        <Link href="/dashboard/upgrade">
                            <Button className="bg-amber-500 hover:bg-amber-600 text-black font-semibold gap-2">
                                Upgrade Account <ArrowRight className="w-4 h-4" />
                            </Button>
                        </Link>
                    )}
                </div>
            </div>
        )
    }

    const standardKey = data.api_keys.standard
    const commissionKey = data.api_keys.commission
    const userName = `${(dbUser as any)?.first_name || ''} ${(dbUser as any)?.last_name || ''}`.trim() || 'User'
    const userEmail = (dbUser as any)?.email || ''
    const userPhone = (dbUser as any)?.phone_number || ''

    return (
        <div className="space-y-6 w-full">

            {/* ── Page Header ─────────────────────────────────────────────── */}
            <div className="flex items-start justify-between gap-3 sm:gap-4 flex-wrap">
                <div className="flex items-center gap-3 min-w-0">
                    <div className="w-11 h-11 sm:w-12 sm:h-12 rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-violet-500/20 flex-shrink-0">
                        <Code2 className="w-5 h-5 sm:w-6 sm:h-6 text-white" />
                    </div>
                    <div className="min-w-0">
                        <h1 className="text-lg sm:text-xl font-bold text-slate-900 dark:text-white tracking-tight">Developer API</h1>
                        <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 mt-0.5 truncate">Integrate data purchases into your applications</p>
                    </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                    <a href="/developers" target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
                    >
                        <ExternalLink className="w-3.5 h-3.5" />
                        <span className="hidden xs:inline">API Docs</span>
                        <span className="xs:hidden">Docs</span>
                    </a>
                    <a href="https://documenter.getpostman.com/view/55615613/2sBYAuTBhF" target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-orange-200 dark:border-orange-700/50 bg-orange-50 dark:bg-orange-900/20 text-xs font-semibold text-orange-700 dark:text-orange-300 hover:bg-orange-100 dark:hover:bg-orange-900/40 transition-colors"
                    >
                        <Package className="w-3.5 h-3.5" />
                        <span className="hidden xs:inline">Postman</span>
                        <span className="xs:hidden">PM</span>
                    </a>
                </div>
            </div>

            {/* ── Usage Stats Grid ─────────────────────────────────────────── */}
            {/* Scoped to the standard key — /api/user/api-keys/stats aggregates
                the `orders` table (source='api'), which only standard keys
                populate. Commission keys are utilities-only and write to
                utility_orders instead (see lib/api-auth.ts's central guard). */}
            {standardKey && stats && (
                <div className="space-y-3">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="flex items-center gap-2">
                            <Activity className="w-4 h-4 text-slate-500" />
                            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">Your API Usage</h2>
                        </div>
                        {stats.week_orders > 0 && (
                            <p className="text-[11px] sm:text-xs text-slate-500 dark:text-slate-400">
                                <span className="font-semibold text-slate-700 dark:text-slate-300">{stats.week_orders}</span> orders ·{' '}
                                <span className="font-semibold text-slate-700 dark:text-slate-300">GH₵ {stats.week_spent.toFixed(2)}</span> spent this week
                            </p>
                        )}
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5 sm:gap-3">
                        <StatCard
                            icon={Wallet}
                            label="Total Spent"
                            value={`GH₵ ${stats.total_spent.toFixed(2)}`}
                            accent="violet"
                        />
                        <StatCard
                            icon={ShoppingCart}
                            label="Total Orders"
                            value={stats.total_orders.toLocaleString()}
                            accent="slate"
                        />
                        <StatCard
                            icon={CheckCircle2}
                            label="Successful"
                            value={stats.success_orders.toLocaleString()}
                            accent="emerald"
                        />
                        <StatCard
                            icon={AlertOctagon}
                            label="Failed"
                            value={stats.failed_orders.toLocaleString()}
                            accent="red"
                        />
                        <StatCard
                            icon={Clock}
                            label="Pending"
                            value={stats.pending_orders.toLocaleString()}
                            accent="amber"
                            pulse={stats.pending_orders > 0}
                        />
                        <StatCard
                            icon={Percent}
                            label="Success Rate"
                            value={`${stats.success_rate}%`}
                            accent={stats.success_rate >= 90 ? 'emerald' : stats.success_rate >= 70 ? 'amber' : 'red'}
                        />
                        <StatCard
                            icon={TrendingUp}
                            label="Requests (24h)"
                            value={stats.requests_24h.toLocaleString()}
                            sub={`${stats.requests_7d.toLocaleString()} this week`}
                            accent="sky"
                        />
                        <StatCard
                            icon={Database}
                            label="Data Delivered"
                            value={`${stats.total_gb.toFixed(1)} GB`}
                            accent="slate"
                        />
                    </div>
                </div>
            )}

            {/* ── API Key Cards — one per key_type ─────────────────────────── */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                <ApiKeyCard
                    keyType="standard"
                    apiKey={standardKey}
                    userName={userName}
                    userEmail={userEmail}
                    userPhone={userPhone}
                    onGenerated={fetchKeyData}
                />
                <ApiKeyCard
                    keyType="commission"
                    apiKey={commissionKey}
                    userName={userName}
                    userEmail={userEmail}
                    userPhone={userPhone}
                    onGenerated={fetchKeyData}
                />
            </div>

            {/* ── Connection Details + Quick Start — side-by-side on lg ────── */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

                {/* Connection Details */}
                <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
                    <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-100 dark:border-slate-800">
                        <Wifi className="w-5 h-5 text-slate-500" />
                        <h2 className="text-sm font-semibold text-slate-900 dark:text-white">Connection Details</h2>
                    </div>
                    <div className="p-5 space-y-4">
                        <div>
                            <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest mb-2">Base URL</p>
                            <CodeBlock code="https://api.kingflexygh.com/api/v2" />
                        </div>
                        <div>
                            <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest mb-2">Authentication Header</p>
                            <CodeBlock code="Authorization: YOUR_API_KEY" />
                        </div>
                    </div>
                </div>

                {/* Quick Start */}
                <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
                    <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-100 dark:border-slate-800">
                        <Terminal className="w-5 h-5 text-slate-500" />
                        <h2 className="text-sm font-semibold text-slate-900 dark:text-white">Quick Start — Purchase Data</h2>
                    </div>
                    <div className="p-5 space-y-4">
                        {/* Language tabs */}
                        <div className="flex flex-wrap gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-xl w-fit">
                            {QUICK_START_TABS.map(tab => (
                                <button
                                    key={tab}
                                    onClick={() => setActiveTab(tab)}
                                    className={cn(
                                        'px-3 py-1.5 rounded-lg text-xs font-semibold transition-all duration-150',
                                        activeTab === tab
                                            ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm'
                                            : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'
                                    )}
                                >
                                    {tab}
                                </button>
                            ))}
                        </div>
                        <CodeBlock code={QUICK_START_CODE[activeTab]} label={activeTab} />
                        <p className="text-xs text-slate-500 dark:text-slate-400 pt-1">
                            Replace <code className="font-mono text-violet-600 dark:text-violet-400">YOUR_API_KEY</code> with your actual key. See the full reference below.
                        </p>
                    </div>
                </div>
            </div>

            {/* ── API Reference ───────────────────────────────────────────── */}
            <ApiReferenceSection standardKey={standardKey} commissionKey={commissionKey} />
        </div>
    )
}

// ── API Reference Section ─────────────────────────────────────────────────────
// v1 has been fully ported and eliminated (owner decision, 2026-08-31) — this
// is now the only live base URL. Every sample below interpolates ${API_BASE}
// rather than a hardcoded version, so the flip propagates automatically.
const API_BASE = 'https://api.kingflexygh.com/api/v2'
const API_KEY_PLACEHOLDER = 'kf_live_your_api_key_here'
const COMMISSION_KEY_PLACEHOLDER = 'kf_cs_live_your_commission_key_here'

function ApiRefTable({ head, rows }: { head: string[]; rows: (string | React.ReactNode)[][] }) {
    return (
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden">
            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="bg-slate-50 dark:bg-slate-800/50">
                            {head.map(h => <th key={h} className="text-left px-5 py-3 text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest">{h}</th>)}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                        {rows.map((row, i) => (
                            <tr key={i} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/30 transition-colors">
                                {row.map((cell, j) => <td key={j} className="px-5 py-3 text-slate-700 dark:text-slate-300">{cell}</td>)}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    )
}

// ── Endpoint samples ──────────────────────────────────────────────────────────
const PKG_SAMPLES: Record<ApiLangTab, string> = {
    'cURL': `# All packages\ncurl -X GET ${API_BASE}/packages \\\n  -H "Authorization: ${API_KEY_PLACEHOLDER}"\n\n# Filter by network\ncurl -X GET "${API_BASE}/packages?network=MTN" \\\n  -H "Authorization: ${API_KEY_PLACEHOLDER}"`,
    'Node.js': `const res = await fetch('${API_BASE}/packages', {\n  headers: { 'Authorization': '${API_KEY_PLACEHOLDER}' },\n});\nconsole.log(await res.json());`,
    'PHP': `<?php\n$ch = curl_init('${API_BASE}/packages?network=MTN');\ncurl_setopt_array($ch, [\n  CURLOPT_RETURNTRANSFER => true,\n  CURLOPT_HTTPHEADER => ['Authorization: ${API_KEY_PLACEHOLDER}'],\n]);\necho curl_exec($ch); curl_close($ch);`,
    'Python': `import requests\nr = requests.get('${API_BASE}/packages',\n  headers={'Authorization': '${API_KEY_PLACEHOLDER}'})\nprint(r.json())`,
}

const PURCHASE_API_SAMPLES: Record<ApiLangTab, string> = {
    'cURL': `curl -X POST ${API_BASE}/data/purchase \\\n  -H "Authorization: ${API_KEY_PLACEHOLDER}" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "network": "MTN",\n    "volume_gb": 5,\n    "recipient": "0551617309",\n    "reference": "order_001"\n  }'`,
    'Node.js': `const res = await fetch('${API_BASE}/data/purchase', {\n  method: 'POST',\n  headers: {\n    'Authorization': '${API_KEY_PLACEHOLDER}',\n    'Content-Type': 'application/json',\n  },\n  body: JSON.stringify({\n    network: 'MTN', volume_gb: 5,\n    recipient: '0551617309', reference: 'order_001',\n  }),\n});\nconsole.log(await res.json());`,
    'PHP': `<?php\n$ch = curl_init('${API_BASE}/data/purchase');\ncurl_setopt_array($ch, [\n  CURLOPT_RETURNTRANSFER => true, CURLOPT_POST => true,\n  CURLOPT_HTTPHEADER => ['Authorization: ${API_KEY_PLACEHOLDER}', 'Content-Type: application/json'],\n  CURLOPT_POSTFIELDS => json_encode([\n    'network' => 'MTN', 'volume_gb' => 5,\n    'recipient' => '0551617309', 'reference' => 'order_001',\n  ]),\n]);\necho curl_exec($ch); curl_close($ch);`,
    'Python': `import requests\nr = requests.post('${API_BASE}/data/purchase',\n  headers={'Authorization': '${API_KEY_PLACEHOLDER}'},\n  json={'network':'MTN','volume_gb':5,'recipient':'0551617309','reference':'order_001'}\n)\nprint(r.json())`,
}

const BULK_API_SAMPLES: Record<ApiLangTab, string> = {
    'cURL': `curl -X POST ${API_BASE}/data/bulk \\\n  -H "Authorization: ${API_KEY_PLACEHOLDER}" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "orders": [\n      {"network":"MTN","volume_gb":5,"recipient":"0551617309","reference":"b_001"},\n      {"network":"Telecel","volume_gb":2,"recipient":"0201234567","reference":"b_002"}\n    ]\n  }'`,
    'Node.js': `const res = await fetch('${API_BASE}/data/bulk', {\n  method: 'POST',\n  headers: { 'Authorization': '${API_KEY_PLACEHOLDER}', 'Content-Type': 'application/json' },\n  body: JSON.stringify({ orders: [\n    { network: 'MTN', volume_gb: 5, recipient: '0551617309', reference: 'b_001' },\n    { network: 'Telecel', volume_gb: 2, recipient: '0201234567', reference: 'b_002' },\n  ]}),\n});\nconsole.log(await res.json());`,
    'PHP': `<?php\n$ch = curl_init('${API_BASE}/data/bulk');\ncurl_setopt_array($ch, [\n  CURLOPT_RETURNTRANSFER => true, CURLOPT_POST => true,\n  CURLOPT_HTTPHEADER => ['Authorization: ${API_KEY_PLACEHOLDER}','Content-Type: application/json'],\n  CURLOPT_POSTFIELDS => json_encode(['orders' => [\n    ['network'=>'MTN','volume_gb'=>5,'recipient'=>'0551617309','reference'=>'b_001'],\n    ['network'=>'Telecel','volume_gb'=>2,'recipient'=>'0201234567','reference'=>'b_002'],\n  ]]),\n]);\necho curl_exec($ch); curl_close($ch);`,
    'Python': `import requests\nr = requests.post('${API_BASE}/data/bulk',\n  headers={'Authorization': '${API_KEY_PLACEHOLDER}'},\n  json={'orders': [\n    {'network':'MTN','volume_gb':5,'recipient':'0551617309','reference':'b_001'},\n    {'network':'Telecel','volume_gb':2,'recipient':'0201234567','reference':'b_002'},\n  ]}\n)\nprint(r.json())`,
}

function verifyApiSamples(path: string): Record<ApiLangTab, string> {
    return {
        'cURL': `curl -X POST ${API_BASE}${path} \\\n  -H "Authorization: ${API_KEY_PLACEHOLDER}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"network":"MTN","recipient":"0551617309"}'`,
        'Node.js': `const res = await fetch('${API_BASE}${path}', {\n  method: 'POST',\n  headers: { 'Authorization': '${API_KEY_PLACEHOLDER}', 'Content-Type': 'application/json' },\n  body: JSON.stringify({ network: 'MTN', recipient: '0551617309' }),\n});\nconsole.log(await res.json());`,
        'PHP': `<?php\n$ch = curl_init('${API_BASE}${path}');\ncurl_setopt_array($ch, [\n  CURLOPT_RETURNTRANSFER => true, CURLOPT_POST => true,\n  CURLOPT_HTTPHEADER => ['Authorization: ${API_KEY_PLACEHOLDER}', 'Content-Type: application/json'],\n  CURLOPT_POSTFIELDS => json_encode(['network' => 'MTN', 'recipient' => '0551617309']),\n]);\necho curl_exec($ch); curl_close($ch);`,
        'Python': `import requests\nr = requests.post('${API_BASE}${path}',\n  headers={'Authorization': '${API_KEY_PLACEHOLDER}'},\n  json={'network': 'MTN', 'recipient': '0551617309'}\n)\nprint(r.json())`,
    }
}

const VERIFY_API_SAMPLES = verifyApiSamples('/data/verify-number')
const VERIFY_S1_API_SAMPLES = verifyApiSamples('/data/verify-number/server-1')
const VERIFY_S2_API_SAMPLES = verifyApiSamples('/data/verify-number/server-2')

const BALANCE_API_SAMPLES: Record<ApiLangTab, string> = {
    'cURL': `curl -X GET ${API_BASE}/wallet/balance \\\n  -H "Authorization: ${API_KEY_PLACEHOLDER}"`,
    'Node.js': `const res = await fetch('${API_BASE}/wallet/balance', {\n  headers: { 'Authorization': '${API_KEY_PLACEHOLDER}' },\n});\nconsole.log(await res.json());`,
    'PHP': `<?php\n$ch = curl_init('${API_BASE}/wallet/balance');\ncurl_setopt_array($ch, [\n  CURLOPT_RETURNTRANSFER => true,\n  CURLOPT_HTTPHEADER => ['Authorization: ${API_KEY_PLACEHOLDER}'],\n]);\necho curl_exec($ch); curl_close($ch);`,
    'Python': `import requests\nr = requests.get('${API_BASE}/wallet/balance',\n  headers={'Authorization': '${API_KEY_PLACEHOLDER}'})\nprint(r.json())`,
}

const STATUS_API_SAMPLES: Record<ApiLangTab, string> = {
    'cURL': `curl -X GET ${API_BASE}/orders/your_reference_here \\\n  -H "Authorization: ${API_KEY_PLACEHOLDER}"`,
    'Node.js': `const ref = 'your_reference_here';\nconst res = await fetch(\`${API_BASE}/orders/\${ref}\`, {\n  headers: { 'Authorization': '${API_KEY_PLACEHOLDER}' },\n});\nconsole.log(await res.json());`,
    'PHP': `<?php\n$ref = 'your_reference_here';\n$ch = curl_init("${API_BASE}/orders/$ref");\ncurl_setopt_array($ch, [\n  CURLOPT_RETURNTRANSFER => true,\n  CURLOPT_HTTPHEADER => ['Authorization: ${API_KEY_PLACEHOLDER}'],\n]);\necho curl_exec($ch); curl_close($ch);`,
    'Python': `import requests\nref = 'your_reference_here'\nr = requests.get(f'${API_BASE}/orders/{ref}',\n  headers={'Authorization': '${API_KEY_PLACEHOLDER}'})\nprint(r.json())`,
}

// ── Utility Bills (Commission) samples ────────────────────────────────────────
const UTIL_BILLERS_SAMPLES: Record<ApiLangTab, string> = {
    'cURL': `curl -X GET ${API_BASE}/utilities/billers \\\n  -H "Authorization: ${COMMISSION_KEY_PLACEHOLDER}"`,
    'Node.js': `const res = await fetch('${API_BASE}/utilities/billers', {\n  headers: { 'Authorization': '${COMMISSION_KEY_PLACEHOLDER}' },\n});\nconsole.log(await res.json());`,
    'PHP': `<?php\n$ch = curl_init('${API_BASE}/utilities/billers');\ncurl_setopt_array($ch, [\n  CURLOPT_RETURNTRANSFER => true,\n  CURLOPT_HTTPHEADER => ['Authorization: ${COMMISSION_KEY_PLACEHOLDER}'],\n]);\necho curl_exec($ch); curl_close($ch);`,
    'Python': `import requests\nr = requests.get('${API_BASE}/utilities/billers',\n  headers={'Authorization': '${COMMISSION_KEY_PLACEHOLDER}'})\nprint(r.json())`,
}

const UTIL_LOOKUP_SAMPLES: Record<ApiLangTab, string> = {
    'cURL': `# DSTV — query by smartcard number\ncurl -X GET "${API_BASE}/utilities/lookup?biller=dstv&account=7041234567" \\\n  -H "Authorization: ${COMMISSION_KEY_PLACEHOLDER}"\n\n# ECG — query by phone (account still required; pass the same number)\ncurl -X GET "${API_BASE}/utilities/lookup?biller=ecg&phone=0551617309&account=0551617309" \\\n  -H "Authorization: ${COMMISSION_KEY_PLACEHOLDER}"`,
    'Node.js': `const params = new URLSearchParams({ biller: 'dstv', account: '7041234567' });\nconst res = await fetch(\`${API_BASE}/utilities/lookup?\${params}\`, {\n  headers: { 'Authorization': '${COMMISSION_KEY_PLACEHOLDER}' },\n});\nconsole.log(await res.json());`,
    'PHP': `<?php\n$qs = http_build_query(['biller' => 'dstv', 'account' => '7041234567']);\n$ch = curl_init("${API_BASE}/utilities/lookup?$qs");\ncurl_setopt_array($ch, [\n  CURLOPT_RETURNTRANSFER => true,\n  CURLOPT_HTTPHEADER => ['Authorization: ${COMMISSION_KEY_PLACEHOLDER}'],\n]);\necho curl_exec($ch); curl_close($ch);`,
    'Python': `import requests\nr = requests.get('${API_BASE}/utilities/lookup',\n  headers={'Authorization': '${COMMISSION_KEY_PLACEHOLDER}'},\n  params={'biller': 'dstv', 'account': '7041234567'})\nprint(r.json())`,
}

const UTIL_PAY_SAMPLES: Record<ApiLangTab, string> = {
    'cURL': `# DSTV — account-only biller\ncurl -X POST ${API_BASE}/utilities/pay \\\n  -H "Authorization: ${COMMISSION_KEY_PLACEHOLDER}" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "biller": "dstv",\n    "account": "7041234567",\n    "amount": 65.00,\n    "reference": "bill_dstv_7041234567_01"\n  }'\n\n# ECG — account is the METER (from lookup meters[]), phone is required too\ncurl -X POST ${API_BASE}/utilities/pay \\\n  -H "Authorization: ${COMMISSION_KEY_PLACEHOLDER}" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "biller": "ecg",\n    "account": "3701234567",\n    "phone": "0551617309",\n    "amount": 50.00,\n    "reference": "bill_ecg_3701234567_01"\n  }'`,
    'Node.js': `const res = await fetch('${API_BASE}/utilities/pay', {\n  method: 'POST',\n  headers: {\n    'Authorization': '${COMMISSION_KEY_PLACEHOLDER}',\n    'Content-Type': 'application/json',\n  },\n  body: JSON.stringify({\n    biller: 'dstv',\n    account: '7041234567',\n    amount: 65.00,\n    reference: 'bill_dstv_7041234567_01',\n  }),\n});\nconsole.log(await res.json());`,
    'PHP': `<?php\n$ch = curl_init('${API_BASE}/utilities/pay');\ncurl_setopt_array($ch, [\n  CURLOPT_RETURNTRANSFER => true, CURLOPT_POST => true,\n  CURLOPT_HTTPHEADER => ['Authorization: ${COMMISSION_KEY_PLACEHOLDER}', 'Content-Type: application/json'],\n  CURLOPT_POSTFIELDS => json_encode([\n    'biller' => 'dstv', 'account' => '7041234567',\n    'amount' => 65.00, 'reference' => 'bill_dstv_7041234567_01',\n  ]),\n]);\necho curl_exec($ch); curl_close($ch);`,
    'Python': `import requests\nr = requests.post('${API_BASE}/utilities/pay',\n  headers={'Authorization': '${COMMISSION_KEY_PLACEHOLDER}'},\n  json={\n    'biller': 'dstv', 'account': '7041234567',\n    'amount': 65.00, 'reference': 'bill_dstv_7041234567_01',\n  }\n)\nprint(r.json())`,
}

const UTIL_STATUS_SAMPLES: Record<ApiLangTab, string> = {
    'cURL': `curl -X GET ${API_BASE}/utilities/orders/UTIL-DSTV-3f9a2b1c4d5e6f70 \\\n  -H "Authorization: ${COMMISSION_KEY_PLACEHOLDER}"`,
    'Node.js': `const ref = 'UTIL-DSTV-3f9a2b1c4d5e6f70'; // the reference from the /pay response\nconst res = await fetch(\`${API_BASE}/utilities/orders/\${ref}\`, {\n  headers: { 'Authorization': '${COMMISSION_KEY_PLACEHOLDER}' },\n});\nconsole.log(await res.json());`,
    'PHP': `<?php\n$ref = 'UTIL-DSTV-3f9a2b1c4d5e6f70';\n$ch = curl_init("${API_BASE}/utilities/orders/$ref");\ncurl_setopt_array($ch, [\n  CURLOPT_RETURNTRANSFER => true,\n  CURLOPT_HTTPHEADER => ['Authorization: ${COMMISSION_KEY_PLACEHOLDER}'],\n]);\necho curl_exec($ch); curl_close($ch);`,
    'Python': `import requests\nref = 'UTIL-DSTV-3f9a2b1c4d5e6f70'\nr = requests.get(f'${API_BASE}/utilities/orders/{ref}',\n  headers={'Authorization': '${COMMISSION_KEY_PLACEHOLDER}'})\nprint(r.json())`,
}

// ── Airtime (Commission) samples ──────────────────────────────────────────────
const AIRTIME_PURCHASE_SAMPLES: Record<ApiLangTab, string> = {
    'cURL': `curl -X POST ${API_BASE}/airtime/purchase \\\n  -H "Authorization: ${COMMISSION_KEY_PLACEHOLDER}" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "network": "MTN",\n    "beneficiary_phone": "0551617309",\n    "amount": 20.00,\n    "reference": "airtime_001"\n  }'`,
    'Node.js': `const res = await fetch('${API_BASE}/airtime/purchase', {\n  method: 'POST',\n  headers: {\n    'Authorization': '${COMMISSION_KEY_PLACEHOLDER}',\n    'Content-Type': 'application/json',\n  },\n  body: JSON.stringify({\n    network: 'MTN',\n    beneficiary_phone: '0551617309',\n    amount: 20.00,\n    reference: 'airtime_001',\n  }),\n});\nconsole.log(await res.json());`,
    'PHP': `<?php\n$ch = curl_init('${API_BASE}/airtime/purchase');\ncurl_setopt_array($ch, [\n  CURLOPT_RETURNTRANSFER => true, CURLOPT_POST => true,\n  CURLOPT_HTTPHEADER => ['Authorization: ${COMMISSION_KEY_PLACEHOLDER}', 'Content-Type: application/json'],\n  CURLOPT_POSTFIELDS => json_encode([\n    'network' => 'MTN', 'beneficiary_phone' => '0551617309',\n    'amount' => 20.00, 'reference' => 'airtime_001',\n  ]),\n]);\necho curl_exec($ch); curl_close($ch);`,
    'Python': `import requests\nr = requests.post('${API_BASE}/airtime/purchase',\n  headers={'Authorization': '${COMMISSION_KEY_PLACEHOLDER}'},\n  json={\n    'network': 'MTN', 'beneficiary_phone': '0551617309',\n    'amount': 20.00, 'reference': 'airtime_001',\n  }\n)\nprint(r.json())`,
}

const AIRTIME_ORDERS_SAMPLES: Record<ApiLangTab, string> = {
    'cURL': `# All recent orders\ncurl -X GET ${API_BASE}/airtime/orders \\\n  -H "Authorization: ${COMMISSION_KEY_PLACEHOLDER}"\n\n# Filter by status\ncurl -X GET "${API_BASE}/airtime/orders?status=completed" \\\n  -H "Authorization: ${COMMISSION_KEY_PLACEHOLDER}"`,
    'Node.js': `const res = await fetch('${API_BASE}/airtime/orders?status=completed', {\n  headers: { 'Authorization': '${COMMISSION_KEY_PLACEHOLDER}' },\n});\nconsole.log(await res.json());`,
    'PHP': `<?php\n$ch = curl_init('${API_BASE}/airtime/orders?status=completed');\ncurl_setopt_array($ch, [\n  CURLOPT_RETURNTRANSFER => true,\n  CURLOPT_HTTPHEADER => ['Authorization: ${COMMISSION_KEY_PLACEHOLDER}'],\n]);\necho curl_exec($ch); curl_close($ch);`,
    'Python': `import requests\nr = requests.get('${API_BASE}/airtime/orders',\n  headers={'Authorization': '${COMMISSION_KEY_PLACEHOLDER}'},\n  params={'status': 'completed'})\nprint(r.json())`,
}

const AIRTIME_STATUS_SAMPLES: Record<ApiLangTab, string> = {
    'cURL': `curl -X GET ${API_BASE}/airtime/orders/airtime_001 \\\n  -H "Authorization: ${COMMISSION_KEY_PLACEHOLDER}"`,
    'Node.js': `const ref = 'airtime_001';\nconst res = await fetch(\`${API_BASE}/airtime/orders/\${ref}\`, {\n  headers: { 'Authorization': '${COMMISSION_KEY_PLACEHOLDER}' },\n});\nconsole.log(await res.json());`,
    'PHP': `<?php\n$ref = 'airtime_001';\n$ch = curl_init("${API_BASE}/airtime/orders/$ref");\ncurl_setopt_array($ch, [\n  CURLOPT_RETURNTRANSFER => true,\n  CURLOPT_HTTPHEADER => ['Authorization: ${COMMISSION_KEY_PLACEHOLDER}'],\n]);\necho curl_exec($ch); curl_close($ch);`,
    'Python': `import requests\nref = 'airtime_001'\nr = requests.get(f'${API_BASE}/airtime/orders/{ref}',\n  headers={'Authorization': '${COMMISSION_KEY_PLACEHOLDER}'})\nprint(r.json())`,
}

// ── Reference tabs, one per key type (+ Webhooks) ───────────────────────────
// Each tab carries its own table of contents as an internal sidebar: pinned
// beside the content on desktop (lg+), collapsed behind a toggle button on
// mobile. Rebuilt this way (rather than one long scroll) because the page
// had grown to cover 9 endpoints across two products plus webhook config —
// exactly the point where a flat list stops being navigable.
type RefTabKey = 'standard' | 'commission' | 'webhooks'

const REF_TABS: { key: RefTabKey; label: string; icon: any }[] = [
    { key: 'standard', label: 'Standard API', icon: Key },
    { key: 'commission', label: 'Commission API', icon: Percent },
    { key: 'webhooks', label: 'Webhooks', icon: Webhook },
]

const REF_TOC: Record<RefTabKey, { id: string; label: string }[]> = {
    standard: [
        { id: 'ref-std-baseurl', label: 'Base URL' },
        { id: 'ref-std-packages', label: 'GET /packages' },
        { id: 'ref-std-purchase', label: 'POST /data/purchase' },
        { id: 'ref-std-bulk', label: 'POST /data/bulk' },
        { id: 'ref-std-verify-s1', label: 'POST /data/verify-number/server-1' },
        { id: 'ref-std-verify-s2', label: 'POST /data/verify-number/server-2' },
        { id: 'ref-std-verify', label: 'POST /data/verify-number' },
        { id: 'ref-std-balance', label: 'GET /wallet/balance' },
        { id: 'ref-std-status', label: 'GET /orders/:reference' },
        { id: 'ref-std-meta', label: 'Networks & Errors' },
    ],
    commission: [
        { id: 'ref-com-intro', label: 'Overview' },
        { id: 'ref-com-billers', label: 'GET /utilities/billers' },
        { id: 'ref-com-lookup', label: 'GET /utilities/lookup' },
        { id: 'ref-com-pay', label: 'POST /utilities/pay' },
        { id: 'ref-com-status', label: 'GET /utilities/orders/:reference' },
        { id: 'ref-com-airtime-purchase', label: 'POST /airtime/purchase' },
        { id: 'ref-com-airtime-orders', label: 'GET /airtime/orders' },
        { id: 'ref-com-airtime-status', label: 'GET /airtime/orders/:reference' },
        { id: 'ref-com-meta', label: 'Rate Limits & Errors' },
    ],
    webhooks: [
        { id: 'ref-wh-intro', label: 'How webhooks work' },
        { id: 'ref-wh-config', label: 'Configure your endpoint' },
        { id: 'ref-wh-events', label: 'Event types' },
        { id: 'ref-wh-payload', label: 'Payload shape' },
        { id: 'ref-wh-verify', label: 'Verifying signatures' },
    ],
}

function scrollToSection(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

const SIGNATURE_VERIFY_SAMPLES: Record<ApiLangTab, string> = {
    'cURL': `# Signature verification isn't a curl operation — see the Node.js /\n# PHP / Python tabs. Your endpoint receives:\n#   X-KFT-Signature: <hex hmac-sha256>\n# computed over the exact raw request body using your webhook secret.`,
    'Node.js': `const crypto = require('crypto');\n\nfunction isValidSignature(rawBody, signatureHeader, secret) {\n  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');\n  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));\n}\n\n// Express example — use a raw-body parser, NOT the parsed JSON, since the\n// signature is computed over the exact bytes we sent.\napp.post('/webhooks/kingflexy', express.raw({ type: 'application/json' }), (req, res) => {\n  const signature = req.headers['x-kft-signature'];\n  if (!isValidSignature(req.body, signature, process.env.KF_WEBHOOK_SECRET)) {\n    return res.status(401).send('invalid signature');\n  }\n  const event = JSON.parse(req.body);\n  // ... handle event.event / event.product / event.reference / event.status\n  res.sendStatus(200);\n});`,
    'PHP': `<?php\n$rawBody = file_get_contents('php://input');\n$signature = $_SERVER['HTTP_X_KFT_SIGNATURE'] ?? '';\n$expected = hash_hmac('sha256', $rawBody, getenv('KF_WEBHOOK_SECRET'));\n\nif (!hash_equals($expected, $signature)) {\n    http_response_code(401);\n    exit('invalid signature');\n}\n\n$event = json_decode($rawBody, true);\n// ... handle $event['event'] / $event['product'] / $event['reference'] / $event['status']\nhttp_response_code(200);`,
    'Python': `import hmac, hashlib\n\ndef is_valid_signature(raw_body: bytes, signature_header: str, secret: str) -> bool:\n    expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()\n    return hmac.compare_digest(expected, signature_header)\n\n# Flask example\n@app.route('/webhooks/kingflexy', methods=['POST'])\ndef webhook():\n    raw_body = request.get_data()\n    signature = request.headers.get('X-KFT-Signature', '')\n    if not is_valid_signature(raw_body, signature, os.environ['KF_WEBHOOK_SECRET']):\n        return 'invalid signature', 401\n    event = request.get_json()\n    # ... handle event['event'] / event['product'] / event['reference'] / event['status']\n    return '', 200`,
}

function ApiReferenceSection({ standardKey, commissionKey }: { standardKey: ApiKeyMeta | null; commissionKey: ApiKeyMeta | null }) {
    const [activeTab, setActiveTab] = useState<RefTabKey>('standard')
    const [mobileTocOpen, setMobileTocOpen] = useState(false)

    return (
        <div className="space-y-6 w-full">
            {/* Section header */}
            <div className="flex items-center gap-3 pt-2">
                <div className="flex-1 h-px bg-slate-200 dark:bg-slate-800" />
                <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
                    <BookOpen className="w-4 h-4 text-violet-500" />
                    <span className="text-sm font-bold text-slate-700 dark:text-slate-200">API Reference</span>
                </div>
                <div className="flex-1 h-px bg-slate-200 dark:bg-slate-800" />
            </div>

            {/* Tab bar — one tab per key type, plus Webhooks */}
            <div className="flex flex-wrap items-center justify-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-2xl w-fit mx-auto">
                {REF_TABS.map(tab => (
                    <button
                        key={tab.key}
                        onClick={() => { setActiveTab(tab.key); setMobileTocOpen(false) }}
                        className={cn(
                            'flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold transition-all duration-150',
                            activeTab === tab.key
                                ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm'
                                : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'
                        )}
                    >
                        <tab.icon className="w-4 h-4" />
                        {tab.label}
                    </button>
                ))}
            </div>

            {/* Mobile TOC toggle */}
            <button
                onClick={() => setMobileTocOpen(o => !o)}
                className="lg:hidden flex items-center justify-between w-full px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-sm font-semibold text-slate-700 dark:text-slate-200"
            >
                <span className="flex items-center gap-2"><Menu className="w-4 h-4" /> On this page</span>
                {mobileTocOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            </button>
            {mobileTocOpen && (
                <nav className="lg:hidden rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-2">
                    {REF_TOC[activeTab].map(item => (
                        <button
                            key={item.id}
                            onClick={() => { scrollToSection(item.id); setMobileTocOpen(false) }}
                            className="block w-full text-left px-3 py-2 rounded-lg text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                            {item.label}
                        </button>
                    ))}
                </nav>
            )}

            {/* Sidebar (desktop, always open) + content */}
            <div className="grid grid-cols-1 lg:grid-cols-[200px_1fr] gap-6 items-start">
                <nav className="hidden lg:block sticky top-6 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-2">
                    <p className="px-3 py-2 text-[11px] font-bold text-slate-400 uppercase tracking-widest">On this page</p>
                    {REF_TOC[activeTab].map(item => (
                        <button
                            key={item.id}
                            onClick={() => scrollToSection(item.id)}
                            className="block w-full text-left px-3 py-1.5 rounded-lg text-[13px] text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white transition-colors"
                        >
                            {item.label}
                        </button>
                    ))}
                </nav>

                <div className="space-y-6 min-w-0">
                    {activeTab === 'standard' && <StandardApiTab />}
                    {activeTab === 'commission' && <CommissionApiTab />}
                    {activeTab === 'webhooks' && <WebhooksTab standardKey={standardKey} commissionKey={commissionKey} />}
                </div>
            </div>
        </div>
    )
}

function StandardApiTab() {
    return (
        <>
            <p className="text-sm text-slate-500 dark:text-slate-400">
                5 endpoints for buying data bundles. Replace <code className="font-mono text-violet-600 dark:text-violet-400 text-xs">kf_live_your_api_key_here</code> with your actual standard key.
            </p>

            {/* Base URL strip */}
            <div id="ref-std-baseurl" className="flex items-center gap-3 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-5 py-3.5 flex-wrap scroll-mt-6">
                <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">Base URL</span>
                <code className="text-sm font-mono text-slate-800 dark:text-slate-100 flex-1">{API_BASE}</code>
                <ApiCopyBtn text={API_BASE} />
            </div>

            {/* Endpoints */}
            <div id="ref-std-packages" className="scroll-mt-6">
            <ApiEndpointBlock
                method="GET" path="/api/v2/packages"
                description="List available data packages with pricing for your account role. Use this to discover valid network/size combinations before placing orders."
                queryParams={[
                    { name: 'network', type: 'string', required: false, desc: 'Filter: MTN | Telecel | AT-iShare | AT-BigTime' },
                    { name: 'size_gb', type: 'number', required: false, desc: 'Filter by exact size e.g. 5' },
                ]}
                responseBody={`{\n  "success": true,\n  "data": {\n    "packages": [\n      {\n        "id": "uuid-...",\n        "network": "MTN",\n        "size": "5GB",\n        "volume_gb": 5,\n        "price": 4.50,\n        "currency": "GHS"\n      }\n    ],\n    "total": 12\n  }\n}`}
                notes={['Price shown is your role-specific price (agent, dealer, or standard).', 'Only available packages are returned.', 'Call this first to avoid 404 errors on purchase.']}
                samples={PKG_SAMPLES}
            />
            </div>

            <div id="ref-std-purchase" className="scroll-mt-6">
            <ApiEndpointBlock
                method="POST" path="/api/v2/data/purchase"
                description="Purchase a single data bundle. Deducts from your wallet atomically."
                requestBody={`{\n  "network": "MTN",\n  "volume_gb": 5,\n  "recipient": "0551617309",\n  "reference": "order_001"\n}`}
                responseBody={`{\n  "success": true,\n  "data": {\n    "order_id": "uuid-...",\n    "reference": "order_001",\n    "status": "pending",\n    "network": "MTN",\n    "size": "5GB",\n    "recipient": "0551617309",\n    "price": 4.50,\n    "new_balance": 120.50\n  }\n}`}
                notes={[
                    'reference is your idempotency key — sending the same reference twice returns the existing order without charging.',
                    'network is case-sensitive: MTN, Telecel, AT-iShare, AT-BigTime.',
                    'recipient must be 0XXXXXXXXX (10 digits, starts with 0).',
                ]}
                samples={PURCHASE_API_SAMPLES}
            />
            </div>

            <div id="ref-std-bulk" className="scroll-mt-6">
            <ApiEndpointBlock
                method="POST" path="/api/v2/data/bulk"
                description="Purchase up to 100 data bundles in one atomic batch. All orders succeed or none are charged."
                requestBody={`{\n  "orders": [\n    { "network": "MTN", "volume_gb": 5, "recipient": "0551617309", "reference": "b_001" },\n    { "network": "Telecel", "volume_gb": 2, "recipient": "0201234567", "reference": "b_002" }\n  ]\n}`}
                responseBody={`{\n  "success": true,\n  "data": {\n    "orders_placed": 2,\n    "total_cost": 7.00,\n    "new_balance": 113.50,\n    "orders": [{ "order_id": "...", "status": "pending", "reference": "b_001" }]\n  }\n}`}
                notes={['Max 100 orders per request.', 'Atomic: if any order fails validation, none are placed.']}
                samples={BULK_API_SAMPLES}
            />
            </div>

            <div id="ref-std-verify-s1" className="scroll-mt-6">
            <ApiEndpointBlock
                method="POST" path="/api/v2/data/verify-number/server-1"
                description="The actual registration state on Server 1 — tells you whether an MTN number is registered on Server 1 specifically. If only Server 1 is currently accepted, use it as your checkout gate."
                requestBody={`{\n  "network": "MTN",\n  "recipient": "0551617309"\n}`}
                responseBody={`{\n  "success": true,\n  "data": {\n    "recipient": "0551617309",\n    "network": "MTN",\n    "server": 1,\n    "allowed": true\n  }\n}`}
                notes={[
                    'A number can be registered on one server and not the other. Watch platform announcements for which server(s) are currently accepted.',
                    'An unregistered number is automatically submitted for registration — check again soon (no fixed turnaround).',
                    'Does not fail open: if Server 1 cannot be reached it returns 502 instead of a guess.',
                    'Rate limit: 20/min per key, shared across all three verify-number endpoints.',
                ]}
                samples={VERIFY_S1_API_SAMPLES}
            />
            </div>

            <div id="ref-std-verify-s2" className="scroll-mt-6">
            <ApiEndpointBlock
                method="POST" path="/api/v2/data/verify-number/server-2"
                description="The actual registration state on Server 2 — tells you whether an MTN number is registered on Server 2 specifically. If only Server 2 is currently accepted, use it as your checkout gate."
                requestBody={`{\n  "network": "MTN",\n  "recipient": "0551617309"\n}`}
                responseBody={`{\n  "success": true,\n  "data": {\n    "recipient": "0551617309",\n    "network": "MTN",\n    "server": 2,\n    "allowed": false\n  }\n}`}
                notes={[
                    'A number can be registered on one server and not the other. Watch platform announcements for which server(s) are currently accepted.',
                    'An unregistered number is automatically submitted for registration — check again soon (no fixed turnaround).',
                    'Does not fail open: if Server 2 cannot be reached it returns 502 instead of a guess.',
                    'Rate limit: 20/min per key, shared across all three verify-number endpoints.',
                ]}
                samples={VERIFY_S2_API_SAMPLES}
            />
            </div>

            <div id="ref-std-verify" className="scroll-mt-6">
            <ApiEndpointBlock
                method="POST" path="/api/v2/data/verify-number"
                description="Server 1 and Server 2 combined — allowed: true when the number is registered on either. Use it as your checkout gate only when both servers are announced as accepted; otherwise check the accepted server's endpoint. It does not say which server holds the number — use the server endpoints for that."
                requestBody={`{\n  "network": "MTN",\n  "recipient": "0551617309"\n}`}
                responseBody={`{\n  "success": true,\n  "data": {\n    "recipient": "0551617309",\n    "network": "MTN",\n    "allowed": true\n  }\n}`}
                notes={[
                    'Follows the server(s) the platform currently accepts, so it equals "Server 1 or Server 2" only while both are accepted.',
                    'Non-MTN networks always return allowed: true immediately.',
                    'Fails open on an upstream outage (allowed: true) — treat true as "likely fine to proceed"; /data/purchase re-verifies at order time.',
                    'Rate limit: 20/min per key, shared across all three verify-number endpoints.',
                ]}
                samples={VERIFY_API_SAMPLES}
            />
            </div>

            <div id="ref-std-balance" className="scroll-mt-6">
            <ApiEndpointBlock
                method="GET" path="/api/v2/wallet/balance"
                description="Retrieve your current wallet balance in GHS. Top up via the dashboard wallet page."
                responseBody={`{\n  "success": true,\n  "data": {\n    "balance": 124.50,\n    "currency": "GHS"\n  }\n}`}
                notes={['Top up at kingflexygh.com/dashboard/wallet.', 'Check before bulk orders to avoid insufficient balance failures.']}
                samples={BALANCE_API_SAMPLES}
            />
            </div>

            <div id="ref-std-status" className="scroll-mt-6">
            <ApiEndpointBlock
                method="GET" path="/api/v2/orders/{reference}"
                description="Check the fulfillment status of an order by its reference code."
                responseBody={`{\n  "success": true,\n  "data": {\n    "order_id": "uuid-...",\n    "reference": "order_001",\n    "status": "completed",\n    "network": "MTN",\n    "size": "5GB",\n    "recipient": "0551617309",\n    "price": 4.50,\n    "source": "api",\n    "created_at": "2026-..."\n  }\n}`}
                notes={['Status flow: pending → processing → completed | failed.', 'Poll this after placing an order to confirm delivery.']}
                samples={STATUS_API_SAMPLES}
            />
            </div>

            {/* Networks + Errors in 2 columns */}
            <div id="ref-std-meta" className="grid grid-cols-1 lg:grid-cols-2 gap-5 scroll-mt-6">
                <div className="space-y-3">
                    <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                        <Globe className="w-4 h-4 text-slate-400" /> Supported Networks
                    </h3>
                    <ApiRefTable
                        head={['Value', 'Provider']}
                        rows={[
                            [<code key="mtn" className="font-mono text-violet-600 dark:text-violet-400 text-xs">"MTN"</code>, 'MTN Ghana'],
                            [<code key="tel" className="font-mono text-violet-600 dark:text-violet-400 text-xs">"Telecel"</code>, 'Telecel Ghana'],
                            [<code key="at1" className="font-mono text-violet-600 dark:text-violet-400 text-xs">"AT-iShare"</code>, 'AirtelTigo iShare'],
                            [<code key="at2" className="font-mono text-violet-600 dark:text-violet-400 text-xs">"AT-BigTime"</code>, 'AirtelTigo BigTime'],
                        ]}
                    />
                    <p className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2 pt-1">Number → Network Prefixes</p>
                    <ApiRefTable
                        head={['Network', 'Prefixes']}
                        rows={[
                            ['MTN', '024, 025, 053, 054, 055, 059'],
                            ['Telecel', '020, 050'],
                            ['AirtelTigo', '026, 027, 056, 057'],
                        ]}
                    />
                    <p className="text-xs text-amber-700 dark:text-amber-400 leading-relaxed">
                        Not guaranteed to stay fixed — operators occasionally get reassigned or new ranges opened. Don&apos;t
                        hardcode this list permanently; treat our API&apos;s response as the final word and re-check here
                        periodically.
                    </p>
                </div>
                <div className="space-y-3">
                    <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                        <AlertCircle className="w-4 h-4 text-slate-400" /> Error Codes
                    </h3>
                    <ApiRefTable
                        head={['Code', 'Meaning']}
                        rows={[
                            [<span key="400" className="font-mono font-bold text-red-500 text-xs">400</span>, 'Invalid request body or parameters'],
                            [<span key="401" className="font-mono font-bold text-red-500 text-xs">401</span>, 'Missing or invalid API key'],
                            [<span key="403" className="font-mono font-bold text-red-500 text-xs">403</span>, 'Key pending / revoked / role not allowed'],
                            [<span key="404" className="font-mono font-bold text-red-500 text-xs">404</span>, 'Package or order not found'],
                            [<span key="409" className="font-mono font-bold text-amber-500 text-xs">409</span>, 'Duplicate reference'],
                            [<span key="429" className="font-mono font-bold text-amber-500 text-xs">429</span>, 'Rate limit exceeded'],
                            [<span key="500" className="font-mono font-bold text-slate-400 text-xs">500</span>, 'Server error'],
                            [<span key="503" className="font-mono font-bold text-slate-400 text-xs">503</span>, 'API disabled by admin'],
                        ]}
                    />
                </div>
            </div>
        </>
    )
}

function CommissionApiTab() {
    return (
        <>
            <div id="ref-com-intro" className="scroll-mt-6 space-y-4">
            <div className="flex items-center gap-3">
                <div className="flex-1 h-px bg-slate-200 dark:bg-slate-800" />
                <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-violet-100 dark:bg-violet-900/30 border border-violet-200 dark:border-violet-700/40">
                    <Percent className="w-4 h-4 text-violet-500" />
                    <span className="text-sm font-bold text-violet-700 dark:text-violet-300">Utility Bills (Commission)</span>
                </div>
                <div className="flex-1 h-px bg-slate-200 dark:bg-slate-800" />
            </div>

            <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
                <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
                    Pay ECG, Ghana Water, DSTV, GOtv, or StarTimes bills — or send MTN, Telecel, or AT airtime — at face value on
                    behalf of your customers, and earn a share of KiNG FLEXY GH's provider commission on every transaction. This is a
                    separate product from the Data API above: the endpoints below only accept a{' '}
                    <strong className="text-slate-800 dark:text-slate-200">Commission Services key</strong> (prefix{' '}
                    <code className="font-mono text-violet-600 dark:text-violet-400 text-xs">kf_cs_live_...</code>), and reject a standard key
                    with <code className="font-mono text-slate-500 text-xs">403</code>. The reverse is also true — a Commission Services key is
                    rejected with <code className="font-mono text-slate-500 text-xs">403</code> on every other <code className="font-mono text-slate-500 text-xs">/api/v2/*</code> endpoint (packages, data purchases, wallet, SMS, etc.).
                </p>
                <div className="grid sm:grid-cols-2 gap-4">
                    <div className="rounded-xl bg-slate-50 dark:bg-slate-800/50 p-4">
                        <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2">Getting a Commission Services key</p>
                        <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                            Generate one from the Commission Services Key card above — no shop required. Your commission is paid into a
                            dedicated <strong>Commission Wallet</strong> (separate from shop earnings), viewable and withdrawable from{' '}
                            <a href="/dashboard/commission" className="underline">Dashboard → Commission</a>. Like the standard key, a new
                            commission key starts <code className="font-mono text-[11px]">pending</code> and needs admin approval before it works.
                        </p>
                    </div>
                    <div className="rounded-xl bg-slate-50 dark:bg-slate-800/50 p-4">
                        <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2">How the money moves</p>
                        <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                            The bill's face value is debited from your <strong>main wallet</strong> when you call <code className="font-mono text-[11px]">POST /pay</code>.
                            Once the order reaches <code className="font-mono text-[11px]">completed</code>, your{' '}
                            <code className="font-mono text-[11px]">commission_share_percent</code> cut of the platform's commission is credited
                            automatically to your <strong>Commission Wallet</strong> — transfer it instantly to your main or shop wallet, or withdraw it via Paystack Mobile Money.
                        </p>
                    </div>
                </div>
            </div>
            </div>

            <div id="ref-com-billers" className="scroll-mt-6">
            <ApiEndpointBlock
                method="GET" path="/api/v2/utilities/billers"
                description="Full biller catalog for utility bill payments — including currently disabled billers, so you can build your UI without hardcoding which ones are live."
                responseBody={`{\n  "success": true,\n  "data": {\n    "billers": [\n      {\n        "key": "ecg",\n        "label": "ECG Prepaid & Postpaid",\n        "enabled": true,\n        "account_label": "Meter number",\n        "requires_phone": true,\n        "lookup_by": "phone",\n        "links_phone_to_account": true,\n        "has_amount_due": true\n      },\n      {\n        "key": "dstv",\n        "label": "DSTV",\n        "enabled": true,\n        "account_label": "Smartcard number",\n        "requires_phone": false,\n        "lookup_by": "account",\n        "links_phone_to_account": false,\n        "has_amount_due": true\n      }\n    ],\n    "min_amount": 1,\n    "max_amount": 1000,\n    "currency": "GHS"\n  }\n}`}
                notes={[
                    'key values are: ecg, ghana_water, dstv, gotv, startimes — pass this exact string as biller on /lookup and /pay.',
                    'enabled is false for a biller currently switched off by an admin — still listed so your UI can grey it out instead of guessing.',
                    'lookup_by tells you which field ecg needs on /lookup ("phone") vs every other biller ("account").',
                    'requires_phone — whether /pay requires a customer phone for this biller (ecg, ghana_water). Note: /lookup accepts account alone for ecg (phone optional there).',
                    'links_phone_to_account is true only for ecg — one phone can be linked to more than one meter, so always let the customer pick from the meters array /lookup returns.',
                    'min_amount / max_amount are the live, admin-configurable limits enforced by /pay — read them from here instead of hardcoding GHS 1–1000.',
                ]}
                samples={UTIL_BILLERS_SAMPLES}
            />
            </div>

            <div id="ref-com-lookup" className="scroll-mt-6 space-y-6">
            <ApiEndpointBlock
                method="GET" path="/api/v2/utilities/lookup"
                description="Verify an account before paying. Always show your customer the returned name (or, for ECG, the linked meters) and get their confirmation before calling /pay."
                queryParams={[
                    { name: 'biller', type: 'string', required: true, desc: 'One of: ecg, ghana_water, dstv, gotv, startimes' },
                    { name: 'account', type: 'string', required: true, desc: 'Meter/smartcard/account number, max 30 chars. Required for every biller, including ecg — for ecg pass the phone number here too if you have no separate meter number, since the query actually runs on phone.' },
                    { name: 'phone', type: 'string', required: false, desc: 'Customer phone, max 30 chars. Required for ghana_water. For ecg, this is what the lookup actually queries by — supply it, not just account.' },
                ]}
                responseBody={`{\n  "success": true,\n  "data": {\n    "account_name": "KWAME MENSAH",\n    "account_number": "7041234567",\n    "amount_due": 245.80,\n    "bouquet": null,\n    "meters": []\n  }\n}`}
                notes={[
                    'ECG\'s shape differs from every other biller: account_name, account_number, amount_due and bouquet are always null — the real result is meters: [{ "name": "KWAME MENSAH", "meterNumber": "3701234567", "outstanding": 245.8 }, ...]. One phone can list several meters; let the customer choose the right one.',
                    'amount_due can be negative — that means the customer has a credit balance, not a bill due.',
                    '404 = account/meter/smartcard not found (bad number). 502 = the billing provider is temporarily unreachable — retry shortly, do not treat as "not found".',
                ]}
                samples={UTIL_LOOKUP_SAMPLES}
            />

            <div className="flex items-start gap-3 rounded-xl bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800/50 p-4">
                <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-amber-800 dark:text-amber-200 leading-relaxed">
                    <strong>reference on /pay is a pure idempotency key, not a distinct-payment key.</strong> Reusing the same reference — even with
                    a different biller, account, or amount — returns the details of the <strong>ORIGINAL</strong> order and never charges you again;
                    it does not re-validate against the new values you sent. Use a unique reference for every distinct bill. Reuse the same reference
                    ONLY to safely retry the exact same payment (e.g. after a network timeout).
                </p>
            </div>
            </div>

            <div id="ref-com-pay" className="scroll-mt-6">
            <ApiEndpointBlock
                method="POST" path="/api/v2/utilities/pay"
                description="Pay a bill at face value from your wallet. Auto-dispatches to the biller in the background — poll GET /orders/{reference} for the final status."
                requestBody={`{\n  "biller": "dstv",\n  "account": "7041234567",\n  "amount": 65.00,\n  "reference": "bill_dstv_7041234567_01"\n}`}
                responseBody={`{\n  "success": true,\n  "data": {\n    "reference": "UTIL-DSTV-3f9a2b1c4d5e6f70",\n    "order_id": "uuid-...",\n    "status": "pending",\n    "biller": "dstv",\n    "account": "7041234567",\n    "amount": 65.00,\n    "commission_share_percent": 40,\n    "new_balance": 435.00\n  }\n}`}
                notes={[
                    'reference is a pure idempotency key — see the callout above. It is optional, 1–64 chars of letters, numbers, dot, underscore or hyphen.',
                    'Save the reference from the RESPONSE, not the one you sent — it is our own generated code (UTIL-<BILLER>-<random>) and is what GET /orders/{reference} expects.',
                    'On an idempotent replay (reused reference), the response is smaller: { reference, order_id, status, already_processed: true } — no biller/account/amount/commission_share_percent/new_balance, since nothing new happened.',
                    'phone is required for ecg and ghana_water (omit for dstv/gotv/startimes). For ecg, account is the specific meter number from the /lookup meters array — not the phone.',
                    'amount must be within the live min_amount/max_amount from GET /billers (defaults GHS 1.00–1000.00).',
                    'Without a reference, sending the same biller + account + amount twice within 30 seconds is rejected with 409. If your first request timed out, reuse that request\'s original reference — you\'ll get the original order back via idempotent replay. A new reference does not bypass the 30-second window; genuinely distinct same-amount payments to the same account must wait it out.',
                    'commission_share_percent is your cut of the platform commission (admin-configurable) — it is credited to your shop wallet once the order completes, not at response time.',
                ]}
                samples={UTIL_PAY_SAMPLES}
            />
            </div>

            <div id="ref-com-status" className="scroll-mt-6">
            <ApiEndpointBlock
                method="GET" path="/api/v2/utilities/orders/{reference}"
                description="Poll the fulfillment status of a utility bill order using the reference from the /pay response. Only returns orders that belong to your own account."
                responseBody={`{\n  "success": true,\n  "data": {\n    "reference": "UTIL-DSTV-3f9a2b1c4d5e6f70",\n    "status": "refunded",\n    "payment_status": "paid",\n    "biller": "dstv",\n    "account_number": "7041234567",\n    "account_name": "KWAME MENSAH",\n    "amount": 65.00,\n    "commission_earned": null,\n    "reason": "The transaction could not be completed by the payment provider.",\n    "created_at": "2026-...",\n    "updated_at": "2026-..."\n  }\n}`}
                notes={[
                    'Status flow: pending → processing → completed | failed | refunded.',
                    'The account field here is called account_number — not account as in the /pay request body. Same value, different key name across endpoints.',
                    'commission_earned is null until the order reaches completed — it is your realized share of the commission, credited to your shop wallet at that point.',
                    'reason is present only on an auto-refunded order (status "refunded") — a short human-readable sentence explaining why the provider\'s failure was treated as definitive. status is "refunded" instead of "failed" whenever we already auto-refunded your wallet for that order.',
                    'Poll every few seconds after /pay until status leaves pending / processing.',
                ]}
                samples={UTIL_STATUS_SAMPLES}
            />
            </div>

            <div className="flex items-center gap-3 pt-2">
                <div className="flex-1 h-px bg-slate-200 dark:bg-slate-800" />
                <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-violet-100 dark:bg-violet-900/30 border border-violet-200 dark:border-violet-700/40">
                    <Wifi className="w-4 h-4 text-violet-500" />
                    <span className="text-sm font-bold text-violet-700 dark:text-violet-300">Airtime (Commission)</span>
                </div>
                <div className="flex-1 h-px bg-slate-200 dark:bg-slate-800" />
            </div>

            <div id="ref-com-airtime-purchase" className="scroll-mt-6">
            <ApiEndpointBlock
                method="POST" path="/api/v2/airtime/purchase"
                description="Send airtime to a beneficiary at face value from your wallet. Auto-dispatches in the background — poll GET /airtime/orders/{reference} for the final status."
                requestBody={`{\n  "network": "MTN",\n  "beneficiary_phone": "0551617309",\n  "amount": 20.00,\n  "reference": "airtime_001"\n}`}
                responseBody={`{\n  "success": true,\n  "data": {\n    "order_id": "uuid-...",\n    "reference": "airtime_001",\n    "status": "pending",\n    "network": "MTN",\n    "beneficiary_phone": "0551617309",\n    "airtime_amount": 20.00,\n    "fee_amount": 0,\n    "total_paid": 20.00,\n    "new_balance": 415.00\n  }\n}`}
                notes={[
                    'reference is your idempotency key — sending the same reference twice returns the existing order without charging (is_duplicate: true).',
                    'network is one of MTN, Telecel, AT — a different value set from the Data API\'s network codes (which distinguish AT-iShare / AT-BigTime); airtime has no such distinction.',
                    'beneficiary_phone must be 0XXXXXXXXX (10 digits, starts with 0).',
                    'fee_amount is always 0 on the Commission Services key — the beneficiary receives the full amount at face value; your earnings come from a share of KiNG FLEXY GH\'s own provider commission, credited to your Commission Wallet once the order completes, not deducted from this transaction.',
                    'amount must fall within the live per-role min/max limits configured by an admin.',
                ]}
                samples={AIRTIME_PURCHASE_SAMPLES}
            />
            </div>

            <div id="ref-com-airtime-orders" className="scroll-mt-6">
            <ApiEndpointBlock
                method="GET" path="/api/v2/airtime/orders"
                description="Your most recent airtime orders, newest first, capped at 30 records."
                queryParams={[
                    { name: 'status', type: 'string', required: false, desc: 'Filter: pending | processing | completed | failed | refunded' },
                ]}
                responseBody={`{\n  "success": true,\n  "data": {\n    "orders": [\n      {\n        "order_id": "uuid-...",\n        "reference": "airtime_001",\n        "status": "completed",\n        "network": "MTN",\n        "beneficiary_phone": "0551617309",\n        "airtime_amount": 20.00,\n        "total_paid": 20.00,\n        "created_at": "2026-...",\n        "updated_at": "2026-..."\n      }\n    ],\n    "count": 1\n  }\n}`}
                notes={['Capped at 30 records — poll GET /airtime/orders/{reference} for a specific order beyond that window.', 'reference here is the value you originally sent, not our internal reference_code.']}
                samples={AIRTIME_ORDERS_SAMPLES}
            />
            </div>

            <div id="ref-com-airtime-status" className="scroll-mt-6">
            <ApiEndpointBlock
                method="GET" path="/api/v2/airtime/orders/{reference}"
                description="Poll the fulfillment status of an airtime order using the reference from the /purchase response. Only returns orders that belong to your own account."
                responseBody={`{\n  "success": true,\n  "data": {\n    "order_id": "uuid-...",\n    "reference": "airtime_001",\n    "status": "refunded",\n    "network": "MTN",\n    "beneficiary_phone": "0551617309",\n    "airtime_amount": 20.00,\n    "fee_amount": 0,\n    "total_paid": 20.00,\n    "reason": "The transaction could not be completed by the payment provider.",\n    "created_at": "2026-...",\n    "updated_at": "2026-..."\n  }\n}`}
                notes={['Status flow: pending → processing → completed | failed | refunded.', 'reason is present only on an auto-refunded order (status "refunded") — a short human-readable sentence explaining why the provider\'s failure was treated as definitive.', 'Poll this after placing an order to confirm delivery.']}
                samples={AIRTIME_STATUS_SAMPLES}
            />
            </div>

            {/* Rate limits + Errors in 2 columns */}
            <div id="ref-com-meta" className="grid grid-cols-1 lg:grid-cols-2 gap-5 scroll-mt-6">
                <div className="space-y-3">
                    <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                        <Zap className="w-4 h-4 text-slate-400" /> Rate Limits (per key)
                    </h3>
                    <ApiRefTable
                        head={['Endpoint', 'Limit']}
                        rows={[
                            [<code key="rl1" className="font-mono text-violet-600 dark:text-violet-400 text-xs">GET /utilities/billers</code>, '30 / min'],
                            [<code key="rl2" className="font-mono text-violet-600 dark:text-violet-400 text-xs">GET /utilities/lookup</code>, '10 / min'],
                            [<code key="rl3" className="font-mono text-violet-600 dark:text-violet-400 text-xs">POST /utilities/pay</code>, '6 / min'],
                            [<code key="rl4" className="font-mono text-violet-600 dark:text-violet-400 text-xs">GET /utilities/orders/{'{reference}'}</code>, '30 / min'],
                            [<code key="rl5" className="font-mono text-violet-600 dark:text-violet-400 text-xs">POST /airtime/purchase</code>, '10 / min'],
                            [<code key="rl6" className="font-mono text-violet-600 dark:text-violet-400 text-xs">GET /airtime/orders</code>, '30 / min'],
                            [<code key="rl7" className="font-mono text-violet-600 dark:text-violet-400 text-xs">GET /airtime/orders/{'{reference}'}</code>, '30 / min'],
                        ]}
                    />
                </div>
                <div className="space-y-3">
                    <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                        <AlertCircle className="w-4 h-4 text-slate-400" /> Error Codes
                    </h3>
                    <ApiRefTable
                        head={['Code', 'Meaning']}
                        rows={[
                            [<span key="u400" className="font-mono font-bold text-red-500 text-xs">400</span>, 'Invalid biller/account/phone/amount/reference (utilities) or network/beneficiary_phone/amount/reference (airtime), insufficient wallet balance, or — for airtime only — the requested network is currently disabled by an admin'],
                            [<span key="u401" className="font-mono font-bold text-red-500 text-xs">401</span>, 'Missing or invalid API key'],
                            [<span key="u403" className="font-mono font-bold text-red-500 text-xs">403</span>, 'Wrong key type (commission key required here; standard key required everywhere else), key pending/revoked, or account suspended'],
                            [<span key="u404" className="font-mono font-bold text-red-500 text-xs">404</span>, 'Account/meter/smartcard not found (lookup), or order not found (status)'],
                            [<span key="u409" className="font-mono font-bold text-amber-500 text-xs">409</span>, 'Duplicate order — same biller + account + amount resent within 30s without a reference (utilities), or reference already in use (airtime)'],
                            [<span key="u429" className="font-mono font-bold text-amber-500 text-xs">429</span>, 'Rate limit exceeded — see limits above'],
                            [<span key="u502" className="font-mono font-bold text-slate-400 text-xs">502</span>, 'Billing provider temporarily unreachable — retry shortly (lookup only)'],
                            [<span key="u503" className="font-mono font-bold text-slate-400 text-xs">503</span>, 'Utility bills, or this specific biller, currently disabled by an admin — for a disabled airtime network see 400 above'],
                        ]}
                    />
                </div>
            </div>
        </>
    )
}

// ── Webhooks tab ─────────────────────────────────────────────────────────────
const WEBHOOK_PRODUCTS: { key: string; label: string; via: 'standard' | 'commission' }[] = [
    { key: 'data', label: 'Data bundle orders', via: 'standard' },
    { key: 'resultschecker', label: 'Result checker vouchers', via: 'standard' },
    { key: 'afa', label: 'AFA (MTN Authorized Field Agent) registrations', via: 'standard' },
    { key: 'airtime', label: 'Airtime purchases', via: 'commission' },
    { key: 'utilities', label: 'Utility bill payments', via: 'commission' },
]

function WebhooksTab({ standardKey, commissionKey }: { standardKey: ApiKeyMeta | null; commissionKey: ApiKeyMeta | null }) {
    return (
        <>
            <div id="ref-wh-intro" className="scroll-mt-6 space-y-3">
                <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
                    A webhook is a single HTTPS POST we send to your own server the instant an order you placed reaches a
                    final state — <code className="font-mono text-xs">completed</code> or <code className="font-mono text-xs">failed</code>.
                    It replaces polling <code className="font-mono text-xs">GET /orders/{'{reference}'}</code> in a loop:
                    configure a URL once below, and every relevant order notifies you as it resolves.
                </p>
                <div className="flex items-start gap-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 p-4">
                    <Webhook className="w-4 h-4 text-violet-500 flex-shrink-0 mt-0.5" />
                    <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                        Webhooks are configured <strong>per key</strong>, not per product — the Standard key's webhook covers data,
                        result checker and AFA orders together; the Commission key's webhook covers both utility bill payments and airtime purchases.
                        Delivery is fire-and-forget with one automatic retry; if both attempts fail, keep polling the status endpoint
                        as a fallback — we do not queue or replay missed deliveries.
                    </p>
                </div>
            </div>

            <div id="ref-wh-config" className="scroll-mt-6 space-y-4">
                <h3 className="text-sm font-bold text-slate-900 dark:text-white">Configure your endpoint</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {standardKey ? (
                        <WebhookConfigCard keyType="standard" />
                    ) : (
                        <div className="rounded-2xl border border-dashed border-slate-300 dark:border-slate-700 p-5 text-xs text-slate-500 dark:text-slate-400 flex items-center justify-center text-center">
                            Generate a Standard API key above to configure its webhook.
                        </div>
                    )}
                    {commissionKey ? (
                        <WebhookConfigCard keyType="commission" />
                    ) : (
                        <div className="rounded-2xl border border-dashed border-slate-300 dark:border-slate-700 p-5 text-xs text-slate-500 dark:text-slate-400 flex items-center justify-center text-center">
                            Generate a Commission Services key above to configure its webhook.
                        </div>
                    )}
                </div>
            </div>

            <div id="ref-wh-events" className="scroll-mt-6 space-y-3">
                <h3 className="text-sm font-bold text-slate-900 dark:text-white">Event types</h3>
                <ApiRefTable
                    head={['product', 'Fires for', 'Key used']}
                    rows={WEBHOOK_PRODUCTS.map(p => [
                        <code key={p.key} className="font-mono text-violet-600 dark:text-violet-400 text-xs">"{p.key}"</code>,
                        p.label,
                        p.via === 'standard' ? 'Standard' : 'Commission',
                    ])}
                />
                <p className="text-xs text-slate-500 dark:text-slate-400">
                    Every event's <code className="font-mono">event</code> field is one of{' '}
                    <code className="font-mono text-violet-600 dark:text-violet-400">"order.completed"</code> or{' '}
                    <code className="font-mono text-violet-600 dark:text-violet-400">"order.failed"</code> — use{' '}
                    <code className="font-mono">product</code> to route the payload, not the event name alone.
                </p>
            </div>

            <div id="ref-wh-payload" className="scroll-mt-6 space-y-3">
                <h3 className="text-sm font-bold text-slate-900 dark:text-white">Payload shape</h3>
                <CodeBlock label="POST to your webhook URL" code={`{\n  "event": "order.completed",\n  "product": "data",\n  "reference": "order_001",\n  "status": "completed",\n  "timestamp": "2026-08-31T10:15:00.000Z",\n  "detail": {\n    "network": "MTN",\n    "size": "5GB"\n  }\n}`} />
                <p className="text-xs text-slate-500 dark:text-slate-400">
                    <code className="font-mono">reference</code> is the same value you sent (or that was echoed back) when placing
                    the order — use it to look up your own record. <code className="font-mono">detail</code> varies by product and
                    is not present on every event; treat it as supplementary, and treat the earlier{' '}
                    <code className="font-mono">GET /orders/{'{reference}'}</code> response as the source of truth if it's ever
                    ambiguous.
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                    For <strong>airtime</strong> and <strong>utility bills</strong> specifically, an{' '}
                    <code className="font-mono">"order.failed"</code> event's <code className="font-mono">detail</code> can also
                    include <code className="font-mono">reason_code</code> (one of{' '}
                    <code className="font-mono text-violet-600 dark:text-violet-400">"invalid_request"</code> |{' '}
                    <code className="font-mono text-violet-600 dark:text-violet-400">"provider_rejected"</code>) and{' '}
                    <code className="font-mono">reason</code>, a short human-readable sentence. When the provider's failure was
                    definitive and we auto-refunded your wallet, <code className="font-mono">detail</code> additionally includes{' '}
                    <code className="font-mono">refunded: true</code>, <code className="font-mono">refund_amount</code>, and{' '}
                    <code className="font-mono">new_balance</code> — and the event's outer{' '}
                    <code className="font-mono">status</code> field is <code className="font-mono">"refunded"</code> instead of{' '}
                    <code className="font-mono">"failed"</code>.{' '}
                    <strong className="text-slate-700 dark:text-slate-300">
                        Your webhook handler should treat both "failed" and "refunded" as terminal failure states
                    </strong>{' '}
                    — checking only for "failed" will silently miss orders we've already refunded.
                </p>
            </div>

            <div id="ref-wh-verify" className="scroll-mt-6 space-y-4">
                <h3 className="text-sm font-bold text-slate-900 dark:text-white">Verifying signatures</h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                    Every delivery carries an <code className="font-mono">X-KFT-Signature</code> header — the HMAC-SHA256 of the exact
                    raw request body, keyed with the signing secret you were shown once when you saved the webhook URL above.
                    <strong className="text-slate-700 dark:text-slate-300"> Always verify it before trusting a payload</strong> — anyone
                    who learns your webhook URL can otherwise POST a fake "completed" event to it.
                </p>
                <EndpointSampleTabs samples={SIGNATURE_VERIFY_SAMPLES} />
            </div>
        </>
    )
}

// Standalone language-tab code sample block, matching ApiEndpointBlock's own
// tab styling but usable outside an endpoint card (the signature-verification
// snippet isn't documenting a request/response, so ApiEndpointBlock's shape
// doesn't fit it).
function EndpointSampleTabs({ samples }: { samples: Record<ApiLangTab, string> }) {
    const langs = Object.keys(samples) as ApiLangTab[]
    const [tab, setTab] = useState<ApiLangTab>(langs[0])
    return (
        <div className="space-y-3">
            <div className="flex flex-wrap gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-xl w-fit">
                {langs.map(l => (
                    <button
                        key={l}
                        onClick={() => setTab(l)}
                        className={cn(
                            'px-3 py-1.5 rounded-lg text-xs font-semibold transition-all duration-150',
                            tab === l
                                ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm'
                                : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'
                        )}
                    >
                        {l}
                    </button>
                ))}
            </div>
            <CodeBlock code={samples[tab]} label={tab} />
        </div>
    )
}

function PageHeader() {
    return (
        <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-violet-500/20">
                <Code2 className="w-6 h-6 text-white" />
            </div>
            <div>
                <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">Developer API</h1>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">Integrate data purchases into your applications</p>
            </div>
        </div>
    )
}
