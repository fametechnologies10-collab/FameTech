'use client'

import { useState, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select'
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Loader2, AlertTriangle, CheckCircle2, MinusCircle } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { DataPackage } from '@/types/supabase'

const NETWORKS = ['MTN', 'Telecel', 'AT-iShare', 'AT-BigTime'] as const

type Network = typeof NETWORKS[number]

type PriceRole = 'price' | 'agent_price' | 'dealer_price' | 'ussd_price' | 'cost_price'

const ROLE_LABELS: Record<PriceRole, string> = {
    price: 'General Price',
    agent_price: 'Agent Price',
    dealer_price: 'Dealer Price',
    ussd_price: 'USSD Price',
    cost_price: 'Cost Price',
}

// Parses a package size string to GB float. Returns null for unrecognised formats.
// "500MB" → 0.5,  "1GB" → 1,  "1.5GB" → 1.5,  "10GB" → 10
export function parseSizeToGB(size: string): number | null {
    const mb = size.match(/^(\d+(?:\.\d+)?)\s*MB$/i)
    if (mb) return parseFloat(mb[1]) / 1024

    const gb = size.match(/^(\d+(?:\.\d+)?)\s*GB$/i)
    if (gb) return parseFloat(gb[1])

    return null
}

interface PreviewRow {
    pkg: DataPackage
    gbSize: number | null
    newPrice: number | null
    warning: string | null
}

interface BulkPricingTabProps {
    packages: DataPackage[]
    onApplied: () => void
}

export function BulkPricingTab({ packages, onApplied }: BulkPricingTabProps) {
    const [network, setNetwork] = useState<Network>('MTN')
    const [role, setRole] = useState<PriceRole>('price')
    const [rateInput, setRateInput] = useState('')
    const [isApplying, setIsApplying] = useState(false)
    // Per-run exclusions: cleared on network change and after a successful apply
    const [excludedIds, setExcludedIds] = useState<Set<string>>(new Set())

    const rate = parseFloat(rateInput)
    const validRate = !isNaN(rate) && rate > 0

    const networkPackages = useMemo(
        () => packages.filter(p => p.network === network),
        [packages, network]
    )

    const previewRows = useMemo<PreviewRow[]>(() => {
        return networkPackages.map(pkg => {
            const gbSize = parseSizeToGB(pkg.size)

            if (gbSize === null) {
                return {
                    pkg,
                    gbSize: null,
                    newPrice: null,
                    warning: 'Unrecognised size format — skipped',
                }
            }

            if (!validRate) {
                return { pkg, gbSize, newPrice: null, warning: null }
            }

            const newPrice = Math.round(gbSize * rate * 100) / 100
            const costPrice = (pkg as any).cost_price ?? 0

            if ((role === 'agent_price' || role === 'dealer_price') && costPrice > 0 && newPrice < costPrice) {
                return {
                    pkg,
                    gbSize,
                    newPrice,
                    warning: `Below cost price (${formatCurrency(costPrice)})`,
                }
            }

            return { pkg, gbSize, newPrice, warning: null }
        })
    }, [networkPackages, rate, validRate, role])

    // Rows the admin can tick/untick (parseable size, not auto-skipped by a warning)
    const selectableRows = previewRows.filter(r => r.warning === null)
    const excludedCount = selectableRows.filter(r => excludedIds.has(r.pkg.id)).length
    const applicableRows = previewRows.filter(
        r => r.newPrice !== null && r.warning === null && !excludedIds.has(r.pkg.id)
    )
    const warningRows = previewRows.filter(r => r.warning !== null)

    const allSelected = selectableRows.length > 0 && excludedCount === 0
    const someSelected = excludedCount < selectableRows.length

    const toggleRow = (id: string) => {
        setExcludedIds(prev => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })
    }

    const toggleAll = () => {
        if (allSelected) setExcludedIds(new Set(selectableRows.map(r => r.pkg.id)))
        else setExcludedIds(new Set())
    }

    const handleApply = async () => {
        if (!validRate || applicableRows.length === 0) return

        setIsApplying(true)
        try {
            const res = await fetch('/api/admin/packages/bulk-pricing', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    network,
                    role,
                    rate,
                    package_ids: applicableRows.map(r => r.pkg.id),
                }),
            })

            const data = await res.json()
            if (!res.ok) throw new Error(data.error || 'Failed to apply bulk pricing')

            toast.success(`Updated ${data.updated} package${data.updated !== 1 ? 's' : ''}`)
            setRateInput('')
            setExcludedIds(new Set())
            onApplied()
        } catch (err: any) {
            toast.error(err.message || 'Failed to apply bulk pricing')
        } finally {
            setIsApplying(false)
        }
    }

    const currentPrice = (pkg: DataPackage): number => (pkg as any)[role] ?? 0

    return (
        <div className="space-y-6">
            <div>
                <h2 className="text-lg font-semibold">Bulk Flat Pricing</h2>
                <p className="text-sm text-muted-foreground">
                    Apply a flat GHS-per-GB rate to all packages in a network for a specific role.
                    e.g. Rate = 4 → 1GB = GHS 4.00, 2GB = GHS 8.00, 5GB = GHS 20.00
                </p>
            </div>

            {/* Controls */}
            <div className="flex flex-wrap gap-4 items-end">
                <div className="space-y-1.5">
                    <Label>Network</Label>
                    <Select
                        value={network}
                        onValueChange={(v) => {
                            setNetwork(v as Network)
                            setExcludedIds(new Set())
                        }}
                    >
                        <SelectTrigger className="w-[160px]">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {NETWORKS.map(n => (
                                <SelectItem key={n} value={n}>{n}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                <div className="space-y-1.5">
                    <Label>Price Role</Label>
                    <Select value={role} onValueChange={(v) => setRole(v as PriceRole)}>
                        <SelectTrigger className="w-[180px]">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {(Object.keys(ROLE_LABELS) as PriceRole[]).map(r => (
                                <SelectItem key={r} value={r}>{ROLE_LABELS[r]}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                <div className="space-y-1.5">
                    <Label>Rate per GB (GHS)</Label>
                    <div className="flex items-center gap-2">
                        <span className="text-sm text-muted-foreground font-medium">GHS</span>
                        <Input
                            type="number"
                            min="0.01"
                            step="0.01"
                            value={rateInput}
                            onChange={e => setRateInput(e.target.value)}
                            placeholder="e.g. 4.00"
                            className="w-[120px]"
                        />
                        <span className="text-sm text-muted-foreground">/ GB</span>
                    </div>
                </div>
            </div>

            {/* Preview Table */}
            {networkPackages.length === 0 ? (
                <p className="text-sm text-muted-foreground">No packages found for {network}.</p>
            ) : (
                <div className="rounded-md border">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead className="w-10">
                                    <Checkbox
                                        checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                                        onCheckedChange={toggleAll}
                                        aria-label="Select all packages"
                                        className="data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground"
                                    />
                                </TableHead>
                                <TableHead>Size</TableHead>
                                <TableHead>Current {ROLE_LABELS[role]}</TableHead>
                                <TableHead>New Price</TableHead>
                                <TableHead>Status</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {previewRows.map(({ pkg, newPrice, warning }) => {
                                const isExcluded = !warning && excludedIds.has(pkg.id)
                                return (
                                <TableRow key={pkg.id} className={warning || isExcluded ? 'opacity-60' : ''}>
                                    <TableCell>
                                        {!warning && (
                                            <Checkbox
                                                checked={!isExcluded}
                                                onCheckedChange={() => toggleRow(pkg.id)}
                                                aria-label={`Include ${pkg.size} in bulk pricing`}
                                            />
                                        )}
                                    </TableCell>
                                    <TableCell className="font-semibold">{pkg.size}</TableCell>
                                    <TableCell>
                                        {currentPrice(pkg) > 0
                                            ? formatCurrency(currentPrice(pkg))
                                            : <span className="text-muted-foreground text-xs">not set</span>
                                        }
                                    </TableCell>
                                    <TableCell>
                                        {validRate && newPrice !== null ? (
                                            <span className="font-medium text-primary">{formatCurrency(newPrice)}</span>
                                        ) : (
                                            <span className="text-muted-foreground text-xs">—</span>
                                        )}
                                    </TableCell>
                                    <TableCell>
                                        {warning ? (
                                            <Badge variant="outline" className="gap-1 text-amber-600 border-amber-300 bg-amber-50 dark:bg-amber-950">
                                                <AlertTriangle className="w-3 h-3" />
                                                {warning}
                                            </Badge>
                                        ) : isExcluded ? (
                                            <Badge variant="outline" className="gap-1 text-muted-foreground">
                                                <MinusCircle className="w-3 h-3" />
                                                Excluded
                                            </Badge>
                                        ) : validRate && newPrice !== null ? (
                                            <Badge variant="outline" className="gap-1 text-green-600 border-green-300 bg-green-50 dark:bg-green-950">
                                                <CheckCircle2 className="w-3 h-3" />
                                                Will update
                                            </Badge>
                                        ) : (
                                            <span className="text-muted-foreground text-xs">Enter rate above</span>
                                        )}
                                    </TableCell>
                                </TableRow>
                                )
                            })}
                        </TableBody>
                    </Table>
                </div>
            )}

            {/* Summary & Apply */}
            {validRate && (
                <div className="flex items-center justify-between pt-2 border-t">
                    <div className="text-sm text-muted-foreground space-y-0.5">
                        <p>
                            <span className="font-medium text-foreground">{applicableRows.length}</span>{' '}
                            package{applicableRows.length !== 1 ? 's' : ''} will be updated
                        </p>
                        {excludedCount > 0 && (
                            <p className="flex items-center gap-1">
                                <MinusCircle className="w-3 h-3" />
                                {excludedCount} package{excludedCount !== 1 ? 's' : ''} excluded by you
                            </p>
                        )}
                        {warningRows.length > 0 && (
                            <p className="text-amber-600 flex items-center gap-1">
                                <AlertTriangle className="w-3 h-3" />
                                {warningRows.length} package{warningRows.length !== 1 ? 's' : ''} skipped (see warnings above)
                            </p>
                        )}
                    </div>
                    <Button
                        onClick={handleApply}
                        disabled={isApplying || applicableRows.length === 0}
                    >
                        {isApplying ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                        Apply to {applicableRows.length} package{applicableRows.length !== 1 ? 's' : ''}
                    </Button>
                </div>
            )}
        </div>
    )
}
