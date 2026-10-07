'use client'

import { createContext, useCallback, useContext, useState, ReactNode } from 'react'

interface UIContextType {
    isInternalSidebarOpen: boolean
    isCollapsed: boolean
    isAnnouncementBellOpen: boolean
    toggleSidebar: () => void
    closeSidebar: () => void
    toggleCollapse: () => void
    setIsAnnouncementBellOpen: (open: boolean) => void
    /** Latest active platform announcement, published by SystemAnnouncementModal once it has loaded it. */
    activeAnnouncement: { id: string; title: string } | null
    setActiveAnnouncement: (announcement: { id: string; title: string } | null) => void
    /** Bumped by reopenAnnouncement(); the modal re-shows itself whenever this changes. */
    announcementReopenTick: number
    reopenAnnouncement: () => void
}

const UIContext = createContext<UIContextType | undefined>(undefined)

export function UIProvider({ children }: { children: ReactNode }) {
    const [isInternalSidebarOpen, setIsInternalSidebarOpen] = useState(false)
    const [isCollapsed, setIsCollapsed] = useState(false)
    const [isAnnouncementBellOpen, setIsAnnouncementBellOpen] = useState(false)
    const [activeAnnouncement, setActiveAnnouncement] = useState<{ id: string; title: string } | null>(null)
    const [announcementReopenTick, setAnnouncementReopenTick] = useState(0)
    const reopenAnnouncement = useCallback(() => setAnnouncementReopenTick(t => t + 1), [])

    const toggleSidebar = () => setIsInternalSidebarOpen(prev => !prev)
    const closeSidebar = () => setIsInternalSidebarOpen(false)
    const toggleCollapse = () => setIsCollapsed(prev => !prev)

    return (
        <UIContext.Provider value={{
            isInternalSidebarOpen,
            isCollapsed,
            isAnnouncementBellOpen,
            toggleSidebar,
            closeSidebar,
            toggleCollapse,
            setIsAnnouncementBellOpen,
            activeAnnouncement,
            setActiveAnnouncement,
            announcementReopenTick,
            reopenAnnouncement,
        }}>
            {children}
        </UIContext.Provider>
    )
}

export function useUI() {
    const context = useContext(UIContext)
    if (context === undefined) {
        throw new Error('useUI must be used within a UIProvider')
    }
    return context
}
