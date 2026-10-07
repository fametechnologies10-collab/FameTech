import { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { createServerClient } from '@/lib/supabase'
import ResultsCheckerRetrieveClient from '@/app/shop/[shopSlug]/results-checker/retrieve/ResultsCheckerRetrieveClient'

interface Props {
    params: Promise<{ shopSlug: string }>
}

export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const { shopSlug } = await params
    const supabase = createServerClient()

    const { data: shop } = await (supabase
        .from('shop_profiles')
        .select('shop_name')
        .eq('shop_slug', shopSlug)
        .eq('approval_status', 'approved')
        .eq('is_active', true)
        .single() as any)

    if (!shop) {
        return { title: 'Voucher Retrieval' }
    }

    return {
        title: `${shop.shop_name} Voucher Retrieval`,
        description: `Retrieve Results Checker vouchers purchased from ${shop.shop_name}.`,
    }
}

export default async function ShopDomainResultsCheckerRetrievePage({ params }: Props) {
    const { shopSlug } = await params
    const supabase = createServerClient()

    const { data: shop } = await (supabase
        .from('shop_profiles')
        .select('shop_name, shop_slug, logo_url, owner_phone, owner_email, whatsapp_number, brand_color')
        .eq('shop_slug', shopSlug)
        .eq('approval_status', 'approved')
        .eq('is_active', true)
        .single() as any)

    if (!shop) {
        notFound()
    }

    return <ResultsCheckerRetrieveClient shop={shop} />
}
