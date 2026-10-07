'use client'

import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { pageRangeLabel, totalPages as computeTotalPages } from '@/lib/pagination'

interface PaginationControlsProps {
    page: number
    pageSize: number
    totalCount: number
    onPageChange: (page: number) => void
    loading?: boolean
    className?: string
}

// Arrow-only pager (no numbered page list) shared by /dashboard/my-orders and
// /dashboard/shop/orders. Deliberately has no "jump to page" input — with a
// fixed 20-row page size, "next"/"previous" is the whole interaction.
export function PaginationControls({ page, pageSize, totalCount, onPageChange, loading, className }: PaginationControlsProps) {
    const pages = computeTotalPages(totalCount, pageSize)
    const { from, to } = pageRangeLabel(page, pageSize, totalCount)
    const atStart = page <= 1
    const atEnd = page >= pages

    return (
        <div className={cn('flex flex-col sm:flex-row items-center justify-between gap-3 py-4', className)}>
            <p className="text-sm text-muted-foreground order-2 sm:order-1">
                {totalCount === 0 ? 'No orders found' : (
                    <>Showing <span className="font-medium text-foreground">{from}–{to}</span> of <span className="font-medium text-foreground">{totalCount.toLocaleString()}</span></>
                )}
            </p>

            <div className="flex items-center gap-3 order-1 sm:order-2">
                <Button
                    variant="outline"
                    size="icon"
                    className="h-9 w-9 rounded-full shadow-sm disabled:shadow-none"
                    disabled={atStart || loading}
                    onClick={() => onPageChange(page - 1)}
                    aria-label="Previous page"
                >
                    <ChevronLeft className="h-4 w-4" />
                </Button>

                <span className="text-sm font-medium tabular-nums min-w-[4.5rem] text-center">
                    {page} / {pages}
                </span>

                <Button
                    variant="outline"
                    size="icon"
                    className="h-9 w-9 rounded-full shadow-sm disabled:shadow-none"
                    disabled={atEnd || loading}
                    onClick={() => onPageChange(page + 1)}
                    aria-label="Next page"
                >
                    <ChevronRight className="h-4 w-4" />
                </Button>
            </div>
        </div>
    )
}
