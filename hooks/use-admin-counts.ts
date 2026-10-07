'use client'

import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/auth-context'

export interface AdminCounts {
    pendingOrders: number
    pendingFulfillment: number
    pendingShops: number
    pendingWithdrawals: number
    pendingAfa: number
    pendingComplaints: number
    expiringAgents: number
    pendingDebts: number
}

const initialCounts: AdminCounts = {
    pendingOrders: 0,
    pendingFulfillment: 0,
    pendingShops: 0,
    pendingWithdrawals: 0,
    pendingAfa: 0,
    pendingComplaints: 0,
    expiringAgents: 0,
    pendingDebts: 0,
}

// ── Module-level singleton store ────────────────────────────────────────────
// Every component that calls useAdminCounts() shares ONE counts object and ONE
// set of realtime channels (refcounted). This replaces the previous per-instance
// design where the sidebar + dashboard each opened a full set of subscriptions
// (~14 channels on the admin dashboard). Now: one set, regardless of caller count.

let sharedCounts: AdminCounts = initialCounts
const listeners = new Set<(c: AdminCounts) => void>()
let channels: ReturnType<typeof supabase.channel>[] = []
let refCount = 0
let started = false

function emit() {
    for (const l of listeners) l(sharedCounts)
}

function patch(p: Partial<AdminCounts>) {
    sharedCounts = { ...sharedCounts, ...p }
    emit()
}

async function fetchOrdersCount() {
    const { count } = await (supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'pending') as any)

    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const { count: fulfillmentCount } = await (supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .in('status', ['pending', 'processing'])
        .gte('created_at', today.toISOString()) as any)

    patch({ pendingOrders: count || 0, pendingFulfillment: fulfillmentCount || 0 })
}

async function fetchShopsCount() {
    const { count: pendingApproval } = await (supabase
        .from('shop_profiles')
        .select('*', { count: 'exact', head: true })
        .eq('approval_status', 'pending') as any)

    const { count: pendingPricing } = await (supabase
        .from('shop_profiles')
        .select('*', { count: 'exact', head: true })
        .eq('approval_status', 'approved')
        .eq('pricing_status', 'pending_review') as any)

    patch({ pendingShops: (pendingApproval || 0) + (pendingPricing || 0) })
}

async function fetchWithdrawalsCount() {
    const { count } = await (supabase
        .from('shop_wallet_transactions')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'pending') as any)
    patch({ pendingWithdrawals: count || 0 })
}

async function fetchAfaCount() {
    const { count } = await (supabase
        .from('afa_orders')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'pending') as any)
    patch({ pendingAfa: count || 0 })
}

// Complaints/support rows are NOT SELECTable by admins via RLS (owner-only
// policies), so a browser count always returned 0. Source the badge from the
// admin-gated service-role counts route instead: open support threads +
// pending legacy complaints.
async function fetchComplaintsCount() {
    try {
        const res = await fetch('/api/admin/support/counts')
        const json = await res.json().catch(() => null)
        if (json?.success) {
            patch({ pendingComplaints: (json.data?.openThreads || 0) + (json.data?.legacyPending || 0) })
        }
    } catch {
        // Non-fatal — leave the badge at its last value.
    }
}

async function fetchExpiringAgentsCount() {
    const soon = new Date()
    soon.setDate(soon.getDate() + 3)
    const now = new Date()

    const { count } = await (supabase
        .from('users')
        .select('*', { count: 'exact', head: true })
        .eq('role', 'agent')
        .gt('agent_expires_at', now.toISOString())
        .lte('agent_expires_at', soon.toISOString()) as any)
    patch({ expiringAgents: count || 0 })
}

async function fetchPendingDebtsCount() {
    const { count } = await (supabase
        .from('pending_settlements')
        .select('*', { count: 'exact', head: true })
        .in('status', ['pending', 'partially_settled']) as any)
    patch({ pendingDebts: count || 0 })
}

function fetchAllCounts() {
    fetchOrdersCount()
    fetchShopsCount()
    fetchWithdrawalsCount()
    fetchAfaCount()
    fetchComplaintsCount()
    fetchExpiringAgentsCount()
    fetchPendingDebtsCount()
}

function startSubscriptions() {
    if (started) return
    started = true
    fetchAllCounts()

    channels = [
        supabase.channel('admin-counts-orders')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, fetchOrdersCount).subscribe(),
        supabase.channel('admin-counts-shops')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'shop_profiles' }, fetchShopsCount).subscribe(),
        supabase.channel('admin-counts-withdrawals')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'shop_wallet_transactions' }, fetchWithdrawalsCount).subscribe(),
        supabase.channel('admin-counts-afa')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'afa_orders' }, fetchAfaCount).subscribe(),
        // No complaints channel: RLS never delivers complaint/thread events to
        // an admin client, so the old subscription never fired. The badge
        // refreshes on mount + manual refresh via the counts route.
        supabase.channel('admin-counts-users')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'users' }, fetchExpiringAgentsCount).subscribe(),
        supabase.channel('admin-counts-debts')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'pending_settlements' }, fetchPendingDebtsCount).subscribe(),
    ]
}

function stopSubscriptions() {
    for (const ch of channels) supabase.removeChannel(ch)
    channels = []
    started = false
}

export function useAdminCounts() {
    const { dbUser } = useAuth()
    const [counts, setCounts] = useState<AdminCounts>(sharedCounts)
    const isAdmin = dbUser?.role === 'admin' || dbUser?.role === 'sub-admin'

    useEffect(() => {
        if (!isAdmin) return

        const listener = (c: AdminCounts) => setCounts(c)
        listeners.add(listener)
        setCounts(sharedCounts)

        refCount += 1
        startSubscriptions()

        return () => {
            listeners.delete(listener)
            refCount -= 1
            if (refCount <= 0) {
                refCount = 0
                stopSubscriptions()
            }
        }
    }, [isAdmin])

    return { counts, refresh: fetchAllCounts }
}
