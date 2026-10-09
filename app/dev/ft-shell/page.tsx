import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import ShellPreview, { type PreviewRole } from './shell-preview'

export const metadata: Metadata = {
    title: 'FT shell preview',
    robots: { index: false, follow: false },
}

const ROLES: PreviewRole[] = ['customer', 'agent', 'dealer', 'subagent', 'admin', 'sub-admin']

export default async function FtShellPage({
    searchParams,
}: {
    searchParams: Promise<{ role?: string; path?: string; collapsed?: string; state?: string }>
}) {
    if (process.env.NODE_ENV === 'production') notFound()
    const { role, path, collapsed, state } = await searchParams
    const safeRole = ROLES.find((r) => r === role) ?? 'customer'
    return (
        <ShellPreview
            role={safeRole}
            path={path || '/dashboard'}
            collapsed={collapsed === '1'}
            drawerOpen={state === 'open'}
        />
    )
}
