import { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { createServerClient } from '@/lib/supabase'
import Image from 'next/image'
import Link from 'next/link'
import { ArrowLeft, Phone, Mail, MessageCircle, MapPin, ShieldCheck, Clock, CheckCircle2, AlertTriangle, Users, BookOpen } from 'lucide-react'
import { CopyrightFooter } from '@/components/CopyrightFooter'
import { TermsSectionsLive } from '@/components/terms/terms-sections-live'

interface Props {
    params: Promise<{ shopSlug: string }>
}

export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const { shopSlug } = await params
    const supabase = createServerClient()

    const { data: shop } = await (supabase
        .from('shop_profiles')
        .select('shop_name, description')
        .eq('shop_slug', shopSlug)
        .eq('approval_status', 'approved')
        .eq('is_active', true)
        .single() as any)

    if (!shop) return { title: 'Not Found' }

    return {
        title: `About ${shop.shop_name}`,
        description: `Learn more about ${shop.shop_name} and our official terms of service.`,
    }
}

export default async function ShopAboutPage({ params }: Props) {
    const { shopSlug } = await params
    const supabase = createServerClient()

    const { data: shop } = await (supabase
        .from('shop_profiles')
        .select('shop_name, description, owner_phone, owner_email, whatsapp_number, logo_url, community_link, brand_color, is_active, approval_status')
        .eq('shop_slug', shopSlug)
        .single() as any)

    if (!shop) {
        notFound()
    }

    const { data: adminSettings } = await (supabase
        .from('admin_settings')
        .select('key, value')
        .in('key', ['copyright_footer_enabled', 'copyright_footer_text', 'copyright_footer_link_url', 'copyright_footer_link_text']) as any)
        
    const settingsMap: Record<string, string> = {}
    for (const row of adminSettings || []) {
        settingsMap[row.key] = row.value
    }

    const brandColor = shop.brand_color || '#2563eb'
    const isValidHex = (color: string) => /^#([A-Fa-f0-9]{3}){1,4}$/.test(color)
    const safeBrandColor = isValidHex(brandColor) ? brandColor : '#2563eb'

    return (
        <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col theme-shop transition-colors duration-300">
            <style dangerouslySetInnerHTML={{ __html: `.theme-shop { --brand-color: ${safeBrandColor}; }` }} />

            {/* Permanent Header (Simplified) */}
            <div className="fixed top-0 left-0 w-full z-50 shadow-sm bg-[var(--brand-color)] h-14 flex items-center px-4">
                <div className="max-w-3xl mx-auto w-full flex items-center gap-3">
                    <Link href={`/${shopSlug}`} className="p-1.5 bg-white/10 hover:bg-white/20 rounded-lg text-white transition-colors">
                        <ArrowLeft className="w-5 h-5" />
                    </Link>
                    <span className="text-white font-bold text-sm tracking-widest uppercase opacity-90">About Shop</span>
                </div>
            </div>

            <div className="flex-1 w-full max-w-3xl mx-auto px-4 py-8 mt-14 space-y-8">
                {/* ── 1. Identity & Description ── */}
                <div className="bg-white dark:bg-slate-900 rounded-[2rem] p-6 sm:p-8 shadow-sm border border-slate-100 dark:border-slate-800 text-center relative overflow-hidden transition-colors">
                    <div className="absolute top-0 left-0 w-full h-24 bg-[var(--brand-color)] opacity-10" />
                    <div className="relative z-10 flex flex-col items-center">
                        {shop.logo_url ? (
                            <div className="w-32 h-32 rounded-full overflow-hidden mb-4">
                                <Image src={shop.logo_url} alt="Logo" width={128} height={128} className="w-full h-full object-contain" />
                            </div>
                        ) : (
                            <div className="w-32 h-32 rounded-full mb-4 bg-[var(--brand-color)] flex items-center justify-center text-white text-4xl font-black">
                                {shop.shop_name.charAt(0)}
                            </div>
                        )}
                        <h1 className="text-2xl font-black text-gray-900 dark:text-white capitalize">{shop.shop_name}</h1>
                        {shop.description && (
                            <p className="mt-3 text-sm font-medium text-gray-500 dark:text-gray-400 max-w-sm mx-auto leading-relaxed">
                                {shop.description}
                            </p>
                        )}
                    </div>
                </div>

                {/* ── 2. Official Contact Info ── */}
                <div className="bg-white dark:bg-slate-900 rounded-3xl p-6 shadow-sm border border-slate-100 dark:border-slate-800 transition-colors">
                    <div className="flex items-center gap-3 mb-6">
                        <div className="w-10 h-10 rounded-xl bg-blue-50 dark:bg-blue-900/20 flex items-center justify-center text-blue-600 dark:text-blue-400">
                            <Phone className="w-5 h-5" />
                        </div>
                        <h2 className="text-lg font-black text-gray-900 dark:text-white uppercase tracking-tighter">Contact & Support</h2>
                    </div>
                    
                    <div className="grid sm:grid-cols-2 gap-4">
                        <a href={`tel:${shop.owner_phone}`} className="flex items-center gap-4 p-4 rounded-2xl border border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors group">
                            <div className="w-10 h-10 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center text-gray-500 group-hover:text-emerald-600 transition-colors">
                                <Phone className="w-5 h-5" />
                            </div>
                            <div>
                                <p className="text-[10px] font-black uppercase text-gray-400 tracking-widest">Phone Line</p>
                                <p className="text-sm font-bold text-gray-900 dark:text-gray-100">{shop.owner_phone}</p>
                            </div>
                        </a>
                        
                        {shop.whatsapp_number && (
                            <a href={`https://wa.me/${shop.whatsapp_number}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-4 p-4 rounded-2xl border border-emerald-100 dark:border-emerald-900/30 bg-emerald-50/50 dark:bg-emerald-950/20 hover:bg-emerald-50 dark:hover:bg-emerald-900/40 transition-colors group">
                                <div className="w-10 h-10 rounded-full bg-[#25D366]/20 flex items-center justify-center text-[#25D366]">
                                    <MessageCircle className="w-5 h-5" />
                                </div>
                                <div>
                                    <p className="text-[10px] font-black uppercase text-emerald-600/70 tracking-widest">WhatsApp Chat</p>
                                    <p className="text-sm font-bold text-emerald-900 dark:text-emerald-300">Tap to Message</p>
                                </div>
                            </a>
                        )}

                        {shop.owner_email && (
                            <a href={`mailto:${shop.owner_email}`} className="flex items-center gap-4 p-4 rounded-2xl border border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors group sm:col-span-2">
                                <div className="w-10 h-10 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center text-gray-500 group-hover:text-blue-600 transition-colors">
                                    <Mail className="w-5 h-5" />
                                </div>
                                <div>
                                    <p className="text-[10px] font-black uppercase text-gray-400 tracking-widest">Support Email</p>
                                    <p className="text-sm font-bold text-gray-900 dark:text-gray-100">{shop.owner_email}</p>
                                </div>
                            </a>
                        )}
                    </div>
                </div>

                {/* ── 3. Community  ── */}
                {shop.community_link && (
                    <div className="bg-[var(--brand-color)] rounded-3xl p-6 sm:px-8 text-center sm:text-left sm:flex items-center justify-between shadow-md relative overflow-hidden">
                        <div className="absolute inset-0 opacity-10 bg-[url('https://www.transparenttextures.com/patterns/carbon-fibre.png')]" />
                        <div className="relative z-10 mb-5 sm:mb-0">
                            <h2 className="text-xl font-black text-white capitalize mb-1">Join Our Community</h2>
                            <p className="text-sm font-semibold text-white/80">Stay updated on the latest deals and network notices.</p>
                        </div>
                        <a href={shop.community_link} target="_blank" rel="noopener noreferrer" className="relative z-10 inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl bg-white text-gray-900 font-bold text-sm shadow-sm hover:scale-105 transition-transform">
                            <Users className="w-4 h-4 text-[var(--brand-color)]" /> Accept Invite
                        </a>
                    </div>
                )}

                {/* ── 4. Terms and Conditions ── */}
                <div className="bg-white dark:bg-slate-900 rounded-3xl p-6 shadow-sm border border-slate-100 dark:border-slate-800 transition-colors">
                    <div className="flex items-center gap-3 mb-6">
                        <div className="w-10 h-10 rounded-xl bg-purple-50 dark:bg-purple-900/20 flex items-center justify-center text-purple-600 dark:text-purple-400">
                            <BookOpen className="w-5 h-5" />
                        </div>
                        <h2 className="text-lg font-black text-gray-900 dark:text-white uppercase tracking-tighter">Terms & Conditions</h2>
                    </div>

                    <TermsSectionsLive className="space-y-6" brandName={shop.shop_name} />
                </div>

                <div className="pb-10">
                    <CopyrightFooter 
                        variant="shop" 
                        shopName={shop.shop_name} 
                        adminSettings={settingsMap}
                        className="py-10"
                    />
                </div>
            </div>
        </div>
    )
}
