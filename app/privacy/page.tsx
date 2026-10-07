import { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft, ShieldCheck, Database, Eye, Share2, Lock } from 'lucide-react'

export const metadata: Metadata = {
    title: 'Privacy Policy | KiNG FLEXY GH',
    description: 'Read the official Privacy Policy for KiNG FLEXY GH Data and Airtime platform.',
}

export default function PrivacyPage() {
    return (
        <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col pt-16 transition-colors duration-300">
            {/* Header */}
            <div className="fixed top-0 left-0 w-full z-50 shadow-sm bg-slate-900 dark:bg-black h-14 flex items-center px-4">
                <div className="max-w-3xl mx-auto w-full flex items-center gap-3">
                    <Link href="/" className="p-1.5 bg-white/10 hover:bg-white/20 rounded-lg text-white transition-colors">
                        <ArrowLeft className="w-5 h-5" />
                    </Link>
                    <span className="text-white font-bold text-sm tracking-widest uppercase opacity-90">Privacy Policy</span>
                </div>
            </div>

            <div className="flex-1 w-full max-w-3xl mx-auto px-4 py-8 space-y-8">
                {/* 1. Header Section */}
                <div className="bg-white dark:bg-slate-900 rounded-[2rem] p-6 sm:p-8 shadow-sm border border-slate-100 dark:border-slate-800 text-center relative overflow-hidden">
                    <div className="absolute top-0 left-0 w-full h-24 bg-emerald-500 opacity-10" />
                    <div className="relative z-10 flex flex-col items-center">
                        <div className="w-20 h-20 rounded-3xl shadow-xl border-4 border-white mb-4 bg-slate-900 flex items-center justify-center text-white">
                            <ShieldCheck className="w-8 h-8" />
                        </div>
                        <h1 className="text-2xl font-black text-slate-900 dark:text-white capitalize">Privacy Policy</h1>
                        <p className="mt-3 text-sm font-medium text-slate-500 dark:text-slate-400 max-w-sm mx-auto leading-relaxed">
                            Your privacy is important to us. Learn how we collect, use, and protect your personal information on KiNG FLEXY GH.
                        </p>
                    </div>
                </div>

                {/* 2. Privacy Content */}
                <div className="bg-white dark:bg-slate-900 rounded-3xl p-6 sm:p-8 shadow-sm border border-slate-100 dark:border-slate-800">
                    <div className="space-y-8">
                        <div className="flex gap-4">
                            <div className="flex-shrink-0 mt-1">
                                <Database className="w-6 h-6 text-emerald-500" />
                            </div>
                            <div>
                                <h3 className="text-base font-black text-slate-900 dark:text-white mb-1">1. Information We Collect</h3>
                                <p className="text-sm font-medium text-slate-500 dark:text-slate-400 leading-relaxed">
                                    When you register, we collect your name, email address, and phone number. We also record transaction histories, wallet balances, and the recipient numbers you enter for data/airtime purchases.
                                </p>
                            </div>
                        </div>

                        <div className="flex gap-4">
                            <div className="flex-shrink-0 mt-1">
                                <Eye className="w-6 h-6 text-sky-500" />
                            </div>
                            <div>
                                <h3 className="text-base font-black text-slate-900 dark:text-white mb-1">2. How We Use Your Information</h3>
                                <div className="text-sm font-medium text-slate-500 dark:text-slate-400 leading-relaxed space-y-2">
                                    <p>We use your data strictly to:</p>
                                    <ul className="list-disc pl-5 space-y-1">
                                        <li>Process and fulfill your orders instantly.</li>
                                        <li>Send transactional SMS alerts and emails (e.g., order success, wallet top-ups).</li>
                                        <li>Manage your Flexy-Wallet and Agent status.</li>
                                        <li>Provide customer support and resolve disputes.</li>
                                    </ul>
                                </div>
                            </div>
                        </div>

                        <div className="flex gap-4">
                            <div className="flex-shrink-0 mt-1">
                                <Lock className="w-6 h-6 text-indigo-500" />
                            </div>
                            <div>
                                <h3 className="text-base font-black text-slate-900 dark:text-white mb-1">3. Data Protection</h3>
                                <p className="text-sm font-medium text-slate-500 dark:text-slate-400 leading-relaxed">
                                    We implement strict security measures to protect your personal information. Passwords are cryptographically hashed, and payment information is securely processed by our payment partners (Paystack). We do not store raw credit card details on our servers.
                                </p>
                            </div>
                        </div>

                        <div className="flex gap-4">
                            <div className="flex-shrink-0 mt-1">
                                <Share2 className="w-6 h-6 text-amber-500" />
                            </div>
                            <div>
                                <h3 className="text-base font-black text-slate-900 dark:text-white mb-1">4. Third-Party Sharing</h3>
                                <div className="text-sm font-medium text-slate-500 dark:text-slate-400 leading-relaxed space-y-2">
                                    <p>We do not sell your personal data. We only share necessary transaction details with:</p>
                                    <ul className="list-disc pl-5 space-y-1">
                                        <li>Telecommunication networks (MTN, Telecel, AT) to fulfill your orders.</li>
                                        <li>Payment processors (Paystack, Moolre) to handle deposits and withdrawals.</li>
                                        <li>SMS providers to deliver transaction alerts.</li>
                                    </ul>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="text-center pb-10">
                    <p className="text-sm text-slate-400">Last updated: April 2026</p>
                </div>
            </div>
        </div>
    )
}
