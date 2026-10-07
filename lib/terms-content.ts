import type { TermsSection, TermsChangeEntry } from './terms'

// Single source of truth for the INITIAL published agreement (version 2026-07-02).
// Seeded into `terms_versions` by scripts/seed-terms.ts; thereafter the DB is
// authoritative and admins edit via the Terms Manager (no redeploy).
//
// DRAFT for founder + counsel review — wording may change before go-live.
// Conventions:
//  - Highlight rule: [[tone: …]] on SHORT key phrases only (≈2–6 words), never a whole sentence.
//    Tones: red=prohibition, amber=caution, gold=important, green=reassurance, u=underline.
//  - {{brand}} renders as "KiNG FLEXY GH" on the dashboard/main site and as the SHOP NAME on storefronts.
//  - Titles carry NO leading number — renderers number them by position (so storefront shows 1–N cleanly).
//  - scope: 'dashboard' hides a section from shop storefronts. Default (omitted) = shown everywhere.
//  - storefront: optional buyer-worded body used on storefronts (falls back to `body`).

export const INITIAL_TERMS_VERSION = '2026-07-02'
export const INITIAL_EFFECTIVE_DATE = 'July 2, 2026'
export const INITIAL_REQUIRES_REACCEPTANCE = true

export const INITIAL_CHANGELOG: TermsChangeEntry[] = [
  {
    version: '2026-07-02',
    date: 'July 2, 2026',
    summary: [
      'Added MoMo Send & Claim rules',
      'Refreshed refunds & 24-hour reporting',
      'Support is through KiNG FLEXY GH only',
      'Added fair-messaging, community & liability terms',
    ],
  },
]

export const INITIAL_SECTIONS: TermsSection[] = [
  { id: 'welcome', title: 'Welcome & Your Agreement',
    body:
      "Thanks for choosing {{brand}}. By creating an account or using our services, you agree to these terms. We keep them short and honest, and [[green: we always show the date of the latest update]]. If we make an important change, we'll ask you to read and accept it again.",
    storefront:
      "Thanks for shopping with {{brand}}. By buying from this store you agree to these terms — we keep them short and honest, and [[green: we always show the date of the latest update]]." },

  { id: 'understand', title: 'Understanding These Terms',
    body:
      "Please read everything carefully. [[amber: If anything is unclear, ask us to explain before you accept]] — you can also have someone you trust help you understand. [[amber: By tapping Accept, you confirm you have read, understood, and agree to all of these terms]].",
    storefront:
      "Please read carefully. [[amber: If anything is unclear, ask before you buy]]. [[amber: Tapping Accept means you have read, understood, and agree to everything here]]." },

  { id: 'account', title: 'Your Account & Security', scope: 'dashboard',
    body:
      "You're responsible for keeping your login details safe, and [[amber: any activity on your account is treated as done by you]]. Keep your PIN and one-time codes private." },

  { id: 'wallet', title: 'Wallet & Funds', scope: 'dashboard',
    body:
      "Your wallet balance is for buying our services. [[green: You can't go into negative balance]], and every movement is recorded. Top-ups have a minimum and maximum shown at checkout." },

  { id: 'momo', title: 'Topping Up by MoMo (Send & Claim)', scope: 'dashboard',
    body:
      "To add funds by Mobile Money, send to our published account and claim with your Transaction ID — [[amber: send at least the minimum shown on your wallet page]], and [[green: your credit is applied automatically once verified]]. [[red: Never reverse, recall, or dispute a MoMo payment after claiming it]], and don't call the network to reverse it — this is treated as fraud and can lead to [[red: temporary or permanent suspension]] and loss of your balance. Each Transaction ID can be claimed once, so [[amber: enter it carefully]] and keep your claim code private. Very large payments may be [[gold: held briefly for review]]." },

  { id: 'payments', title: 'Payments & Verification',
    body:
      "When you pay by card or MoMo through our gateway, [[amber: don't close the payment page until you see the final confirmation]] — closing early can delay your order. We re-check every payment amount for your safety.",
    storefront:
      "When you pay by Mobile Money, [[amber: don't close the payment page until you see the final confirmation]] — closing early can delay your order. We re-check every payment amount for your safety." },

  { id: 'refunds', title: 'Refunds & the 24-Hour Window',
    body:
      "Because data, airtime, and vouchers deliver instantly, [[red: completed orders are final]]. If something goes wrong, [[amber: report a missing or wrong order within 24 hours]] — after that we may not be able to help. We gladly refund orders still pending, processing, or clearly failed, and [[green: wallet refunds are instant]]. Please [[amber: double-check the number and network before paying]] — we can't refund items sent to a wrong number you entered.",
    storefront:
      "Because data, airtime, and vouchers deliver instantly, [[red: completed orders are final]]. If something goes wrong, [[amber: report a missing or wrong order within 24 hours]] — after that we may not be able to help. Please [[amber: double-check the number and network before paying]] — we can't refund items sent to a wrong number you entered." },

  { id: 'support', title: 'Getting Help — Our Channels Only',
    body:
      "You have an agreement with [[green: {{brand}} — not with the networks or payment providers]]. For ANY issue, [[amber: reach us only through our official support channels in the app]] — on your dashboard, tap the [[gold: Customer Support (headphones) icon]] in the header for Email or WhatsApp help; on a shop storefront, use the shop's [[gold: Need Help / WhatsApp]] contact. [[red: Do not call or complain to MTN, Telecel, AirtelTigo, Paystack, or any provider]], and don't ask them to reverse a payment — [[red: calling them may get your phone number blacklisted from our platform entirely]]. [[red: Using any channel outside {{brand}} can get your account banned or deleted without prior notice]].",
    storefront:
      "You're buying from [[green: {{brand}}]]. For any issue, [[amber: contact this shop using the Need Help or WhatsApp button on this page]]. [[red: Please don't call or complain to MTN, Telecel, AirtelTigo, or your payment provider]], and don't try to reverse a payment through them — [[red: calling them may get your phone number blacklisted from our platform entirely]]." },

  { id: 'roles', title: 'Agent, Dealer & Shop Roles', scope: 'dashboard',
    body:
      "Paid roles unlock better pricing and tools for the period you choose, and [[amber: benefits end when the plan expires]]. Prices may change over time and are always confirmed at checkout." },

  { id: 'shop-withdrawals', title: 'Shop Earnings & Withdrawals', scope: 'dashboard',
    body:
      "Your shop profit is yours to withdraw once you're above the minimum. [[amber: Every withdrawal is reviewed and paid by our team]] (usually within 24–48 hours) — it isn't instant, and [[amber: the payout name is verified]] for your protection." },

  { id: 'sub-withdrawals', title: 'Sub-Earnings & Auto-Approval', badge: 'Upcoming', scope: 'dashboard',
    body:
      "When you invite people to earn under your shop, [[green: their approved earnings belong to them]]. [[red: You may not divert, withhold, or delay an invitee's withdrawal]], or use invites to take money that belongs to them — doing so leads to suspension. [[green: Eligible sub-withdrawals are auto-approved by the system on a set schedule]], so payouts aren't slowed by shop owners." },

  { id: 'messaging', title: 'Fair Messaging & Bulk SMS', scope: 'dashboard',
    body:
      "Our messaging tools are for genuine customer updates, and [[green: your customer list stays private to your shop]]. [[red: Phishing, fake receipts, prize scams, reversal tricks, and impersonation are strictly prohibited]] and blocked automatically — [[red: repeat abuse permanently disables your account]]. Links are limited to {{brand}} and approved social platforms. [[green: Blocked messages cost nothing]], and a monitoring team reviews activity." },

  { id: 'api', title: 'Developer API', scope: 'dashboard',
    body:
      "If you use our API, keep your key secret and within the rate limits. [[red: Reselling access, scraping, or dodging limits leads to revocation and suspension]]." },

  { id: 'products', title: 'Products & Accuracy',
    body:
      "You're responsible for the recipient number and network you enter. [[amber: AFA registrations use your Ghana Card details and can't be edited after submission]]. Result-checker vouchers are reserved on success and may expire if unclaimed.",
    storefront:
      "You're responsible for the recipient number and network you enter. [[amber: We can't recover items sent to a wrong number]], so please check carefully before you pay." },

  { id: 'fraud', title: 'Fraud, Suspension & Termination',
    body:
      "We monitor for abuse. [[red: Chargebacks, bot ordering, reversal fraud, and reselling restricted access can lead to suspension or permanent termination]]. We may hold or review activity that looks unsafe.",
    storefront:
      "[[red: Chargebacks, fake payment claims, and reversing a payment after delivery are treated as fraud]] and may be reported and blocked." },

  { id: 'privacy', title: 'Your Data & Privacy',
    body:
      "We handle your data as described in our Privacy Policy. [[amber: Account deletion is permanent]], and some financial records are kept for legal and accounting reasons even after deletion.",
    storefront:
      "We only use your details to process and deliver your order. [[green: Your information is kept private]]." },

  { id: 'community', title: 'Stay Updated — Join Our Community', scope: 'dashboard',
    body:
      "[[amber: Join our official community channel]] to get updates and notices first — we often share changes and fixes there before they reach the site. [[amber: Issues already answered in the community won't be reviewed again]]. Joining is safe: [[green: we never share or expose your personal information]]." },

  { id: 'liability', title: 'Our Responsibility to You',
    body:
      "We work hard to deliver every order instantly, but [[amber: we can't promise the service will never be interrupted]] — parts depend on MTN, Telecel, AirtelTigo, Paystack, and our suppliers, and [[amber: delays caused by them or events beyond our control aren't our responsibility]]. If we're ever at fault for a transaction, [[gold: the most we're responsible for is the value of that transaction]]. [[amber: We're not responsible for indirect losses]] like lost profit. [[green: Nothing here removes rights you have under Ghanaian law]], and this doesn't limit our responsibility for our own fraud or serious misconduct.",
    storefront:
      "We work hard to deliver every order instantly, but [[amber: we can't promise the service is never interrupted]] — parts depend on MTN, Telecel, AirtelTigo, and payment providers, and [[amber: delays caused by them aren't our fault]]. If we're at fault for a transaction, [[gold: the most we're responsible for is the value of that transaction]]." },
]
