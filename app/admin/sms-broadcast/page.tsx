'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
    Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog'
import {
    Loader2, Send, MessageSquare, Users, Search, CheckSquare, XSquare,
    Plus, Trash2, Pencil, Upload, Download, Settings2, Eye, Copy,
    BookTemplate, Folder, FolderOpen, UserPlus, ToggleLeft, ToggleRight,
    ChevronRight, AlertTriangle, CheckCircle2, X,
    ShieldCheck, ShieldAlert, ShieldX,
} from 'lucide-react'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

interface AppUser {
    id: string; first_name: string; last_name: string
    phone_number: string; role: string; email: string
    phone_verified: boolean
}

interface SmsGroup {
    id: string; name: string; description?: string
    contact_count: number; created_at: string
}

interface SmsContact {
    id: string; first_name: string | null; last_name: string | null
    phone_number: string; created_at: string
}

interface SmsTemplate {
    id: string; name: string; body: string
    created_at: string; updated_at: string
}

type SmsProvider = 'hubtel' | 'moolre' | 'mnotify'

const PROVIDER_META: Record<SmsProvider, { label: string; color: string; description: string }> = {
    hubtel:  { label: 'Hubtel',  color: 'bg-emerald-500', description: 'Direct Telco connections — highest delivery rate' },
    moolre:  { label: 'Moolre',  color: 'bg-blue-500',    description: 'Reliable Ghanaian SMS gateway' },
    mnotify: { label: 'mNotify', color: 'bg-violet-500',  description: 'Fast delivery across all networks' },
}

const ALL_PROVIDERS: SmsProvider[] = ['hubtel', 'moolre', 'mnotify']

const VARIABLES = [
    { label: '[FirstName]', desc: "Recipient's first name" },
    { label: '[LastName]',  desc: "Recipient's last name" },
    { label: '[Phone]',     desc: "Recipient's phone number" },
]

const SMS_PAGE_SIZE = 160

// ─── Helper: CSV Template ─────────────────────────────────────────────────────
function downloadCsvTemplate() {
    const csv = 'first_name,last_name,phone_number\nKwame,Asante,0244000001\nEfua,Mensah,0551000002'
    const blob = new Blob([csv], { type: 'text/csv' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url; a.download = 'sms_contacts_template.csv'
    a.click(); URL.revokeObjectURL(url)
}

// ─── Helper: Parse CSV ────────────────────────────────────────────────────────
function parseCsv(text: string): Array<{ first_name: string; last_name: string; phone_number: string }> {
    const lines  = text.trim().split(/\r?\n/)
    if (lines.length < 2) return []
    const header = lines[0].toLowerCase().split(',').map(h => h.trim())
    const fi = header.indexOf('first_name')
    const li = header.indexOf('last_name')
    const pi = header.indexOf('phone_number')
    if (pi === -1) return []
    return lines.slice(1).map(line => {
        const cols = line.split(',').map(c => c.trim().replace(/^"|"$/g, ''))
        return {
            first_name:   fi !== -1 ? (cols[fi] || '') : '',
            last_name:    li !== -1 ? (cols[li] || '') : '',
            phone_number: cols[pi] || '',
        }
    }).filter(r => r.phone_number)
}

// ─── Role Badge ───────────────────────────────────────────────────────────────
function RoleBadge({ role }: { role: string }) {
    const color = role === 'admin' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
        : role === 'sub-admin'     ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400'
        : role === 'dealer'        ? 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400'
        : role === 'agent'         ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
        : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
    return <span className={cn('text-[10px] font-semibold px-1.5 py-0.5 rounded-full', color)}>{role}</span>
}

// ─── Message Composer ─────────────────────────────────────────────────────────
function MessageComposer({
    value, onChange, templates, onInsertVariable,
}: {
    value: string
    onChange: (v: string) => void
    templates: SmsTemplate[]
    onInsertVariable: (v: string) => void
}) {
    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const charCount = value.length
    const smsCount  = Math.ceil(charCount / SMS_PAGE_SIZE) || 1

    const handleTemplateSelect = (id: string) => {
        const t = templates.find(t => t.id === id)
        if (t) { onChange(t.body); toast.info(`Loaded template: ${t.name}`) }
    }

    const insertAtCursor = (variable: string) => {
        const el = textareaRef.current
        if (!el) { onChange(value + variable); return }
        const start = el.selectionStart ?? value.length
        const end   = el.selectionEnd   ?? value.length
        const next  = value.slice(0, start) + variable + value.slice(end)
        onChange(next)
        setTimeout(() => {
            el.selectionStart = el.selectionEnd = start + variable.length
            el.focus()
        }, 0)
    }

    return (
        <div className="space-y-3">
            {/* Template loader */}
            {templates.length > 0 && (
                <Select onValueChange={handleTemplateSelect}>
                    <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="⚡ Load a saved template…" />
                    </SelectTrigger>
                    <SelectContent>
                        {templates.map(t => (
                            <SelectItem key={t.id} value={t.id} className="text-xs">
                                <span className="font-medium">{t.name}</span>
                                <span className="ml-2 text-muted-foreground truncate hidden sm:inline">
                                    — {t.body.substring(0, 40)}{t.body.length > 40 ? '…' : ''}
                                </span>
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            )}

            {/* Variable quick-insert */}
            <div className="flex flex-wrap gap-1.5">
                {VARIABLES.map(v => (
                    <button
                        key={v.label}
                        type="button"
                        title={v.desc}
                        onClick={() => insertAtCursor(v.label)}
                        className="text-[10px] font-mono px-2 py-0.5 rounded border border-dashed border-violet-400 text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-500/10 transition-colors"
                    >
                        {v.label}
                    </button>
                ))}
            </div>

            {/* Textarea */}
            <Textarea
                ref={textareaRef}
                id="sms-message"
                placeholder="Type your SMS message here… Use [FirstName] for personalization."
                className="min-h-[140px] resize-none font-mono text-sm"
                value={value}
                onChange={e => onChange(e.target.value)}
                maxLength={480}
            />
            <div className="flex justify-between text-[11px] text-muted-foreground">
                <span className={charCount > 400 ? 'text-amber-500 font-medium' : ''}>{charCount}/480 chars</span>
                <span className={smsCount > 1 ? 'text-amber-500 font-medium' : ''}>{smsCount} SMS unit{smsCount > 1 ? 's' : ''}</span>
            </div>
        </div>
    )
}

// ─── Live Preview ─────────────────────────────────────────────────────────────
function LivePreview({ message, sampleName }: { message: string; sampleName: string }) {
    const preview = message
        .replace(/\[FirstName\]/gi, sampleName || 'Kwame')
        .replace(/\[LastName\]/gi,  'Asante')
        .replace(/\[Phone\]/gi,     '0244000001')

    return (
        <div className="rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
            <div className="px-4 py-2 bg-slate-100 dark:bg-slate-800 flex items-center gap-2">
                <Eye className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="text-xs font-semibold text-muted-foreground">Live Preview</span>
                {/\[(FirstName|LastName|Phone)\]/i.test(message) && (
                    <span className="ml-auto text-[10px] text-violet-500 font-medium">✦ Personalized</span>
                )}
            </div>
            <div className="p-4 min-h-[80px]">
                {preview ? (
                    <div className="inline-block max-w-xs bg-slate-800 dark:bg-slate-700 text-white rounded-2xl rounded-tl-sm px-4 py-3 text-sm leading-relaxed shadow">
                        {preview}
                    </div>
                ) : (
                    <p className="text-sm text-muted-foreground italic">Your message preview will appear here…</p>
                )}
            </div>
        </div>
    )
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════════════════════

export default function AdminSMSBroadcastPage() {

    // ── Shared state ──────────────────────────────────────────────────────────
    const [templates, setTemplates]   = useState<SmsTemplate[]>([])
    const [activeTab, setActiveTab]   = useState('broadcast')

    // ── Tab 1: Broadcast ──────────────────────────────────────────────────────
    const [audience, setAudience]     = useState<'users' | 'group'>('users')
    const [message, setMessage]       = useState('')
    const [sending, setSending]       = useState(false)
    const [lastResult, setLastResult] = useState<{ sent: number; failed: number; total: number } | null>(null)

    // Users audience
    const [appUsers, setAppUsers]         = useState<AppUser[]>([])
    const [filteredUsers, setFilteredUsers] = useState<AppUser[]>([])
    const [selectedUsers, setSelectedUsers] = useState<Set<string>>(new Set())
    const [loadingUsers, setLoadingUsers]   = useState(false)
    const [searchQuery, setSearchQuery]     = useState('')
    const [roleFilter, setRoleFilter]       = useState('all')
    const [verifiedFilter, setVerifiedFilter] = useState('all')

    // Group audience
    const [groups, setGroups]           = useState<SmsGroup[]>([])
    const [selectedGroupId, setSelectedGroupId] = useState<string>('')
    const [groupContacts, setGroupContacts]     = useState<SmsContact[]>([])
    const [loadingGroups, setLoadingGroups]     = useState(false)

    // ── Tab 2: Contacts & Groups ──────────────────────────────────────────────
    const [cgGroups, setCgGroups]         = useState<SmsGroup[]>([])
    const [cgOpenGroupId, setCgOpenGroupId] = useState<string | null>(null)
    const [cgContacts, setCgContacts]     = useState<SmsContact[]>([])
    const [cgLoading, setCgLoading]       = useState(false)
    const [cgContactsLoading, setCgContactsLoading] = useState(false)

    // Create group dialog
    const [showCreateGroup, setShowCreateGroup]     = useState(false)
    const [newGroupName, setNewGroupName]           = useState('')
    const [newGroupDesc, setNewGroupDesc]           = useState('')
    const [savingGroup, setSavingGroup]             = useState(false)

    // Add contact dialog
    const [showAddContact, setShowAddContact]       = useState(false)
    const [contactFirstName, setContactFirstName]   = useState('')
    const [contactLastName, setContactLastName]     = useState('')
    const [contactPhone, setContactPhone]           = useState('')
    const [savingContact, setSavingContact]         = useState(false)

    // MoMo verification
    type VerifyStatus = 'idle' | 'loading' | 'verified' | 'unverified' | 'invalid'
    const [verifyStatus, setVerifyStatus]   = useState<VerifyStatus>('idle')
    const [verifiedName, setVerifiedName]   = useState('')
    const [verifiedNetwork, setVerifiedNetwork] = useState('')

    // CSV upload
    const [csvUploading, setCsvUploading]           = useState(false)
    const [enrichNames, setEnrichNames]             = useState(false)
    const csvInputRef = useRef<HTMLInputElement>(null)

    // Delete confirm
    const [deleteTarget, setDeleteTarget] = useState<{ type: 'group' | 'contact'; id: string; label: string } | null>(null)
    const [deleting, setDeleting]         = useState(false)

    // ── Tab 3: Templates ──────────────────────────────────────────────────────
    const [tplLoading, setTplLoading]     = useState(false)
    const [showTplDialog, setShowTplDialog] = useState(false)
    const [editTpl, setEditTpl]           = useState<SmsTemplate | null>(null)
    const [tplName, setTplName]           = useState('')
    const [tplBody, setTplBody]           = useState('')
    const [savingTpl, setSavingTpl]       = useState(false)

    // ── Tab 4: Provider Settings ──────────────────────────────────────────────
    const [primary, setPrimary]         = useState<SmsProvider>('hubtel')
    const [fallbacks, setFallbacks]     = useState<SmsProvider[]>(['moolre', 'mnotify'])
    const [savingSettings, setSavingSettings] = useState(false)
    const [settingsLoading, setSettingsLoading] = useState(true)

    // ── Initial loads ─────────────────────────────────────────────────────────
    useEffect(() => { fetchTemplates() }, [])
    useEffect(() => { fetchProviderSettings() }, [])
    useEffect(() => { if (activeTab === 'broadcast' && audience === 'users') fetchAppUsers() }, [activeTab, audience])
    useEffect(() => { if (activeTab === 'broadcast' && audience === 'group') fetchGroups() }, [activeTab, audience])
    useEffect(() => { if (activeTab === 'contacts') fetchCgGroups() }, [activeTab])

    // ── Filter users ──────────────────────────────────────────────────────────
    useEffect(() => {
        let f = [...appUsers]
        if (roleFilter !== 'all') f = f.filter(u => u.role === roleFilter)
        if (verifiedFilter === 'verified') f = f.filter(u => u.phone_verified)
        if (verifiedFilter === 'unverified') f = f.filter(u => !u.phone_verified)
        if (searchQuery.trim()) {
            const q = searchQuery.toLowerCase()
            f = f.filter(u =>
                u.first_name?.toLowerCase().includes(q) ||
                u.last_name?.toLowerCase().includes(q)  ||
                u.phone_number?.includes(q)             ||
                u.email?.toLowerCase().includes(q)
            )
        }
        setFilteredUsers(f)
    }, [appUsers, searchQuery, roleFilter, verifiedFilter])

    // ── Load group contacts when group selected in broadcast tab ──────────────
    useEffect(() => {
        if (audience === 'group' && selectedGroupId) fetchGroupContactsForBroadcast(selectedGroupId)
        else setGroupContacts([])
    }, [selectedGroupId, audience])

    // ─── Fetch functions ──────────────────────────────────────────────────────
    const fetchAppUsers = async () => {
        setLoadingUsers(true)
        try {
            const res  = await fetch('/api/admin/sms-broadcast/users')
            const data = await res.json()
            if (!res.ok) throw new Error(data.error)
            setAppUsers(data.users || [])
        } catch (e: any) { toast.error('Failed to load users: ' + e.message) }
        finally { setLoadingUsers(false) }
    }

    const fetchGroups = async () => {
        setLoadingGroups(true)
        try {
            const res  = await fetch('/api/admin/sms-groups')
            const data = await res.json()
            if (!res.ok) throw new Error(data.error)
            setGroups(data.groups || [])
        } catch (e: any) { toast.error('Failed to load groups: ' + e.message) }
        finally { setLoadingGroups(false) }
    }

    const fetchGroupContactsForBroadcast = async (id: string) => {
        try {
            const res  = await fetch(`/api/admin/sms-groups/${id}`)
            const data = await res.json()
            if (!res.ok) throw new Error(data.error)
            setGroupContacts(data.contacts || [])
        } catch { setGroupContacts([]) }
    }

    const fetchTemplates = async () => {
        setTplLoading(true)
        try {
            const res  = await fetch('/api/admin/sms-templates')
            const data = await res.json()
            if (!res.ok) throw new Error(data.error)
            setTemplates(data.templates || [])
        } catch (e: any) { toast.error('Failed to load templates: ' + e.message) }
        finally { setTplLoading(false) }
    }

    const fetchCgGroups = async () => {
        setCgLoading(true)
        try {
            const res  = await fetch('/api/admin/sms-groups')
            const data = await res.json()
            if (!res.ok) throw new Error(data.error)
            setCgGroups(data.groups || [])
        } catch (e: any) { toast.error('Failed to load groups: ' + e.message) }
        finally { setCgLoading(false) }
    }

    const fetchCgContacts = async (id: string) => {
        setCgContactsLoading(true)
        try {
            const res  = await fetch(`/api/admin/sms-groups/${id}`)
            const data = await res.json()
            if (!res.ok) throw new Error(data.error)
            setCgContacts(data.contacts || [])
        } catch (e: any) { toast.error('Failed to load contacts: ' + e.message) }
        finally { setCgContactsLoading(false) }
    }

    const fetchProviderSettings = async () => {
        setSettingsLoading(true)
        try {
            const res  = await fetch('/api/admin/sms-settings')
            const data = await res.json()
            if (!res.ok) throw new Error(data.error)
            setPrimary(data.primary || 'hubtel')
            setFallbacks(data.fallbacks || [])
        } catch { /* use defaults */ }
        finally { setSettingsLoading(false) }
    }

    // ─── Broadcast Send ───────────────────────────────────────────────────────
    const handleSend = async () => {
        if (!message.trim()) { toast.error('Please enter a message'); return }
        if (audience === 'users' && selectedUsers.size === 0) { toast.error('Select at least one recipient'); return }
        if (audience === 'group' && !selectedGroupId) { toast.error('Select a contact group'); return }
        if (audience === 'group' && groupContacts.length === 0) { toast.error('Selected group has no contacts'); return }

        setSending(true); setLastResult(null)
        try {
            const payload: any = { message: message.trim(), audience }
            if (audience === 'users') payload.userIds  = Array.from(selectedUsers)
            else                       payload.groupId  = selectedGroupId

            const res  = await fetch('/api/admin/sms-broadcast', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error)

            const { sent, failed, total } = data.results
            setLastResult({ sent, failed, total })
            toast.success(`✅ Sent ${sent}/${total} messages via batch API`)
            if (failed > 0) toast.warning(`${failed} message(s) failed — check errors`)
            setMessage(''); setSelectedUsers(new Set()); setSelectedGroupId('')
        } catch (e: any) {
            toast.error(e.message || 'Failed to send SMS')
        } finally { setSending(false) }
    }

    // ─── Create Group ─────────────────────────────────────────────────────────
    const handleCreateGroup = async () => {
        if (!newGroupName.trim()) { toast.error('Group name is required'); return }
        setSavingGroup(true)
        try {
            const res  = await fetch('/api/admin/sms-groups', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newGroupName.trim(), description: newGroupDesc.trim() }),
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error)
            toast.success(`Group "${data.group.name}" created`)
            setShowCreateGroup(false); setNewGroupName(''); setNewGroupDesc('')
            fetchCgGroups()
        } catch (e: any) { toast.error(e.message) }
        finally { setSavingGroup(false) }
    }

    // ─── Add Single Contact ───────────────────────────────────────────────────
    const handleAddContact = async () => {
        if (!contactPhone.trim()) { toast.error('Phone number is required'); return }
        if (!cgOpenGroupId) { toast.error('Open a group first'); return }
        setSavingContact(true)
        try {
            const res = await fetch('/api/admin/sms-contacts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    group_id: cgOpenGroupId,
                    contact: { first_name: contactFirstName, last_name: contactLastName, phone_number: contactPhone },
                }),
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error)
            toast.success('Contact added')
            setShowAddContact(false)
            setContactFirstName(''); setContactLastName(''); setContactPhone('')
            setVerifyStatus('idle'); setVerifiedName(''); setVerifiedNetwork('')
            fetchCgContacts(cgOpenGroupId); fetchCgGroups()
        } catch (e: any) { toast.error(e.message) }
        finally { setSavingContact(false) }
    }

    // ─── MoMo Phone Verification ──────────────────────────────────────────────
    const verifyContactPhone = async (phone: string) => {
        const trimmed = phone.trim()
        if (!trimmed) { setVerifyStatus('idle'); return }
        // Only trigger if looks like a possible Ghana number
        const digits = trimmed.replace(/[\s\-+]/g, '')
        if (digits.length < 9) { setVerifyStatus('idle'); return }

        setVerifyStatus('loading')
        setVerifiedName(''); setVerifiedNetwork('')
        try {
            const res  = await fetch(`/api/admin/sms-contacts/verify?phone=${encodeURIComponent(trimmed)}`)
            const data = await res.json()
            if (!res.ok) { setVerifyStatus('unverified'); return }

            if (data.error?.toLowerCase().includes('invalid')) {
                setVerifyStatus('invalid')
            } else if (data.valid && data.name) {
                setVerifyStatus('verified')
                setVerifiedName(data.name)
                setVerifiedNetwork(data.network || '')
                // Auto-fill name fields if both are still empty
                if (!contactFirstName.trim() && !contactLastName.trim()) {
                    const parts = data.name.trim().split(/\s+/)
                    setContactFirstName(parts[0] ?? '')
                    setContactLastName(parts.slice(1).join(' '))
                }
            } else {
                setVerifyStatus('unverified')
                setVerifiedNetwork(data.network || '')
            }
        } catch {
            setVerifyStatus('unverified')
        }
    }

    const resetContactDialog = () => {
        setShowAddContact(false)
        setContactFirstName(''); setContactLastName(''); setContactPhone('')
        setVerifyStatus('idle'); setVerifiedName(''); setVerifiedNetwork('')
    }

    // ─── CSV Upload ───────────────────────────────────────────────────────────
    const handleCsvUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (!file || !cgOpenGroupId) return
        if (!file.name.endsWith('.csv')) { toast.error('Please upload a .csv file'); return }
        setCsvUploading(true)
        try {
            const text = await file.text()
            const rows = parseCsv(text)
            if (rows.length === 0) { toast.error('No valid rows found in CSV'); return }

            const res = await fetch('/api/admin/sms-contacts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ group_id: cgOpenGroupId, rows, enrichNames }),
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error)

            const parts: string[] = [`Imported ${data.inserted} contacts`]
            if (data.enriched > 0) {
                const byProvider = Object.entries(data.providers_used || {})
                    .map(([p, n]) => `${n} via ${p}`)
                    .join(', ')
                parts.push(`${data.enriched} names resolved (${byProvider})`)
            }
            if (data.enrich_cap_hit) parts.push(`first ${data.enrich_cap} enriched — cap reached`)
            if (data.skipped_count > 0) parts.push(`${data.skipped_count} skipped — invalid numbers`)
            toast.success(parts.join(' · '))
            fetchCgContacts(cgOpenGroupId); fetchCgGroups()
        } catch (e: any) { toast.error(e.message) }
        finally { setCsvUploading(false); if (csvInputRef.current) csvInputRef.current.value = '' }
    }

    // ─── Delete Handler ───────────────────────────────────────────────────────
    const handleDelete = async () => {
        if (!deleteTarget) return
        setDeleting(true)
        try {
            const url = deleteTarget.type === 'group'
                ? `/api/admin/sms-groups/${deleteTarget.id}`
                : `/api/admin/sms-contacts/${deleteTarget.id}`
            const res = await fetch(url, { method: 'DELETE' })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error)
            toast.success(`${deleteTarget.type === 'group' ? 'Group' : 'Contact'} deleted`)
            setDeleteTarget(null)
            if (deleteTarget.type === 'group') {
                fetchCgGroups()
                if (cgOpenGroupId === deleteTarget.id) { setCgOpenGroupId(null); setCgContacts([]) }
            } else {
                if (cgOpenGroupId) { fetchCgContacts(cgOpenGroupId); fetchCgGroups() }
            }
        } catch (e: any) { toast.error(e.message) }
        finally { setDeleting(false) }
    }

    // ─── Template CRUD ────────────────────────────────────────────────────────
    const openNewTemplate = () => {
        setEditTpl(null); setTplName(''); setTplBody('')
        setShowTplDialog(true)
    }

    const openEditTemplate = (t: SmsTemplate) => {
        setEditTpl(t); setTplName(t.name); setTplBody(t.body)
        setShowTplDialog(true)
    }

    const handleSaveTemplate = async () => {
        if (!tplName.trim()) { toast.error('Template name is required'); return }
        if (!tplBody.trim()) { toast.error('Template body is required'); return }
        setSavingTpl(true)
        try {
            const url    = editTpl ? `/api/admin/sms-templates/${editTpl.id}` : '/api/admin/sms-templates'
            const method = editTpl ? 'PATCH' : 'POST'
            const res    = await fetch(url, {
                method, headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: tplName.trim(), body: tplBody.trim() }),
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error)
            toast.success(editTpl ? 'Template updated' : 'Template saved')
            setShowTplDialog(false); fetchTemplates()
        } catch (e: any) { toast.error(e.message) }
        finally { setSavingTpl(false) }
    }

    const handleDeleteTemplate = async (t: SmsTemplate) => {
        if (!confirm(`Delete template "${t.name}"?`)) return
        try {
            const res = await fetch(`/api/admin/sms-templates/${t.id}`, { method: 'DELETE' })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error)
            toast.success('Template deleted'); fetchTemplates()
        } catch (e: any) { toast.error(e.message) }
    }

    // ─── Provider Settings ────────────────────────────────────────────────────
    const handleSaveProviderSettings = async () => {
        setSavingSettings(true)
        try {
            const res = await fetch('/api/admin/sms-settings', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ primary, fallbacks }),
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error)
            setFallbacks(data.fallbacks)
            toast.success('Provider settings saved — changes take effect immediately')
        } catch (e: any) { toast.error(e.message) }
        finally { setSavingSettings(false) }
    }

    const toggleFallback = (p: SmsProvider) => {
        if (p === primary) return
        setFallbacks(prev => prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p])
    }

    // ─── Recipient count for broadcast summary ────────────────────────────────
    const recipientCount = audience === 'users' ? selectedUsers.size : groupContacts.length

    // ─────────────────────────────────────────────────────────────────────────
    // RENDER
    // ─────────────────────────────────────────────────────────────────────────
    return (
        <div className="space-y-6 max-w-6xl">

            {/* Header */}
            <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-violet-600 to-indigo-600 flex items-center justify-center shadow-lg flex-shrink-0">
                    <MessageSquare className="w-6 h-6 text-white" />
                </div>
                <div>
                    <h1 className="text-xl font-black tracking-tight">SMS Centre</h1>
                    <p className="text-sm text-muted-foreground">Broadcast messages, manage contacts & configure providers</p>
                </div>
            </div>

            <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList className="h-auto flex-wrap gap-1">
                    <TabsTrigger value="broadcast" className="gap-1.5 text-xs">
                        <Send className="w-3.5 h-3.5" /> Broadcast
                    </TabsTrigger>
                    <TabsTrigger value="contacts" className="gap-1.5 text-xs">
                        <Users className="w-3.5 h-3.5" /> Contacts &amp; Groups
                    </TabsTrigger>
                    <TabsTrigger value="templates" className="gap-1.5 text-xs">
                        <BookTemplate className="w-3.5 h-3.5" /> Templates
                    </TabsTrigger>
                    <TabsTrigger value="settings" className="gap-1.5 text-xs">
                        <Settings2 className="w-3.5 h-3.5" /> Providers
                    </TabsTrigger>
                </TabsList>

                {/* ═══════════════════════════════════════════════════════════ */}
                {/* TAB 1: BROADCAST                                           */}
                {/* ═══════════════════════════════════════════════════════════ */}
                <TabsContent value="broadcast" className="mt-4 space-y-4">
                    <div className="grid gap-4 xl:grid-cols-[1fr_420px]">

                        {/* Left: Compose + Preview */}
                        <div className="space-y-4">
                            <Card>
                                <CardHeader className="pb-3">
                                    <CardTitle className="flex items-center gap-2 text-base">
                                        <MessageSquare className="w-4 h-4 text-violet-500" />
                                        Compose Message
                                    </CardTitle>
                                    <CardDescription>Use [FirstName], [LastName], or [Phone] for personalization</CardDescription>
                                </CardHeader>
                                <CardContent>
                                    <MessageComposer
                                        value={message}
                                        onChange={setMessage}
                                        templates={templates}
                                        onInsertVariable={() => {}}
                                    />
                                </CardContent>
                            </Card>

                            <LivePreview message={message} sampleName="Kwame" />

                            {/* Send summary + button */}
                            <Card className="border-violet-200 dark:border-violet-500/20 bg-violet-50/40 dark:bg-violet-500/5">
                                <CardContent className="pt-4 space-y-3">
                                    <div className="grid grid-cols-3 gap-2 text-center">
                                        <div className="rounded-xl bg-white dark:bg-slate-800 p-2 border">
                                            <p className="text-xl font-black">{recipientCount}</p>
                                            <p className="text-[10px] text-muted-foreground">Recipients</p>
                                        </div>
                                        <div className="rounded-xl bg-white dark:bg-slate-800 p-2 border">
                                            <p className="text-xl font-black">{Math.ceil(message.length / 160) || 1}</p>
                                            <p className="text-[10px] text-muted-foreground">SMS Units</p>
                                        </div>
                                        <div className="rounded-xl bg-white dark:bg-slate-800 p-2 border">
                                            <p className="text-xl font-black">{recipientCount * (Math.ceil(message.length / 160) || 1)}</p>
                                            <p className="text-[10px] text-muted-foreground">Total Units</p>
                                        </div>
                                    </div>

                                    {lastResult && (
                                        <div className={cn(
                                            'flex items-center gap-2 p-2 rounded-lg text-xs font-medium',
                                            lastResult.failed === 0
                                                ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                                                : 'bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400'
                                        )}>
                                            {lastResult.failed === 0 ? <CheckCircle2 className="w-4 h-4 flex-shrink-0" /> : <AlertTriangle className="w-4 h-4 flex-shrink-0" />}
                                            Last batch: {lastResult.sent}/{lastResult.total} delivered
                                            {lastResult.failed > 0 && `, ${lastResult.failed} failed`}
                                        </div>
                                    )}

                                    <Button
                                        id="btn-send-sms"
                                        onClick={handleSend}
                                        className="w-full gap-2 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-700 hover:to-indigo-700 text-white font-bold h-11"
                                        disabled={sending || recipientCount === 0 || !message.trim()}
                                    >
                                        {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                                        {sending ? 'Sending via Hubtel Batch…' : `Send to ${recipientCount} Recipient${recipientCount !== 1 ? 's' : ''}`}
                                    </Button>
                                </CardContent>
                            </Card>
                        </div>

                        {/* Right: Audience selector */}
                        <div className="space-y-3">
                            {/* Audience toggle */}
                            <div className="flex gap-2">
                                <button
                                    onClick={() => setAudience('users')}
                                    className={cn(
                                        'flex-1 flex items-center gap-2 p-3 rounded-xl border text-sm font-semibold transition-all',
                                        audience === 'users'
                                            ? 'border-violet-500 bg-violet-50 dark:bg-violet-500/10 text-violet-700 dark:text-violet-300'
                                            : 'border-slate-200 dark:border-slate-700 text-muted-foreground hover:border-slate-300'
                                    )}
                                >
                                    <Users className="w-4 h-4" /> App Users
                                </button>
                                <button
                                    onClick={() => setAudience('group')}
                                    className={cn(
                                        'flex-1 flex items-center gap-2 p-3 rounded-xl border text-sm font-semibold transition-all',
                                        audience === 'group'
                                            ? 'border-violet-500 bg-violet-50 dark:bg-violet-500/10 text-violet-700 dark:text-violet-300'
                                            : 'border-slate-200 dark:border-slate-700 text-muted-foreground hover:border-slate-300'
                                    )}
                                >
                                    <Folder className="w-4 h-4" /> Contact Group
                                </button>
                            </div>

                            {/* App Users audience */}
                            {audience === 'users' && (
                                <Card className="h-fit">
                                    <CardHeader className="pb-2">
                                        <CardTitle className="text-sm flex items-center gap-2">
                                            <Users className="w-4 h-4 text-violet-500" /> Select Recipients
                                        </CardTitle>
                                    </CardHeader>
                                    <CardContent className="space-y-3">
                                        <div className="flex gap-2">
                                            <div className="flex-1 relative">
                                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                                                <Input
                                                    placeholder="Search…"
                                                    value={searchQuery}
                                                    onChange={e => setSearchQuery(e.target.value)}
                                                    className="pl-8 h-8 text-xs"
                                                />
                                            </div>
                                            <Select value={roleFilter} onValueChange={setRoleFilter}>
                                                <SelectTrigger className="w-[110px] h-8 text-xs">
                                                    <SelectValue placeholder="Role" />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="all" className="text-xs">All Roles</SelectItem>
                                                    <SelectItem value="dealer" className="text-xs">Dealers</SelectItem>
                                                    <SelectItem value="agent" className="text-xs">Agents</SelectItem>
                                                    <SelectItem value="subagent" className="text-xs">Subagents</SelectItem>
                                                    <SelectItem value="customer" className="text-xs">Customers</SelectItem>
                                                    <SelectItem value="sub-admin" className="text-xs">Sub-Admins</SelectItem>
                                                    <SelectItem value="admin" className="text-xs">Admins</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>
                                        <div className="flex gap-2">
                                            <Select value={verifiedFilter} onValueChange={setVerifiedFilter}>
                                                <SelectTrigger className="flex-1 h-8 text-xs">
                                                    <SelectValue placeholder="Phone status" />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="all" className="text-xs">Any Phone Status</SelectItem>
                                                    <SelectItem value="verified" className="text-xs">Verified only</SelectItem>
                                                    <SelectItem value="unverified" className="text-xs">Unverified only</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>
                                        <div className="flex gap-2">
                                            <Button variant="outline" size="sm" className="flex-1 h-7 text-xs"
                                                onClick={() => setSelectedUsers(new Set(filteredUsers.map(u => u.id)))}>
                                                <CheckSquare className="w-3 h-3 mr-1" /> All ({filteredUsers.length})
                                            </Button>
                                            <Button variant="outline" size="sm" className="flex-1 h-7 text-xs"
                                                onClick={() => { const s = new Set(selectedUsers); filteredUsers.forEach(u => s.delete(u.id)); setSelectedUsers(s) }}>
                                                <XSquare className="w-3 h-3 mr-1" /> Deselect
                                            </Button>
                                        </div>
                                        <div className="border rounded-lg max-h-[340px] overflow-y-auto">
                                            {loadingUsers ? (
                                                <div className="flex items-center justify-center py-8">
                                                    <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                                                </div>
                                            ) : filteredUsers.length === 0 ? (
                                                <div className="text-center py-8 text-sm text-muted-foreground">No users found</div>
                                            ) : (
                                                <div className="divide-y">
                                                    {filteredUsers.map(u => (
                                                        <label key={u.id}
                                                            className="flex items-center gap-3 px-3 py-2 hover:bg-muted/50 cursor-pointer transition-colors">
                                                            <Checkbox
                                                                checked={selectedUsers.has(u.id)}
                                                                onCheckedChange={() => {
                                                                    const s = new Set(selectedUsers)
                                                                    s.has(u.id) ? s.delete(u.id) : s.add(u.id)
                                                                    setSelectedUsers(s)
                                                                }}
                                                            />
                                                            <div className="flex-1 min-w-0">
                                                                <div className="flex items-center gap-1.5">
                                                                    <span className="text-xs font-medium truncate">{u.first_name} {u.last_name}</span>
                                                                    <RoleBadge role={u.role} />
                                                                </div>
                                                                <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                                                                    {u.phone_number}
                                                                    {u.phone_verified && (
                                                                        <ShieldCheck className="w-3 h-3 text-emerald-600 flex-shrink-0" aria-label="Verified" />
                                                                    )}
                                                                </p>
                                                            </div>
                                                        </label>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                        <p className="text-[11px] text-muted-foreground text-center">
                                            Showing {filteredUsers.length} of {appUsers.length} users · {selectedUsers.size} selected
                                        </p>
                                    </CardContent>
                                </Card>
                            )}

                            {/* Group audience */}
                            {audience === 'group' && (
                                <Card className="h-fit">
                                    <CardHeader className="pb-2">
                                        <CardTitle className="text-sm flex items-center gap-2">
                                            <Folder className="w-4 h-4 text-violet-500" /> Choose Contact Group
                                        </CardTitle>
                                    </CardHeader>
                                    <CardContent className="space-y-3">
                                        {loadingGroups ? (
                                            <div className="flex items-center justify-center py-6">
                                                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                                            </div>
                                        ) : groups.length === 0 ? (
                                            <div className="text-center py-6">
                                                <p className="text-sm text-muted-foreground">No groups yet</p>
                                                <Button variant="outline" size="sm" className="mt-2 text-xs"
                                                    onClick={() => setActiveTab('contacts')}>
                                                    Create a Group
                                                </Button>
                                            </div>
                                        ) : (
                                            <div className="space-y-2">
                                                {groups.map(g => (
                                                    <label key={g.id}
                                                        className={cn(
                                                            'flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all',
                                                            selectedGroupId === g.id
                                                                ? 'border-violet-500 bg-violet-50 dark:bg-violet-500/10'
                                                                : 'border-slate-200 dark:border-slate-700 hover:border-slate-300'
                                                        )}>
                                                        <input
                                                            type="radio"
                                                            name="group"
                                                            value={g.id}
                                                            checked={selectedGroupId === g.id}
                                                            onChange={() => setSelectedGroupId(g.id)}
                                                            className="accent-violet-600"
                                                        />
                                                        <div className="flex-1 min-w-0">
                                                            <p className="text-sm font-semibold truncate">{g.name}</p>
                                                            <p className="text-[11px] text-muted-foreground">
                                                                {g.contact_count} contact{g.contact_count !== 1 ? 's' : ''}
                                                                {g.description ? ` · ${g.description}` : ''}
                                                            </p>
                                                        </div>
                                                    </label>
                                                ))}
                                            </div>
                                        )}
                                        {selectedGroupId && groupContacts.length > 0 && (
                                            <p className="text-[11px] text-emerald-600 dark:text-emerald-400 font-medium text-center">
                                                ✓ {groupContacts.length} contacts will receive this message
                                            </p>
                                        )}
                                    </CardContent>
                                </Card>
                            )}
                        </div>
                    </div>
                </TabsContent>

                {/* ═══════════════════════════════════════════════════════════ */}
                {/* TAB 2: CONTACTS & GROUPS                                   */}
                {/* ═══════════════════════════════════════════════════════════ */}
                <TabsContent value="contacts" className="mt-4">
                    <div className="grid gap-4 lg:grid-cols-[280px_1fr]">

                        {/* Group list */}
                        <div className="space-y-3">
                            <div className="flex items-center justify-between">
                                <h3 className="text-sm font-bold">Groups</h3>
                                <Button size="sm" className="h-7 text-xs gap-1" onClick={() => setShowCreateGroup(true)}>
                                    <Plus className="w-3 h-3" /> New
                                </Button>
                            </div>
                            {cgLoading ? (
                                <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin" /></div>
                            ) : cgGroups.length === 0 ? (
                                <div className="rounded-xl border border-dashed p-6 text-center">
                                    <Folder className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
                                    <p className="text-sm text-muted-foreground">No groups yet</p>
                                    <Button variant="outline" size="sm" className="mt-2 text-xs" onClick={() => setShowCreateGroup(true)}>
                                        Create First Group
                                    </Button>
                                </div>
                            ) : (
                                <div className="space-y-1">
                                    {cgGroups.map(g => (
                                        <div key={g.id}
                                            className={cn(
                                                'flex items-center gap-2 px-3 py-2.5 rounded-xl border cursor-pointer transition-all group',
                                                cgOpenGroupId === g.id
                                                    ? 'border-violet-500 bg-violet-50 dark:bg-violet-500/10'
                                                    : 'border-transparent hover:border-slate-200 dark:hover:border-slate-700 hover:bg-muted/50'
                                            )}
                                            onClick={() => {
                                                setCgOpenGroupId(g.id)
                                                fetchCgContacts(g.id)
                                            }}
                                        >
                                            {cgOpenGroupId === g.id
                                                ? <FolderOpen className="w-4 h-4 text-violet-500 flex-shrink-0" />
                                                : <Folder className="w-4 h-4 text-muted-foreground flex-shrink-0" />}
                                            <div className="flex-1 min-w-0">
                                                <p className="text-xs font-semibold truncate">{g.name}</p>
                                                <p className="text-[10px] text-muted-foreground">{g.contact_count} contacts</p>
                                            </div>
                                            <button
                                                className="opacity-0 group-hover:opacity-100 p-0.5 text-destructive hover:bg-destructive/10 rounded transition-all"
                                                onClick={e => { e.stopPropagation(); setDeleteTarget({ type: 'group', id: g.id, label: g.name }) }}
                                            >
                                                <Trash2 className="w-3 h-3" />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* Contact list */}
                        <div>
                            {!cgOpenGroupId ? (
                                <div className="flex flex-col items-center justify-center h-60 rounded-2xl border border-dashed text-muted-foreground">
                                    <FolderOpen className="w-10 h-10 mb-2 opacity-30" />
                                    <p className="text-sm">Select a group to view contacts</p>
                                </div>
                            ) : (
                                <Card>
                                    <CardHeader className="pb-3">
                                        <div className="flex items-center justify-between">
                                            <div>
                                                <CardTitle className="text-sm flex items-center gap-2">
                                                    <FolderOpen className="w-4 h-4 text-violet-500" />
                                                    {cgGroups.find(g => g.id === cgOpenGroupId)?.name}
                                                </CardTitle>
                                                <CardDescription className="text-xs">
                                                    {cgContacts.length} contact{cgContacts.length !== 1 ? 's' : ''}
                                                </CardDescription>
                                            </div>
                                            <div className="flex flex-wrap items-center gap-2">
                                                <Button variant="outline" size="sm" className="text-xs h-7 gap-1"
                                                    onClick={downloadCsvTemplate}>
                                                    <Download className="w-3 h-3" /> CSV Template
                                                </Button>
                                                <div className="flex items-center gap-1.5">
                                                    <Button variant="outline" size="sm" className="text-xs h-7 gap-1"
                                                        onClick={() => csvInputRef.current?.click()}
                                                        disabled={csvUploading}>
                                                        {csvUploading
                                                            ? <><Loader2 className="w-3 h-3 animate-spin" />{enrichNames ? 'Importing & verifying…' : 'Importing…'}</>
                                                            : <><Upload className="w-3 h-3" /> Import CSV</>
                                                        }
                                                    </Button>
                                                    <label className={cn(
                                                        'flex items-center gap-1 text-[10px] font-medium cursor-pointer px-2 py-1 rounded-lg border transition-colors select-none',
                                                        enrichNames
                                                            ? 'border-emerald-400 dark:border-emerald-500/50 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                                                            : 'border-slate-200 dark:border-slate-700 text-muted-foreground hover:border-slate-300'
                                                    )}
                                                        title="Resolve missing contact names from MoMo registry via Paystack (max 100 per upload)">
                                                        <input
                                                            type="checkbox"
                                                            checked={enrichNames}
                                                            onChange={e => setEnrichNames(e.target.checked)}
                                                            className="accent-emerald-600 w-3 h-3"
                                                        />
                                                        Enrich names
                                                    </label>
                                                </div>
                                                <input ref={csvInputRef} type="file" accept=".csv" className="hidden" onChange={handleCsvUpload} />
                                                <Button size="sm" className="text-xs h-7 gap-1"
                                                    onClick={() => setShowAddContact(true)}>
                                                    <UserPlus className="w-3 h-3" /> Add Contact
                                                </Button>
                                            </div>
                                        </div>
                                    </CardHeader>
                                    <CardContent>
                                        {cgContactsLoading ? (
                                            <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin" /></div>
                                        ) : cgContacts.length === 0 ? (
                                            <div className="text-center py-10 text-muted-foreground">
                                                <UserPlus className="w-8 h-8 mx-auto mb-2 opacity-30" />
                                                <p className="text-sm">No contacts yet — add one or import a CSV</p>
                                            </div>
                                        ) : (
                                            <div className="border rounded-xl overflow-hidden">
                                                <table className="w-full text-xs">
                                                    <thead className="bg-muted/50">
                                                        <tr>
                                                            <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Name</th>
                                                            <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Phone</th>
                                                            <th className="w-10 px-3 py-2"></th>
                                                        </tr>
                                                    </thead>
                                                    <tbody className="divide-y">
                                                        {cgContacts.map(c => (
                                                            <tr key={c.id} className="hover:bg-muted/30 transition-colors">
                                                                <td className="px-3 py-2 font-medium">
                                                                    {c.first_name || c.last_name
                                                                        ? [c.first_name, c.last_name].filter(Boolean).join(' ')
                                                                        : <span className="text-muted-foreground italic">—</span>}
                                                                </td>
                                                                <td className="px-3 py-2 font-mono text-muted-foreground">{c.phone_number}</td>
                                                                <td className="px-3 py-2">
                                                                    <button
                                                                        className="p-1 text-destructive hover:bg-destructive/10 rounded transition-colors"
                                                                        onClick={() => setDeleteTarget({ type: 'contact', id: c.id, label: c.phone_number })}
                                                                    >
                                                                        <Trash2 className="w-3 h-3" />
                                                                    </button>
                                                                </td>
                                                            </tr>
                                                        ))}
                                                    </tbody>
                                                </table>
                                            </div>
                                        )}
                                    </CardContent>
                                </Card>
                            )}
                        </div>
                    </div>
                </TabsContent>

                {/* ═══════════════════════════════════════════════════════════ */}
                {/* TAB 3: TEMPLATES                                           */}
                {/* ═══════════════════════════════════════════════════════════ */}
                <TabsContent value="templates" className="mt-4">
                    <div className="space-y-4">
                        <div className="flex items-center justify-between">
                            <div>
                                <h3 className="font-bold">Message Templates</h3>
                                <p className="text-xs text-muted-foreground">Reusable messages. Supports [FirstName], [LastName], [Phone] variables.</p>
                            </div>
                            <Button size="sm" className="gap-1 text-xs" onClick={openNewTemplate}>
                                <Plus className="w-3.5 h-3.5" /> New Template
                            </Button>
                        </div>

                        {tplLoading ? (
                            <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin" /></div>
                        ) : templates.length === 0 ? (
                            <div className="rounded-2xl border border-dashed p-10 text-center">
                                <BookTemplate className="w-10 h-10 mx-auto mb-3 opacity-30" />
                                <p className="text-sm text-muted-foreground">No templates yet</p>
                            </div>
                        ) : (
                            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                                {templates.map(t => (
                                    <div key={t.id} className="rounded-2xl border bg-card p-4 space-y-3 hover:border-violet-300 dark:hover:border-violet-500/40 transition-all group">
                                        <div className="flex items-start justify-between gap-2">
                                            <p className="text-sm font-bold leading-tight">{t.name}</p>
                                            <div className="flex gap-1 flex-shrink-0">
                                                <button
                                                    className="p-1 rounded text-muted-foreground hover:text-violet-600 hover:bg-violet-50 dark:hover:bg-violet-500/10 transition-colors"
                                                    onClick={() => openEditTemplate(t)}
                                                    title="Edit"
                                                >
                                                    <Pencil className="w-3.5 h-3.5" />
                                                </button>
                                                <button
                                                    className="p-1 rounded text-muted-foreground hover:text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-500/10 transition-colors"
                                                    onClick={() => { navigator.clipboard.writeText(t.body); toast.info('Copied to clipboard') }}
                                                    title="Copy"
                                                >
                                                    <Copy className="w-3.5 h-3.5" />
                                                </button>
                                                <button
                                                    className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                                                    onClick={() => handleDeleteTemplate(t)}
                                                    title="Delete"
                                                >
                                                    <Trash2 className="w-3.5 h-3.5" />
                                                </button>
                                            </div>
                                        </div>
                                        <p className="text-xs text-muted-foreground leading-relaxed line-clamp-3">{t.body}</p>
                                        <div className="flex items-center justify-between">
                                            <span className="text-[10px] text-muted-foreground">{t.body.length} chars</span>
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                className="h-6 text-[10px] px-2"
                                                onClick={() => {
                                                    setMessage(t.body)
                                                    setActiveTab('broadcast')
                                                    toast.info(`Template "${t.name}" loaded`)
                                                }}
                                            >
                                                Use in Broadcast →
                                            </Button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </TabsContent>

                {/* ═══════════════════════════════════════════════════════════ */}
                {/* TAB 4: PROVIDER SETTINGS                                   */}
                {/* ═══════════════════════════════════════════════════════════ */}
                <TabsContent value="settings" className="mt-4 max-w-2xl">
                    <div className="space-y-4">
                        <div>
                            <h3 className="font-bold">SMS Provider Routing</h3>
                            <p className="text-xs text-muted-foreground">Changes take effect immediately across the platform (5-min cache).</p>
                        </div>

                        {settingsLoading ? (
                            <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin" /></div>
                        ) : (
                            <div className="space-y-4">
                                {/* Primary provider */}
                                <div className="rounded-2xl border bg-card p-4 space-y-3">
                                    <div className="flex items-center gap-2">
                                        <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                                        <p className="text-sm font-bold">Active Primary Provider</p>
                                    </div>
                                    <p className="text-xs text-muted-foreground">All SMS will be sent through this provider first.</p>
                                    <div className="grid gap-2">
                                        {ALL_PROVIDERS.map(p => {
                                            const meta = PROVIDER_META[p]
                                            return (
                                                <label key={p} className={cn(
                                                    'flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all',
                                                    primary === p
                                                        ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-500/10'
                                                        : 'border-slate-200 dark:border-slate-700 hover:border-slate-300'
                                                )}>
                                                    <input
                                                        type="radio"
                                                        name="primary"
                                                        value={p}
                                                        checked={primary === p}
                                                        onChange={() => setPrimary(p)}
                                                        className="accent-emerald-600"
                                                    />
                                                    <div className={cn('w-2.5 h-2.5 rounded-full flex-shrink-0', meta.color)} />
                                                    <div className="flex-1">
                                                        <p className="text-sm font-semibold">{meta.label}</p>
                                                        <p className="text-[11px] text-muted-foreground">{meta.description}</p>
                                                    </div>
                                                    {primary === p && (
                                                        <span className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 uppercase">Active</span>
                                                    )}
                                                </label>
                                            )
                                        })}
                                    </div>
                                </div>

                                {/* Fallback providers */}
                                <div className="rounded-2xl border bg-card p-4 space-y-3">
                                    <div className="flex items-center gap-2">
                                        <div className="w-2 h-2 rounded-full bg-amber-500" />
                                        <p className="text-sm font-bold">Fallback Providers</p>
                                    </div>
                                    <p className="text-xs text-muted-foreground">
                                        If the primary provider fails or has insufficient credits, the system will retry using these providers in order.
                                        The primary provider is automatically excluded.
                                    </p>
                                    <div className="space-y-2">
                                        {ALL_PROVIDERS.filter(p => p !== primary).map(p => {
                                            const meta    = PROVIDER_META[p]
                                            const enabled = fallbacks.includes(p)
                                            return (
                                                <div key={p} className={cn(
                                                    'flex items-center gap-3 p-3 rounded-xl border transition-all',
                                                    enabled
                                                        ? 'border-amber-300 dark:border-amber-500/30 bg-amber-50/40 dark:bg-amber-500/5'
                                                        : 'border-slate-200 dark:border-slate-700'
                                                )}>
                                                    <div className={cn('w-2.5 h-2.5 rounded-full flex-shrink-0', meta.color)} />
                                                    <div className="flex-1">
                                                        <p className="text-sm font-semibold">{meta.label}</p>
                                                        <p className="text-[11px] text-muted-foreground">{meta.description}</p>
                                                    </div>
                                                    <Switch
                                                        checked={enabled}
                                                        onCheckedChange={() => toggleFallback(p)}
                                                        className="data-[state=checked]:bg-amber-500"
                                                    />
                                                </div>
                                            )
                                        })}
                                    </div>

                                    {/* Fallback order indicator */}
                                    {fallbacks.length > 0 && (
                                        <div className="flex items-center gap-1.5 flex-wrap pt-1">
                                            <span className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wide">Retry order:</span>
                                            <div className={cn('w-2 h-2 rounded-full', PROVIDER_META[primary].color)} />
                                            <span className="text-[10px] font-semibold">{PROVIDER_META[primary].label}</span>
                                            {fallbacks.map(f => (
                                                <span key={f} className="flex items-center gap-1">
                                                    <ChevronRight className="w-3 h-3 text-muted-foreground" />
                                                    <div className={cn('w-2 h-2 rounded-full', PROVIDER_META[f].color)} />
                                                    <span className="text-[10px] font-semibold">{PROVIDER_META[f].label}</span>
                                                </span>
                                            ))}
                                        </div>
                                    )}
                                </div>

                                <Button
                                    onClick={handleSaveProviderSettings}
                                    disabled={savingSettings}
                                    className="gap-2 font-bold"
                                >
                                    {savingSettings ? <Loader2 className="w-4 h-4 animate-spin" /> : <Settings2 className="w-4 h-4" />}
                                    Save Provider Settings
                                </Button>
                            </div>
                        )}
                    </div>
                </TabsContent>
            </Tabs>

            {/* ─── Create Group Dialog ────────────────────────────────────────── */}
            <Dialog open={showCreateGroup} onOpenChange={setShowCreateGroup}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Create Contact Group</DialogTitle>
                        <DialogDescription>Groups let you send broadcasts to saved contacts.</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-3">
                        <div className="space-y-1.5">
                            <Label htmlFor="group-name" className="text-xs font-semibold">Group Name *</Label>
                            <Input id="group-name" value={newGroupName} onChange={e => setNewGroupName(e.target.value)}
                                placeholder="e.g. VIP Customers" maxLength={80} />
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="group-desc" className="text-xs font-semibold">Description (optional)</Label>
                            <Input id="group-desc" value={newGroupDesc} onChange={e => setNewGroupDesc(e.target.value)}
                                placeholder="Brief description of this group" maxLength={200} />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setShowCreateGroup(false)}>Cancel</Button>
                        <Button onClick={handleCreateGroup} disabled={savingGroup || !newGroupName.trim()}>
                            {savingGroup ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                            Create Group
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* ─── Add Contact Dialog ─────────────────────────────────────────── */}
            <Dialog open={showAddContact} onOpenChange={open => { if (!open) resetContactDialog() }}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Add Contact</DialogTitle>
                        <DialogDescription>
                            Adding to: <strong>{cgGroups.find(g => g.id === cgOpenGroupId)?.name}</strong>
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-3">
                        <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1.5">
                                <Label className="text-xs font-semibold">First Name</Label>
                                <Input value={contactFirstName} onChange={e => setContactFirstName(e.target.value)}
                                    placeholder="Kwame" maxLength={60} />
                            </div>
                            <div className="space-y-1.5">
                                <Label className="text-xs font-semibold">Last Name</Label>
                                <Input value={contactLastName} onChange={e => setContactLastName(e.target.value)}
                                    placeholder="Asante" maxLength={60} />
                            </div>
                        </div>
                        <div className="space-y-1.5">
                            <Label className="text-xs font-semibold">Phone Number *</Label>
                            <Input
                                value={contactPhone}
                                onChange={e => {
                                    setContactPhone(e.target.value)
                                    // Reset verification when user edits the number
                                    if (verifyStatus !== 'idle') {
                                        setVerifyStatus('idle'); setVerifiedName(''); setVerifiedNetwork('')
                                    }
                                    // Auto-trigger once the number looks complete
                                    const d = e.target.value.replace(/[\s\-+]/g, '')
                                    if (d.length === 10 || d.length === 12) verifyContactPhone(e.target.value)
                                }}
                                onBlur={e => verifyContactPhone(e.target.value)}
                                placeholder="0244000001 or 233244000001"
                                maxLength={15}
                                className={cn(
                                    verifyStatus === 'invalid' && 'border-destructive focus-visible:ring-destructive/30',
                                    verifyStatus === 'verified' && 'border-emerald-500 focus-visible:ring-emerald-500/30',
                                )}
                            />

                            {/* Verification badge */}
                            {verifyStatus === 'loading' && (
                                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                    Verifying MoMo account…
                                </div>
                            )}
                            {verifyStatus === 'verified' && (
                                <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/20 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
                                    <ShieldCheck className="w-3.5 h-3.5 flex-shrink-0" />
                                    {verifiedName}
                                    {verifiedNetwork && <span className="opacity-60">· {verifiedNetwork}</span>}
                                </div>
                            )}
                            {verifyStatus === 'unverified' && (
                                <div className="flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                                    <ShieldAlert className="w-3.5 h-3.5 flex-shrink-0" />
                                    Could not verify — number may not have a MoMo wallet
                                </div>
                            )}
                            {verifyStatus === 'invalid' && (
                                <div className="flex items-center gap-1.5 text-[11px] text-destructive">
                                    <ShieldX className="w-3.5 h-3.5 flex-shrink-0" />
                                    Invalid phone format
                                </div>
                            )}
                            {verifyStatus === 'idle' && (
                                <p className="text-[11px] text-muted-foreground">Accepts 0XXXXXXXXX or 233XXXXXXXXX · auto-verified on blur</p>
                            )}
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={resetContactDialog}>Cancel</Button>
                        <Button
                            onClick={handleAddContact}
                            disabled={savingContact || !contactPhone.trim() || verifyStatus === 'invalid'}
                            className={cn(
                                verifyStatus === 'unverified' && 'border-amber-400 dark:border-amber-500'
                            )}
                        >
                            {savingContact ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                            {verifyStatus === 'unverified' ? 'Add Anyway' : 'Add Contact'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* ─── Template Dialog ────────────────────────────────────────────── */}
            <Dialog open={showTplDialog} onOpenChange={setShowTplDialog}>
                <DialogContent className="sm:max-w-lg">
                    <DialogHeader>
                        <DialogTitle>{editTpl ? 'Edit Template' : 'New Message Template'}</DialogTitle>
                        <DialogDescription>Supports [FirstName], [LastName], [Phone] variables</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-3">
                        <div className="space-y-1.5">
                            <Label className="text-xs font-semibold">Template Name *</Label>
                            <Input value={tplName} onChange={e => setTplName(e.target.value)}
                                placeholder="e.g. Welcome Promo" maxLength={100} />
                        </div>
                        <div className="space-y-1.5">
                            <Label className="text-xs font-semibold">Message Body *</Label>
                            <Textarea
                                value={tplBody}
                                onChange={e => setTplBody(e.target.value)}
                                placeholder="Hi [FirstName], …"
                                className="min-h-[120px] resize-none font-mono text-sm"
                                maxLength={480}
                            />
                            <div className="flex justify-between text-[11px] text-muted-foreground">
                                <div className="flex gap-1.5 flex-wrap">
                                    {VARIABLES.map(v => (
                                        <button key={v.label} type="button"
                                            className="font-mono px-1.5 py-0.5 rounded border border-dashed border-violet-400 text-violet-600 dark:text-violet-400 text-[10px] hover:bg-violet-50 dark:hover:bg-violet-500/10"
                                            onClick={() => setTplBody(b => b + v.label)}>
                                            {v.label}
                                        </button>
                                    ))}
                                </div>
                                <span className={tplBody.length > 400 ? 'text-amber-500' : ''}>{tplBody.length}/480</span>
                            </div>
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setShowTplDialog(false)}>Cancel</Button>
                        <Button onClick={handleSaveTemplate} disabled={savingTpl || !tplName.trim() || !tplBody.trim()}>
                            {savingTpl ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                            {editTpl ? 'Save Changes' : 'Create Template'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* ─── Delete Confirmation Dialog ─────────────────────────────────── */}
            <Dialog open={!!deleteTarget} onOpenChange={v => { if (!v) setDeleteTarget(null) }}>
                <DialogContent className="sm:max-w-sm">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2 text-destructive">
                            <AlertTriangle className="w-5 h-5" />
                            Confirm Delete
                        </DialogTitle>
                        <DialogDescription>
                            {deleteTarget?.type === 'group'
                                ? `Deleting group "${deleteTarget.label}" will also permanently delete all its contacts. This cannot be undone.`
                                : `Remove contact ${deleteTarget?.label} from this group?`}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
                        <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
                            {deleting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                            Delete
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
