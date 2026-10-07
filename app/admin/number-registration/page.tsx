'use client'

import { useEffect, useState, useCallback } from 'react'
import {
    Hourglass, Download, CheckCircle2, RefreshCw, Search, Loader2,
    FileSpreadsheet, ShieldCheck, ShieldAlert, Plus,
} from 'lucide-react'

interface NewNumber { phone_number: string; network: string; first_seen_at: string; queued_orders: number }
interface Batch {
    id: string; filename: string; network: string; number_count: number
    status: string; created_at: string; confirmed_at: string | null
}
interface RegistryRow {
    phone_number: string; network: string; status: string; source: string
    first_seen_at: string; submitted_at: string | null; registered_at: string | null
}
interface Payload {
    stats: { new: number; submitted: number; registered: number; queuedOrders: number }
    newNumbers: NewNumber[]
    batches: Batch[]
    gateEnabled: boolean
    whitelistGateEnabled: boolean
    bundlePortalWhitelistEnabled: boolean
}

type Tab = 'new' | 'batches' | 'registry'

export default function NumberRegistrationPage() {
    const [data, setData] = useState<Payload | null>(null)
    const [loading, setLoading] = useState(true)
    const [tab, setTab] = useState<Tab>('new')
    const [busy, setBusy] = useState<string | null>(null)
    const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null)

    // Registry tab
    const [search, setSearch] = useState('')
    const [registryRows, setRegistryRows] = useState<RegistryRow[] | null>(null)
    const [manualPhones, setManualPhones] = useState('')

    const flash = (msg: string, ok = true) => {
        setToast({ msg, ok })
        setTimeout(() => setToast(null), 4000)
    }

    const load = useCallback(async () => {
        setLoading(true)
        try {
            const res = await fetch('/api/admin/number-registration')
            const json = await res.json()
            if (json.success) setData(json.data)
            else flash(json.error || 'Failed to load', false)
        } catch {
            flash('Failed to load', false)
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { load() }, [load])

    const generateXlsx = async (rows: { phone_number: string; network: string }[], filename: string) => {
        // @ts-ignore — xlsx-js-style has no bundled types
        const { utils, writeFile } = await import('xlsx-js-style')
        const aoa = [['Phone Number', 'Network'], ...rows.map(r => [r.phone_number, r.network])]
        const ws = utils.aoa_to_sheet(aoa)
        ws['!cols'] = [{ wch: 20 }, { wch: 12 }]
        const wb = utils.book_new()
        utils.book_append_sheet(wb, ws, 'MTN Numbers')
        writeFile(wb, filename)
    }

    const toggleGate = async () => {
        if (!data) return
        const next = !data.gateEnabled
        setBusy('gate')
        try {
            const res = await fetch('/api/admin/settings/toggle', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: 'number_registration_gate_enabled', value: next }),
            })
            const json = await res.json()
            if (res.ok && json.success) {
                setData({ ...data, gateEnabled: next })
                flash(`Registration gate ${next ? 'ENABLED' : 'disabled'}.`)
            } else {
                flash(json.error || 'Toggle failed', false)
            }
        } catch {
            flash('Toggle failed', false)
        } finally {
            setBusy(null)
        }
    }

    // Separate, independent toggle — the AgentPortal real-time whitelist gate
    // (lib/mtn-whitelist-gate.ts). Shown on this page for admin convenience only;
    // it shares no state or logic with the registration gate above.
    const toggleWhitelistGate = async () => {
        if (!data) return
        const next = !data.whitelistGateEnabled
        setBusy('whitelistGate')
        try {
            const res = await fetch('/api/admin/settings/toggle', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: 'mtn_agentportal_whitelist_gate_enabled', value: next }),
            })
            const json = await res.json()
            if (res.ok && json.success) {
                setData({ ...data, whitelistGateEnabled: next })
                flash(`AgentPortal whitelist gate ${next ? 'ENABLED' : 'disabled'}.`)
            } else {
                flash(json.error || 'Toggle failed', false)
            }
        } catch {
            flash('Toggle failed', false)
        } finally {
            setBusy(null)
        }
    }

    // Separate, independent toggle — the Bundle Portal whitelist fallback
    // (lib/mtn-whitelist-merge.ts). Shown on this page for admin convenience only;
    // it shares no state or logic with the AgentPortal whitelist gate or the
    // registration gate above.
    const toggleBundlePortalWhitelist = async () => {
        if (!data) return
        const next = !data.bundlePortalWhitelistEnabled
        setBusy('bundlePortalWhitelist')
        try {
            const res = await fetch('/api/admin/settings/toggle', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: 'mtn_bundleportal_whitelist_gate_enabled', value: next }),
            })
            const json = await res.json()
            if (res.ok && json.success) {
                setData({ ...data, bundlePortalWhitelistEnabled: next })
                flash(`Bundle Portal whitelist fallback ${next ? 'ENABLED' : 'disabled'}.`)
            } else {
                flash(json.error || 'Toggle failed', false)
            }
        } catch {
            flash('Toggle failed', false)
        } finally {
            setBusy(null)
        }
    }

    const downloadAndSubmit = async () => {
        if (!data || data.stats.new === 0) return
        setBusy('download')
        try {
            const idempotencyKey = `dl-${Date.now()}`
            const res = await fetch('/api/admin/number-registration/download', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ idempotencyKey }),
            })
            const json = await res.json()
            if (res.ok && json.success) {
                await generateXlsx(json.numbers || [], json.filename || 'mtn-registration.xlsx')
                flash(`Submitted ${json.numbers?.length ?? 0} numbers. Send the Excel file to your supplier, then mark the batch Registered once confirmed.`)
                await load()
                setTab('batches')
            } else {
                flash(json.error || 'Download failed', false)
            }
        } catch {
            flash('Download failed', false)
        } finally {
            setBusy(null)
        }
    }

    const reDownloadBatch = async (batch: Batch) => {
        setBusy(`dl-${batch.id}`)
        try {
            const res = await fetch(`/api/admin/number-registration?batchId=${encodeURIComponent(batch.id)}`)
            const json = await res.json()
            if (res.ok && json.success && (json.data?.numbers?.length ?? 0) > 0) {
                await generateXlsx(json.data.numbers, batch.filename || `mtn-registration-${batch.id}.xlsx`)
                flash(`Re-downloaded ${json.data.numbers.length} numbers.`)
            } else {
                flash(json.error || 'This batch has no numbers to download.', false)
            }
        } catch {
            flash('Re-download failed', false)
        } finally {
            setBusy(null)
        }
    }

    const markRegistered = async (batch: Batch) => {
        setBusy(`rel-${batch.id}`)
        try {
            const res = await fetch('/api/admin/number-registration/release', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ batchId: batch.id }),
            })
            const json = await res.json()
            if (res.ok && json.success) {
                const rel = (json.data?.released_orders ?? 0) + (json.data?.released_shop_orders ?? 0)
                flash(`Batch registered. Released ${rel} queued order${rel === 1 ? '' : 's'} for fulfillment.`)
                await load()
            } else {
                flash(json.error || 'Release failed', false)
            }
        } catch {
            flash('Release failed', false)
        } finally {
            setBusy(null)
        }
    }

    const runSearch = async () => {
        if (!search.trim()) { setRegistryRows(null); return }
        setBusy('search')
        try {
            const res = await fetch(`/api/admin/number-registration?search=${encodeURIComponent(search.trim())}`)
            const json = await res.json()
            if (json.success) setRegistryRows(json.data.results || [])
            else flash(json.error || 'Search failed', false)
        } catch {
            flash('Search failed', false)
        } finally {
            setBusy(null)
        }
    }

    const registerManual = async () => {
        const phones = manualPhones.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean)
        if (phones.length === 0) return
        setBusy('manual')
        try {
            const res = await fetch('/api/admin/number-registration/release', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phones }),
            })
            const json = await res.json()
            if (res.ok && json.success) {
                const rel = (json.data?.released_orders ?? 0) + (json.data?.released_shop_orders ?? 0)
                flash(`Registered ${json.data?.registered ?? 0} numbers. Released ${rel} queued order${rel === 1 ? '' : 's'}.`)
                setManualPhones('')
                await load()
            } else {
                flash(json.error || 'Registration failed', false)
            }
        } catch {
            flash('Registration failed', false)
        } finally {
            setBusy(null)
        }
    }

    const statusPill = (s: string) => {
        const map: Record<string, string> = {
            new: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400',
            submitted: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
            registered: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
            confirmed: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
        }
        return map[s] || 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400'
    }

    if (loading && !data) {
        return <div className="flex items-center justify-center py-24"><Loader2 className="w-8 h-8 animate-spin text-muted-foreground" /></div>
    }

    const stats = data?.stats

    return (
        <div className="space-y-5 max-w-5xl mx-auto pb-6">
            {/* Header */}
            <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                    <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
                        <Hourglass className="w-6 h-6 text-indigo-600" /> MTN Number Registration
                    </h1>
                    <p className="text-sm text-muted-foreground mt-1">
                        Export new MTN recipient numbers to your supplier, then release their held orders once registered.
                    </p>
                </div>
                {/* Two independent gates — no shared state or logic between them */}
                <div className="flex flex-col items-end gap-2">
                    <button
                        onClick={toggleGate}
                        disabled={busy === 'gate'}
                        title="Registration Gate — holds orders to unregistered MTN numbers as 'queued' until you release the batch"
                        className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold border transition-colors ${
                            data?.gateEnabled
                                ? 'bg-green-50 border-green-300 text-green-700 dark:bg-green-900/20 dark:border-green-800 dark:text-green-400'
                                : 'bg-gray-50 border-border text-muted-foreground dark:bg-gray-900/30'
                        }`}
                    >
                        {busy === 'gate' ? <Loader2 className="w-4 h-4 animate-spin" />
                            : data?.gateEnabled ? <ShieldCheck className="w-4 h-4" /> : <ShieldAlert className="w-4 h-4" />}
                        Registration Gate: {data?.gateEnabled ? 'ON' : 'OFF'}
                    </button>
                    <button
                        onClick={toggleWhitelistGate}
                        disabled={busy === 'whitelistGate'}
                        title="Server 1 (AgentPortal) whitelist gate — when ON, Server 1 is an active server: MTN purchases are blocked unless the number is registered on an active server (separate system, no shared state with the Registration Gate)"
                        className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold border transition-colors ${
                            data?.whitelistGateEnabled
                                ? 'bg-blue-50 border-blue-300 text-blue-700 dark:bg-blue-900/20 dark:border-blue-800 dark:text-blue-400'
                                : 'bg-gray-50 border-border text-muted-foreground dark:bg-gray-900/30'
                        }`}
                    >
                        {busy === 'whitelistGate' ? <Loader2 className="w-4 h-4 animate-spin" />
                            : data?.whitelistGateEnabled ? <ShieldCheck className="w-4 h-4" /> : <ShieldAlert className="w-4 h-4" />}
                        Server 1 (AgentPortal) Whitelist: {data?.whitelistGateEnabled ? 'ON' : 'OFF'}
                    </button>
                    <button
                        onClick={toggleBundlePortalWhitelist}
                        disabled={busy === 'bundlePortalWhitelist'}
                        title="Server 2 (Bundle Portal) whitelist gate — when ON, Server 2 is an active server: MTN purchases are blocked unless the number is registered on an active server. Works on its own or together with Server 1 (a number registered on either active server passes)"
                        className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold border transition-colors ${
                            data?.bundlePortalWhitelistEnabled
                                ? 'bg-blue-50 border-blue-300 text-blue-700 dark:bg-blue-900/20 dark:border-blue-800 dark:text-blue-400'
                                : 'bg-gray-50 border-border text-muted-foreground dark:bg-gray-900/30'
                        }`}
                    >
                        {busy === 'bundlePortalWhitelist' ? <Loader2 className="w-4 h-4 animate-spin" />
                            : data?.bundlePortalWhitelistEnabled ? <ShieldCheck className="w-4 h-4" /> : <ShieldAlert className="w-4 h-4" />}
                        Server 2 (Bundle Portal) Whitelist: {data?.bundlePortalWhitelistEnabled ? 'ON' : 'OFF'}
                    </button>
                </div>
            </div>

            {!data?.gateEnabled && (
                <div className="rounded-xl bg-amber-50 dark:bg-amber-900/15 border border-amber-200 dark:border-amber-800/50 p-3 text-sm text-amber-800 dark:text-amber-300">
                    The <b>Registration Gate</b> is <b>OFF</b>: MTN orders are fulfilled normally, but new numbers are still being tracked below.
                    Pre-register the backlog with your supplier, then turn the gate <b>ON</b> to start holding unregistered MTN numbers.
                </div>
            )}

            {(data?.whitelistGateEnabled || data?.bundlePortalWhitelistEnabled) && (
                <div className="rounded-xl bg-blue-50 dark:bg-blue-900/15 border border-blue-200 dark:border-blue-800/50 p-3 text-sm text-blue-800 dark:text-blue-300">
                    The <b>Whitelist Gate</b> is <b>ON</b> with{' '}
                    <b>{data?.whitelistGateEnabled && data?.bundlePortalWhitelistEnabled ? 'Server 1 and Server 2' : data?.whitelistGateEnabled ? 'Server 1 only' : 'Server 2 only'}</b> active:
                    MTN purchases across every channel (dashboard, shop, USSD, API) are checked live before being charged, and a number registered on{' '}
                    {data?.whitelistGateEnabled && data?.bundlePortalWhitelistEnabled ? 'either active server passes' : 'the active server passes — one registered only on the other server is blocked'}.
                    A number that isn't registered is blocked outright — the buyer is told it has been submitted for registration and to try again soon. This is a separate system from the Registration Gate above and doesn't share any state with it.
                </div>
            )}

            {/* Stats */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <StatCard label="New numbers" sub="Awaiting export" value={stats?.new ?? 0} color="text-indigo-600" Icon={Plus} />
                <StatCard label="Submitted" sub="Awaiting supplier" value={stats?.submitted ?? 0} color="text-amber-600" Icon={FileSpreadsheet} />
                <StatCard label="Registered" sub="Confirmed total" value={stats?.registered ?? 0} color="text-green-600" Icon={CheckCircle2} />
                <StatCard label="Queued orders" sub="Held for release" value={stats?.queuedOrders ?? 0} color="text-indigo-600" Icon={Hourglass} />
            </div>

            {/* Tabs */}
            <div className="flex gap-1 border-b border-border">
                {(['new', 'batches', 'registry'] as Tab[]).map(t => (
                    <button
                        key={t}
                        onClick={() => setTab(t)}
                        className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                            tab === t ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-muted-foreground hover:text-foreground'
                        }`}
                    >
                        {t === 'new' ? 'New Numbers' : t === 'batches' ? 'Batches' : 'Registry'}
                    </button>
                ))}
            </div>

            {/* New Numbers */}
            {tab === 'new' && (
                <div className="space-y-3">
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                        <p className="text-sm text-muted-foreground">
                            {stats?.new ?? 0} new MTN number{(stats?.new ?? 0) === 1 ? '' : 's'} not yet sent to the supplier.
                        </p>
                        <button
                            onClick={downloadAndSubmit}
                            disabled={busy === 'download' || (stats?.new ?? 0) === 0}
                            className="flex items-center gap-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white px-4 py-2.5 text-sm font-semibold"
                        >
                            {busy === 'download' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                            Download &amp; Submit (Excel)
                        </button>
                    </div>
                    <div className="rounded-xl border border-border overflow-x-auto">
                        <table className="w-full text-sm min-w-[520px]">
                            <thead className="bg-muted/50 text-muted-foreground">
                                <tr>
                                    <th className="text-left font-medium px-4 py-2.5">Phone Number</th>
                                    <th className="text-left font-medium px-4 py-2.5">Network</th>
                                    <th className="text-right font-medium px-4 py-2.5">Queued Orders</th>
                                    <th className="text-right font-medium px-4 py-2.5">First Seen</th>
                                </tr>
                            </thead>
                            <tbody>
                                {(data?.newNumbers || []).length === 0 && (
                                    <tr><td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">No new numbers.</td></tr>
                                )}
                                {(data?.newNumbers || []).map(n => (
                                    <tr key={n.phone_number} className="border-t border-border">
                                        <td className="px-4 py-2.5 font-mono">{n.phone_number}</td>
                                        <td className="px-4 py-2.5">{n.network}</td>
                                        <td className="px-4 py-2.5 text-right">{n.queued_orders}</td>
                                        <td className="px-4 py-2.5 text-right text-muted-foreground">{new Date(n.first_seen_at).toLocaleDateString()}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* Batches */}
            {tab === 'batches' && (
                <div className="rounded-xl border border-border overflow-x-auto">
                    <table className="w-full text-sm min-w-[680px]">
                        <thead className="bg-muted/50 text-muted-foreground">
                            <tr>
                                <th className="text-left font-medium px-4 py-2.5">Batch</th>
                                <th className="text-right font-medium px-4 py-2.5">Numbers</th>
                                <th className="text-center font-medium px-4 py-2.5">Status</th>
                                <th className="text-right font-medium px-4 py-2.5">Created</th>
                                <th className="text-right font-medium px-4 py-2.5">Action</th>
                            </tr>
                        </thead>
                        <tbody>
                            {(data?.batches || []).length === 0 && (
                                <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">No batches yet.</td></tr>
                            )}
                            {(data?.batches || []).map(b => (
                                <tr key={b.id} className="border-t border-border">
                                    <td className="px-4 py-2.5">
                                        <div className="flex items-center gap-2"><FileSpreadsheet className="w-4 h-4 text-muted-foreground" /><span className="truncate max-w-[240px]">{b.filename}</span></div>
                                    </td>
                                    <td className="px-4 py-2.5 text-right">{b.number_count}</td>
                                    <td className="px-4 py-2.5 text-center">
                                        <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${statusPill(b.status)}`}>{b.status}</span>
                                    </td>
                                    <td className="px-4 py-2.5 text-right text-muted-foreground">{new Date(b.created_at).toLocaleDateString()}</td>
                                    <td className="px-4 py-2.5">
                                        <div className="flex items-center justify-end gap-2">
                                            <button
                                                onClick={() => reDownloadBatch(b)}
                                                disabled={busy === `dl-${b.id}`}
                                                title="Re-download this batch as Excel"
                                                className="inline-flex items-center gap-1.5 rounded-lg border border-border hover:bg-muted disabled:opacity-50 px-3 py-1.5 text-xs font-semibold"
                                            >
                                                {busy === `dl-${b.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                                                Re-download
                                            </button>
                                            {b.status === 'submitted' ? (
                                                <button
                                                    onClick={() => markRegistered(b)}
                                                    disabled={busy === `rel-${b.id}`}
                                                    className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white px-3 py-1.5 text-xs font-semibold"
                                                >
                                                    {busy === `rel-${b.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                                                    Mark Registered
                                                </button>
                                            ) : (
                                                <span className="inline-flex items-center gap-1 text-xs text-green-600"><CheckCircle2 className="w-3.5 h-3.5" /> Registered</span>
                                            )}
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {/* Registry */}
            {tab === 'registry' && (
                <div className="space-y-5">
                    <div>
                        <label className="text-sm font-medium text-foreground">Search a number</label>
                        <div className="flex gap-2 mt-1.5">
                            <input
                                value={search}
                                onChange={e => setSearch(e.target.value)}
                                onKeyDown={e => e.key === 'Enter' && runSearch()}
                                placeholder="024xxxxxxx"
                                className="flex-1 rounded-xl border border-border bg-background px-3 py-2.5 text-sm"
                            />
                            <button onClick={runSearch} disabled={busy === 'search'} className="flex items-center gap-2 rounded-xl bg-foreground text-background px-4 py-2.5 text-sm font-semibold disabled:opacity-50">
                                {busy === 'search' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />} Search
                            </button>
                        </div>
                        {registryRows && (
                            <div className="mt-3 rounded-xl border border-border overflow-x-auto">
                                <table className="w-full text-sm min-w-[440px]">
                                    <thead className="bg-muted/50 text-muted-foreground">
                                        <tr>
                                            <th className="text-left font-medium px-4 py-2.5">Phone</th>
                                            <th className="text-center font-medium px-4 py-2.5">Status</th>
                                            <th className="text-left font-medium px-4 py-2.5">Source</th>
                                            <th className="text-right font-medium px-4 py-2.5">First Seen</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {registryRows.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-muted-foreground">No match.</td></tr>}
                                        {registryRows.map(r => (
                                            <tr key={r.phone_number} className="border-t border-border">
                                                <td className="px-4 py-2.5 font-mono">{r.phone_number}</td>
                                                <td className="px-4 py-2.5 text-center"><span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${statusPill(r.status)}`}>{r.status}</span></td>
                                                <td className="px-4 py-2.5">{r.source}</td>
                                                <td className="px-4 py-2.5 text-right text-muted-foreground">{new Date(r.first_seen_at).toLocaleDateString()}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>

                    <div className="rounded-xl border border-border p-4">
                        <label className="text-sm font-medium text-foreground">Manually register numbers</label>
                        <p className="text-xs text-muted-foreground mt-1 mb-2">
                            Paste numbers your supplier registered outside a batch (comma, space, or newline separated).
                            They are marked registered and any held orders are released immediately.
                        </p>
                        <textarea
                            value={manualPhones}
                            onChange={e => setManualPhones(e.target.value)}
                            rows={4}
                            placeholder="0241234567, 0559876543"
                            className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm font-mono"
                        />
                        <button onClick={registerManual} disabled={busy === 'manual' || !manualPhones.trim()} className="mt-2 flex items-center gap-2 rounded-xl bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white px-4 py-2.5 text-sm font-semibold">
                            {busy === 'manual' ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Register &amp; Release
                        </button>
                    </div>
                </div>
            )}

            {/* Toast */}
            {toast && (
                <div className={`fixed left-1/2 -translate-x-1/2 z-[60] rounded-xl px-4 py-3 text-sm font-medium shadow-lg max-w-[92vw] sm:max-w-md text-center bottom-[calc(96px+env(safe-area-inset-bottom,0px))] lg:bottom-5 ${
                    toast.ok ? 'bg-green-600 text-white' : 'bg-red-600 text-white'
                }`}>
                    {toast.msg}
                </div>
            )}
        </div>
    )
}

function StatCard({ label, sub, value, color, Icon }: { label: string; sub: string; value: number; color: string; Icon: any }) {
    return (
        <div className="rounded-2xl bg-card border border-border p-4">
            <div className="flex items-center gap-2 mb-2">
                <Icon className={`w-4 h-4 ${color}`} />
                <p className="text-xs font-medium text-muted-foreground">{label}</p>
            </div>
            <p className="text-2xl font-bold text-foreground leading-none">{value}</p>
            <p className="text-xs text-muted-foreground mt-1">{sub}</p>
        </div>
    )
}
