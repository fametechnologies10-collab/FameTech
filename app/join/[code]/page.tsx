'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useAuth } from '@/contexts/auth-context'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/lib/toast'
import { Loader2, Store, CheckCircle2, ShieldCheck } from 'lucide-react'

// De-branded sub-agent onboarding (spec §9, §12). Carries the UPLINE Lead's brand —
// deliberately NO KiNG FLEXY branding. Reuses the platform auth backend
// (/api/auth/login, /api/auth/signup) then redeems the invite (/api/join).

interface Preview { valid: boolean; shopName?: string; logoUrl?: string | null; brandColor?: string | null }

export default function JoinPage() {
    const { code } = useParams<{ code: string }>()
    const router = useRouter()
    const { user, loading: authLoading } = useAuth() as any

    const [preview, setPreview] = useState<Preview | null>(null)
    const [mode, setMode] = useState<'signin' | 'register'>('register')
    const [busy, setBusy] = useState(false)
    const [done, setDone] = useState<null | 'pending' | 'member'>(null)
    const [form, setForm] = useState({ firstName: '', lastName: '', email: '', phoneNumber: '', password: '' })

    useEffect(() => {
        fetch(`/api/join?code=${encodeURIComponent(String(code))}`)
            .then(r => r.json()).then(j => setPreview(j?.data ?? { valid: false }))
            .catch(() => setPreview({ valid: false }))
    }, [code])

    const redeem = async () => {
        setBusy(true)
        try {
            const r = await fetch('/api/join', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code }),
            })
            const j = await r.json()
            if (j?.success) setDone(j.data.alreadyMember ? 'member' : 'pending')
            else toast.error(j?.error || 'Could not join')
        } catch { toast.error('Could not join') }
        finally { setBusy(false) }
    }

    const submitAuth = async (e: React.FormEvent) => {
        e.preventDefault()
        setBusy(true)
        try {
            const endpoint = mode === 'signin' ? '/api/auth/login' : '/api/auth/signup'
            const payload = mode === 'signin'
                ? { email: form.email, password: form.password }
                : form
            const r = await fetch(endpoint, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            })
            const j = await r.json()
            if (r.ok && (j?.user || j?.session || j?.success)) {
                // Session cookie is set; give it a beat, then redeem.
                toast.success(mode === 'signin' ? 'Signed in' : 'Account created')
                setTimeout(redeem, 400)
            } else {
                toast.error(j?.error || 'Authentication failed')
                setBusy(false)
            }
        } catch { toast.error('Authentication failed'); setBusy(false) }
    }

    if (preview === null || authLoading) {
        return <div className="min-h-screen flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
    }

    if (!preview.valid) {
        return (
            <div className="min-h-screen flex items-center justify-center p-4">
                <Card className="max-w-sm w-full"><CardContent className="p-6 text-center space-y-2">
                    <div className="text-lg font-semibold">Invite unavailable</div>
                    <p className="text-sm text-muted-foreground">This invite link is invalid, expired, or has reached its limit.</p>
                </CardContent></Card>
            </div>
        )
    }

    const accent = preview.brandColor || '#2563eb'

    if (done) {
        return (
            <div className="min-h-screen flex items-center justify-center p-4">
                <Card className="max-w-sm w-full"><CardContent className="p-6 text-center space-y-3">
                    <CheckCircle2 className="w-10 h-10 mx-auto" style={{ color: accent }} />
                    <div className="text-lg font-semibold">{done === 'member' ? "You're already in this network" : "You're in — pending approval"}</div>
                    <p className="text-sm text-muted-foreground">
                        {done === 'pending'
                            ? `${preview.shopName} will approve your account shortly. Then you can set up your storefront and start selling.`
                            : `Continue to your dashboard to manage your storefront.`}
                    </p>
                    <Button className="w-full" style={{ backgroundColor: accent }} onClick={() => router.push('/dashboard')}>Go to dashboard</Button>
                </CardContent></Card>
            </div>
        )
    }

    return (
        <div className="min-h-screen flex items-center justify-center p-4 bg-muted/30">
            <Card className="max-w-sm w-full">
                <CardContent className="p-6 space-y-5">
                    <div className="text-center space-y-2">
                        {preview.logoUrl
                            ? <img src={preview.logoUrl} alt={preview.shopName} className="w-14 h-14 rounded-full object-cover mx-auto" />
                            : <div className="w-14 h-14 rounded-full mx-auto flex items-center justify-center" style={{ backgroundColor: accent }}><Store className="w-7 h-7 text-white" /></div>}
                        <div className="text-lg font-bold">Join {preview.shopName}</div>
                        <p className="text-xs text-muted-foreground">Become a sub-agent: get wholesale pricing, run your own storefront, and earn on every sale.</p>
                    </div>

                    {user ? (
                        <Button className="w-full" style={{ backgroundColor: accent }} onClick={redeem} disabled={busy}>
                            {busy ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null} Join as sub-agent
                        </Button>
                    ) : (
                        <form onSubmit={submitAuth} className="space-y-3">
                            {mode === 'register' && (
                                <div className="grid grid-cols-2 gap-2">
                                    <Input placeholder="First name" value={form.firstName} onChange={e => setForm({ ...form, firstName: e.target.value })} required />
                                    <Input placeholder="Last name" value={form.lastName} onChange={e => setForm({ ...form, lastName: e.target.value })} required />
                                </div>
                            )}
                            <Input type="email" placeholder="Email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} required />
                            {mode === 'register' && (
                                <Input placeholder="Phone (0XXXXXXXXX)" value={form.phoneNumber} onChange={e => setForm({ ...form, phoneNumber: e.target.value })} required />
                            )}
                            <Input type="password" placeholder="Password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} required />
                            <Button type="submit" className="w-full" style={{ backgroundColor: accent }} disabled={busy}>
                                {busy ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                                {mode === 'register' ? 'Create account & join' : 'Sign in & join'}
                            </Button>
                            <button type="button" className="text-xs text-muted-foreground w-full text-center" onClick={() => setMode(mode === 'register' ? 'signin' : 'register')}>
                                {mode === 'register' ? 'Already have an account? Sign in' : 'New here? Create an account'}
                            </button>
                        </form>
                    )}

                    <div className="flex items-center justify-center gap-1 text-[11px] text-muted-foreground">
                        <ShieldCheck className="w-3 h-3" /> Secure onboarding
                    </div>
                </CardContent>
            </Card>
        </div>
    )
}
