export interface FeatureOption {
    key: string
    label: string
}

export interface CategoryOption {
    key: string
    label: string
}

export const WEBSITE_REQUEST_CATEGORIES: CategoryOption[] = [
    { key: 'business_portfolio', label: 'Business / Portfolio Website' },
    { key: 'ecommerce', label: 'E-commerce / Online Store' },
    { key: 'booking_appointment', label: 'Booking / Appointment System' },
    { key: 'school_church_org', label: 'School / Church / Organization Website' },
    { key: 'blog_news', label: 'Blog / News / Magazine' },
    { key: 'mobile_app', label: 'Mobile App (Android/iOS)' },
    { key: 'custom_web_app', label: 'Custom Web App / System' },
    { key: 'other', label: 'Other' },
]

export const WEBSITE_REQUEST_CATEGORY_KEYS = WEBSITE_REQUEST_CATEGORIES.map(c => c.key) as [string, ...string[]]

export const CATEGORY_FEATURES: Record<string, FeatureOption[]> = {
    business_portfolio: [
        { key: 'about_page', label: 'About page' },
        { key: 'services_showcase', label: 'Services/products showcase' },
        { key: 'contact_form', label: 'Contact form' },
        { key: 'photo_gallery', label: 'Photo gallery' },
        { key: 'testimonials', label: 'Testimonials' },
        { key: 'blog_section', label: 'Blog/news section' },
        { key: 'social_integration', label: 'Social media integration' },
        { key: 'google_maps', label: 'Google Maps location' },
    ],
    ecommerce: [
        { key: 'product_catalog', label: 'Product catalog & categories' },
        { key: 'cart_checkout', label: 'Cart & checkout' },
        { key: 'payment_integration', label: 'Paystack/Mobile Money payment' },
        { key: 'order_tracking', label: 'Order tracking' },
        { key: 'customer_accounts', label: 'Customer accounts' },
        { key: 'inventory_management', label: 'Inventory management' },
        { key: 'coupon_codes', label: 'Discount/coupon codes' },
        { key: 'multi_vendor', label: 'Multi-vendor support' },
    ],
    booking_appointment: [
        { key: 'booking_calendar', label: 'Online booking calendar' },
        { key: 'sms_email_reminders', label: 'SMS/email reminders' },
        { key: 'staff_scheduling', label: 'Staff/resource scheduling' },
        { key: 'payment_at_booking', label: 'Payment at booking' },
        { key: 'customer_reviews', label: 'Customer reviews' },
        { key: 'admin_bookings_dashboard', label: 'Admin bookings dashboard' },
    ],
    school_church_org: [
        { key: 'events_calendar', label: 'Events calendar' },
        { key: 'news_announcements', label: 'News/announcements' },
        { key: 'staff_directory', label: 'Staff/members directory' },
        { key: 'online_giving', label: 'Online giving/donations' },
        { key: 'media_gallery', label: 'Media gallery' },
        { key: 'admission_forms', label: 'Admission/registration forms' },
        { key: 'newsletter_signup', label: 'Newsletter signup' },
    ],
    blog_news: [
        { key: 'article_publishing', label: 'Article publishing & categories' },
        { key: 'comments', label: 'Comments' },
        { key: 'author_profiles', label: 'Author profiles' },
        { key: 'newsletter_subscription', label: 'Newsletter subscription' },
        { key: 'search', label: 'Search' },
        { key: 'social_sharing', label: 'Social sharing' },
        { key: 'ad_space_management', label: 'Ad space management' },
    ],
    mobile_app: [
        { key: 'push_notifications', label: 'Push notifications' },
        { key: 'user_accounts', label: 'User accounts/login' },
        { key: 'offline_mode', label: 'Offline mode' },
        { key: 'payment_integration', label: 'Payment integration' },
        { key: 'admin_backend', label: 'Admin backend' },
        { key: 'app_store_publishing', label: 'App store publishing assistance' },
    ],
    custom_web_app: [
        { key: 'user_roles_permissions', label: 'User roles & permissions' },
        { key: 'custom_dashboard', label: 'Custom dashboard/analytics' },
        { key: 'reporting', label: 'Reporting' },
        { key: 'api_integrations', label: 'Third-party API integrations' },
        { key: 'automated_workflows', label: 'Automated workflows' },
    ],
    other: [],
}

export const TIMELINE_OPTIONS: { key: string; label: string }[] = [
    { key: 'asap', label: 'ASAP' },
    { key: '1_month', label: '1 month' },
    { key: '2_3_months', label: '2-3 months' },
    { key: 'flexible', label: 'Flexible' },
]

/** True if `category` is known and every entry in `features` is one of that category's allowed keys. */
export function isValidFeatureSet(category: string, features: string[]): boolean {
    const allowed = CATEGORY_FEATURES[category]
    if (!allowed) return false
    const allowedKeys = new Set(allowed.map(f => f.key))
    return features.every(f => allowedKeys.has(f))
}
