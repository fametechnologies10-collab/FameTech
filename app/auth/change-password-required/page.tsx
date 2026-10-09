'use client'

import { useState } from 'react'
import { Label } from '@/components/ui/label'
import { ClayButton, NeuInput, PasswordStrength } from '@/components/ft'
import { toast } from '@/lib/toast'
import { AuthShell } from '../_components/auth-shell'

export default function ChangePasswordRequiredPage() {
    const [currentPassword, setCurrentPassword] = useState('')
    const [newPassword, setNewPassword] = useState('')
    const [confirmPassword, setConfirmPassword] = useState('')
    const [submitting, setSubmitting] = useState(false)

    const submit = async (e: React.FormEvent) => {
        e.preventDefault()
        if (newPassword !== confirmPassword) {
            toast.error("New password and confirmation don't match.")
            return
        }
        setSubmitting(true)
        try {
            const res = await fetch('/api/users/change-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
            })
            const body = await res.json()
            if (!res.ok) {
                toast.error(body.error || 'Could not change password.')
                return
            }
            toast.success('Password changed. You can also set up biometric sign-in anytime from your profile.')
            window.location.assign('/dashboard')
        } finally {
            setSubmitting(false)
        }
    }

    return (
        <AuthShell
            showBrandPanel={false}
            title="Set a new password"
            subtitle="For your security, you need to set your own password before continuing."
        >
            <form onSubmit={submit} className="space-y-4">
                <div className="space-y-2">
                    <Label htmlFor="cpr-current" className="text-sm font-semibold text-ft-ink">Current access key</Label>
                    <NeuInput id="cpr-current" type="password" placeholder="Current access key" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required />
                </div>
                <div className="space-y-2">
                    <Label htmlFor="cpr-new" className="text-sm font-semibold text-ft-ink">New password</Label>
                    <NeuInput id="cpr-new" type="password" placeholder="New password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required minLength={8} />
                    <PasswordStrength password={newPassword} />
                </div>
                <div className="space-y-2">
                    <Label htmlFor="cpr-confirm" className="text-sm font-semibold text-ft-ink">Confirm new password</Label>
                    <NeuInput id="cpr-confirm" type="password" placeholder="Confirm new password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required minLength={8} />
                </div>
                <ClayButton type="submit" loading={submitting} className="w-full">
                    {submitting ? 'Saving…' : 'Set password'}
                </ClayButton>
            </form>
        </AuthShell>
    )
}
