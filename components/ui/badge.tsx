import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const badgeVariants = cva(
    "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--ft-focus-edge)]",
    {
        variants: {
            variant: {
                default:
                    "border-transparent bg-[#0057FF] text-white",
                secondary:
                    "border-transparent bg-secondary text-secondary-foreground",
                destructive:
                    "border-transparent bg-[#B71C1C] text-white",
                outline: "border-[color:var(--ft-field-edge)] bg-transparent text-foreground",
                success:
                    "border-transparent bg-[#D1FAE5] text-[#065F46] dark:bg-[#163C3D] dark:text-[#6EE7B7]",
                warning:
                    "border-transparent bg-[#FEF3C7] text-[#92400E] dark:bg-[#3D3121] dark:text-[#FCD34D]",
                pending:
                    "border-transparent bg-[#FEF3C7] text-[#92400E] dark:bg-[#3D3121] dark:text-[#FCD34D]",
                processing:
                    "border-transparent bg-[#DBEAFE] text-[#1E40AF] dark:bg-[#182C50] dark:text-[#93C5FD]",
                completed:
                    "border-transparent bg-[#D1FAE5] text-[#065F46] dark:bg-[#163C3D] dark:text-[#6EE7B7]",
                failed:
                    "border-transparent bg-[#FEE2E2] text-[#991B1B] dark:bg-[#3C1F2C] dark:text-[#FCA5A5]",
                mtn:
                    "border-transparent bg-[#FEF9C3] text-[#854D0E] dark:bg-[#3B3520] dark:text-[#FDE047]",
                telecel:
                    "border-transparent bg-[#FEE2E2] text-[#991B1B] dark:bg-[#3C1F2C] dark:text-[#FCA5A5]",
                airteltigo:
                    "border-transparent bg-[#FFEDD5] text-[#9A3412] dark:bg-[#3E2923] dark:text-[#FDBA74]",
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
