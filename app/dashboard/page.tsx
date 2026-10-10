'use client'

import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { useAuth } from '@/contexts/auth-context'
import { useUI } from '@/contexts/ui-context'
import { supabase } from '@/lib/supabase'
import { useDashboardSummary } from '@/hooks/use-dashboard-summary'

import { PromoCarousel } from '@/components/promo-carousel/PromoCarousel'
import { buildDashboardSlides } from '@/lib/promo-carousel/dashboard-slides'
import { RoleGreetingBox } from '@/components/dashboard/RoleGreetingBox'
import {
    WebsiteRequestBanner,
    type ActiveWebsiteRequest,
} from '@/components/dashboard/WebsiteRequestBanner'
import { TodaysOrdersSummary } from '@/components/dashboard/TodaysOrdersSummary'
import { WalletHero } from '@/components/dashboard/home/WalletHero'
import { OrderTracker } from '@/components/dashboard/home/OrderTracker'
import { StatusStrip } from '@/components/dashboard/home/StatusStrip'
import { SpendInsights } from '@/components/dashboard/home/SpendInsights'
import { QuickActions } from '@/components/dashboard/home/QuickActions'

const MtnWhitelistChecker = dynamic(
    () => import('@/components/mtn-whitelist-checker').then(m => m.MtnWhitelistChecker),
    { ssr: false },
)

// NEXT_PUBLIC_ vars inline at build time — keep as a module const.
const USSD_SHORTCODE = process.env.NEXT_PUBLIC_USSD_SHORTCODE ?? '*713*9939#'

// `website_requests` is not in the generated Database types, so this one call goes
// through a narrow structural cast of the query chain we actually use.
type WebsiteRequestQuery = {
    from: (table: 'website_requests') => {
        select: (columns: string) => {
            eq: (column: string, value: string) => {
                in: (column: string, values: string[]) => {
                    order: (column: string, opts: { ascending: boolean }) => {
                        limit: (n: number) => {
                            maybeSingle: () => Promise<{ data: ActiveWebsiteRequest | null; error: unknown }>
                        }
                    }
                }
            }
        }
    }
}

const SKELETON = 'bg-muted rounded-xl motion-safe:animate-pulse'
const FOCUS_RING =
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ft-blue focus-visible:ring-offset-2 focus-visible:ring-offset-background'

export default function DashboardPage() {
    const { dbUser, isAdmin } = useAuth()
    const { activeAnnouncement, reopenAnnouncement } = useUI()
    const { summary, error, refresh } = useDashboardSummary()
    const [websiteRequest, setWebsiteRequest] = useState<ActiveWebsiteRequest | null>(null)
    const [hasShop, setHasShop] = useState(false)
    // Mounted on first open only, so the checker's code isn't loaded until someone asks for it.
    const [whitelistMounted, setWhitelistMounted] = useState(false)
    const [whitelistOpen, setWhitelistOpen] = useState(false)

    const userId = dbUser?.id

    // Small extras (banner state + shop existence) fetched in parallel with the summary hook.
    // Errors degrade to "no active request" / "no shop" rather than failing the dashboard.
    // Results are ignored if the user changes or the page unmounts before they resolve.
    // Also refetches (with the summary) on the pull-to-refresh 'app-refresh' event.
    useEffect(() => {
        setWebsiteRequest(null)
        setHasShop(false)
        if (!userId) return

        let cancelled = false

        const loadExtras = async () => {
            const [websiteRes, shopRes] = await Promise.all([
                (supabase as unknown as WebsiteRequestQuery)
                    .from('website_requests')
                    .select('id, status, request_type, created_at')
                    .eq('user_id', userId)
                    .in('status', ['new', 'contacted'])
                    .order('created_at', { ascending: false })
                    .limit(1)
                    .maybeSingle(),
                supabase.from('shop_profiles').select('id').eq('owner_id', userId).maybeSingle(),
            ])
            if (cancelled) return
            setWebsiteRequest(websiteRes.error ? null : websiteRes.data)
            setHasShop(!shopRes.error && !!shopRes.data)
        }

        loadExtras().catch(() => {
            if (cancelled) return
            setWebsiteRequest(null)
            setHasShop(false)
        })

        const handleRefresh = () => {
            void refresh()
            loadExtras().catch(() => {})
        }
        window.addEventListener('app-refresh', handleRefresh)
        return () => {
            cancelled = true
            window.removeEventListener('app-refresh', handleRefresh)
        }
    }, [userId, refresh])

    // Sub-Agents shortcut — agent/dealer/admin only, same gate as the sidebar's
    // Sub-Agents link; a sub-agent can never recruit, so 'subagent' is excluded.
    const showSubAgents = isAdmin || dbUser?.role === 'agent' || dbUser?.role === 'dealer'

    return (
        <div className="ft-flat space-y-2 sm:space-y-3">
            <RoleGreetingBox stats={summary ? { totalOrders: summary.counts.total } : undefined} />
            <WebsiteRequestBanner activeRequest={websiteRequest} />

            <div className="flex flex-col gap-2 sm:gap-3 lg:grid lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
                {/* Left column */}
                <div className="contents lg:flex lg:flex-col lg:gap-3 lg:col-start-1">
                    {summary ? (
                        <>
                            <div className="order-2">
                                <WalletHero balance={summary.wallet_balance} />
                            </div>
                            {summary.active_order && (
                                <div className="order-3">
                                    <OrderTracker order={summary.active_order} />
                                </div>
                            )}
                            <div className="order-4">
                                <StatusStrip counts={summary.counts} />
                            </div>
                            <div className="order-5">
                                <SpendInsights spend={summary.spend} />
                            </div>
                        </>
                    ) : error ? (
                        <div className="order-2 bg-card border border-border rounded-xl p-3 sm:p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-3">
                            <p className="text-sm text-foreground">Couldn&apos;t load your summary.</p>
                            <button
                                type="button"
                                onClick={() => void refresh()}
                                className={`bg-ft-blue text-white rounded-xl h-11 px-4 text-sm font-medium ${FOCUS_RING}`}
                            >
                                Try again
                            </button>
                        </div>
                    ) : (
                        <>
                            <div className="order-2">
                                <WalletHero balance={null} />
                            </div>
                            <div className={`${SKELETON} h-[180px] order-4`} aria-hidden="true" />
                            <div className={`${SKELETON} h-[140px] order-5`} aria-hidden="true" />
                        </>
                    )}
                </div>

                {/* Right rail */}
                <div className="contents lg:flex lg:flex-col lg:gap-3 lg:col-start-2 lg:row-start-1">
                    <div className="order-7 lg:order-1">
                        <QuickActions showSubAgents={showSubAgents} />
                    </div>
                    <div className="order-6 lg:order-2">
                        <TodaysOrdersSummary />
                    </div>
                    <div className="order-1 lg:order-3">
                        <PromoCarousel
                            slides={buildDashboardSlides({
                                role: dbUser?.role,
                                hasShop,
                                ussdShortcode: USSD_SHORTCODE,
                                announcement: activeAnnouncement,
                                onOpenAnnouncement: reopenAnnouncement,
                                onOpenWhitelistCheck: () => {
                                    setWhitelistMounted(true)
                                    setWhitelistOpen(true)
                                },
                            })}
                        />
                    </div>
                </div>
            </div>

            {whitelistMounted && <MtnWhitelistChecker open={whitelistOpen} onOpenChange={setWhitelistOpen} />}
        </div>
    )
}
