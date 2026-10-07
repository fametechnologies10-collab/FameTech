import type { SupabaseClient } from '@supabase/supabase-js'
import type { HubtelRequest, HubtelResponse, ActiveMenuConfig, USSDState } from '../types'
import { respond, release } from '../utils'
import { getResumeSession, clearInterruptedSession } from '../session'
import { handleData } from './data'
import { handleResultsChecker } from './results-checker'
import { handleAfa } from './afa'
import { handleAirtime } from './airtime'
import { handleMashup } from './mashup'
import { handleUtility } from './utility'
import { resolveShopByCode, type ShopUSSDContext } from '../shop-resolver'
import { findUserByMobile } from '../price-resolver'
import { getAdminSetting, getAdminSettings } from '@/lib/admin-settings-cache'

// PERF (2026-09-27): these menu toggles were read fresh from admin_settings on
// every USSD step (~5k round-trips/day on the Hubtel hot path). They now go
// through the shared 60s cache — the same bound already accepted for the
// ussd_enabled kill switch. Money keys (fees) are deliberately NOT read here.
const MAIN_MENU_KEYS = [
    'ussd_data_enabled', 'ussd_rc_enabled', 'ussd_afa_enabled', 'ussd_airtime_enabled',
    'ussd_mashup_enabled',
    // Utility bills gates (Task F-flow): ussd_utility_enabled AND the feature-wide
    // utility_bills_enabled kill-switch AND at least one biller enabled.
    'ussd_utility_enabled', 'utility_bills_enabled', 'hubtel_utility_billers',
    'ussd_helpline',
] as const
const SHOP_MENU_KEYS = [
    'ussd_data_enabled', 'ussd_rc_enabled', 'ussd_afa_enabled', 'ussd_airtime_enabled', 'ussd_mashup_enabled',
    'ussd_utility_enabled', 'utility_bills_enabled', 'hubtel_utility_billers',
] as const

// =============================================================================
// Main menu — dynamic numbering based on admin kill switches
// =============================================================================

/** hubtel_utility_billers is a real JSONB object (not a JSON-string toggle like the
 *  other admin_settings values) — true when at least one biller is switched on. */
function hasEnabledBiller(billersMap: unknown): boolean {
    if (!billersMap || typeof billersMap !== 'object' || Array.isArray(billersMap)) return false
    return Object.values(billersMap as Record<string, unknown>).some((v) => v === true)
}

/** Fetch the USSD header from admin_settings (brand + helpline) */
async function getUSSDHeader(supabase: SupabaseClient): Promise<string> {
    const menu = await getActiveMenuConfig(supabase)
    return menu.header
}

/** Fetch which services are enabled from admin_settings */
async function getActiveMenuConfig(_supabase: SupabaseClient): Promise<ActiveMenuConfig> {
    const map: Record<string, any> = await getAdminSettings(MAIN_MENU_KEYS)

    const dataOn = map['ussd_data_enabled'] !== 'false'
    const rcOn   = map['ussd_rc_enabled']   !== 'false'
    const afaOn  = map['ussd_afa_enabled']  !== 'false'
    // Airtime + Mashup + Utility ship OFF — only surfaced when explicitly enabled in admin.
    const airtimeOn = map['ussd_airtime_enabled'] === 'true'
    const mashupOn = map['ussd_mashup_enabled'] === 'true'
    const utilityOn = map['ussd_utility_enabled'] === 'true'
        && map['utility_bills_enabled'] === 'true'
        && hasEnabledBiller(map['hubtel_utility_billers'])

    const helpline = map['ussd_helpline']?.trim()
    const header = helpline
        ? `Welcome to FameTech\nHelp Line: ${helpline}`
        : 'Welcome to FameTech'

    const items: ActiveMenuConfig['items'] = []
    const menuMap: Record<string, 'data' | 'results_checker' | 'afa' | 'airtime' | 'mashup' | 'utility'> = {}
    let n = 1

    if (dataOn) {
        items.push({ key: 'data', label: 'Data Bundles', number: n })
        menuMap[String(n)] = 'data'
        n++
    }
    if (rcOn) {
        items.push({ key: 'results_checker', label: 'Waec Results Checker', number: n })
        menuMap[String(n)] = 'results_checker'
        n++
    }
    if (afaOn) {
        items.push({ key: 'afa', label: 'AFA Registration', number: n })
        menuMap[String(n)] = 'afa'
        n++
    }
    if (airtimeOn) {
        items.push({ key: 'airtime', label: 'Buy Airtime', number: n })
        menuMap[String(n)] = 'airtime'
        n++
    }
    if (mashupOn) {
        items.push({ key: 'mashup', label: 'Buy Mashup', number: n })
        menuMap[String(n)] = 'mashup'
        n++
    }
    if (utilityOn) {
        items.push({ key: 'utility', label: 'Pay Utility Bill', number: n })
        menuMap[String(n)] = 'utility'
        n++
    }

    const lines = [header, '', 'Choose a Service:']
    for (const item of items) lines.push(`${item.number}. ${item.label}`)
    lines.push('0. Exit')

    return { items, menuText: lines.join('\n'), menuMap, header }
}

/** Get configured resume window in minutes */
async function getResumeWindow(_supabase: SupabaseClient): Promise<number> {
    const val = parseInt((await getAdminSetting('ussd_session_resume_minutes')) ?? '30', 10)
    return isNaN(val) ? 30 : val
}

export async function isStorefrontMode(_supabase: SupabaseClient): Promise<boolean> {
    return (await getAdminSetting('ussd_storefront_mode')) === 'true'
}

/** Storefront-mode shop-code prompt (shown to unregistered guests). */
function promptShopCode(req: HubtelRequest): HubtelResponse {
    const codeState: USSDState = { step: 'shop_code_entry', codeAttempts: 0 }
    return respond(
        req.SessionId,
        'Fame Technologies\n\nEnter your 4-character\nshop code or 0 to exit:',
        codeState,
        'Fame Technologies',
    )
}

/**
 * Start a fresh session. The storefront gate is enforced inside showMainMenu()
 * itself (single choke point, see its comment) — this wrapper exists purely
 * for call-site readability at the places that mean "abandon any shop/resume
 * context and start over".
 */
async function startFreshRespectingGate(
    req: HubtelRequest,
    supabase: SupabaseClient,
): Promise<HubtelResponse> {
    return showMainMenu(req, supabase)
}

async function showShopMenu(
    req: HubtelRequest,
    state: USSDState,
    shop: ShopUSSDContext,
    supabase: SupabaseClient,
): Promise<HubtelResponse> {
    const map: Record<string, any> = await getAdminSettings(SHOP_MENU_KEYS)

    const dataOn = map['ussd_data_enabled'] !== 'false'
    const rcOn   = map['ussd_rc_enabled']   !== 'false'
    // AFA is a normal shop product — resolveShopAfaPricing (lib/ussd/price-resolver.ts) already
    // branches internally for sub-agent vs. agent/dealer-owned shops and guards against an
    // underwater sub-agent cost, so (unlike utility) no extra per-shop/role gate is needed here.
    const afaOn  = map['ussd_afa_enabled']  !== 'false'
    const airtimeOn = map['ussd_airtime_enabled'] === 'true'
    const mashupOn = map['ussd_mashup_enabled'] === 'true'
    let utilityOn = map['ussd_utility_enabled'] === 'true'
        && map['utility_bills_enabled'] === 'true'
        && hasEnabledBiller(map['hubtel_utility_billers'])

    // Per-shop gate: the storefront toggle (app/api/shop/utility-settings/route.ts) is the single
    // enforcement point for shop-attributed utility commission — credit_utility_commission's
    // shop_id branch pays the shop owner with NO role re-check on the strength of it. The USSD
    // shop menu must therefore honour the same toggle AND the same agent/dealer role rule, or it
    // becomes an ungated side door to that commission. Only queried when the platform-level gates
    // already passed, so the common (feature-off) path costs nothing extra. ShopUSSDContext only
    // reliably carries `id` across both call paths (fresh resolve vs. session-restored), so we
    // re-query shop_profiles by id rather than adding fields to that type.
    if (utilityOn) {
        const { data: shopRow } = await supabase
            .from('shop_profiles')
            .select('utilities_enabled, owner:users!shop_profiles_owner_id_fkey(role)')
            .eq('id', shop.id)
            .maybeSingle()
        const ownerRole = (shopRow as any)?.owner?.role
        // Task 3: a sub-agent owner's users.role is literally 'subagent' (never
        // 'agent'/'dealer' — see lib/sub-agent-create.ts), so the gate must list it
        // explicitly or a sub-agent-owned shop's utility bill payments silently vanish
        // from its USSD menu even with utilities_enabled=true.
        utilityOn = (shopRow as any)?.utilities_enabled === true
            && (ownerRole === 'agent' || ownerRole === 'dealer' || ownerRole === 'subagent')
    }

    const header = `${shop.shopName}\nHelp Line: ${shop.ownerPhone}`
    const menuMap: Record<string, 'data' | 'results_checker' | 'afa' | 'airtime' | 'mashup' | 'utility'> = {}
    const lines = [header, '', 'Choose a Service:']
    let n = 1

    if (dataOn) {
        lines.push(`${n}. Data Bundles`)
        menuMap[String(n)] = 'data'
        n++
    }
    if (rcOn) {
        lines.push(`${n}. Results Checker`)
        menuMap[String(n)] = 'results_checker'
        n++
    }
    if (afaOn) {
        lines.push(`${n}. AFA Registration`)
        menuMap[String(n)] = 'afa'
        n++
    }
    if (airtimeOn) {
        lines.push(`${n}. Buy Airtime`)
        menuMap[String(n)] = 'airtime'
        n++
    }
    if (mashupOn) {
        lines.push(`${n}. Buy Mashup`)
        menuMap[String(n)] = 'mashup'
        n++
    }
    if (utilityOn) {
        lines.push(`${n}. Pay Utility Bill`)
        menuMap[String(n)] = 'utility'
        n++
    }
    lines.push('0. Exit')

    if (n === 1) {
        return release(req.SessionId, `${shop.shopName}\n\nNo services available right now.`)
    }

    const newState: USSDState = {
        step: 'main_choice',
        menuMap,
        shopId:           shop.id,
        shopName:         shop.shopName,
        shopContactPhone: shop.ownerPhone,
    }
    return respond(req.SessionId, lines.join('\n'), newState, shop.shopName)
}

async function handleShopCodeEntry(
    req: HubtelRequest,
    state: USSDState,
    supabase: SupabaseClient,
): Promise<HubtelResponse> {
    const { SessionId, Message } = req
    const input = Message.trim()

    if (input === '0') {
        return release(SessionId, 'Thank you for using Fame Technologies. Goodbye!')
    }

    const shop = await resolveShopByCode(supabase, input)

    if (!shop) {
        const attempts = (state.codeAttempts ?? 0) + 1
        if (attempts >= 3) {
            return release(
                SessionId,
                'Invalid code. Please contact your shop owner for a valid shop code. Thank you.',
            )
        }
        const remaining = 3 - attempts
        const retryState: USSDState = { step: 'shop_code_entry', codeAttempts: attempts }
        return respond(
            SessionId,
            `Invalid code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.\n\nEnter your 4-character\nshop code or 0 to exit:`,
            retryState,
            'Fame Technologies',
        )
    }

    return showShopMenu(req, state, shop, supabase)
}

// =============================================================================
// Main handler
// =============================================================================

export async function handleMainMenu(
    req: HubtelRequest,
    state: USSDState,
    supabase: SupabaseClient,
): Promise<HubtelResponse> {
    const { SessionId, Message, Mobile } = req

    // ── Shop code entry (storefront mode) ─────────────────────────────────
    if (state.step === 'shop_code_entry') {
        return handleShopCodeEntry(req, state, supabase)
    }

    // ── "0. Exit" from the main choice screen only ────────────────────────
    // Service handlers manage their own 0=back logic at every step.
    if (Message.trim() === '0' && state.step === 'main_choice') {
        return release(SessionId, 'Thank you for using Fame Technologies. Goodbye!')
    }

    // ── Resume flow ────────────────────────────────────────────────────────
    if (state.step === 'main_resume') {
        return handleResumeChoice(req, state, supabase)
    }

    // ── Initial main menu (Initiation or step='main') ──────────────────────
    if (state.step === 'main') {
        // Offer to continue an interrupted session FIRST — guests included. A
        // guest's interrupted state carries its shopId, so resuming keeps the
        // shop's pricing and skips re-entering the shop code. (Choosing "start
        // new" re-applies the storefront gate — enforced inside showMainMenu.)
        const windowMinutes = await getResumeWindow(supabase)
        const resumeSession = await getResumeSession(supabase, Mobile, windowMinutes)

        if (resumeSession) {
            const header = await getUSSDHeader(supabase)
            const newState: USSDState = {
                step: 'main_resume',
                // We embed the interrupted state's service for context
                service: resumeSession.interrupted_state.service,
                // Store the old session_id so we can restore it
                menuMap: { restore: resumeSession.session_id },
            }
            return respond(
                SessionId,
                `${header}\nYou have an unfinished session.\n\n1. Continue where you left off\n2. Start a new session`,
                newState,
                'Resume session',
            )
        }

        // No session to resume — the storefront gate is enforced inside showMainMenu.
        return showMainMenu(req, supabase)
    }

    // ── Main menu choice ───────────────────────────────────────────────────
    if (state.step === 'main_choice') {
        return handleMainChoice(req, state, supabase)
    }

    // ── Delegate to service handler ────────────────────────────────────────
    // The default goes through dispatchService so an unknown/service-less state
    // re-applies the storefront gate for guests instead of leaking the global
    // admin menu (same hole as the resume path — see dispatchService).
    return dispatchService(req, state, supabase)
}

async function showMainMenu(req: HubtelRequest, supabase: SupabaseClient): Promise<HubtelResponse> {
    // CHOKE POINT: this is the only function that renders the global,
    // un-scoped (admin-priced) menu. Every caller MUST pass through here —
    // no call site may skip this check. An unregistered guest must never see
    // the global menu while storefront mode is on, no matter which path got
    // here (fresh dial, resume, retry, or a path not yet discovered).
    // Order 1ff7c45f (see commit 1a653a20) traced back to exactly this failure
    // mode — a call site reaching the global menu without gating a guest
    // first. A second live occurrence (guest attribution lost across a
    // redial) was found in production on 2026-07-27, prompting this
    // consolidation. Moving the check here instead of duplicating it at each
    // call site means a future call site cannot reintroduce the same class
    // of bug.
    if (await isStorefrontMode(supabase)) {
        const user = await findUserByMobile(supabase, req.Mobile)
        if (!user) {
            console.warn(`[USSD] Guest ${req.Mobile} routed to global menu gate — showing shop-code prompt (session ${req.SessionId})`)
            return promptShopCode(req)
        }
    }

    const menu = await getActiveMenuConfig(supabase)

    if (menu.items.length === 0) {
        return release(
            req.SessionId,
            'Fame Technologies\nAll services are currently unavailable. Please try again later.',
        )
    }

    const state: USSDState = { step: 'main_choice', menuMap: menu.menuMap }
    return respond(req.SessionId, menu.menuText, state, menu.header)
}

async function handleMainChoice(
    req: HubtelRequest,
    state: USSDState,
    supabase: SupabaseClient,
): Promise<HubtelResponse> {
    const { SessionId, Message } = req
    const choice = Message.trim()

    if (choice === '0') {
        return release(SessionId, 'Thank you for using Fame Technologies. Goodbye!')
    }

    const menuMap = state.menuMap ?? {}
    const service = menuMap[choice]

    if (!service) {
        // Shop session: re-show the SHOP menu (keeping shop context). Falling back
        // to the admin menu here would both leak the shop's pricing and offer
        // services the shop never enabled.
        if (state.shopId) {
            const shopCtx: ShopUSSDContext = {
                id:         state.shopId,
                shopName:   state.shopName ?? '',
                ownerPhone: state.shopContactPhone ?? '',
                rcMarkup:   0, // unused for menu display; RC handler re-queries the live markup
            }
            return showShopMenu(req, state, shopCtx, supabase)
        }

        const menu = await getActiveMenuConfig(supabase)
        const retryState: USSDState = { step: 'main_choice', menuMap: menu.menuMap }
        return respond(
            SessionId,
            `Invalid choice. Please try again.\n\n${menu.menuText}`,
            retryState,
            menu.header,
        )
    }

    // Delegate immediately to the service's first step.
    // Carry the shop context forward — without this, a guest who entered a shop
    // code drops back to admin/guest pricing and the sale is never attributed
    // or credited to the shop (shopId is the single key that gates all three).
    const serviceState: USSDState = {
        step: `${service}_start`,
        service: service as 'data' | 'results_checker' | 'afa' | 'airtime' | 'utility' | 'mashup',
        shopId:           state.shopId,
        shopName:         state.shopName,
        shopContactPhone: state.shopContactPhone,
    }
    return dispatchService(req, serviceState, supabase)
}

async function handleResumeChoice(
    req: HubtelRequest,
    state: USSDState,
    supabase: SupabaseClient,
): Promise<HubtelResponse> {
    const { SessionId, Message, Mobile } = req
    const choice = Message.trim()

    if (choice === '1') {
        // Restore interrupted session
        const windowMinutes = await getResumeWindow(supabase)
        const resumeSession = await getResumeSession(supabase, Mobile, windowMinutes)

        if (!resumeSession) {
            // Session expired — fall back to a fresh start (gate still applies)
            return startFreshRespectingGate(req, supabase)
        }

        // Clear the old interrupted state so it doesn't show again
        await clearInterruptedSession(supabase, resumeSession.session_id)

        const restoredState = resumeSession.interrupted_state

        // If the restored session was shop-scoped, ensure the shop is still active
        // before resuming — a shop deactivated mid-session must not keep selling.
        if (restoredState.shopId) {
            const { data: shopStillActive } = await supabase
                .from('shop_profiles')
                .select('id')
                .eq('id', restoredState.shopId)
                .eq('ussd_active', true)
                .maybeSingle()
            if (!shopStillActive) {
                return startFreshRespectingGate(req, supabase)
            }
        }

        // Blank out the message: the '1' the guest pressed chose "Continue" on
        // the RESUME menu — it must not be consumed as input by the restored
        // step. Handlers treat an empty message as invalid input and re-show
        // their current screen; passing the raw '1' through used to instantly
        // pick option 1 (or worse, confirm a restored payment screen straight
        // into a MoMo prompt the guest never re-saw).
        return dispatchService({ ...req, Message: '' }, restoredState, supabase)
    }

    if (choice === '2') {
        return startFreshRespectingGate(req, supabase)
    }

    // Invalid choice — re-show resume screen
    const retryState: USSDState = { ...state }
    return respond(
        SessionId,
        `Invalid choice.\n\n1. Continue where I left off\n2. Start a new session`,
        retryState,
        'Resume session',
    )
}

async function dispatchService(
    req: HubtelRequest,
    state: USSDState,
    supabase: SupabaseClient,
): Promise<HubtelResponse> {
    switch (state.service) {
        case 'data':
            return handleData(req, state, supabase)
        case 'results_checker':
            return handleResultsChecker(req, state, supabase)
        case 'afa':
            return handleAfa(req, state, supabase)
        case 'airtime':
            return handleAirtime(req, state, supabase)
        case 'mashup':
            return handleMashup(req, state, supabase)
        case 'utility':
            return handleUtility(req, state, supabase)
        default:
            // A service-less state MUST NOT fall through to the global admin
            // menu. A session interrupted at shop_code_entry has no `service`,
            // so resuming it landed a GUEST on the global menu — silently
            // bypassing the storefront gate. That exact path turned a shop
            // customer's Telecel 15GB purchase (order 1ff7c45f, 2026-07-04)
            // into an unattributed platform sale at guest pricing: the owner
            // saw no order and earned no profit. Re-enter the code prompt for
            // an interrupted code entry; otherwise re-apply the gate.
            if (state.step === 'shop_code_entry') {
                return promptShopCode(req)
            }
            return startFreshRespectingGate(req, supabase)
    }
}
