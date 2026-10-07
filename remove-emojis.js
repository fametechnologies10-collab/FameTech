const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'lib', 'email-service.ts');
let content = fs.readFileSync(filePath, 'utf8');

// List of exact targeted replacements to remove emojis and casual tone
const replacements = [
    // Welcome email
    ['<h1 class="greeting">Welcome, ${firstName}! 🎉</h1>', '<h1 class="greeting">Welcome, ${firstName}</h1>'],
    ['<p class="subtitle">Your premium data journey begins now</p>', '<p class="subtitle">Your account has been successfully created</p>'],
    ['<div class="info-card-icon">✨</div>', '<div class="info-card-icon">i</div>'],
    ['<span class="info-label">💰 Fund Wallet</span>', '<span class="info-label">Fund Wallet</span>'],
    ['<span class="info-label">📱 Buy Data</span>', '<span class="info-label">Buy Data</span>'],
    ['<span class="info-label">👥 Manage Customers</span>', '<span class="info-label">Manage Customers</span>'],
    ['<span class="info-label">📊 Real-time Tracking</span>', '<span class="info-label">Real-time Tracking</span>'],
    ['💡 <strong>Pro Tip:</strong>', '<strong>Note:</strong>'],
    ['subject: `Welcome to KiNG FLEXY GH, ${firstName}! 🎉`,', 'subject: `Welcome to KiNG FLEXY GH, ${firstName}`,'],

    // Order Success
    ['<h1 class="greeting">Order Placed Successfully! ✅</h1>', '<h1 class="greeting">Order Confirmation</h1>'],
    ['<div class="info-card-icon">📦</div>', '<div class="info-card-icon">i</div>'],
    
    // Order Failed
    ['<h1 class="greeting">Order Failed ❌</h1>', '<h1 class="greeting">Order Failed</h1>'],
    ['⚠️ <strong>Next Steps:</strong>', '<strong>Next Steps:</strong>'],

    // Wallet Topup
    ['<h1 class="greeting">Wallet Top-up Successful! 💰</h1>', '<h1 class="greeting">Wallet Top-up Successful</h1>'],
    ['<div class="info-card-icon">🧾</div>', '<div class="info-card-icon">i</div>'],
    ['subject: `Wallet Credited - GHS ${amount.toFixed(2)} ✅`,', 'subject: `Wallet Credited - GHS ${amount.toFixed(2)}`,'],

    // Payment Failed
    ['<h1 class="greeting">Payment Failed ❌</h1>', '<h1 class="greeting">Payment Failed</h1>'],
    ['💡 <strong>What to do:</strong>', '<strong>Action Required:</strong>'],

    // Complaint Resolved
    ['<h1 class="greeting">Complaint Update 🔔</h1>', '<h1 class="greeting">Complaint Update</h1>'],
    ['<div class="info-card-icon">📝</div>', '<div class="info-card-icon">i</div>'],

    // Admin New Complaint
    ['<h1 class="greeting">New Complaint Alert 🚨</h1>', '<h1 class="greeting">New Complaint Alert</h1>'],
    ['<div class="info-card-icon">👤</div>', '<div class="info-card-icon">i</div>'],
    ['<div class="info-card-icon">⚠️</div>', '<div class="info-card-icon">!</div>'],

    // Permanent Agent
    ['<h1 class="greeting">Permanent Agent Unlocked! 💎</h1>', '<h1 class="greeting">Permanent Agent Status Activated</h1>'],
    ['👑 You now have', 'You now have'],
    ['subject: `Welcome to the Lifetime Elite – Permanent Agent Status 👑`,', 'subject: `Permanent Agent Status Activated`,'],

    // Admin order alert
    ['headerTitle = isFailure ? \\\'Fulfillment Failed ❌\\\' : \\\'⚠️ Action Required\\\'', 'headerTitle = isFailure ? \\\'Fulfillment Failed\\\' : \\\'Action Required\\\''],
    ['Fulfillment Failed ❌', 'Fulfillment Failed'],
    ['⚠️ Action Required', 'Action Required'],

    // Bulk Alert
    ['hasErrors ? \\\'⚠️ Bulk Fulfillment Issues Detected\\\' : \\\'⏸️ Bulk Order — Manual Fulfillment Required\\\'', 'hasErrors ? \\\'Bulk Fulfillment Issues Detected\\\' : \\\'Bulk Order — Manual Fulfillment Required\\\''],
    ['❌ Failed', 'Failed'],
    ['⏸️ Skipped', 'Skipped'],
    ['<div class="info-card-icon">📊</div>', '<div class="info-card-icon">i</div>'],
    ['<div class="info-card-icon">📋</div>', '<div class="info-card-icon">i</div>'],

    // New User Alert
    ['<h1 class="greeting">New User Registration! 👤</h1>', '<h1 class="greeting">New User Registration</h1>'],
    ['subject: `👤 New User:', 'subject: `New User:'],

    // Shop Approved/Rejected
    ['<h1 class="greeting">Pricing Approved! ✅</h1>', '<h1 class="greeting">Pricing Approved</h1>'],
    ['subject: `✅ Your Shop Pricing is Approved', 'subject: `Your Shop Pricing is Approved'],
    
    ['<h1 class="greeting">Pricing Needs Revision ⚠️</h1>', '<h1 class="greeting">Pricing Needs Revision</h1>'],
    ['subject: `⚠️ Shop Pricing Needs Revision', 'subject: `Shop Pricing Needs Revision'],

    ['<h1 class="greeting">Your Shop is Approved! 🎉</h1>', '<h1 class="greeting">Your Shop is Approved</h1>'],
    ['<div class="info-card-icon">🚀</div>', '<div class="info-card-icon">i</div>'],
    ['subject: `🎉 Your Shop', 'subject: `Your Shop'],

    ['<h1 class="greeting">Shop Application — Action Required ❌</h1>', '<h1 class="greeting">Shop Application — Action Required</h1>'],
    ['subject: `❌ Shop Application', 'subject: `Shop Application'],

    // Withdrawal
    ['<h1 class="greeting">Payout Successful! 💰</h1>', '<h1 class="greeting">Payout Successful</h1>'],
    ['subject: `💰 Net Payout', 'subject: `Net Payout'],

    ['<h1 class="greeting">Withdrawal Request — Action Required ⚠️</h1>', '<h1 class="greeting">Withdrawal Request — Action Required</h1>'],
    ['subject: `⚠️ Withdrawal Request Rejected', 'subject: `Withdrawal Request Rejected'],

    // Admin shop alerts
    ['<h1 class="greeting">New Pricing Submission 🔔</h1>', '<h1 class="greeting">New Pricing Submission</h1>'],
    ['<div class="info-card-icon">🏷️</div>', '<div class="info-card-icon">i</div>'],
    ['subject: `🔔 New Pricing Submission', 'subject: `New Pricing Submission'],

    ['<h1 class="greeting">New Shop Registration 🏪</h1>', '<h1 class="greeting">New Shop Registration</h1>'],
    ['<div class="info-card-icon">🏪</div>', '<div class="info-card-icon">i</div>'],
    ['subject: `🏪 New Shop Registration', 'subject: `New Shop Registration'],

    ['Resubmission ♻️', 'Resubmission'],
    ['Withdrawal Request 💸', 'Withdrawal Request'],
    ['♻️ Resubmission', 'Resubmission'],
    ['💸 New Withdrawal', 'New Withdrawal'],
    
    ['<h1 class="greeting">New AFA Membership Application 🔔</h1>', '<h1 class="greeting">New AFA Membership Application</h1>'],
    ['subject: \\\'🔔 New AFA Membership Application', 'subject: \\\'New AFA Membership Application']
];

for (const [target, replacement] of replacements) {
    content = content.split(target).join(replacement);
}

fs.writeFileSync(filePath, content, 'utf8');
console.log('Done rewriting tone and removing emojis.');
