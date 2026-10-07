import { BrandLoader } from '@/components/ui/brand-loader'

export default function DashboardLoading() {
    return (
        <div className="flex items-center justify-center min-h-[60vh]">
            <BrandLoader fullScreen={false} />
        </div>
    )
}
