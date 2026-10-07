// scripts/bundleportal-register-webhook.ts
// One-off: registers (or rotates) Bundle Portal's webhook URL and prints the signing secret.
// Run manually: npx tsx scripts/bundleportal-register-webhook.ts <webhook-url>
//
// The secret is shown ONCE by Bundle Portal and cannot be read back — copy it into Vercel env
// vars (BUNDLEPORTAL_WEBHOOK_SECRET, every environment this route runs in) immediately.
//
// NOT run automatically by any CI/deploy step — this is a live, side-effecting call against
// Bundle Portal's production account that can rotate/replace any existing registration.
import fs from 'node:fs'
import path from 'node:path'

function loadEnvLocal() {
    const envPath = path.resolve(process.cwd(), '.env.local')
    if (!fs.existsSync(envPath)) {
        console.error('.env.local not found — run from the project root.')
        process.exit(1)
    }
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq === -1) continue
        let value = trimmed.slice(eq + 1).trim()
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1)
        }
        process.env[trimmed.slice(0, eq).trim()] = value
    }
}

async function run() {
    loadEnvLocal()
    const url = process.argv[2]
    if (!url) {
        console.error('Usage: npx tsx scripts/bundleportal-register-webhook.ts <webhook-url>')
        console.error('Example: npx tsx scripts/bundleportal-register-webhook.ts https://www.kingflexygh.com/api/webhooks/bundleportal')
        process.exit(1)
    }
    if (!url.startsWith('https://')) {
        console.error('Bundle Portal requires an https:// URL resolving to a public host.')
        process.exit(1)
    }

    const { setBundlePortalWebhook } = await import('../lib/bundleportal-service')
    const result = await setBundlePortalWebhook(url)

    if (!result.success) {
        console.error(`Registration failed: ${result.error}`)
        process.exit(1)
    }

    console.log('')
    console.log('✅ Webhook registered.')
    console.log(`   URL:    ${result.webhookUrl}`)
    console.log(`   Events: ${(result.events || []).join(', ')}`)
    console.log('')
    console.log('⚠️  SECRET SHOWN ONCE — copy it now, it cannot be read back:')
    console.log('')
    console.log(`   ${result.webhookSecret}`)
    console.log('')
    console.log('Set this in Vercel now: vercel env add BUNDLEPORTAL_WEBHOOK_SECRET')
    console.log('(add it to every environment app/api/webhooks/bundleportal/route.ts runs in)')
}

run().catch((e) => { console.error(e); process.exit(1) })
