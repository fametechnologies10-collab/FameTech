import { createServerComponentClient } from '@/lib/supabase-server'
import { redirect } from 'next/navigation'
import ShopSmsAdminClient from './ShopSmsAdminClient'

export const dynamic = 'force-dynamic'

export default async function AdminShopSmsPage() {
    const supabase = await createServerComponentClient()
    const { data: { user: authUser }, error: authError } = await supabase.auth.getUser()

    if (authError || !authUser) redirect('/admin/login')

    const { data: userData } = await supabase
        .from('users')
        .select('role')
        .eq('id', authUser.id)
        .single()

    // STRICTLY BLOCK SUB-ADMINS — this page configures money settings
    if ((userData as any)?.role !== 'admin') {
        redirect('/admin')
    }

    return <ShopSmsAdminClient />
}
