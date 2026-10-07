'use client'

import { createContext, useContext, useCallback, useRef, useState, useEffect } from 'react'

// Priority values — lower number = higher priority = shown first.
export const MODAL_PRIORITY = {
    TERMS_ACCEPTANCE:   0, // Blocking legal gate — must be accepted before ANY other modal
    AGENT_EXPIRY:       1, // Critical: role downgrade, blocks workflow
    ANNOUNCEMENT:       2, // Important: admin-set platform notice
    SIGNUP_PROMO:       3, // Welcome offer (one-time, commercial)
    PUSH_PERMISSION:    4, // Ambient: push notification opt-in
    NAV_TIP:            5, // Informational: one-time UI hint (absolutely last)
} as const

export type ModalId = keyof typeof MODAL_PRIORITY

interface QueueEntry {
    id: ModalId
    priority: number
}

interface ModalQueueContextType {
    /** Register intent to show. Returns true if this modal is now the active one. */
    register: (id: ModalId) => void
    /** Call when the modal closes. Advances the queue. */
    dismiss: (id: ModalId) => void
    /** Returns true when this modal is at the head of the queue. */
    isActive: (id: ModalId) => boolean
    /** True when any queued modal is currently visible. Used by push-toast. */
    hasActiveModal: boolean
}

const ModalQueueContext = createContext<ModalQueueContextType | undefined>(undefined)

export function ModalQueueProvider({ children }: { children: React.ReactNode }) {
    // Sorted queue: head is the currently-active modal.
    const [queue, setQueue] = useState<QueueEntry[]>([])
    // Tracks which IDs have been registered (prevents double-register).
    const registered = useRef(new Set<ModalId>())

    const register = useCallback((id: ModalId) => {
        if (registered.current.has(id)) return
        registered.current.add(id)
        setQueue(prev => {
            const next = [...prev, { id, priority: MODAL_PRIORITY[id] }]
            next.sort((a, b) => a.priority - b.priority)
            return next
        })
    }, [])

    const dismiss = useCallback((id: ModalId) => {
        registered.current.delete(id)
        setQueue(prev => prev.filter(e => e.id !== id))
    }, [])

    const isActive = useCallback((id: ModalId) => {
        return queue.length > 0 && queue[0].id === id
    }, [queue])

    const hasActiveModal = queue.length > 0

    return (
        <ModalQueueContext.Provider value={{ register, dismiss, isActive, hasActiveModal }}>
            {children}
        </ModalQueueContext.Provider>
    )
}

export function useModalQueue(id: ModalId, shouldShow: boolean) {
    const ctx = useContext(ModalQueueContext)
    if (!ctx) throw new Error('useModalQueue must be used within ModalQueueProvider')

    const { register, dismiss, isActive } = ctx
    const active = isActive(id)

    // Register when we know we want to show; unregister when we no longer do.
    useEffect(() => {
        if (shouldShow) {
            register(id)
        } else {
            dismiss(id)
        }
    }, [shouldShow, id, register, dismiss])

    // Clean up on unmount.
    useEffect(() => () => { dismiss(id) }, [id, dismiss])

    return {
        /** True only when this modal has reached the head of the queue. */
        canShow: active && shouldShow,
        /** Call when the modal is dismissed by the user. */
        onDismiss: () => dismiss(id),
    }
}

export function useModalQueueContext() {
    const ctx = useContext(ModalQueueContext)
    if (!ctx) throw new Error('useModalQueueContext must be used within ModalQueueProvider')
    return ctx
}

/** Non-throwing variant for components that may render outside the provider
 *  (e.g. BottomNav used in both /dashboard and /admin layouts). */
export function useModalQueueContextSafe() {
    const ctx = useContext(ModalQueueContext)
    return ctx ?? { register: () => {}, dismiss: () => {}, isActive: () => false, hasActiveModal: false }
}
