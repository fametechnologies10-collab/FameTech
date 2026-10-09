import { WhatsAppCommunityButtons } from '@/components/whatsapp-community-buttons'

export function Community() {
    return (
        <section id="community" aria-labelledby="community-heading" className="ft-lazy scroll-mt-24 px-4 py-12 sm:px-6 lg:px-8">
            <div className="mx-auto max-w-4xl">
                <h2 id="community-heading" className="ft-display text-2xl font-extrabold tracking-tight text-ft-ink sm:text-3xl">
                    Join our community
                </h2>
                <p className="mt-2 text-base text-[color:var(--ft-muted)]">
                    Get offers and news on our WhatsApp platforms.
                </p>
                <div className="mt-6">
                    <WhatsAppCommunityButtons ft />
                </div>
            </div>
        </section>
    )
}
