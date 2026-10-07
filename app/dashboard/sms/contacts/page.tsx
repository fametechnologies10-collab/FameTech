'use client'

/**
 * KFT SMS — Contact Groups (/dashboard/sms/contacts)
 *
 * Manage reusable recipient lists for the user SMS platform: create / rename /
 * delete groups, add single contacts, bulk CSV import (chunked upserts with
 * duplicate-safe onConflict), search and delete. All reads/writes go through
 * the RLS-scoped browser client — owner CRUD policies enforce access.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { motion, AnimatePresence } from 'framer-motion'
import { useAuth } from '@/contexts/auth-context'
import { supabase } from '@/lib/supabase'
import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import {
    Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import {
    ArrowLeft, Users, Plus, Pencil, Trash2, Loader2, Search, X,
    UserPlus, Upload, FileText, FolderPlus, AlertCircle, RefreshCcw,
    ChevronRight, Phone, Megaphone,
} from 'lucide-react'
import { toast } from '@/lib/toast'

// ── Types ────────────────────────────────────────────────────────────────────

interface GroupRow {
    id: string
    name: string
    description: string | null
    created_at: string
    count: number
}

interface ContactRow {
    id: string
    phone_number: string
    first_name: string | null
    last_name: string | null
    created_at: string
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Ghana phone normalizer — mirrors the server's. 0XXXXXXXXX / 233XXXXXXXXX → 233XXXXXXXXX. */
function normalizeGhanaPhone(raw: string): string | null {
    let n = raw.replace(/[\s\-+()]/g, '')
    if (!/^\d+$/.test(n)) return null
    if (n.startsWith('0') && n.length === 10) n = '233' + n.slice(1)
    if (n.startsWith('233') && n.length === 12) return n
    return null
}

function displayPhone(n: string): string {
    return n.startsWith('233') && n.length === 12 ? '0' + n.slice(3) : n
}

function contactName(c: ContactRow): string {
    return [c.first_name, c.last_name].filter(Boolean).join(' ').trim()
}

function initialsOf(c: ContactRow): string {
    const name = contactName(c)
    if (!name) return '#'
    return name.split(/\s+/).slice(0, 2).map(p => p[0]?.toUpperCase() ?? '').join('') || '#'
}

/** Minimal CSV line parser that copes with quoted cells. */
function parseCsvLine(line: string): string[] {
    const out: string[] = []
    let cur = ''
    let inQ = false
    for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (inQ) {
            if (ch === '"') {
                if (line[i + 1] === '"') { cur += '"'; i++ } else inQ = false
            } else cur += ch
        } else if (ch === '"') {
            inQ = true
        } else if (ch === ',') {
            out.push(cur); cur = ''
        } else cur += ch
    }
    out.push(cur)
    return out.map(s => s.trim())
}

const PHONE_COL_RE = /^(phone|phone[_ ]?number|number|mobile|msisdn|recipient|tel)s?$/i
const FIRST_COL_RE = /^(first[_ ]?name|firstname|first|given[_ ]?name)$/i
const LAST_COL_RE  = /^(last[_ ]?name|lastname|last|surname)$/i
const NAME_COL_RE  = /^(full[_ ]?name|name|customer)$/i

function cleanName(v: string | undefined): string | null {
    const t = (v ?? '').replace(/<[^>]*>/g, '').trim().slice(0, 60)
    return t || null
}

// ── Component ────────────────────────────────────────────────────────────────

export default function SmsContactsPage() {
    const { dbUser } = useAuth()

    const [accountId, setAccountId] = useState<string | null>(null)
    const [loading, setLoading]     = useState(true)
    const [loadError, setLoadError] = useState<string | null>(null)

    // Groups
    const [groups, setGroups]           = useState<GroupRow[]>([])
    const [selectedId, setSelectedId]   = useState<string | null>(null)

    // Group dialogs
    const [createOpen, setCreateOpen]   = useState(false)
    const [formName, setFormName]       = useState('')
    const [formDesc, setFormDesc]       = useState('')
    const [savingGroup, setSavingGroup] = useState(false)
    const [groupFormError, setGroupFormError] = useState<string | null>(null)
    const [editTarget, setEditTarget]     = useState<GroupRow | null>(null)
    const [deleteTarget, setDeleteTarget] = useState<GroupRow | null>(null)
    const [deletingGroup, setDeletingGroup] = useState(false)

    // Contacts (detail view)
    const [contacts, setContacts]               = useState<ContactRow[]>([])
    const [contactsLoading, setContactsLoading] = useState(false)
    const [search, setSearch]                   = useState('')

    // Add-single form
    const [addOpen, setAddOpen]             = useState(false)
    const [addPhone, setAddPhone]           = useState('')
    const [addFirst, setAddFirst]           = useState('')
    const [addLast, setAddLast]             = useState('')
    const [savingContact, setSavingContact] = useState(false)
    const [contactFormError, setContactFormError] = useState<string | null>(null)
    const addPhoneRef                       = useRef<HTMLInputElement>(null)

    // CSV import + delete
    const [importing, setImporting]           = useState(false)
    const [deletingContactId, setDeletingContactId] = useState<string | null>(null)
    const fileRef                             = useRef<HTMLInputElement>(null)

    const selected = useMemo(
        () => groups.find(g => g.id === selectedId) ?? null,
        [groups, selectedId],
    )

    // ── Data loading ─────────────────────────────────────────────────────────

    const fetchGroups = useCallback(async (accId: string) => {
        const { data: rows, error } = await (supabase as any)
            .from('sms_contact_groups')
            .select('id, name, description, created_at, sms_group_contacts(count)')
            .eq('account_id', accId)
            .order('created_at', { ascending: false })
        if (error) throw error
        setGroups((rows ?? []).map((g: any) => ({
            id: g.id,
            name: g.name,
            description: g.description ?? null,
            created_at: g.created_at,
            count: g.sms_group_contacts?.[0]?.count ?? 0,
        })))
    }, [])

    const loadAll = useCallback(async () => {
        setLoading(true)
        setLoadError(null)
        try {
            const res  = await fetch('/api/sms/account')
            const json = await res.json().catch(() => null)
            if (!json?.success) {
                setLoadError(json?.error || 'Failed to load your SMS account')
                return
            }
            const accId: string = json.data.account.id
            setAccountId(accId)
            await fetchGroups(accId)
        } catch (err) {
            console.error('[SMS Contacts] load:', err)
            setLoadError('Network error — check your connection and retry')
        } finally {
            setLoading(false)
        }
    }, [fetchGroups])

    useEffect(() => {
        if (dbUser) loadAll()
    }, [dbUser, loadAll])

    const loadContacts = useCallback(async (groupId: string) => {
        setContactsLoading(true)
        try {
            const out: ContactRow[] = []
            for (let page = 0; page < 10; page++) {
                const { data: rows, error } = await (supabase as any)
                    .from('sms_group_contacts')
                    .select('id, phone_number, first_name, last_name, created_at')
                    .eq('group_id', groupId)
                    .order('created_at', { ascending: false })
                    .range(page * 1000, page * 1000 + 999)
                if (error) throw error
                out.push(...(rows ?? []))
                if ((rows ?? []).length < 1000) break
            }
            setContacts(out)
        } catch (err) {
            console.error('[SMS Contacts] contacts load:', err)
            toast.error('Failed to load contacts')
        } finally {
            setContactsLoading(false)
        }
    }, [])

    // ── Group handlers ───────────────────────────────────────────────────────

    const openGroup = (g: GroupRow) => {
        setSelectedId(g.id)
        setSearch('')
        setAddOpen(false)
        setContacts([])
        loadContacts(g.id)
    }

    const backToList = () => {
        setSelectedId(null)
        setContacts([])
        setSearch('')
        setAddOpen(false)
    }

    const handleCreateGroup = async () => {
        if (!accountId) return
        const name = formName.trim().slice(0, 80)
        setGroupFormError(null)
        if (!name) { setGroupFormError('Give the group a name'); toast.error('Give the group a name'); return }
        setSavingGroup(true)
        try {
            const { data: row, error } = await (supabase as any)
                .from('sms_contact_groups')
                .insert({ account_id: accountId, name, description: formDesc.trim().slice(0, 200) || null })
                .select('id, name, description, created_at')
                .single()
            if (error) throw error
            setGroups(prev => [{ ...row, count: 0 }, ...prev])
            setCreateOpen(false)
            setFormName('')
            setFormDesc('')
            toast.success(`Group "${name}" created`)
        } catch (err: any) {
            console.error('[SMS Contacts] create group:', err)
            const msg = err?.message?.includes('check') ? 'Group name must be 1–80 characters' : 'Could not create group'
            setGroupFormError(msg)
            toast.error(msg)
        } finally {
            setSavingGroup(false)
        }
    }

    const handleRenameGroup = async () => {
        if (!editTarget) return
        const name = formName.trim().slice(0, 80)
        setGroupFormError(null)
        if (!name) { setGroupFormError('Give the group a name'); toast.error('Give the group a name'); return }
        setSavingGroup(true)
        try {
            const desc = formDesc.trim().slice(0, 200) || null
            const { error } = await (supabase as any)
                .from('sms_contact_groups')
                .update({ name, description: desc, updated_at: new Date().toISOString() })
                .eq('id', editTarget.id)
            if (error) throw error
            setGroups(prev => prev.map(g => g.id === editTarget.id ? { ...g, name, description: desc } : g))
            setEditTarget(null)
            toast.success('Group updated')
        } catch (err: any) {
            console.error('[SMS Contacts] rename group:', err)
            const msg = err?.message?.includes('check') ? 'Group name must be 1–80 characters' : 'Could not update group'
            setGroupFormError(msg)
            toast.error(msg)
        } finally {
            setSavingGroup(false)
        }
    }

    const handleDeleteGroup = async () => {
        if (!deleteTarget) return
        setDeletingGroup(true)
        try {
            const { error } = await (supabase as any)
                .from('sms_contact_groups')
                .delete()
                .eq('id', deleteTarget.id)
            if (error) throw error
            setGroups(prev => prev.filter(g => g.id !== deleteTarget.id))
            if (selectedId === deleteTarget.id) backToList()
            toast.success(`Group "${deleteTarget.name}" deleted`)
            setDeleteTarget(null)
        } catch (err) {
            console.error('[SMS Contacts] delete group:', err)
            toast.error('Could not delete group')
        } finally {
            setDeletingGroup(false)
        }
    }

    // ── Contact handlers ─────────────────────────────────────────────────────

    const openAddForm = () => {
        setContactFormError(null)
        setAddOpen(true)
        // iOS: focus inside the gesture chain — double rAF, never setTimeout
        requestAnimationFrame(() => {
            requestAnimationFrame(() => { addPhoneRef.current?.focus() })
        })
    }

    const handleAddContact = async () => {
        if (!selected) return
        setContactFormError(null)
        const n = normalizeGhanaPhone(addPhone)
        if (!n) {
            const msg = 'Enter a valid Ghana number (e.g. 0244123456)'
            setContactFormError(msg)
            toast.error(msg)
            return
        }
        setSavingContact(true)
        try {
            const { data: rows, error } = await (supabase as any)
                .from('sms_group_contacts')
                .upsert(
                    {
                        group_id: selected.id,
                        phone_number: n,
                        first_name: cleanName(addFirst),
                        last_name: cleanName(addLast),
                    },
                    { onConflict: 'group_id,phone_number', ignoreDuplicates: true },
                )
                .select('id, phone_number, first_name, last_name, created_at')
            if (error) throw error
            if (!rows || rows.length === 0) {
                toast.info(`${displayPhone(n)} is already in this group`)
            } else {
                setContacts(prev => [rows[0], ...prev])
                setGroups(prev => prev.map(g => g.id === selected.id ? { ...g, count: g.count + 1 } : g))
                toast.success(`${displayPhone(n)} added`)
            }
            setAddPhone('')
            setAddFirst('')
            setAddLast('')
            // Keep the form open for rapid entry and re-focus the phone field
            requestAnimationFrame(() => {
                requestAnimationFrame(() => { addPhoneRef.current?.focus() })
            })
        } catch (err) {
            console.error('[SMS Contacts] add contact:', err)
            const msg = 'Could not add contact'
            setContactFormError(msg)
            toast.error(msg)
        } finally {
            setSavingContact(false)
        }
    }

    const handleDeleteContact = async (c: ContactRow) => {
        if (!selected) return
        setDeletingContactId(c.id)
        try {
            const { error } = await (supabase as any)
                .from('sms_group_contacts')
                .delete()
                .eq('id', c.id)
            if (error) throw error
            setContacts(prev => prev.filter(x => x.id !== c.id))
            setGroups(prev => prev.map(g => g.id === selected.id ? { ...g, count: Math.max(0, g.count - 1) } : g))
            toast.success(`${displayPhone(c.phone_number)} removed`)
        } catch (err) {
            console.error('[SMS Contacts] delete contact:', err)
            toast.error('Could not remove contact')
        } finally {
            setDeletingContactId(null)
        }
    }

    const handleImportFile = async (file: File) => {
        if (!selected) return
        setImporting(true)
        try {
            const text  = await file.text()
            const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0)
            if (lines.length === 0) { toast.error('That file is empty'); return }

            const header  = parseCsvLine(lines[0])
            const findCol = (re: RegExp) => header.findIndex(h => re.test(h))
            let phoneCol  = findCol(PHONE_COL_RE)
            const firstCol = findCol(FIRST_COL_RE)
            const lastCol  = findCol(LAST_COL_RE)
            const nameCol  = findCol(NAME_COL_RE)
            let startRow  = 1
            if (phoneCol === -1) {
                phoneCol = 0
                // No named phone column — first row is data unless it clearly isn't a number
                startRow = normalizeGhanaPhone(header[0] ?? '') ? 0 : 1
            }

            const byPhone = new Map<string, { group_id: string; phone_number: string; first_name: string | null; last_name: string | null }>()
            let invalid = 0
            for (let i = startRow; i < lines.length; i++) {
                const cells = parseCsvLine(lines[i])
                const n = normalizeGhanaPhone(cells[phoneCol] ?? '')
                if (!n) { invalid++; continue }
                let first = firstCol >= 0 ? cleanName(cells[firstCol]) : null
                let last  = lastCol >= 0 ? cleanName(cells[lastCol]) : null
                if (!first && !last && nameCol >= 0) {
                    const parts = (cells[nameCol] ?? '').trim().split(/\s+/).filter(Boolean)
                    first = cleanName(parts[0])
                    last  = cleanName(parts.slice(1).join(' '))
                }
                if (!byPhone.has(n)) {
                    byPhone.set(n, { group_id: selected.id, phone_number: n, first_name: first, last_name: last })
                }
            }

            const rows = [...byPhone.values()]
            if (rows.length === 0) {
                toast.error('No valid Ghana numbers found in that file')
                return
            }

            // Chunked duplicate-safe inserts — 500 rows per request.
            let inserted = 0
            for (let i = 0; i < rows.length; i += 500) {
                const chunk = rows.slice(i, i + 500)
                const { data: ins, error } = await (supabase as any)
                    .from('sms_group_contacts')
                    .upsert(chunk, { onConflict: 'group_id,phone_number', ignoreDuplicates: true })
                    .select('id')
                if (error) throw error
                inserted += (ins ?? []).length
            }

            const skipped = rows.length - inserted
            toast.success(
                `Imported ${inserted} contact(s)` +
                (skipped > 0 ? `, ${skipped} already in group` : '') +
                (invalid > 0 ? `, ${invalid} invalid skipped` : ''),
            )
            setGroups(prev => prev.map(g => g.id === selected.id ? { ...g, count: g.count + inserted } : g))
            await loadContacts(selected.id)
        } catch (err) {
            console.error('[SMS Contacts] import:', err)
            toast.error('Import failed — please check the file and try again')
        } finally {
            setImporting(false)
            if (fileRef.current) fileRef.current.value = ''
        }
    }

    // ── Derived ──────────────────────────────────────────────────────────────

    const totalContacts = useMemo(() => groups.reduce((s, g) => s + g.count, 0), [groups])

    const filteredContacts = useMemo(() => {
        const q = search.trim().toLowerCase()
        if (!q) return contacts
        const qDigits = q.replace(/\D/g, '')
        return contacts.filter(c => {
            if (qDigits && (c.phone_number.includes(qDigits) || displayPhone(c.phone_number).includes(qDigits))) return true
            return contactName(c).toLowerCase().includes(q)
        })
    }, [contacts, search])

    const openCreateDialog = () => {
        setFormName('')
        setFormDesc('')
        setGroupFormError(null)
        setCreateOpen(true)
    }

    const openEditDialog = (g: GroupRow) => {
        setFormName(g.name)
        setFormDesc(g.description ?? '')
        setGroupFormError(null)
        setEditTarget(g)
    }

    // ── Shells ───────────────────────────────────────────────────────────────

    if (loading) {
        return (
            <div className="space-y-5 pb-20 md:pb-6 max-w-2xl mx-auto">
                <div className="space-y-2">
                    <Skeleton className="h-8 w-44" />
                    <Skeleton className="h-5 w-64" />
                </div>
                <Skeleton className="h-16 w-full rounded-2xl" />
                <Skeleton className="h-20 w-full rounded-2xl" />
                <Skeleton className="h-20 w-full rounded-2xl" />
                <Skeleton className="h-20 w-full rounded-2xl" />
            </div>
        )
    }

    if (loadError || !accountId) {
        return (
            <div className="max-w-md mx-auto text-center py-20 space-y-3">
                <div className="w-14 h-14 mx-auto rounded-full bg-red-50 dark:bg-red-950/30 flex items-center justify-center">
                    <AlertCircle className="w-6 h-6 text-red-500" />
                </div>
                <p className="font-semibold">Could not load your contacts</p>
                <p className="text-sm text-muted-foreground">{loadError || 'Something went wrong.'}</p>
                <Button variant="outline" className="h-10 gap-2" onClick={loadAll}>
                    <RefreshCcw className="w-4 h-4" /> Retry
                </Button>
            </div>
        )
    }

    // ── Render ───────────────────────────────────────────────────────────────

    return (
        <div className="space-y-5 pb-20 md:pb-6 max-w-2xl mx-auto">

            <AnimatePresence mode="wait" initial={false}>
                {!selected ? (
                    /* ══════════ GROUPS LIST ══════════ */
                    <motion.div
                        key="list"
                        initial={{ opacity: 0, x: -12 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -12 }}
                        transition={{ duration: 0.18 }}
                        className="space-y-5"
                    >
                        {/* Header */}
                        <div className="flex items-start justify-between gap-2">
                            <div>
                                <Link href="/dashboard/sms">
                                    <Button variant="ghost" size="sm" className="w-fit gap-2 -ml-2 text-muted-foreground hover:text-emerald-600">
                                        <ArrowLeft className="w-4 h-4" /> KFT SMS
                                    </Button>
                                </Link>
                                <h1 className="text-xl font-bold flex items-center gap-2 mt-1">
                                    <Users className="w-5 h-5 text-emerald-600" /> Contact Groups
                                </h1>
                                <p className="text-muted-foreground text-sm mt-0.5">Reusable recipient lists for your SMS campaigns.</p>
                            </div>
                            <Button
                                onClick={openCreateDialog}
                                className="h-10 shrink-0 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold gap-1.5"
                            >
                                <Plus className="w-4 h-4" /> New Group
                            </Button>
                        </div>

                        {/* Stats */}
                        {groups.length > 0 && (
                            <div className="grid grid-cols-2 gap-2">
                                <Card className="rounded-xl border-emerald-200 dark:border-emerald-900 bg-emerald-50/50 dark:bg-emerald-900/10">
                                    <CardContent className="p-3">
                                        <p className="text-[10px] sm:text-[11px] font-semibold text-muted-foreground">Groups</p>
                                        <p className="text-base font-bold tabular-nums mt-0.5">{groups.length.toLocaleString()}</p>
                                    </CardContent>
                                </Card>
                                <Card className="rounded-xl border-blue-200 dark:border-blue-900 bg-blue-50/50 dark:bg-blue-900/10">
                                    <CardContent className="p-3">
                                        <p className="text-[10px] sm:text-[11px] font-semibold text-muted-foreground">Total contacts</p>
                                        <p className="text-base font-bold tabular-nums mt-0.5">{totalContacts.toLocaleString()}</p>
                                    </CardContent>
                                </Card>
                            </div>
                        )}

                        {/* Groups */}
                        {groups.length === 0 ? (
                            <Card className="rounded-2xl border-dashed">
                                <CardContent className="py-14 text-center space-y-3">
                                    <div className="w-16 h-16 mx-auto rounded-full bg-emerald-50 dark:bg-emerald-900/20 flex items-center justify-center">
                                        <FolderPlus className="w-7 h-7 text-emerald-600" />
                                    </div>
                                    <div>
                                        <p className="font-semibold">No contact groups yet</p>
                                        <p className="text-sm text-muted-foreground mt-1 max-w-xs mx-auto">
                                            Create a group like &quot;Customers&quot; or &quot;VIP list&quot;, add numbers once, then message them in one tap from the composer.
                                        </p>
                                    </div>
                                    <Button
                                        onClick={openCreateDialog}
                                        className="h-11 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold gap-1.5"
                                    >
                                        <Plus className="w-4 h-4" /> Create your first group
                                    </Button>
                                </CardContent>
                            </Card>
                        ) : (
                            <div className="space-y-2.5">
                                {groups.map(g => (
                                    <Card key={g.id} className="rounded-2xl hover:border-emerald-300 dark:hover:border-emerald-800 transition-colors">
                                        <CardContent className="p-3 sm:p-4">
                                            <div className="flex items-center gap-3">
                                                <button
                                                    type="button"
                                                    onClick={() => openGroup(g)}
                                                    className="flex-1 min-w-0 flex items-center gap-3 text-left min-h-[48px]"
                                                >
                                                    <div className="w-10 h-10 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 flex items-center justify-center shrink-0">
                                                        <Users className="w-5 h-5 text-emerald-600" />
                                                    </div>
                                                    <div className="min-w-0">
                                                        <p className="text-sm font-semibold truncate">{g.name}</p>
                                                        <p className="text-[11px] text-muted-foreground truncate">
                                                            {g.count.toLocaleString()} contact(s)
                                                            {g.description ? ` · ${g.description}` : ''}
                                                            {' · created '}{new Date(g.created_at).toLocaleDateString()}
                                                        </p>
                                                    </div>
                                                </button>
                                                <div className="flex items-center gap-1 shrink-0">
                                                    <Button
                                                        variant="ghost" size="sm"
                                                        className="h-10 w-10 p-0 text-muted-foreground hover:text-emerald-600"
                                                        onClick={() => openEditDialog(g)}
                                                        title="Rename group"
                                                    >
                                                        <Pencil className="w-4 h-4" />
                                                    </Button>
                                                    <Button
                                                        variant="ghost" size="sm"
                                                        className="h-10 w-10 p-0 text-muted-foreground hover:text-red-600"
                                                        onClick={() => setDeleteTarget(g)}
                                                        title="Delete group"
                                                    >
                                                        <Trash2 className="w-4 h-4" />
                                                    </Button>
                                                    <button
                                                        type="button"
                                                        onClick={() => openGroup(g)}
                                                        className="h-10 w-8 flex items-center justify-center text-muted-foreground"
                                                        aria-label={`Open ${g.name}`}
                                                    >
                                                        <ChevronRight className="w-4 h-4" />
                                                    </button>
                                                </div>
                                            </div>
                                        </CardContent>
                                    </Card>
                                ))}
                            </div>
                        )}

                        {/* Composer shortcut */}
                        {groups.length > 0 && (
                            <Link href="/dashboard/sms/compose" className="block">
                                <Button variant="outline" className="w-full h-11 gap-2">
                                    <Megaphone className="w-4 h-4 text-emerald-600" /> Compose a campaign with these groups
                                </Button>
                            </Link>
                        )}
                    </motion.div>
                ) : (
                    /* ══════════ GROUP DETAIL ══════════ */
                    <motion.div
                        key={selected.id}
                        initial={{ opacity: 0, x: 12 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: 12 }}
                        transition={{ duration: 0.18 }}
                        className="space-y-4"
                    >
                        {/* Header */}
                        <div>
                            <Button
                                variant="ghost" size="sm"
                                onClick={backToList}
                                className="w-fit gap-2 -ml-2 text-muted-foreground hover:text-emerald-600"
                            >
                                <ArrowLeft className="w-4 h-4" /> All groups
                            </Button>
                            <div className="flex items-start justify-between gap-2 mt-1">
                                <div className="min-w-0">
                                    <h1 className="text-xl font-bold flex items-center gap-2 truncate">
                                        <Users className="w-5 h-5 text-emerald-600 shrink-0" />
                                        <span className="truncate">{selected.name}</span>
                                    </h1>
                                    <p className="text-muted-foreground text-sm mt-0.5">
                                        {selected.count.toLocaleString()} contact(s){selected.description ? ` · ${selected.description}` : ''}
                                    </p>
                                </div>
                                <Button
                                    variant="ghost" size="sm"
                                    className="h-10 w-10 p-0 text-muted-foreground hover:text-emerald-600 shrink-0"
                                    onClick={() => openEditDialog(selected)}
                                    title="Rename group"
                                >
                                    <Pencil className="w-4 h-4" />
                                </Button>
                            </div>
                        </div>

                        {/* Actions */}
                        <div className="grid grid-cols-2 gap-2">
                            <Button
                                variant={addOpen ? 'secondary' : 'outline'}
                                className="h-11 gap-1.5 font-semibold"
                                onClick={() => addOpen ? setAddOpen(false) : openAddForm()}
                            >
                                <UserPlus className="w-4 h-4 text-emerald-600" /> Add contact
                            </Button>
                            <Button
                                variant="outline"
                                className="h-11 gap-1.5 font-semibold"
                                disabled={importing}
                                onClick={() => fileRef.current?.click()}
                            >
                                {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4 text-emerald-600" />}
                                {importing ? 'Importing…' : 'Import CSV'}
                            </Button>
                            <input
                                ref={fileRef}
                                type="file"
                                accept=".csv,text/csv,text/plain"
                                className="hidden"
                                onChange={e => { const f = e.target.files?.[0]; if (f) handleImportFile(f) }}
                            />
                        </div>
                        <p className="text-[11px] text-muted-foreground -mt-2 flex items-center gap-1">
                            <FileText className="w-3 h-3" />
                            CSV: first column or a <code className="bg-muted px-1 rounded">phone</code> column; optional <code className="bg-muted px-1 rounded">first_name</code> / <code className="bg-muted px-1 rounded">last_name</code>. Duplicates are skipped.
                        </p>

                        {/* Add-single form */}
                        <AnimatePresence initial={false}>
                            {addOpen && (
                                <motion.div
                                    initial={{ opacity: 0, height: 0 }}
                                    animate={{ opacity: 1, height: 'auto' }}
                                    exit={{ opacity: 0, height: 0 }}
                                    transition={{ duration: 0.18 }}
                                    className="overflow-hidden"
                                >
                                    <Card className="rounded-2xl border-emerald-200 dark:border-emerald-900">
                                        <CardContent className="p-4 space-y-2.5">
                                            <p className="text-xs font-semibold flex items-center gap-1.5">
                                                <UserPlus className="w-3.5 h-3.5 text-emerald-600" /> New contact
                                            </p>
                                            <Input
                                                ref={addPhoneRef}
                                                value={addPhone}
                                                onChange={e => { setContactFormError(null); setAddPhone(e.target.value.replace(/[^0-9+\s\-]/g, '').slice(0, 15)) }}
                                                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddContact() } }}
                                                placeholder="Phone (required), e.g. 0244123456"
                                                className="h-11 font-mono text-sm"
                                                inputMode="tel"
                                                autoComplete="off"
                                            />
                                            {contactFormError && (
                                                <p className="text-[11px] text-red-600 font-medium flex items-start gap-1">
                                                    <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-px" /> {contactFormError}
                                                </p>
                                            )}
                                            <div className="grid grid-cols-2 gap-2">
                                                <Input
                                                    value={addFirst}
                                                    onChange={e => setAddFirst(e.target.value.slice(0, 60))}
                                                    placeholder="First name (optional)"
                                                    className="h-11"
                                                    autoComplete="off"
                                                />
                                                <Input
                                                    value={addLast}
                                                    onChange={e => setAddLast(e.target.value.slice(0, 60))}
                                                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddContact() } }}
                                                    placeholder="Last name (optional)"
                                                    className="h-11"
                                                    autoComplete="off"
                                                />
                                            </div>
                                            <div className="flex gap-2">
                                                <Button
                                                    onClick={handleAddContact}
                                                    disabled={savingContact || !addPhone.trim()}
                                                    className="flex-1 h-11 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold gap-1.5"
                                                >
                                                    {savingContact ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                                                    Add to group
                                                </Button>
                                                <Button variant="ghost" className="h-11" onClick={() => setAddOpen(false)}>
                                                    Done
                                                </Button>
                                            </div>
                                        </CardContent>
                                    </Card>
                                </motion.div>
                            )}
                        </AnimatePresence>

                        {/* Search */}
                        {contacts.length > 0 && (
                            <div className="relative">
                                <Search className="w-4 h-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
                                <Input
                                    value={search}
                                    onChange={e => setSearch(e.target.value.slice(0, 60))}
                                    placeholder="Search name or number…"
                                    className="h-11 pl-9 pr-9"
                                    autoComplete="off"
                                />
                                {search && (
                                    <button
                                        type="button"
                                        onClick={() => setSearch('')}
                                        className="absolute right-1 top-1/2 -translate-y-1/2 h-10 w-10 flex items-center justify-center text-muted-foreground hover:text-foreground"
                                        aria-label="Clear search"
                                    >
                                        <X className="w-4 h-4" />
                                    </button>
                                )}
                            </div>
                        )}

                        {/* Contacts */}
                        <Card className="rounded-2xl overflow-hidden">
                            <CardContent className="p-0">
                                <div className="px-4 py-3 border-b flex items-center justify-between">
                                    <h3 className="text-sm font-semibold flex items-center gap-1.5">
                                        <Phone className="w-4 h-4 text-emerald-500" /> Contacts
                                    </h3>
                                    <span className="text-[11px] text-muted-foreground tabular-nums">
                                        {search
                                            ? `${filteredContacts.length.toLocaleString()} of ${contacts.length.toLocaleString()}`
                                            : contacts.length.toLocaleString()}
                                    </span>
                                </div>

                                {contactsLoading ? (
                                    <div className="p-4 space-y-2.5">
                                        <Skeleton className="h-12 w-full rounded-xl" />
                                        <Skeleton className="h-12 w-full rounded-xl" />
                                        <Skeleton className="h-12 w-full rounded-xl" />
                                    </div>
                                ) : contacts.length === 0 ? (
                                    <div className="py-12 text-center space-y-3">
                                        <div className="w-14 h-14 mx-auto rounded-full bg-muted flex items-center justify-center">
                                            <UserPlus className="w-6 h-6 text-muted-foreground" />
                                        </div>
                                        <div>
                                            <p className="text-sm font-semibold">No contacts in this group yet</p>
                                            <p className="text-xs text-muted-foreground mt-1">Add a number above or import a CSV file.</p>
                                        </div>
                                    </div>
                                ) : filteredContacts.length === 0 ? (
                                    <div className="py-10 text-center space-y-2">
                                        <Search className="w-6 h-6 mx-auto text-muted-foreground" />
                                        <p className="text-xs text-muted-foreground">No contact matches &quot;{search}&quot;.</p>
                                    </div>
                                ) : (
                                    <div className="divide-y max-h-[60vh] overflow-y-auto">
                                        {filteredContacts.map(c => (
                                            <div key={c.id} className="px-4 py-2.5 flex items-center gap-3 min-h-[56px]">
                                                <div className="w-9 h-9 rounded-full bg-emerald-50 dark:bg-emerald-900/20 flex items-center justify-center shrink-0">
                                                    <span className="text-[11px] font-bold text-emerald-700 dark:text-emerald-400">{initialsOf(c)}</span>
                                                </div>
                                                <div className="flex-1 min-w-0">
                                                    <p className="text-xs font-semibold truncate">
                                                        {contactName(c) || <span className="text-muted-foreground font-normal italic">No name</span>}
                                                    </p>
                                                    <p className="text-[11px] text-muted-foreground font-mono">{displayPhone(c.phone_number)}</p>
                                                </div>
                                                <Button
                                                    variant="ghost" size="sm"
                                                    className="h-10 w-10 p-0 text-muted-foreground hover:text-red-600 shrink-0"
                                                    onClick={() => handleDeleteContact(c)}
                                                    disabled={deletingContactId === c.id}
                                                    title={`Remove ${displayPhone(c.phone_number)}`}
                                                >
                                                    {deletingContactId === c.id
                                                        ? <Loader2 className="w-4 h-4 animate-spin" />
                                                        : <Trash2 className="w-4 h-4" />}
                                                </Button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </CardContent>
                        </Card>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* ── Create group dialog ── */}
            <Dialog open={createOpen} onOpenChange={open => { setCreateOpen(open); if (!open) setGroupFormError(null) }}>
                <DialogContent className="max-w-sm" aria-describedby={undefined}>
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <FolderPlus className="w-4 h-4 text-emerald-600" /> New Contact Group
                        </DialogTitle>
                    </DialogHeader>
                    <div className="space-y-3">
                        <div>
                            <label className="text-xs font-semibold text-muted-foreground block mb-1">Group name</label>
                            <Input
                                value={formName}
                                onChange={e => setFormName(e.target.value.slice(0, 80))}
                                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleCreateGroup() } }}
                                placeholder="e.g. My Customers"
                                maxLength={80}
                                className="h-11"
                                autoComplete="off"
                            />
                            <p className="text-[10px] text-muted-foreground/60 mt-0.5">{formName.length}/80</p>
                        </div>
                        <div>
                            <label className="text-xs font-semibold text-muted-foreground block mb-1">Description (optional)</label>
                            <Textarea
                                value={formDesc}
                                onChange={e => setFormDesc(e.target.value.slice(0, 200))}
                                placeholder="What is this list for?"
                                rows={2}
                                maxLength={200}
                                className="resize-none"
                            />
                        </div>
                        {groupFormError && (
                            <p className="text-[11px] text-red-600 font-medium flex items-start gap-1">
                                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-px" /> {groupFormError}
                            </p>
                        )}
                    </div>
                    <DialogFooter className="gap-2">
                        <Button variant="ghost" className="h-10" onClick={() => setCreateOpen(false)}>Cancel</Button>
                        <Button
                            onClick={handleCreateGroup}
                            disabled={savingGroup || !formName.trim()}
                            className="h-10 bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5"
                        >
                            {savingGroup ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                            Create Group
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* ── Rename group dialog ── */}
            <Dialog open={!!editTarget} onOpenChange={open => { if (!open) { setEditTarget(null); setGroupFormError(null) } }}>
                <DialogContent className="max-w-sm" aria-describedby={undefined}>
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <Pencil className="w-4 h-4 text-emerald-600" /> Edit Group
                        </DialogTitle>
                    </DialogHeader>
                    <div className="space-y-3">
                        <div>
                            <label className="text-xs font-semibold text-muted-foreground block mb-1">Group name</label>
                            <Input
                                value={formName}
                                onChange={e => setFormName(e.target.value.slice(0, 80))}
                                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleRenameGroup() } }}
                                maxLength={80}
                                className="h-11"
                                autoComplete="off"
                            />
                        </div>
                        <div>
                            <label className="text-xs font-semibold text-muted-foreground block mb-1">Description (optional)</label>
                            <Textarea
                                value={formDesc}
                                onChange={e => setFormDesc(e.target.value.slice(0, 200))}
                                rows={2}
                                maxLength={200}
                                className="resize-none"
                            />
                        </div>
                        {groupFormError && (
                            <p className="text-[11px] text-red-600 font-medium flex items-start gap-1">
                                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-px" /> {groupFormError}
                            </p>
                        )}
                    </div>
                    <DialogFooter className="gap-2">
                        <Button variant="ghost" className="h-10" onClick={() => setEditTarget(null)}>Cancel</Button>
                        <Button
                            onClick={handleRenameGroup}
                            disabled={savingGroup || !formName.trim()}
                            className="h-10 bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5"
                        >
                            {savingGroup ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Pencil className="w-3.5 h-3.5" />}
                            Save Changes
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* ── Delete group confirm ── */}
            <Dialog open={!!deleteTarget} onOpenChange={open => { if (!open && !deletingGroup) setDeleteTarget(null) }}>
                <DialogContent className="max-w-sm" aria-describedby={undefined}>
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2 text-red-600">
                            <Trash2 className="w-4 h-4" /> Delete Group?
                        </DialogTitle>
                    </DialogHeader>
                    {deleteTarget && (
                        <div className="space-y-3">
                            <p className="text-sm">
                                Delete <strong>&quot;{deleteTarget.name}&quot;</strong> and its{' '}
                                <strong>{deleteTarget.count.toLocaleString()} contact(s)</strong>?
                            </p>
                            <div className="flex items-start gap-2 p-3 rounded-xl bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-400">
                                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                                <span>This cannot be undone. Past campaigns are not affected.</span>
                            </div>
                        </div>
                    )}
                    <DialogFooter className="gap-2">
                        <Button variant="ghost" className="h-10" onClick={() => setDeleteTarget(null)} disabled={deletingGroup}>
                            Cancel
                        </Button>
                        <Button
                            onClick={handleDeleteGroup}
                            disabled={deletingGroup}
                            className="h-10 bg-red-600 hover:bg-red-700 text-white gap-1.5"
                        >
                            {deletingGroup ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                            Delete Group
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
