// Single source of truth for the public developer-facing product pages
// (/developers/<slug>), /llms.txt and the sitemap. Facts here mirror
// postman/specs/openapi.yaml — change the spec first, then this file.

export const API_BASE = 'https://api.kingflexygh.com/api/v2'
export const SITE = 'https://kingflexygh.com'
export const USSD_SHORTCODE = process.env.NEXT_PUBLIC_USSD_SHORTCODE ?? '*713*9939#'

export type KeyType = 'standard' | 'commission' | 'sms'

export const KEY_INFO: Record<KeyType, { label: string; prefix: string }> = {
    standard: { label: 'Standard API key', prefix: 'kf_live_' },
    commission: { label: 'Commission Services API key', prefix: 'kf_cs_live_' },
    sms: { label: 'SMS API key', prefix: 'kf_sms_live_' },
}

export interface ProductEndpoint {
    method: 'GET' | 'POST'
    path: string
    summary: string
}

export interface DeveloperProduct {
    slug: string
    name: string
    title: string
    description: string
    intro: string
    keyType: KeyType | null
    endpoints: ProductEndpoint[]
    curl: string | null
    ussd: string | null
    keywords: string[]
}

const q = (s: string) => s.replace(/'/g, "'\\''")

function curlPost(path: string, key: string, body: object): string {
    return [
        `curl -X POST '${API_BASE}${path}' \\`,
        `  -H 'Authorization: ${key}' \\`,
        `  -H 'Content-Type: application/json' \\`,
        `  -d '${q(JSON.stringify(body, null, 2))}'`,
    ].join('\n')
}

const USSD_ALL_PRODUCTS = `Customers can also buy this on USSD by dialling ${USSD_SHORTCODE}. Shop owners can activate their own USSD code branded with their shop name from Dashboard > Shop > USSD.`

export const DEVELOPER_PRODUCTS: DeveloperProduct[] = [
    {
        slug: 'data-bundles',
        name: 'Data Bundles API',
        title: 'Data Bundles API Ghana — MTN, Telecel & AirtelTigo',
        description:
            'Buy MTN, Telecel, AT-iShare and AT-BigTime data bundles programmatically in Ghana. Single and bulk (up to 100) purchases, number verification, order status, wallet-based billing and idempotent references.',
        intro:
            'Resell data bundles from your own app, website or bot. List live packages with prices for your account role, place single or bulk orders paid from your wallet, and poll order status. Ghana networks only.',
        keyType: 'standard',
        endpoints: [
            { method: 'GET', path: '/packages', summary: 'List available data packages with pricing for your role' },
            { method: 'POST', path: '/data/purchase', summary: 'Purchase a single data bundle' },
            { method: 'POST', path: '/data/bulk', summary: 'Purchase up to 100 data bundles in one batch' },
            { method: 'POST', path: '/data/verify-number', summary: 'Check a number against Server 1 and Server 2 combined' },
            { method: 'GET', path: '/orders/{reference}', summary: 'Check a data order\'s fulfillment status' },
            { method: 'GET', path: '/wallet/balance', summary: 'Get your wallet balance' },
        ],
        curl: curlPost('/data/purchase', 'kf_live_your_api_key_here', {
            network: 'MTN',
            volume_gb: 5,
            recipient: '0551617309',
            reference: 'order-1001',
        }),
        ussd: USSD_ALL_PRODUCTS,
        keywords: ['data bundle API Ghana', 'MTN data API', 'Telecel data API', 'AirtelTigo data API', 'bulk data API Ghana', 'data reseller API'],
    },
    {
        slug: 'airtime',
        name: 'Airtime API',
        title: 'Airtime API Ghana — MTN, Telecel & AirtelTigo Top-up',
        description:
            'Top up MTN, Telecel and AirtelTigo airtime at face value through a REST API in Ghana, with commission for lifetime agents and dealers.',
        intro:
            'Top up airtime at face value with no fee. Lifetime agents and dealers earn a share of the provider commission into a dedicated Commission Wallet. Orders dispatch in the background and you poll for the final status.',
        keyType: 'commission',
        endpoints: [
            { method: 'POST', path: '/airtime/purchase', summary: 'Top up airtime' },
            { method: 'GET', path: '/airtime/orders', summary: 'List your recent airtime orders' },
            { method: 'GET', path: '/airtime/orders/{reference}', summary: 'Check one airtime order\'s status' },
        ],
        curl: curlPost('/airtime/purchase', 'kf_cs_live_your_commission_key_here', {
            network: 'MTN',
            beneficiary_phone: '0551617309',
            amount: 10,
            reference: 'airtime-1001',
        }),
        ussd: USSD_ALL_PRODUCTS,
        keywords: ['airtime API Ghana', 'VTU API Ghana', 'MTN airtime API', 'airtime top-up API'],
    },
    {
        slug: 'results-checker',
        name: 'Results Checker API',
        title: 'WAEC, BECE & WASSCE Results Checker API Ghana',
        description:
            'Sell WAEC, BECE and WASSCE results checker vouchers through an API in Ghana. Stock is checked before your wallet is charged and vouchers are returned in the same response.',
        intro:
            'List voucher types with your role-based price and live stock, then buy one or many vouchers. Vouchers come back directly in the purchase response, with optional SMS or email delivery to the buyer.',
        keyType: 'standard',
        endpoints: [
            { method: 'GET', path: '/resultschecker/types', summary: 'List voucher types with your role-based price and stock' },
            { method: 'POST', path: '/resultschecker/purchase', summary: 'Buy voucher(s)' },
            { method: 'GET', path: '/resultschecker/orders', summary: 'List your recent results checker orders' },
            { method: 'GET', path: '/resultschecker/orders/{reference}', summary: 'Look up one order, including its vouchers again' },
        ],
        curl: curlPost('/resultschecker/purchase', 'kf_live_your_api_key_here', {
            typeId: 'voucher-type-uuid-from-/resultschecker/types',
            quantity: 1,
            reference: 'rc-1001',
        }),
        ussd: USSD_ALL_PRODUCTS,
        keywords: ['results checker API Ghana', 'WAEC checker API', 'BECE checker API', 'WASSCE result checker API'],
    },
    {
        slug: 'afa-registration',
        name: 'AFA Registration API',
        title: 'MTN AFA Registration API Ghana',
        description:
            'Submit MTN AFA (Authorized Field Agent) registrations on behalf of customers through an API in Ghana. Permanent registration, Ghana Card based, with status tracking.',
        intro:
            'Register customers for MTN AFA programmatically. Each registration needs a valid Ghana Card and a supported region, and you can track every registration by its reference.',
        keyType: 'standard',
        endpoints: [
            { method: 'POST', path: '/afa/register', summary: 'Submit an MTN AFA registration (permanent, no expiry)' },
            { method: 'GET', path: '/afa/orders', summary: 'List your recent AFA registrations' },
            { method: 'GET', path: '/afa/orders/{reference}', summary: 'Check one AFA registration\'s status' },
        ],
        curl: curlPost('/afa/register', 'kf_live_your_api_key_here', {
            reference: 'afa-1001',
            full_name: 'Ama Mensah',
            phone: '0551617309',
            id_type: 'Ghana Card',
            id_number: 'GHA-123456789-0',
            date_of_birth: '1995-04-12',
            region: 'Greater Accra',
            location: 'Madina',
        }),
        ussd: USSD_ALL_PRODUCTS,
        keywords: ['AFA registration API Ghana', 'MTN AFA API', 'AFA agent registration Ghana'],
    },
    {
        slug: 'sms',
        name: 'SMS API',
        title: 'Bulk SMS API Ghana — Send OTP, Alerts & Campaigns',
        description:
            'Send bulk and transactional SMS in Ghana through a REST API. Up to 10,000 recipients per request, approved sender IDs, delivery tracking and credit balance.',
        intro:
            'Send OTPs, order updates and campaigns from your own systems. Small sends (up to 500 recipients) dispatch immediately and larger sends are queued and processed within a minute, with per-recipient delivery tracking.',
        keyType: 'sms',
        endpoints: [
            { method: 'POST', path: '/sms/send', summary: 'Send an SMS to one or many recipients' },
            { method: 'GET', path: '/sms/senders', summary: 'List sender IDs this key may send under' },
            { method: 'GET', path: '/sms/campaigns', summary: 'List your recent SMS campaigns' },
            { method: 'GET', path: '/sms/messages/{id}', summary: 'Delivery status for a campaign' },
            { method: 'GET', path: '/sms/balance', summary: 'Your SMS credit balance' },
        ],
        curl: curlPost('/sms/send', 'kf_sms_live_your_sms_key_here', {
            message: 'Your verification code is 482913',
            recipients: ['0551617309'],
            reference: 'sms-1001',
        }),
        ussd: null,
        keywords: ['bulk SMS API Ghana', 'SMS API Ghana', 'OTP SMS API Ghana', 'transactional SMS Ghana'],
    },
    {
        slug: 'utility-bills',
        name: 'Utility Bills API',
        title: 'Utility Bill Payment API Ghana — ECG, Ghana Water, DStv, GOtv, StarTimes',
        description:
            'Pay ECG, Ghana Water, DStv, GOtv and StarTimes bills through an API in Ghana. Verify accounts before paying and earn commission on every payment.',
        intro:
            'List billers, verify an account or meter, pay at face value from your wallet and poll the order status. Commission is paid into a dedicated Commission Wallet.',
        keyType: 'commission',
        endpoints: [
            { method: 'GET', path: '/utilities/billers', summary: 'Full biller catalog' },
            { method: 'GET', path: '/utilities/lookup', summary: 'Verify an account before paying' },
            { method: 'POST', path: '/utilities/pay', summary: 'Pay a bill at face value from your wallet' },
            { method: 'GET', path: '/utilities/orders/{reference}', summary: 'Poll a utility bill order\'s status' },
        ],
        curl: curlPost('/utilities/pay', 'kf_cs_live_your_commission_key_here', {
            biller: 'dstv',
            account: '1234567890',
            amount: 50,
            reference: 'bill-1001',
        }),
        ussd: USSD_ALL_PRODUCTS,
        keywords: ['utility bill API Ghana', 'ECG bill payment API', 'Ghana Water API', 'DStv payment API Ghana', 'GOtv API', 'StarTimes API'],
    },
    {
        slug: 'ussd',
        name: 'USSD for Resellers',
        title: 'USSD for Data Resellers in Ghana — Your Own Branded USSD Code',
        description:
            `Resellers on KiNG FLEXY GH can sell data bundles, mashup, airtime, results checkers, AFA registrations and utility bills over USSD. Customers dial ${USSD_SHORTCODE}, or a shop owner activates their own USSD code branded in their shop name.`,
        intro:
            `Many data resellers need USSD because their customers do not use smartphones or apps. KiNG FLEXY GH supports USSD for its products in two ways: the shared shortcode ${USSD_SHORTCODE}, and a USSD code each shop owner can activate and brand in their own name.`,
        keyType: null,
        endpoints: [],
        curl: null,
        ussd: null,
        keywords: ['USSD data reseller Ghana', 'sell data on USSD Ghana', 'branded USSD code Ghana', 'USSD shop Ghana'],
    },
]

export function getProduct(slug: string): DeveloperProduct | undefined {
    return DEVELOPER_PRODUCTS.find(p => p.slug === slug)
}

export const USSD_DETAILS: string[] = [
    `Shared shortcode: customers dial ${USSD_SHORTCODE} and can buy data bundles, mashup, airtime, WAEC/BECE results checkers, MTN AFA registration and utility bills.`,
    'Your own branded USSD code: a shop owner activates USSD for their shop from Dashboard > Shop > USSD, then customises the code and brands it in their own name to share with customers.',
    'USSD is a dashboard and reseller feature. It is not exposed as a developer API endpoint.',
    'SMS sending is API and dashboard only and is not sold over USSD.',
]

export function llmsTxt(): string {
    const lines: string[] = []
    lines.push('# KiNG FLEXY GH')
    lines.push('')
    lines.push(
        '> KiNG FLEXY GH (KiNG FLEXY TECHNOLOGIES LTD) is a Ghana digital services platform and developer API: MTN, Telecel and AirtelTigo data bundles, airtime, WAEC/BECE results checker vouchers, MTN AFA registration, utility bill payments (ECG, Ghana Water, DStv, GOtv, StarTimes), and bulk SMS. Resellers can also sell these over USSD. Ghana only.',
    )
    lines.push('')
    lines.push('## API')
    lines.push('')
    lines.push(`- Base URL: ${API_BASE}`)
    lines.push('- Auth: send your API key RAW in the Authorization header (no "Bearer" prefix).')
    lines.push('- Key types: standard (kf_live_...) for data, results checker, AFA, wallet and orders; commission (kf_cs_live_...) for airtime and utility bills; SMS (kf_sms_live_...) for SMS.')
    lines.push('- Money-moving endpoints take a unique `reference` as an idempotency key.')
    lines.push(`- [Full API documentation](${SITE}/developers)`)
    lines.push(`- [OpenAPI 3 specification](${SITE}/openapi.yaml)`)
    lines.push('')
    lines.push('## Products')
    lines.push('')
    for (const p of DEVELOPER_PRODUCTS) {
        lines.push(`- [${p.name}](${SITE}/developers/${p.slug}): ${p.description}`)
    }
    lines.push('')
    lines.push('## USSD')
    lines.push('')
    for (const d of USSD_DETAILS) lines.push(`- ${d}`)
    lines.push('')
    lines.push('## Getting an API key')
    lines.push('')
    lines.push(`Sign in or register at ${SITE}/auth, then follow the steps in ${SITE}/developers#authentication (Dashboard > Developer API). Keys are shown once and need admin approval before they go live. The agent.kingflexygh.com site is only a login page for existing sub-agent accounts and is not where developers sign up.`)
    lines.push('')
    return lines.join('\n')
}
