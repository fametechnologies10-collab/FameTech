// Single definition of "is mandatory phone OTP verification switched on".
//
// admin_settings.phone_verification_enabled is the owner's switch. A missing row
// counts as OFF, matching lib/phone-otp-service.ts (sendPhoneOtp sends nothing when
// off) and app/auth/complete-profile/page.tsx (saves the phone with no OTP when off).
// The dashboard gate must use the same rule: requiring phone_verified while no code
// can ever be sent traps every new user on /auth/verify-phone-required.
export function isPhoneVerificationEnabled(value: unknown): boolean {
    return value === true || value === 'true'
}

// True when the user must be sent to /auth/verify-phone-required.
export function mustVerifyPhone(settingValue: unknown, phoneVerified: boolean | null | undefined): boolean {
    return isPhoneVerificationEnabled(settingValue) && !phoneVerified
}
