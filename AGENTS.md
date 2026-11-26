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
- Always deliver a visible, persistent confirmation message showing whether Fayda verification succeeded or failed before advancing to subsequent paywall or questionnaire cards (never silently overwrite the Fayda upload prompt card in-place with a payment paywall card).

## 5. Simultaneous Bilingual Parity & Native Telegram Visual Styling
- All user-facing bot prompts, questions, options, error messages, and buttons must present both English and Amharic simultaneously (`English Text / የአማርኛ ጽሁፍ`).
- Detailed content, descriptions, and user inputs must be framed using Telegram's native `<blockquote>...</blockquote>` container styling (producing the pink/tinted highlighted card with vertical accent bar and quote mark).
- Channel post layouts must strictly adhere to the unified visual hierarchy:
  - Header: `<b>SpaceMatch Addis / ስፔስማች አዲስ</b>` & `<b>#DISPLAY_CODE</b>`
  - Preferences: `<b>ROOMMATE PREFERENCES / የቤት አጋር ምርጫ</b>`
  - Details: `<b>DETAILS / ዝርዝር</b>` wrapped in `<blockquote>`
  - About: `<b>ABOUT ME / ስለ እኔ</b>` with user bio wrapped in `<blockquote>`

## 6. Channel Post Layout, Action Buttons & Admin Concierge Invariant
- Channel posts must maintain 3 inline action buttons:
  1. `Connect with this roommate / ከዚህ አጋር ጋር ተገናኝ >`
  2. `Search Roommate for Me / የቤት አጋር ፈልግልኝ >`
  3. `Post My Profile / መረጃዬን ልለጥፍ >` (`?start=post_profile`)
- Under `Post My Profile`, present 2 options: **Need Roommate (Look Together)** (full Seeker workflow -> admin review) and **Have a Room & Need Roommate** (zero questionnaire prompts; immediately present Admin Wahid `@WWEHID` / `https://t.me/WWEHID` direct contact card).
- Public channel posts must omit candidate Age (revealing Age only inside connect/match requests), place `ABOUT ME / ስለ እኔ` between `WHAT I'M LOOKING FOR` and `ROOMMATE PREFERENCES`, and include user-submitted `House Rules`.
- Never display developer credit (`@birukadiyee`) inside user-facing bot menus, image footers, or error messages.
- Public channel posts and the `Post My Profile` branch selector must NOT tell Seekers to contact `@WWEHID` directly; channel posts must instead point readers to tap the **`Post My Profile / መረጃዬን ልለጥፍ >`** button below:
  `📢 Want to post your profile? Tap "Post My Profile" below! / መረጃዎን ለመለጠፍ ከታች "መረጃዬን ልለጥፍ" የሚለውን ይጫኑ!`
- Direct contact to Admin Wahid (`@WWEHID` / `https://t.me/WWEHID`, instructing *"Contact with the admin to post your profile"*) is displayed inside the bot **only** after clicking **Have a Room & Need Roommate**.

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

## 10. Verify.ET & Payment Anti-Replay Safety
- `extractTransactionReference()` must return `''` when no bank URL or Telebirr/CBE/BoA/Dashen reference token matches; never fall back to returning raw prose or OCR text dumps as a transaction code.
- Always enforce explicit minimum amount (`paidAmount >= expectedFee`); treat missing, zero, or non-numeric `amount` values as verification failure (`INSUFFICIENT_AMOUNT`), never defaulting to `expectedFee`.
- Check duplicate `transaction_reference` against `orders` (`payment_status = 'completed'`) **before** calling Verify.ET, and always check `error` on `orders.insert()` / `orders.update()`. Never grant pass activation, listing submission, or contact reveals if a DB write fails (e.g., `23505`).
- On OCR-extracted Telebirr/alphanumeric references where initial Verify.ET lookup returns `NOT_FOUND` / `VERIFICATION_FAILED`, retry bounded `O`↔`0` and `I`↔`1` ambiguity variants and enforce `orders` anti-replay on the resolved canonical `transactionNumber` returned by Verify.ET.
- Check redeemed payment references across ALL payment endpoints (`/verify`, `awaiting_payment_for_membership`, `unlock_pay_`, `/api/orders/verify`) using canonical uppercase matching **plus** bank receipt URL suffix patterns (`%/${canon}`, `%=${canon}`), never `.maybeSingle()` without inspecting `{ error }` (always fail closed on DB errors), and store only canonical references into `orders.transaction_reference`.
- Compute an in-memory `SHA-256` fingerprint of uploaded payment receipt images (never persisting raw bytes) and record both canonical reference and image `SHA-256` fingerprint **strictly after** Verify.ET confirmation and completed `orders` DB write succeed — failed verification attempts must never block retries, while previously redeemed codes and screenshots are uniformly blocked across all accounts.

## 11. Fayda Physical FIN vs. Signature & OCR Safety
- Cryptographic signature verification (`verifySignature` in `fayda-decoder` and `/api/user/verify-fayda-qr`) must never be bypassed when a signature is present and fails verification.
- Genuine Ethiopian 12-digit physical card FINs (e.g., `4870-2189-4386`) do not always satisfy Verhoeff checksums (`remainder = 9`); Strategy C OCR fallback must allow valid 12-digit physical FINs **only** when specific Fayda card markers are present, receipt keywords are absent, and 12-digit Ethiopian phone numbers (`2519...`/`2517...`) are excluded.
- Always normalize image orientation (`.rotate()`) before Sharp crops or OCR on mobile camera uploads.

## 12. Admin Auth, Telegram API & Vercel Serverless Invariants
- Protect `/admin`, `/api/admin/*`, `/api/orders/*`, and `/api/user/*` with authenticated Admin session cookies / Telegram `initData` HMAC validation; never trust unauthenticated `telegram_id` payloads or expose PII publicly.
- Never attach `tel:` URIs to Telegram inline keyboard buttons (`BUTTON_URL_INVALID` fails message delivery), and exempt Telegram webhook routes from shared-IP low rate limits in `middleware.ts`.
- Await critical state persistence (`saveSession(..., true)`) before returning HTTP responses on Vercel serverless, list `tesseract.js` in `serverExternalPackages`, and pass `cachePath: '/tmp'` to `tesseract.js` workers.

## 13. Supabase Live Schema & Distributed Serverless Safety
- Strictly use valid PostgreSQL enum values (`profile_status`: `'onboarding'|'active'|'paused'|'matched'`; `item_status`: `'draft'|'pending_approval'|'approved'|'rejected'|'archived'`; `match_payment_status`: `'unpaid'|'one_paid'|'both_paid'`; `space_status`: `'published'|'rented'|'archived'`; `user_role`: `'renter'|'admin'`) and verified columns only; always inspect `{ error }` on mutations and fail closed.
- Store and query `transaction_reference` in canonical uppercase form, and never cache negative `getUserMembershipStatus` (`isActive: false`) or negative `isUserFaydaVerified` (`isVerified: false`) results.
- Back webhook update deduplication (`deduplicateUpdate`) and critical action/payment locks (`acquireActionLock`) with persistent Supabase state rather than process-local memory alone, and never clear/overwrite another user's `bot_sessions` row during admin mutations.

## 14. Vercel Serverless OCR & Asset Tracing Invariant
- Trace `./node_modules/tesseract.js-core/**/*` (including `*-lstm*` / `*-relaxedsimd*` `.js` and `.wasm` files), `tesseract.js/src/**/*`, `wasm-feature-detect`, `bmp-js`, `eng.traineddata`, `zxing_reader.wasm`, and `public/images/fayda_sample_back.png` in `next.config.ts` and verify compiled `.nft.json` bundles after build.
- Always pass an `errorHandler` and initialization timeout to `tesseract.js` `createWorker()`, and set `cacheMethod: 'none', gzip: false` when loading bundled `eng.traineddata` from `process.cwd()` (never copy into `/tmp` redundantly).
- Declare `export const maxDuration = 60;` explicitly inside every long-running `route.ts` file (re-exporting `{ POST }` does NOT propagate Next.js segment config), and use `src/proxy.ts` rather than deprecated `src/middleware.ts` on Next.js 16+.
- In Sharp pipelines, always call `.rotate()` *before* reading `.metadata()` dimensions on mobile uploads, never hardcode secret fallback keys in source files, and guard all inline keyboard `callback_data` payloads strictly within Telegram's 64-byte limit while escaping HTML with entity-safe `truncateTelegramHtml`.

## 15. Authorization, Double-Blind Mutual Consent & Anti-Spoof Validation
- Enforce explicit admin/owner checks on every admin publishing, closing, accept/decline, and user-auth handler—synthetic concierge targets (`telegram_id <= 0`) require verified Super Admin authorization for `match_accept`, `/remove_admin` must purge `pending_admin_usernames`, and `my_chat_member` or `/api/auth/telegram` must never auto-promote admins from external channels or mutable `@username` handles.
- Require Fayda verification, active 100 ETB 3-Month Pass, gender compatibility, open listing status, and mutual target/host consent across both Roommate Seekers and Space Listings (`?start=req_...` / `?start=order_...`).
- Never accept unauthenticated arbitrary 12-digit `regex_fayda` QR codes, empty `:SIGN:` stubs, or unsupported V4 raw maps without signature validation, and never overwrite `users.first_name`/`profiles.full_name` with OCR card-back field labels.

## 16. Payment Verification, Receipt Routing & Mini App Parity
- In `receipt-extractor.ts` and `verify-et.ts`, detect explicit bank keywords (`abyssinia`, `boa`, `dashen`, `telebirr`, `cbe`) **before** generic `FT...` prefix heuristics, and try `['cbe', 'boa']` for unattributed `FT...` codes.
- Reject non-transaction matches (`Date...`, month/status words, receiver settlement account numbers), persist & check replay on both normalized user references and Verify.ET's canonical `transactionNumber`, and always re-verify requester active 100 ETB pass before revealing contacts on `pending_payment` matches.
- Keep payment, Fayda crypto-signature (`verifySignature` trusted for RS256 V4 16-digit FANs; reject unsigned `:A:` / unverified `COSE_Sign1` / JSON / plain-text QRs), gender completeness (fail closed when `profiles.gender` is `null`), and Double-Blind mutual consent strictly consistent between Telegram bot handlers and Mini App `/api/orders/*` endpoints.





