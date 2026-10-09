import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const badgeVariants = cva(
    "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
    {
        variants: {
            variant: {
                default:
                    "border-transparent bg-[#0057FF] text-white shadow-[inset_0_1px_2px_rgba(255,255,255,0.4),0_3px_8px_var(--ft-clay-glow)]",
                secondary:
                    "border-transparent ft-soft shadow-[-2px_-2px_5px_var(--ft-hi),2px_2px_5px_var(--ft-lo)]",
                destructive:
                    "border-transparent bg-[#B71C1C] text-white shadow-[inset_0_1px_2px_rgba(255,255,255,0.35),0_3px_8px_rgba(183,28,28,0.3)]",
                outline: "ft-field text-foreground shadow-[inset_-2px_-2px_4px_var(--ft-hi),inset_2px_2px_4px_var(--ft-lo)]",
                success:
                    "border-transparent shadow-[-2px_-2px_5px_var(--ft-hi),2px_2px_5px_var(--ft-lo)] bg-[#D1FAE5] text-[#065F46] dark:bg-[#163C3D] dark:text-[#6EE7B7]",
                warning:
                    "border-transparent shadow-[-2px_-2px_5px_var(--ft-hi),2px_2px_5px_var(--ft-lo)] bg-[#FEF3C7] text-[#92400E] dark:bg-[#3D3121] dark:text-[#FCD34D]",
                pending:
                    "border-transparent shadow-[-2px_-2px_5px_var(--ft-hi),2px_2px_5px_var(--ft-lo)] bg-[#FEF3C7] text-[#92400E] dark:bg-[#3D3121] dark:text-[#FCD34D]",
                processing:
                    "border-transparent shadow-[-2px_-2px_5px_var(--ft-hi),2px_2px_5px_var(--ft-lo)] bg-[#DBEAFE] text-[#1E40AF] dark:bg-[#182C50] dark:text-[#93C5FD]",
                completed:
                    "border-transparent shadow-[-2px_-2px_5px_var(--ft-hi),2px_2px_5px_var(--ft-lo)] bg-[#D1FAE5] text-[#065F46] dark:bg-[#163C3D] dark:text-[#6EE7B7]",
                failed:
                    "border-transparent shadow-[-2px_-2px_5px_var(--ft-hi),2px_2px_5px_var(--ft-lo)] bg-[#FEE2E2] text-[#991B1B] dark:bg-[#3C1F2C] dark:text-[#FCA5A5]",
                mtn:
                    "border-transparent shadow-[-2px_-2px_5px_var(--ft-hi),2px_2px_5px_var(--ft-lo)] bg-[#FEF9C3] text-[#854D0E] dark:bg-[#3B3520] dark:text-[#FDE047]",
                telecel:
                    "border-transparent shadow-[-2px_-2px_5px_var(--ft-hi),2px_2px_5px_var(--ft-lo)] bg-[#FEE2E2] text-[#991B1B] dark:bg-[#3C1F2C] dark:text-[#FCA5A5]",
                airteltigo:
                    "border-transparent shadow-[-2px_-2px_5px_var(--ft-hi),2px_2px_5px_var(--ft-lo)] bg-[#FFEDD5] text-[#9A3412] dark:bg-[#3E2923] dark:text-[#FDBA74]",
            },
        },
        defaultVariants: {
            variant: "default",
        },
    }
)

export interface BadgeProps
    extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> { }

function Badge({ className, variant, ...props }: BadgeProps) {
    return (
        <div className={cn(badgeVariants({ variant }), className)} {...props} />
    )
}

export { Badge, badgeVariants }
