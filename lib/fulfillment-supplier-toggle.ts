// Shared client helper: flips one supplier on/off for one network via the atomic
// server-side RPC (toggle_fulfillment_supplier_network, see the 20260822 migration).
// app/admin/fulfillment/page.tsx and app/admin/ishare/page.tsx both call this SAME
// function so their "Connect/Disconnect" controls can never drift from each other —
// a second hand-copied version of this call would reintroduce the exact
// lost-update race the RPC exists to close (two pages each doing their own
// read-modify-write of the whole settings blob).
import type { SupplierKey } from '@/lib/order-supplier'

export interface SupplierNetworkSettings {
    networks: Record<string, boolean>
    codecraft_networks: Record<string, boolean>
    xpress_networks: Record<string, boolean>
    ghdata_networks: Record<string, boolean>
    agentportal_networks: Record<string, boolean>
    bundleportal_networks: Record<string, boolean>
    hendylinks_networks: Record<string, boolean>
    atishare_console_networks: Record<string, boolean>
    spfastit_networks: Record<string, boolean>
}

export type ToggleSupplierNetworkResult =
    | { success: true; settings: SupplierNetworkSettings }
    | { success: false; error: string }

export async function toggleSupplierNetwork(
    supplier: SupplierKey,
    network: string,
    enable: boolean
): Promise<ToggleSupplierNetworkResult> {
    try {
        const res = await fetch('/api/admin/fulfillment/toggle-supplier-network', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ supplier, network, enable }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok || !data?.success) {
            return { success: false, error: data?.error || 'Failed to update supplier settings' }
        }
        return { success: true, settings: data.settings as SupplierNetworkSettings }
    } catch (e: any) {
        return { success: false, error: e?.message || 'Network error' }
    }
}
