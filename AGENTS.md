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
