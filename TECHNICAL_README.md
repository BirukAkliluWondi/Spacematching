# SpaceMatch Addis: Technical Architecture & Code Guide

This document provides a comprehensive technical overview of the SpaceMatch Addis Telegram Bot architecture, state machine, data models, and API integrations.

---

## 1. High-Level Architecture

SpaceMatch Addis is built on **Next.js 16 (App Router)** with TypeScript, backed by **Supabase (PostgreSQL)**, and interfaced via the **Telegram Bot API v7.x** with **Verify.ET** for Ethiopian payment verification (Telebirr & CBE).

```
                        ┌───────────────────────────────┐
                        │ Public Telegram Channel       │
                        │ @roommatch_addis              │
                        └──────────────┬────────────────┘
                                       │
                      3 In-Line Action Buttons
              ┌────────────────────────┼────────────────────────┐
              │                        │                        │
              ▼                        ▼                        ▼
     /start req_<CODE>        /start post_profile     /start search_roommate
   (Contact Roommate)          (Post Seeker/Room)       (Matchmaker Search)
              │                        │                        │
              ▼                        ▼                        ▼
   ┌────────────────────────────────────────────────────────────────────┐
   │ Next.js App Router: /api/telegram/webhook                          │
   │                                                                    │
   │ 1. Session & State Machine (Supabase + In-Memory Fallback)        │
   │ 2. Fayda Verhoeff Dihedral (D5) Checksum & QR Scanner Validation   │
   │ 3. Anonymous Request Dispatcher                                    │
   │ 4. Mutual Escrow Payment Coordinator (Telebirr / CBE via Verify.ET)│
   │ 5. Channel Post Broadcast Engine (Single Post & Multi-Photo Albums)│
   │ 6. 24-Hour Post-Match Closure & Follow-up Daemon                   │
   └────────────────────────────────────────────────────────────────────┘
```

---

## 2. Key Modules & Technical Flow

### 2.1 Webhook Entrypoint (`src/app/api/telegram/webhook/route.ts`)
The webhook handles both `update.message` and `update.callback_query`, as well as channel management events:
- **Direct `/start`**: Strips out legacy bulky `ReplyKeyboardMarkup` custom keyboards, presenting an elegant in-line welcome card with two primary actions:
  - `[ 🔍 Search Roommate for Me Based on My Preferences ]`
  - `[ 📢 Post My Profile on the Channel ]`
- **Channel Deep-Links**:
  - `/start req_<CODE>`: Loads target listing `#RM...`, stores target context in session, gates through profile details + Fayda ID verification, and sends anonymous connection request.
  - `/start post_profile`: Prompts for Space Owner vs. Space Seeker branch.
  - `/start search_roommate`: Launches interactive preference wizard.

### 2.2 Dual-Branch Profile Creation & Channel Admin Review
When a user posts a profile (`/start post_profile`):
1. **Branch 1: "I have a space and I want a roommate"**
   - Collects: Total rent, space type, amenities ("what I have"), roommate's split share, subcity, lifestyle habits, and Fayda verification.
   - **Photo Upload Without Database Bloat**: Accepts 1 to 4 space photos sent by the user, storing Telegram `file_id` references temporarily in memory/session. Photos are never downloaded or stored in database tables, saving bandwidth and storage.
   - Formats a draft post headed by: `"Roommate available with a Room"`.
   - Routes to the **Channel Administrator Queue** for approval.
2. **Branch 2: "I want a roommate and we look for space together"**
   - Collects: Budget cap, gender, age, preferred subcities, traits, and Fayda verification.
   - Formats draft post headed by: `"Roommate Available"`.
   - Routes to the **Channel Administrator Queue** for approval.
3. **Channel Admin Approval**:
   - Administrators receive an interactive card in their DM with `[ ✅ Post to Channel 🚀 ]` and `[ ❌ Reject ]`.
   - Upon approval, the bot posts directly to `@roommatch_addis` (either as a photo album or formatted card) with the **3 Mandatory Action Buttons**.

### 2.3 The 3-Button Standard Under Channel Posts
Every post posted via the bot to the channel attaches:
```json
[
  [{ "text": "⚡ Contact with Roommate ↗️", "url": "https://t.me/Spacematchaddis_bot?start=req_<CODE>" }],
  [{ "text": "📢 Post My Profile ↗️", "url": "https://t.me/Spacematchaddis_bot?start=post_profile" }],
  [{ "text": "🔍 Search Roommate for Me ↗️", "url": "https://t.me/Spacematchaddis_bot?start=search_roommate" }]
]
```

### 2.4 Mutual Escrow Protocol & Real-Time Deposit Notifications
1. **Target Acceptance**: When target user taps `[ ✅ Accept ]`, both parties are transitioned to `pending_payment`.
2. **Escrow Guarantee**: The bot prompts both for **50 ETB** (Telebirr: `0987310978`, CBE: `1000054066094`) and displays:
   > *"After both parties pay, contact information will be revealed to both of you. If one party refuses to pay, your payment will be fully refunded."*
3. **Real-Time Notification**:
   - As soon as Party A pays and submits `/verify telebirr <REF>`, the bot verifies payment with Verify.ET and immediately notifies Party B:
     > *"🔔 Your potential roommate has completed their 50 ETB payment! Pay now to immediately unlock mutual contact details."*
4. **Pre-Reveal Legal Disclaimer**:
   - The moment both payments are confirmed, the bot displays:
     > *"⚠️ IMPORTANT DISCLAIMER: Our job is to connect verified roommates. SpaceMatch Addis does not take responsibility for anything that happens after roommates are matched up."*
5. **Simultaneous Contact Reveal**:
   - Atomically sends Party A's Name, Phone, and @username to Party B, and Party B's details to Party A.

### 2.5 In-Bot Matchmaker Search (`/start search_roommate`)
1. Collects search preferences: Subcities (grid), Gender preference, and Budget cap.
2. Queries active listings registered in Supabase that are published on the channel.
3. Renders interactive listing cards with `[ 🔓 Unlock Contact Information ]`.
4. When tapped:
   - If user is new/unverified, prompts them for their details and Fayda verification first (so the target roommate can see who is requesting).
   - Sends an anonymous connection request to the target.
   - If target agrees, enters the identical mutual 50 ETB payment protocol.

### 2.6 24-Hour Post-Match Check-in & Post Closure (`_____________CLOSED________`)
1. Upon mutual contact unlock, the timestamp is recorded in `matches.contacts_unlocked_at`.
2. 24 hours later, the bot checks in via DM with the listing owner:
   > *"Do you want to keep your profile posted on the channel?"*
   - `[ ❌ No, close it (Roommate match was successful!) ]`
   - `[ ✅ Keep it (I want more roommate matches) ]`
3. If the owner selects "No, close it":
   - The bot calls Telegram API `editMessageText` / `editMessageCaption` on the channel post ID.
   - Prepends `🔴 ━━━━━ _____CLOSED_____ ━━━━━ 🔴` at the very top.
   - Swaps inline buttons to inactive status buttons.
   - Updates database status to `closed`.

---

## 3. Data Models (Supabase PostgreSQL)

- **`profiles`**:
  - `id` (UUID): Primary key.
  - `telegram_id` (BIGINT): User's Telegram Chat ID.
  - `display_code` (TEXT): Unique public identifier (e.g. `RM205`).
  - `listing_category` (TEXT): `'space_available'` or `'seeker'`.
  - `space_type` (TEXT): Type of space (e.g. master bedroom, shared room).
  - `space_rent` (NUMERIC): Total monthly rent.
  - `space_share` (NUMERIC): Roommate's split share.
  - `space_amenities` (TEXT[]): List of amenities.
  - `space_photos` (TEXT[]): Telegram `file_id` array for temporary broadcast.
  - `channel_message_id` (BIGINT): Message ID of the channel post.
  - `status` (TEXT): `'active'`, `'pending_approval'`, `'closed'`, `'matched'`.
  - `kyc_status` (TEXT): `'verified'` (Fayda FAN validated).

- **`matches`**:
  - `id` (UUID): Match identifier.
  - `requester_id` (UUID): Seeker initiating the connection.
  - `target_id` (UUID): Profile owner receiving the request.
  - `requester_paid` (BOOLEAN): Payment status for requester.
  - `target_paid` (BOOLEAN): Payment status for target.
  - `requester_paid_at` (TIMESTAMPTZ): Requester payment timestamp.
  - `target_paid_at` (TIMESTAMPTZ): Target payment timestamp.
  - `contacts_unlocked_at` (TIMESTAMPTZ): Timestamp when mutual contacts were revealed.
  - `checkin_24h_sent` (BOOLEAN): Flag indicating if 24h follow-up was dispatched.
  - `status` (TEXT): `'pending_acceptance'`, `'pending_payment'`, `'matched'`, `'declined'`.
