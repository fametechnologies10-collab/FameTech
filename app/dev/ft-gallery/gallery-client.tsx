'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Pagination, PaginationContent, PaginationItem, PaginationLink, PaginationNext, PaginationPrevious } from '@/components/ui/pagination'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Separator } from '@/components/ui/separator'
import { PinPad } from '@/components/ui/pin-pad'
import { BrandLoader } from '@/components/ui/brand-loader'
import { ThemeToggle } from '@/components/ui/theme-toggle'
import { toast } from '@/lib/toast'
import { FT_BLUE, FT_CYAN, FT_INDIGO, FT_IRIS, FT_SLATE, type FtRamp } from '@/lib/ft-palette'

type Open = 'dialog' | 'sheet' | 'dropdown' | 'select' | 'toast' | null

const RAMPS: { name: string; ramp: FtRamp }[] = [
    { name: 'FT_SLATE (slate/gray/zinc/neutral/stone)', ramp: FT_SLATE },
    { name: 'FT_BLUE (blue)', ramp: FT_BLUE },
    { name: 'FT_INDIGO (indigo)', ramp: FT_INDIGO },
    { name: 'FT_IRIS (violet/purple/fuchsia)', ramp: FT_IRIS },
    { name: 'FT_CYAN (sky/cyan)', ramp: FT_CYAN },
]

const BUTTON_VARIANTS = ['default', 'destructive', 'outline', 'secondary', 'ghost', 'link', 'success', 'warning', 'mtn', 'telecel', 'gradient'] as const
const BUTTON_SIZES = ['default', 'sm', 'lg', 'xl', 'icon'] as const
const BADGE_VARIANTS = ['default', 'secondary', 'destructive', 'outline', 'success', 'warning', 'pending', 'processing', 'completed', 'failed', 'mtn', 'telecel', 'airteltigo'] as const
const ALERT_VARIANTS = ['default', 'destructive', 'success', 'warning', 'info'] as const
const WEIGHTS = [400, 500, 600, 700, 900] as const

const ROWS = Array.from({ length: 200 }, (_, i) => ({
    id: i + 1,
    name: `Customer ${i + 1}`,
    network: ['MTN', 'Telecel', 'AirtelTigo'][i % 3],
    amount: (5 + (i % 40) * 2.5).toFixed(2),
    status: ['pending', 'processing', 'completed', 'failed'][i % 4],
}))
const CARDS = Array.from({ length: 100 }, (_, i) => i + 1)

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
    return (
        <section id={id} className="space-y-4 scroll-mt-16">
            <h2 className="text-2xl font-display font-bold">{title}</h2>
            {children}
        </section>
    )
}

function Row({ children, label }: { children: React.ReactNode; label?: string }) {
    return (
        <div className="space-y-2">
            {label && <p className="text-xs font-medium text-muted-foreground">{label}</p>}
            <div className="flex flex-wrap items-center gap-3">{children}</div>
        </div>
    )
}

export default function GalleryClient({ initialOpen }: { initialOpen: Open }) {
    const [dialogOpen, setDialogOpen] = useState(initialOpen === 'dialog')
    const [dialogNoCloseOpen, setDialogNoCloseOpen] = useState(false)
    const [sheetRightOpen, setSheetRightOpen] = useState(initialOpen === 'sheet')
    const [sheetBottomOpen, setSheetBottomOpen] = useState(false)
    const [selectOpen, setSelectOpen] = useState(initialOpen === 'select')
    const [dropdownOpen, setDropdownOpen] = useState(initialOpen === 'dropdown')
    const [checked, setChecked] = useState(true)
    const [switchOn, setSwitchOn] = useState(true)

    useEffect(() => {
        if (initialOpen === 'toast') {
            toast.success('Gallery success toast')
            toast.error('Gallery error toast')
        }
    }, [initialOpen])

    return (
        <div className="min-h-screen bg-background text-foreground">
            <div className="fixed right-3 top-3 z-50">
                <ThemeToggle />
            </div>
            <main className="mx-auto max-w-4xl space-y-12 px-4 py-10">
                <header className="space-y-1">
                    <h1 className="text-4xl font-display font-black">FT component gallery</h1>
                    <p className="text-sm text-muted-foreground">Dev-only component gallery</p>
                </header>

                <Section id="palette" title="Palette swatches">
                    {RAMPS.map(({ name, ramp }) => (
                        <div key={name} className="space-y-1">
                            <p className="text-xs font-medium">{name}</p>
                            <div className="grid grid-cols-6 gap-1 sm:grid-cols-11">
                                {Object.entries(ramp).map(([stop, hex]) => (
                                    <div key={stop} className="space-y-1 text-center">
                                        <div className="h-10 rounded-md border border-black/10" style={{ backgroundColor: hex }} />
                                        <p className="text-[9px] leading-tight text-muted-foreground">{stop}<br />{hex}</p>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                    <div className="space-y-1">
                        <p className="text-xs font-medium">The five 500 stops side by side (category distinctness)</p>
                        <div className="grid grid-cols-5 gap-2">
                            {RAMPS.map(({ name, ramp }) => (
                                <div key={name} className="space-y-1 text-center">
                                    <div className="h-14 rounded-md border border-black/10" style={{ backgroundColor: ramp['500'] }} />
                                    <p className="text-[10px] text-muted-foreground">{name.split(' ')[0]} {ramp['500']}</p>
                                </div>
                            ))}
                        </div>
                    </div>
                </Section>

                <Section id="typography" title="Typography">
                    <div className="space-y-2">
                        <h1 className="text-4xl font-bold">Heading 1</h1>
                        <h2 className="text-3xl font-bold">Heading 2</h2>
                        <h3 className="text-2xl font-semibold">Heading 3</h3>
                        <h4 className="text-xl font-semibold">Heading 4</h4>
                        <h5 className="text-lg font-medium">Heading 5</h5>
                        <h6 className="text-base font-medium">Heading 6</h6>
                        <p>Body text: fast data bundles, airtime and vouchers across MTN, Telecel and AirtelTigo.</p>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-1 font-sans">
                            <p className="text-xs text-muted-foreground">font-sans</p>
                            {WEIGHTS.map((w) => (
                                <p key={w} style={{ fontWeight: w }}>Weight {w} the quick brown fox</p>
                            ))}
                        </div>
                        <div className="space-y-1 font-display">
                            <p className="text-xs text-muted-foreground">font-display</p>
                            {WEIGHTS.map((w) => (
                                <p key={w} style={{ fontWeight: w }}>Weight {w} the quick brown fox</p>
                            ))}
                        </div>
                    </div>
                </Section>

                <Section id="buttons" title="Buttons">
                    {BUTTON_VARIANTS.map((v) => (
                        <Row key={v} label={v}>
                            {BUTTON_SIZES.map((s) => (
                                <Button key={s} variant={v} size={s}>{s === 'icon' ? '+' : s}</Button>
                            ))}
                            <Button variant={v} disabled>disabled</Button>
                        </Row>
                    ))}
                    <Row label="Consumer overrides must win">
                        <Button className="bg-purple-600 hover:bg-purple-700 text-white">bg-purple-600 override</Button>
                        <Button className="bg-emerald-600">bg-emerald-600 override</Button>
                        <Button asChild><a href="#buttons">asChild link</a></Button>
                    </Row>
                </Section>

                <Section id="cards" title="Cards">
                    <div className="grid gap-4 sm:grid-cols-2">
                        <Card>
                            <CardHeader>
                                <CardTitle>Card title</CardTitle>
                                <CardDescription>Card description text</CardDescription>
                            </CardHeader>
                            <CardContent>Card content area.</CardContent>
                            <CardFooter><Button size="sm">Action</Button></CardFooter>
                        </Card>
                        <div className="bg-white dark:bg-slate-900 rounded-2xl border shadow-sm p-4 text-slate-900 dark:text-slate-50">Legacy: bg-white dark:bg-slate-900 rounded-2xl border shadow-sm p-4</div>
                        <div className="bg-white rounded-xl p-4 text-slate-900">Legacy: bg-white rounded-xl only</div>
                        <div className="ft-true-white rounded-xl border p-4 text-slate-900">ft-true-white opt-out tile<p className="text-xs text-slate-600">stays white in dark, needs explicit dark text</p></div>
                        <ul className="space-y-2">
                            <li>
                                <div className="bg-white rounded-xl p-3 text-slate-900">Nested card inside ul/li (flat context)</div>
                            </li>
                        </ul>
                        <Card className="bg-transparent shadow-none">
                            <CardContent className="pt-6">Card with bg-transparent shadow-none (override wins)</CardContent>
                        </Card>
                    </div>
                </Section>

                <Section id="forms" title="Form controls">
                    <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-2"><Label htmlFor="g-in1">Input normal</Label><Input id="g-in1" placeholder="Type here" /></div>
                        <div className="space-y-2"><Label htmlFor="g-in2">Input disabled</Label><Input id="g-in2" disabled placeholder="Disabled" /></div>
                        <div className="space-y-2"><Label htmlFor="g-in3">Input with value</Label><Input id="g-in3" defaultValue="0244000000" /></div>
                        <div className="space-y-2"><Label htmlFor="g-in4">Input error</Label><Input id="g-in4" aria-invalid="true" className="border border-destructive" defaultValue="bad value" /></div>
                        <div className="space-y-2 sm:col-span-2"><Label htmlFor="g-ta">Textarea</Label><Textarea id="g-ta" placeholder="Write something" /></div>
                        <div className="space-y-2">
                            <Label>Select</Label>
                            <Select>
                                <SelectTrigger><SelectValue placeholder="Pick a network" /></SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="mtn">MTN</SelectItem>
                                    <SelectItem value="telecel">Telecel</SelectItem>
                                    <SelectItem value="at">AirtelTigo</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="flex items-center gap-4">
                            <label className="flex items-center gap-2 text-sm"><Checkbox /> Unchecked</label>
                            <label className="flex items-center gap-2 text-sm"><Checkbox checked={checked} onCheckedChange={(v) => setChecked(v === true)} /> Checked</label>
                        </div>
                        <div className="flex items-center gap-4">
                            <label className="flex items-center gap-2 text-sm"><Switch /> Off</label>
                            <label className="flex items-center gap-2 text-sm"><Switch checked={switchOn} onCheckedChange={setSwitchOn} /> On</label>
                        </div>
                    </div>
                </Section>

                <Section id="badges" title="Badges">
                    <Row label="Badge variants">
                        {BADGE_VARIANTS.map((v) => <Badge key={v} variant={v}>{v}</Badge>)}
                        <Badge className="bg-amber-100 text-amber-900">override amber</Badge>
                    </Row>
                    <Row label="Helper classes">
                        {['network-badge-mtn', 'network-badge-telecel', 'network-badge-airteltigo', 'status-pending', 'status-processing', 'status-completed', 'status-failed'].map((c) => (
                            <span key={c} className={`${c} inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold`}>{c}</span>
                        ))}
                    </Row>
                </Section>

                <Section id="alerts" title="Alerts">
                    {ALERT_VARIANTS.map((v) => (
                        <Alert key={v} variant={v}>
                            <AlertTitle>{v} alert</AlertTitle>
                            <AlertDescription>Alert description for the {v} variant.</AlertDescription>
                        </Alert>
                    ))}
                </Section>

                <Section id="tabs" title="Tabs">
                    <Tabs defaultValue="a">
                        <TabsList>
                            <TabsTrigger value="a">Data</TabsTrigger>
                            <TabsTrigger value="b">Airtime</TabsTrigger>
                            <TabsTrigger value="c">AFA</TabsTrigger>
                        </TabsList>
                        <TabsContent value="a">Data bundles panel</TabsContent>
                        <TabsContent value="b">Airtime panel</TabsContent>
                        <TabsContent value="c">AFA panel</TabsContent>
                    </Tabs>
                </Section>

                <Section id="table" title="Table (200 rows) and card list (100)">
                    <div className="max-h-[420px] overflow-auto rounded-xl border">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead className="sticky top-0 z-10 bg-background">#</TableHead>
                                    <TableHead className="sticky top-0 z-10 bg-background">Name</TableHead>
                                    <TableHead className="sticky top-0 z-10 bg-background">Network</TableHead>
                                    <TableHead className="sticky top-0 z-10 bg-background">Amount</TableHead>
                                    <TableHead className="sticky top-0 z-10 bg-background">Status</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {ROWS.map((r) => (
                                    <TableRow key={r.id}>
                                        <TableCell>{r.id}</TableCell>
                                        <TableCell>{r.name}</TableCell>
                                        <TableCell>{r.network}</TableCell>
                                        <TableCell>GHS {r.amount}</TableCell>
                                        <TableCell>{r.status}</TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                        {CARDS.map((n) => (
                            <Card key={n}>
                                <CardHeader><CardTitle className="text-base">Order #{n}</CardTitle></CardHeader>
                                <CardContent className="text-sm text-muted-foreground">1GB MTN data bundle</CardContent>
                            </Card>
                        ))}
                    </div>
                </Section>

                <Section id="overlays" title="Overlays">
                    <Row>
                        <Button onClick={() => setDialogOpen(true)}>Dialog</Button>
                        <Button variant="outline" onClick={() => setDialogNoCloseOpen(true)}>Dialog (hideCloseButton)</Button>
                        <Button variant="secondary" onClick={() => setSheetRightOpen(true)}>Sheet right</Button>
                        <Button variant="secondary" onClick={() => setSheetBottomOpen(true)}>Sheet bottom</Button>
                        <DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
                            <DropdownMenuTrigger asChild><Button variant="outline">Dropdown</Button></DropdownMenuTrigger>
                            <DropdownMenuContent>
                                <DropdownMenuLabel>My account</DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem>Profile</DropdownMenuItem>
                                <DropdownMenuItem>Settings</DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                        <Select open={selectOpen} onOpenChange={setSelectOpen}>
                            <SelectTrigger className="w-40"><SelectValue placeholder="Select open" /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="mtn">MTN</SelectItem>
                                <SelectItem value="telecel">Telecel</SelectItem>
                                <SelectItem value="at">AirtelTigo</SelectItem>
                            </SelectContent>
                        </Select>
                    </Row>
                    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                        <DialogContent>
                            <DialogHeader>
                                <DialogTitle>Dialog title</DialogTitle>
                                <DialogDescription>Dialog description text.</DialogDescription>
                            </DialogHeader>
                            <Input placeholder="Inside dialog" />
                            <DialogFooter><Button onClick={() => setDialogOpen(false)}>Confirm</Button></DialogFooter>
                        </DialogContent>
                    </Dialog>
                    <Dialog open={dialogNoCloseOpen} onOpenChange={setDialogNoCloseOpen}>
                        <DialogContent hideCloseButton>
                            <DialogHeader>
                                <DialogTitle>No close button</DialogTitle>
                                <DialogDescription>hideCloseButton set.</DialogDescription>
                            </DialogHeader>
                            <DialogFooter><Button onClick={() => setDialogNoCloseOpen(false)}>Done</Button></DialogFooter>
                        </DialogContent>
                    </Dialog>
                    <Sheet open={sheetRightOpen} onOpenChange={setSheetRightOpen}>
                        <SheetContent side="right">
                            <SheetHeader><SheetTitle>Sheet right</SheetTitle><SheetDescription>Right-side sheet.</SheetDescription></SheetHeader>
                        </SheetContent>
                    </Sheet>
                    <Sheet open={sheetBottomOpen} onOpenChange={setSheetBottomOpen}>
                        <SheetContent side="bottom">
                            <SheetHeader><SheetTitle>Sheet bottom</SheetTitle><SheetDescription>Bottom sheet.</SheetDescription></SheetHeader>
                        </SheetContent>
                    </Sheet>
                </Section>

                <Section id="misc" title="Misc">
                    <Pagination>
                        <PaginationContent>
                            <PaginationItem><PaginationPrevious href="#misc" /></PaginationItem>
                            <PaginationItem><PaginationLink href="#misc">1</PaginationLink></PaginationItem>
                            <PaginationItem><PaginationLink href="#misc" isActive>2</PaginationLink></PaginationItem>
                            <PaginationItem><PaginationLink href="#misc">3</PaginationLink></PaginationItem>
                            <PaginationItem><PaginationNext href="#misc" /></PaginationItem>
                        </PaginationContent>
                    </Pagination>
                    <div className="space-y-3">
                        <Progress value={0} />
                        <Progress value={40} />
                        <Progress value={100} />
                    </div>
                    <Separator />
                    <Row>
                        <Skeleton className="h-10 w-40" />
                        <Skeleton className="h-10 w-10 rounded-full" />
                        <Avatar><AvatarFallback>FT</AvatarFallback></Avatar>
                        <BrandLoader fullScreen={false} size="md" />
                    </Row>
                    <PinPad length={4} onComplete={() => undefined} title="Enter PIN" subtitle="Dummy handler" />
                    <Row label="Toasts">
                        <Button variant="success" onClick={() => toast.success('Success toast')}>success</Button>
                        <Button variant="destructive" onClick={() => toast.error('Error toast')}>error</Button>
                        <Button variant="outline" onClick={() => toast.info('Info toast')}>info</Button>
                        <Button variant="warning" onClick={() => toast.warning('Warning toast')}>warning</Button>
                    </Row>
                </Section>

                <Section id="helpers" title="Helper classes">
                    <div className="grid gap-4 sm:grid-cols-2">
                        <div className="glass-card rounded-2xl p-4">glass-card</div>
                        <div className="village-card rounded-2xl p-4">village-card</div>
                        <div className="interactive-card rounded-2xl border p-4">interactive-card (hover)</div>
                    </div>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                        <div className="gradient-primary rounded-xl p-4 text-white">gradient-primary</div>
                        <div className="gradient-success rounded-xl p-4 text-white">gradient-success</div>
                        <div className="gradient-warning rounded-xl p-4 text-black">gradient-warning</div>
                        <div className="gradient-danger rounded-xl p-4 text-white">gradient-danger</div>
                        <div className="gradient-mtn rounded-xl p-4 text-black">gradient-mtn</div>
                        <div className="gradient-telecel rounded-xl p-4 text-white">gradient-telecel</div>
                        <div className="gradient-airteltigo rounded-xl p-4 text-white">gradient-airteltigo</div>
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                        <div className="glow-primary rounded-xl border p-4">glow-primary</div>
                        <div className="glow-success rounded-xl border p-4">glow-success</div>
                        <div className="glow-warning rounded-xl border p-4">glow-warning</div>
                    </div>
                </Section>

                <Section id="contrast" title="Contrast checklist">
                    <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-1 rounded-xl p-4">
                            <p className="text-xs font-medium">On page surface</p>
                            <p className="text-slate-500">text-slate-500 sample</p>
                            <p className="text-slate-600">text-slate-600 sample</p>
                            <p className="text-slate-400 dark:text-slate-400">text-slate-400 dark:text-slate-400 sample</p>
                            <p className="text-muted-foreground">text-muted-foreground sample</p>
                        </div>
                        <Card>
                            <CardContent className="space-y-1 pt-6">
                                <p className="text-xs font-medium">On a card</p>
                                <p className="text-slate-500">text-slate-500 sample</p>
                                <p className="text-slate-600">text-slate-600 sample</p>
                                <p className="text-slate-400 dark:text-slate-400">text-slate-400 dark:text-slate-400 sample</p>
                                <p className="text-muted-foreground">text-muted-foreground sample</p>
                            </CardContent>
                        </Card>
                    </div>
                </Section>
            </main>
        </div>
    )
}
