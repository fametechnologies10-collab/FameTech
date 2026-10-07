'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useAuth } from '@/contexts/auth-context'
import { supabase } from '@/lib/supabase'
import { formatCurrency, cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
    Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import {
    Users, ArrowLeft, Search, Loader2, RefreshCcw, Copy, Check,
    MessageCircle, Share2, Crown, Clock, ShoppingCart, QrCode,
    TrendingUp, Lightbulb, Tag, Save, MessageSquare, Smartphone
} from 'lucide-react'
import { toast } from '@/lib/toast'

interface ShopCustomer {
    id: string
    phone: string
    name: string | null
    tags: string[]
    notes: string | null
    total_orders: number
    total_spent: number
    first_order_at: string | null
    last_order_at: string | null
    from_ussd?: boolean  // has at least one order placed via the shop's USSD code
}

type SortKey = 'recent' | 'spend' | 'orders'

export default function ShopCustomersPage() {
    const { dbUser } = useAuth()
    const [customers, setCustomers] = useState<ShopCustomer[]>([])
    const [shopSlug, setShopSlug] = useState('')
    const [shopName, setShopName] = useState('')
    const [loading, setLoading] = useState(true)
    const [isRefreshing, setIsRefreshing] = useState(false)
    const [search, setSearch] = useState('')
    const [sortKey, setSortKey] = useState<SortKey>('recent')
    const [ussdOnly, setUssdOnly] = useState(false)
    const [copied, setCopied] = useState(false)

    // Edit modal
    const [editing, setEditing] = useState<ShopCustomer | null>(null)
    const [editTags, setEditTags] = useState('')
    const [editNotes, setEditNotes] = useState('')
    const [savingEdit, setSavingEdit] = useState(false)

    useEffect(() => {
        if (dbUser) fetchData()
    }, [dbUser])

    const fetchData = async () => {
        try {
            const { data: shop } = await (supabase as any)
                .from('shop_profiles')
                .select('shop_slug, shop_name')
                .eq('owner_id', dbUser!.id)
                .maybeSingle()
            if (shop) { setShopSlug(shop.shop_slug); setShopName(shop.shop_name) }

            const res = await fetch('/api/shop/customers')
            const json = await res.json()
            if (json.success) setCustomers(json.data.customers)
            else toast.error(json.error || 'Failed to load customers')
        } catch (err) {
            console.error('[Customers]', err)
            toast.error('Failed to load customers')
        } finally {
            setLoading(false)
        }
    }

    const handleRefresh = async () => {
        setIsRefreshing(true)
        await fetchData()
        setIsRefreshing(false)
        toast.success('Customer list updated')
    }

    const shopUrl = shopSlug ? `https://shop.kingflexygh.com/${shopSlug}` : ''
    const shareText = `🛍️ Buy affordable data bundles, airtime & vouchers from ${shopName || 'my shop'}: ${shopUrl}`

    const copyLink = async () => {
        await navigator.clipboard.writeText(shopUrl)
        setCopied(true)
        toast.success('Shop link copied!')
        setTimeout(() => setCopied(false), 2000)
    }

    const filtered = useMemo(() => {
        let list = customers
        if (ussdOnly) list = list.filter(c => c.from_ussd)
        if (search.trim()) {
            const q = search.trim().toLowerCase()
            list = list.filter(c =>
                c.phone.includes(q) ||
                (c.name || '').toLowerCase().includes(q) ||
                c.tags.some(t => t.toLowerCase().includes(q)) ||
                (!!c.from_ussd && 'ussd'.includes(q))
            )
        }
        return [...list].sort((a, b) => {
            if (sortKey === 'spend') return b.total_spent - a.total_spent
            if (sortKey === 'orders') return b.total_orders - a.total_orders
            return new Date(b.last_order_at || 0).getTime() - new Date(a.last_order_at || 0).getTime()
        })
    }, [customers, search, sortKey, ussdOnly])

    const ussdCount = useMemo(() => customers.filter(c => c.from_ussd).length, [customers])

    const totals = useMemo(() => ({
        count: customers.length,
        revenue: customers.reduce((s, c) => s + c.total_spent, 0),
        orders: customers.reduce((s, c) => s + c.total_orders, 0),
        returning: customers.filter(c => c.total_orders > 1).length,
    }), [customers])

    const topSpenderId = useMemo(() => {
        if (customers.length === 0) return null
        return [...customers].sort((a, b) => b.total_spent - a.total_spent)[0]?.id || null
    }, [customers])

    const openEdit = (c: ShopCustomer) => {
        setEditing(c)
        setEditTags(c.tags.join(', '))
        setEditNotes(c.notes || '')
    }

    const saveEdit = async () => {
        if (!editing) return
        setSavingEdit(true)
        try {
            const tags = editTags.split(',').map(t => t.trim()).filter(Boolean).slice(0, 10)
            const res = await fetch('/api/shop/customers', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ customerId: editing.id, tags, notes: editNotes }),
            })
            const json = await res.json()
            if (!json.success) throw new Error(json.error)
            setCustomers(prev => prev.map(c => c.id === editing.id ? { ...c, tags, notes: editNotes || null } : c))
            toast.success('Customer updated')
            setEditing(null)
        } catch (err: any) {
            toast.error(err.message || 'Failed to update')
        } finally {
            setSavingEdit(false)
        }
    }

    if (loading) {
        return (
            <div className="flex items-center justify-center py-20">
                <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
        )
    }

    return (
        <div className="space-y-5 pb-20 md:pb-6">
            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                    <Link href="/dashboard/shop">
                        <Button variant="ghost" size="sm" className="w-fit gap-2 -ml-2 text-muted-foreground hover:text-emerald-600 transition-colors">
                            <ArrowLeft className="w-4 h-4" />
                            Back to Shop Dashboard
                        </Button>
                    </Link>
                    <h1 className="text-xl font-bold flex items-center gap-2 mt-1">
                        <Users className="w-5 h-5 text-emerald-600" />
                        Customers
                    </h1>
                    <p className="text-muted-foreground text-sm mt-0.5">
                        Everyone who has bought from your shop — and the tools to find more.
                    </p>
                </div>
                <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isRefreshing} className="gap-1.5 w-fit">
                    <RefreshCcw className={cn('w-3.5 h-3.5', isRefreshing && 'animate-spin')} />
                    Refresh
                </Button>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
                {[
                    { label: 'Customers', value: String(totals.count), icon: Users, color: 'text-emerald-600' },
                    { label: 'Returning', value: String(totals.returning), icon: Crown, color: 'text-amber-600' },
                    { label: 'Total Orders', value: String(totals.orders), icon: ShoppingCart, color: 'text-blue-600' },
                    { label: 'Total Revenue', value: formatCurrency(totals.revenue), icon: TrendingUp, color: 'text-purple-600' },
                ].map(({ label, value, icon: Icon, color }) => (
                    <Card key={label} className="border shadow-sm rounded-xl">
                        <CardContent className="p-3.5">
                            <div className="flex items-center gap-1.5 mb-1">
                                <Icon className={cn('w-3.5 h-3.5', color)} />
                                <p className="text-[11px] text-muted-foreground font-medium">{label}</p>
                            </div>
                            <p className="text-base font-bold tabular-nums truncate">{value}</p>
                        </CardContent>
                    </Card>
                ))}
            </div>

            {/* ── Grow Your Shop (sharing) ── */}
            <div className="rounded-2xl bg-gradient-to-br from-emerald-700 to-emerald-900 p-5 text-white space-y-4">
                <div className="flex items-center gap-2">
                    <Share2 className="w-4 h-4 text-emerald-200" />
                    <h2 className="text-sm font-bold">Grow Your Shop</h2>
                </div>

                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 bg-white/10 p-2 rounded-xl">
                    <span className="text-xs font-mono text-emerald-100 truncate flex-1 px-2 py-1.5">{shopUrl}</span>
                    <div className="flex gap-2">
                        <Button onClick={copyLink} size="sm" variant="secondary" className="flex-1 sm:flex-none h-9 bg-white text-emerald-700 gap-1.5 rounded-lg font-semibold hover:bg-emerald-50">
                            {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />} {copied ? 'Copied!' : 'Copy'}
                        </Button>
                        <a href={`https://wa.me/?text=${encodeURIComponent(shareText)}`} target="_blank" rel="noopener noreferrer">
                            <Button size="sm" className="h-9 bg-[#25D366] hover:bg-[#1ebc57] text-white gap-1.5 rounded-lg font-semibold">
                                <MessageCircle className="w-3.5 h-3.5" /> WhatsApp
                            </Button>
                        </a>
                        <a
                            href={`https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(shopUrl)}`}
                            target="_blank" rel="noopener noreferrer" title="Download QR code"
                        >
                            <Button size="sm" variant="secondary" className="h-9 bg-white/15 hover:bg-white/25 text-white gap-1.5 rounded-lg font-semibold border-0">
                                <QrCode className="w-3.5 h-3.5" /> QR
                            </Button>
                        </a>
                    </div>
                </div>

                <div className="grid sm:grid-cols-2 gap-2 text-xs text-emerald-100/90">
                    <div className="flex gap-2 items-start"><Lightbulb className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-emerald-300" /> Post your link on WhatsApp status daily — consistency beats one big push.</div>
                    <div className="flex gap-2 items-start"><Lightbulb className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-emerald-300" /> Print the QR code and place it where your community gathers.</div>
                    <div className="flex gap-2 items-start"><Lightbulb className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-emerald-300" /> Reward returning customers with a small discount on bulk orders.</div>
                    <div className="flex gap-2 items-start"><Lightbulb className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-emerald-300" /> Use SMS broadcasts to announce promos to your customer list.</div>
                </div>
            </div>

            {/* Search + sort */}
            <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center justify-between">
                <div className="relative flex-1 sm:max-w-xs">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                        placeholder="Search phone, name or tag..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="pl-9 h-9"
                    />
                </div>
                <div className="flex items-center gap-2">
                    {/* USSD-only filter — surfaces customers who bought via the shop's USSD code */}
                    <button
                        onClick={() => setUssdOnly(v => !v)}
                        title="Show only customers who bought via USSD"
                        className={cn(
                            'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors whitespace-nowrap',
                            ussdOnly
                                ? 'bg-violet-600 border-violet-600 text-white'
                                : 'bg-muted border-transparent text-muted-foreground hover:text-foreground'
                        )}
                    >
                        <Smartphone className="w-3.5 h-3.5" />
                        USSD{ussdCount > 0 ? ` (${ussdCount})` : ''}
                    </button>
                    <div className="flex bg-muted rounded-lg p-1 w-fit">
                        {([
                            { id: 'recent', label: 'Recent' },
                            { id: 'spend', label: 'Top Spenders' },
                            { id: 'orders', label: 'Most Orders' },
                        ] as const).map(s => (
                            <button
                                key={s.id}
                                onClick={() => setSortKey(s.id)}
                                className={cn(
                                    'px-3 py-1.5 text-xs font-semibold rounded-md transition-all whitespace-nowrap',
                                    sortKey === s.id ? 'bg-white dark:bg-gray-800 shadow-sm text-emerald-600' : 'text-muted-foreground hover:text-foreground'
                                )}
                            >
                                {s.label}
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            {/* Customer list */}
            <Card className="rounded-2xl overflow-hidden">
                <CardContent className="p-0">
                    {filtered.length === 0 ? (
                        <div className="text-center py-14 text-muted-foreground px-4">
                            <Users className="w-9 h-9 mx-auto mb-2 opacity-25" />
                            <p className="text-sm font-medium">
                                {customers.length === 0 ? 'No customers yet.' : 'No customers match your search.'}
                            </p>
                            {customers.length === 0 && (
                                <p className="text-xs mt-1">Share your shop link above — every buyer is added here automatically.</p>
                            )}
                        </div>
                    ) : (
                        <div className="divide-y">
                            {filtered.map(c => (
                                <button
                                    key={c.id}
                                    onClick={() => openEdit(c)}
                                    className="w-full text-left px-4 py-3 flex items-center justify-between gap-3 hover:bg-muted/30 transition-colors"
                                >
                                    <div className="flex items-center gap-3 min-w-0">
                                        <div className={cn(
                                            'w-9 h-9 rounded-full flex items-center justify-center font-bold text-xs flex-shrink-0',
                                            c.id === topSpenderId
                                                ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                                                : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                                        )}>
                                            {c.id === topSpenderId ? <Crown className="w-4 h-4" /> : (c.name?.charAt(0)?.toUpperCase() || c.phone.slice(-2))}
                                        </div>
                                        <div className="min-w-0">
                                            <div className="flex items-center gap-1.5 min-w-0">
                                                <p className="font-semibold text-sm truncate">{c.name || c.phone}</p>
                                                {c.from_ussd && (
                                                    <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-full bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400 flex-shrink-0">
                                                        <Smartphone className="w-2.5 h-2.5" /> USSD
                                                    </span>
                                                )}
                                            </div>
                                            <p className="text-xs text-muted-foreground font-mono">{c.phone}</p>
                                            {c.tags.length > 0 && (
                                                <div className="flex gap-1 mt-1 flex-wrap">
                                                    {c.tags.slice(0, 3).map(t => (
                                                        <span key={t} className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-600 dark:bg-blue-900/20 dark:text-blue-400">{t}</span>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                    <div className="text-right flex-shrink-0">
                                        <p className="font-bold text-sm tabular-nums">{formatCurrency(c.total_spent)}</p>
                                        <p className="text-[11px] text-muted-foreground">{c.total_orders} order{c.total_orders === 1 ? '' : 's'}</p>
                                        {c.last_order_at && (
                                            <p className="text-[10px] text-muted-foreground/70 flex items-center gap-0.5 justify-end mt-0.5">
                                                <Clock className="w-2.5 h-2.5" />
                                                {new Date(c.last_order_at).toLocaleDateString()}
                                            </p>
                                        )}
                                    </div>
                                </button>
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* SMS shortcut */}
            {customers.length > 0 && (
                <Link href="/dashboard/shop/sms" className="block">
                    <div className="flex items-center justify-between p-4 rounded-2xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50/60 dark:bg-emerald-950/20 hover:bg-emerald-100/60 dark:hover:bg-emerald-950/40 transition-colors">
                        <div className="flex items-center gap-3">
                            <div className="w-9 h-9 rounded-xl bg-emerald-600 text-white flex items-center justify-center">
                                <MessageSquare className="w-4 h-4" />
                            </div>
                            <div>
                                <p className="font-semibold text-sm">Message your customers</p>
                                <p className="text-xs text-muted-foreground">Send promos and updates by SMS to your whole customer list.</p>
                            </div>
                        </div>
                        <Tag className="w-4 h-4 text-emerald-600" />
                    </div>
                </Link>
            )}

            {/* Edit modal */}
            <Dialog open={!!editing} onOpenChange={(open) => { if (!open) setEditing(null) }}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <Users className="w-4 h-4 text-emerald-600" />
                            {editing?.name || editing?.phone}
                        </DialogTitle>
                    </DialogHeader>
                    {editing && (
                        <div className="space-y-4">
                            <div className="grid grid-cols-3 gap-2 text-center bg-muted/40 rounded-xl p-3">
                                <div>
                                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Orders</p>
                                    <p className="font-bold text-sm">{editing.total_orders}</p>
                                </div>
                                <div>
                                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Spent</p>
                                    <p className="font-bold text-sm">{formatCurrency(editing.total_spent)}</p>
                                </div>
                                <div>
                                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Since</p>
                                    <p className="font-bold text-sm">{editing.first_order_at ? new Date(editing.first_order_at).toLocaleDateString() : '—'}</p>
                                </div>
                            </div>

                            <div>
                                <label className="text-xs font-semibold text-muted-foreground">Tags (comma separated, max 10)</label>
                                <Input
                                    value={editTags}
                                    onChange={e => setEditTags(e.target.value)}
                                    placeholder="vip, bulk-buyer, mtn"
                                    className="mt-1.5 h-10"
                                />
                            </div>
                            <div>
                                <label className="text-xs font-semibold text-muted-foreground">Notes (private)</label>
                                <Textarea
                                    value={editNotes}
                                    onChange={e => setEditNotes(e.target.value)}
                                    placeholder="e.g. Prefers MTN bundles, buys every Friday"
                                    rows={3}
                                    maxLength={500}
                                    className="mt-1.5"
                                />
                            </div>
                        </div>
                    )}
                    <DialogFooter className="gap-2">
                        <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
                        <Button onClick={saveEdit} disabled={savingEdit} className="bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5">
                            {savingEdit ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                            Save
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
