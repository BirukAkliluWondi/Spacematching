# 🏠 SpaceMatch Addis - Room Matching Telegram Ecosystem

SpaceMatch Addis is a comprehensive room rental & roommate matching platform tailored for Addis Ababa, Ethiopia. It connects homeowners, room seekers, and renters through an integrated **Telegram Mini App**, interactive **Telegram Bot step workflows**, and automated **Telegram Channel broadcasts**.

---

## 🚀 Features & Architecture

* **Telegram Mini App Storefront**: Dynamic Web App featuring sub-city filtering, price filters, category tabs (Shared Rooms, Entire Houses, Commercial, Warehouses), wishlist management, and responsive UI.
* **Touchable Step-by-Step Telegram Bot Workflows**:
  * **Homeowner Listing Flow**: `/start` ➔ `/property_type` ➔ `/my_gender` (2x2 touchable grid) ➔ `/my_age` ➔ `/upload_listing` (Forwarded to admins for approval).
  * **Seeker Matching Flow**: `/start` ➔ `/seeker_property_type` ➔ `/seeker_gender` (2x2 touchable grid) ➔ `/seeker_age` ➔ `/upload_seeker_profile`.
* **Admin Governance & Review System**: Admins review incoming space listings and seeker profiles with inline `✅ Approve & Post` and `❌ Reject` controls directly within Telegram.
* **Channel Integration & Interactive Post Buttons**: Automatic broadcasting of approved spaces to the channel with inline buttons:
  * `🏠 I Have a Space` (Direct deep link to homeowner flow)
  * `🔍 I Need a Space` (Direct deep link to seeker flow)
  * `🛒 በቦት እዘዝ (Order in Bot)` (Checkout contact unlock card in Bot DM)
  * `🔍 በሚኒ አፕ ተመልከት` (Direct open in Telegram Mini App)
* **Contact Unlocking & Telebirr Payment Verification**: Telebirr transaction reference (Txn Ref / FT...) verification via `verify.et` API for instant contact detail unlocking.
* **Fayda National ID Verification**: Integrated identity verification for trusted user badges.
* **Security & Group Protection**: Built-in auto-leave protection against unauthorized group or channel additions.

---

## 🛠️ Prerequisites

* **Node.js**: `v18+` or `v20+`
* **Package Manager**: `npm`
* **Database**: [Supabase](https://supabase.com) (PostgreSQL with Realtime & Storage enabled)
* **Telegram Bot**: Created via [@BotFather](https://t.me/BotFather) on Telegram

---

## ⚙️ Environment Configuration

Create a `.env.local` file in the root directory:

```env
# Supabase Configuration
NEXT_PUBLIC_SUPABASE_URL="https://your-supabase-project.supabase.co"
NEXT_PUBLIC_SUPABASE_ANON_KEY="your-supabase-anon-key"
SUPABASE_SERVICE_ROLE_KEY="your-supabase-service-role-key"

# Telegram Bot Credentials
TELEGRAM_BOT_TOKEN="your-telegram-bot-token"
NEXT_PUBLIC_BOT_USERNAME="@Spacematchaddis_bot"
NEXT_PUBLIC_TELEGRAM_APP_NAME="roommatch"
TELEGRAM_CHANNEL_ID="@roommatch_addis"

# Payment & Verification Settings
TELEBIRR_RECEIVER_PHONE="0987310978"
VERIFY_ET_API_KEY="your-verify-et-api-key"

# Application Base URL
NEXT_PUBLIC_APP_URL="https://your-domain.vercel.app"
```

---

## 📖 How to Run the System

### 1. Install Dependencies
```bash
npm install
```

### 2. Start the Local Development Server
```bash
npm run dev
```
The server will start listening at `http://localhost:3000`.

---

### 3. Configure Telegram Bot Webhook & Menu Commands

#### A. Expose Your Local Server (For Local Testing)
Use a tunneling tool like `ngrok` to expose port `3000`:
```bash
npx ngrok http 3000
```
Copy the generated HTTPS forwarding URL (e.g., `https://xxxx.ngrok-free.app`).

#### B. Set Telegram Webhook
Run the webhook script with your bot token and public URL:
```bash
TELEGRAM_BOT_TOKEN="<YOUR_BOT_TOKEN>" NEXT_PUBLIC_APP_URL="https://xxxx.ngrok-free.app" node scripts/set_webhook.js
```

#### C. Register Bot Commands Menu
Register slash commands (`/start`, `/property_type`, `/my_gender`, `/my_age`, `/upload_listing`, `/seeker_property_type`, `/seeker_gender`, `/seeker_age`, `/upload_seeker_profile`, `/match`, `/browse`, `/myorders`, `/verify`, `/help`, `/support`, `/admin`, `/cancel`, `/stats`):
```bash
TELEGRAM_BOT_TOKEN="<YOUR_BOT_TOKEN>" node scripts/register_bot_commands.js
```

#### D. Update Bot Profile & Mini App Menu Button
```bash
TELEGRAM_BOT_TOKEN="<YOUR_BOT_TOKEN>" node scripts/restore_bot_profile.js
TELEGRAM_BOT_TOKEN="<YOUR_BOT_TOKEN>" NEXT_PUBLIC_APP_URL="https://xxxx.ngrok-free.app" node scripts/update_menu_button.js
```

---

## 📱 Bot Commands Reference

| Command | Description |
| :--- | :--- |
| `/start` | Welcome screen & role selection (`I Have a Space` / `I Need a Space`) |
| `/property_type` | Homeowner Step 2: Select property type |
| `/my_gender` | Homeowner Step 3: Select gender & roommate preference (2x2 Grid) |
| `/my_age` | Homeowner Step 4: Select age bracket |
| `/upload_listing` | Homeowner Step 5: Send photos & listing details |
| `/seeker_property_type` | Seeker Step 1: Select space type requested |
| `/seeker_gender` | Seeker Step 2: Select seeker gender & roommate preference |
| `/seeker_age` | Seeker Step 3: Select seeker age bracket |
| `/upload_seeker_profile` | Seeker Step 4: Send seeker preferences description |
| `/match` | Search & match available rooms by sub-city and budget |
| `/browse` | Open the SpaceMatch Telegram Mini App |
| `/myorders` | View unlocked contact details for purchased rooms |
| `/verify` | Initiate Fayda National ID verification |
| `/admin` | [Admin] Channel manager & listing control panel |
| `/stats` | [Admin] Platform statistics dashboard |
| `/cancel` | Cancel active flow & return to start |

---

## 🚢 Production Deployment (Vercel)

1. Push your repository to GitHub:
   ```bash
   git add .
   git commit -m "feat: complete SpaceMatch Addis system setup"
   git push origin main
   ```

2. Import project into [Vercel](https://vercel.com).

3. Configure all environment variables in Vercel (**Settings ➔ Environment Variables**):
   * `TELEGRAM_BOT_TOKEN`
   * `NEXT_PUBLIC_SUPABASE_URL`
   * `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   * `SUPABASE_SERVICE_ROLE_KEY`
   * `NEXT_PUBLIC_BOT_USERNAME`
   * `NEXT_PUBLIC_APP_URL` (Set to your Vercel deployment URL, e.g., `https://spacematch-addis.vercel.app`)

4. Point your Telegram Bot Webhook to your live production endpoint:
   ```bash
   TELEGRAM_BOT_TOKEN="<YOUR_BOT_TOKEN>" NEXT_PUBLIC_APP_URL="https://spacematch-addis.vercel.app" node scripts/set_webhook.js
   ```

---

## 🔒 Security Best Practices

* **Keep API Tokens Secret**: Never commit plain-text Telegram Bot Tokens or Supabase Service Role keys to GitHub. Use environment variables.
* **Group Restrictions**: In Telegram `@BotFather` settings:
  * `/mybots` ➔ Select `@Spacematchaddis_bot` ➔ **Bot Settings** ➔ **Allow Groups?** ➔ **Turn groups off**.
