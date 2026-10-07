// app/admin/website-requests/page.tsx
'use client'

import { useEffect, useState, useMemo } from 'react'
import { Phone, MessageSquare, Loader2 } from 'lucide-react'
import { toast } from '@/lib/toast'
import { formatDate, normalizeWhatsAppNumber } from '@/lib/utils'
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
    WEBSITE_REQUEST_CATEGORIES,
    TIMELINE_OPTIONS,
    CATEGORY_FEATURES,
} from '@/lib/website-request-categories'

interface WebsiteRequestRow {
    id: string
    request_type: 'full_request' | 'call_request'
    category: string | null
    budget_ghs: number | null
    features: string[] | null
    description: string
    reference_sites: string | null
    timeline: string | null
    contact_phone: string
    contact_whatsapp: string | null
    status: 'new' | 'contacted' | 'closed'
    closed_outcome: string | null
    admin_notes: string | null
    created_at: string
    users?: { first_name: string; last_name: string; email: string }
}

type StatusFilter = 'all' | 'new' | 'contacted' | 'closed'

const categoryLabel = (key: string | null): string =>
    WEBSITE_REQUEST_CATEGORIES.find(c => c.key === key)?.label ?? (key ?? '')

const timelineLabel = (key: string | null): string =>
    TIMELINE_OPTIONS.find(t => t.key === key)?.label ?? (key ?? '')

const featureLabel = (categoryKey: string | null, featureKey: string): string =>
    CATEGORY_FEATURES[categoryKey ?? '']?.find(f => f.key === featureKey)?.label ?? featureKey

export default function AdminWebsiteRequestsPage() {
    const [requests, setRequests] = useState<WebsiteRequestRow[]>([])
    const [loading, setLoading] = useState(true)
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
    const [active, setActive] = useState<WebsiteRequestRow | null>(null)
    const [notesDraft, setNotesDraft] = useState('')
    const [savingStatus, setSavingStatus] = useState(false)

    useEffect(() => {
        fetchRequests()
    }, [])

    const fetchRequests = async () => {
        setLoading(true)
        try {
            const res = await fetch('/api/admin/website-requests')
            const json = await res.json()
            if (json.success) setRequests(json.data)
        } catch {
            toast.error('Failed to load website requests')
        } finally {
            setLoading(false)
        }
    }

    const filtered = useMemo(() => {
        if (statusFilter === 'all') return requests
        return requests.filter(r => r.status === statusFilter)
    }, [requests, statusFilter])

    const openDetail = (row: WebsiteRequestRow) => {
        setActive(row)
        setNotesDraft(row.admin_notes || '')
    }

    const updateStatus = async (status: WebsiteRequestRow['status'], closedOutcome?: string) => {
        if (!active) return
        setSavingStatus(true)
        try {
            const res = await fetch(`/api/admin/website-requests/${active.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status, closed_outcome: closedOutcome, admin_notes: notesDraft }),
            })
            const json = await res.json()
            if (!json.success) {
                toast.error(json.details?.[0] || json.error || 'Failed to update')
                return
            }
            setRequests(prev => prev.map(r => r.id === active.id ? json.data : r))
            setActive(json.data)
            toast.success('Updated')
        } catch {
            toast.error('Failed to update request')
        } finally {
            setSavingStatus(false)
        }
    }

    return (
        <div className="p-4 space-y-4">
            <div className="flex items-center justify-between">
                <h1 className="text-lg font-bold text-foreground">Website & App Requests</h1>
                <select
                    value={statusFilter}
                    onChange={e => setStatusFilter(e.target.value as StatusFilter)}
                    className="rounded-lg border border-border bg-background p-2 text-sm"
                >
                    <option value="all">All statuses</option>
                    <option value="new">New</option>
                    <option value="contacted">Contacted</option>
                    <option value="closed">Closed</option>
                </select>
            </div>

            {loading ? (
                <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
            ) : (
                <div className="rounded-2xl border border-border overflow-hidden">
                    {filtered.map(row => (
                        <button
                            key={row.id}
                            onClick={() => openDetail(row)}
                            className="w-full text-left flex items-center justify-between gap-3 p-4 border-b border-border last:border-b-0 hover:bg-muted/50"
                        >
                            <div className="min-w-0">
                                <p className="text-sm font-semibold text-foreground truncate">
                                    {row.users?.first_name} {row.users?.last_name}
                                    {' · '}
                                    {row.request_type === 'full_request' ? categoryLabel(row.category) : 'Call request'}
                                </p>
                                <p className="text-xs text-muted-foreground truncate">
                                    {row.request_type === 'full_request' && row.budget_ghs ? `GHS ${row.budget_ghs} · ` : ''}
                                    {formatDate(row.created_at)}
                                </p>
                            </div>
                            <Badge variant={row.status === 'new' ? 'processing' : row.status === 'closed' ? 'completed' : 'pending'}>
                                {row.status}
                            </Badge>
                        </button>
                    ))}
                    {filtered.length === 0 && (
                        <p className="p-6 text-center text-sm text-muted-foreground">No requests found</p>
                    )}
                </div>
            )}

            <Dialog open={!!active} onOpenChange={open => { if (!open) setActive(null) }}>
                <DialogContent className="max-w-lg w-[calc(100vw-2rem)] sm:w-full">
                    {active && (
                        <>
                            <DialogHeader>
                                <DialogTitle>
                                    {active.request_type === 'full_request' ? categoryLabel(active.category) : 'Call Request'}
                                </DialogTitle>
                            </DialogHeader>

                            <div className="space-y-3 text-sm">
                                <div className="flex flex-wrap items-center gap-3">
                                    <a href={`tel:${active.contact_phone}`} className="inline-flex items-center gap-1 text-primary hover:underline">
                                        <Phone className="w-3.5 h-3.5" /> {active.contact_phone}
                                    </a>
                                    <a
                                        href={`https://wa.me/${normalizeWhatsAppNumber(active.contact_whatsapp || active.contact_phone)}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1 text-primary hover:underline"
                                    >
                                        <MessageSquare className="w-3.5 h-3.5" /> WhatsApp
                                    </a>
                                </div>

                                {active.request_type === 'full_request' && (
                                    <>
                                        <p>
                                            <span className="font-semibold">Budget guide:</span> GHS {active.budget_ghs}
                                            <span className="ml-1 text-xs text-muted-foreground">(client&apos;s estimate, not a quote)</span>
                                        </p>
                                        <p><span className="font-semibold">Timeline:</span> {timelineLabel(active.timeline)}</p>
                                        {active.features && active.features.length > 0 && (
                                            <p><span className="font-semibold">Features:</span> {active.features.map(f => featureLabel(active.category, f)).join(', ')}</p>
                                        )}
                                    </>
                                )}

                                <p className="whitespace-pre-wrap">
                                    <span className="font-semibold">
                                        {active.request_type === 'full_request' ? 'Description:' : 'Reason for call:'}
                                    </span>{' '}
                                    {active.description}
                                </p>

                                {active.reference_sites && (
                                    <p className="whitespace-pre-wrap">
                                        <span className="font-semibold">Sites they like:</span>{' '}
                                        {active.reference_sites}
                                    </p>
                                )}

                                <div>
                                    <label className="text-xs font-semibold text-foreground">Admin notes</label>
                                    <textarea
                                        value={notesDraft}
                                        onChange={e => setNotesDraft(e.target.value.slice(0, 5000))}
                                        rows={3}
                                        maxLength={5000}
                                        className="mt-1 w-full rounded-lg border border-border bg-background p-2 text-sm"
                                    />
                                    <p className="text-xs text-muted-foreground mt-1">{notesDraft.length}/5000</p>
                                </div>

                                <div className="flex flex-wrap gap-2 pt-2">
                                    <Button size="sm" variant={active.status === 'contacted' ? 'default' : 'outline'} disabled={savingStatus} onClick={() => updateStatus('contacted')}>
                                        Mark Contacted
                                    </Button>
                                    <Button size="sm" variant="outline" disabled={savingStatus} onClick={() => updateStatus('closed', 'won')}>
                                        Close: Won
                                    </Button>
                                    <Button size="sm" variant="outline" disabled={savingStatus} onClick={() => updateStatus('closed', 'lost')}>
                                        Close: Lost
                                    </Button>
                                    <Button size="sm" variant="outline" disabled={savingStatus} onClick={() => updateStatus('closed', 'spam')}>
                                        Close: Spam
                                    </Button>
                                </div>
                            </div>
                        </>
                    )}
                </DialogContent>
            </Dialog>
        </div>
    )
}
