'use client'

import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { PathnameContext, SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { AuthContext, type AuthContextType } from '@/contexts/auth-context'
import { UIProvider, useUI } from '@/contexts/ui-context'
import { ModalQueueProvider } from '@/contexts/modal-queue-context'
import { DashboardSidebar } from '@/components/dashboard/sidebar'
import { DashboardHeader } from '@/components/dashboard/header'
import { BottomNav } from '@/components/dashboard/bottom-nav'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

export type PreviewRole = 'customer' | 'agent' | 'dealer' | 'subagent' | 'admin' | 'sub-admin'

interface Props {
    role: PreviewRole
    path: string
    collapsed: boolean
    drawerOpen: boolean
}

// Dev-only: contains a failing shell child (dummy Supabase env) so the rest still renders.
class Boundary extends Component<{ name: string; children: ReactNode }, { failed: boolean }> {
    state = { failed: false }
    static getDerivedStateFromError() {
        return { failed: true }
    }
    componentDidCatch(error: unknown) {
        console.error(`[ft-shell] ${this.props.name} threw during render`, error)
    }
    render() {
        if (this.state.failed) {
            return <div className="p-2 text-xs text-red-600">{this.props.name} failed to render (see console)</div>
        }
        return this.props.children
    }
}

function buildAuth(role: PreviewRole): AuthContextType {
    const now = new Date().toISOString()
    const value = {
        user: {
            id: 'preview-user',
            email: 'ama@example.com',
            aud: 'authenticated',
            app_metadata: {},
            user_metadata: { has_password: true },
            identities: [],
            created_at: now,
        },
        session: { access_token: 'preview', refresh_token: 'preview', expires_in: 3600, token_type: 'bearer' },
        dbUser: {
            id: 'preview-user',
            first_name: 'Ama',
            last_name: 'Mensah',
            email: 'ama@example.com',
            role,
            status: 'active',
            phone_number: '0244000000',
            wallet_balance: 250,
            created_at: now,
            suspended_until: null,
        },
        isLoading: false,
        isSigningOut: false,
        isAdmin: role === 'admin',
        isSubAdmin: role === 'sub-admin',
        isDealer: role === 'dealer',
        sessionExpiring: false,
        signIn: async () => ({ error: null }),
        signUp: async () => ({ error: null, data: null }),
        signOut: async () => {},
        refreshUser: async () => {},
        syncSession: async () => true,
        extendSession: () => {},
        getPendingCredentials: () => null,
        clearPendingCredentials: () => {},
    }
    return value as unknown as AuthContextType
}

function UIInit({ collapsed, drawerOpen }: { collapsed: boolean; drawerOpen: boolean }) {
    const { isCollapsed, toggleCollapse, isInternalSidebarOpen, toggleSidebar } = useUI()
    // Ref guard: StrictMode re-runs this effect with the same stale closure, which would toggle twice and undo it.
    const applied = useRef(false)
    useEffect(() => {
        if (applied.current) return
        applied.current = true
        if (collapsed && !isCollapsed) toggleCollapse()
        if (drawerOpen && !isInternalSidebarOpen) toggleSidebar()
        // mount-only: apply the query-string initial state once
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
    return null
}

// KEEP IN SYNC with app/dashboard/dashboard-layout-client.tsx wrapper classes
function Layout() {
    const { isCollapsed } = useUI()
    return (
        <div className="min-h-screen bg-background relative">
            <Boundary name="DashboardSidebar">
                <DashboardSidebar />
            </Boundary>
            <div className={cn(
                "relative transition-all duration-300 ease-in-out min-h-screen flex flex-col w-full max-w-[100vw] overflow-x-clip",
                isCollapsed ? "lg:pl-20" : "lg:pl-80"
            )}>
                <Boundary name="DashboardHeader">
                    <DashboardHeader onOpenNotifications={() => {}} unreadCount={3} />
                </Boundary>
                <div className="h-16 flex-shrink-0" />
                <main className="p-4 lg:p-6 flex-1 max-lg:pb-[calc(80px+env(safe-area-inset-bottom,0px))]">
                    <div className="space-y-4">
                        <h1 className="text-2xl font-bold">Preview page</h1>
                        <div className="grid gap-4 md:grid-cols-3">
                            {['Card one', 'Card two', 'Card three'].map((t) => (
                                <Card key={t}>
                                    <CardHeader>
                                        <CardTitle>{t}</CardTitle>
                                    </CardHeader>
                                    <CardContent>Sample card content for checking the shell.</CardContent>
                                </Card>
                            ))}
                        </div>
                        <div className="space-y-2">
                            {Array.from({ length: 30 }, (_, i) => (
                                <div key={i} className="bg-white dark:bg-slate-900 rounded-xl border p-4">
                                    List row {i + 1}
                                </div>
                            ))}
                        </div>
                    </div>
                </main>
            </div>
            <Boundary name="BottomNav">
                <BottomNav />
            </Boundary>
        </div>
    )
}

export default function ShellPreview({ role, path, collapsed, drawerOpen }: Props) {
    const auth = useMemo(() => buildAuth(role), [role])
    // Next's internal PathnameContext is created by a different React copy than the one
    // SSR renders with (app has react 18, Next SSR uses its vendored React 19), so its
    // Provider throws "Element type is invalid" during SSR. Mount it client-side only;
    // SSR/first paint has no active nav item, the browser gets it right after mount.
    const [mounted, setMounted] = useState(false)
    useEffect(() => setMounted(true), [])
    const shell = (
        <AuthContext.Provider value={auth}>
            <UIProvider>
                <UIInit collapsed={collapsed} drawerOpen={drawerOpen} />
                <ModalQueueProvider>
                    <Layout />
                </ModalQueueProvider>
            </UIProvider>
        </AuthContext.Provider>
    )
    if (!mounted) return shell
    return (
        <PathnameContext.Provider value={path}>
            <SearchParamsContext.Provider value={new URLSearchParams() as never}>
                {shell}
            </SearchParamsContext.Provider>
        </PathnameContext.Provider>
    )
}
