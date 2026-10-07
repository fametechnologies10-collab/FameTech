# GHData - Mobile Data & Airtime Platform

A modern e-commerce platform for selling mobile data and airtime in Ghana, built with Next.js 15, Tailwind CSS, and Supabase.

## Features

- **User Dashboard**: Buy data, top-up wallet, view history, manage profile.
- **Admin Panel**: Manage users, orders, packages, complaints, finances, and system settings.
- **Wallet System**: Integrated wallet with Paystack top-ups and manual fulfillment.
- **Auto Fulfillment**: Integration with MTN and CodeCraft (Telecel/AT) APIs (simulated/ready for keys).
- **Agent System**: AFA (Authorized Field Agent) application and tracking.
- **Notifications**: Real-time updates for orders and payments.

## Tech Stack

- **Framework**: Next.js 15 (App Router)
- **Database**: Supabase (PostgreSQL)
- **Auth**: Supabase Auth
- **Styling**: Tailwind CSS + shadcn/ui
- **Icons**: Lucide React
- **Payments**: Paystack

## Getting Started

### 1. Environment Setup

Copy `.env.local` and fill in your API keys:

```bash
cp .env.local .env
```

You will need keys for:

- Supabase (URL, Anon Key, Service Key)
- Paystack (Secret/Public Keys)
- MTN/CodeCraft/Moolre (if using actual APIs)

### 2. Database Setup

1. Create a new Supabase project.
2. Go to the SQL Editor in Supabase.
3. Copy the content of `supabase/schema.sql` and run it to create tables and policies.
4. Enable Auth providers (Email/Password) in Supabase Authentication settings.

### 3. Install Dependencies

```bash
npm install
```

### 4. Run Development Server

```bash
npm run dev
```

Visit `http://localhost:3000` to see the app.

## Admin Access

By default, new users are standard users. To make yourself an admin:

1. Sign up on the platform.
2. Go to your Supabase `users` table.
3. Find your user record and change the `role` from `user` to `admin`.
4. Refresh the page to access the Admin Dashboard.

## Cron Jobs

All 14 scheduled jobs are executed by [cron-job.org](https://cron-job.org) — **not** Vercel's built-in cron scheduler. Each job calls a `GET` endpoint in `app/api/cron/` and is secured via the `Authorization: Bearer <CRON_SECRET>` header.

### Setting up the CRON_SECRET

The `CRON_SECRET` is a password that you create to ensure only your authorized cron jobs can trigger the API.

1. **Generate a Secret**: Use a random string generator or just type a long, complex string (e.g., `48392cf3-5d6e-4b4b-9b4b-1234567890ab`).
2. **Add to Vercel**:
    - Go to your **Vercel Dashboard**.
    - Select your project (**GHData**).
    - Go to **Settings** > **Environment Variables**.
    - Add a new variable:
        - **Key**: `CRON_SECRET`
        - **Value**: `<your-generated-secret>`
    - Click **Save**.
    - *Note: You may need to redeploy your app for the change to take effect.*
3. **Local Testing**: Add `CRON_SECRET=<your-secret>` to your `.env.local` file if you want to test the cron routes locally using tools like Postman.

### Active Endpoints & Schedules

| Endpoint | Schedule | Purpose |
| :--- | :--- | :--- |
| `verify-pending-payments` | Every 5 min | Checks pending Paystack wallet payments |
| `refulfill-pending-orders` | Every 5 min | Auto-retries pending data orders via active supplier |
| `sync-codecraft-status` | Every 5 min | Polls CodeCraft API to update processing order statuses (regular & bigtime) |
| `sync-xpress-status` | Every 5 min | Polls Xpress API to update processing order statuses |
| `sync-moolre-withdrawals` | Every 10 min | Polls Moolre API to settle pending withdrawals |
| `auto-complete-data` | Every 10 min | Auto-completes stale data package orders |
| `fulfill-pending-rc-vouchers` | Every 10 min | Auto-fulfills pending RC orders and retries delivery |
| `release-rc-reservations` | Every 15 min | Frees expired Results Checker reservations |
| `agent-renewal-reminder` | Daily 07:00 UTC | Sends SMS reminders to expiring agents |
| `delete-old-notifications` | Daily 00:00 UTC | Purges notifications older than 30 days |
| `delete-old-orders` | Weekly Sun 01:00 UTC | Purges orders older than 90 days |
| `delete-old-complaints` | Weekly Sun 01:00 UTC | Purges complaints older than 30 days |
| `shop-sales-report?type=daily` | Daily 23:59 UTC | Emails daily sales recap to shop owners |
| `shop-sales-report?type=weekly` | Weekly Sun 23:59 UTC | Emails weekly sales recap to shop owners |
| `shop-sales-report?type=monthly` | Monthly 1st 00:00 UTC | Emails monthly sales recap to shop owners |

### Detailed Setup Guide for cron-job.org

After creating your account on [cron-job.org](https://cron-job.org), follow these steps for **each** of the 15 jobs:

1. **Click "Create Cron Job"**: Look for the big blue button on your dashboard.
2. **Title**: Give it a clear name (e.g., `GHData: Sync Moolre Withdrawals`).
3. **URL**: Enter the full production URL for the specific endpoint:
    - Example: `https://www.kingflexygh.com/api/cron/sync-moolre-withdrawals`
    - *Make sure you use `https://` and change the last part of the URL for each job.*
4. **Schedule**: Select "User-defined" and set the interval as specified in the table above:
    - For "Every 10 min", set minutes to `*/10`.
    - For "Daily 07:00 UTC", set hour to `7` and minute to `0`.
5. **Request Method**: Set this to **GET**.
6. **Advanced Settings (IMPORTANT)**:
    - Click on the **"HTTP Headers"** tab.
    - Click **"Add header"**.
    - **Key**: `Authorization`
    - **Value**: `Bearer <YOUR_CRON_SECRET>`
    - *(Replace `<YOUR_CRON_SECRET>` with the actual secret you set in your Vercel Environment Variables).*
7. **Failure Notifications**: Under the "Notifications" tab, ensure "Send notification on failure" is checked so you know if a job breaks.
8. **Save & Test**:
    - Click **"Create"**.
    - Once created, click the **"Play" icon (Execute now)** next to the job in your dashboard.
    - Check the "History" tab for that job. It should show a **Status 200 (OK)**. If it shows 401, your secret or header is wrong.
