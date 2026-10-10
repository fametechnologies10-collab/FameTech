'use client'

import Link from 'next/link'
import { Ban, Headphones } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { WhatsAppIcon } from '@/components/icons/whatsapp-icon'

export function SuspendedAccount() {
    const handleWhatsAppClick = () => {
        window.open('https://wa.me/233578065809', '_blank', 'noopener,noreferrer')
    }

    return (
        <div className="min-h-[80vh] flex items-center justify-center p-4">
            <Card className="max-w-md w-full overflow-hidden rounded-3xl" role="alert">
                <div className="h-2 bg-[#B71C1C] w-full" />
                <CardContent className="p-8 text-center space-y-6">
                    <div className="flex justify-center">
                        <div className="w-20 h-20 ft-field rounded-full flex items-center justify-center">
                            <Ban className="w-10 h-10 text-[#B71C1C] dark:text-red-400" />
                        </div>
                    </div>

                    <div className="space-y-2">
                        <h2 className="text-2xl font-bold text-foreground tracking-tight">
                            Your account is suspended
                        </h2>
                        <p className="text-muted-foreground font-medium">
                            You can appeal this decision or contact our team below.
                        </p>
                    </div>

                    <div className="pt-4 space-y-3">
                        <Button
                            asChild
                            className="w-full h-12 font-bold rounded-xl"
                        >
                            <Link href="/dashboard/complaints" className="flex items-center justify-center gap-3">
                                <Headphones className="w-5 h-5" />
                                Open a complaint or appeal
                            </Link>
                        </Button>
                        <Button
                            onClick={handleWhatsAppClick}
                            className="w-full h-12 text-[#0B3D1E] [--ft-c1:#25D366] font-bold rounded-xl flex items-center justify-center gap-3"
                        >
                            <WhatsAppIcon className="w-5 h-5" />
                            Contact support (WhatsApp)
                        </Button>
                    </div>

                    <p className="text-xs text-muted-foreground font-medium pt-4 border-t border-foreground/10">
                        FameTech support system
                    </p>
                </CardContent>
            </Card>
        </div>
    )
}
