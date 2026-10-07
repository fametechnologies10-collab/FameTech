'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/lib/toast'

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
        <div className="flex min-h-screen items-center justify-center px-4">
            <form onSubmit={submit} className="w-full max-w-sm space-y-4">
                <h1 className="text-xl font-bold">Set a new password</h1>
                <p className="text-sm text-muted-foreground">
                    For your security, you need to set your own password before continuing.
                </p>
                <Input type="password" placeholder="Current access key" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required />
                <Input type="password" placeholder="New password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required minLength={8} />
                <Input type="password" placeholder="Confirm new password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required minLength={8} />
                <Button type="submit" disabled={submitting} className="w-full">
                    {submitting ? 'Saving…' : 'Set password'}
                </Button>
            </form>
        </div>
    )
}
