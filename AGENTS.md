<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->


# Identity Verification & Contact Safety Invariants

## 1. Zero-Storage Policy for User Verification Documents
- Never persist raw identity documents (e.g., Fayda ID card photos, passports, or receipts) to Supabase Storage, S3 buckets, or local disk directories.
- Stream file bytes directly from Telegram/external APIs into in-memory `Buffer` instances in volatile process RAM.
- Extract required fields (FAN, full name, DOB, gender) and cryptographically verify detached digital signatures in-memory using `fayda-decoder` and `zxing-wasm`.
- Allow the in-memory buffer to be garbage-collected immediately following verification.

## 2. Deprecation of Typed FAN Inputs
- Never prompt users to manually type 12- or 16-digit National ID numbers.
- If a user inputs text or numbers during an ID verification step, reject it immediately with bilingual guidance (Amharic & English) requiring a photo upload showing the official QR code.

## 3. Contact Dossier Sanitization
- Never leak raw admin IDs, concierge placeholders (e.g., `admin:123456`, `admin_123456`), or invalid Telegram handles into match notification dossiers.
- Validate Telegram handles against RFC rules (`^[a-zA-Z0-9_]{5,32}$`).
- For synthetic, concierge, or admin listings, automatically route contact details to the verified SpaceMatch Coordinator (`@WWEHID`).

## 4. Multi-Tier Resilient Fayda Identity Verification (Zero Biometric / Zero Admin Friction)
- Fayda National ID verification is 100% automated via a multi-tier in-memory verification engine:
  - **Strategy A:** Official NIDP V4 JWS RS256 detached signature parsing (`fayda-decoder`).
  - **Strategy B:** Universal MOSIP Claim 169 CBOR / CWT / COSE_Sign1 and RFC 9285 Base45 payload extraction (`fayda-qr-decoder.ts`).
  - **Strategy C (OCR Fallback):** High-speed in-memory OCR extraction of human-readable FIN/FAN numbers directly from the physical card text (`extractFaydaCardViaOcr`), validating Verhoeff check digits when QR codes suffer from camera blur or Telegram photo compression.
- Never require secondary selfies, video notes, or facial biometrics to compare against low-resolution ID thumbnails.
- Never place Fayda verification into a manual admin approval queue or waiting status; immediately persist verified status to Supabase upon successful verification.

## 5. Simultaneous Bilingual Parity & Native Telegram Visual Styling
- All user-facing bot prompts, questions, options, error messages, and buttons must present both English and Amharic simultaneously (`English Text / የአማርኛ ጽሁፍ`).
- Detailed content, descriptions, and user inputs must be framed using Telegram's native `<blockquote>...</blockquote>` container styling (producing the pink/tinted highlighted card with vertical accent bar and quote mark).
- Channel post layouts must strictly adhere to the unified visual hierarchy:
  - Header: `<b>SpaceMatch Addis / ስፔስማች አዲስ</b>` & `<b>#DISPLAY_CODE</b>`
  - Preferences: `<b>ROOMMATE PREFERENCES / የቤት አጋር ምርጫ</b>`
  - Details: `<b>DETAILS / ዝርዝር</b>` wrapped in `<blockquote>`
  - About: `<b>ABOUT ME / ስለ እኔ</b>` with user bio wrapped in `<blockquote>`

## 6. Channel Post Action Buttons & Admin Concierge Invariant
- Channel posts must strictly maintain only 2 inline action buttons:
  1. `Connect with this roommate / ከዚህ አጋር ጋር ተገናኝ >`
  2. `Search Roommate for Me / የቤት አጋር ፈልግልኝ >`
- The "Post My Profile" button is deprecated and removed from channel posts to prevent self-service spam and route users directly to the verified coordinator.
- All channel posts must feature the bilingual footer note directing users to the SpaceMatch Coordinator:
  `📢 To post your profile on the channel, contact admin: @WWEHID / መረጃዎን ቻናሉ ላይ ለመለጠፍ አድሚን @WWEHID ያነጋግሩ`

## 7. Subscription Duration & Pricing Invariant
- The SpaceMatch All-Access Membership Pass is strictly **100 ETB for 3 Months (90 days)**.
- System threshold for active pass verification in the `orders` table is $\ge 100\text{ ETB}$, granting full unmasked contact reveals and search access for 90 days from transaction date.

## 8. Mandatory 100 ETB Membership Pass Gate for Connection Requests
- Under no circumstances may a user send, queue, or deliver a roommate connection request or match notification without an active 100 ETB 3-Month Pass (`getUserMembershipStatus(chatId).isActive === true`).
- Any attempt to initiate a match request (whether via channel deep link `/start req_...`, the matchmaker wizard, or returning user preview card) must immediately present `sendMembershipPaywallCard('connect_request', ...)` if the requesting user does not hold an active $\ge 100\text{ ETB}$ order within the 90-day window.
- `executeDirectMatchRequest` and `finalizeFaydaVerification` must strictly enforce this check as a defense-in-depth gate, preventing any unauthorized match insertion or notification delivery.

## 9. Automated In-Memory Payment Receipt Screenshot Extraction
- When users submit payment receipts as screenshots/photos, never prompt them to manually re-type reference codes.
- Use the high-speed in-memory dual-engine pipeline (`extractTransactionReferenceFromImage` via `zxing-wasm` and warm `tesseract.js`) to extract the transaction reference code directly in RAM.
- Automatically verify with Verify.ET and activate the 100 ETB 3-Month Pass with zero extra taps.
- In-memory Buffer processing only (strictly enforcing Invariant 1: Zero-Storage Policy).



