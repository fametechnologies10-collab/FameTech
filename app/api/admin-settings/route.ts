import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// Optimized for Vercel Pro Edge Caching

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
if (!supabaseServiceKey) {
  throw new Error('[AdminSettings] SUPABASE_SERVICE_ROLE_KEY is not configured')
}

const supabase = createClient(supabaseUrl, supabaseServiceKey)

/**
 * Strict whitelist of admin_settings keys that are safe to expose to the
 * public (unauthenticated) landing page. Sensitive operational settings like
 * fee percentages, price adjustments, and page access flags MUST NOT appear
 * here — they are only accessible via authenticated admin routes.
 */
const PUBLIC_ALLOWED_KEYS = new Set([
    'landing_customer_count',
    'landing_data_packages',
    'landing_agent_pricing',
    'landing_testimonials',
    'guest_storefront_url',
    'whatsapp_admin_number',
    'whatsapp_group_link',
    'whatsapp_channel_link',
    'whatsapp_community_link',
    'footer_copyright_text',
    'footer_branding_text',
    'signup_promo_role',
    'phone_verification_enabled',
    // Per-network data-bundle stock map { MTN:false, ... } — read by the client buy
    // page to show a network as "Out of Stock at the Moment". Non-sensitive (customers
    // see the state anyway).
    'data_network_stock',
    // MTN whitelist gate toggles (Server 1 / Server 2) — read by the dashboard bulk-order
    // page (app/dashboard/data-packages/page.tsx) to decide whether to run the
    // amber pre-check before hitting /api/mtn-whitelist/verify. Non-sensitive:
    // they only say whether the gate is currently on.
    'mtn_agentportal_whitelist_gate_enabled',
    'mtn_bundleportal_whitelist_gate_enabled',
])

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url)
        const keysParam = searchParams.get('keys')

        // Filter requested keys against the whitelist.
        // If no keys are specified, fall back to all allowed keys.
        let allowedKeys: string[]
        if (keysParam) {
            const requested = keysParam.split(',').map(k => k.trim()).filter(Boolean)
            allowedKeys = requested.filter(k => PUBLIC_ALLOWED_KEYS.has(k))
            // If every requested key was blocked, return an empty object immediately
            // without touching the database.
            if (allowedKeys.length === 0) {
                return NextResponse.json({}, {
                    headers: {
                        'Cache-Control': 'no-store, no-cache',
                    }
                })
            }
        } else {
            allowedKeys = Array.from(PUBLIC_ALLOWED_KEYS)
        }

        const { data, error } = await supabase
            .from('admin_settings')
            .select('key, value')
            .in('key', allowedKeys)

        if (error) {
            throw error
        }

        // Convert array of {key, value} to a flat object
        const settings = (data || []).reduce((acc: Record<string, unknown>, curr: { key: string; value: unknown }) => {
            acc[curr.key] = curr.value
            return acc
        }, {})

        // Return with headers that explicitly forbid caching
        return NextResponse.json(settings, {
            headers: {
                'Cache-Control': 'no-store, no-cache',
            }
        })
    } catch (error) {
        console.error('Error fetching admin settings:', error)
        return NextResponse.json(
            { error: 'Failed to fetch settings' },
            { status: 500 }
        )
    }
}
