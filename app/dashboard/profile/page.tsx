'use client'

import { useEffect, useState } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { usePin } from '@/contexts/pin-context'
import { supabase } from '@/lib/supabase'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import {
    User,
    Mail,
    Phone,
    Calendar,
    Shield,
    ShieldOff,
    LogOut,
    Loader2,
    AlertCircle,
    CheckCircle2,
    Trash2,
    Crown,
    MonitorX,
    Key,
    Pencil,
} from 'lucide-react'
import { toast } from '@/lib/toast'
import { formatDate, cn } from '@/lib/utils'
import { clearTrustedDevice } from '@/lib/pin-crypto'
import {
    browserSupportsWebAuthn,
    listPasskeys,
    registerNewPasskey,
    renamePasskey,
    deletePasskey,
    type PasskeyRecord,
} from '@/lib/passkey-client'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { roleConfig, UserRole } from '@/lib/roles'

import { isStrongPassword, PASSWORD_REQUIREMENTS_MESSAGE } from '@/lib/password-validation'

export default function ProfilePage() {
    const { dbUser, user, signOut, isSigningOut, refreshUser, syncSession, getPendingCredentials } = useAuth()
    const { showPinSetup, isPinSet } = usePin()
    const router = useRouter()
    const searchParams = useSearchParams()

    const [isConnectingGoogle, setIsConnectingGoogle] = useState(false)
    const [isDisconnectingGoogle, setIsDisconnectingGoogle] = useState(false)

    const hasGoogleIdentity = user?.identities?.some(id => id.provider === 'google') ?? false
    const hasPasswordIdentity = user?.user_metadata?.has_password === true
        || (user?.identities?.some(id => id.provider === 'email') ?? false)

    // Handle the return from supabase.auth.linkIdentity() — Google redirects
    // through /auth/callback (which exchanges the code and refreshes the
    // session) and lands back here with ?linked=google once done.
    useEffect(() => {
        if (searchParams.get('linked') !== 'google') return

        const finalizeLink = async () => {
            try {
                // The /auth/callback route enforces the email match server-side
                // before the browser ever runs. If it already handled a
                // mismatch, report that outcome and stop — the identity is
                // already gone (or the failure is already logged server-side).
                const serverOutcome = searchParams.get('link')
                if (serverOutcome === 'mismatch') {
                    await syncSession()
                    toast.error(
                        `That Google account doesn't match your KiNG FLEXY email, so it was not connected. ` +
                        `Please use the Google account registered to your KiNG FLEXY email.`
                    )
                    return
                }
                if (serverOutcome === 'mismatch_failed') {
                    await syncSession()
                    toast.error(
                        `A Google account that doesn't match your KiNG FLEXY email was connected, and we ` +
                        `couldn't remove it automatically. Please tap Disconnect, or contact support.`
                    )
                    return
                }

                await syncSession()
                const { data: { user: freshUser } } = await supabase.auth.getUser()
                const googleIdentity = freshUser?.identities?.find(id => id.provider === 'google')

                if (!googleIdentity) return

                // Supabase does NOT enforce that the linked Google account's email
                // matches this account — this check is the only thing that does.
                // Anything other than a confirmed, case-insensitive match is
                // treated as a mismatch and unlinked (fail closed).
                const googleEmail = googleIdentity.identity_data?.email
                const matches =
                    typeof googleEmail === 'string' &&
                    typeof freshUser?.email === 'string' &&
                    googleEmail.toLowerCase() === freshUser.email.toLowerCase()

                if (matches) {
                    toast.success('Google account connected!')
                    return
                }

                const { error: unlinkError } = await supabase.auth.unlinkIdentity(googleIdentity)
                await syncSession()

                if (unlinkError) {
                    console.error('[profile] failed to unlink mismatched Google identity:', unlinkError.message)
                    toast.error(
                        `A Google account that doesn't match your KiNG FLEXY email was connected, and we ` +
                        `couldn't remove it automatically. Please tap Disconnect, or contact support.`
                    )
                    return
                }

                toast.error(
                    `That Google account (${googleEmail ?? 'unknown'}) doesn't match your ` +
                    `KiNG FLEXY email (${freshUser?.email ?? 'unknown'}). Please use the Google account registered to that email.`
                )
            } catch (err) {
                console.error('[profile] finalizing Google link failed:', err)
                toast.error("Couldn't finish connecting Google. Please try again.")
            } finally {
                router.replace('/dashboard/profile')
            }
        }

        finalizeLink()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchParams])

    const [isEditing, setIsEditing] = useState(false)
    const [isSaving, setIsSaving] = useState(false)
    const [formData, setFormData] = useState({
        first_name: '',
        last_name: '',
        phone_number: '',
    })
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

    // Calculate days remaining for agents
    const calculateDaysRemaining = () => {
        if (!dbUser?.agent_expires_at || dbUser?.role !== 'agent') return null
        const now = new Date()
        const expiresAt = new Date(dbUser.agent_expires_at)
        const daysRemaining = Math.ceil((expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
        return daysRemaining > 0 ? daysRemaining : 0
    }

    const daysRemaining = calculateDaysRemaining()

    // Password change
    const [isChangingPassword, setIsChangingPassword] = useState(false)
    const [passwordData, setPasswordData] = useState({
        currentPassword: '',
        newPassword: '',
        confirmPassword: '',
    })
    const [passwordSaving, setPasswordSaving] = useState(false)

    // Terminate sessions
    const [isTerminatingSessions, setIsTerminatingSessions] = useState(false)

    // Delete account
    const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
    const [deletePassword, setDeletePassword] = useState('')
    const [isDeleting, setIsDeleting] = useState(false)

    // PIN Management
    const [hasPin, setHasPin] = useState<boolean | null>(null)
    const [isPinLoading, setIsPinLoading] = useState(true)
    const [isRemovePinDialogOpen, setIsRemovePinDialogOpen] = useState(false)
    const [removePinPassword, setRemovePinPassword] = useState('')
    const [isRemovingPin, setIsRemovingPin] = useState(false)
    const [isPinPasswordDialogOpen, setIsPinPasswordDialogOpen] = useState(false)
    const [pinPasswordForTrust, setPinPasswordForTrust] = useState('')
    const [pinPasswordError, setPinPasswordError] = useState('')

    // Passkey Management
    const [passkeyWebAuthnSupported, setPasskeyWebAuthnSupported] = useState(false)
    const [passkeys, setPasskeys] = useState<PasskeyRecord[]>([])
    const [passkeyListLoading, setPasskeyListLoading] = useState(true)
    const [isAddingPasskey, setIsAddingPasskey] = useState(false)
    const [renamingPasskeyId, setRenamingPasskeyId] = useState<string | null>(null)
    const [renameValue, setRenameValue] = useState('')
    const [deletingPasskeyId, setDeletingPasskeyId] = useState<string | null>(null)

    useEffect(() => {
        const checkPinStatus = async () => {
            try {
                const res = await fetch('/api/auth/pin', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'status' }),
                })
                if (res.ok) {
                    const data = await res.json()
                    setHasPin(data.hasPin)
                }
            } catch (e) {
                console.error('Failed to check PIN status', e)
            } finally {
                setIsPinLoading(false)
            }
        }
        checkPinStatus()
    }, [])

    // Sync hasPin with context state (updates after setup via showPinSetup())
    useEffect(() => {
        if (isPinSet) setHasPin(true)
    }, [isPinSet])

    // Load passkeys on mount
    useEffect(() => {
        const supported = browserSupportsWebAuthn()
        setPasskeyWebAuthnSupported(supported)
        if (!supported) { setPasskeyListLoading(false); return }
        listPasskeys().then(keys => {
            setPasskeys(keys)
            setPasskeyListLoading(false)
        })
    }, [])

    const handleAddPasskey = async () => {
        setIsAddingPasskey(true)
        const result = await registerNewPasskey()
        setIsAddingPasskey(false)
        if (result.success && result.passkey) {
            setPasskeys(prev => [result.passkey!, ...prev])
            toast.success('Passkey registered successfully!')
        } else if (result.error) {
            toast.error(result.error)
        }
    }

    const handleRenamePasskey = async (id: string) => {
        if (!renameValue.trim()) return
        const ok = await renamePasskey(id, renameValue.trim())
        if (ok) {
            setPasskeys(prev => prev.map(p => p.id === id ? { ...p, friendly_name: renameValue.trim() } : p))
            setRenamingPasskeyId(null)
            toast.success('Passkey renamed.')
        } else {
            toast.error('Failed to rename passkey.')
        }
    }

    const handleDeletePasskey = async (id: string) => {
        setDeletingPasskeyId(id)
        const result = await deletePasskey(id)
        setDeletingPasskeyId(null)
        if (result.success) {
            setPasskeys(prev => prev.filter(p => p.id !== id))
            toast.success('Passkey removed.')
        } else {
            toast.error(result.error || 'Failed to remove passkey.')
        }
    }

    function getPasskeyBadge(pk: PasskeyRecord): { label: string; className: string } {
        const t = pk.transports ?? []
        if (t.includes('usb') || t.includes('nfc') || t.includes('ble')) {
            return { label: 'Security Key', className: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300' }
        }
        if (pk.device_type === 'multiDevice') {
            return { label: 'Synced (Cloud)', className: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' }
        }
        return { label: 'This Device', className: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300' }
    }

    const handleSetupOrChangePin = () => {
        const creds = getPendingCredentials()
        if (creds) {
            showPinSetup(creds.password)
        } else {
            setPinPasswordError('')
            setPinPasswordForTrust('')
            setIsPinPasswordDialogOpen(true)
        }
    }

    const handlePinPasswordConfirm = () => {
        if (!pinPasswordForTrust) { setPinPasswordError('Please enter your password.'); return }
        setIsPinPasswordDialogOpen(false)
        showPinSetup(pinPasswordForTrust)
        setPinPasswordForTrust('')
    }

    const handleRemovePin = async () => {
        // Step-up: removing the app-lock PIN now requires the account password so
        // a briefly-unlocked session can't silently disable it.
        if (!removePinPassword) {
            toast.error('Please enter your account password to confirm.')
            return
        }
        setIsRemovingPin(true)
        try {
            const res = await fetch('/api/auth/pin', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'remove', password: removePinPassword }),
            })
            if (res.status === 401) {
                toast.error('Incorrect password. Please try again.')
                return
            }
            if (!res.ok) throw new Error('Failed to remove PIN')

            // Clear local PIN session and trusted device credentials
            try {
                localStorage.removeItem('kfg_pin_verified')
                localStorage.removeItem('kfg_pin_verified_at')
                clearTrustedDevice()
            } catch {}

            setHasPin(false)
            setIsRemovePinDialogOpen(false)
            setRemovePinPassword('')
            toast.success('PIN removed. You can set a new one anytime from this page.')
        } catch {
            toast.error('Failed to remove PIN. Please try again.')
        } finally {
            setIsRemovingPin(false)
        }
    }

    useEffect(() => {
        if (dbUser) {
            setFormData({
                first_name: dbUser.first_name || '',
                last_name: dbUser.last_name || '',
                phone_number: dbUser.phone_number || '',
            })
        }
    }, [dbUser])

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setFormData(prev => ({
            ...prev,
            [e.target.name]: e.target.value
        }))
        if (fieldErrors[e.target.name]) {
            setFieldErrors(prev => {
                const { [e.target.name]: _, ...rest } = prev
                return rest
            })
        }
    }

    const handleSave = async () => {
        setIsSaving(true)
        setFieldErrors({})
        try {
            const res = await fetch('/api/users/update-profile', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    first_name: formData.first_name,
                    last_name: formData.last_name,
                })
            })

            const data = await res.json()

            if (!res.ok) {
                if (data.details) {
                    const newErrors: Record<string, string> = {}
                    data.details.forEach((err: string) => {
                        const [field, ...msgParts] = err.split(': ')
                        if (field) newErrors[field] = msgParts.join(': ')
                    })
                    setFieldErrors(newErrors)
                }
                throw new Error(data.error || 'Failed to update profile')
            }

            await refreshUser()
            setIsEditing(false)
            toast.success('Profile updated successfully')
        } catch (error: any) {
            console.error('Profile Update error:', error)
            toast.error(error.message || 'Failed to update profile')
        } finally {
            setIsSaving(false)
        }
    }

    const handlePasswordChange = async () => {
        if (passwordData.newPassword !== passwordData.confirmPassword) {
            toast.error('Passwords do not match')
            return
        }

        if (!isStrongPassword(passwordData.newPassword)) {
            toast.error(PASSWORD_REQUIREMENTS_MESSAGE)
            return
        }

        if (passwordData.currentPassword === passwordData.newPassword) {
            toast.error('New password must be different from your current password')
            return
        }

        setPasswordSaving(true)
        try {
            const response = await fetch('/api/users/change-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    currentPassword: passwordData.currentPassword,
                    newPassword: passwordData.newPassword,
                    confirmPassword: passwordData.confirmPassword,
                })
            })

            if (response.status === 429) {
                const retryAfter = response.headers.get('Retry-After')
                const minutes = retryAfter ? Math.max(1, Math.ceil(parseInt(retryAfter, 10) / 60)) : 10
                toast.error(`Too many password change attempts. Please try again in ${minutes} minute${minutes !== 1 ? 's' : ''}.`)
                return
            }

            const result = await response.json()

            if (!response.ok) {
                toast.error(result.error || 'Failed to change password')
                return
            }

            setIsChangingPassword(false)
            setPasswordData({ currentPassword: '', newPassword: '', confirmPassword: '' })
            toast.success('Password changed successfully. Please log in again.')

            // signOut navigates to /api/auth/signout which clears cookies and
            // redirects to /auth — the setTimeout double-navigation is removed.
            signOut()
        } catch (error: any) {
            // Catch unexpected errors and still show a meaningful message
            toast.error(error?.message || 'An unexpected error occurred. Please try again.')
        } finally {
            setPasswordSaving(false)
        }
    }

    const handleTerminateSessions = async () => {
        setIsTerminatingSessions(true)
        try {
            const { error } = await supabase.auth.signOut({ scope: 'others' })
            if (error) throw error

            toast.success('All other active sessions have been terminated.')
            toast.warning('Please change your password immediately for security reasons.', {
                duration: 10000,
            })

            // Open password change form dynamically
            setIsChangingPassword(true)
        } catch (error) {
            console.error('Error terminating sessions:', error)
            toast.error('Failed to terminate sessions. Please try logging out completely.')
        } finally {
            setIsTerminatingSessions(false)
        }
    }

    const handleConnectGoogle = async () => {
        setIsConnectingGoogle(true)
        try {
            const { error } = await supabase.auth.linkIdentity({
                provider: 'google',
                options: {
                    redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent('/dashboard/profile?linked=google')}`,
                },
            })
            if (error) {
                toast.error("Couldn't connect Google right now. Please try again later.")
                console.error('[profile] linkIdentity error:', error.message)
                setIsConnectingGoogle(false)
            }
            // On success, linkIdentity redirects the browser — nothing else to do here.
        } catch {
            toast.error("Couldn't connect Google right now. Please try again later.")
            setIsConnectingGoogle(false)
        }
    }

    const handleDisconnectGoogle = async () => {
        if (!hasPasswordIdentity) {
            toast.error('Set a password first — Google is currently your only way to sign in.')
            return
        }

        setIsDisconnectingGoogle(true)
        try {
            const googleIdentity = user?.identities?.find(id => id.provider === 'google')
            if (!googleIdentity) return

            const { error } = await supabase.auth.unlinkIdentity(googleIdentity)
            if (error) {
                toast.error('Could not disconnect Google. Please try again.')
                return
            }
            await syncSession()
            toast.success('Google account disconnected.')
        } catch {
            toast.error('Could not disconnect Google. Please try again.')
        } finally {
            setIsDisconnectingGoogle(false)
        }
    }

    const handleDeleteAccount = async () => {
        if (!deletePassword) {
            toast.error('Please enter your password to confirm')
            return
        }

        setIsDeleting(true)
        try {
            const response = await fetch('/api/users/delete-account', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: deletePassword })
            })

            // A 429 here is the middleware limiter (which runs BEFORE the password
            // check). Surface an actionable retry time instead of the generic
            // "Failed to delete account" that the throw below would show.
            if (response.status === 429) {
                const retryAfter = response.headers.get('Retry-After')
                const minutes = retryAfter ? Math.max(1, Math.ceil(parseInt(retryAfter, 10) / 60)) : 15
                toast.error(`Too many attempts. Please try again in ${minutes} minute${minutes !== 1 ? 's' : ''}.`)
                return
            }

            const result = await response.json()

            if (!response.ok) {
                throw new Error(result.error || 'Failed to delete account')
            }

            toast.success('Account deleted successfully. Redirecting...')

            // Wait briefly for toast to show, then redirect to login
            setTimeout(() => {
                window.location.href = '/auth'
            }, 1500)
        } catch (error: any) {
            console.error('Delete account error:', error)
            toast.error(error.message || 'Failed to delete account')
        } finally {
            setIsDeleting(false)
        }
    }

    const getInitials = () => {
        return `${dbUser?.first_name?.[0] || ''}${dbUser?.last_name?.[0] || ''}`.toUpperCase()
    }

    return (
        <div className="scroll-smooth">
            <h1 className="text-2xl font-bold mb-6">My Profile</h1>

            {/* ── Row 1: Personal Info + Security (side-by-side on desktop) ── */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start mb-6">

            {/* Profile Card */}
            <Card id="personal-info" className={cn(
                dbUser?.role === 'agent' && "bg-gradient-to-br from-yellow-400 via-amber-500 to-yellow-600 border-yellow-600/30"
            )}>
                <CardHeader>
                    <div className="flex items-center gap-4">
                        {(() => {
                            const userRole = (dbUser?.role || 'customer') as UserRole
                            const config = roleConfig[userRole] || roleConfig['customer']
                            const roleBgClass = {
                                'admin': 'bg-[#E60000]',
                                'sub-admin': 'bg-[#FACC15]',
                                'dealer': 'bg-[#7C3AED]',
                                'agent': 'bg-[#25D366]',
                                'subagent': 'bg-[#0D9488]',
                                'customer': 'bg-[#0056B3]',
                            }[userRole] || 'bg-[#0056B3]'

                            const RoleIcon = config.icon

                            return (
                                <div
                                    className={cn("w-20 h-20 rounded-full flex items-center justify-center text-white shadow-lg ring-4 ring-white dark:ring-gray-800", roleBgClass)}
                                >
                                    <RoleIcon className="w-10 h-10" />
                                </div>
                            )
                        })()}
                        <div>
                            <CardTitle className="text-xl flex items-center gap-2 flex-wrap">
                                <span className={cn(
                                    "flex items-center gap-2",
                                    dbUser?.role === 'agent' && "text-black font-black"
                                )}>
                                    {dbUser?.first_name} {dbUser?.last_name}
                                    {dbUser?.role === 'agent' && (
                                        <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-gradient-to-r from-yellow-300 to-amber-400 border border-black/10 shadow-sm">
                                            <Crown className="w-3 h-3 text-black fill-black" />
                                            <span className="text-[10px] font-black text-black uppercase tracking-wider">PREMIUM</span>
                                        </div>
                                    )}
                                </span>
                                {dbUser?.role === 'agent' && daysRemaining !== null && (
                                    <Badge className={cn(
                                        "font-bold text-xs",
                                        daysRemaining <= 3
                                            ? "bg-red-100 text-red-700 hover:bg-red-200"
                                            : "bg-green-100 text-green-700 hover:bg-green-200"
                                    )}>
                                        {daysRemaining} {daysRemaining === 1 ? 'day' : 'days'} left
                                    </Badge>
                                )}
                            </CardTitle>
                            <CardDescription className={cn(
                                dbUser?.role === 'agent' && "text-black/70 font-semibold"
                            )}>{dbUser?.email}</CardDescription>
                            <div className="flex items-center gap-2 mt-2">
                                <Badge variant={dbUser?.role === 'admin' ? 'destructive' : 'secondary'}>
                                    {dbUser?.role || 'User'}
                                </Badge>
                                <Badge variant={dbUser?.status === 'active' ? 'completed' : 'failed'}>
                                    {dbUser?.status || 'Active'}
                                </Badge>
                            </div>
                        </div>
                    </div>
                </CardHeader>
                <CardContent className="space-y-6">
                    {isEditing ? (
                        <div className="space-y-4">
                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <Label htmlFor="first_name">First Name</Label>
                                    <Input
                                        id="first_name"
                                        name="first_name"
                                        value={formData.first_name}
                                        onChange={handleChange}
                                        className={fieldErrors.first_name ? 'border-red-500 focus:ring-red-500' : ''}
                                    />
                                    {fieldErrors.first_name && <p className="text-red-500 text-xs mt-1">{fieldErrors.first_name}</p>}
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="last_name">Last Name</Label>
                                    <Input
                                        id="last_name"
                                        name="last_name"
                                        value={formData.last_name}
                                        onChange={handleChange}
                                        className={fieldErrors.last_name ? 'border-red-500 focus:ring-red-500' : ''}
                                    />
                                    {fieldErrors.last_name && <p className="text-red-500 text-xs mt-1">{fieldErrors.last_name}</p>}
                                </div>
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="phone_number">Phone Number</Label>
                                <Input
                                    id="phone_number"
                                    name="phone_number"
                                    value={formData.phone_number}
                                    disabled
                                    readOnly
                                />
                                <p className="text-xs text-muted-foreground">
                                    Your phone number is verified and can only be changed through{' '}
                                    <Link href="/auth/verify-phone-required?mode=change" className="underline">
                                        account recovery
                                    </Link>.
                                </p>
                            </div>
                            <div className="flex gap-2">
                                <Button onClick={handleSave} disabled={isSaving}>
                                    {isSaving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                                    Save Changes
                                </Button>
                                <Button variant="outline" onClick={() => setIsEditing(false)}>
                                    Cancel
                                </Button>
                            </div>
                        </div>
                    ) : (
                        <>
                            <div className="space-y-3 sm:space-y-4">
                                <div className={cn(
                                    "flex items-center gap-3 p-3 sm:p-4 rounded-lg transition-all",
                                    dbUser?.role === 'agent'
                                        ? "bg-yellow-300/40 border border-yellow-600/20"
                                        : "bg-muted/50"
                                )}>
                                    <User className={cn(
                                        "w-5 h-5 flex-shrink-0",
                                        dbUser?.role === 'agent' ? "text-black" : "text-muted-foreground"
                                    )} />
                                    <div className="min-w-0 flex-1">
                                        <p className={cn(
                                            "text-sm",
                                            dbUser?.role === 'agent' ? "text-black/70 font-bold" : "text-muted-foreground"
                                        )}>Full Name</p>
                                        <p className={cn(
                                            "font-medium break-words",
                                            dbUser?.role === 'agent' && "text-black font-bold"
                                        )}>
                                            {dbUser?.first_name} {dbUser?.last_name}
                                        </p>
                                    </div>
                                </div>
                                <div className={cn(
                                    "flex items-center gap-3 p-3 sm:p-4 rounded-lg transition-all",
                                    dbUser?.role === 'agent'
                                        ? "bg-yellow-300/40 border border-yellow-600/20"
                                        : "bg-muted/50"
                                )}>
                                    <Mail className={cn(
                                        "w-5 h-5 flex-shrink-0",
                                        dbUser?.role === 'agent' ? "text-black" : "text-muted-foreground"
                                    )} />
                                    <div className="min-w-0 flex-1">
                                        <p className={cn(
                                            "text-sm",
                                            dbUser?.role === 'agent' ? "text-black/70 font-bold" : "text-muted-foreground"
                                        )}>Email</p>
                                        <p className={cn(
                                            "font-medium break-all",
                                            dbUser?.role === 'agent' && "text-black font-bold"
                                        )}>{dbUser?.email}</p>
                                    </div>
                                </div>
                                <div className={cn(
                                    "flex items-center gap-3 p-3 sm:p-4 rounded-lg transition-all",
                                    dbUser?.role === 'agent'
                                        ? "bg-yellow-300/40 border border-yellow-600/20"
                                        : "bg-muted/50"
                                )}>
                                    <Phone className={cn(
                                        "w-5 h-5 flex-shrink-0",
                                        dbUser?.role === 'agent' ? "text-black" : "text-muted-foreground"
                                    )} />
                                    <div className="min-w-0 flex-1">
                                        <p className={cn(
                                            "text-sm",
                                            dbUser?.role === 'agent' ? "text-black/70 font-bold" : "text-muted-foreground"
                                        )}>Phone Number</p>
                                        <p className={cn(
                                            "font-medium",
                                            dbUser?.role === 'agent' && "text-black font-bold"
                                        )}>{dbUser?.phone_number}</p>
                                    </div>
                                </div>
                                <div className={cn(
                                    "flex items-center gap-3 p-3 sm:p-4 rounded-lg transition-all",
                                    dbUser?.role === 'agent'
                                        ? "bg-yellow-300/40 border border-yellow-600/20"
                                        : "bg-muted/50"
                                )}>
                                    <Calendar className={cn(
                                        "w-5 h-5 flex-shrink-0",
                                        dbUser?.role === 'agent' ? "text-black" : "text-muted-foreground"
                                    )} />
                                    <div className="min-w-0 flex-1">
                                        <p className={cn(
                                            "text-sm",
                                            dbUser?.role === 'agent' ? "text-black/70 font-bold" : "text-muted-foreground"
                                        )}>Member Since</p>
                                        <p className={cn(
                                            "font-medium",
                                            dbUser?.role === 'agent' && "text-black font-bold"
                                        )}>{dbUser?.created_at ? formatDate(dbUser.created_at) : 'N/A'}</p>
                                    </div>
                                </div>
                            </div>
                            <Button onClick={() => setIsEditing(true)}>
                                Edit Profile
                            </Button>
                        </>
                    )}
                </CardContent>
            </Card>

            {/* ── Security Card (paired with Profile on desktop) ── */}
            <Card id="security-section" className={cn(
                dbUser?.role === 'agent' && "bg-gradient-to-br from-yellow-400 via-amber-500 to-yellow-600 border-yellow-600/30"
            )}>
                <CardHeader>
                    <CardTitle className={cn(
                        "flex items-center gap-2",
                        dbUser?.role === 'agent' && "text-black"
                    )}>
                        <Shield className={cn(
                            "w-5 h-5",
                            dbUser?.role === 'agent' && "text-black"
                        )} />
                        Security
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    {isChangingPassword ? (
                        <div className="space-y-4">
                            <div className="space-y-2">
                                <Label htmlFor="currentPassword">Current Password</Label>
                                <Input
                                    id="currentPassword"
                                    type="password"
                                    autoComplete="current-password"
                                    value={passwordData.currentPassword}
                                    onChange={(e) => setPasswordData(prev => ({ ...prev, currentPassword: e.target.value }))}
                                />
                                <button
                                    type="button"
                                    onClick={() => { window.location.href = '/api/auth/signout?next=/auth/reset-password' }}
                                    className="text-xs font-semibold text-[#0056B3] hover:underline"
                                >
                                    Forgot your current password?
                                </button>
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="newPassword">New Password</Label>
                                <Input
                                    id="newPassword"
                                    type="password"
                                    autoComplete="new-password"
                                    value={passwordData.newPassword}
                                    onChange={(e) => setPasswordData(prev => ({ ...prev, newPassword: e.target.value }))}
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="confirmPassword">Confirm New Password</Label>
                                <Input
                                    id="confirmPassword"
                                    type="password"
                                    autoComplete="new-password"
                                    value={passwordData.confirmPassword}
                                    onChange={(e) => setPasswordData(prev => ({ ...prev, confirmPassword: e.target.value }))}
                                />
                            </div>
                            <div className="flex gap-2">
                                <Button onClick={handlePasswordChange} disabled={passwordSaving}>
                                    {passwordSaving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                                    Change Password
                                </Button>
                                <Button variant="outline" onClick={() => setIsChangingPassword(false)}>
                                    Cancel
                                </Button>
                            </div>
                        </div>
                    ) : (
                        <div className="flex flex-col sm:flex-row gap-3">
                            <Button variant="outline" onClick={() => setIsChangingPassword(true)} className="flex-1">
                                Change Password
                            </Button>
                            <Button
                                variant="outline"
                                onClick={handleTerminateSessions}
                                disabled={isTerminatingSessions}
                                className="flex-1 border-amber-200 text-amber-700 hover:bg-amber-50 hover:text-amber-800"
                            >
                                {isTerminatingSessions ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <MonitorX className="w-4 h-4 mr-2" />}
                                Terminate Other Sessions
                            </Button>
                        </div>
                    )}
                </CardContent>
            </Card>

            </div>{/* end Row 1 grid */}

            {/* ── Connected Accounts Card ── */}
            <Card className="mb-6">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <svg viewBox="0 0 24 24" className="w-5 h-5 flex-shrink-0" xmlns="http://www.w3.org/2000/svg">
                            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
                            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05" />
                            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
                        </svg>
                        Connected Accounts
                    </CardTitle>
                    <CardDescription>
                        Link your Google account so you can sign in either way.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="flex items-center justify-between gap-3 p-3 rounded-xl border border-slate-200 dark:border-slate-700">
                        <div>
                            <p className="font-medium text-sm">Google</p>
                            <p className="text-xs text-muted-foreground">
                                {hasGoogleIdentity ? 'Connected' : 'Not connected'}
                            </p>
                        </div>
                        {hasGoogleIdentity ? (
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={handleDisconnectGoogle}
                                disabled={isDisconnectingGoogle || !hasPasswordIdentity}
                                title={!hasPasswordIdentity ? 'Set a password first — Google is your only sign-in method' : undefined}
                            >
                                {isDisconnectingGoogle ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                                Disconnect
                            </Button>
                        ) : (
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={handleConnectGoogle}
                                disabled={isConnectingGoogle}
                            >
                                {isConnectingGoogle ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                                Connect
                            </Button>
                        )}
                    </div>
                </CardContent>
            </Card>

            {/* ── Row 2: PIN + Passkeys (side-by-side when both present) ── */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start mb-6">

            {/* Quick Access PIN Card */}
            <Card className={cn(
                dbUser?.role === 'agent' && "border-yellow-600/30"
            )}>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <Shield className="w-5 h-5 text-[#0056B3] dark:text-blue-400" />
                        Quick Access PIN
                    </CardTitle>
                    <CardDescription>
                        Use a 6-digit PIN to securely unlock the app without typing your password.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="flex flex-col sm:flex-row items-center justify-between p-4 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 gap-4">
                        <div className="flex-1 text-center sm:text-left">
                            <p className="text-sm font-bold text-slate-900 dark:text-white">
                                {isPinLoading ? 'Checking...' : hasPin ? 'PIN is Active' : 'No PIN Configured'}
                            </p>
                            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                                {hasPin
                                    ? 'Your session is secured with a 6-digit PIN.'
                                    : 'Set up a PIN for faster and secure login.'}
                            </p>
                        </div>
                        <div className="flex gap-2 w-full sm:w-auto">
                            <Button
                                onClick={handleSetupOrChangePin}
                                disabled={isPinLoading}
                                className={cn(
                                    "flex-1 sm:flex-none",
                                    hasPin ? "bg-slate-200 hover:bg-slate-300 text-slate-900 dark:bg-slate-700 dark:hover:bg-slate-600 dark:text-white" : "bg-[#0056B3] hover:bg-[#004494] text-white"
                                )}
                                variant={hasPin ? "secondary" : "default"}
                            >
                                <Shield className="w-4 h-4 mr-1.5" />
                                {hasPin ? 'Change PIN' : 'Set Up PIN'}
                            </Button>
                            {hasPin && (
                                <Button
                                    variant="outline"
                                    onClick={() => setIsRemovePinDialogOpen(true)}
                                    disabled={isPinLoading}
                                    className="flex-1 sm:flex-none border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
                                >
                                    <ShieldOff className="w-4 h-4 mr-1.5" />
                                    Remove PIN
                                </Button>
                            )}
                        </div>
                    </div>
                </CardContent>
            </Card>

            {/* ── Passkeys Card ────────────────────────────────────────── */}
            {passkeyWebAuthnSupported && (
                <Card className={cn(dbUser?.role === 'agent' && "border-yellow-600/30")}>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <Key className="w-5 h-5 text-[#0056B3] dark:text-blue-400" />
                            Passkeys
                        </CardTitle>
                        <CardDescription>
                            Sign in with Face ID, fingerprint, or a security key — across all your devices, including QR-code cross-device sign-in on desktop.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        {passkeyListLoading ? (
                            <div className="flex items-center gap-2 text-sm text-slate-500 py-2">
                                <Loader2 className="w-4 h-4 animate-spin" /> Loading passkeys…
                            </div>
                        ) : passkeys.length === 0 ? (
                            <p className="text-sm text-slate-500 dark:text-slate-400 py-1">
                                No passkeys registered yet. Add one below for faster, more secure sign-in.
                            </p>
                        ) : (
                            <div className="space-y-2">
                                {passkeys.map(pk => {
                                    const badge = getPasskeyBadge(pk)
                                    const isRenaming = renamingPasskeyId === pk.id
                                    const isDeleting = deletingPasskeyId === pk.id
                                    return (
                                        <div key={pk.id} className="flex items-center gap-3 p-3 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                                            <Key className="w-4 h-4 text-[#0056B3] dark:text-blue-400 shrink-0" />
                                            <div className="flex-1 min-w-0">
                                                {isRenaming ? (
                                                    <div className="flex items-center gap-2">
                                                        <Input
                                                            value={renameValue}
                                                            onChange={e => setRenameValue(e.target.value)}
                                                            onKeyDown={e => {
                                                                if (e.key === 'Enter') handleRenamePasskey(pk.id)
                                                                if (e.key === 'Escape') setRenamingPasskeyId(null)
                                                            }}
                                                            className="h-8 text-sm"
                                                            autoFocus
                                                            maxLength={50}
                                                        />
                                                        <Button size="sm" className="h-8 text-xs bg-[#0056B3] hover:bg-[#004494] text-white" onClick={() => handleRenamePasskey(pk.id)}>Save</Button>
                                                        <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setRenamingPasskeyId(null)}>Cancel</Button>
                                                    </div>
                                                ) : (
                                                    <>
                                                        <p className="text-sm font-semibold text-slate-900 dark:text-white truncate">{pk.friendly_name}</p>
                                                        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                                            <span className={cn('text-[10px] font-bold px-2 py-0.5 rounded-full', badge.className)}>{badge.label}</span>
                                                            {pk.backed_up && (
                                                                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300">Cloud Backup</span>
                                                            )}
                                                            <span className="text-[10px] text-slate-400">Added {formatDate(pk.created_at)}</span>
                                                            {pk.last_used_at && (
                                                                <span className="text-[10px] text-slate-400">Used {formatDate(pk.last_used_at)}</span>
                                                            )}
                                                        </div>
                                                    </>
                                                )}
                                            </div>
                                            {!isRenaming && (
                                                <div className="flex items-center gap-1 shrink-0">
                                                    <Button
                                                        variant="ghost" size="sm"
                                                        className="h-8 w-8 p-0 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                                                        onClick={() => { setRenamingPasskeyId(pk.id); setRenameValue(pk.friendly_name) }}
                                                        title="Rename"
                                                    >
                                                        <Pencil className="w-3.5 h-3.5" />
                                                    </Button>
                                                    <Button
                                                        variant="ghost" size="sm"
                                                        className="h-8 w-8 p-0 text-red-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950"
                                                        onClick={() => handleDeletePasskey(pk.id)}
                                                        disabled={isDeleting}
                                                        title="Remove passkey"
                                                    >
                                                        {isDeleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                                                    </Button>
                                                </div>
                                            )}
                                        </div>
                                    )
                                })}
                            </div>
                        )}
                        <Button
                            onClick={handleAddPasskey}
                            disabled={isAddingPasskey}
                            className="bg-[#0056B3] hover:bg-[#004494] text-white w-full sm:w-auto"
                        >
                            {isAddingPasskey
                                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Registering…</>
                                : <><Key className="w-4 h-4 mr-2" />{passkeys.length === 0 ? 'Add Your First Passkey' : 'Add Another Passkey'}</>
                            }
                        </Button>
                    </CardContent>
                </Card>
            )}

            </div>{/* end Row 2 grid */}

            {/* ── Danger Zone (full width) ── */}

            {/* PIN Password Confirmation Dialog (needed when session is older than 5 min) */}
            <Dialog open={isPinPasswordDialogOpen} onOpenChange={open => { setIsPinPasswordDialogOpen(open); if (!open) setPinPasswordForTrust('') }}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <Shield className="w-5 h-5 text-[#0056B3]" />
                            Confirm Your Password
                        </DialogTitle>
                        <DialogDescription>
                            Enter your password once so your PIN can securely sign you in without typing it again next time.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-3 py-2">
                        <Label htmlFor="pinPassword">Password</Label>
                        <Input
                            id="pinPassword"
                            type="password"
                            placeholder="Your account password"
                            value={pinPasswordForTrust}
                            onChange={e => { setPinPasswordForTrust(e.target.value); setPinPasswordError('') }}
                            onKeyDown={e => { if (e.key === 'Enter' && pinPasswordForTrust) handlePinPasswordConfirm() }}
                            autoFocus
                        />
                        {pinPasswordError && (
                            <p className="text-sm text-red-600 flex items-center gap-1.5">
                                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                                {pinPasswordError}
                            </p>
                        )}
                    </div>
                    <DialogFooter className="gap-2 sm:gap-0">
                        <Button variant="outline" onClick={() => setIsPinPasswordDialogOpen(false)}>
                            Cancel
                        </Button>
                        <Button
                            onClick={handlePinPasswordConfirm}
                            disabled={!pinPasswordForTrust}
                            className="bg-[#0056B3] hover:bg-[#004494] text-white"
                        >
                            <Shield className="w-4 h-4 mr-2" />
                            Continue to PIN Setup
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Remove PIN Confirmation Dialog */}
            <Dialog open={isRemovePinDialogOpen} onOpenChange={setIsRemovePinDialogOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <ShieldOff className="w-5 h-5 text-red-500" />
                            Remove Quick Access PIN
                        </DialogTitle>
                        <DialogDescription>
                            This will disable PIN login on this device. You will need to sign in with your email and password. You can set up a new PIN anytime from this page.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-1.5 py-1">
                        <Label htmlFor="removePinPassword">Enter your account password to confirm</Label>
                        <Input
                            id="removePinPassword"
                            type="password"
                            autoComplete="current-password"
                            placeholder="Account password"
                            value={removePinPassword}
                            onChange={e => setRemovePinPassword(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') handleRemovePin() }}
                        />
                    </div>
                    <DialogFooter className="gap-2 sm:gap-0">
                        <Button
                            variant="outline"
                            onClick={() => { setIsRemovePinDialogOpen(false); setRemovePinPassword('') }}
                            disabled={isRemovingPin}
                        >
                            Cancel
                        </Button>
                        <Button
                            variant="destructive"
                            onClick={handleRemovePin}
                            disabled={isRemovingPin || !removePinPassword}
                        >
                            {isRemovingPin ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <ShieldOff className="w-4 h-4 mr-2" />}
                            Remove PIN
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Danger Zone */}
            <Card className="border-red-200 dark:border-red-900">
                <CardHeader>
                    <CardTitle className="text-red-600">Danger Zone</CardTitle>
                    <CardDescription>
                        Irreversible and destructive actions
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="flex flex-col sm:flex-row gap-3">
                        <Button
                            variant="destructive"
                            onClick={() => setIsDeleteDialogOpen(true)}
                            className="flex-1"
                        >
                            <Trash2 className="w-4 h-4 mr-2" />
                            Delete Account
                        </Button>
                        <Button
                            variant="outline"
                            onClick={isSigningOut ? undefined : signOut}
                            disabled={isSigningOut}
                            className="flex-1 border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700"
                        >
                            {isSigningOut
                                ? <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                : <LogOut className="w-4 h-4 mr-2" />
                            }
                            {isSigningOut ? 'Signing out…' : 'Sign Out'}
                        </Button>
                    </div>
                </CardContent>
            </Card>

            {/* Delete Account Confirmation Dialog */}
            <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle className="text-red-600">Delete Account Permanently?</DialogTitle>
                        <DialogDescription>
                            This action cannot be undone. This will permanently delete your account and remove all your data including:
                            <ul className="list-disc list-inside mt-2 space-y-1">
                                <li>Your profile information</li>
                                <li>Order history</li>
                                <li>Transaction records</li>
                                <li>Wallet balance</li>
                                <li>All associated data</li>
                            </ul>
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        <div className="space-y-2">
                            <Label htmlFor="deletePassword">Enter your password to confirm</Label>
                            <Input
                                id="deletePassword"
                                type="password"
                                value={deletePassword}
                                onChange={(e) => setDeletePassword(e.target.value)}
                                placeholder="Your password"
                                disabled={isDeleting}
                            />
                        </div>
                        <div className="bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 rounded-lg p-3">
                            <p className="text-sm text-red-800 dark:text-red-200 font-medium">
                                <AlertCircle className="w-4 h-4 inline mr-2" />
                                Warning: This action is permanent and cannot be reversed!
                            </p>
                        </div>
                    </div>
                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => {
                                setIsDeleteDialogOpen(false)
                                setDeletePassword('')
                            }}
                            disabled={isDeleting}
                        >
                            Cancel
                        </Button>
                        <Button
                            variant="destructive"
                            onClick={handleDeleteAccount}
                            disabled={isDeleting || !deletePassword}
                        >
                            {isDeleting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                            Delete My Account
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
