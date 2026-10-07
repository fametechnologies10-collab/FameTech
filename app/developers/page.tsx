'use client'

import { useState, useEffect } from 'react'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import Link from 'next/link'
import {
    Copy, Check,
    Lock, Zap, List, Globe, AlertCircle, Code2, ArrowRight,
    Menu, X, ExternalLink, MessageSquare, Percent, AlertTriangle,
    UserCheck, Smartphone, GraduationCap, BadgeCheck, Lightbulb,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SMS_API_ENDPOINTS, SMS_BUSINESS_MODE_NOTICE } from '@/content/sms-api-docs'
import { USSD_DETAILS } from '@/lib/developer-products'

// ─── Types ────────────────────────────────────────────────────────────────────
type Method = 'GET' | 'POST'
type LangTab = 'cURL' | 'Node.js' | 'PHP' | 'Python'

const LANG_TABS: LangTab[] = ['cURL', 'Node.js', 'PHP', 'Python']

// ─── TOC ─────────────────────────────────────────────────────────────────────
const TOC = [
    { id: 'authentication', label: 'Authentication', icon: Lock },
    { id: 'response-format', label: 'Response Format', icon: Code2 },
    { id: 'endpoints', label: 'Endpoints', icon: List },
    { id: 'account-role', label: 'Account & Role', icon: UserCheck },
    { id: 'airtime', label: 'Airtime (v2)', icon: Smartphone },
    { id: 'resultschecker', label: 'Results Checker (v2)', icon: GraduationCap },
    { id: 'afa', label: 'AFA Registration (v2)', icon: BadgeCheck },
    { id: 'sms', label: 'SMS API', icon: MessageSquare },
    { id: 'utilities', label: 'Utility Bills', icon: Percent },
    { id: 'ussd', label: 'USSD for Resellers', icon: Smartphone },
    { id: 'tips', label: 'Tips & Recommendations', icon: Lightbulb },
    { id: 'networks', label: 'Networks', icon: Globe },
    { id: 'errors', label: 'Error Codes', icon: AlertCircle },
    { id: 'examples', label: 'Code Examples', icon: Zap },
]

// ─── Copy Button ─────────────────────────────────────────────────────────────
function CopyBtn({ text, className }: { text: string; className?: string }) {
    const [copied, setCopied] = useState(false)
    const copy = async () => {
        try { await navigator.clipboard.writeText(text) } catch {
            const el = Object.assign(document.createElement('textarea'), { value: text })
            document.body.appendChild(el); el.select(); document.execCommand('copy'); el.remove()
        }
        setCopied(true)
        toast.success('Copied')
        setTimeout(() => setCopied(false), 2200)
    }
    return (
        <button
            onClick={copy}
            className={cn(
                'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all',
                'bg-slate-700 hover:bg-slate-600 text-slate-200 hover:text-white border border-slate-600',
                className
            )}
        >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? 'Copied' : 'Copy'}
        </button>
    )
}

// ─── Code Block ──────────────────────────────────────────────────────────────
function CodeBlock({ code, label, className }: { code: string; label?: string; className?: string }) {
    return (
        <div className={cn('rounded-xl overflow-hidden border border-slate-700/50', className)}>
            {label && (
                <div className="flex items-center justify-between pl-4 pr-2 py-2 bg-slate-800/80 border-b border-slate-700/50">
                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">{label}</span>
                    <CopyBtn text={code} />
                </div>
            )}
            {!label && (
                <div className="flex justify-end px-2 py-2 bg-slate-800/80 border-b border-slate-700/50">
                    <CopyBtn text={code} />
                </div>
            )}
            <div className="bg-[#0d1117] overflow-x-auto p-4">
                <pre className="text-[13px] font-mono text-slate-300 leading-relaxed whitespace-pre">{code}</pre>
            </div>
        </div>
    )
}

// ─── Inline Code ─────────────────────────────────────────────────────────────
function IC({ children }: { children: React.ReactNode }) {
    return (
        <code className="text-[12px] font-mono bg-slate-100 dark:bg-slate-800 text-violet-600 dark:text-violet-400 px-1.5 py-0.5 rounded-md">
            {children}
        </code>
    )
}

// ─── Method Badge ─────────────────────────────────────────────────────────────
const METHOD_COLORS: Record<Method, string> = {
    GET: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
    POST: 'bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30',
}

function MethodBadge({ method }: { method: Method }) {
    return (
        <span className={cn(
            'inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold border tracking-wide font-mono',
            METHOD_COLORS[method]
        )}>
            {method}
        </span>
    )
}

// ─── Endpoint Section (always open, plain) ────────────────────────────────────
function EndpointSection({
    method, path, description, queryParams, requestBody, responseBody, notes, codeSamples,
}: {
    method: Method; path: string; description: string
    queryParams?: { name: string; type: string; required: boolean; desc: string }[]
    requestBody?: string; responseBody: string; notes?: string[]
    codeSamples: Record<LangTab, string>
}) {
    const [lang, setLang] = useState<LangTab>('cURL')

    return (
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
            {/* Header bar */}
            <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-100 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/30 flex-wrap">
                <MethodBadge method={method} />
                <code className="text-sm font-mono font-semibold text-slate-800 dark:text-slate-100 break-all">{path}</code>
                <span className="text-xs text-slate-500 dark:text-slate-400 ml-auto hidden sm:block">{description}</span>
            </div>

            <div className="p-5 sm:p-6 space-y-6">
                <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">{description}</p>

                {/* Query params */}
                {queryParams && queryParams.length > 0 && (
                    <div>
                        <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-3">Query Parameters</p>
                        <div className="rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden divide-y divide-slate-100 dark:divide-slate-800">
                            {queryParams.map(p => (
                                <div key={p.name} className="flex flex-wrap items-start gap-3 px-4 py-3 text-sm">
                                    <code className="font-mono text-violet-600 dark:text-violet-400 text-xs font-bold w-24 flex-shrink-0 mt-0.5">{p.name}</code>
                                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 uppercase">{p.type}</span>
                                    {!p.required && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-400 uppercase">optional</span>}
                                    <span className="text-slate-600 dark:text-slate-400 text-xs flex-1 min-w-[140px]">{p.desc}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Request / Response */}
                <div className={cn('grid gap-5', requestBody ? 'sm:grid-cols-2' : 'grid-cols-1 max-w-xl')}>
                    {requestBody && (
                        <div>
                            <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2">Request Body</p>
                            <CodeBlock code={requestBody} />
                        </div>
                    )}
                    <div>
                        <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2">Response</p>
                        <CodeBlock code={responseBody} />
                    </div>
                </div>

                {/* Notes */}
                {notes && notes.length > 0 && (
                    <ul className="space-y-2 bg-slate-50 dark:bg-slate-800/40 rounded-xl p-4">
                        {notes.map((note, i) => (
                            <li key={i} className="flex items-start gap-2 text-xs text-slate-600 dark:text-slate-400">
                                <span className="text-violet-500 font-bold mt-0.5 flex-shrink-0">→</span>
                                <span className="leading-relaxed">{note}</span>
                            </li>
                        ))}
                    </ul>
                )}

                {/* Code samples */}
                <div className="space-y-2">
                    <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">Code Sample</p>
                    <div className="flex flex-wrap gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-xl w-fit">
                        {LANG_TABS.map(l => (
                            <button
                                key={l}
                                onClick={() => setLang(l)}
                                className={cn(
                                    'px-3 py-1.5 rounded-lg text-xs font-semibold transition-all',
                                    lang === l
                                        ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm'
                                        : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
                                )}
                            >
                                {l}
                            </button>
                        ))}
                    </div>
                    <CodeBlock code={codeSamples[lang]} label={lang} />
                </div>
            </div>
        </div>
    )
}

// ─── Section Heading ──────────────────────────────────────────────────────────
function SectionHeading({ id, num, label }: { id: string; num: number; label: string }) {
    return (
        <h2 id={id} className="flex items-center gap-3 text-xl font-black text-slate-900 dark:text-white scroll-mt-24">
            <span className="w-8 h-8 rounded-xl bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center text-violet-600 dark:text-violet-400 text-sm font-black flex-shrink-0">
                {num}
            </span>
            {label}
        </h2>
    )
}

// ─── Table ────────────────────────────────────────────────────────────────────
function DocTable({ head, rows }: { head: string[]; rows: (string | React.ReactNode)[][] }) {
    return (
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden">
            <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[400px]">
                    <thead>
                        <tr className="bg-slate-50 dark:bg-slate-800/50">
                            {head.map(h => (
                                <th key={h} className="text-left px-5 py-3 text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest">{h}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                        {rows.map((row, i) => (
                            <tr key={i} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/30 transition-colors">
                                {row.map((cell, j) => (
                                    <td key={j} className="px-5 py-3 text-slate-700 dark:text-slate-300">{cell}</td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    )
}

// ─── Endpoint Data ────────────────────────────────────────────────────────────
// v1 has been fully ported and eliminated (owner decision, 2026-08-31 — all
// developers were notified and confirmed). BASE now points at the ONLY live
// API surface; every sample below inherits the flip automatically since they
// all interpolate ${BASE} rather than hardcoding a version.
const BASE = 'https://api.kingflexygh.com/api/v2'
const KEY = 'kf_live_your_api_key_here'
const CS_KEY = 'kf_cs_live_your_commission_key_here'

const PACKAGES_SAMPLES: Record<LangTab, string> = {
    'cURL': `# All packages
curl -X GET ${BASE}/packages \\
  -H "Authorization: ${KEY}"

# Filter by network
curl -X GET "${BASE}/packages?network=MTN" \\
  -H "Authorization: ${KEY}"

# Filter by network + size
curl -X GET "${BASE}/packages?network=MTN&size_gb=5" \\
  -H "Authorization: ${KEY}"`,
    'Node.js': `// All packages
const res = await fetch('${BASE}/packages', {
  headers: { 'Authorization': '${KEY}' },
});
console.log(await res.json());

// Filter by network
const mtn = await fetch('${BASE}/packages?network=MTN', {
  headers: { 'Authorization': '${KEY}' },
});
console.log(await mtn.json());`,
    'PHP': `<?php
$ch = curl_init('${BASE}/packages?network=MTN');
curl_setopt_array($ch, [
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => ['Authorization: ${KEY}'],
]);
echo curl_exec($ch); curl_close($ch);`,
    'Python': `import requests

# All packages
r = requests.get('${BASE}/packages',
  headers={'Authorization': '${KEY}'})
print(r.json())

# Filter by network
r = requests.get('${BASE}/packages',
  headers={'Authorization': '${KEY}'},
  params={'network': 'MTN'})
print(r.json())`,
}

const PURCHASE_SAMPLES: Record<LangTab, string> = {
    'cURL': `curl -X POST ${BASE}/data/purchase \\
  -H "Authorization: ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "network": "MTN",
    "volume_gb": 5,
    "recipient": "0551617309",
    "reference": "order_001"
  }'`,
    'Node.js': `const res = await fetch('${BASE}/data/purchase', {
  method: 'POST',
  headers: {
    'Authorization': '${KEY}',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    network: 'MTN', volume_gb: 5,
    recipient: '0551617309', reference: 'order_001',
  }),
});
console.log(await res.json());`,
    'PHP': `<?php
$ch = curl_init('${BASE}/data/purchase');
curl_setopt_array($ch, [
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_POST => true,
  CURLOPT_HTTPHEADER => [
    'Authorization: ${KEY}',
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
  '${BASE}/data/purchase',
  headers={'Authorization': '${KEY}'},
  json={
    'network': 'MTN', 'volume_gb': 5,
    'recipient': '0551617309', 'reference': 'order_001',
  }
)
print(r.json())`,
}

const BULK_SAMPLES: Record<LangTab, string> = {
    'cURL': `curl -X POST ${BASE}/data/bulk \\
  -H "Authorization: ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "orders": [
      {"network":"MTN","volume_gb":5,"recipient":"0551617309","reference":"b_001"},
      {"network":"Telecel","volume_gb":2,"recipient":"0201234567","reference":"b_002"}
    ]
  }'`,
    'Node.js': `const res = await fetch('${BASE}/data/bulk', {
  method: 'POST',
  headers: { 'Authorization': '${KEY}', 'Content-Type': 'application/json' },
  body: JSON.stringify({ orders: [
    { network: 'MTN', volume_gb: 5, recipient: '0551617309', reference: 'b_001' },
    { network: 'Telecel', volume_gb: 2, recipient: '0201234567', reference: 'b_002' },
  ]}),
});
console.log(await res.json());`,
    'PHP': `<?php
$ch = curl_init('${BASE}/data/bulk');
curl_setopt_array($ch, [
  CURLOPT_RETURNTRANSFER => true, CURLOPT_POST => true,
  CURLOPT_HTTPHEADER => ['Authorization: ${KEY}', 'Content-Type: application/json'],
  CURLOPT_POSTFIELDS => json_encode(['orders' => [
    ['network'=>'MTN','volume_gb'=>5,'recipient'=>'0551617309','reference'=>'b_001'],
    ['network'=>'Telecel','volume_gb'=>2,'recipient'=>'0201234567','reference'=>'b_002'],
  ]]),
]);
echo curl_exec($ch); curl_close($ch);`,
    'Python': `import requests

r = requests.post('${BASE}/data/bulk',
  headers={'Authorization': '${KEY}'},
  json={'orders': [
    {'network':'MTN','volume_gb':5,'recipient':'0551617309','reference':'b_001'},
    {'network':'Telecel','volume_gb':2,'recipient':'0201234567','reference':'b_002'},
  ]}
)
print(r.json())`,
}

const VERIFY_NUMBER_SAMPLES: Record<LangTab, string> = {
    'cURL': `curl -X POST ${BASE}/data/verify-number \\
  -H "Authorization: ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"network":"MTN","recipient":"0551617309"}'`,
    'Node.js': `const res = await fetch('${BASE}/data/verify-number', {
  method: 'POST',
  headers: { 'Authorization': '${KEY}', 'Content-Type': 'application/json' },
  body: JSON.stringify({ network: 'MTN', recipient: '0551617309' }),
});
console.log(await res.json());`,
    'PHP': `<?php
$ch = curl_init('${BASE}/data/verify-number');
curl_setopt_array($ch, [
  CURLOPT_RETURNTRANSFER => true, CURLOPT_POST => true,
  CURLOPT_HTTPHEADER => ['Authorization: ${KEY}', 'Content-Type: application/json'],
  CURLOPT_POSTFIELDS => json_encode(['network' => 'MTN', 'recipient' => '0551617309']),
]);
echo curl_exec($ch); curl_close($ch);`,
    'Python': `import requests

r = requests.post('${BASE}/data/verify-number',
  headers={'Authorization': '${KEY}'},
  json={'network': 'MTN', 'recipient': '0551617309'}
)
print(r.json())`,
}

function verifyServerSamples(server: 1 | 2): Record<LangTab, string> {
    return {
        'cURL': `curl -X POST ${BASE}/data/verify-number/server-${server} \\
  -H "Authorization: ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"network":"MTN","recipient":"0551617309"}'`,
        'Node.js': `const res = await fetch('${BASE}/data/verify-number/server-${server}', {
  method: 'POST',
  headers: { 'Authorization': '${KEY}', 'Content-Type': 'application/json' },
  body: JSON.stringify({ network: 'MTN', recipient: '0551617309' }),
});
console.log(await res.json());`,
        'PHP': `<?php
$ch = curl_init('${BASE}/data/verify-number/server-${server}');
curl_setopt_array($ch, [
  CURLOPT_RETURNTRANSFER => true, CURLOPT_POST => true,
  CURLOPT_HTTPHEADER => ['Authorization: ${KEY}', 'Content-Type: application/json'],
  CURLOPT_POSTFIELDS => json_encode(['network' => 'MTN', 'recipient' => '0551617309']),
]);
echo curl_exec($ch); curl_close($ch);`,
        'Python': `import requests

r = requests.post('${BASE}/data/verify-number/server-${server}',
  headers={'Authorization': '${KEY}'},
  json={'network': 'MTN', 'recipient': '0551617309'}
)
print(r.json())`,
    }
}

const VERIFY_SERVER_1_SAMPLES = verifyServerSamples(1)
const VERIFY_SERVER_2_SAMPLES = verifyServerSamples(2)

const BALANCE_SAMPLES: Record<LangTab, string> = {
    'cURL': `curl -X GET ${BASE}/wallet/balance \\
  -H "Authorization: ${KEY}"`,
    'Node.js': `const res = await fetch('${BASE}/wallet/balance', {
  headers: { 'Authorization': '${KEY}' },
});
console.log(await res.json());`,
    'PHP': `<?php
$ch = curl_init('${BASE}/wallet/balance');
curl_setopt_array($ch, [
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => ['Authorization: ${KEY}'],
]);
echo curl_exec($ch); curl_close($ch);`,
    'Python': `import requests
r = requests.get('${BASE}/wallet/balance',
  headers={'Authorization': '${KEY}'})
print(r.json())`,
}

const ORDER_STATUS_SAMPLES: Record<LangTab, string> = {
    'cURL': `curl -X GET ${BASE}/orders/your_reference_here \\
  -H "Authorization: ${KEY}"`,
    'Node.js': `const ref = 'your_reference_here';
const res = await fetch(\`${BASE}/orders/\${ref}\`, {
  headers: { 'Authorization': '${KEY}' },
});
console.log(await res.json());`,
    'PHP': `<?php
$ref = 'your_reference_here';
$ch = curl_init("${BASE}/orders/$ref");
curl_setopt_array($ch, [
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => ['Authorization: ${KEY}'],
]);
echo curl_exec($ch); curl_close($ch);`,
    'Python': `import requests
ref = 'your_reference_here'
r = requests.get(f'${BASE}/orders/{ref}',
  headers={'Authorization': '${KEY}'})
print(r.json())`,
}

// ─── Utility Bills (Commission) code samples ─────────────────────────────────
const UTIL_BILLERS_SAMPLES: Record<LangTab, string> = {
    'cURL': `curl -X GET ${BASE}/utilities/billers \\
  -H "Authorization: ${CS_KEY}"`,
    'Node.js': `const res = await fetch('${BASE}/utilities/billers', {
  headers: { 'Authorization': '${CS_KEY}' },
});
console.log(await res.json());`,
    'PHP': `<?php
$ch = curl_init('${BASE}/utilities/billers');
curl_setopt_array($ch, [
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => ['Authorization: ${CS_KEY}'],
]);
echo curl_exec($ch); curl_close($ch);`,
    'Python': `import requests
r = requests.get('${BASE}/utilities/billers',
  headers={'Authorization': '${CS_KEY}'})
print(r.json())`,
}

const UTIL_LOOKUP_SAMPLES: Record<LangTab, string> = {
    'cURL': `# DSTV — query by smartcard number
curl -X GET "${BASE}/utilities/lookup?biller=dstv&account=7041234567" \\
  -H "Authorization: ${CS_KEY}"

# ECG — query by phone (account is still required; pass the same number)
curl -X GET "${BASE}/utilities/lookup?biller=ecg&phone=0551617309&account=0551617309" \\
  -H "Authorization: ${CS_KEY}"`,
    'Node.js': `const params = new URLSearchParams({ biller: 'dstv', account: '7041234567' });
const res = await fetch(\`${BASE}/utilities/lookup?\${params}\`, {
  headers: { 'Authorization': '${CS_KEY}' },
});
console.log(await res.json());`,
    'PHP': `<?php
$qs = http_build_query(['biller' => 'dstv', 'account' => '7041234567']);
$ch = curl_init("${BASE}/utilities/lookup?$qs");
curl_setopt_array($ch, [
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => ['Authorization: ${CS_KEY}'],
]);
echo curl_exec($ch); curl_close($ch);`,
    'Python': `import requests
r = requests.get('${BASE}/utilities/lookup',
  headers={'Authorization': '${CS_KEY}'},
  params={'biller': 'dstv', 'account': '7041234567'})
print(r.json())`,
}

const UTIL_PAY_SAMPLES: Record<LangTab, string> = {
    'cURL': `# DSTV — account-only biller
curl -X POST ${BASE}/utilities/pay \\
  -H "Authorization: ${CS_KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "biller": "dstv",
    "account": "7041234567",
    "amount": 65.00,
    "reference": "bill_dstv_7041234567_01"
  }'

# ECG — account is the METER (from lookup meters[]), phone is required too
curl -X POST ${BASE}/utilities/pay \\
  -H "Authorization: ${CS_KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "biller": "ecg",
    "account": "3701234567",
    "phone": "0551617309",
    "amount": 50.00,
    "reference": "bill_ecg_3701234567_01"
  }'`,
    'Node.js': `const res = await fetch('${BASE}/utilities/pay', {
  method: 'POST',
  headers: {
    'Authorization': '${CS_KEY}',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    biller: 'dstv',
    account: '7041234567',
    amount: 65.00,
    reference: 'bill_dstv_7041234567_01',
  }),
});
console.log(await res.json());`,
    'PHP': `<?php
$ch = curl_init('${BASE}/utilities/pay');
curl_setopt_array($ch, [
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_POST => true,
  CURLOPT_HTTPHEADER => [
    'Authorization: ${CS_KEY}',
    'Content-Type: application/json',
  ],
  CURLOPT_POSTFIELDS => json_encode([
    'biller' => 'dstv', 'account' => '7041234567',
    'amount' => 65.00, 'reference' => 'bill_dstv_7041234567_01',
  ]),
]);
echo curl_exec($ch); curl_close($ch);`,
    'Python': `import requests

r = requests.post(
  '${BASE}/utilities/pay',
  headers={'Authorization': '${CS_KEY}'},
  json={
    'biller': 'dstv', 'account': '7041234567',
    'amount': 65.00, 'reference': 'bill_dstv_7041234567_01',
  }
)
print(r.json())`,
}

const UTIL_STATUS_SAMPLES: Record<LangTab, string> = {
    'cURL': `curl -X GET ${BASE}/utilities/orders/UTIL-DSTV-3f9a2b1c4d5e6f70 \\
  -H "Authorization: ${CS_KEY}"`,
    'Node.js': `const ref = 'UTIL-DSTV-3f9a2b1c4d5e6f70'; // the reference from the /pay response
const res = await fetch(\`${BASE}/utilities/orders/\${ref}\`, {
  headers: { 'Authorization': '${CS_KEY}' },
});
console.log(await res.json());`,
    'PHP': `<?php
$ref = 'UTIL-DSTV-3f9a2b1c4d5e6f70';
$ch = curl_init("${BASE}/utilities/orders/$ref");
curl_setopt_array($ch, [
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => ['Authorization: ${CS_KEY}'],
]);
echo curl_exec($ch); curl_close($ch);`,
    'Python': `import requests
ref = 'UTIL-DSTV-3f9a2b1c4d5e6f70'
r = requests.get(f'${BASE}/utilities/orders/{ref}',
  headers={'Authorization': '${CS_KEY}'})
print(r.json())`,
}

// ─── v2 Endpoint Data ───────────────────────────────────────────────────────
// V2_BASE and BASE are now the same string — the full v1→v2 port completed
// and v1 is retired. Kept as a separate name (rather than merged into BASE)
// because these product sections (Account & Role, Airtime, Results Checker,
// AFA Registration) were added before the port and this avoids re-touching
// every sample in this block for a purely cosmetic rename.
const V2_BASE = 'https://api.kingflexygh.com/api/v2'
const V2_KEY = KEY // same key material — one standard key for the whole v2 API

const ACCOUNT_ROLE_SAMPLES: Record<LangTab, string> = {
    'cURL': `curl -X GET ${V2_BASE}/account/role \\
  -H "Authorization: ${V2_KEY}"`,
    'Node.js': `const res = await fetch('${V2_BASE}/account/role', {
  headers: { 'Authorization': '${V2_KEY}' },
});
console.log(await res.json());`,
    'PHP': `<?php
$ch = curl_init('${V2_BASE}/account/role');
curl_setopt_array($ch, [
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => ['Authorization: ${V2_KEY}'],
]);
echo curl_exec($ch); curl_close($ch);`,
    'Python': `import requests

r = requests.get('${V2_BASE}/account/role',
  headers={'Authorization': '${V2_KEY}'})
print(r.json())`,
}

const AIRTIME_PURCHASE_SAMPLES: Record<LangTab, string> = {
    'cURL': `curl -X POST ${V2_BASE}/airtime/purchase \\
  -H "Authorization: ${CS_KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "network": "MTN",
    "beneficiary_phone": "0551617309",
    "amount": 10,
    "reference": "air_001"
  }'`,
    'Node.js': `const res = await fetch('${V2_BASE}/airtime/purchase', {
  method: 'POST',
  headers: { 'Authorization': '${CS_KEY}', 'Content-Type': 'application/json' },
  body: JSON.stringify({
    network: 'MTN', beneficiary_phone: '0551617309',
    amount: 10, reference: 'air_001',
  }),
});
console.log(await res.json());`,
    'PHP': `<?php
$ch = curl_init('${V2_BASE}/airtime/purchase');
curl_setopt_array($ch, [
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_POST => true,
  CURLOPT_HTTPHEADER => [
    'Authorization: ${CS_KEY}',
    'Content-Type: application/json',
  ],
  CURLOPT_POSTFIELDS => json_encode([
    'network' => 'MTN', 'beneficiary_phone' => '0551617309',
    'amount' => 10, 'reference' => 'air_001',
  ]),
]);
echo curl_exec($ch); curl_close($ch);`,
    'Python': `import requests

r = requests.post(
  '${V2_BASE}/airtime/purchase',
  headers={'Authorization': '${CS_KEY}'},
  json={
    'network': 'MTN', 'beneficiary_phone': '0551617309',
    'amount': 10, 'reference': 'air_001',
  }
)
print(r.json())`,
}

const AIRTIME_ORDERS_SAMPLES: Record<LangTab, string> = {
    'cURL': `curl -X GET ${V2_BASE}/airtime/orders \\
  -H "Authorization: ${CS_KEY}"`,
    'Node.js': `const res = await fetch('${V2_BASE}/airtime/orders', {
  headers: { 'Authorization': '${CS_KEY}' },
});
console.log(await res.json());`,
    'PHP': `<?php
$ch = curl_init('${V2_BASE}/airtime/orders');
curl_setopt_array($ch, [
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => ['Authorization: ${CS_KEY}'],
]);
echo curl_exec($ch); curl_close($ch);`,
    'Python': `import requests

r = requests.get('${V2_BASE}/airtime/orders',
  headers={'Authorization': '${CS_KEY}'})
print(r.json())`,
}

const AIRTIME_STATUS_SAMPLES: Record<LangTab, string> = {
    'cURL': `curl -X GET ${V2_BASE}/airtime/orders/air_001 \\
  -H "Authorization: ${CS_KEY}"`,
    'Node.js': `const res = await fetch('${V2_BASE}/airtime/orders/air_001', {
  headers: { 'Authorization': '${CS_KEY}' },
});
console.log(await res.json());`,
    'PHP': `<?php
$ch = curl_init('${V2_BASE}/airtime/orders/air_001');
curl_setopt_array($ch, [
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => ['Authorization: ${CS_KEY}'],
]);
echo curl_exec($ch); curl_close($ch);`,
    'Python': `import requests
ref = 'air_001'
r = requests.get(f'${V2_BASE}/airtime/orders/{ref}',
  headers={'Authorization': '${CS_KEY}'})
print(r.json())`,
}

const RC_TYPES_SAMPLES: Record<LangTab, string> = {
    'cURL': `curl -X GET ${V2_BASE}/resultschecker/types \\
  -H "Authorization: ${V2_KEY}"`,
    'Node.js': `const res = await fetch('${V2_BASE}/resultschecker/types', {
  headers: { 'Authorization': '${V2_KEY}' },
});
console.log(await res.json());`,
    'PHP': `<?php
$ch = curl_init('${V2_BASE}/resultschecker/types');
curl_setopt_array($ch, [
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => ['Authorization: ${V2_KEY}'],
]);
echo curl_exec($ch); curl_close($ch);`,
    'Python': `import requests

r = requests.get('${V2_BASE}/resultschecker/types',
  headers={'Authorization': '${V2_KEY}'})
print(r.json())`,
}

const RC_PURCHASE_SAMPLES: Record<LangTab, string> = {
    'cURL': `curl -X POST ${V2_BASE}/resultschecker/purchase \\
  -H "Authorization: ${V2_KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "typeId": "uuid-of-a-type-from-GET-types",
    "quantity": 1,
    "reference": "rc_001"
  }'`,
    'Node.js': `const res = await fetch('${V2_BASE}/resultschecker/purchase', {
  method: 'POST',
  headers: { 'Authorization': '${V2_KEY}', 'Content-Type': 'application/json' },
  body: JSON.stringify({
    typeId: 'uuid-of-a-type-from-GET-types',
    quantity: 1, reference: 'rc_001',
    // recipientPhone / recipientEmail are optional — omit both to receive
    // the vouchers in this response only and deliver them yourself.
  }),
});
console.log(await res.json());`,
    'PHP': `<?php
$ch = curl_init('${V2_BASE}/resultschecker/purchase');
curl_setopt_array($ch, [
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_POST => true,
  CURLOPT_HTTPHEADER => [
    'Authorization: ${V2_KEY}',
    'Content-Type: application/json',
  ],
  CURLOPT_POSTFIELDS => json_encode([
    'typeId' => 'uuid-of-a-type-from-GET-types',
    'quantity' => 1, 'reference' => 'rc_001',
  ]),
]);
echo curl_exec($ch); curl_close($ch);`,
    'Python': `import requests

r = requests.post(
  '${V2_BASE}/resultschecker/purchase',
  headers={'Authorization': '${V2_KEY}'},
  json={
    'typeId': 'uuid-of-a-type-from-GET-types',
    'quantity': 1, 'reference': 'rc_001',
  }
)
print(r.json())`,
}

const RC_ORDERS_SAMPLES: Record<LangTab, string> = {
    'cURL': `curl -X GET ${V2_BASE}/resultschecker/orders \\
  -H "Authorization: ${V2_KEY}"`,
    'Node.js': `const res = await fetch('${V2_BASE}/resultschecker/orders', {
  headers: { 'Authorization': '${V2_KEY}' },
});
console.log(await res.json());`,
    'PHP': `<?php
$ch = curl_init('${V2_BASE}/resultschecker/orders');
curl_setopt_array($ch, [
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => ['Authorization: ${V2_KEY}'],
]);
echo curl_exec($ch); curl_close($ch);`,
    'Python': `import requests

r = requests.get('${V2_BASE}/resultschecker/orders',
  headers={'Authorization': '${V2_KEY}'})
print(r.json())`,
}

const RC_STATUS_SAMPLES: Record<LangTab, string> = {
    'cURL': `curl -X GET ${V2_BASE}/resultschecker/orders/rc_001 \\
  -H "Authorization: ${V2_KEY}"`,
    'Node.js': `const res = await fetch('${V2_BASE}/resultschecker/orders/rc_001', {
  headers: { 'Authorization': '${V2_KEY}' },
});
console.log(await res.json());`,
    'PHP': `<?php
$ch = curl_init('${V2_BASE}/resultschecker/orders/rc_001');
curl_setopt_array($ch, [
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => ['Authorization: ${V2_KEY}'],
]);
echo curl_exec($ch); curl_close($ch);`,
    'Python': `import requests
ref = 'rc_001'
r = requests.get(f'${V2_BASE}/resultschecker/orders/{ref}',
  headers={'Authorization': '${V2_KEY}'})
print(r.json())`,
}

const AFA_REGISTER_SAMPLES: Record<LangTab, string> = {
    'cURL': `curl -X POST ${V2_BASE}/afa/register \\
  -H "Authorization: ${V2_KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "reference": "afa_001",
    "full_name": "Kwame Mensah",
    "phone": "0551617309",
    "id_type": "Ghana Card",
    "id_number": "GHA-123456789-0",
    "date_of_birth": "1995-04-12",
    "region": "Greater Accra",
    "location": "Madina"
  }'`,
    'Node.js': `const res = await fetch('${V2_BASE}/afa/register', {
  method: 'POST',
  headers: { 'Authorization': '${V2_KEY}', 'Content-Type': 'application/json' },
  body: JSON.stringify({
    reference: 'afa_001',
    full_name: 'Kwame Mensah', phone: '0551617309',
    id_type: 'Ghana Card', id_number: 'GHA-123456789-0',
    date_of_birth: '1995-04-12', region: 'Greater Accra', location: 'Madina',
  }),
});
console.log(await res.json());`,
    'PHP': `<?php
$ch = curl_init('${V2_BASE}/afa/register');
curl_setopt_array($ch, [
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_POST => true,
  CURLOPT_HTTPHEADER => [
    'Authorization: ${V2_KEY}',
    'Content-Type: application/json',
  ],
  CURLOPT_POSTFIELDS => json_encode([
    'reference' => 'afa_001',
    'full_name' => 'Kwame Mensah', 'phone' => '0551617309',
    'id_type' => 'Ghana Card', 'id_number' => 'GHA-123456789-0',
    'date_of_birth' => '1995-04-12', 'region' => 'Greater Accra', 'location' => 'Madina',
  ]),
]);
echo curl_exec($ch); curl_close($ch);`,
    'Python': `import requests

r = requests.post(
  '${V2_BASE}/afa/register',
  headers={'Authorization': '${V2_KEY}'},
  json={
    'reference': 'afa_001',
    'full_name': 'Kwame Mensah', 'phone': '0551617309',
    'id_type': 'Ghana Card', 'id_number': 'GHA-123456789-0',
    'date_of_birth': '1995-04-12', 'region': 'Greater Accra', 'location': 'Madina',
  }
)
print(r.json())`,
}

const AFA_ORDERS_SAMPLES: Record<LangTab, string> = {
    'cURL': `curl -X GET ${V2_BASE}/afa/orders \\
  -H "Authorization: ${V2_KEY}"`,
    'Node.js': `const res = await fetch('${V2_BASE}/afa/orders', {
  headers: { 'Authorization': '${V2_KEY}' },
});
console.log(await res.json());`,
    'PHP': `<?php
$ch = curl_init('${V2_BASE}/afa/orders');
curl_setopt_array($ch, [
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => ['Authorization: ${V2_KEY}'],
]);
echo curl_exec($ch); curl_close($ch);`,
    'Python': `import requests

r = requests.get('${V2_BASE}/afa/orders',
  headers={'Authorization': '${V2_KEY}'})
print(r.json())`,
}

const AFA_STATUS_SAMPLES: Record<LangTab, string> = {
    'cURL': `curl -X GET ${V2_BASE}/afa/orders/afa_001 \\
  -H "Authorization: ${V2_KEY}"`,
    'Node.js': `const res = await fetch('${V2_BASE}/afa/orders/afa_001', {
  headers: { 'Authorization': '${V2_KEY}' },
});
console.log(await res.json());`,
    'PHP': `<?php
$ch = curl_init('${V2_BASE}/afa/orders/afa_001');
curl_setopt_array($ch, [
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => ['Authorization: ${V2_KEY}'],
]);
echo curl_exec($ch); curl_close($ch);`,
    'Python': `import requests
ref = 'afa_001'
r = requests.get(f'${V2_BASE}/afa/orders/{ref}',
  headers={'Authorization': '${V2_KEY}'})
print(r.json())`,
}

// ─── TOC Nav ──────────────────────────────────────────────────────────────────
function TocNav({ activeSection, onSelect }: { activeSection: string; onSelect: (id: string) => void }) {
    return (
        <nav className="space-y-0.5">
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest px-3 mb-3">On this page</p>
            {TOC.map(item => {
                const Icon = item.icon
                return (
                    <button
                        key={item.id}
                        onClick={() => onSelect(item.id)}
                        className={cn(
                            'w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-medium transition-all text-left',
                            activeSection === item.id
                                ? 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 font-semibold'
                                : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800'
                        )}
                    >
                        <Icon className="w-4 h-4 flex-shrink-0" />
                        {item.label}
                    </button>
                )
            })}
            <div className="pt-4 mt-4 border-t border-slate-200 dark:border-slate-800 space-y-2">
                <Link href="/dashboard/api">
                    <Button size="sm" className="w-full bg-violet-600 hover:bg-violet-700 text-white text-xs font-bold gap-1.5 h-9">
                        Get API Key <ArrowRight className="w-3.5 h-3.5" />
                    </Button>
                </Link>
                <a href="https://documenter.getpostman.com/view/55615613/2sBYAuTBhF" target="_blank" rel="noopener noreferrer" className="block">
                    <Button size="sm" variant="outline" className="w-full text-xs font-bold gap-1.5 h-9">
                        Postman Collection <ExternalLink className="w-3 h-3" />
                    </Button>
                </a>
            </div>
        </nav>
    )
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function DevelopersPage() {
    const [activeSection, setActiveSection] = useState('authentication')
    const [activeLang, setActiveLang] = useState<LangTab>('cURL')
    const [sidebarOpen, setSidebarOpen] = useState(false)

    useEffect(() => {
        const observer = new IntersectionObserver(
            (entries) => { entries.forEach(e => { if (e.isIntersecting) setActiveSection(e.target.id) }) },
            { rootMargin: '-15% 0% -65% 0%', threshold: 0 }
        )
        TOC.forEach(({ id }) => { const el = document.getElementById(id); if (el) observer.observe(el) })
        return () => observer.disconnect()
    }, [])

    useEffect(() => {
        document.body.style.overflow = sidebarOpen ? 'hidden' : ''
        return () => { document.body.style.overflow = '' }
    }, [sidebarOpen])

    const scrollTo = (id: string) => {
        document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        setActiveSection(id)
        setSidebarOpen(false)
    }

    return (
        <div className="min-h-screen bg-slate-50 dark:bg-slate-950">

            {sidebarOpen && (
                <>
                    <div className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm lg:hidden" onClick={() => setSidebarOpen(false)} />
                    <div className="fixed inset-y-0 left-0 z-50 w-72 bg-white dark:bg-slate-900 shadow-2xl border-r border-slate-200 dark:border-slate-800 flex flex-col lg:hidden">
                        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex-shrink-0">
                            <div className="flex items-center gap-2">
                                <Code2 className="w-4 h-4 text-violet-600 dark:text-violet-400" />
                                <span className="text-sm font-bold text-slate-900 dark:text-white">API Docs</span>
                            </div>
                            <button onClick={() => setSidebarOpen(false)} className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors" aria-label="Close menu">
                                <X className="w-4 h-4 text-slate-500" />
                            </button>
                        </div>
                        <div className="flex-1 overflow-y-auto p-4">
                            <TocNav activeSection={activeSection} onSelect={scrollTo} />
                        </div>
                    </div>
                </>
            )}

            {/* ── Hero ─────────────────────────────────────────────────────── */}
            <div className="relative overflow-hidden bg-gradient-to-br from-violet-600 via-indigo-700 to-slate-900 text-white">
                <div className="absolute inset-0 opacity-[0.07] bg-[linear-gradient(rgba(255,255,255,.1)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.1)_1px,transparent_1px)] bg-[size:48px_48px]" />
                <div className="relative max-w-5xl xl:max-w-6xl 2xl:max-w-[1600px] mx-auto px-4 sm:px-6 py-12 sm:py-20">
                    <div className="flex items-center gap-3 mb-6">
                        <div className="w-11 h-11 rounded-2xl bg-white/15 backdrop-blur-sm border border-white/20 flex items-center justify-center">
                            <Code2 className="w-5 h-5" />
                        </div>
                        <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs font-bold bg-emerald-400/20 border border-emerald-400/30 text-emerald-300 rounded-full px-3 py-1">v2 — the only live API</span>
                        </div>
                    </div>
                    <h1 className="text-3xl sm:text-5xl font-black tracking-tight mb-3 leading-tight">
                        KiNG FLEXY GH<br /><span className="text-violet-300">Developer API</span>
                    </h1>
                    <p className="text-sm sm:text-lg text-white/75 max-w-xl mb-8">
                        One API for Ghana digital services: data bundles, airtime, bulk SMS, WAEC/BECE results checkers, MTN AFA registration and utility bills. Integrate using your wallet balance and agent pricing. Reselling over USSD? That is supported too.
                    </p>
                    <div className="flex flex-wrap items-center gap-3">
                        <div className="flex flex-wrap items-center gap-2 bg-white/10 border border-white/20 backdrop-blur-sm rounded-xl px-4 py-2.5 overflow-x-auto">
                            <span className="text-xs text-white/60 font-medium whitespace-nowrap">Base URL</span>
                            <code className="text-xs sm:text-sm font-mono text-white font-semibold whitespace-nowrap">{BASE}</code>
                            <CopyBtn text={BASE} />
                        </div>
                    </div>
                    <div className="mt-8 rounded-xl overflow-hidden border border-white/10 bg-black/30 backdrop-blur-sm max-w-xl">
                        <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/10 bg-white/5">
                            <span className="text-[10px] font-bold text-white/50 uppercase tracking-widest">Authentication Header</span>
                            <CopyBtn text={`Authorization: ${KEY}`} />
                        </div>
                        <div className="px-4 py-3 overflow-x-auto">
                            <pre className="text-sm font-mono text-violet-300 whitespace-nowrap">
                                {'Authorization: '}<span className="text-emerald-400">{KEY}</span>
                            </pre>
                        </div>
                    </div>
                </div>
            </div>

            {/* ── Coverage notice ──────────────────────────────────────────────
                Deliberately placed BEFORE the mobile TOC bar / Authentication
                section — the single most important scope fact on this page
                must not be something a developer only discovers after they've
                already started integrating. */}
            <div className="bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-800/50">
                <div className="max-w-5xl xl:max-w-6xl 2xl:max-w-[1600px] mx-auto px-4 sm:px-6 py-3.5 flex items-start sm:items-center gap-3">
                    <Globe className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5 sm:mt-0" />
                    <p className="text-xs sm:text-sm text-amber-800 dark:text-amber-200 leading-relaxed">
                        <strong>Ghana networks only.</strong> This API fulfils MTN, Telecel, AT-iShare, and AT-BigTime — Ghanaian
                        numbers and Ghanaian networks exclusively. There is no support for international numbers, foreign
                        telecom networks, or any country outside Ghana.
                    </p>
                </div>
            </div>

            {/* ── Mobile TOC bar ────────────────────────────────────────────── */}
            <div className="lg:hidden sticky top-0 z-30 bg-white/95 dark:bg-slate-900/95 backdrop-blur-sm border-b border-slate-200 dark:border-slate-800">
                <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-2 min-w-0">
                        <span className="text-xs font-bold text-slate-400 uppercase tracking-widest whitespace-nowrap">Section:</span>
                        <span className="text-sm font-semibold text-slate-700 dark:text-slate-200 truncate">
                            {TOC.find(t => t.id === activeSection)?.label ?? 'Introduction'}
                        </span>
                    </div>
                    <button
                        onClick={() => setSidebarOpen(true)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 text-xs font-bold flex-shrink-0"
                    >
                        <Menu className="w-3.5 h-3.5" />Contents
                    </button>
                </div>
            </div>

            {/* ── Body ─────────────────────────────────────────────────────── */}
            <div className="max-w-5xl xl:max-w-6xl 2xl:max-w-[1600px] mx-auto px-4 sm:px-6 py-10">
                <div className="flex flex-col lg:flex-row gap-10">

                    <aside className="hidden lg:block w-52 xl:w-60 flex-shrink-0">
                        <div className="sticky top-8">
                            <TocNav activeSection={activeSection} onSelect={scrollTo} />
                        </div>
                    </aside>

                    <div className="flex-1 min-w-0 space-y-14">

                        {/* 1. Authentication */}
                        <section id="authentication" className="space-y-5">
                            <SectionHeading id="authentication" num={1} label="Authentication" />
                            <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-5">
                                <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
                                    All API requests must include your API key in the <IC>Authorization</IC> header — no Bearer prefix required.
                                </p>
                                <CodeBlock code={`Authorization: ${KEY}`} />
                                <div className="flex items-start gap-3 rounded-xl bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800/50 p-4">
                                    <span className="text-amber-500 mt-0.5 flex-shrink-0">⚠️</span>
                                    <p className="text-sm text-amber-800 dark:text-amber-200">
                                        <strong>Important:</strong> Your API key is shown <em>only once</em> when generated. Store it securely — losing it requires generating a new key, which permanently revokes the old one.
                                    </p>
                                </div>
                                <div>
                                    <h3 className="text-sm font-bold text-slate-900 dark:text-white mb-3">Getting Your API Key</h3>
                                    <ol className="space-y-2">
                                        {[
                                            'Log in to your KingFlexyGh account (agent role required)',
                                            'Navigate to Dashboard → Developer API',
                                            'Click Generate API Key and accept the policy',
                                            'Copy and store the key — it will not be shown again',
                                            'Wait for admin approval (status: pending → active)',
                                        ].map((step, i) => (
                                            <li key={i} className="flex items-start gap-3 text-sm text-slate-600 dark:text-slate-400">
                                                <span className="w-5 h-5 rounded-full bg-violet-100 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400 text-[11px] font-bold flex items-center justify-center flex-shrink-0 mt-0.5">
                                                    {i + 1}
                                                </span>
                                                {step}
                                            </li>
                                        ))}
                                    </ol>
                                </div>
                            </div>
                        </section>

                        {/* 2. Response Format */}
                        <section id="response-format" className="space-y-5">
                            <SectionHeading id="response-format" num={2} label="Response Format" />
                            <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-5">
                                <p className="text-sm text-slate-600 dark:text-slate-400">All responses follow a consistent JSON structure:</p>
                                <div className="grid sm:grid-cols-2 gap-4">
                                    <div className="space-y-2">
                                        <p className="text-xs font-bold text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5">
                                            <Check className="w-3.5 h-3.5" /> Success
                                        </p>
                                        <CodeBlock code={`{\n  "success": true,\n  "data": { ... },\n  "meta": {\n    "timestamp": "2026-...",\n    "version": "v2"\n  }\n}`} />
                                    </div>
                                    <div className="space-y-2">
                                        <p className="text-xs font-bold text-red-600 dark:text-red-400 flex items-center gap-1.5">
                                            <AlertCircle className="w-3.5 h-3.5" /> Error
                                        </p>
                                        <CodeBlock code={`{\n  "success": false,\n  "error": {\n    "code": 400,\n    "message": "..."\n  }\n}`} />
                                    </div>
                                </div>
                            </div>
                        </section>

                        {/* 3. Endpoints */}
                        <section id="endpoints" className="space-y-5">
                            <SectionHeading id="endpoints" num={3} label="Endpoints" />
                            <p className="text-sm text-slate-500 dark:text-slate-400">Eight endpoints — all require a valid API key in the <IC>Authorization</IC> header.</p>
                            <div className="space-y-6">

                                <EndpointSection
                                    method="GET" path="/api/v2/packages"
                                    description="List all available data packages with pricing for your account role. Call this first to discover valid network and size combinations."
                                    queryParams={[
                                        { name: 'network', type: 'string', required: false, desc: 'Filter by network: MTN, Telecel, AT-iShare, AT-BigTime (case-sensitive)' },
                                        { name: 'size_gb', type: 'number', required: false, desc: 'Filter by exact GB size e.g. 5' },
                                    ]}
                                    responseBody={`{\n  "success": true,\n  "data": {\n    "packages": [\n      {\n        "id": "uuid-...",\n        "network": "MTN",\n        "size": "5GB",\n        "volume_gb": 5,\n        "price": 4.50,\n        "currency": "GHS"\n      }\n    ],\n    "total": 12\n  }\n}`}
                                    notes={[
                                        'Price is your role-specific price (agent, dealer, or standard customer).',
                                        'Only packages with is_available = true are returned.',
                                        'Use this to validate network/size combinations before placing orders.',
                                    ]}
                                    codeSamples={PACKAGES_SAMPLES}
                                />

                                <EndpointSection
                                    method="POST" path="/api/v2/data/purchase"
                                    description="Purchase a single data bundle for a recipient phone number. Deducts from your wallet instantly."
                                    requestBody={`{\n  "network": "MTN",\n  "volume_gb": 5,\n  "recipient": "0551617309",\n  "reference": "order_001"\n}`}
                                    responseBody={`{\n  "success": true,\n  "data": {\n    "order_id": "uuid-...",\n    "reference": "order_001",\n    "status": "pending",\n    "network": "MTN",\n    "size": "5GB",\n    "recipient": "0551617309",\n    "price": 4.50,\n    "new_balance": 120.50\n  }\n}`}
                                    notes={[
                                        'reference is your idempotency key — sending the same reference twice returns the existing order without double-charging.',
                                        'status is usually "pending", but MAY be "queued" if the recipient number still needs registration on our network — it auto-releases to pending and is fulfilled shortly after. Poll GET /api/v2/orders/{reference} to track it.',
                                        'MTN purchases MAY also return 409 if the recipient number isn\'t yet whitelisted with our supplier (only applies when this optional gate is enabled by an admin) — message reads "This number isn\'t registered to receive MTN data yet. We\'ve submitted it for registration — please try again soon." Retrying shortly usually succeeds once the number is registered. To avoid this, check the number before checkout — see POST /data/verify-number and its /server-1 and /server-2 variants.',
                                        'network must be one of: MTN, Telecel, AT-iShare, AT-BigTime (case-sensitive).',
                                        'volume_gb must match an available package. Use GET /packages to confirm.',
                                        'recipient must be a valid Ghana number: 0XXXXXXXXX (10 digits, starts with 0).',
                                    ]}
                                    codeSamples={PURCHASE_SAMPLES}
                                />

                                <EndpointSection
                                    method="POST" path="/api/v2/data/bulk"
                                    description="Purchase up to 100 data bundles in a single batch. A validation failure (invalid network, package not found, out of stock) rejects the whole batch and nothing is charged; the one exception is MTN recipients not yet whitelisted with our supplier — those orders are skipped individually while the rest of the batch is placed and charged normally."
                                    requestBody={`{\n  "orders": [\n    {\n      "network": "MTN",\n      "volume_gb": 5,\n      "recipient": "0551617309",\n      "reference": "b_001"\n    },\n    {\n      "network": "Telecel",\n      "volume_gb": 2,\n      "recipient": "0201234567",\n      "reference": "b_002"\n    }\n  ]\n}`}
                                    responseBody={`{\n  "success": true,\n  "data": {\n    "orders_placed": 2,\n    "total_cost": 7.00,\n    "new_balance": 113.50,\n    "orders": [\n      { "order_id": "...", "reference": "b_001", "status": "pending" }\n    ],\n    "skipped": []\n  }\n}`}
                                    notes={[
                                        'Maximum 100 orders per batch request.',
                                        'Still atomic for network/package validation failures (invalid network, package not found, out of stock) — one bad order in the array rejects the whole batch and nothing is charged.',
                                        'MTN orders to a recipient not yet whitelisted with our supplier are the one exception: they are skipped individually — not charged, not created — while the rest of the batch is placed normally. Only applies when this optional gate is enabled by an admin.',
                                        'skipped is an array of { recipient, reason }, one entry per order skipped for the whitelist reason above — cross-reference it against your original orders array since skipped orders have no reference or order_id.',
                                        'Each order in the array follows the same rules as single purchase.',
                                    ]}
                                    codeSamples={BULK_SAMPLES}
                                />

                                <EndpointSection
                                    method="POST" path="/api/v2/data/verify-number"
                                    description="Server 1 and Server 2 combined: allowed: true when the number is registered on Server 1 or Server 2. Use it as your checkout gate only when the platform has announced that both servers are accepted — if only one server is accepted, check that server's endpoint instead. It does not tell you which server holds the number: for the actual registration state, use /data/verify-number/server-1 and /server-2. Non-MTN networks always return allowed: true immediately — no need to special-case other networks in your own client."
                                    requestBody={`{\n  "network": "MTN",\n  "recipient": "0551617309"\n}`}
                                    responseBody={`{\n  "success": true,\n  "data": {\n    "recipient": "0551617309",\n    "network": "MTN",\n    "allowed": true\n  }\n}`}
                                    notes={[
                                        'The combined result follows the server(s) the platform currently accepts orders on, so it equals "Server 1 or Server 2" only while both are accepted. Watch platform announcements for which servers are accepted.',
                                        'A number that isn\'t registered yet is automatically submitted for registration — check again soon.',
                                        '/data/purchase independently re-verifies at order time.',
                                        'On an upstream verification outage this endpoint fails open (allowed: true) rather than wrongly telling you a real customer is blocked — treat a true response as "likely fine to proceed", not a guarantee the subsequent purchase will succeed.',
                                        'Rate limit: 20/min per API key, shared across /data/verify-number, /server-1 and /server-2.',
                                    ]}
                                    codeSamples={VERIFY_NUMBER_SAMPLES}
                                />

                                <EndpointSection
                                    method="POST" path="/api/v2/data/verify-number/server-1"
                                    description="The actual registration state on Server 1: allowed tells you whether this number is registered on Server 1 specifically. Use this endpoint to know which server a number is registered on. If only Server 1 is currently accepted, use it as your checkout gate."
                                    requestBody={`{\n  "network": "MTN",\n  "recipient": "0551617309"\n}`}
                                    responseBody={`{\n  "success": true,\n  "data": {\n    "recipient": "0551617309",\n    "network": "MTN",\n    "server": 1,\n    "allowed": true\n  }\n}`}
                                    notes={[
                                        'A number can be registered on one server and not the other. Which server(s) the platform currently accepts orders on can change — check platform announcements or ask support.',
                                        'A number that isn\'t registered on Server 1 is automatically submitted for registration — check again soon.',
                                        'Unlike /data/verify-number, this does not fail open: if Server 1 can\'t be reached it returns 502 instead of a guess.',
                                        'Rate limit: 20/min per API key, shared across /data/verify-number, /server-1 and /server-2.',
                                    ]}
                                    codeSamples={VERIFY_SERVER_1_SAMPLES}
                                />

                                <EndpointSection
                                    method="POST" path="/api/v2/data/verify-number/server-2"
                                    description="The actual registration state on Server 2: allowed tells you whether this number is registered on Server 2 specifically. Use this endpoint to know which server a number is registered on. If only Server 2 is currently accepted, use it as your checkout gate."
                                    requestBody={`{\n  "network": "MTN",\n  "recipient": "0551617309"\n}`}
                                    responseBody={`{\n  "success": true,\n  "data": {\n    "recipient": "0551617309",\n    "network": "MTN",\n    "server": 2,\n    "allowed": false\n  }\n}`}
                                    notes={[
                                        'A number can be registered on one server and not the other. Which server(s) the platform currently accepts orders on can change — check platform announcements or ask support.',
                                        'A number that isn\'t registered on Server 2 is automatically submitted for registration — check again soon.',
                                        'Unlike /data/verify-number, this does not fail open: if Server 2 can\'t be reached it returns 502 instead of a guess.',
                                        'Rate limit: 20/min per API key, shared across /data/verify-number, /server-1 and /server-2.',
                                    ]}
                                    codeSamples={VERIFY_SERVER_2_SAMPLES}
                                />

                                <EndpointSection
                                    method="GET" path="/api/v2/wallet/balance"
                                    description="Retrieve your current wallet balance in GHS. Use before large orders to verify you have sufficient funds."
                                    responseBody={`{\n  "success": true,\n  "data": {\n    "balance": 124.50,\n    "currency": "GHS"\n  }\n}`}
                                    notes={[
                                        'Top up your wallet via the web dashboard at kingflexygh.com/dashboard/wallet.',
                                        'Check balance before bulk orders to prevent partial failures due to insufficient funds.',
                                    ]}
                                    codeSamples={BALANCE_SAMPLES}
                                />

                                <EndpointSection
                                    method="GET" path="/api/v2/orders/{reference}"
                                    description="Check the fulfillment status of an order using the reference code you provided when placing it."
                                    responseBody={`{\n  "success": true,\n  "data": {\n    "order_id": "uuid-...",\n    "reference": "order_001",\n    "status": "completed",\n    "network": "MTN",\n    "size": "5GB",\n    "recipient": "0551617309",\n    "price": 4.50,\n    "source": "api",\n    "created_at": "2026-..."\n  }\n}`}
                                    notes={[
                                        'Use the same reference you passed when calling /data/purchase or /data/bulk.',
                                        'Status lifecycle: pending | queued → processing → completed | failed | refunded.',
                                        'pending — order accepted and awaiting dispatch to the network.',
                                        'queued — the recipient MTN number is not yet registered with our network provider, so the order is held (not dispatched); it auto-releases to pending and is fulfilled once registration completes, usually within a short period.',
                                        'processing — dispatched to the network and being fulfilled.',
                                        'completed — bundle delivered successfully.',
                                        'failed — the order could not be fulfilled.',
                                        'refunded — the order was refunded to your wallet / original payment method.',
                                        'Poll this endpoint after placing an order to confirm delivery.',
                                    ]}
                                    codeSamples={ORDER_STATUS_SAMPLES}
                                />

                            </div>
                        </section>

                        {/* 4. Account & Role (v2) */}
                        <section id="account-role" className="space-y-5">
                            <SectionHeading id="account-role" num={4} label="Account & Role" />
                            <p className="text-sm text-slate-500 dark:text-slate-400">
                                Check your own role and, if it&apos;s time-limited, how many days are left — no support ticket needed.
                            </p>
                            <div className="space-y-6">
                                <EndpointSection
                                    method="GET" path="/api/v2/account/role"
                                    description="Returns your current role and, for dealer/agent, the days remaining before it lapses."
                                    responseBody={`{\n  "success": true,\n  "data": {\n    "role": "dealer",\n    "is_active": true,\n    "is_permanent": false,\n    "expires_at": "2026-...",\n    "days_remaining": 12\n  }\n}`}
                                    notes={[
                                        'is_permanent: true and expires_at: null means a lifetime dealer/agent, or a plain customer account — there is nothing to expire.',
                                        'is_active becomes false the moment expires_at passes, even though role in the users table has not changed yet — the platform prices you as a customer from that exact moment on every endpoint, not just this one.',
                                        'Rate limit: 30/min.',
                                    ]}
                                    codeSamples={ACCOUNT_ROLE_SAMPLES}
                                />
                            </div>
                        </section>

                        {/* 5. Airtime (v2) */}
                        <section id="airtime" className="space-y-5">
                            <SectionHeading id="airtime" num={5} label="Airtime (v2)" />
                            <p className="text-sm text-slate-500 dark:text-slate-400">
                                Send MTN, Telecel, or AT airtime to a beneficiary at face value — no fee — on behalf of your customers,
                                and earn a share of KiNG FLEXY GH&apos;s provider commission on every top-up. This endpoint only accepts a{' '}
                                <IC>Commission Services</IC> key (prefix <IC>kf_cs_live_...</IC>); a <IC>standard</IC> key is rejected with{' '}
                                <IC>403</IC>.
                            </p>
                            <div className="space-y-6">
                                <EndpointSection
                                    method="POST" path="/api/v2/airtime/purchase"
                                    description="Send airtime to a beneficiary at face value from your wallet. Auto-dispatches in the background — poll GET /airtime/orders/{reference} for the final status."
                                    requestBody={`{\n  "network": "MTN",\n  "beneficiary_phone": "0551617309",\n  "amount": 10,\n  "reference": "air_001"\n}`}
                                    responseBody={`{\n  "success": true,\n  "data": {\n    "order_id": "uuid-...",\n    "reference": "air_001",\n    "status": "pending",\n    "network": "MTN",\n    "beneficiary_phone": "0551617309",\n    "airtime_amount": 10,\n    "fee_amount": 0,\n    "total_paid": 10,\n    "new_balance": 90\n  }\n}`}
                                    notes={[
                                        'reference is your idempotency key (3–100 chars) — a repeat with the SAME reference and body returns the existing order instead of charging again; a reused reference against a DIFFERENT order returns 409 and your wallet is not charged.',
                                        'fee_amount is always 0 — the beneficiary receives the full amount at face value; your earnings come from a share of KiNG FLEXY GH\'s own provider commission, credited to your Commission Wallet once the order completes, not deducted from this transaction.',
                                        'Rate limit: 10/min.',
                                    ]}
                                    codeSamples={AIRTIME_PURCHASE_SAMPLES}
                                />
                                <EndpointSection
                                    method="GET" path="/api/v2/airtime/orders"
                                    description="List your most recent airtime orders."
                                    responseBody={`{\n  "success": true,\n  "data": {\n    "orders": [ { "order_id": "uuid-...", "reference": "air_001", "status": "completed", "network": "MTN", "airtime_amount": 10 } ]\n  }\n}`}
                                    notes={['Returns at most 30 records, newest first. Rate limit: 30/min.']}
                                    codeSamples={AIRTIME_ORDERS_SAMPLES}
                                />
                                <EndpointSection
                                    method="GET" path="/api/v2/airtime/orders/{reference}"
                                    description="Check the status of one airtime order using the reference you sent when placing it."
                                    responseBody={`{\n  "success": true,\n  "data": {\n    "order_id": "uuid-...",\n    "reference": "air_001",\n    "status": "refunded",\n    "network": "MTN",\n    "beneficiary_phone": "0551617309",\n    "airtime_amount": 10,\n    "reason": "The transaction could not be completed by the payment provider."\n  }\n}`}
                                    notes={['Rate limit: 30/min.', 'Status flow: pending → processing → completed | failed | refunded. A definitive provider failure auto-refunds your wallet — status becomes "refunded" and `reason` is present with a short, fixed explanation (never raw provider text).']}
                                    codeSamples={AIRTIME_STATUS_SAMPLES}
                                />
                            </div>
                        </section>

                        {/* 6. Results Checker (v2) */}
                        <section id="resultschecker" className="space-y-5">
                            <SectionHeading id="resultschecker" num={6} label="Results Checker (v2)" />
                            <p className="text-sm text-slate-500 dark:text-slate-400">
                                Sell WAEC/BECE/WASSCE results checker vouchers. Same <IC>standard</IC> key.
                            </p>
                            <div className="rounded-xl bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800/50 p-4 text-xs text-amber-800 dark:text-amber-200 leading-relaxed">
                                <strong>Vouchers are returned directly in the purchase response</strong> — there is no separate
                                &quot;retrieve voucher&quot; call. <IC>recipientPhone</IC> / <IC>recipientEmail</IC> are optional
                                and have no fallback to your own account: omit both and KiNG FLEXY GH sends nothing — you own
                                delivering the voucher to your customer.
                            </div>
                            <div className="space-y-6">
                                <EndpointSection
                                    method="GET" path="/api/v2/resultschecker/types"
                                    description="List available voucher types with YOUR OWN role-based price and current stock."
                                    responseBody={`{\n  "success": true,\n  "data": {\n    "types": [ { "type_id": "uuid-...", "name": "WAEC BECE", "price": 18, "available_count": 412, "is_active": true } ]\n  }\n}`}
                                    notes={['Rate limit: 30/min.']}
                                    codeSamples={RC_TYPES_SAMPLES}
                                />
                                <EndpointSection
                                    method="POST" path="/api/v2/resultschecker/purchase"
                                    description="Buy voucher(s). Stock is checked BEFORE your wallet is touched — insufficient stock is rejected upfront, never charged then refunded."
                                    requestBody={`{\n  "typeId": "uuid-of-a-type-from-GET-types",\n  "quantity": 1,\n  "reference": "rc_001",\n  "recipientPhone": "0551617309",\n  "recipientEmail": "customer@example.com"\n}`}
                                    responseBody={`{\n  "success": true,\n  "data": {\n    "order": { "id": "uuid-...", "reference": "rc_001", "status": "completed", "type_name": "WAEC BECE", "quantity": 1, "unit_price": 18, "total_paid": 18 },\n    "vouchers": [ { "id": "uuid-...", "pin": "1234-5678-9012", "serial_number": "SN-000123" } ],\n    "new_balance": 82\n  }\n}`}
                                    notes={[
                                        'recipientPhone / recipientEmail are OPTIONAL. Pass either (or both) to also have KiNG FLEXY GH deliver the voucher by SMS/email as a courtesy — the vouchers array in this response is always the authoritative copy either way.',
                                        'reference is your idempotency key — a reused reference against a different order returns 409, wallet untouched.',
                                        'Rate limit: 10/min.',
                                    ]}
                                    codeSamples={RC_PURCHASE_SAMPLES}
                                />
                                <EndpointSection
                                    method="GET" path="/api/v2/resultschecker/orders"
                                    description="List your most recent results checker orders."
                                    responseBody={`{\n  "success": true,\n  "data": {\n    "orders": [ { "id": "uuid-...", "reference": "rc_001", "status": "completed", "type_name": "WAEC BECE", "quantity": 1 } ]\n  }\n}`}
                                    notes={['Returns at most 30 records, newest first. Rate limit: 30/min.']}
                                    codeSamples={RC_ORDERS_SAMPLES}
                                />
                                <EndpointSection
                                    method="GET" path="/api/v2/resultschecker/orders/{reference}"
                                    description="Look up one order, including its vouchers again if you need to recover them."
                                    responseBody={`{\n  "success": true,\n  "data": {\n    "order": { "id": "uuid-...", "reference": "rc_001", "status": "completed" },\n    "vouchers": [ { "id": "uuid-...", "pin": "1234-5678-9012", "serial_number": "SN-000123" } ]\n  }\n}`}
                                    notes={['Rate limit: 30/min.']}
                                    codeSamples={RC_STATUS_SAMPLES}
                                />
                            </div>
                        </section>

                        {/* 7. AFA Registration (v2) */}
                        <section id="afa" className="space-y-5">
                            <SectionHeading id="afa" num={7} label="AFA Registration (v2)" />
                            <p className="text-sm text-slate-500 dark:text-slate-400">
                                Register an MTN AFA agent on behalf of your customer. Same <IC>standard</IC> key.
                            </p>
                            <div className="space-y-6">
                                <EndpointSection
                                    method="POST" path="/api/v2/afa/register"
                                    description="Submit an AFA registration. Requires a valid Ghana Card and a supported region."
                                    requestBody={`{\n  "reference": "afa_001",\n  "full_name": "Kwame Mensah",\n  "phone": "0551617309",\n  "id_type": "Ghana Card",\n  "id_number": "GHA-123456789-0",\n  "date_of_birth": "1995-04-12",\n  "region": "Greater Accra",\n  "location": "Madina"\n}`}
                                    responseBody={`{\n  "success": true,\n  "data": {\n    "order_id": "uuid-...",\n    "reference": "afa_001",\n    "status": "pending",\n    "new_balance": 64.0\n  }\n}`}
                                    notes={[
                                        'id_type must be exactly "Ghana Card"; id_number must match GHA-XXXXXXXXX-X.',
                                        'region must be one of the 16 official Ghana regions (Greater Accra, Ashanti, Western, Eastern, Central, Northern, Volta, Upper East, Upper West, Bono, Bono East, Ahafo, Savannah, North East, Oti, Western North).',
                                        'Applicant must be 18 or older — computed from date_of_birth.',
                                        'reference is your idempotency key. It is GLOBAL across all developers, not just your own account — a reused reference already taken by anyone returns 409, never a silent success.',
                                        'This carries Ghana Card KYC data — send it only over HTTPS, which is all this API accepts.',
                                        'Rate limit: 10/min.',
                                    ]}
                                    codeSamples={AFA_REGISTER_SAMPLES}
                                />
                                <EndpointSection
                                    method="GET" path="/api/v2/afa/orders"
                                    description="List your most recent AFA registrations."
                                    responseBody={`{\n  "success": true,\n  "data": {\n    "orders": [ { "id": "uuid-...", "reference": "afa_001", "status": "pending" } ]\n  }\n}`}
                                    notes={['Returns at most 30 records, newest first. Rate limit: 30/min.']}
                                    codeSamples={AFA_ORDERS_SAMPLES}
                                />
                                <EndpointSection
                                    method="GET" path="/api/v2/afa/orders/{reference}"
                                    description="Check the status of one AFA registration."
                                    responseBody={`{\n  "success": true,\n  "data": {\n    "id": "uuid-...",\n    "reference": "afa_001",\n    "status": "processing"\n  }\n}`}
                                    notes={[
                                        'Status lifecycle: pending → processing → completed | cancelled.',
                                        'Rate limit: 30/min.',
                                    ]}
                                    codeSamples={AFA_STATUS_SAMPLES}
                                />
                            </div>
                        </section>

                        {/* 8. SMS API */}
                        <section id="sms" className="space-y-5">
                            <SectionHeading id="sms" num={8} label="SMS API" />
                            <p className="text-sm text-slate-500 dark:text-slate-400">
                                Send bulk and transactional SMS from your own systems — OTPs, order updates,
                                campaigns — with per-recipient delivery tracking.
                            </p>
                            <div className="rounded-xl border border-amber-200 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-900/15 p-4 text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
                                {SMS_BUSINESS_MODE_NOTICE}{' '}
                                <Link href="/dashboard/sms/business" className="underline font-semibold">SMS dashboard</Link>
                                {' · '}
                                <Link href="/dashboard/sms/credits" className="underline font-semibold">Credits page</Link>
                            </div>
                            <div className="space-y-6">

                                {SMS_API_ENDPOINTS.map(ep => (
                                    <EndpointSection
                                        key={ep.path}
                                        method={ep.method}
                                        path={ep.path}
                                        description={ep.description}
                                        queryParams={ep.queryParams}
                                        requestBody={ep.requestBody}
                                        responseBody={ep.responseBody}
                                        notes={ep.notes}
                                        codeSamples={ep.codeSamples}
                                    />
                                ))}

                            </div>
                        </section>

                        {/* 9. Utility Bills (Commission) */}
                        <section id="utilities" className="space-y-5">
                            <SectionHeading id="utilities" num={9} label="Utility Bills (Commission)" />
                            <p className="text-sm text-slate-500 dark:text-slate-400">
                                Pay ECG, Ghana Water, DSTV, GOtv, or StarTimes bills at face value on behalf of your customers — and earn a
                                share of KiNG FLEXY GH&apos;s provider commission on every payment.
                            </p>
                            <div className="rounded-xl border border-violet-200 dark:border-violet-800/50 bg-violet-50 dark:bg-violet-900/15 p-4 text-xs text-violet-800 dark:text-violet-300 leading-relaxed space-y-2">
                                <p>
                                    <strong>Separate key required.</strong> These four endpoints only accept a{' '}
                                    <strong>Commission Services key</strong> (prefix <IC>kf_cs_live_...</IC>) — a standard key is rejected with{' '}
                                    <IC>403</IC>. The reverse is also true: a Commission Services key is rejected with <IC>403</IC> on every
                                    other <IC>/api/v2/*</IC> endpoint (packages, data purchases, wallet, SMS, etc.).
                                </p>
                                <p>
                                    Generate one from <Link href="/dashboard/api" className="underline font-semibold">Dashboard → Developer API</Link> — no shop
                                    required. Your commission is paid into a dedicated <strong>Commission Wallet</strong>, separate from shop earnings. Like
                                    the standard key, it starts <IC>pending</IC> and needs admin approval before it works.
                                </p>
                                <p>
                                    <strong>How the money moves:</strong> the bill&apos;s face value is debited from your <strong>main wallet</strong> when
                                    you call <IC>POST /pay</IC>. Once the order reaches <IC>completed</IC>, your <IC>commission_share_percent</IC> cut
                                    of the platform&apos;s commission is credited automatically to your <strong>Commission Wallet</strong> — transfer it
                                    instantly to your main or shop wallet, or withdraw it via Paystack Mobile Money.
                                </p>
                            </div>
                            <div className="space-y-6">

                                <EndpointSection
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
                                    codeSamples={UTIL_BILLERS_SAMPLES}
                                />

                                <EndpointSection
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
                                    codeSamples={UTIL_LOOKUP_SAMPLES}
                                />

                                <div className="flex items-start gap-3 rounded-xl bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800/50 p-4">
                                    <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                                    <p className="text-sm text-amber-800 dark:text-amber-200 leading-relaxed">
                                        <strong>reference on /pay is a pure idempotency key, not a distinct-payment key.</strong> Reusing the same
                                        reference — even with a different biller, account, or amount — returns the details of the <strong>ORIGINAL</strong> order
                                        and never charges you again; it does not re-validate against the new values you sent. Use a unique reference
                                        for every distinct bill. Reuse the same reference ONLY to safely retry the exact same payment (e.g. after a
                                        network timeout).
                                    </p>
                                </div>

                                <EndpointSection
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
                                        'commission_share_percent is your cut of the platform commission (admin-configurable) — it is credited to your Commission Wallet once the order completes, not at response time.',
                                    ]}
                                    codeSamples={UTIL_PAY_SAMPLES}
                                />

                                <EndpointSection
                                    method="GET" path="/api/v2/utilities/orders/{reference}"
                                    description="Poll the fulfillment status of a utility bill order using the reference from the /pay response. Only returns orders that belong to your own account."
                                    responseBody={`{\n  "success": true,\n  "data": {\n    "reference": "UTIL-DSTV-3f9a2b1c4d5e6f70",\n    "status": "refunded",\n    "payment_status": "paid",\n    "biller": "dstv",\n    "account_number": "7041234567",\n    "account_name": "KWAME MENSAH",\n    "amount": 65.00,\n    "commission_earned": null,\n    "reason": "The transaction could not be completed by the payment provider.",\n    "created_at": "2026-...",\n    "updated_at": "2026-..."\n  }\n}`}
                                    notes={[
                                        'Status flow: pending → processing → completed | failed | refunded.',
                                        'The account field here is called account_number — not account as in the /pay request body. Same value, different key name across endpoints.',
                                        'commission_earned is null until the order reaches completed — it is your realized share of the commission, credited to your Commission Wallet at that point.',
                                        'A definitive provider failure auto-refunds your wallet — status becomes "refunded" and reason is present with a short, fixed explanation (never raw provider text).',
                                        'Poll every few seconds after /pay until status leaves pending / processing.',
                                    ]}
                                    codeSamples={UTIL_STATUS_SAMPLES}
                                />

                            </div>

                            <div>
                                <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-3">Rate Limits (per key)</p>
                                <DocTable
                                    head={['Endpoint', 'Limit']}
                                    rows={[
                                        [<code key="rl1" className="font-mono text-violet-600 dark:text-violet-400 text-xs">GET /billers</code>, '30 / min'],
                                        [<code key="rl2" className="font-mono text-violet-600 dark:text-violet-400 text-xs">GET /lookup</code>, '10 / min'],
                                        [<code key="rl3" className="font-mono text-violet-600 dark:text-violet-400 text-xs">POST /pay</code>, '6 / min'],
                                        [<code key="rl4" className="font-mono text-violet-600 dark:text-violet-400 text-xs">GET /orders/{'{reference}'}</code>, '30 / min'],
                                    ]}
                                />
                            </div>

                            <div>
                                <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-3">Error Codes (this section)</p>
                                <DocTable
                                    head={['Code', 'When it occurs']}
                                    rows={[
                                        [<span key="u400" className="font-mono font-bold text-red-500">400</span>, 'Invalid biller/account/phone/amount/reference, or insufficient wallet balance'],
                                        [<span key="u401" className="font-mono font-bold text-red-500">401</span>, 'Missing or invalid API key'],
                                        [<span key="u403" className="font-mono font-bold text-red-500">403</span>, 'Wrong key type (commission key required here; standard key required everywhere else), key pending/revoked, or account suspended'],
                                        [<span key="u404" className="font-mono font-bold text-red-500">404</span>, 'Account/meter/smartcard not found (lookup), or order not found (status)'],
                                        [<span key="u409" className="font-mono font-bold text-amber-500">409</span>, 'Duplicate order — same biller + account + amount resent within 30s without a reference'],
                                        [<span key="u429" className="font-mono font-bold text-amber-500">429</span>, 'Rate limit exceeded — see limits above'],
                                        [<span key="u502" className="font-mono font-bold text-slate-500">502</span>, 'Billing provider temporarily unreachable — retry shortly (lookup only)'],
                                        [<span key="u503" className="font-mono font-bold text-slate-500">503</span>, 'Utility bills, or this specific biller, currently disabled by an admin'],
                                    ]}
                                />
                            </div>
                        </section>

                        {/* 10. USSD for Resellers */}
                        <section id="ussd" className="space-y-5">
                            <SectionHeading id="ussd" num={10} label="USSD for Resellers" />
                            <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-4">
                                <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
                                    Many data resellers need USSD for customers without smartphones. Our products are
                                    available over USSD in two ways, with no extra integration work on your side.
                                </p>
                                <ul className="list-disc pl-5 space-y-2 text-sm text-slate-600 dark:text-slate-400">
                                    {USSD_DETAILS.map(d => <li key={d}>{d}</li>)}
                                </ul>
                                <Link href="/developers/ussd" className="inline-flex text-sm font-semibold text-violet-600 dark:text-violet-400 underline">
                                    Read more about USSD for resellers
                                </Link>
                            </div>
                        </section>

                        {/* 11. Tips & Recommendations */}
                        <section id="tips" className="space-y-6">
                            <SectionHeading id="tips" num={11} label="Tips & Recommendations" />
                            <p className="text-sm text-slate-500 dark:text-slate-400">
                                One key type, one purpose — a <IC>standard</IC> key covers data, results checker and
                                AFA; a <IC>Commission Services</IC> key covers utilities and airtime; an <IC>SMS</IC> key covers SMS. A key
                                is confined to its own section — a standard key cannot call <IC>/utilities/*</IC>, <IC>/airtime/*</IC>, or{' '}
                                <IC>/sms/*</IC>, and vice versa.
                            </p>

                            <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-4">
                                <p className="text-sm font-bold text-slate-800 dark:text-slate-100">Standard key — data, results checker, AFA</p>
                                <ul className="space-y-2.5 text-sm text-slate-600 dark:text-slate-400">
                                    <li className="flex items-start gap-2"><span className="text-violet-500 font-bold mt-0.5">→</span><span>Always send a unique <IC>reference</IC> per order — it becomes your idempotency key. A retry with the SAME reference and body safely returns the existing order instead of charging twice; reusing a reference for a genuinely DIFFERENT order returns <IC>409</IC> instead of a silent duplicate charge.</span></li>
                                    <li className="flex items-start gap-2"><span className="text-violet-500 font-bold mt-0.5">→</span><span>Poll <IC>GET .../orders/&#123;reference&#125;</IC> after placing an order rather than assuming success from the initial <IC>pending</IC> status.</span></li>
                                    <li className="flex items-start gap-2"><span className="text-violet-500 font-bold mt-0.5">→</span><span>Results Checker vouchers arrive directly in the purchase response — save them immediately. There is no separate voucher-retrieval call beyond the order-status lookup.</span></li>
                                    <li className="flex items-start gap-2"><span className="text-violet-500 font-bold mt-0.5">→</span><span>Validate the AFA Ghana Card format and region client-side before calling the API — it avoids a wasted request on an obvious input mistake.</span></li>
                                    <li className="flex items-start gap-2"><span className="text-violet-500 font-bold mt-0.5">→</span><span>If you serve dealer/agent accounts, check <IC>GET /account/role</IC> — pricing is expiry-aware everywhere, so a lapsed reseller is automatically billed as a customer the moment their tier expires.</span></li>
                                    <li className="flex items-start gap-2"><span className="text-violet-500 font-bold mt-0.5">→</span><span>Every list endpoint returns at most 30 records. Design your integration to look up by reference or page through results, not to fetch everything in one call.</span></li>
                                </ul>
                            </div>

                            <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-4">
                                <p className="text-sm font-bold text-slate-800 dark:text-slate-100">MTN number registration checks</p>
                                <ul className="space-y-2.5 text-sm text-slate-600 dark:text-slate-400">
                                    <li className="flex items-start gap-2"><span className="text-violet-500 font-bold mt-0.5">→</span><span>To know the <strong>actual registration state</strong> of a number — which server it is registered on — call <IC>POST /data/verify-number/server-1</IC> and <IC>POST /data/verify-number/server-2</IC>. A number can be registered on one and not the other.</span></li>
                                    <li className="flex items-start gap-2"><span className="text-violet-500 font-bold mt-0.5">→</span><span><IC>POST /data/verify-number</IC> is the <strong>combination of Server 1 and Server 2</strong>. Use it as your checkout gate only when the platform announces that both servers are accepted. If only one server is accepted, gate on that server&apos;s endpoint instead.</span></li>
                                    <li className="flex items-start gap-2"><span className="text-violet-500 font-bold mt-0.5">→</span><span>Which server(s) are accepted can change — watch platform announcements, or ask support, rather than hardcoding an assumption.</span></li>
                                    <li className="flex items-start gap-2"><span className="text-violet-500 font-bold mt-0.5">→</span><span>A number that isn&apos;t registered is automatically submitted for registration. There is no fixed turnaround — check again soon rather than after a set time.</span></li>
                                    <li className="flex items-start gap-2"><span className="text-violet-500 font-bold mt-0.5">→</span><span>The three checks share one <IC>20/min</IC> limit per API key. Check once at checkout, not on every keystroke.</span></li>
                                </ul>
                            </div>

                            <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-4">
                                <p className="text-sm font-bold text-slate-800 dark:text-slate-100">Commission Services key — utilities, airtime</p>
                                <ul className="space-y-2.5 text-sm text-slate-600 dark:text-slate-400">
                                    <li className="flex items-start gap-2"><span className="text-violet-500 font-bold mt-0.5">→</span><span>Call <IC>GET /utilities/billers</IC> and <IC>GET /utilities/lookup</IC> before <IC>POST /utilities/pay</IC> — the payment call validates against what lookup returns, so skipping it just produces avoidable 400s.</span></li>
                                    <li className="flex items-start gap-2"><span className="text-violet-500 font-bold mt-0.5">→</span><span>This key type is scoped to <IC>/utilities/*</IC> and <IC>/airtime/*</IC> only — it cannot reach data, results checker, AFA, or SMS endpoints.</span></li>
                                </ul>
                            </div>

                            <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-4">
                                <p className="text-sm font-bold text-slate-800 dark:text-slate-100">SMS key</p>
                                <ul className="space-y-2.5 text-sm text-slate-600 dark:text-slate-400">
                                    <li className="flex items-start gap-2"><span className="text-violet-500 font-bold mt-0.5">→</span><span>Check <IC>GET /sms/senders</IC> for your approved sender IDs before sending — an unapproved sender ID is rejected outright.</span></li>
                                    <li className="flex items-start gap-2"><span className="text-violet-500 font-bold mt-0.5">→</span><span>Check <IC>GET /sms/balance</IC> before a large campaign so you don&apos;t hit a funding failure mid-send.</span></li>
                                    <li className="flex items-start gap-2"><span className="text-violet-500 font-bold mt-0.5">→</span><span>Campaign and message list endpoints are capped at 30 records per page — page with <IC>?page=</IC> rather than assuming one call covers a whole campaign.</span></li>
                                </ul>
                            </div>

                            <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-4">
                                <p className="text-sm font-bold text-slate-800 dark:text-slate-100">Network number validation</p>
                                <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
                                    We detect a recipient/beneficiary&apos;s network from the number&apos;s prefix before submitting an
                                    order. As of this writing:
                                </p>
                                <DocTable
                                    head={['Network', 'Prefixes']}
                                    rows={[
                                        ['MTN', '024, 025, 053, 054, 055, 059'],
                                        ['Telecel', '020, 050'],
                                        ['AirtelTigo', '026, 027, 056, 057'],
                                    ]}
                                />
                                <p className="text-xs text-amber-700 dark:text-amber-400 leading-relaxed">
                                    These are <strong>not guaranteed to stay fixed</strong> — Ghanaian operators occasionally get
                                    reassigned or new ranges opened by the regulator. Don&apos;t hardcode this list as a permanent
                                    source of truth in your own client-side validation; our API&apos;s response is the final word on
                                    whether a number/network pairing is accepted, and it&apos;s worth re-checking this page
                                    periodically for changes.
                                </p>
                            </div>

                            <div className="rounded-xl bg-violet-50 dark:bg-violet-900/15 border border-violet-200 dark:border-violet-800/50 p-4 text-sm text-violet-800 dark:text-violet-300">
                                Need a higher rate limit, custom pricing, or a role adjustment? Message admin support from your
                                dashboard — don&apos;t build workarounds around a limit; we can usually just raise it for you.
                            </div>
                        </section>

                        {/* 11. Networks */}
                        <section id="networks" className="space-y-5">
                            <SectionHeading id="networks" num={12} label="Supported Networks" />
                            <DocTable
                                head={['Network Value', 'Provider', 'Notes']}
                                rows={[
                                    [<code key="mtn" className="font-mono text-violet-600 dark:text-violet-400 text-xs">"MTN"</code>, 'MTN Ghana', 'Most widely available bundles'],
                                    [<code key="tel" className="font-mono text-violet-600 dark:text-violet-400 text-xs">"Telecel"</code>, 'Telecel Ghana (formerly Vodafone)', ''],
                                    [<code key="at1" className="font-mono text-violet-600 dark:text-violet-400 text-xs">"AT-iShare"</code>, 'AirtelTigo iShare', 'AirtelTigo bundle type 1'],
                                    [<code key="at2" className="font-mono text-violet-600 dark:text-violet-400 text-xs">"AT-BigTime"</code>, 'AirtelTigo BigTime', 'AirtelTigo bundle type 2'],
                                ]}
                            />
                            <div className="rounded-xl bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800/50 p-4 text-sm text-amber-800 dark:text-amber-200">
                                Network values are <strong>case-sensitive</strong>. Use <IC>GET /packages</IC> to see exactly which networks and sizes are currently available.
                            </div>
                            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                                This is the complete list — the four networks above are the only ones this API serves. There is no
                                network value for any carrier outside Ghana, and none will be accepted.
                            </p>
                        </section>

                        {/* 12. Error Codes */}
                        <section id="errors" className="space-y-5">
                            <SectionHeading id="errors" num={13} label="Error Codes" />
                            <DocTable
                                head={['Code', 'When it occurs']}
                                rows={[
                                    [<span key="400" className="font-mono font-bold text-red-500">400</span>, 'Bad request — invalid phone, volume_gb, network value, or malformed body'],
                                    [<span key="401" className="font-mono font-bold text-red-500">401</span>, 'Missing or invalid API key'],
                                    [<span key="403" className="font-mono font-bold text-red-500">403</span>, 'Key pending approval, revoked, suspended account, or role not allowed'],
                                    [<span key="404" className="font-mono font-bold text-red-500">404</span>, 'Package or order not found for the given network/size/reference'],
                                    [<span key="409" className="font-mono font-bold text-amber-500">409</span>, 'Duplicate reference — an order with this reference already exists. On /data/purchase specifically, an MTN recipient not yet whitelisted with our supplier also returns 409 (see that endpoint\'s notes) — /data/bulk skips those orders individually instead of returning an error.'],
                                    [<span key="429" className="font-mono font-bold text-amber-500">429</span>, 'Rate limit exceeded — back off and retry after a short delay'],
                                    [<span key="500" className="font-mono font-bold text-slate-500">500</span>, 'Internal server error — contact support if persistent'],
                                    [<span key="503" className="font-mono font-bold text-slate-500">503</span>, 'API feature temporarily disabled by administrator'],
                                ]}
                            />
                        </section>

                        {/* 13. Code Examples */}
                        <section id="examples" className="space-y-5">
                            <SectionHeading id="examples" num={14} label="Full Examples" />
                            <p className="text-sm text-slate-600 dark:text-slate-300">Complete runnable data purchase example. Select your language.</p>
                            <div className="flex flex-wrap gap-1 p-1 bg-slate-200 dark:bg-slate-800 rounded-xl w-fit">
                                {LANG_TABS.map(l => (
                                    <button key={l} onClick={() => setActiveLang(l)}
                                        className={cn('px-4 py-2 rounded-lg text-sm font-semibold transition-all',
                                            activeLang === l
                                                ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm'
                                                : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'
                                        )}>
                                        {l}
                                    </button>
                                ))}
                            </div>
                            <CodeBlock code={PURCHASE_SAMPLES[activeLang]} label={activeLang} />
                        </section>

                        {/* Footer */}
                        <div className="border-t border-slate-200 dark:border-slate-800 pt-10 text-center">
                            <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">Ready to start building?</p>
                            <div className="flex flex-wrap items-center justify-center gap-3">
                                <Link href="/dashboard/api">
                                    <Button className="bg-violet-600 hover:bg-violet-700 text-white font-bold gap-2 px-6">
                                        Get Your API Key <ArrowRight className="w-4 h-4" />
                                    </Button>
                                </Link>
                                <a href="https://documenter.getpostman.com/view/55615613/2sBYAuTBhF" target="_blank" rel="noopener noreferrer">
                                    <Button variant="outline" className="font-bold gap-2 px-6">
                                        Postman Collection <ExternalLink className="w-4 h-4" />
                                    </Button>
                                </a>
                            </div>
                            <p className="mt-6 text-xs text-slate-400 dark:text-slate-600">
                                © {new Date().getFullYear()} KiNG FLEXY TECHNOLOGIES LTD · Need help? Contact support via your dashboard.
                            </p>
                        </div>

                    </div>
                </div>
            </div>
        </div>
    )
}
