/**
 * One-off probe: verify Hubtel accepts an arbitrary sender ID in the request
 * body (as their technical team confirmed). Sends ONE real SMS.
 *
 *   npx tsx scripts/probe-sms-sender.ts
 *
 * Uses @next/env to load .env.local exactly like the app. Prints the HTTP
 * status + Hubtel response body (never the credentials).
 */

import { loadEnvConfig } from '@next/env'
loadEnvConfig(process.cwd())

const SENDER = 'KFT Test'
const TO_RAW = '0551617309'
const CONTENT = 'KFG SMS test: verifying custom sender ID via Hubtel. Please ignore.'

function normalizeGhanaPhone(raw: string): string | null {
    let n = raw.replace(/[\s\-+]/g, '')
    if (n.startsWith('0') && n.length === 10) n = '233' + n.slice(1)
    if (n.startsWith('233') && n.length === 12) return n
    return null
}

async function main() {
    const clientId = process.env.HUBTEL_CLIENT_ID
    const clientSecret = process.env.HUBTEL_CLIENT_SECRET
    if (!clientId || !clientSecret) {
        console.error('❌ HUBTEL_CLIENT_ID / HUBTEL_CLIENT_SECRET not set in .env.local')
        process.exit(1)
    }

    const to = normalizeGhanaPhone(TO_RAW)
    if (!to) { console.error('❌ Bad phone'); process.exit(1) }

    const From = SENDER.substring(0, 11)
    console.log('── Hubtel custom-sender probe ─────────────────────────')
    console.log('  From (sender ID):', JSON.stringify(From), `(${From.length} chars)`)
    console.log('  To:              ', to)
    console.log('  Endpoint:        ', 'https://sms.hubtel.com/v1/messages/send')
    console.log('  Auth:            ', 'Basic (CLIENT_ID:CLIENT_SECRET) — hidden')
    console.log('───────────────────────────────────────────────────────')

    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')

    const res = await fetch('https://sms.hubtel.com/v1/messages/send', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Authorization': `Basic ${basicAuth}`,
        },
        body: JSON.stringify({
            From,
            To: to,
            Content: CONTENT,
            RegisteredDelivery: true,
        }),
    })

    const text = await res.text()
    let data: any
    try { data = JSON.parse(text) } catch { data = text }

    console.log('\n── Result ─────────────────────────────────────────────')
    console.log('  HTTP status:', res.status)
    console.log('  Response:   ', JSON.stringify(data, null, 2))
    console.log('───────────────────────────────────────────────────────')

    const ok = (res.status === 200 || res.status === 201) &&
        (data?.status === 0 || String(data?.statusDescription || '').toLowerCase().includes('success'))
    if (ok) {
        console.log('\n✅ SUCCESS — Hubtel accepted the custom sender ID.')
        console.log('   MessageId:', data?.data?.messageId ?? data?.messageId ?? '(none in response)')
        console.log('   Check the handset for a message from "' + From + '".')
    } else {
        console.log('\n⚠️  Hubtel did NOT accept it — inspect statusDescription above.')
        console.log('   (Some Hubtel accounts require the sender ID to be pre-registered even when passed in the body.)')
    }
}

main().catch(e => { console.error('❌ Exception:', e?.message || e); process.exit(1) })
