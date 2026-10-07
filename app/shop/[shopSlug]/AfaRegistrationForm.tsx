'use client'

import { useState } from 'react'
import { toast } from '@/lib/toast'
import { VALID_REGIONS } from '@/lib/afa-validation'

interface AfaRegistrationFormProps {
    shopSlug: string
    /** Selling price + Paystack fee, for display only. Server recomputes authoritatively. */
    displayPrice?: number | null
    /**
     * The KYC form's only job is to collect + locally validate the applicant's details,
     * then hand them to the parent, which opens ServiceChargeSheet for payment (native
     * MoMo charge via /api/shop/afa/charge — no redirect, no KYC in Paystack metadata).
     */
    onSubmitDetails: (formData: Record<string, any>, guestEmail: string) => void
}

export default function AfaRegistrationForm({ shopSlug: _shopSlug, displayPrice, onSubmitDetails }: AfaRegistrationFormProps) {
    const [fullName, setFullName] = useState('')
    const [phone, setPhone] = useState('')
    const [idNumber, setIdNumber] = useState('')
    const [region, setRegion] = useState('')
    const [location, setLocation] = useState('')
    const [occupation, setOccupation] = useState('')
    const [dob, setDob] = useState('')
    const [email, setEmail] = useState('')

    function handleSubmit(e: React.FormEvent) {
        e.preventDefault()
        const cleanPhone = phone.replace(/\s+/g, '')
        if (!/^(0\d{9}|233\d{9})$/.test(cleanPhone)) {
            toast.error('Enter a valid phone number (0XXXXXXXXX)')
            return
        }
        if (!fullName.trim() || !idNumber.trim() || !region || !location.trim() || !occupation.trim() || !dob) {
            toast.error('Please fill in all required fields')
            return
        }
        if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
            toast.error('Enter a valid email or leave it blank')
            return
        }
        onSubmitDetails({
            full_name: fullName,
            phone: cleanPhone,
            id_type: 'Ghana Card',
            id_number: idNumber,
            region,
            location,
            occupation,
            date_of_birth: dob,
        }, email.trim())
    }

    const inputCls = 'w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2.5 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-amber-500'

    return (
        <form onSubmit={handleSubmit} className="space-y-3">
            <div className="rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 p-3">
                <p className="text-xs text-amber-800 dark:text-amber-300">
                    Register your SIM with your Ghana Card. Your details are sent securely and used only for this registration.
                </p>
            </div>

            <input required value={fullName} onChange={e => setFullName(e.target.value)} maxLength={100}
                placeholder="Full Name (as on Ghana Card)" className={inputCls} />

            <input required value={phone} onChange={e => setPhone(e.target.value)} inputMode="tel"
                placeholder="Phone Number to register (0XXXXXXXXX)" className={inputCls} />

            <input required value={idNumber} onChange={e => setIdNumber(e.target.value.toUpperCase())}
                placeholder="Ghana Card Number (GHA-XXXXXXXXX-X)" className={inputCls} />

            <select required value={region} onChange={e => setRegion(e.target.value)} className={inputCls}>
                <option value="">Select Region</option>
                {VALID_REGIONS.map(r => <option key={r} value={r}>{r}</option>)}
            </select>

            <input required value={location} onChange={e => setLocation(e.target.value)} maxLength={100}
                placeholder="Town / Area" className={inputCls} />

            <input required value={occupation} onChange={e => setOccupation(e.target.value)} maxLength={100}
                placeholder="Occupation" className={inputCls} />

            <div>
                <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-1">
                    Date of Birth (must be 18+)
                </label>
                <input required type="date" value={dob} onChange={e => setDob(e.target.value)} className={inputCls} />
            </div>

            <input type="email" value={email} onChange={e => setEmail(e.target.value)} maxLength={254}
                placeholder="Email (optional — for your receipt)" className={inputCls} />

            <button type="submit"
                className="w-full flex items-center justify-center gap-2 rounded-xl bg-amber-600 hover:bg-amber-700 disabled:opacity-60 px-4 py-3 text-sm font-black text-white transition-colors">
                Continue to Payment{displayPrice ? ` — GHS ${displayPrice.toFixed(2)}` : ''}
            </button>
        </form>
    )
}
