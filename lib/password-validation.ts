export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 128
export const PASSWORD_REQUIREMENTS_MESSAGE = 'Password must be 8-128 characters and include uppercase, lowercase, and a number'

export const passwordStrengthRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[\s\S]{8,128}$/

export function isStrongPassword(password: string) {
    return passwordStrengthRegex.test(password)
}
