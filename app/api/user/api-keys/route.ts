import { NextRequest, NextResponse } from 'next/server'
import { createRouteClient } from '@/lib/supabase-server'
import { createServerClient } from '@/lib/supabase'
import { parseAllowedRoles } from '@/lib/role-parser'
import bcrypt from 'bcryptjs'
import { randomBytes } from 'crypto'

// ============================================================================
// API Key Management — User Endpoints (cookie-based auth, NOT API key auth)
// GET  — View current keys (prefix + status only, never the full key) — a
//        user may hold up to THREE keys, one per key_type ('standard' |
//        'commission' | 'sms'), returned as api_keys.standard /
//        api_keys.commission / api_keys.sms.
// POST — Generate a new key of the requested type (deletes the OLD key of
//        that SAME type only — the other type's key, if any, is untouched —
//        and returns the full key ONCE)
// ============================================================================

// ── GET: View current API keys (standard + commission + sms) ─────────────

export async function GET() {
    try {
        const supabaseAuth = await createRouteClient()
        const { data: { user: authUser } } = await supabaseAuth.auth.getUser()

        if (!authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const supabase = createServerClient()

        // Check if user's role is allowed for API access
        const { data: userData } = await supabase
            .from('users')
            .select('role')
            .eq('id', authUser.id)
            .single()

        const userRole = (userData as any)?.role

        // Get allowed roles from admin_settings
        const { data: rolesSetting } = await (supabase
            .from('admin_settings') as any)
            .select('value')
            .eq('key', 'api_allowed_roles')
            .single()

        const allowedRoles = parseAllowedRoles(rolesSetting?.value)

        const isEligible = allowedRoles.includes(userRole)

        // Get user's current API keys — up to three rows now (one per key_type),
        // so this is a plain array select rather than .single()/.maybeSingle().
        const { data: apiKeys, error: keyError } = await (supabase
            .from('api_keys') as any)
            .select('id, key_prefix, name, status, key_type, last_used_at, created_at, updated_at')
            .eq('user_id', authUser.id)

        if (keyError) {
            console.error('[API Keys GET] DB error:', keyError.message)
            return NextResponse.json({ error: 'Failed to fetch API keys' }, { status: 500 })
        }

        const mapKey = (k: any) => k ? {
            id: k.id,
            prefix: k.key_prefix,
            name: k.name,
            status: k.status,
            key_type: k.key_type,
            last_used_at: k.last_used_at,
            created_at: k.created_at,
        } : null

        const standardKey = (apiKeys || []).find((k: any) => k.key_type === 'standard') || null
        const commissionKey = (apiKeys || []).find((k: any) => k.key_type === 'commission') || null
        const smsKey = (apiKeys || []).find((k: any) => k.key_type === 'sms') || null

        // Check if API feature is enabled
        const { data: featureSetting } = await (supabase
            .from('admin_settings') as any)
            .select('value')
            .eq('key', 'api_feature_enabled')
            .single()

        const featureEnabled = featureSetting?.value !== 'false' && featureSetting?.value !== false

        return NextResponse.json({
            feature_enabled: featureEnabled,
            is_eligible: isEligible,
            allowed_roles: allowedRoles,
            user_role: userRole,
            api_keys: {
                standard: mapKey(standardKey),
                commission: mapKey(commissionKey),
                sms: mapKey(smsKey),
            },
        })
    } catch (error: any) {
        console.error('[API Keys GET] Exception:', error.message)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

// ── POST: Generate a new API key ──────────────────────────────────────────
// If the user already has a key of the SAME key_type, only that key is
// deleted (revoked permanently) — the other type's key, if any, is left
// completely untouched. The new full key is returned ONCE in this response —
// never stored in plaintext.

export async function POST(request: NextRequest) {
    try {
        const supabaseAuth = await createRouteClient()
        const { data: { user: authUser } } = await supabaseAuth.auth.getUser()

        if (!authUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const supabase = createServerClient()

        // ── Check feature toggle ──────────────────────────────────────────
        const { data: featureSetting } = await (supabase
            .from('admin_settings') as any)
            .select('value')
            .eq('key', 'api_feature_enabled')
            .single()

        if (featureSetting?.value === 'false' || featureSetting?.value === false) {
            return NextResponse.json({ error: 'API feature is currently disabled' }, { status: 503 })
        }

        // ── Check role eligibility ────────────────────────────────────────
        const { data: userData } = await supabase
            .from('users')
            .select('role')
            .eq('id', authUser.id)
            .single()

        const userRole = (userData as any)?.role

        const { data: rolesSetting } = await (supabase
            .from('admin_settings') as any)
            .select('value')
            .eq('key', 'api_allowed_roles')
            .single()

        const allowedRoles = parseAllowedRoles(rolesSetting?.value)

        if (!allowedRoles.includes(userRole)) {
            return NextResponse.json({
                error: 'API access is not available for your account type',
            }, { status: 403 })
        }

        // ── Parse optional key name + key_type from body ──────────────────
        let keyName = 'My API Key'
        let keyType: 'standard' | 'commission' | 'sms' = 'standard'
        try {
            const body = await request.json()
            if (body?.name && typeof body.name === 'string' && body.name.trim().length > 0) {
                keyName = body.name.trim().substring(0, 50) // Max 50 chars
            }
            if (body?.key_type !== undefined && body.key_type !== null) {
                if (body.key_type === 'commission') {
                    keyType = 'commission'
                    if (keyName === 'My API Key') keyName = 'Commission Services Key'
                } else if (body.key_type === 'sms') {
                    keyType = 'sms'
                    if (keyName === 'My API Key') keyName = 'SMS API Key'
                } else if (body.key_type !== 'standard') {
                    return NextResponse.json({ error: "key_type must be 'standard', 'commission', or 'sms'" }, { status: 400 })
                }
            }
        } catch {
            // No body or invalid JSON — use defaults
        }

        // Commission keys no longer require an active shop — commission is now
        // credited to a dedicated commission_wallets row (see lib/commission-wallet.ts
        // and supabase/migrations/20260901b_commission_wallet_rpcs.sql), independent
        // of shop_wallets. Eligibility is the same allowedRoles check already applied
        // to every key type above.

        // ── SMS keys require an APPROVED business-mode SMS account ─────────
        // Business mode already required a manual admin KYC review (Ghana
        // Card + business docs, see app/api/sms/business/route.ts), so this
        // is the sole gate — no separate approval step for the key itself.
        if (keyType === 'sms') {
            const { data: smsAccount } = await (supabase
                .from('sms_accounts') as any)
                .select('mode')
                .eq('user_id', authUser.id)
                .maybeSingle()

            if (!smsAccount || smsAccount.mode !== 'business') {
                return NextResponse.json({
                    error: 'SMS API keys require business mode. Register your business on the SMS dashboard and wait for approval.',
                }, { status: 403 })
            }
        }

        // ── Delete existing key of the SAME type only ──────────────────────
        // This permanently revokes the old same-type key. The user was warned
        // in the UI. The other key_type's key (if any) is untouched.
        await (supabase.from('api_keys') as any)
            .delete()
            .eq('user_id', authUser.id)
            .eq('key_type', keyType)

        // ── Generate new key ──────────────────────────────────────────────
        // Standard: kf_live_ + 32 hex = 40 chars. Commission: kf_cs_live_ +
        // 32 hex = 43 chars. SMS: kf_sms_live_ + 32 hex = 44 chars. Prefix is
        // ALWAYS the first 16 chars (must match lib/api-auth.ts's lookup).
        const randomPart = randomBytes(16).toString('hex') // 32 hex chars
        const fullKey = keyType === 'commission'
            ? `kf_cs_live_${randomPart}`
            : keyType === 'sms'
                ? `kf_sms_live_${randomPart}`
                : `kf_live_${randomPart}`
        const keyPrefix = fullKey.substring(0, 16)

        // Hash for storage (bcrypt, 10 salt rounds) — same cost for all types
        const keyHash = await bcrypt.hash(fullKey, 10)

        // SMS keys are auto-active: business mode already passed manual KYC
        // review, so a second manual key-approval step is pure friction.
        // standard/commission keys keep the existing pending-approval flow.
        const initialStatus = keyType === 'sms' ? 'active' : 'pending'

        // ── Insert new key ──────────────────────────────────────────────
        const { data: newKey, error: insertError } = await (supabase
            .from('api_keys') as any)
            .insert({
                user_id: authUser.id,
                key_hash: keyHash,
                key_prefix: keyPrefix,
                name: keyName,
                key_type: keyType,
                status: initialStatus,
            })
            .select('id, key_prefix, name, status, key_type, created_at')
            .single()

        if (insertError) {
            console.error('[API Keys POST] Insert error:', insertError)
            return NextResponse.json({ error: 'Failed to create API key' }, { status: 500 })
        }

        // ── Return the full key ONCE ──────────────────────────────────────
        // This is the ONLY time the plaintext key is visible.
        // After this response, only the hash exists in the database.
        return NextResponse.json({
            success: true,
            message: keyType === 'sms'
                ? 'SMS API key generated and active. Save this key now — it will NOT be shown again.'
                : 'API key generated successfully. Save this key now — it will NOT be shown again.',
            api_key: {
                key: fullKey, // ← Shown ONCE, then never again
                prefix: newKey.key_prefix,
                name: newKey.name,
                status: newKey.status,
                key_type: newKey.key_type,
                created_at: newKey.created_at,
            },
            warning: keyType === 'sms'
                ? undefined
                : 'Your API key requires admin approval before it can be used. Status: pending.',
        })

    } catch (error: any) {
        console.error('[API Keys POST] Exception:', error.message)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
