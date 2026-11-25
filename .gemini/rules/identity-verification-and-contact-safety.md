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
