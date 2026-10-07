// Single source of truth for the SMS API docs — rendered on /developers,
// the SMS dashboard's API tab (a later task), and the public /sms marketing
// page. Edit here, not in the consuming pages.
//
// Uses a dedicated kf_sms_live_ placeholder (not the general kf_live_ one)
// because /api/v2/sms/* requires an sms-type key — a standard key is
// rejected there (see lib/api-auth.ts's key-type scope guard, shipped
// earlier in this plan).
//
// v1 has been fully ported and eliminated (owner decision, 2026-08-31) — this
// is now the only live base URL. Every code sample and path literal below was
// still pointing at v1 until this fix, since this file predates the port.

const SMS_BASE = 'https://api.kingflexygh.com/api/v2'
const SMS_KEY = 'kf_sms_live_your_api_key_here'

export const SMS_BUSINESS_MODE_NOTICE =
    "Business mode required. The SMS API is available once your business " +
    "(domain + description) is registered and approved on the SMS dashboard. " +
    "You then send under a default sender ID from our pool — or your own " +
    "sender ID after network approval (Ghana Card required). SMS credits are " +
    "purchased on the credits page; 1 credit = 1 SMS segment (160 GSM chars) " +
    "per recipient. Generate your SMS API key from the SMS dashboard's API & " +
    "Docs tab — it's separate from your general developer API key and " +
    "activates immediately, no approval wait."

export type SmsApiLangTab = 'cURL' | 'Node.js' | 'PHP' | 'Python'

export interface SmsApiEndpointDoc {
    method: 'GET' | 'POST'
    path: string
    description: string
    queryParams?: { name: string; type: string; required: boolean; desc: string }[]
    requestBody?: string
    responseBody: string
    notes: string[]
    codeSamples: Record<SmsApiLangTab, string>
}

export const SMS_API_ENDPOINTS: SmsApiEndpointDoc[] = [
    {
        method: 'POST',
        path: '/api/v2/sms/send',
        description: 'Send an SMS to one or many recipients. Small sends (≤500 recipients) dispatch immediately and return per-send results; larger sends are queued and processed within a minute.',
        requestBody: `{\n  "message": "Your order #123 is ready. Thank you!",\n  "recipients": ["0551234567", "0209876543"],\n  "sender": "AcmeGH",\n  "reference": "order-123"\n}`,
        responseBody: `{\n  "success": true,\n  "data": {\n    "campaignId": "uuid-...",\n    "status": "completed",\n    "recipients": 2,\n    "segments": 1,\n    "creditsCharged": 2,\n    "sender": "AcmeGH",\n    "sent": 2,\n    "failed": 0,\n    "balance": 498\n  }\n}`,
        notes: [
            'message: 3–1000 characters. Cost = SMS segments × recipients (GSM-7: 160 chars = 1 segment; unicode/emoji reduce this to 70).',
            'recipients: a string or array of Ghana numbers (0XXXXXXXXX or 233XXXXXXXXX), up to 10,000 per call. Duplicates are removed automatically.',
            "sender is optional — defaults to your account's sending identity. It MUST be one of your approved sender IDs or a pool sender (call GET /sms/senders); any other value is rejected with 400.",
            'reference is an optional idempotency key (≤100 chars): retrying with the same reference returns the original campaign instead of sending again or double-charging.',
            'Credits are debited up-front; provider-rejected messages are refunded automatically when the campaign settles.',
            'Content policy: telco transaction-message impersonation (fake MoMo receipts etc.) is blocked. Links to any domain are allowed for business accounts.',
            'HTTP 402 = insufficient SMS credits. HTTP 403 = wrong key type (use your SMS API key, not your general developer key) or account suspended. HTTP 429 = rate limited.',
        ],
        codeSamples: {
            'cURL': `curl -X POST ${SMS_BASE}/sms/send \\\n  -H "Authorization: ${SMS_KEY}" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "message": "Your order #123 is ready for pickup. Thank you!",\n    "recipients": ["0551234567", "0209876543"],\n    "sender": "AcmeGH"\n  }'`,
            'Node.js': `const res = await fetch('${SMS_BASE}/sms/send', {\n  method: 'POST',\n  headers: {\n    'Authorization': '${SMS_KEY}',\n    'Content-Type': 'application/json',\n  },\n  body: JSON.stringify({\n    message: 'Your order #123 is ready for pickup. Thank you!',\n    recipients: ['0551234567', '0209876543'],\n    sender: 'AcmeGH', // optional — defaults to your account sender\n  }),\n});\nconsole.log(await res.json());`,
            'PHP': `<?php\n$ch = curl_init('${SMS_BASE}/sms/send');\ncurl_setopt_array($ch, [\n  CURLOPT_RETURNTRANSFER => true,\n  CURLOPT_POST => true,\n  CURLOPT_HTTPHEADER => [\n    'Authorization: ${SMS_KEY}',\n    'Content-Type: application/json',\n  ],\n  CURLOPT_POSTFIELDS => json_encode([\n    'message' => 'Your order #123 is ready for pickup. Thank you!',\n    'recipients' => ['0551234567', '0209876543'],\n    'sender' => 'AcmeGH',\n  ]),\n]);\necho curl_exec($ch); curl_close($ch);`,
            'Python': `import requests\nr = requests.post('${SMS_BASE}/sms/send',\n  headers={'Authorization': '${SMS_KEY}'},\n  json={\n    'message': 'Your order #123 is ready for pickup. Thank you!',\n    'recipients': ['0551234567', '0209876543'],\n    'sender': 'AcmeGH',\n  })\nprint(r.json())`,
        },
    },
    {
        method: 'GET',
        path: '/api/v2/sms/senders',
        description: 'List the sender IDs this API key may send under — your approved own sender IDs plus the shared pool senders. Use these exact values for the sender field.',
        responseBody: `{\n  "success": true,\n  "data": {\n    "mode": "business",\n    "defaultSender": "AcmeGH",\n    "senders": [\n      { "sender": "AcmeGH", "type": "own", "isDefault": true },\n      { "sender": "KFT SMS", "type": "pool", "isDefault": false }\n    ]\n  }\n}`,
        notes: [
            'type "own" = a sender ID approved for your business; "pool" = a shared platform sender any approved business may use.',
        ],
        codeSamples: {
            'cURL': `curl -X GET ${SMS_BASE}/sms/senders \\\n  -H "Authorization: ${SMS_KEY}"`,
            'Node.js': `const res = await fetch('${SMS_BASE}/sms/senders', {\n  headers: { 'Authorization': '${SMS_KEY}' },\n});\nconsole.log(await res.json());`,
            'PHP': `<?php\n$ch = curl_init('${SMS_BASE}/sms/senders');\ncurl_setopt_array($ch, [\n  CURLOPT_RETURNTRANSFER => true,\n  CURLOPT_HTTPHEADER => ['Authorization: ${SMS_KEY}'],\n]);\necho curl_exec($ch); curl_close($ch);`,
            'Python': `import requests\nr = requests.get('${SMS_BASE}/sms/senders',\n  headers={'Authorization': '${SMS_KEY}'})\nprint(r.json())`,
        },
    },
    {
        method: 'GET',
        path: '/api/v2/sms/messages/{campaignId}',
        description: 'Delivery status for a send. Returns the campaign summary, a delivery rollup, and per-recipient statuses (100 per page).',
        queryParams: [
            { name: 'page', type: 'number', required: false, desc: 'Zero-based page of per-recipient rows (100/page)' },
            { name: 'status', type: 'string', required: false, desc: 'Filter rows: queued, sent, delivered, undelivered, failed, expired, rejected' },
        ],
        responseBody: `{\n  "success": true,\n  "data": {\n    "campaign": {\n      "id": "uuid-...",\n      "sender_used": "AcmeGH",\n      "recipients_count": 2,\n      "segments": 1,\n      "credits_charged": 2,\n      "status": "completed",\n      "created_at": "2026-..."\n    },\n    "delivery": { "delivered": 2 },\n    "messages": [\n      {\n        "recipient": "233551234567",\n        "status": "delivered",\n        "status_updated_at": "2026-..."\n      }\n    ],\n    "page": 0\n  }\n}`,
        notes: [
            'Use the campaignId returned by POST /sms/send.',
            'Message statuses: queued → sent → delivered | undelivered | expired | rejected. failed = rejected by the provider at send time (refunded).',
            'Delivery reports arrive asynchronously from the network — poll this endpoint a few minutes after sending for final statuses.',
        ],
        codeSamples: {
            'cURL': `curl -X GET "${SMS_BASE}/sms/messages/your_campaign_id?status=delivered" \\\n  -H "Authorization: ${SMS_KEY}"`,
            'Node.js': `const id = 'your_campaign_id';\nconst res = await fetch(\`${SMS_BASE}/sms/messages/\${id}\`, {\n  headers: { 'Authorization': '${SMS_KEY}' },\n});\nconsole.log(await res.json());`,
            'PHP': `<?php\n$id = 'your_campaign_id';\n$ch = curl_init("${SMS_BASE}/sms/messages/$id");\ncurl_setopt_array($ch, [\n  CURLOPT_RETURNTRANSFER => true,\n  CURLOPT_HTTPHEADER => ['Authorization: ${SMS_KEY}'],\n]);\necho curl_exec($ch); curl_close($ch);`,
            'Python': `import requests\ncid = 'your_campaign_id'\nr = requests.get(f'${SMS_BASE}/sms/messages/{cid}',\n  headers={'Authorization': '${SMS_KEY}'})\nprint(r.json())`,
        },
    },
    {
        // Was missing from this file entirely — the route has existed since
        // the v1->v2 port but was never documented here. Added while auditing
        // this file for stale v1 base URLs (Phase 4 / OpenAPI spec work).
        method: 'GET',
        path: '/api/v2/sms/campaigns',
        description: 'List your recent SMS campaigns, newest first — a discovery endpoint that complements GET /sms/messages/{campaignId} for when you don\'t already have a campaign id on hand.',
        queryParams: [
            { name: 'page', type: 'number', required: false, desc: 'Zero-based page, 30 per page (default 0)' },
            { name: 'status', type: 'string', required: false, desc: 'Filter: queued, processing, completed, failed, blocked' },
            { name: 'from', type: 'string', required: false, desc: 'ISO date — only campaigns created on/after this date' },
            { name: 'to', type: 'string', required: false, desc: 'ISO date — only campaigns created on/before this date' },
        ],
        responseBody: `{\n  "success": true,\n  "data": {\n    "campaigns": [\n      {\n        "id": "uuid-...",\n        "status": "completed",\n        "recipients_count": 2,\n        "segments": 1,\n        "credits_charged": 2,\n        "sender_used": "AcmeGH",\n        "source": "api",\n        "scheduled_at": null,\n        "created_at": "2026-..."\n      }\n    ],\n    "page": 0\n  }\n}`,
        notes: [
            'Returns 30 campaigns per page, newest first — pass page to walk further back, not to raise the page size.',
            'Use the returned id with GET /sms/messages/{campaignId} for per-recipient delivery detail.',
        ],
        codeSamples: {
            'cURL': `curl -X GET "${SMS_BASE}/sms/campaigns?status=completed" \\\n  -H "Authorization: ${SMS_KEY}"`,
            'Node.js': `const res = await fetch('${SMS_BASE}/sms/campaigns?status=completed', {\n  headers: { 'Authorization': '${SMS_KEY}' },\n});\nconsole.log(await res.json());`,
            'PHP': `<?php\n$ch = curl_init('${SMS_BASE}/sms/campaigns?status=completed');\ncurl_setopt_array($ch, [\n  CURLOPT_RETURNTRANSFER => true,\n  CURLOPT_HTTPHEADER => ['Authorization: ${SMS_KEY}'],\n]);\necho curl_exec($ch); curl_close($ch);`,
            'Python': `import requests\nr = requests.get('${SMS_BASE}/sms/campaigns',\n  headers={'Authorization': '${SMS_KEY}'},\n  params={'status': 'completed'})\nprint(r.json())`,
        },
    },
    {
        method: 'GET',
        path: '/api/v2/sms/balance',
        description: 'Your SMS credit balance and account mode.',
        responseBody: `{\n  "success": true,\n  "data": {\n    "credits": 498,\n    "totalPurchased": 600,\n    "totalUsed": 102,\n    "mode": "business",\n    "accountStatus": "active"\n  }\n}`,
        notes: [
            'SMS credits are separate from your GHS wallet — buy bundles at kingflexygh.com/dashboard/sms/credits.',
            'Check balance before large campaigns; sends fail with HTTP 402 when credits are insufficient.',
        ],
        codeSamples: {
            'cURL': `curl -X GET ${SMS_BASE}/sms/balance \\\n  -H "Authorization: ${SMS_KEY}"`,
            'Node.js': `const res = await fetch('${SMS_BASE}/sms/balance', {\n  headers: { 'Authorization': '${SMS_KEY}' },\n});\nconsole.log(await res.json());`,
            'PHP': `<?php\n$ch = curl_init('${SMS_BASE}/sms/balance');\ncurl_setopt_array($ch, [\n  CURLOPT_RETURNTRANSFER => true,\n  CURLOPT_HTTPHEADER => ['Authorization: ${SMS_KEY}'],\n]);\necho curl_exec($ch); curl_close($ch);`,
            'Python': `import requests\nr = requests.get('${SMS_BASE}/sms/balance',\n  headers={'Authorization': '${SMS_KEY}'})\nprint(r.json())`,
        },
    },
]
