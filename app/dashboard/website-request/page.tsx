// app/dashboard/website-request/page.tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/contexts/auth-context'
import { Button } from '@/components/ui/button'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import {
    Check, PhoneCall, ShieldCheck, Wallet, Clock,
    Lightbulb, Loader2, ArrowLeft,
} from 'lucide-react'
import {
    WEBSITE_REQUEST_CATEGORIES,
    CATEGORY_FEATURES,
    TIMELINE_OPTIONS,
} from '@/lib/website-request-categories'

type Mode = 'full' | 'call'

const BUDGET_PRESETS = [1000, 3000, 8000, 20000]

// Starter sentences — the blank textarea is the hardest part of this form, so we
// hand people a first line they can edit rather than an empty box.
const DESCRIPTION_STARTERS = [
    { label: 'An online store', text: 'I want an online store like Jumia where customers can browse my products, pay with Mobile Money, and I can manage stock and orders.' },
    { label: 'A business website', text: 'I want a professional website for my business showing who we are, the services we offer, and a way for customers to contact us.' },
    { label: 'A booking site', text: 'I want a site where customers can see my available times and book an appointment themselves, and I get notified for each booking.' },
    { label: 'A mobile app', text: 'I want a mobile app for Android and iPhone that my customers can download and use to order from me directly.' },
]

function SectionHeading({ step, title, hint }: { step: number; title: string; hint?: string }) {
    return (
        <div className="mb-3 flex items-start gap-2.5">
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-[11px] font-bold text-white dark:bg-indigo-500">
                {step}
            </span>
            <div className="min-w-0">
                <h2 className="text-sm font-bold text-foreground">{title}</h2>
                {hint && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{hint}</p>}
            </div>
        </div>
    )
}

const fieldClass =
    'w-full rounded-xl border border-border bg-background p-3 text-sm text-foreground ' +
    'placeholder:text-muted-foreground focus:border-indigo-500 focus:outline-none ' +
    'focus:ring-2 focus:ring-indigo-500/20 transition'

export default function WebsiteRequestPage() {
    const { dbUser } = useAuth()
    const router = useRouter()
    const [mode, setMode] = useState<Mode>('full')
    const [isSubmitting, setIsSubmitting] = useState(false)

    const [category, setCategory] = useState('')
    const [budget, setBudget] = useState('')
    const [features, setFeatures] = useState<string[]>([])
    const [timeline, setTimeline] = useState('')
    const [description, setDescription] = useState('')
    const [referenceSites, setReferenceSites] = useState('')
    const [confirmSerious, setConfirmSerious] = useState(false)

    const [callNote, setCallNote] = useState('')

    const [contactPhone, setContactPhone] = useState(dbUser?.phone_number ?? '')
    const [contactWhatsapp, setContactWhatsapp] = useState('')

    const toggleFeature = (key: string) => {
        setFeatures(prev => prev.includes(key) ? prev.filter(f => f !== key) : [...prev, key])
    }

    const applyStarter = (text: string) => {
        setDescription(prev => (prev.trim() ? `${prev.trim()}\n${text}` : text))
    }

    const submitFull = async () => {
        const budgetNum = Number(budget)
        if (!category) return toast.error('Please choose what you want built')
        if (!budgetNum || budgetNum < 1000) return toast.error('Budget guide must be at least GHS 1,000')
        if (!timeline) return toast.error('Please choose a timeline')
        if (description.trim().length < 10) return toast.error('Please describe your project (at least 10 characters)')
        if (!contactPhone) return toast.error('Please provide a contact phone number')
        if (!confirmSerious) return toast.error('Please confirm this is a genuine project request')

        setIsSubmitting(true)
        try {
            const res = await fetch('/api/user/website-requests', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    request_type: 'full_request',
                    category,
                    budget_ghs: budgetNum,
                    features,
                    timeline,
                    description,
                    reference_sites: referenceSites,
                    contact_phone: contactPhone,
                    contact_whatsapp: contactWhatsapp,
                    confirm_serious: confirmSerious,
                }),
            })
            const json = await res.json()
            if (!json.success) {
                toast.error(json.details?.[0] || json.error || 'Failed to submit request')
                return
            }
            toast.success('Request sent. We\'ll call you shortly.')
            router.push('/dashboard')
        } catch {
            toast.error('Something went wrong. Please check your connection and try again.')
        } finally {
            setIsSubmitting(false)
        }
    }

    const submitCall = async () => {
        if (callNote.trim().length < 5) return toast.error('Please briefly tell us what you want to discuss')
        if (!contactPhone) return toast.error('Please provide a contact phone number')

        setIsSubmitting(true)
        try {
            const res = await fetch('/api/user/website-requests', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    request_type: 'call_request',
                    description: callNote,
                    contact_phone: contactPhone,
                    contact_whatsapp: contactWhatsapp,
                }),
            })
            const json = await res.json()
            if (!json.success) {
                toast.error(json.details?.[0] || json.error || 'Failed to submit request')
                return
            }
            toast.success('Call request sent. We\'ll be in touch shortly.')
            router.push('/dashboard')
        } catch {
            toast.error('Something went wrong. Please check your connection and try again.')
        } finally {
            setIsSubmitting(false)
        }
    }

    const activeFeatures = category ? (CATEGORY_FEATURES[category] ?? []) : []

    return (
        <div className="mx-auto max-w-2xl space-y-4 p-4 pb-10">

            {/* Header */}
            <div>
                <button
                    type="button"
                    onClick={() => router.push('/dashboard')}
                    className="mb-3 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground"
                >
                    <ArrowLeft className="h-3.5 w-3.5" />
                    Back to dashboard
                </button>
                <h1 className="text-2xl font-black tracking-tight text-foreground">
                    Start your project
                </h1>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                    Tell us what you want built. We&apos;ll review it, call you to talk through the
                    details, and send you a quote — no payment at this stage.
                </p>

                {/* Trust strip */}
                <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 rounded-xl border border-border bg-card p-3">
                    {[
                        { Icon: Wallet, text: 'Nothing to pay now' },
                        { Icon: PhoneCall, text: 'Free consultation call' },
                        { Icon: ShieldCheck, text: 'Your details stay private' },
                    ].map(({ Icon, text }) => (
                        <span key={text} className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                            <Icon className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" />
                            {text}
                        </span>
                    ))}
                </div>
            </div>

            {/* Mode switch — both paths visible up front */}
            <div className="grid grid-cols-2 gap-1.5 rounded-xl border border-border bg-muted/40 p-1.5">
                {([
                    { key: 'full' as Mode, label: 'Describe my project' },
                    { key: 'call' as Mode, label: 'Just request a call' },
                ]).map(({ key, label }) => (
                    <button
                        key={key}
                        type="button"
                        onClick={() => setMode(key)}
                        className={cn(
                            'rounded-lg px-3 py-2 text-xs font-semibold transition sm:text-sm',
                            mode === key
                                ? 'bg-card text-foreground shadow-sm'
                                : 'text-muted-foreground hover:text-foreground'
                        )}
                    >
                        {label}
                    </button>
                ))}
            </div>

            {mode === 'full' ? (
                <div className="space-y-4">

                    {/* 1. Category */}
                    <section className="rounded-2xl border border-border bg-card p-5">
                        <SectionHeading step={1} title="What do you want built?" />
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                            {WEBSITE_REQUEST_CATEGORIES.map(c => {
                                const selected = category === c.key
                                return (
                                    <button
                                        key={c.key}
                                        type="button"
                                        onClick={() => { setCategory(c.key); setFeatures([]) }}
                                        className={cn(
                                            'flex items-center justify-between gap-2 rounded-xl border p-3 text-left text-sm font-medium transition',
                                            selected
                                                ? 'border-indigo-500 bg-indigo-50 text-indigo-900 ring-1 ring-indigo-500 dark:bg-indigo-950/50 dark:text-indigo-100'
                                                : 'border-border bg-background text-foreground hover:border-indigo-300 hover:bg-muted/50 dark:hover:border-indigo-800'
                                        )}
                                    >
                                        <span className="min-w-0">{c.label}</span>
                                        {selected && <Check className="h-4 w-4 shrink-0 text-indigo-600 dark:text-indigo-400" />}
                                    </button>
                                )
                            })}
                        </div>
                    </section>

                    {/* 2. Features */}
                    {activeFeatures.length > 0 && (
                        <section className="rounded-2xl border border-border bg-card p-5">
                            <SectionHeading
                                step={2}
                                title="What should it include?"
                                hint="Pick anything that applies — you can add more later, nothing is locked in."
                            />
                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                {activeFeatures.map(f => {
                                    const checked = features.includes(f.key)
                                    return (
                                        <button
                                            key={f.key}
                                            type="button"
                                            onClick={() => toggleFeature(f.key)}
                                            className={cn(
                                                'flex items-center gap-2.5 rounded-xl border p-2.5 text-left text-sm transition',
                                                checked
                                                    ? 'border-indigo-500 bg-indigo-50 text-indigo-900 dark:bg-indigo-950/50 dark:text-indigo-100'
                                                    : 'border-border bg-background text-foreground hover:bg-muted/50'
                                            )}
                                        >
                                            <span className={cn(
                                                'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition',
                                                checked
                                                    ? 'border-indigo-600 bg-indigo-600 text-white dark:border-indigo-500 dark:bg-indigo-500'
                                                    : 'border-border'
                                            )}>
                                                {checked && <Check className="h-3 w-3" />}
                                            </span>
                                            <span className="min-w-0">{f.label}</span>
                                        </button>
                                    )
                                })}
                            </div>
                        </section>
                    )}

                    {/* 3. Description */}
                    <section className="rounded-2xl border border-border bg-card p-5">
                        <SectionHeading
                            step={3}
                            title="Tell us about it"
                            hint="The more detail you give, the more accurate your quote will be."
                        />

                        {/* Tips */}
                        <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/50 dark:bg-amber-950/30">
                            <p className="flex items-center gap-1.5 text-xs font-bold text-amber-900 dark:text-amber-300">
                                <Lightbulb className="h-3.5 w-3.5" />
                                Helpful things to mention
                            </p>
                            <ul className="mt-1.5 space-y-1 text-xs leading-relaxed text-amber-900/80 dark:text-amber-200/80">
                                <li>• What your business does and who your customers are</li>
                                <li>• Any website or app you like — even a rough example helps</li>
                                <li>• What you want visitors to be able to do on it</li>
                            </ul>
                        </div>

                        {/* Starters */}
                        <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                            Not sure where to start? Tap one to fill it in, then edit:
                        </p>
                        <div className="mb-3 flex flex-wrap gap-1.5">
                            {DESCRIPTION_STARTERS.map(s => (
                                <button
                                    key={s.label}
                                    type="button"
                                    onClick={() => applyStarter(s.text)}
                                    className="rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition hover:border-indigo-400 hover:bg-indigo-50 dark:hover:border-indigo-700 dark:hover:bg-indigo-950/40"
                                >
                                    {s.label}
                                </button>
                            ))}
                        </div>

                        <textarea
                            value={description}
                            onChange={e => setDescription(e.target.value.slice(0, 2000))}
                            rows={6}
                            maxLength={2000}
                            placeholder="Example: I run a fashion shop in Accra. I want an online store where customers can see my clothes, pay with MoMo, and I can add new items myself…"
                            className={fieldClass}
                        />
                        <p className="mt-1 text-right text-xs text-muted-foreground">{description.length}/2000</p>

                        {/* Reference sites */}
                        <div className="mt-3">
                            <label className="text-sm font-semibold text-foreground">
                                Websites or apps you like{' '}
                                <span className="font-normal text-muted-foreground">(optional)</span>
                            </label>
                            <p className="mt-0.5 text-xs text-muted-foreground">
                                Names or links are both fine — it helps us match the style you want.
                            </p>
                            <input
                                type="text"
                                value={referenceSites}
                                onChange={e => setReferenceSites(e.target.value.slice(0, 300))}
                                maxLength={300}
                                placeholder="e.g. jumia.com.gh, or “something like kingflexygh.com”"
                                className={cn(fieldClass, 'mt-1.5')}
                            />
                        </div>
                    </section>

                    {/* 4. Budget & timeline */}
                    <section className="rounded-2xl border border-border bg-card p-5">
                        <SectionHeading step={4} title="Budget and timing" />

                        <label className="text-sm font-semibold text-foreground">Your budget guide (GHS)</label>
                        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                            This is <span className="font-semibold text-foreground">not a payment</span> and
                            not a fixed price. It just tells us what scale of solution to design for. We agree
                            the final cost with you after we&apos;ve talked.
                        </p>
                        <input
                            type="number"
                            min={1000}
                            value={budget}
                            onChange={e => setBudget(e.target.value)}
                            placeholder="Minimum 1,000"
                            className={cn(fieldClass, 'mt-2')}
                        />
                        <div className="mt-2 flex flex-wrap gap-1.5">
                            {BUDGET_PRESETS.map(amount => (
                                <button
                                    key={amount}
                                    type="button"
                                    onClick={() => setBudget(String(amount))}
                                    className={cn(
                                        'rounded-full border px-3 py-1.5 text-xs font-medium transition',
                                        Number(budget) === amount
                                            ? 'border-indigo-500 bg-indigo-50 text-indigo-900 dark:bg-indigo-950/50 dark:text-indigo-100'
                                            : 'border-border bg-background text-foreground hover:bg-muted/50'
                                    )}
                                >
                                    {amount.toLocaleString()}
                                </button>
                            ))}
                        </div>

                        <div className="mt-5">
                            <label className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                                <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                                When do you need it?
                            </label>
                            <div className="mt-2 flex flex-wrap gap-1.5">
                                {TIMELINE_OPTIONS.map(t => (
                                    <button
                                        key={t.key}
                                        type="button"
                                        onClick={() => setTimeline(t.key)}
                                        className={cn(
                                            'rounded-full border px-3.5 py-1.5 text-xs font-medium transition',
                                            timeline === t.key
                                                ? 'border-indigo-500 bg-indigo-50 text-indigo-900 dark:bg-indigo-950/50 dark:text-indigo-100'
                                                : 'border-border bg-background text-foreground hover:bg-muted/50'
                                        )}
                                    >
                                        {t.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </section>

                    {/* 5. Contact */}
                    <section className="rounded-2xl border border-border bg-card p-5">
                        <SectionHeading step={5} title="How should we reach you?" hint="We call or WhatsApp — we never share your number." />
                        <label className="text-sm font-semibold text-foreground">Phone number</label>
                        <input
                            type="tel"
                            value={contactPhone}
                            onChange={e => setContactPhone(e.target.value)}
                            placeholder="0241234567"
                            className={cn(fieldClass, 'mt-1.5')}
                        />
                        <label className="mt-3 block text-sm font-semibold text-foreground">
                            WhatsApp <span className="font-normal text-muted-foreground">(optional)</span>
                        </label>
                        <p className="mt-0.5 text-xs text-muted-foreground">Leave blank to use the number above.</p>
                        <input
                            type="tel"
                            value={contactWhatsapp}
                            onChange={e => setContactWhatsapp(e.target.value)}
                            placeholder="0241234567"
                            className={cn(fieldClass, 'mt-1.5')}
                        />
                    </section>

                    {/* Confirm + submit */}
                    <div className="rounded-2xl border border-border bg-card p-5">
                        <label className="flex cursor-pointer items-start gap-2.5">
                            <input
                                type="checkbox"
                                checked={confirmSerious}
                                onChange={e => setConfirmSerious(e.target.checked)}
                                className="mt-0.5 h-4 w-4 shrink-0 accent-indigo-600"
                            />
                            <span className="text-xs leading-relaxed text-muted-foreground">
                                This is a genuine project I want to move forward with, and I&apos;m happy for the
                                KiNG FLEXY GH team to contact me about it.
                            </span>
                        </label>

                        <Button
                            onClick={submitFull}
                            disabled={isSubmitting}
                            className="mt-4 h-12 w-full rounded-xl bg-indigo-600 text-sm font-bold text-white hover:bg-indigo-700 dark:bg-indigo-500 dark:hover:bg-indigo-400"
                        >
                            {isSubmitting ? (
                                <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Sending…</>
                            ) : 'Send my project request'}
                        </Button>
                        <p className="mt-2 text-center text-xs text-muted-foreground">
                            No payment is taken now. We&apos;ll call you before anything is agreed.
                        </p>
                    </div>
                </div>
            ) : (
                /* ── Call-back request ─────────────────────────────────── */
                <div className="space-y-4">
                    <section className="rounded-2xl border border-border bg-card p-5">
                        <div className="mb-4 flex items-start gap-3">
                            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-100 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-400">
                                <PhoneCall className="h-5 w-5" />
                            </span>
                            <div className="min-w-0">
                                <h2 className="text-sm font-bold text-foreground">Request a call back</h2>
                                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                                    Not ready to write it all out? Leave your number and a short note —
                                    we&apos;ll call and work through it with you.
                                </p>
                            </div>
                        </div>

                        <label className="text-sm font-semibold text-foreground">Phone number</label>
                        <input
                            type="tel"
                            value={contactPhone}
                            onChange={e => setContactPhone(e.target.value)}
                            placeholder="0241234567"
                            className={cn(fieldClass, 'mt-1.5')}
                        />

                        <label className="mt-3 block text-sm font-semibold text-foreground">
                            WhatsApp <span className="font-normal text-muted-foreground">(optional)</span>
                        </label>
                        <input
                            type="tel"
                            value={contactWhatsapp}
                            onChange={e => setContactWhatsapp(e.target.value)}
                            placeholder="Leave blank to use the number above"
                            className={cn(fieldClass, 'mt-1.5')}
                        />

                        <label className="mt-3 block text-sm font-semibold text-foreground">
                            What would you like to discuss?
                        </label>
                        <textarea
                            value={callNote}
                            onChange={e => setCallNote(e.target.value.slice(0, 2000))}
                            rows={4}
                            maxLength={2000}
                            placeholder="e.g. I run a pharmacy and I'm thinking about selling online, but I'm not sure what I need."
                            className={cn(fieldClass, 'mt-1.5')}
                        />
                        <p className="mt-1 text-right text-xs text-muted-foreground">{callNote.length}/2000</p>

                        <Button
                            onClick={submitCall}
                            disabled={isSubmitting}
                            className="mt-4 h-12 w-full rounded-xl bg-indigo-600 text-sm font-bold text-white hover:bg-indigo-700 dark:bg-indigo-500 dark:hover:bg-indigo-400"
                        >
                            {isSubmitting ? (
                                <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Sending…</>
                            ) : 'Request a call back'}
                        </Button>
                    </section>
                </div>
            )}
        </div>
    )
}
