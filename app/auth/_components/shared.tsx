import { Loader2, Shield, CreditCard, AlertTriangle, Clock, UserCheck } from 'lucide-react'

// ─── Terms content ────────────────────────────────────────────────────────────
export const TERMS_SECTIONS = [
    {
        icon: Shield,
        color: 'text-sky-500',
        title: '1. Account Security',
        body: 'You are responsible for maintaining the confidentiality of your login credentials. Any transaction performed through your account is considered authorized by you.',
    },
    {
        icon: CreditCard,
        color: 'text-emerald-500',
        title: '2. Non-Refundable Policy',
        body: 'Due to the instant nature of digital assets (Data, Airtime, Vouchers), all successful transactions are final and non-refundable.',
    },
    {
        icon: AlertTriangle,
        color: 'text-amber-500',
        title: '3. Buyer Accuracy Guarantee',
        body: "You are solely responsible for ensuring that the recipient's phone number and selected telecommunications network are 100% accurate before confirming an order. We are not liable for items sent to an incorrect number due to user input errors.",
    },
    {
        icon: Clock,
        color: 'text-blue-500',
        title: '4. Processing Times & 24hr Reporting',
        body: 'While 99% of transactions hit the entered number within seconds, telecommunications networks may experience downtime. Customers must report non-received orders within 24 hours of purchase. Failure to report within this window may result in the loss of eligibility for fulfillment.',
    },
    {
        icon: AlertTriangle,
        color: 'text-purple-500',
        title: '5. Payment Verification & Stay-on-Page',
        body: 'To ensure orders are processed instantly, you MUST NOT close the payment tab until you see the final confirmation screen. Failure to wait may result in delayed fulfillment.',
    },
    {
        icon: UserCheck,
        color: 'text-indigo-500',
        title: '6. Agent & Shop Roles',
        body: 'Users who purchase Agent upgrades or open Shops are bound by the pricing and operational guidelines set by KiNG FLEXY GH. We reserve the right to suspend accounts that abuse the platform or violate network provider rules.',
    },
]

// ─── Google icon ──────────────────────────────────────────────────────────────
export function GoogleIcon() {
    return (
        <svg viewBox="0 0 24 24" className="w-5 h-5 flex-shrink-0" xmlns="http://www.w3.org/2000/svg">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05" />
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
        </svg>
    )
}

export function GoogleButton({ label, isLoading, onClick }: { label: string; isLoading: boolean; onClick: () => void }) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={isLoading}
            className="w-full flex items-center justify-center gap-3 h-11 px-4 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700/80 text-slate-700 dark:text-slate-200 font-semibold text-sm shadow-sm transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed"
        >
            {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <GoogleIcon />}
            <span>{label}</span>
        </button>
    )
}

export function OrDivider() {
    return (
        <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-slate-200 dark:bg-slate-700/60" />
            <span className="text-xs font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-widest">or</span>
            <div className="flex-1 h-px bg-slate-200 dark:bg-slate-700/60" />
        </div>
    )
}

export function BrandAccentLine() {
    return <div className="h-1 w-full bg-gradient-to-r from-[#0056B3] via-[#00B4D8] to-[#FFCC00]" />
}
