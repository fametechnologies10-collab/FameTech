export interface ResultsCheckerVoucher {
    pin: string
    serial_number: string
}

export interface ResultsCheckerDownloadOrder {
    type_name?: string
    typeName?: string
    reference_code?: string
    referenceCode?: string
    created_at?: string | Date
}

export function normalizeResultsCheckerPhone(rawPhone: string): string {
    const normalized = String(rawPhone || '')
        .replace(/\s+/g, '')
        .replace(/-/g, '')
        .replace(/\+/g, '')

    if (normalized.startsWith('233') && normalized.length === 12) {
        return `0${normalized.slice(3)}`
    }

    return normalized
}

export function isValidResultsCheckerPhone(rawPhone: string): boolean {
    const normalized = normalizeResultsCheckerPhone(rawPhone)
    return /^0\d{9}$/.test(normalized)
}

export function getResultsCheckerPortal(typeName: string): string {
    const upperTypeName = String(typeName || '').toUpperCase()

    if (upperTypeName.includes('BECE')) {
        return 'eresults.waecgh.org'
    }

    if (upperTypeName.includes('WAEC') || upperTypeName.includes('WASSCE')) {
        return 'ghana.waecdirect.org'
    }

    return 'Please contact your exam board on how to print your results.'
}

export function buildResultsCheckerVoucherDownload(
    order: ResultsCheckerDownloadOrder,
    vouchers: ResultsCheckerVoucher[],
    phone?: string,
    email?: string,
    shopName?: string
): { filename: string; content: string } {
    const typeName = order.type_name || order.typeName || 'RESULTS'
    const upperTypeName = typeName.toUpperCase()
    const examPortal = getResultsCheckerPortal(typeName)
    const createdAt = order.created_at ? new Date(order.created_at) : new Date()
    const dateStr = createdAt.toISOString().split('T')[0]
    const timeStr = createdAt.toTimeString().split(' ')[0]

    const blocks = vouchers.map((voucher, index) => (
        [
            `Voucher ${index + 1}`,
            `Serial Number: ${voucher.serial_number}`,
            `PIN: ${voucher.pin}`,
            '-----------------------------------------',
        ].join('\n')
    )).join('\n')

    const content = [
        `${upperTypeName} CHECKER`,
        '-----------------------------------------',
        blocks,
        `Purchased by: Number: ${phone || 'N/A'}, Email: ${email || 'N/A'}`,
        `Date: ${dateStr} ${timeStr}`,
        `Reference: ${order.reference_code || order.referenceCode || 'N/A'}`,
        `Log on to: ${examPortal}`,
        `Powered by ${shopName || 'KiNG FLEXY GH'}`,
    ].join('\n')

    const filename = `${upperTypeName}-vouchers-${order.reference_code || order.referenceCode || 'receipt'}.txt`
        .replace(/\s+/g, '-')

    return { filename, content }
}

export function downloadResultsCheckerVouchers(
    order: ResultsCheckerDownloadOrder,
    vouchers: ResultsCheckerVoucher[],
    phone?: string,
    email?: string,
    shopName?: string
): void {
    if (typeof document === 'undefined') {
        return
    }

    const { filename, content } = buildResultsCheckerVoucherDownload(order, vouchers, phone, email, shopName)
    const blob = new Blob([content], { type: 'text/plain' })
    const link = document.createElement('a')

    link.href = URL.createObjectURL(blob)
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(link.href)
}
