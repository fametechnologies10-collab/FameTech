import { NextRequest, NextResponse } from 'next/server'
import { validateAdminAccess } from '@/lib/auth-utils'
import { createServerClient } from '@/lib/supabase'
import { SUPPLIER_NETWORK_SETTING_KEYS, type SupplierKey } from '@/lib/order-supplier'

// Kept in sync with the NETWORKS constant in app/admin/fulfillment/page.tsx. The
// RPC itself only requires a non-empty string; this is the boundary validation —
// never trust the network name from the request body without checking it against
// a known set, the same "validate at the boundary" rule this codebase applies to
// supplier network names everywhere else (see AT-iShare Console's own
// assertAtIShareNetwork for the same idea one layer down).
const KNOWN_NETWORKS = new Set(['MTN', 'Telecel', 'AT-iShare', 'AT-BigTime'])

/**
 * Atomically toggles one supplier on/off for one network.
 *
 * This is the ONLY place that should ever write admin_settings.fulfillment_settings
 * for a per-network connect/disconnect action — routing the mutation through the
 * toggle_fulfillment_supplier_network RPC (row-locked read-modify-write) is what
 * makes it safe for more than one admin page to expose this control at once. Do
 * NOT reintroduce a client-side "read the whole blob, mutate locally, upsert the
 * whole blob back" path elsewhere; that is the exact race this route exists to
 * close.
 *
 * Security: admin-only (validateAdminAccess(false, ...)), same posture as the
 * free-form AT-iShare Console send route — this changes where real customer
 * money gets routed, so sub-admins are not permitted.
 */
export async function POST(request: NextRequest) {
    const authResult = await validateAdminAccess(false, request)
    if (authResult.error) {
        return NextResponse.json({ error: authResult.error }, { status: authResult.status })
    }

    let body: any
    try {
        body = await request.json()
    } catch {
        return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const { supplier, network, enable } = body || {}

    if (typeof supplier !== 'string' || !(supplier in SUPPLIER_NETWORK_SETTING_KEYS)) {
        return NextResponse.json({ error: 'Unknown supplier' }, { status: 400 })
    }
    if (typeof network !== 'string' || !KNOWN_NETWORKS.has(network)) {
        return NextResponse.json({ error: 'Unknown network' }, { status: 400 })
    }
    if (typeof enable !== 'boolean') {
        return NextResponse.json({ error: 'enable must be a boolean' }, { status: 400 })
    }

    const supplierKey = SUPPLIER_NETWORK_SETTING_KEYS[supplier as SupplierKey]

    try {
        const admin = createServerClient()
        const { data, error } = await (admin as any).rpc('toggle_fulfillment_supplier_network', {
            p_supplier_key: supplierKey,
            p_network: network,
            p_enable: enable,
        })

        if (error) {
            console.error('[ToggleSupplierNetwork] RPC error:', error.message)
            return NextResponse.json({ error: 'Failed to update supplier settings' }, { status: 500 })
        }

        return NextResponse.json({ success: true, settings: data })
    } catch (error: any) {
        console.error('[ToggleSupplierNetwork] Unexpected error:', error)
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
    }
}
