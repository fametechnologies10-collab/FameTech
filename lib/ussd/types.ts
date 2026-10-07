// =============================================================================
// Hubtel USSD — Shared TypeScript Types
// =============================================================================

// Inbound push from Hubtel to /api/ussd/interact
export interface HubtelRequest {
    Type: 'Initiation' | 'Response' | 'Timeout'
    Mobile: string        // 233XXXXXXXXX format from Hubtel
    SessionId: string
    ServiceCode: string   // "9939"
    Message: string       // raw user input
    Operator: string      // mtn | vodafone | airteltigo
    Sequence: number
    ClientState: string
    Platform: 'USSD' | 'Hubtel-App' | 'Webstore'
}

// Outbound response from our app to Hubtel
export interface HubtelResponse {
    SessionId: string
    Type: 'response' | 'release' | 'AddToCart'
    Message: string
    Label: string
    ClientState?: string
    DataType: 'display' | 'input'
    FieldType: 'text' | 'phone' | 'number' | 'decimal' | 'email' | 'textarea'
    Sequence?: number
    Item?: CartItem
}

// Item payload for AddToCart (triggers Hubtel MoMo payment prompt)
export interface CartItem {
    ItemName: string
    Qty: number
    Price: number
}

// Hubtel service fulfillment payload (POST to /api/ussd/fulfill after MoMo payment)
export interface HubtelFulfillment {
    SessionId: string
    OrderId: string
    ExtraData: Record<string, unknown>
    OrderInfo: {
        CustomerMobileNumber: string
        CustomerEmail: string | null
        CustomerName: string
        Status: string
        OrderDate: string
        Currency: string
        Subtotal: number
        Items: Array<{
            ItemId: string
            Name: string
            Quantity: number
            UnitPrice: number
        }>
        Payment: {
            PaymentType: string
            AmountPaid: number
            AmountAfterCharges: number
            PaymentDate: string
            PaymentDescription: string
            IsSuccessful: boolean
        }
    }
}

// Session state stored as JSON in ClientState
export interface USSDState {
    step: string
    service?: 'data' | 'results_checker' | 'afa' | 'airtime' | 'utility' | 'mashup'
    // Populated in main-menu for dynamic routing.
    // Holds service names, package UUIDs, quantities, or special strings — all safe without casting.
    menuMap?: Record<string, string | number>
    // Resume flow
    resuming?: boolean
    // Data bundle flow
    network?: string
    packageId?: string
    packageSize?: string
    bundlePage?: number
    // Results checker flow
    rcTypeId?: string
    rcTypeName?: string
    rcUnitPrice?: number
    rcQuantity?: number
    rcQtyPage?: number  // current page index (0-based) of the quantity menu
    // Shop USSD context (set when guest enters valid shop code)
    shopId?:           string
    shopName?:         string
    shopContactPhone?: string
    codeAttempts?:     number
    rcShopMarkup?:     number  // RC per-unit shop markup, carried at top level (menuMap gets overwritten by showQuantityMenu)
    rcOwnerRole?:      string  // shop owner's effective role — lets the qty menu re-price bulk tiers via calculateRCPrice
    rcRawMarkup?:      number  // uncapped per-exam markup (calculateRCPrice applies the cap) for bulk re-pricing
    // AFA registration flow
    afaFullName?: string
    afaIdType?: string
    afaIdNumber?: string
    afaPhone?: string
    afaRegion?: string
    afaRegionPage?: number
    afaLocation?: string
    afaDob?: string
    afaOccupation?: string
    // Airtime flow (Hubtel Commission auto-fulfillment) — exact mode: beneficiary gets airtimeAmount,
    // customer pays `price` (= airtimeAmount + fee). Fee split carried so fulfillment records it without recompute.
    airtimeAmount?: number
    feeAmount?: number
    adminFeeAmount?: number
    shopFeeAmount?: number
    shopOwnerId?: string
    shopOwnerRole?: string
    // Utility bills flow (Task F-flow, USSD leg — ECG / Ghana Water / DSTV / GOtv /
    // StarTimes via Hubtel Commission Services). Face-value only: no USSD fee, no markup.
    utilityBiller?: string              // UtilityBiller key ('ecg' | 'ghana_water' | 'dstv' | 'gotv' | 'startimes')
    utilityAccount?: string             // meter / smartcard / account number
    utilityAccountName?: string         // name from the provider lookup — TRUNCATED to ≤24 chars before storage
    utilityAmountDue?: number           // outstanding balance from the lookup (ecg meters always have one; GW/TV may not)
    utilityPhone?: string               // 233..., the customer MSISDN used for the lookup (session or entered)
    utilityMeterMap?: Record<string, string>  // ECG meter-list page: option -> "meterNumber|name24|outstanding", dropped once a meter is picked
    utilityMeterPage?: number           // ECG meter-list current page (0-based) — re-queried per page, never cached across pages
    utilityAmount?: number              // amount entered at utility_amount, GHS
    // Two deliberate additions beyond the brief's pinned field list (both small/optional,
    // negligible ClientState cost): a lookup-attempts counter so a flaky/failing Hubtel
    // account query can fail closed after 2 tries (brief step 2) without an infinite retry
    // loop, and the StarTimes bouquet label so the confirm screen can be re-rendered
    // byte-identically (e.g. on an invalid confirm keypress) without re-querying Hubtel.
    utilityLookupAttempts?: number
    utilityBouquet?: string             // StarTimes only — TRUNCATED to ≤12 chars before storage
    // Shared
    recipientPhone?: string
    price?: number              // amount the guest is charged (incl. any USSD fee)
    shopBasePrice?: number      // shop's selling price BEFORE the shop USSD fee (shop accounting only)
    paymentMethod?: 'momo' | 'wallet'   // chosen payment method, set in payment_method step
}

// A single active service item with its dynamic menu number
export interface MenuItemDef {
    key: 'data' | 'results_checker' | 'afa' | 'airtime' | 'utility' | 'mashup'
    label: string
    number: number
}

export interface ActiveMenuConfig {
    items: MenuItemDef[]
    menuText: string
    menuMap: Record<string, 'data' | 'results_checker' | 'afa' | 'airtime' | 'utility' | 'mashup'>
    header: string
}

// Resolved user account (nullable — guest users have no account)
export interface USSDUser {
    id: string
    role: string
    agentExpiresAt: string | null
    dealerExpiresAt: string | null
    firstName?: string      // user's first_name from users table
    walletId?: string       // wallet UUID from wallets table (needed for wallet_transactions insert)
    walletBalance?: number  // current wallet balance in GHS
}
