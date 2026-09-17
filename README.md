# SpaceMatch Addis - Room Matching Telegram Mini App & Bot Ecosystem

SpaceMatch Addis is a peer-to-peer room rental platform connecting renters and homeowners in Addis Ababa, Ethiopia through a Telegram Mini App storefront, interactive Telegram Bot workflows, and automated channel broadcasts.

## Features

- **Telegram Mini App Storefront**: Responsive storefront UI featuring category filters, search, wishlist saving, and desktop responsive container.
- **Zero-Trust Privacy & Contact Unlocking**: Homeowner phone number, Telegram handle, and exact location remain locked until verified payment.
- **Telegram Bot Automation**: Step-by-step room listing submission for homeowners, admin approval/rejection workflows, and automated channel posts with inline buttons (`Order in Bot`).
- **Telebirr & verify.et Verification**: Automated transaction reference verification for instant contact unlocking.

## Tech Stack

- **Framework**: Next.js 16 (App Router, React 19)
- **Database & Storage**: Supabase (PostgreSQL, Realtime, Storage)
- **Styling**: Tailwind CSS, Lucide Icons, Framer Motion
- **Bot Integration**: Telegram Bot API (Webhooks, Inline Keyboards, Deep Links)

## Getting Started

1. Clone the repository and install dependencies:
   ```bash
   npm install
   ```

2. Configure environment variables in `.env.local`:
   ```env
   NEXT_PUBLIC_SUPABASE_URL="your-supabase-url"
   NEXT_PUBLIC_SUPABASE_ANON_KEY="your-anon-key"
   SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"
   TELEGRAM_BOT_TOKEN="your-telegram-bot-token"
   NEXT_PUBLIC_BOT_USERNAME="Spacematchaddis_bot"
   NEXT_PUBLIC_TELEGRAM_APP_NAME="roommatch"
   TELEGRAM_CHANNEL_ID="@roommatch_addis"
   TELEBIRR_RECEIVER_PHONE="0987310978"
   VERIFY_ET_API_KEY="your-verify-et-key"
   ```

3. Run the development server:
   ```bash
   npm run dev
   ```

4. Open [http://localhost:3000](http://localhost:3000) in your browser.
