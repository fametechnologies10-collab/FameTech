// app/dashboard/shop/loading.tsx
// Scoped Suspense fallback for ALL /dashboard/shop/* navigations. Without this,
// the force-dynamic dashboard has no close loading boundary, so taps show no
// feedback until the new page's server render returns (the "ghost button" delay).
export default function ShopLoading() {
    return (
        <div className="space-y-5 pb-20 md:pb-6 animate-pulse">
            <div className="h-24 rounded-2xl bg-gray-100 dark:bg-zinc-900 border border-gray-200 dark:border-gray-800" />
            <div className="grid grid-cols-4 md:grid-cols-8 gap-2">
                {Array.from({ length: 8 }).map((_, i) => (
                    <div key={i} className="h-16 rounded-xl bg-gray-100 dark:bg-zinc-900 border border-gray-200 dark:border-gray-800" />
                ))}
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
                {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="h-20 rounded-xl bg-gray-100 dark:bg-zinc-900 border border-gray-200 dark:border-gray-800" />
                ))}
            </div>
            <div className="h-64 rounded-2xl bg-gray-100 dark:bg-zinc-900 border border-gray-200 dark:border-gray-800" />
        </div>
    )
}
