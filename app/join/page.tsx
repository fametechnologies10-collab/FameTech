'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/lib/toast'
import { Loader2, ShoppingBag, ArrowRight, ShieldCheck } from 'lucide-react'

// Neutral partner portal (spec 2026-07-06). The de-branded front door of the
// store domain: a guest types (or pastes) their shop owner's invite code and is
// routed into the owner-branded onboarding at /join/[code]. Deliberately carries
// NO KiNG FLEXY branding — see app/join/layout.tsx for the de-branded metadata.

// Accept a bare code OR a pasted full invite link — extract the trailing segment.
function extractCode(raw: string): string {
    const v = raw.trim()
    if (!v) return ''
    const m = v.match(/\/join\/([^/?#\s]+)/i)
    if (m) return m[1]
    // Or a bare URL without /join (take the last path segment), else the raw token.
    try {
        const u = new URL(v)
        const seg = u.pathname.split('/').filter(Boolean).pop()
        if (seg) return seg
    } catch { /* not a URL — treat as a raw code */ }
    return v
}

export default function PartnerPortalPage() {
    const router = useRouter()
    const [value, setValue] = useState('')
    const [busy, setBusy] = useState(false)

    const submit = async (e: React.FormEvent) => {
        e.preventDefault()
        const code = extractCode(value)
        if (code.length < 4) { toast.error('Enter your invite code'); return }
        setBusy(true)
        try {
            const r = await fetch(`/api/join?code=${encodeURIComponent(code)}`)
            const j = await r.json()
            if (j?.data?.valid) {
                router.push(`/join/${encodeURIComponent(code)}`)
            } else {
                toast.error('That invite code is invalid, expired, or has been turned off')
                setBusy(false)
            }
        } catch {
            toast.error('Could not check that code. Please try again')
            setBusy(false)
        }
    }

    return (
        <div className="min-h-screen flex items-center justify-center p-4 bg-muted/30">
            <Card className="max-w-sm w-full">
                <CardContent className="p-6 space-y-6">
                    <div className="text-center space-y-2">
                        <div className="w-14 h-14 rounded-2xl mx-auto flex items-center justify-center bg-primary/10">
                            <ShoppingBag className="w-7 h-7 text-primary" />
                        </div>
                        <h1 className="text-lg font-bold">Partner Portal</h1>
                        <p className="text-xs text-muted-foreground">
                            Enter your invite code to join a storefront, get wholesale pricing and start selling.
                        </p>
                    </div>

                    <form onSubmit={submit} className="space-y-3">
                        <Input
                            value={value}
                            onChange={e => setValue(e.target.value)}
                            placeholder="Invite code"
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                            className="text-center tracking-wide"
                            aria-label="Invite code"
                        />
                        <Button type="submit" className="w-full" disabled={busy}>
                            {busy ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                            Continue
                            {!busy ? <ArrowRight className="w-4 h-4 ml-2" /> : null}
                        </Button>
                    </form>

                    <div className="flex items-center justify-center gap-1 text-[11px] text-muted-foreground">
                        <ShieldCheck className="w-3 h-3" /> Invitation only · secure onboarding
                    </div>
                </CardContent>
            </Card>
        </div>
    )
}
