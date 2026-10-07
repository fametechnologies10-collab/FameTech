import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import {
    API_BASE,
    DEVELOPER_PRODUCTS,
    KEY_INFO,
    SITE,
    USSD_DETAILS,
    getProduct,
} from '@/lib/developer-products'

export const dynamicParams = false

export function generateStaticParams() {
    return DEVELOPER_PRODUCTS.map(p => ({ product: p.slug }))
}

export async function generateMetadata({ params }: { params: Promise<{ product: string }> }): Promise<Metadata> {
    const { product } = await params
    const p = getProduct(product)
    if (!p) return {}
    const url = `${SITE}/developers/${p.slug}`
    return {
        title: `${p.title} | KiNG FLEXY GH`,
        description: p.description,
        keywords: p.keywords,
        alternates: { canonical: url },
        openGraph: { title: p.title, description: p.description, url, type: 'article', siteName: 'KiNG FLEXY GH' },
        twitter: { card: 'summary_large_image', title: p.title, description: p.description },
    }
}

export default async function DeveloperProductPage({ params }: { params: Promise<{ product: string }> }) {
    const { product } = await params
    const p = getProduct(product)
    if (!p) notFound()

    const key = p.keyType ? KEY_INFO[p.keyType] : null
    const others = DEVELOPER_PRODUCTS.filter(o => o.slug !== p.slug)

    const jsonLd = {
        '@context': 'https://schema.org',
        '@type': 'TechArticle',
        headline: p.title,
        description: p.description,
        url: `${SITE}/developers/${p.slug}`,
        inLanguage: 'en-GH',
        about: p.name,
        publisher: { '@type': 'Organization', name: 'KiNG FLEXY TECHNOLOGIES LTD', url: SITE },
    }

    return (
        <main className="min-h-screen bg-white dark:bg-slate-950 text-slate-800 dark:text-slate-200">
            <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
            <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10 space-y-10">
                <nav className="text-sm text-slate-500">
                    <Link href="/" className="hover:underline">KiNG FLEXY GH</Link>
                    {' / '}
                    <Link href="/developers" className="hover:underline">Developer API</Link>
                    {' / '}
                    <span>{p.name}</span>
                </nav>

                <header className="space-y-3">
                    <h1 className="text-3xl sm:text-4xl font-black tracking-tight text-slate-900 dark:text-white">{p.title}</h1>
                    <p className="text-base text-slate-600 dark:text-slate-400 leading-relaxed">{p.intro}</p>
                </header>

                {p.endpoints.length > 0 && (
                    <section className="space-y-4">
                        <h2 className="text-xl font-bold text-slate-900 dark:text-white">Endpoints</h2>
                        <p className="text-sm text-slate-600 dark:text-slate-400">
                            Base URL: <code className="font-mono">{API_BASE}</code>
                            {key && (
                                <>
                                    {' '}· Requires a {key.label} (<code className="font-mono">{key.prefix}...</code>) sent raw in the{' '}
                                    <code className="font-mono">Authorization</code> header.
                                </>
                            )}
                        </p>
                        <ul className="divide-y divide-slate-200 dark:divide-slate-800 rounded-xl border border-slate-200 dark:border-slate-800">
                            {p.endpoints.map(e => (
                                <li key={e.method + e.path} className="p-4 space-y-1">
                                    <p className="font-mono text-sm">
                                        <strong>{e.method}</strong> {e.path}
                                    </p>
                                    <p className="text-sm text-slate-600 dark:text-slate-400">{e.summary}</p>
                                </li>
                            ))}
                        </ul>
                    </section>
                )}

                {p.curl && (
                    <section className="space-y-3">
                        <h2 className="text-xl font-bold text-slate-900 dark:text-white">Example request</h2>
                        <pre className="overflow-x-auto rounded-xl bg-slate-900 text-slate-100 p-4 text-xs sm:text-sm">
                            <code>{p.curl}</code>
                        </pre>
                    </section>
                )}

                {p.slug === 'ussd' ? (
                    <section className="space-y-3">
                        <h2 className="text-xl font-bold text-slate-900 dark:text-white">How USSD works on KiNG FLEXY GH</h2>
                        <ul className="list-disc pl-5 space-y-2 text-sm text-slate-700 dark:text-slate-300">
                            {USSD_DETAILS.map(d => <li key={d}>{d}</li>)}
                        </ul>
                    </section>
                ) : p.ussd ? (
                    <section className="space-y-2">
                        <h2 className="text-xl font-bold text-slate-900 dark:text-white">Also on USSD</h2>
                        <p className="text-sm text-slate-700 dark:text-slate-300">{p.ussd}</p>
                        <p className="text-sm">
                            <Link href="/developers/ussd" className="text-violet-600 dark:text-violet-400 underline">
                                More about USSD for resellers
                            </Link>
                        </p>
                    </section>
                ) : null}

                <section className="space-y-3">
                    <h2 className="text-xl font-bold text-slate-900 dark:text-white">Get started</h2>
                    <ul className="list-disc pl-5 space-y-1 text-sm text-slate-700 dark:text-slate-300">
                        <li>
                            <Link href="/developers" className="text-violet-600 dark:text-violet-400 underline">Full API documentation</Link>
                            {' '}with every request and response
                        </li>
                        <li>
                            <a href="/openapi.yaml" className="text-violet-600 dark:text-violet-400 underline">OpenAPI 3 specification</a>
                        </li>
                        <li>
                            <Link href="/auth" className="text-violet-600 dark:text-violet-400 underline">Sign in or create an account</Link>
                            {' '}to generate your API key
                        </li>
                    </ul>
                </section>

                <section className="space-y-3">
                    <h2 className="text-xl font-bold text-slate-900 dark:text-white">More from KiNG FLEXY GH</h2>
                    <ul className="flex flex-wrap gap-2">
                        {others.map(o => (
                            <li key={o.slug}>
                                <Link
                                    href={`/developers/${o.slug}`}
                                    className="inline-block rounded-full border border-slate-200 dark:border-slate-800 px-3 py-1 text-sm hover:bg-slate-50 dark:hover:bg-slate-900"
                                >
                                    {o.name}
                                </Link>
                            </li>
                        ))}
                    </ul>
                </section>
            </div>
        </main>
    )
}
