import { Star } from 'lucide-react'
import { NeuCard } from '@/components/ft'
import { DEFAULT_TESTIMONIALS, isValidReview, parseCustomerCountTarget, type LandingReview } from '@/components/landing/helpers'

interface ReviewsProps {
    customerCountRaw: string
    testimonials: LandingReview[]
}

function clampRating(rating: number): number {
    if (!Number.isFinite(rating)) return 0
    return Math.min(5, Math.max(0, Math.round(rating)))
}

export function Reviews({ customerCountRaw, testimonials }: ReviewsProps) {
    // Static count: the old code only parsed the label into a number (no frame loop),
    // so the same value is rendered directly. en-US keeps server and client output identical.
    const count = parseCustomerCountTarget(customerCountRaw).toLocaleString('en-US')
    const plus = customerCountRaw.includes('+') ? '+' : ''
    const valid = Array.isArray(testimonials) ? testimonials.filter(isValidReview) : []
    const reviews = (valid.length > 0 ? valid : DEFAULT_TESTIMONIALS).slice(0, 6)
    // 3 columns only when the count divides evenly (3 or 6); otherwise 2 columns at md+ so no card is orphaned.
    const gridCols = reviews.length === 3 || reviews.length === 6 ? 'md:grid-cols-2 lg:grid-cols-3' : 'md:grid-cols-2'

    return (
        <section id="reviews" aria-labelledby="reviews-heading" className="ft-lazy scroll-mt-24 px-4 py-16 sm:px-6 lg:px-8">
            <div className="mx-auto max-w-7xl">
                <NeuCard pressed className="p-6 text-center sm:p-8">
                    <p className="ft-display break-words text-5xl font-extrabold tracking-tight text-ft-blue dark:text-[color:var(--ft-cyan)] sm:text-6xl">
                        {count}{plus}
                    </p>
                    <h2 id="reviews-heading" className="ft-display mx-auto mt-2 max-w-2xl text-2xl font-extrabold tracking-tight text-ft-ink sm:text-3xl">
                        Customers across Ghana trust FameTech
                    </h2>
                    <p className="mx-auto mt-2 max-w-xl text-base text-[color:var(--ft-muted)]">
                        They rely on our speed, reliability and reseller support.
                    </p>
                </NeuCard>

                <ul className={`mt-8 grid gap-5 ${gridCols}`}>
                    {reviews.map((review, index) => {
                        const rating = clampRating(review.rating)
                        return (
                            <li key={`${review.name}-${index}`} className="min-w-0">
                                <NeuCard className="h-full min-w-0 p-5">
                                    <div role="img" aria-label={`${rating} out of 5`} className="flex items-center gap-1">
                                        {Array.from({ length: 5 }).map((_, i) => (
                                            <Star
                                                key={i}
                                                aria-hidden="true"
                                                className={i < rating ? 'h-5 w-5 fill-ft-blue text-ft-blue dark:fill-[color:var(--ft-cyan)] dark:text-[color:var(--ft-cyan)]' : 'h-5 w-5 text-[color:var(--ft-muted)]'}
                                            />
                                        ))}
                                    </div>
                                    <p className="mt-3 break-words text-base leading-relaxed text-ft-ink">{review.quote}</p>
                                    <p className="mt-4 break-words font-semibold text-ft-ink">{review.name}</p>
                                    <p className="break-words text-sm text-[color:var(--ft-muted)]">{review.role}</p>
                                </NeuCard>
                            </li>
                        )
                    })}
                </ul>
            </div>
        </section>
    )
}
