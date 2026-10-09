import Link from 'next/link'
import { ArrowRight, Check, Gem } from 'lucide-react'
import { ClayButton, NeuCard, NeuTray } from '@/components/ft'
import { DEFAULT_AGENT_PLANS, isValidPlan, type LandingAgentPlan } from '@/components/landing/helpers'

const SHOP_POINTS = ['Your own branded shop link', 'Set your own profit margins', 'Track earnings and withdrawals']
const FLOW = ['Create shop', 'Set prices', 'Share your link', 'Earn profit']

export function ResellerPlans({ plans }: { plans: LandingAgentPlan[] }) {
    const valid = Array.isArray(plans) ? plans.filter(isValidPlan) : []
    const shown = valid.length > 0 ? valid : DEFAULT_AGENT_PLANS

    return (
        <section id="resell" aria-labelledby="resell-heading" className="ft-lazy scroll-mt-24 px-4 py-16 sm:px-6 lg:px-8">
            <div className="mx-auto max-w-7xl">
                <h2 id="resell-heading" className="ft-display max-w-2xl text-3xl font-extrabold tracking-tight text-ft-ink sm:text-4xl">
                    Start your own data shop.
                </h2>
                <p className="mt-3 max-w-2xl text-base text-[color:var(--ft-muted)]">
                    Create a branded storefront, set your own prices, share your link, and earn on every order.
                </p>
                <div className="mt-8 grid items-start gap-8 lg:grid-cols-2">
                    <div className="min-w-0">
                        <ul className="space-y-3">
                            {SHOP_POINTS.map(point => (
                                <li key={point} className="flex items-start gap-3 font-semibold text-ft-ink">
                                    <Check className="mt-0.5 h-5 w-5 shrink-0 text-ft-blue dark:text-[color:var(--ft-cyan)]" aria-hidden="true" />
                                    <span>{point}</span>
                                </li>
                            ))}
                        </ul>
                        <ClayButton asChild className="mt-8">
                            <Link href="/auth?tab=signup">
                                Open your shop
                                <ArrowRight className="h-4 w-4 shrink-0" aria-hidden="true" />
                            </Link>
                        </ClayButton>
                    </div>
                    <NeuTray className="p-4">
                        <h3 className="mb-3 text-sm font-semibold text-[color:var(--ft-muted)]">How resellers earn</h3>
                        <ul className="grid grid-cols-2 gap-3">
                            {FLOW.map(step => (
                                <li key={step} className="ft-raised flex min-h-12 items-center justify-center px-3 py-2 text-center text-sm font-semibold text-ft-ink">
                                    {step}
                                </li>
                            ))}
                        </ul>
                    </NeuTray>
                </div>

                <h3 className="ft-display mt-16 text-2xl font-extrabold text-ft-ink">Agent membership plans</h3>
                <p className="mt-2 max-w-2xl text-base text-[color:var(--ft-muted)]">
                    All plans include wholesale pricing, a shop storefront, bulk orders, and{' '}
                    <span className="font-semibold text-ft-ink">Developer API key access</span>.
                </p>
                <ul className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
                    {shown.map(plan => {
                        const popular = plan.title === 'Most Popular' || plan.badge === 'Most Popular'
                        return (
                            <li key={plan.key} className="min-w-0">
                                <NeuCard pressed={popular} className="flex h-full flex-col p-6">
                                    {plan.badge && (
                                        <span className="ft-inset mb-3 inline-block max-w-full self-start break-words px-3 py-1 text-xs font-semibold text-ft-ink">
                                            {plan.badge}
                                        </span>
                                    )}
                                    <h4 className="ft-display break-words text-lg font-extrabold text-ft-ink">{plan.title}</h4>
                                    <p className="mt-1 break-words text-sm text-[color:var(--ft-muted)]">{plan.duration}</p>
                                    <div className="mt-4">
                                        {plan.oldPrice && plan.oldPrice !== plan.price && (
                                            <p className="break-words text-sm text-[color:var(--ft-muted)] line-through">
                                                <span className="sr-only">Was </span>GHS {plan.oldPrice}
                                            </p>
                                        )}
                                        <p className="ft-display break-words text-3xl font-extrabold text-ft-ink">GHS {plan.price}</p>
                                    </div>
                                    <ClayButton asChild variant={popular ? 'primary' : 'soft'} className="mt-5 w-full">
                                        <Link href="/auth?tab=signup">Get started</Link>
                                    </ClayButton>
                                </NeuCard>
                            </li>
                        )
                    })}
                </ul>

                {/* Dealer tier teaser */}
                <NeuCard className="mt-8 flex flex-col gap-5 p-6 sm:flex-row sm:items-center sm:p-8">
                    <span className="ft-clay flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl">
                        <Gem className="h-7 w-7" aria-hidden="true" />
                    </span>
                    <div className="min-w-0 flex-1">
                        <h3 className="ft-display text-xl font-extrabold text-ft-ink">Become a dealer</h3>
                        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-[color:var(--ft-muted)]">
                            The highest reseller rank on FameTech, available only to Lifetime Agent members. Unlock more discounted prices, full Developer API access with high rate limits, priority order processing, and direct priority support.
                        </p>
                    </div>
                    <ClayButton asChild className="shrink-0">
                        <Link href="/auth?tab=signup">Learn more</Link>
                    </ClayButton>
                </NeuCard>
            </div>
        </section>
    )
}
