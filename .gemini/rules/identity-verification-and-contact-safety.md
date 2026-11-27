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
- For synthetic, concierge, or admin listings, automatically route contact details to the verified SpaceMatch Coordinator (`@spacematchaddissupport`).

## 10. Verify.ET & Payment Anti-Replay Safety
- `extractTransactionReference()` must return `''` when no bank URL or Telebirr/CBE/BoA/Dashen reference token matches; never fall back to returning raw prose or OCR text dumps as a transaction code.
- Always enforce explicit minimum amount (`paidAmount >= expectedFee`); treat missing, zero, or non-numeric `amount` values as verification failure (`INSUFFICIENT_AMOUNT`), never defaulting to `expectedFee`.
- Check duplicate `transaction_reference` against `orders` (`payment_status = 'completed'`) **before** calling Verify.ET, and always check `error` on `orders.insert()` / `orders.update()`. Never grant pass activation, listing submission, or contact reveals if a DB write fails (e.g., `23505`).

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

