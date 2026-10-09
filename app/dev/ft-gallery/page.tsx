import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import GalleryClient from './gallery-client'

export const metadata: Metadata = {
    title: 'FT gallery',
    robots: { index: false, follow: false },
}

const OPEN_VALUES = ['dialog', 'sheet', 'dropdown', 'select', 'toast'] as const

export default async function FtGalleryPage({
    searchParams,
}: {
    searchParams: Promise<{ open?: string }>
}) {
    if (process.env.NODE_ENV === 'production') notFound()
    const { open } = await searchParams
    const initialOpen = OPEN_VALUES.find((v) => v === open) ?? null
    return <GalleryClient initialOpen={initialOpen} />
}
