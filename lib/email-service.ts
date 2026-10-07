/**
 * Brevo Email Service
 * 
 * This service handles all transactional emails using Brevo (formerly Sendinblue).
 * Premium high-end email templates for KiNG FLEXY TECHNOLOGIES LTD.
 */

// @ts-ignore - Brevo SDK doesn't have complete type definitions
import * as SibApiV3Sdk from '@getbrevo/brevo'
import { createClient } from '@supabase/supabase-js'
import { sendAdminPushNotification } from './push-service'
import { Resend } from 'resend'
import { MailerSend, EmailParams, Sender, Recipient } from "mailersend"
import { Redis } from '@upstash/redis'

const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
})

const resend = new Resend(process.env.RESEND_API_KEY)
const mailerSend = new MailerSend({ apiKey: process.env.MAILERSEND_API_KEY || '' })

// Initialize API instance with API key
const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi()

// Set API key using the correct method
// @ts-ignore - SDK type definitions are incomplete
apiInstance.setApiKey(SibApiV3Sdk.TransactionalEmailsApiApiKeys.apiKey, process.env.BREVO_API_KEY || '')

/**
 * SECURITY (stored XSS): HTML-escape any user-controlled value before
 * interpolating it into an email HTML template. Email clients render HTML, so
 * an unescaped value — a shop name, applicant name, complaint name, etc.
 * containing `<img src=x onerror=...>` — becomes stored XSS the moment an admin
 * (or owner) opens the message. Apply to EVERY `${...}` that carries user /
 * shop-owner / applicant input. Server-formatted numbers and dates don't need
 * it, but escaping them is harmless. This is defense-in-depth on TOP of the
 * input validation at the write routes — a single missed/relaxed validator must
 * not reopen XSS.
 */
function escapeHtml(value: unknown): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

// Sender configuration
const DEFAULT_SENDER = {
    name: process.env.BREVO_SENDER_NAME || 'KiNG FLEXY TECHNOLOGIES',
    email: process.env.BREVO_SENDER_EMAIL || 'support@kingflexygh.com'
}

interface SendEmailOptions {
    to: string
    toName?: string
    subject: string
    htmlContent: string
}

interface EmailResult {
    success: boolean
    messageId?: string
    error?: string
}

/**
 * Core function to send transactional email via Brevo
 */
export async function sendEmail(options: SendEmailOptions, senderEmail?: string): Promise<EmailResult> {
    if (!process.env.BREVO_API_KEY) {
        console.warn('BREVO_API_KEY not set. Email not sent.')
        return { success: false, error: 'Email service not configured' }
    }

    try {
        const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail()

        sendSmtpEmail.sender = senderEmail ? { name: process.env.BREVO_SENDER_NAME || 'KiNG FLEXY GH', email: senderEmail } : DEFAULT_SENDER
        sendSmtpEmail.to = [{ email: options.to, name: options.toName || options.to }]
        sendSmtpEmail.subject = options.subject
        sendSmtpEmail.htmlContent = options.htmlContent

        const data = await apiInstance.sendTransacEmail(sendSmtpEmail)
        const rawMessageId = data.body?.messageId || data.response?.headers?.['x-message-id']
        const messageId = Array.isArray(rawMessageId) ? rawMessageId[0] : rawMessageId
        console.log('Email sent successfully:', messageId)

        return { success: true, messageId }
    } catch (error: any) {
        console.error('Failed to send email:', error.response?.body || error.message)
        return {
            success: false,
            error: error.response?.body?.message || error.message || 'Failed to send email'
        }
    }
}

/**
 * Core function to send critical transactional email via Resend
 * Automatically falls back to Brevo if Resend fails.
 */
export async function sendResendEmail(options: SendEmailOptions, senderEmail: string = 'receipts@kingflexygh.com'): Promise<EmailResult> {
    if (!process.env.RESEND_API_KEY) {
        console.warn('RESEND_API_KEY not set. Falling back to MailerSend → Brevo.')
        return sendMailerSendEmail(options, senderEmail)
    }

    try {
        const data = await resend.emails.send({
            from: `KiNG FLEXY GH <${senderEmail}>`,
            to: options.toName ? `${options.toName} <${options.to}>` : options.to,
            subject: options.subject,
            html: options.htmlContent,
        })

        if (data.error) {
            console.error('Resend API Error:', data.error)
            console.warn('Falling back to MailerSend → Brevo...')
            return sendMailerSendEmail(options, senderEmail)
        }

        console.log('Email sent successfully via Resend:', data.data?.id)
        return { success: true, messageId: data.data?.id }
    } catch (error: any) {
        console.error('Failed to send email via Resend:', error.message)
        console.warn('Falling back to MailerSend → Brevo...')
        return sendMailerSendEmail(options, senderEmail)
    }
}

/**
 * Core function to send time-sensitive transactional email via MailerSend
 * Automatically falls back to Brevo if MailerSend fails.
 */
export async function sendMailerSendEmail(options: SendEmailOptions, senderEmail: string = 'support@kingflexygh.com'): Promise<EmailResult> {
    if (!process.env.MAILERSEND_API_KEY) {
        console.warn('MAILERSEND_API_KEY not set. Falling back to Brevo.')
        return sendEmail(options, senderEmail)
    }

    try {
        const sentFrom = new Sender(senderEmail, "KiNG FLEXY GH")
        const recipients = [new Recipient(options.to, options.toName || options.to)]

        const emailParams = new EmailParams()
            .setFrom(sentFrom)
            .setTo(recipients)
            .setSubject(options.subject)
            .setHtml(options.htmlContent)

        const response = await mailerSend.email.send(emailParams)

        console.log('Email sent successfully via MailerSend')
        return { success: true }
    } catch (error: any) {
        console.error('Failed to send email via MailerSend:', error)
        console.warn('Falling back to Brevo...')
        return sendEmail(options, senderEmail)
    }
}

/**
 * Premium high-end HTML email template
 */
function generateProfessionalTemplate(title: string, content: string, accentColor: string = '#FFCC00'): string {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <meta name="color-scheme" content="light dark">
    <meta name="supported-color-schemes" content="light dark">
    <title>${title}</title>
    <!--[if mso]>
    <noscript>
        <xml>
            <o:OfficeDocumentSettings>
                <o:PixelsPerInch>96</o:PixelsPerInch>
            </o:OfficeDocumentSettings>
        </xml>
    </noscript>
    <![endif]-->
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
        
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            line-height: 1.7;
            color: #1a1a2e;
            background-color: #f1f5f9;
            padding: 40px 20px;
            min-height: 100vh;
        }
        
        .email-wrapper {
            max-width: 600px;
            margin: 0 auto;
        }
        
        .email-container {
            background-color: #ffffff;
            border-radius: 24px;
            overflow: hidden;
            box-shadow: 
                0 25px 50px -12px rgba(0, 0, 0, 0.4),
                0 0 0 1px rgba(212, 175, 55, 0.1);
        }
        
        .header {
            background-color: #0f0f23;
            padding: 50px 40px;
            text-align: center;
            position: relative;
            overflow: hidden;
        }
        
        .header::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 4px;
            background: linear-gradient(90deg, ${accentColor}, #f5e6a3, ${accentColor});
        }
        
        .header::after {
            content: '';
            position: absolute;
            top: -50%;
            right: -50%;
            width: 100%;
            height: 200%;
            background: radial-gradient(circle, rgba(212, 175, 55, 0.1) 0%, transparent 70%);
            pointer-events: none;
        }
        
        .logo-container {
            position: relative;
            z-index: 1;
        }
        
        .logo-icon {
            width: 70px;
            height: 70px;
            background-color: ${accentColor};
            border-radius: 16px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            margin-bottom: 20px;
            box-shadow: 0 10px 30px rgba(212, 175, 55, 0.3);
        }
        
        .logo-text {
            font-size: 36px;
            color: #1a1a2e;
            font-weight: 700;
        }
        
        .brand-name {
            font-size: 26px;
            font-weight: 700;
            color: #ffffff;
            letter-spacing: 2px;
            text-transform: uppercase;
            margin-bottom: 8px;
        }
        
        .brand-tagline {
            font-size: 13px;
            color: ${accentColor};
            letter-spacing: 4px;
            text-transform: uppercase;
            font-weight: 500;
        }
        
        .content {
            padding: 50px 40px;
        }
        
        .greeting {
            font-size: 28px;
            font-weight: 700;
            color: #1a1a2e;
            margin-bottom: 10px;
        }
        
        .subtitle {
            font-size: 16px;
            color: #64748b;
            margin-bottom: 35px;
            padding-bottom: 25px;
            border-bottom: 1px solid #e2e8f0;
        }
        
        .message-text {
            font-size: 15px;
            color: #475569;
            margin-bottom: 30px;
            line-height: 1.8;
        }
        
        .info-card {
            background-color: #f8fafc;
            border-radius: 16px;
            padding: 30px;
            margin: 30px 0;
            border: 1px solid #e2e8f0;
        }
        
        .info-card-header {
            display: flex;
            align-items: center;
            margin-bottom: 20px;
            padding-bottom: 15px;
            border-bottom: 1px solid #e2e8f0;
        }
        
        .info-card-icon {
            width: 44px;
            height: 44px;
            background-color: ${accentColor};
            border-radius: 12px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            margin-right: 15px;
            font-size: 20px;
        }
        
        .info-card-title {
            font-size: 18px;
            font-weight: 600;
            color: #1a1a2e;
        }
        
        .info-row {
            display: flex;
            justify-content: space-between;
            padding: 12px 0;
            border-bottom: 1px solid #e2e8f0;
        }
        
        .info-row:last-child {
            border-bottom: none;
            padding-bottom: 0;
        }
        
        .info-label {
            font-size: 14px;
            color: #64748b;
            font-weight: 500;
        }
        
        .info-value {
            font-size: 14px;
            color: #1a1a2e;
            font-weight: 600;
            text-align: right;
        }
        
        .amount-display {
            text-align: center;
            padding: 35px;
            background-color: #0f0f23;
            border-radius: 20px;
            margin: 30px 0;
        }
        
        .amount-label {
            font-size: 13px;
            color: rgba(255,255,255,0.7);
            text-transform: uppercase;
            letter-spacing: 2px;
            margin-bottom: 10px;
        }
        
        .amount-value {
            font-size: 42px;
            font-weight: 700;
            color: #ffffff;
        }
        
        .amount-currency {
            color: ${accentColor};
        }
        
        .status-badge {
            display: inline-block;
            padding: 8px 20px;
            border-radius: 50px;
            font-size: 13px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 1px;
        }
        
        .status-success {
            background-color: #10b981;
            color: #ffffff;
        }
        
        .status-failed {
            background-color: #ef4444;
            color: #ffffff;
        }
        
        .status-pending {
            background-color: ${accentColor};
            color: #1a1a2e;
        }
        
        .cta-button {
            display: inline-block;
            background-color: ${accentColor};
            color: #1a1a2e !important;
            text-decoration: none;
            padding: 16px 40px;
            border-radius: 12px;
            font-size: 15px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 1px;
            box-shadow: 0 10px 30px rgba(212, 175, 55, 0.3);
            transition: all 0.3s ease;
        }
        
        .cta-container {
            text-align: center;
            margin: 40px 0;
        }
        
        .divider {
            height: 1px;
            background-color: #e2e8f0;
            margin: 40px 0;
        }
        
        .footer {
            background-color: #f8fafc;
            padding: 35px 40px;
            text-align: center;
            border-top: 1px solid #e2e8f0;
        }
        
        .footer-text {
            font-size: 13px;
            color: #64748b;
            margin-bottom: 15px;
        }
        
        .footer-links {
            margin-bottom: 20px;
        }
        
        .footer-link {
            color: #1a1a2e;
            text-decoration: none;
            font-size: 13px;
            font-weight: 500;
            margin: 0 15px;
        }
        
        .footer-copyright {
            font-size: 12px;
            color: #94a3b8;
        }
        
        .highlight-box {
            background-color: #fefce8;
            border-left: 4px solid ${accentColor};
            padding: 20px 25px;
            border-radius: 0 12px 12px 0;
            margin: 25px 0;
        }
        
        .highlight-text {
            font-size: 14px;
            color: #1a1a2e;
            font-weight: 500;
        }
        
        @media only screen and (max-width: 600px) {
            body {
                padding: 20px 15px;
            }
            .header {
                padding: 35px 25px;
            }
            .content {
                padding: 35px 25px;
            }
            .footer {
                padding: 25px 20px;
            }
            .greeting {
                font-size: 24px;
            }
            .brand-name {
                font-size: 22px;
            }
            .amount-value {
                font-size: 34px;
            }
        }
        
        /* Dark Mode Support */
        @media (prefers-color-scheme: dark) {
            body { background-color: #0f0f23 !important; }
            .email-container { background-color: #1a1a2e !important; box-shadow: 0 0 0 1px rgba(212, 175, 55, 0.2) !important; }
            .content { background-color: #1a1a2e !important; }
            .greeting, .brand-name, .logo-text, .info-card-title, .amount-value, .highlight-text, .info-value { color: #ffffff !important; }
            .subtitle, .message-text, .info-label, .footer-text, .footer-copyright { color: #cbd5e1 !important; }
            .info-card { background-color: #232336 !important; border-color: #334155 !important; }
            .info-card-header, .info-row, .divider, .footer { border-color: #334155 !important; }
            .footer { background-color: #1a1a2e !important; }
            .footer-link { color: #f8fafc !important; }
            .amount-display { background-color: #232336 !important; border: 1px solid #334155 !important; }
            .highlight-box { background-color: #232336 !important; }
        }
    </style>
</head>
<body>
    <div class="email-wrapper">
        <div class="email-container">
            <div class="header">
                <div class="logo-container">
                    <div class="logo-icon">
                        <span class="logo-text">K</span>
                    </div>
                    <div class="brand-name"><span style="color: #ffffff;">KiNG </span><span style="color: #FFCC00;">FLEXY GH</span></div>
                    <div class="brand-tagline">Powering Digital Services in Ghana</div>
                </div>
            </div>
            <div class="content">
                ${content}
            </div>
            <div class="footer">
                <div class="footer-links">
                    <a href="${process.env.NEXT_PUBLIC_APP_URL}" class="footer-link">Website</a>
                    <a href="${process.env.NEXT_PUBLIC_APP_URL}/dashboard" class="footer-link">Dashboard</a>
                    <a href="mailto:support@kingflexygh.com" class="footer-link">Support</a>
                </div>
                <p class="footer-text">
                    Questions? Reply to this email or contact us at<br>
                    <strong>support@kingflexygh.com</strong>
                </p>
                <p class="footer-copyright">
                    © ${new Date().getFullYear()} KiNG FLEXY TECHNOLOGIES LTD. All rights reserved.<br>
                    Powering Digital Services in Ghana
                </p>
            </div>
        </div>
    </div>
</body>
</html>`
}

// ==========================================
// USER EMAIL FUNCTIONS
// ==========================================

/**
 * Send welcome email after user registration
 */
export async function sendWelcomeEmail(
    email: string,
    firstName: string
): Promise<EmailResult> {
    const content = `
        <h1 class="greeting">Welcome, ${firstName}</h1>
        <p class="subtitle">Your account has been successfully created</p>
        
        <p class="message-text">
            Thank you for joining <strong>KiNG FLEXY GH</strong>  -  Ghana's premier digital
            services platform. Your account has been successfully created and
            you're now part of an exclusive community.
        </p>
        
        <div class="info-card">
            <div class="info-card-header">
                <div class="info-card-icon">i</div>
                <span class="info-card-title">What You Can Do</span>
            </div>
            <div class="info-row">
                <span class="info-label">Fund Wallet</span>
                <span class="info-value">Instant Paystack top-up</span>
            </div>
            <div class="info-row">
                <span class="info-label">Buy Data</span>
                <span class="info-value">MTN, Telecel, AirtelTigo</span>
            </div>
            <div class="info-row">
                <span class="info-label">Manage Customers</span>
                <span class="info-value">Track all your recipients</span>
            </div>
            <div class="info-row">
                <span class="info-label">Real-time Tracking</span>
                <span class="info-value">Monitor every order</span>
            </div>
        </div>
        
        <div class="cta-container">
            <a href="${process.env.NEXT_PUBLIC_APP_URL}/dashboard" class="cta-button">
                Access Your Dashboard
            </a>
        </div>
        
        <div class="highlight-box">
            <p class="highlight-text">
                <strong>Note:</strong> Fund your wallet now and start enjoying the best 
                data prices in Ghana. Our rates are unbeatable!
            </p>
        </div>
    `

    return sendEmail({
        to: email,
        toName: firstName,
        subject: `Welcome to KiNG FLEXY GH, ${firstName}`,
        htmlContent: generateProfessionalTemplate('Welcome', content)
    })
}

/**
 * Send order placed success email to user
 */
export async function sendOrderSuccessEmail(
    email: string,
    firstName: string,
    orderDetails: {
        referenceCode: string
        phoneNumber: string
        network: string
        size: string
        price: number
    }
): Promise<EmailResult> {
    const content = `
        <h1 class="greeting">Order Confirmation</h1>
        <p class="subtitle">Your data order is being processed</p>
        
        <p class="message-text">
            Hi ${firstName}, your order has been received and is now being processed. 
            The data bundle will be delivered to the recipient shortly.
        </p>
        
        <div class="info-card">
            <div class="info-card-header">
                <div class="info-card-icon">i</div>
                <span class="info-card-title">Order Details</span>
            </div>
            <div class="info-row">
                <span class="info-label">Reference</span>
                <span class="info-value">${orderDetails.referenceCode}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Recipient</span>
                <span class="info-value">${orderDetails.phoneNumber}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Network</span>
                <span class="info-value">${orderDetails.network}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Package</span>
                <span class="info-value">${orderDetails.size}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Amount Paid</span>
                <span class="info-value" style="color: #10b981; font-size: 16px;">GHS ${orderDetails.price.toFixed(2)}</span>
            </div>
        </div>
        
        <div style="text-align: center; margin: 25px 0;">
            <span class="status-badge status-pending">Processing</span>
        </div>
        
        <div class="cta-container">
            <a href="${process.env.NEXT_PUBLIC_APP_URL}/dashboard/my-orders" class="cta-button">
                Track Your Order
            </a>
        </div>
    `

    return sendResendEmail({
        to: email,
        toName: firstName,
        subject: `Order Confirmed - ${orderDetails.referenceCode}`,
        htmlContent: generateProfessionalTemplate('Order Confirmed', content)
    }, 'receipts@kingflexygh.com')
}

/**
 * Send order failed email to user
 */
export async function sendOrderFailedEmail(
    email: string,
    firstName: string,
    orderDetails: {
        referenceCode: string
        phoneNumber: string
        network: string
        size: string
        reason?: string
    }
): Promise<EmailResult> {
    const content = `
        <h1 class="greeting">Order Failed</h1>
        <p class="subtitle">We couldn't process your order</p>
        
        <p class="message-text">
            Hi ${firstName}, we're sorry but we were unable to complete your data order. 
            Please don't worry  -  you can file a complaint to request a refund.
        </p>
        
        <div class="info-card">
            <div class="info-card-header">
                <div class="info-card-icon">i</div>
                <span class="info-card-title">Order Details</span>
            </div>
            <div class="info-row">
                <span class="info-label">Reference</span>
                <span class="info-value">${orderDetails.referenceCode}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Recipient</span>
                <span class="info-value">${orderDetails.phoneNumber}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Network</span>
                <span class="info-value">${orderDetails.network}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Package</span>
                <span class="info-value">${orderDetails.size}</span>
            </div>
            ${orderDetails.reason ? `
            <div class="info-row">
                <span class="info-label">Reason</span>
                <span class="info-value" style="color: #ef4444;">${orderDetails.reason}</span>
            </div>
            ` : ''}
        </div>
        
        <div style="text-align: center; margin: 25px 0;">
            <span class="status-badge status-failed">Failed</span>
        </div>
        
        <div class="highlight-box">
            <p class="highlight-text">
                <strong>Next Steps:</strong> Visit your orders page and file a complaint 
                to request a refund. Our team will process it within 24 hours.
            </p>
        </div>
        
        <div class="cta-container">
            <a href="${process.env.NEXT_PUBLIC_APP_URL}/dashboard/my-orders" class="cta-button">
                File a Complaint
            </a>
        </div>
    `

    return sendResendEmail({
        to: email,
        toName: firstName,
        subject: `Order Failed - ${orderDetails.referenceCode}`,
        htmlContent: generateProfessionalTemplate('Order Failed', content, '#ef4444')
    }, 'receipts@kingflexygh.com')
}

/**
 * Send wallet top-up success email to user
 */
export async function sendWalletTopupSuccessEmail(
    email: string,
    firstName: string,
    amount: number,
    reference: string,
    newBalance: number
): Promise<EmailResult> {
    const content = `
        <h1 class="greeting">Wallet Top-up Successful</h1>
        <p class="subtitle">Your funds have been added</p>
        
        <div class="amount-display">
            <p class="amount-label">Amount Credited</p>
            <p class="amount-value"><span class="amount-currency">GHS</span> ${amount.toFixed(2)}</p>
        </div>
        
        <p class="message-text">
            Hi ${firstName}, your wallet has been successfully credited. You can now 
            use your balance to purchase data bundles for any network.
        </p>
        
        <div class="info-card">
            <div class="info-card-header">
                <div class="info-card-icon">i</div>
                <span class="info-card-title">Transaction Details</span>
            </div>
            <div class="info-row">
                <span class="info-label">Reference</span>
                <span class="info-value">${reference}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Payment Method</span>
                <span class="info-value">Paystack</span>
            </div>
            <div class="info-row">
                <span class="info-label">New Balance</span>
                <span class="info-value" style="color: #10b981; font-size: 16px;">GHS ${newBalance.toFixed(2)}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Date</span>
                <span class="info-value">${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
            </div>
        </div>
        
        <div style="text-align: center; margin: 25px 0;">
            <span class="status-badge status-success">Completed</span>
        </div>
        
        <div class="cta-container">
            <a href="${process.env.NEXT_PUBLIC_APP_URL}/dashboard/data-packages" class="cta-button">
                Buy Data Now
            </a>
        </div>
    `

    return sendResendEmail({
        to: email,
        toName: firstName,
        subject: `Wallet Credited - GHS ${amount.toFixed(2)}`,
        htmlContent: generateProfessionalTemplate('Wallet Credited', content, '#10b981')
    }, 'receipts@kingflexygh.com')
}

/**
 * Send wallet top-up failed email to user
 */
export async function sendWalletTopupFailedEmail(
    email: string,
    firstName: string,
    amount: number,
    reference: string,
    reason?: string
): Promise<EmailResult> {
    const content = `
        <h1 class="greeting">Payment Failed</h1>
        <p class="subtitle">Your wallet top-up was not completed</p>
        
        <div class="amount-display" style="background: linear-gradient(135deg, #7f1d1d 0%, #991b1b 100%);">
            <p class="amount-label">Attempted Amount</p>
            <p class="amount-value"><span class="amount-currency" style="color: #fca5a5;">GHS</span> ${amount.toFixed(2)}</p>
        </div>
        
        <p class="message-text">
            Hi ${firstName}, unfortunately your wallet top-up could not be completed. 
            If any amount was deducted from your account, it will be automatically 
            reversed within 24-48 hours.
        </p>
        
        <div class="info-card">
            <div class="info-card-header">
                <div class="info-card-icon">i</div>
                <span class="info-card-title">Transaction Details</span>
            </div>
            <div class="info-row">
                <span class="info-label">Reference</span>
                <span class="info-value">${reference}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Payment Method</span>
                <span class="info-value">Paystack</span>
            </div>
            ${reason ? `
            <div class="info-row">
                <span class="info-label">Reason</span>
                <span class="info-value" style="color: #ef4444;">${escapeHtml(reason)}</span>
            </div>
            ` : ''}
            <div class="info-row">
                <span class="info-label">Date</span>
                <span class="info-value">${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
            </div>
        </div>
        
        <div style="text-align: center; margin: 25px 0;">
            <span class="status-badge status-failed">Failed</span>
        </div>
        
        <div class="highlight-box">
            <p class="highlight-text">
                <strong>Action Required:</strong> Please try again with a different payment 
                method or contact your bank if the issue persists.
            </p>
        </div>
        
        <div class="cta-container">
            <a href="${process.env.NEXT_PUBLIC_APP_URL}/dashboard/wallet" class="cta-button">
                Try Again
            </a>
        </div>
    `

    return sendResendEmail({
        to: email,
        toName: firstName,
        subject: `Payment Failed - GHS ${amount.toFixed(2)}`,
        htmlContent: generateProfessionalTemplate('Payment Failed', content, '#ef4444')
    }, 'receipts@kingflexygh.com')
}

/**
 * Send complaint resolved email to user
 */
export async function sendComplaintResolvedEmail(
    email: string,
    firstName: string,
    complaintDetails: {
        orderRef: string
        status: string
        resolutionNotes: string
    }
): Promise<EmailResult> {
    const isResolved = complaintDetails.status === 'resolved'
    const statusColor = isResolved ? '#10b981' : '#ef4444' // Green or Red
    const statusText = isResolved ? 'Resolved' : 'Rejected'
    const statusBadgeClass = isResolved ? 'status-success' : 'status-failed'

    const content = `
        <h1 class="greeting">Complaint Update</h1>
        <p class="subtitle">There is an update on your complaint</p>
        
        <p class="message-text">
            Hi ${escapeHtml(firstName)}, your complaint regarding order <strong>${escapeHtml(complaintDetails.orderRef)}</strong> has been updated.
        </p>

        <div class="info-card">
            <div class="info-card-header">
                <div class="info-card-icon">i</div>
                <span class="info-card-title">Complaint Details</span>
            </div>
            <div class="info-row">
                <span class="info-label">Order Reference</span>
                <span class="info-value">${escapeHtml(complaintDetails.orderRef)}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Status</span>
                <span class="info-value">
                    <span class="status-badge ${statusBadgeClass}" style="padding: 4px 12px; font-size: 11px;">${statusText}</span>
                </span>
            </div>
            <div class="info-row" style="flex-direction: column; align-items: flex-start; gap: 8px;">
                <span class="info-label">Resolution Notes</span>
                <span class="info-value" style="text-align: left; background: rgba(0,0,0,0.03); padding: 10px; border-radius: 8px; width: 100%; font-weight: 400;">
                    ${escapeHtml(complaintDetails.resolutionNotes) || 'No additional notes provided.'}
                </span>
            </div>
        </div>
        
        <div class="cta-container">
            <a href="${process.env.NEXT_PUBLIC_APP_URL}/dashboard/complaints" class="cta-button">
                View Complaint
            </a>
        </div>
    `

    return sendMailerSendEmail({
        to: email,
        toName: firstName,
        subject: `Complaint Update - ${complaintDetails.orderRef} [${statusText}]`,
        htmlContent: generateProfessionalTemplate(`Complaint ${statusText}`, content, statusColor)
    }, 'support@kingflexygh.com')
}

/**
 * Send new complaint alert to admin
 */
export async function sendAdminNewComplaintAlert(
    complaintDetails: {
        userEmail: string
        userName: string
        orderRef: string
        title: string
        description: string
        priority: string
    }
): Promise<EmailResult> {
    const adminEmail = process.env.ADMIN_EMAIL || 'kingflexytechnologies@gmail.com'

    const content = `
        <h1 class="greeting">New Complaint Alert</h1>
        <p class="subtitle">A user has filed a new complaint</p>
        
        <div class="info-card">
            <div class="info-card-header">
                <div class="info-card-icon">i</div>
                <span class="info-card-title">User Details</span>
            </div>
            <div class="info-row">
                <span class="info-label">Name</span>
                <span class="info-value">${escapeHtml(complaintDetails.userName)}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Email</span>
                <span class="info-value">${escapeHtml(complaintDetails.userEmail)}</span>
            </div>
        </div>

        <div class="info-card">
            <div class="info-card-header">
                <div class="info-card-icon">!</div>
                <span class="info-card-title">Complaint Details</span>
            </div>
            <div class="info-row">
                <span class="info-label">Order Ref</span>
                <span class="info-value">${escapeHtml(complaintDetails.orderRef)}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Priority</span>
                <span class="info-value" style="color: ${complaintDetails.priority === 'high' ? '#ef4444' : '#f59e0b'}">
                    ${complaintDetails.priority.toUpperCase()}
                </span>
            </div>
            <div class="info-row">
                <span class="info-label">Title</span>
                <span class="info-value">${escapeHtml(complaintDetails.title)}</span>
            </div>
            <div class="info-row" style="flex-direction: column; align-items: flex-start; gap: 8px;">
                <span class="info-label">Description</span>
                <span class="info-value" style="text-align: left; background: rgba(0,0,0,0.03); padding: 10px; border-radius: 8px; width: 100%; font-weight: 400;">
                    ${escapeHtml(complaintDetails.description)}
                </span>
            </div>
        </div>
        
        <div class="cta-container">
            <a href="${process.env.NEXT_PUBLIC_APP_URL}/admin/complaints" class="cta-button">
                Process Complaint
            </a>
        </div>
    `

    await sendAdminPushNotification({
        title: `New Complaint: ${complaintDetails.title}`,
        body: `From: ${complaintDetails.userName} | Order Ref: ${complaintDetails.orderRef} | Priority: ${complaintDetails.priority}`,
        url: `/admin/complaints`
    }).catch(e => console.error('[Complaint Alert] Admin push error:', e))

    return sendEmail({
        to: adminEmail,
        toName: 'Admin',
        subject: `[New Complaint] ${complaintDetails.title} - ${complaintDetails.orderRef}`,
        htmlContent: generateProfessionalTemplate('New Complaint', content, '#ef4444')
    }, 'admin@kingflexygh.com')
}

/**
 * Send permanent agent upgrade success email
 */
export async function sendPermanentAgentUpgradeSuccessEmail(
    email: string,
    firstName: string
): Promise<EmailResult> {
    const siteUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.kingflexygh.com'
    const content = `
        <h1 class="greeting">Permanent Agent Status Activated</h1>
        <p class="subtitle">Lifetime access to premium data rates</p>
        
        <p class="message-text">
            Hi ${firstName}, congratulations on upgrading to the <strong>Permanent Agent</strong> membership!
        </p>
        
        <div class="highlight-box">
            <p class="highlight-text">
                You now have <strong>unlimited, lifetime access</strong> to KiNG FLEXY GH's lowest agent pricing. Your account will never expire, and you will never need to renew your subscription again.
            </p>
        </div>
        
        <p class="message-text">
            Enjoy permanent premium benefits and start maximizing your profits today.
        </p>
        
        <div style="text-align: center; margin: 25px 0;">
            <span class="status-badge status-success" style="background: linear-gradient(135deg, #4f46e5 0%, #3730a3 100%);">Lifetime Active</span>
        </div>
        
        <div class="cta-container">
            <a href="${siteUrl}/dashboard/data-packages" class="cta-button" style="background: linear-gradient(135deg, #4f46e5 0%, #312e81 100%); color: #ffffff !important;">
                Buy Partner Data
            </a>
        </div>
    `

    return sendMailerSendEmail({
        to: email,
        toName: firstName,
        subject: `Permanent Agent Status Activated`,
        htmlContent: generateProfessionalTemplate('Permanent Agent', content, '#4f46e5')
    }, 'billing@kingflexygh.com')
}

/**
 * Send dealer activation success email
 */
export async function sendDealerActivationSuccessEmail(
    email: string,
    firstName: string,
    expiryDate: string | Date
): Promise<EmailResult> {
    const siteUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.kingflexygh.com'
    const formatted = new Date(expiryDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    const content = `
        <h1 class="greeting">Dealer Status Activated!</h1>
        <p class="subtitle">Welcome to the highest reseller rank on the platform</p>

        <p class="message-text">
            Hi ${firstName}, congratulations on becoming a <strong>Dealer</strong> on KiNG FLEXY GH!
            You now have access to the most discounted prices on the platform.
        </p>

        <div class="highlight-box" style="background: rgba(124,58,237,0.08); border-left-color: #7C3AED;">
            <p class="highlight-text">
                Your Dealer membership is <strong>active for 6 months</strong> and expires on
                <strong>${formatted}</strong>. After expiry you automatically return to Lifetime Agent.
            </p>
        </div>

        <div class="info-card">
            <div class="info-card-header">
                <div class="info-card-icon" style="background: #7C3AED; color: white;">&#x1F48E;</div>
                <span class="info-card-title">Dealer Benefits</span>
            </div>
            <div class="info-row">
                <span class="info-label">Data Pricing</span>
                <span class="info-value" style="color: #7C3AED;">Lowest Dealer Rates</span>
            </div>
            <div class="info-row">
                <span class="info-label">API Access</span>
                <span class="info-value">Full + High Rate Limits</span>
            </div>
            <div class="info-row">
                <span class="info-label">Order Processing</span>
                <span class="info-value">Priority Queue</span>
            </div>
            <div class="info-row">
                <span class="info-label">Support</span>
                <span class="info-value">Direct Priority Line</span>
            </div>
            <div class="info-row">
                <span class="info-label">Membership Expiry</span>
                <span class="info-value">${formatted}</span>
            </div>
        </div>

        <div style="text-align: center; margin: 25px 0;">
            <span class="status-badge status-success" style="background: linear-gradient(135deg, #7C3AED 0%, #5B21B6 100%);">Dealer Active</span>
        </div>

        <div class="cta-container">
            <a href="${siteUrl}/dashboard/data-packages" class="cta-button" style="background: linear-gradient(135deg, #7C3AED 0%, #5B21B6 100%); color: #ffffff !important;">
                Buy Data at Dealer Prices
            </a>
        </div>
    `
    return sendMailerSendEmail({
        to: email,
        toName: firstName,
        subject: `Dealer Status Activated  -  Expires ${formatted}`,
        htmlContent: generateProfessionalTemplate('Dealer Activated', content, '#7C3AED')
    }, 'billing@kingflexygh.com')
}

/**
 * Send dealer membership extension success email
 */
export async function sendDealerExtensionSuccessEmail(
    email: string,
    firstName: string,
    newExpiryDate: string | Date
): Promise<EmailResult> {
    const siteUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.kingflexygh.com'
    const formatted = new Date(newExpiryDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    const content = `
        <h1 class="greeting">Dealer Membership Extended!</h1>
        <p class="subtitle">6 more months of premium dealer access</p>

        <p class="message-text">
            Hi ${firstName}, your <strong>Dealer membership</strong> has been successfully extended by 6 months.
            Continue enjoying the platform's lowest data prices without interruption.
        </p>

        <div class="highlight-box" style="background: rgba(124,58,237,0.08); border-left-color: #7C3AED;">
            <p class="highlight-text">
                Your new membership expiry date is <strong>${formatted}</strong>.
                Remember to renew before expiry to keep your Dealer status active.
            </p>
        </div>

        <div class="info-card">
            <div class="info-card-header">
                <div class="info-card-icon" style="background: #7C3AED; color: white;">&#x1F48E;</div>
                <span class="info-card-title">Membership Details</span>
            </div>
            <div class="info-row">
                <span class="info-label">Extension Added</span>
                <span class="info-value">+6 Months</span>
            </div>
            <div class="info-row">
                <span class="info-label">New Expiry Date</span>
                <span class="info-value" style="color: #7C3AED;">${formatted}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Membership Tier</span>
                <span class="info-value">Dealer  -  Premium</span>
            </div>
            <div class="info-row">
                <span class="info-label">Date</span>
                <span class="info-value">${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
            </div>
        </div>

        <div style="text-align: center; margin: 25px 0;">
            <span class="status-badge status-success" style="background: linear-gradient(135deg, #7C3AED 0%, #5B21B6 100%);">Extended</span>
        </div>

        <div class="cta-container">
            <a href="${siteUrl}/dashboard" class="cta-button" style="background: linear-gradient(135deg, #7C3AED 0%, #5B21B6 100%); color: #ffffff !important;">
                Go to Dashboard
            </a>
        </div>
    `
    return sendMailerSendEmail({
        to: email,
        toName: firstName,
        subject: `Dealer Membership Extended  -  New Expiry: ${formatted}`,
        htmlContent: generateProfessionalTemplate('Dealer Extended', content, '#7C3AED')
    }, 'billing@kingflexygh.com')
}

// ==========================================
// ADMIN EMAIL FUNCTIONS
// ==========================================

/**
 * Send alert to admin when a user successfully claims a MoMo transaction
 */
export async function sendMomoClaimAdminAlert(
    details: {
        userName: string
        userEmail: string
        transactionId: string
        amount: number
        date: string
        isAutoClaim?: boolean
        refCode?: string | null
    }
): Promise<EmailResult> {
    // Admin MoMo claim alerts now handled exclusively via web push (see claim-momo/route.ts)
    console.log(`[MomoClaimAlert] Push-only — email suppressed for ${details.isAutoClaim ? 'auto' : 'manual'} claim GHS ${details.amount}`)
    return { success: true }
}

/**
 * Send new order alert to admin when fulfillment is skipped or fails
 */
export async function sendAdminNewOrderAlert(
    orderDetails: {
        referenceCode: string
        phoneNumber: string
        network: string
        size: string
        price: number
        customerName: string
        customerEmail: string
        source: 'main_site' | 'shop_storefront'
        shopName?: string
        reason: string
    }
): Promise<EmailResult> {
    // Dedup: only send one admin push alert per order reference per 6 hours
    const dedupKey = `push:order_alert:${orderDetails.referenceCode}`
    const alreadyAlerted = await redis.set(dedupKey, '1', { nx: true, ex: 6 * 60 * 60 })
    if (alreadyAlerted === null) {
        console.log(`[OrderAlert] Suppressed duplicate alert for order ${orderDetails.referenceCode}`)
        return { success: true }
    }

    const isFailure = orderDetails.reason.toLowerCase().includes('error') || orderDetails.reason.toLowerCase().includes('fail')

    // Fulfillment alerts now handled exclusively via web push — no email broadcast
    await sendAdminPushNotification({
        title: isFailure ? 'Order Fulfillment Failed' : 'New Order - Manual Fulfillment',
        body: `${orderDetails.network} ${orderDetails.size} for ${orderDetails.phoneNumber} (GHS ${orderDetails.price}) - ${orderDetails.reason}`,
        url: `/admin/orders`
    }).catch(e => console.error('[Order Alert] Admin push error:', e))

    return { success: true }
}


/**
 * Send aggregated bulk order fulfillment alert to all admins/sub-admins
 */
export async function sendAdminBulkOrderAlert(
    details: {
        totalOrders: number
        failureCount: number
        failures: Array<{ referenceCode: string; network: string; reason: string; type: 'error' | 'skipped' }>
        customerName: string
        customerEmail: string
    }
): Promise<EmailResult> {
    const hasErrors = details.failures.some(f => f.type === 'error')
    // Bulk order alerts now handled exclusively via web push — no email broadcast
    await sendAdminPushNotification({
        title: hasErrors ? 'Bulk Fulfillment Issues Detected' : 'Bulk Order - Action Required',
        body: `${details.failureCount}/${details.totalOrders} orders failed/skipped. Submitted by ${details.customerName}.`,
        url: `/admin/orders`
    }).catch(e => console.error('[Bulk Alert] Admin push error:', e))
    return { success: true }
}


/**
 * Send welcome notification to admin when new user signs up
 */
export async function sendAdminNewUserAlert(
    userDetails: {
        firstName: string
        lastName: string
        email: string
        phoneNumber: string
    }
): Promise<EmailResult> {
    const adminEmail = process.env.ADMIN_EMAIL || 'kingflexytechnologies@gmail.com'

    const content = `
        <h1 class="greeting">New User Registration</h1>
        <p class="subtitle">A new user has joined the platform</p>
        
        <div class="info-card">
            <div class="info-card-header">
                <div class="info-card-icon">i</div>
                <span class="info-card-title">New User Details</span>
            </div>
            <div class="info-row">
                <span class="info-label">Full Name</span>
                <span class="info-value">${escapeHtml(userDetails.firstName)} ${escapeHtml(userDetails.lastName)}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Email</span>
                <span class="info-value">${escapeHtml(userDetails.email)}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Phone Number</span>
                <span class="info-value">${escapeHtml(userDetails.phoneNumber)}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Joined At</span>
                <span class="info-value">${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
            </div>
        </div>
        
        <div class="cta-container">
            <a href="${process.env.NEXT_PUBLIC_APP_URL}/admin/users" class="cta-button">
                View in Admin Panel
            </a>
        </div>
    `

    await sendAdminPushNotification({
        title: 'New User Registered ',
        body: `${userDetails.firstName} ${userDetails.lastName} (${userDetails.phoneNumber}) has registered.`,
        url: `/admin/users`
    }).catch(e => console.error('[New User Alert] Admin push error:', e))

    return sendEmail({
        to: adminEmail,
        toName: 'Admin',
        subject: `New User: ${userDetails.firstName} ${userDetails.lastName}`,
        htmlContent: generateProfessionalTemplate('New User Alert', content)
    }, 'admin@kingflexygh.com')
}

// ==========================================
// SHOP ALERT EMAIL FUNCTIONS  -  OWNER
// ==========================================

/**
 * Alert 3 Â· Pricing Approved  -  Email to shop owner
 */
export async function sendShopPricingApprovedEmail(
    email: string,
    firstName: string,
    shopName: string
): Promise<EmailResult> {
    const siteUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.kingflexygh.com'
    const content = `
        <h1 class="greeting">Pricing Approved</h1>
        <p class="subtitle">Your shop prices are now live</p>
        <p class="message-text">
            Hi ${escapeHtml(firstName)}, your submitted prices for <strong>${escapeHtml(shopName)}</strong> have been reviewed and approved.
            Your new prices are now <strong>live on your shop</strong>. Customers can start ordering immediately.
        </p>
        <div style="text-align: center; margin: 25px 0;"><span class="status-badge status-success">Approved</span></div>
        <div class="cta-container"><a href="${siteUrl}/dashboard/shop" class="cta-button">View My Shop</a></div>
    `
    return sendEmail({ to: email, toName: firstName, subject: `Your Shop Pricing is Approved  -  ${shopName}`, htmlContent: generateProfessionalTemplate('Pricing Approved', content, '#10b981') })
}

/**
 * Alert 4 Â· Pricing Rejected  -  Email to shop owner
 */
export async function sendShopPricingRejectedEmail(
    email: string,
    firstName: string,
    shopName: string,
    reason: string
): Promise<EmailResult> {
    const siteUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.kingflexygh.com'
    const content = `
        <h1 class="greeting">Pricing Needs Revision</h1>
        <p class="subtitle">Your pricing submission was returned</p>
        <p class="message-text">Hi ${escapeHtml(firstName)}, your pricing submission for <strong>${escapeHtml(shopName)}</strong> has been returned for revision.</p>
        <div class="highlight-box"><p class="highlight-text"><strong>Admin note:</strong> ${escapeHtml(reason)}</p></div>
        <p class="message-text">Please log in, review the feedback, and resubmit your prices.</p>
        <div style="text-align: center; margin: 25px 0;"><span class="status-badge status-failed">Rejected</span></div>
        <div class="cta-container"><a href="${siteUrl}/dashboard/shop/pricing" class="cta-button">Revise Pricing</a></div>
    `
    return sendEmail({ to: email, toName: firstName, subject: `Shop Pricing Needs Revision  -  ${shopName}`, htmlContent: generateProfessionalTemplate('Pricing Rejected', content, '#ef4444') })
}

/**
 * Alert 5 Â· Shop Profile Approved  -  Email to shop owner
 */
export async function sendShopProfileApprovedEmail(
    email: string,
    firstName: string,
    shopName: string
): Promise<EmailResult> {
    const siteUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.kingflexygh.com'
    const content = `
        <h1 class="greeting">Your Shop is Approved</h1>
        <p class="subtitle">Welcome to the King Flexy Shop Network</p>
        <p class="message-text">Hi ${escapeHtml(firstName)}, your shop <strong>${escapeHtml(shopName)}</strong> has been approved. Set your prices to go live!</p>
        <div class="info-card">
            <div class="info-card-header"><div class="info-card-icon">i</div><span class="info-card-title">Next Steps</span></div>
            <div class="info-row"><span class="info-label">1. Set Pricing</span><span class="info-value">Go to Shop → Pricing</span></div>
            <div class="info-row"><span class="info-label">2. Submit for Review</span><span class="info-value">Admin approves within 24hrs</span></div>
            <div class="info-row"><span class="info-label">3. Go Live</span><span class="info-value">Share your shop link & start earning</span></div>
        </div>
        <div style="text-align: center; margin: 25px 0;"><span class="status-badge status-success">Approved</span></div>
        <div class="cta-container"><a href="${siteUrl}/dashboard/shop/pricing" class="cta-button">Set Pricing Now</a></div>
    `
    return sendEmail({ to: email, toName: firstName, subject: `Your Shop "${shopName}" is Approved!`, htmlContent: generateProfessionalTemplate('Shop Approved', content, '#10b981') })
}

/**
 * Alert 6 Â· Shop Profile Rejected  -  Email to shop owner
 */
export async function sendShopProfileRejectedEmail(
    email: string,
    firstName: string,
    shopName: string,
    reason: string
): Promise<EmailResult> {
    const siteUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.kingflexygh.com'
    const content = `
        <h1 class="greeting">Shop Application  -  Action Required</h1>
        <p class="subtitle">Your shop application needs attention</p>
        <p class="message-text">Hi ${escapeHtml(firstName)}, your shop application for <strong>${escapeHtml(shopName)}</strong> could not be approved at this time.</p>
        <div class="highlight-box"><p class="highlight-text"><strong>Admin note:</strong> ${escapeHtml(reason)}</p></div>
        <p class="message-text">Please log in, address the feedback, and resubmit your shop profile.</p>
        <div style="text-align: center; margin: 25px 0;"><span class="status-badge status-failed">Rejected</span></div>
        <div class="cta-container"><a href="${siteUrl}/dashboard/shop" class="cta-button">Update My Profile</a></div>
    `
    return sendEmail({ to: email, toName: firstName, subject: `Shop Application  -  Action Required (${shopName})`, htmlContent: generateProfessionalTemplate('Shop Rejected', content, '#ef4444') })
}

/**
 * Alert 7 Â· Withdrawal Processed (Paid)  -  Email to shop owner
 */
export async function sendShopWithdrawalProcessedEmail(
    email: string,
    firstName: string,
    shopName: string,
    netAmount: number,
    momoNumber: string,
    network: string
): Promise<EmailResult> {
    const siteUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.kingflexygh.com'
    // Escape user-controlled strings (H1) + mask the destination number (M2),
    // matching the admin withdrawal-request alert.
    const maskNum = (n: string) => !n ? '' : n.length <= 4 ? '****' : '*'.repeat(n.length - 4) + n.slice(-4)
    const content = `
        <h1 class="greeting">Payout Successful</h1>
        <p class="subtitle">Your funds have been sent</p>
        <div class="amount-display">
            <p class="amount-label">Net Payout Sent</p>
            <p class="amount-value"><span class="amount-currency">GH</span>${netAmount.toFixed(2)}</p>
        </div>
        <p class="message-text">Hi ${escapeHtml(firstName)}, your net payout from <strong>${escapeHtml(shopName)}</strong> has been successfully sent to your ${escapeHtml(network)} number.</p>
        <div class="info-card">
            <div class="info-card-header"><div class="info-card-icon">i</div><span class="info-card-title">Payout Details</span></div>
            <div class="info-row"><span class="info-label">Net Amount</span><span class="info-value" style="color: #10b981;">GH${netAmount.toFixed(2)}</span></div>
            <div class="info-row"><span class="info-label">Network</span><span class="info-value">${escapeHtml(network)}</span></div>
            <div class="info-row"><span class="info-label">MoMo Number</span><span class="info-value">${maskNum(momoNumber)}</span></div>
            <div class="info-row"><span class="info-label">Date</span><span class="info-value">${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></div>
        </div>
        <div style="text-align: center; margin: 25px 0;"><span class="status-badge status-success">Completed</span></div>
        <p class="message-text">Thank you for selling with KiNG FLEXY GH. Keep growing!</p>
        <div class="cta-container"><a href="${siteUrl}/dashboard/shop/withdraw" class="cta-button">View Withdrawal History</a></div>
    `
    return sendMailerSendEmail({ to: email, toName: firstName, subject: `Net Payout of GH${netAmount.toFixed(2)} Sent  -  ${shopName}`, htmlContent: generateProfessionalTemplate('Payout Successful', content, '#10b981') }, 'billing@kingflexygh.com')
}

/**
 * Alert 7b Â· Withdrawal Rejected  -  Email to shop owner
 */
export async function sendShopWithdrawalRejectedEmail(
    email: string,
    firstName: string,
    shopName: string,
    amount: number,
    adminNote: string
): Promise<EmailResult> {
    const siteUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.kingflexygh.com'
    const content = `
        <h1 class="greeting">Withdrawal Request  -  Action Required</h1>
        <p class="subtitle">Your withdrawal request was not approved</p>
        <div class="amount-display" style="background: linear-gradient(135deg, #7f1d1d 0%, #991b1b 100%);"> 
            <p class="amount-label">Requested Amount</p>
            <p class="amount-value"><span class="amount-currency" style="color: #fca5a5;">GH</span>${amount.toFixed(2)}</p>
        </div>
        <p class="message-text">Hi ${escapeHtml(firstName)}, your withdrawal request from <strong>${escapeHtml(shopName)}</strong> was not approved at this time.</p>
        <div class="highlight-box"><p class="highlight-text"><strong>Admin note:</strong> ${escapeHtml(adminNote)}</p></div>
        <p class="message-text">Please log in to your dashboard, review the reason, update your payment details, and resubmit your request.</p>
        <div style="text-align: center; margin: 25px 0;"><span class="status-badge status-failed">Rejected</span></div>
        <div class="cta-container"><a href="${siteUrl}/dashboard/shop/withdraw" class="cta-button">Update &amp; Resubmit</a></div>
    `
    return sendMailerSendEmail({ to: email, toName: firstName, subject: `Withdrawal Request Rejected  -  ${shopName}`, htmlContent: generateProfessionalTemplate('Withdrawal Rejected', content, '#ef4444') }, 'billing@kingflexygh.com')
}

// ==========================================
// ADMIN SHOP ALERT EMAIL FUNCTIONS
// ==========================================

/**
 * Alert 9 Â· New Pricing Submission  -  Email to admin only
 */
export async function sendAdminShopPricingSubmissionAlert(details: {
    shopName: string; ownerName: string; ownerEmail: string; shopId: string; date: string
}): Promise<EmailResult> {
    const adminEmail = process.env.ADMIN_EMAIL || 'kingflexytechnologies@gmail.com'
    const siteUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.kingflexygh.com'
    const content = `
        <h1 class="greeting">New Pricing Submission</h1>
        <p class="subtitle">A shop owner has submitted pricing for review</p>
        <div class="info-card">
            <div class="info-card-header"><div class="info-card-icon">i</div><span class="info-card-title">Submission Details</span></div>
            <div class="info-row"><span class="info-label">Shop</span><span class="info-value">${escapeHtml(details.shopName)}</span></div>
            <div class="info-row"><span class="info-label">Owner</span><span class="info-value">${escapeHtml(details.ownerName)}</span></div>
            <div class="info-row"><span class="info-label">Owner Email</span><span class="info-value">${escapeHtml(details.ownerEmail)}</span></div>
            <div class="info-row"><span class="info-label">Submitted</span><span class="info-value">${escapeHtml(details.date)}</span></div>
        </div>
        <div class="cta-container"><a href="${siteUrl}/admin/shops/${encodeURIComponent(details.shopId)}" class="cta-button">Review Pricing</a></div>
    `
    await sendAdminPushNotification({
        title: 'New Shop Pricing Submission ',
        body: `${details.shopName} (Owner: ${details.ownerName}) has submitted pricing for review.`,
        url: `/admin/shops/${details.shopId}`
    }).catch(e => console.error('[Pricing Alert] Admin push error:', e))

    return sendEmail({ to: adminEmail, toName: 'Admin', subject: `New Pricing Submission  -  ${details.shopName}`, htmlContent: generateProfessionalTemplate('Pricing Submission', content) }, 'admin@kingflexygh.com')
}

/**
 * Alert 10 Â· New Shop Registration  -  Email to admin only
 */
export async function sendAdminNewShopRegistrationAlert(details: {
    shopName: string; ownerName: string; ownerEmail: string; date: string
}): Promise<EmailResult> {
    const adminEmail = process.env.ADMIN_EMAIL || 'kingflexytechnologies@gmail.com'
    const siteUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.kingflexygh.com'
    const content = `
        <h1 class="greeting">New Shop Registration</h1>
        <p class="subtitle">A new shop is awaiting your approval</p>
        <div class="info-card">
            <div class="info-card-header"><div class="info-card-icon">i</div><span class="info-card-title">Shop Details</span></div>
            <div class="info-row"><span class="info-label">Shop Name</span><span class="info-value">${escapeHtml(details.shopName)}</span></div>
            <div class="info-row"><span class="info-label">Owner</span><span class="info-value">${escapeHtml(details.ownerName)}</span></div>
            <div class="info-row"><span class="info-label">Owner Email</span><span class="info-value">${escapeHtml(details.ownerEmail)}</span></div>
            <div class="info-row"><span class="info-label">Submitted</span><span class="info-value">${escapeHtml(details.date)}</span></div>
        </div>
        <div style="text-align: center; margin: 25px 0;"><span class="status-badge status-pending">Pending Review</span></div>
        <div class="cta-container"><a href="${siteUrl}/admin/shops" class="cta-button">Review Shop</a></div>
    `
    await sendAdminPushNotification({
        title: 'New Shop Registration ',
        body: `${details.shopName} (Owner: ${details.ownerName}) has registered a new shop.`,
        url: `/admin/shops`
    }).catch(e => console.error('[Shop Registration Alert] Admin push error:', e))

    return sendEmail({ to: adminEmail, toName: 'Admin', subject: `New Shop Registration  -  ${details.shopName}`, htmlContent: generateProfessionalTemplate('New Shop Registration', content) }, 'admin@kingflexygh.com')
}

/**
 * Alert 11 Â· Withdrawal Request  -  Email to admin only
 */
export async function sendAdminShopWithdrawalRequestAlert(details: {
    shopName: string
    ownerName: string
    ownerPhone?: string
    amount: number
    momoNumber: string
    accountName: string
    network: string
    balanceSnapshot: number
    date: string
    shopId: string
    isResubmission?: boolean
}): Promise<EmailResult> {
    // SEC-W04/W10: HTML-escape user-controlled strings to prevent XSS in email body.
    // Mask momoNumber to last-4 digits before interpolation. Uses the shared
    // escapeHtml() so apostrophes are escaped too.
    const esc = escapeHtml
    const maskNum = (n: string) => !n ? '' : n.length <= 4 ? '****' : '*'.repeat(n.length - 4) + n.slice(-4)

    const adminEmail = process.env.ADMIN_EMAIL || 'kingflexytechnologies@gmail.com'
    const siteUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.kingflexygh.com'
    const badge = details.isResubmission
        ? `<div style="text-align:center;margin:20px 0;"><span style="background:#7c3aed;color:#fff;padding:6px 16px;border-radius:50px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Resubmission</span></div>`
        : ''
    const content = `
        <h1 class="greeting">${details.isResubmission ? 'Resubmitted Withdrawal Request ' : 'New Withdrawal Request'}</h1>
        <p class="subtitle">A shop owner has requested a payout</p>
        ${badge}
        <div class="amount-display">
            <p class="amount-label">Requested Amount</p>
            <p class="amount-value"><span class="amount-currency">GH</span>${details.amount.toFixed(2)}</p>
        </div>
        <div class="info-card">
            <div class="info-card-header"><div class="info-card-icon">i</div><span class="info-card-title">Request Details</span></div>
            <div class="info-row"><span class="info-label">Shop</span><span class="info-value">${esc(details.shopName)}</span></div>
            <div class="info-row"><span class="info-label">Owner</span><span class="info-value">${esc(details.ownerName)}</span></div>
            ${details.ownerPhone ? `<div class="info-row"><span class="info-label">Owner Phone</span><span class="info-value">${esc(details.ownerPhone)}</span></div>` : ''}
            <div class="info-row"><span class="info-label">Gross Amount</span><span class="info-value" style="color: #D4AF37; font-size:16px;">GH${details.amount.toFixed(2)}</span></div>
            <div class="info-row"><span class="info-label">Network</span><span class="info-value">${esc(details.network)}</span></div>
            <div class="info-row"><span class="info-label">Account Name</span><span class="info-value">${esc(details.accountName)}</span></div>
            <div class="info-row"><span class="info-label">MoMo Number</span><span class="info-value">${maskNum(details.momoNumber)}</span></div>
            <div class="info-row"><span class="info-label">Remaining Balance</span><span class="info-value" style="color:#10b981;">GH${details.balanceSnapshot.toFixed(2)}</span></div>
            <div class="info-row"><span class="info-label">Requested</span><span class="info-value">${details.date}</span></div>
        </div>
        <div style="text-align: center; margin: 25px 0;"><span class="status-badge status-pending">Action Required</span></div>
        <div class="cta-container"><a href="${siteUrl}/admin/shops/withdrawals" class="cta-button">Process Withdrawal</a></div>
    `
    await sendAdminPushNotification({
        title: details.isResubmission ? 'Resubmitted Shop Withdrawal ' : 'New Shop Withdrawal Request ',
        body: `${details.shopName} (Owner: ${details.ownerName}) requested payout of GHS ${details.amount.toFixed(2)}.`,
        url: `/admin/shops/withdrawals`
    }).catch(e => console.error('[Withdrawal Alert] Admin push error:', e))

    return sendEmail({ to: adminEmail, toName: 'Admin', subject: `${details.isResubmission ? 'Resubmission' : 'New Withdrawal'}  -  GH${details.amount.toFixed(2)} from ${details.shopName}`, htmlContent: generateProfessionalTemplate('Withdrawal Request', content) }, 'admin@kingflexygh.com')
}

/**
 * Alert 12 Â· New AFA Membership Application  -  Email to admin only
 */
export async function sendAdminNewAfaApplicationAlert(details: {
    applicantName: string
    phone: string
    region: string
}, toEmail?: string): Promise<EmailResult> {
    const adminEmail = toEmail || process.env.ADMIN_EMAIL || 'kingflexytechnologies@gmail.com'
    const siteUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.kingflexygh.com'
    const content = `
        <h1 class="greeting">New AFA Membership Application</h1>
        <p class="subtitle">A new application has been submitted for review</p>
        <div class="info-card">
            <div class="info-card-header"><div class="info-card-icon">i</div><span class="info-card-title">Applicant Details</span></div>
            <div class="info-row"><span class="info-label">Name</span><span class="info-value">${escapeHtml(details.applicantName)}</span></div>
            <div class="info-row"><span class="info-label">Phone</span><span class="info-value">${escapeHtml(details.phone)}</span></div>
            <div class="info-row"><span class="info-label">Region</span><span class="info-value">${escapeHtml(details.region)}</span></div>
        </div>
        <div style="text-align: center; margin: 25px 0;"><span class="status-badge status-pending">Action Required</span></div>
        <div class="cta-container"><a href="${siteUrl}/admin/afa-management" class="cta-button">Review Application</a></div>
    `
    await sendAdminPushNotification({
        title: 'New AFA Application ',
        body: `${details.applicantName} (${details.phone}) from ${details.region} applied for AFA.`,
        url: `/admin/afa-management`
    }).catch(e => console.error('[AFA Alert] Admin push error:', e))

    return sendEmail({ to: adminEmail, toName: 'Admin', subject: ' New AFA Membership Application - ' + details.applicantName, htmlContent: generateProfessionalTemplate('New AFA Application', content) }, 'admin@kingflexygh.com')
}

// ==========================================
// AIRTIME EMAIL FUNCTIONS
// ==========================================

/**
 * Send admin alert email when a new airtime or mashup order is placed.
 * For Mashup orders, the email title/greeting and order label change to reflect
 * the mashup context. A "Preference" row is added to the Order Details section.
 */
export async function sendAdminAirtimeOrderEmail(details: {
    referenceCode: string
    userName: string
    userEmail: string
    userRole: string
    beneficiaryPhone: string
    network: string
    airtimeAmount: number | string
    feeRate?: number | string
    feeAmount?: number | string
    totalPaid: number | string
    walletBalanceAfter?: number | string | null
    useExactAmount: boolean
    source?: string
    type?: 'airtime' | 'mashup'
    bundle_preference?: 'balanced' | 'data' | 'voice' | null
}): Promise<EmailResult> {
    // Airtime/Mashup order alerts now handled exclusively via web push — no email broadcast
    const isMashup = details.type === 'mashup'
    const parseNum = (val: any) => typeof val === 'string' ? parseFloat(val) : val
    await sendAdminPushNotification({
        title: `New ${isMashup ? 'Mashup' : 'Airtime'} Order`,
        body: `${details.network} GHS ${parseNum(details.airtimeAmount).toFixed(2)} to ${details.beneficiaryPhone} by ${details.userName}.`,
        url: `/admin/airtime`
    }).catch(e => console.error('[Airtime Alert] Admin push error:', e))
    return { success: true }
}

// ==========================================
// RESULTS CHECKER EMAIL FUNCTIONS
// ==========================================

/**
 * Send voucher delivery email to customer with a styled voucher table.
 * Uses the existing generateProfessionalTemplate() infrastructure.
 */
export async function sendResultsCheckerDeliveryEmail(
    email: string,
    name: string,
    orderDetails: {
        referenceCode: string
        typeName: string
        quantity: number
        totalPaid: number
    },
    vouchers: Array<{ pin: string; serial_number: string }>
): Promise<EmailResult> {
    const voucherRows = vouchers.map((v, i) => `
        <tr>
            <td style="padding: 12px 16px; border-bottom: 1px solid #e2e8f0; font-size: 14px; color: #64748b; font-weight: 500;">${i + 1}</td>
            <td style="padding: 12px 16px; border-bottom: 1px solid #e2e8f0; font-size: 14px; font-weight: 700; color: #1a1a2e; letter-spacing: 1px; font-family: monospace;">${v.pin}</td>
            <td style="padding: 12px 16px; border-bottom: 1px solid #e2e8f0; font-size: 14px; font-weight: 600; color: #475569; font-family: monospace;">${v.serial_number}</td>
        </tr>
    `).join('')

    const upperTypeName = orderDetails.typeName.toUpperCase()
    let url = 'Please contact your exam board on how to print your results.'
    if (upperTypeName.includes('BECE')) {
        url = 'eresults.waecgh.org'
    } else if (upperTypeName.includes('WAEC') || upperTypeName.includes('WASSCE')) {
        url = 'ghana.waecdirect.org'
    }

    const content = `
        <h1 class="greeting">Your Vouchers Are Ready! </h1>
        <p class="subtitle">${orderDetails.typeName}  -  ${orderDetails.quantity} voucher${orderDetails.quantity > 1 ? 's' : ''}</p>

        <p class="message-text">
            Hi ${name}, your Results Checker voucher${orderDetails.quantity > 1 ? 's are' : ' is'} attached below.
            Keep this email safe  -  you'll need the PIN and Serial Number to check your results.
        </p>

        <div class="info-card">
            <div class="info-card-header">
                <div class="info-card-icon">i</div>
                <span class="info-card-title">Order Summary</span>
            </div>
            <div class="info-row">
                <span class="info-label">Reference</span>
                <span class="info-value">${orderDetails.referenceCode}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Exam Type</span>
                <span class="info-value">${orderDetails.typeName}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Quantity</span>
                <span class="info-value">${orderDetails.quantity}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Amount Paid</span>
                <span class="info-value" style="color: #10b981; font-size: 16px;">GHS ${orderDetails.totalPaid.toFixed(2)}</span>
            </div>
        </div>

        <div style="margin: 30px 0;">
            <div style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); border-radius: 16px; padding: 20px; margin-bottom: 15px;">
                <p style="font-size: 12px; color: rgba(255,255,255,0.6); text-transform: uppercase; letter-spacing: 3px; margin-bottom: 8px; font-weight: 600;">Your Voucher${orderDetails.quantity > 1 ? 's' : ''}</p>
            </div>
            <table style="width: 100%; border-collapse: collapse; border-radius: 12px; overflow: hidden; border: 1px solid #e2e8f0;">
                <thead>
                    <tr style="background: linear-gradient(135deg, #f8fafc, #f1f5f9);">
                        <th style="padding: 12px 16px; text-align: left; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #64748b;">#</th>
                        <th style="padding: 12px 16px; text-align: left; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #64748b;">PIN</th>
                        <th style="padding: 12px 16px; text-align: left; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #64748b;">Serial Number</th>
                    </tr>
                </thead>
                <tbody>
                    ${voucherRows}
                </tbody>
            </table>
        </div>

        <div class="highlight-box">
            <p class="highlight-text">
                <strong>How to use:</strong> Visit the official portal at <strong><a href="https://${url.replace('https://', '')}" style="color: #10b981;">${url}</a></strong> and enter your PIN and Serial Number to check your results.
            </p>
        </div>

        <div style="text-align: center; margin: 25px 0;">
            <span class="status-badge status-success">Delivered</span>
        </div>

        <div class="cta-container">
            <a href="${process.env.NEXT_PUBLIC_APP_URL}/dashboard/results-checker" class="cta-button">
                View My Orders
            </a>
        </div>
    `

    return sendEmail({
        to: email,
        toName: name,
        subject: `Your ${orderDetails.typeName} Voucher${orderDetails.quantity > 1 ? 's' : ''}  -  ${orderDetails.referenceCode}`,
        htmlContent: generateProfessionalTemplate('Results Checker Vouchers', content, '#10b981'),
    })
}

/**
 * Send admin notification when a new RC order is placed.
 */
export async function sendAdminRCOrderEmail(orderDetails: {
    referenceCode: string
    typeName: string
    quantity: number
    totalPaid: number
    customerPhone?: string | null
    customerEmail?: string | null
    userRole: string
    source: string
}): Promise<EmailResult> {
    // RC order alerts now handled exclusively via web push — no email broadcast
    await sendAdminPushNotification({
        title: 'New RC Order',
        body: `${orderDetails.quantity}x ${orderDetails.typeName} (Total: GHS ${orderDetails.totalPaid.toFixed(2)}) by ${orderDetails.userRole}.`,
        url: `/admin/results-checker`
    }).catch(e => console.error('[RC Alert] Admin push error:', e))
    return { success: true }
}

// ==========================================
// MOMO CLAIM EMAIL FUNCTIONS
// ==========================================

/**
 * Send MoMo claim success email to the claiming user.
 * Uses the existing Brevo premium template system (emerald accent).
 */
export async function sendMomoClaimSuccessEmail(
    email: string,
    firstName: string,
    details: {
        transactionId: string
        senderName: string
        senderNetwork: string
        amount: number
        feePercent: number
        feeAmount: number
        netAmount: number
        newBalance: number
        isAutoClaim?: boolean
        refCode?: string | null
    }
): Promise<EmailResult> {
    const claimedAt = new Date().toLocaleDateString('en-GB', {
        day: 'numeric', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
    })

    const feeRow = details.feePercent > 0
        ? `<div class="info-row">
                <span class="info-label">Claim Fee (${details.feePercent}%)</span>
                <span class="info-value" style="color: #e11d48;">- GHS ${details.feeAmount.toFixed(2)}</span>
           </div>`
        : `<div class="info-row">
                <span class="info-label">Claim Fee</span>
                <span class="info-value" style="color: #10b981;">Free</span>
           </div>`

    const content = `
        <h1 class="greeting">MoMo Claim Successful! </h1>
        <p class="subtitle">Your wallet has been credited instantly</p>

        <div class="amount-display">
            <p class="amount-label">Amount Credited</p>
            <p class="amount-value"><span class="amount-currency">GHS</span> ${details.netAmount.toFixed(2)}</p>
        </div>

        <p class="message-text">
            Hi ${firstName}, your MoMo claim has been successfully processed and your
            Flexy-Wallet has been credited. You can now use your balance to purchase
            data bundles for any network.
        </p>

        <div class="info-card">
            <div class="info-card-header">
                <div class="info-card-icon">i</div>
                <span class="info-card-title">Claim Breakdown</span>
            </div>
            <div class="info-row">
                <span class="info-label">Transaction ID</span>
                <span class="info-value" style="font-family: monospace; font-size: 13px;">${details.transactionId}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Network Provider</span>
                <span class="info-value">${escapeHtml(details.senderNetwork)}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Sender Name</span>
                <span class="info-value">${escapeHtml(details.senderName)}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Payment Amount</span>
                <span class="info-value">GHS ${details.amount.toFixed(2)}</span>
            </div>
            ${feeRow}
            <div class="info-row" style="border-top: 2px solid #e2e8f0; margin-top: 8px; padding-top: 12px;">
                <span class="info-label" style="font-weight: 700; color: #1a1a2e;">Amount Credited</span>
                <span class="info-value" style="color: #10b981; font-size: 18px; font-weight: 700;">GHS ${details.netAmount.toFixed(2)}</span>
            </div>
            <div class="info-row">
                <span class="info-label">New Wallet Balance</span>
                <span class="info-value" style="color: #10b981; font-weight: 600;">GHS ${details.newBalance.toFixed(2)}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Date</span>
                <span class="info-value">${claimedAt}</span>
            </div>
        </div>

        <div style="text-align: center; margin: 25px 0;">
            <span class="status-badge status-success">Completed</span>
        </div>

        <div class="cta-container">
            <a href="${process.env.NEXT_PUBLIC_APP_URL}/dashboard/data-packages" class="cta-button">
                Buy Data Now
            </a>
        </div>

        <div class="highlight-box" style="border-left-color: #ef4444; background: rgba(239,68,68,0.05);">
            <p class="highlight-text" style="color: #7f1d1d;">
                 <strong>Security Notice:</strong> If you did not make this MoMo claim,
                please contact our support team immediately at
                <a href="mailto:kingflexytechnologies@gmail.com" style="color: #dc2626;">kingflexytechnologies@gmail.com</a>
            </p>
        </div>
    `

    return sendEmail({
        to: email,
        toName: firstName,
        subject: details.isAutoClaim ? ` Auto-Claim Successful  -  GHS ${details.netAmount.toFixed(2)} Credited (Ref: ${details.refCode})` : `MoMo Claim Successful  -  GHS ${details.netAmount.toFixed(2)} Credited`,
        htmlContent: generateProfessionalTemplate('MoMo Claim Successful', content, '#10b981')
    })
}


/**
 * Send agent renewal reminder email
 */
export async function sendAgentRenewalReminderEmail(
    email: string,
    firstName: string
): Promise<EmailResult> {
    const siteUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.kingflexygh.com'
    const content = `
        <h1 class="greeting">Agent Role Expiring Soon</h1>
        <p class="subtitle">Your premium agent access needs renewal</p>
        
        <p class="message-text">
            Hi ${firstName}, your Agent Role plan is about to expire. 
            Kindly extend your plan to continue enjoying our lowest agent prices.
        </p>
        
        <div style="text-align: center; margin: 25px 0;">
            <span class="status-badge status-pending">Action Required</span>
        </div>
        
        <div class="cta-container">
            <a href="${siteUrl}/dashboard/agent-upgrade" class="cta-button">
                Extend Plan Now
            </a>
        </div>
    `

    return sendEmail({
        to: email,
        toName: firstName,
        subject: `Agent Role Expiring Soon - Action Required`,
        htmlContent: generateProfessionalTemplate('Agent Role Expiry', content)
    })
}

/**
 * Send dealer renewal reminder email (less than 48 hours left)
 */
export async function sendDealerRenewalReminderEmail(
    email: string,
    firstName: string
): Promise<EmailResult> {
    const siteUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.kingflexygh.com'
    const content = `
        <h1 class="greeting">Dealer Role Expiring Soon</h1>
        <p class="subtitle">Your premium dealer access is expiring in less than 48 hours</p>

        <p class="message-text">
            Hi ${firstName}, your Dealer Role plan is expiring in less than 48 hours.
            Enable Auto-Upgrade in your dashboard settings so your Flexy-Wallet covers the renewal automatically —
            or renew manually before it expires to keep your Dealer benefits uninterrupted.
        </p>

        <div style="text-align: center; margin: 25px 0;">
            <span class="status-badge status-pending">Action Required</span>
        </div>

        <div class="cta-container">
            <a href="${siteUrl}/dashboard/upgrade" class="cta-button" style="background: linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%);">
                Renew / Enable Auto-Upgrade
            </a>
        </div>
    `

    return sendEmail({
        to: email,
        toName: firstName,
        subject: `Dealer Role Expiring Soon - Action Required`,
        htmlContent: generateProfessionalTemplate('Dealer Role Expiry', content, '#7c3aed')
    })
}

/**
 * Send automated daily/weekly/monthly sales summary to shop owners
 */
export async function sendShopSalesSummaryEmail(
    email: string,
    firstName: string,
    shopName: string,
    reportType: 'daily' | 'weekly' | 'monthly',
    dateRangeStr: string,
    stats: {
        totalOrders: number
        successfulOrders: number
        grossSales: number
        netProfit: number
        topSellingNetwork: string
    }
): Promise<EmailResult> {
    const siteUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.kingflexygh.com'
    const successRate = stats.totalOrders > 0 
        ? Math.round((stats.successfulOrders / stats.totalOrders) * 100) 
        : 0

    const content = `
        <h1 class="greeting">Your ${reportType.charAt(0).toUpperCase() + reportType.slice(1)} Sales Report</h1>
        <p class="subtitle">Performance summary for <strong>${escapeHtml(shopName)}</strong></p>
        
        <p class="message-text">
            Hi ${firstName}, here is your automated ${reportType} sales recap for ${dateRangeStr}.
        </p>

        <div class="amount-display">
            <p class="amount-label">Net Profit Earned</p>
            <p class="amount-value"><span class="amount-currency">GHS</span> ${stats.netProfit.toFixed(2)}</p>
        </div>

        <div class="info-card">
            <div class="info-card-header">
                <div class="info-card-icon">i</div>
                <span class="info-card-title">Performance Metrics</span>
            </div>
            <div class="info-row">
                <span class="info-label">Gross Sales</span>
                <span class="info-value">GHS ${stats.grossSales.toFixed(2)}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Total Orders</span>
                <span class="info-value">${stats.totalOrders}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Successful Orders</span>
                <span class="info-value" style="color: #10b981;">${stats.successfulOrders} (${successRate}%)</span>
            </div>
            <div class="info-row">
                <span class="info-label">Top Selling Network</span>
                <span class="info-value">${stats.topSellingNetwork || 'N/A'}</span>
            </div>
        </div>

        <div style="text-align: center; margin: 25px 0;">
            <span class="status-badge status-success">Report Generated</span>
        </div>

        <div class="cta-container">
            <a href="${siteUrl}/dashboard/shop" class="cta-button">
                Open My Shop Dashboard
            </a>
        </div>
    `

    // Uses Brevo for automated reports to avoid hitting limits on transactional IPs
    return sendEmail({
        to: email,
        toName: firstName,
        subject: `Your ${reportType.charAt(0).toUpperCase() + reportType.slice(1)} Sales Report  -  ${shopName}`,
        htmlContent: generateProfessionalTemplate('Sales Report', content, '#3b82f6')
    })
}

/**
 * Send auto-upgrade failure email when wallet balance is insufficient.
 * Sent by the auto-upgrade cron when it disables auto-upgrade for a user.
 */
export async function sendAutoUpgradeFailedEmail(
    email: string,
    firstName: string,
    planLabel: string,
    currentBalance: number,
    requiredAmount: number
): Promise<EmailResult> {
    const siteUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.kingflexygh.com'
    const shortfall = (requiredAmount - currentBalance).toFixed(2)

    const content = `
        <h1 class="greeting">Auto-Upgrade Failed</h1>
        <p class="subtitle">Your wallet balance was insufficient to renew your membership</p>

        <p class="message-text">
            Hi ${firstName}, your scheduled auto-upgrade for <strong>${planLabel}</strong> could not be completed because your Flexy-Wallet balance was too low. Auto-upgrade has been temporarily disabled.
        </p>

        <div class="info-card">
            <div class="info-card-header">
                <div class="info-card-icon">!</div>
                <span class="info-card-title">Balance Summary</span>
            </div>
            <div class="info-row">
                <span class="info-label">Your Current Balance</span>
                <span class="info-value" style="color: #ef4444;">GHS ${currentBalance.toFixed(2)}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Required Amount</span>
                <span class="info-value">GHS ${requiredAmount.toFixed(2)}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Top Up Needed</span>
                <span class="info-value" style="color: #f59e0b; font-weight: bold;">GHS ${shortfall}</span>
            </div>
        </div>

        <p class="message-text">
            To restore your membership and re-enable auto-upgrade, top up your Flexy-Wallet with at least <strong>GHS ${shortfall}</strong> then head to the Upgrade page to re-enable auto-upgrade.
        </p>

        <div style="text-align: center; margin: 25px 0;">
            <span class="status-badge" style="background: #ef4444; color: #fff;">Auto-Upgrade Disabled</span>
        </div>

        <div class="cta-container">
            <a href="${siteUrl}/dashboard/wallet" class="cta-button" style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); color: #000 !important;">
                Top Up My Wallet
            </a>
        </div>
    `

    return sendEmail({
        to: email,
        toName: firstName,
        subject: `Action Required: Auto-Upgrade Failed  -  ${planLabel}`,
        htmlContent: generateProfessionalTemplate('Auto-Upgrade Failed', content, '#ef4444')
    })
}
