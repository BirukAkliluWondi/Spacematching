# Walkthrough: Two-Step Biometric Ownership Verification (Fayda QR Face vs. Live Selfie / Video Note)

## Overview
SpaceMatch Addis cryptographically authenticates physical Ethiopian Fayda National IDs by decoding the Version 4 QR payload, checking NIDP's detached RS256 signature, and extracting legal citizen records. To confirm that the user uploading an authentic card is its legitimate owner without costly SMS gateways or government e-KYC private contracts, we implemented an in-memory, zero-storage two-step biometric ownership verification system:

1. **Step 1/2**: User uploads the Fayda ID card photo. The system decodes the QR code with `{ includeFace: true }` and extracts the government-signed WebP facial thumbnail into volatile RAM. If the QR code lacks a face thumbnail, it rejects early with clear bilingual guidance at Step 1.
2. **Step 2/2**: The bot prompts the user for a quick front-facing selfie photo or round Telegram video note.
3. **In-Memory Biometric Match**: Compares the live face against the reference thumbnail using translation-tolerant spatial correlation (Peak NCC, aligned SSIM, true Sobel contour gradient vector cosine similarity, and luminance histogram intersection) entirely in volatile RAM with EXIF auto-rotation.
4. **Automated Verification**: Enforces the approved $\ge 65\%$ similarity threshold. Users meeting $\ge 65\%$ are persisted to Supabase and issued the Verified Resident Dossier Card. Below 65%, helpful bilingual lighting and angle guidance is provided.
5. **Zero-Storage Invariant**: Neither the raw ID photo nor the selfie / video note is ever written to disk or uploaded to remote storage buckets. Temporary facial reference buffers are wiped from session RAM upon verification.

---

## Changes Made & Hardening Fixes

### 1. Fayda QR Face Extraction ([`src/lib/bot/fayda-photo-verifier.ts`](file:///c:/Users/mrxan/OneDrive/Desktop/Spacematching-this/src/lib/bot/fayda-photo-verifier.ts))
- Updated `decodeImage` calls to `{ includeFace: true }`.
- Added `faceBase64?: string` to `FaydaSuccessResult`.
- Extracted and populated `decodeResult.fields.face?.base64` in `verifyFaydaPhotoUpload`.

### 2. In-Memory Zero-Storage Face Matcher ([`src/lib/bot/face-matcher.ts`](file:///c:/Users/mrxan/OneDrive/Desktop/Spacematching-this/src/lib/bot/face-matcher.ts))
- Implemented `compareFaceToThumbnail(liveImageBuffer: Buffer, qrFaceBase64: string): Promise<FaceMatchResult>`.
- In-memory decoding and canonical scaling to 64x64 grayscale via `sharp`.
- **EXIF Auto-Orientation**: Added `.rotate()` to Sharp pipeline so front-facing camera selfies with EXIF orientation metadata (iOS/Android Orientation 6/8) are oriented right-side up.
- **Translation-Tolerant Peak Alignment**: Added a $\pm 6\text{px}$ spatial translation search window. Eliminates false rejections due to natural handheld camera jitter (a 4px natural offset previously failed at 56%; it now cleanly matches at >95%).
- **True Sobel Directional Vector Cosine**: Replaced scalar magnitude multiplication with vector dot product ($gx1 \cdot gx2 + gy1 \cdot gy2$), correctly measuring facial contour orientation (eyes, nose, mouth) rather than positive magnitude overlap.
- **Zero-Variance Protection**: Guarded Normalized Cross-Correlation (NCC) against flat zero-variance inputs to prevent false positive matches on blank/solid images.
- Enforced calibrated similarity threshold $\ge 65\%$ (`score >= 0.65`).
- Strictly zero disk writes or bucket persistence.

### 3. Step 2/2 Dialogue & Liveness Handler ([`src/app/api/telegram/webhook/route.ts`](file:///c:/Users/mrxan/OneDrive/Desktop/Spacematching-this/src/app/api/telegram/webhook/route.ts))
- Created `initiateFaydaLivenessStep2`:
  - Early-checks `photoResult.faceBase64`: If a scanned card has no face thumbnail, rejects immediately at Step 1 rather than misleading the user into taking a selfie that cannot pass.
  - Saves extracted citizen fields (`fullName`, `fan`, `dob`, `gender`) and `temp_fayda_face` in `session.draft_data`.
  - Sets `session.step = 'awaiting_fayda_liveness_selfie'`.
  - Dispatches bilingual Step 2/2 prompt with `[ 🏠 Main Menu / ሰርዝ ]` keyboard.
- Connected all 5 Fayda entry points to `initiateFaydaLivenessStep2`:
  1. Universal Photo Handler
  2. Standalone Fayda FAN Input (`awaiting_standalone_fayda_fan`)
  3. Seeker Step 9 Input (`dyn_card_fayda_fan`)
  4. Target User Verification (`awaiting_target_fayda_fan:${matchId}`)
  5. Seeker Wizard Fayda Upload (`awaiting_seeker_fayda_upload`)
- Added message handler for `awaiting_fayda_liveness_selfie`:
  - Positioned before Universal Photo Handler so selfie images are not misidentified as Fayda cards.
  - Supports compressed photos (`message.photo`), uncompressed documents (`message.document`), and Telegram round video notes (`message.video_note` via thumbnail).
  - Handles video notes without thumbnail gracefully by requesting a front-facing selfie instead of downloading raw MP4 into Sharp and throwing decode errors.
  - Surfaces bilingual `FILE_TOO_LARGE` guidance if downloaded selfie exceeds 10MB.
  - On match ($\ge 65\%$): persists to Supabase, enforces read-back guard, wipes `temp_fayda_face` from RAM, and renders the Verified Resident Dossier Card.
  - On rejection ($< 65\%$): sends score feedback and lighting/angle retake guidance, retaining session state.
  - On manual text: guides user to upload a selfie or video note.

### 4. Synthetic Fixtures & Test Harness ([`scripts/helpers/synthetic-fayda.ts`](file:///c:/Users/mrxan/OneDrive/Desktop/Spacematching-this/scripts/helpers/synthetic-fayda.ts), [`scripts/helpers/test-harness.ts`](file:///c:/Users/mrxan/OneDrive/Desktop/Spacematching-this/scripts/helpers/test-harness.ts))
- Updated `createAuthenticFaydaPayload` to default to an authentic WebP face thumbnail with RIFF headers (`DEFAULT_SYNTHETIC_FACE_WEBP_BASE64URL`) and support explicit empty face payloads for Step 1 negative tests.
- Added `createTelegramVideoNoteUpdate` builder helper to simulate Telegram round video notes.
- Fixed `scripts/challenger3-empirical-verification.ts` by initializing `setupTelegramFetchMock()` at the start of probe execution so `zxing-wasm` WebAssembly modules are resolved without network/file fetch aborts.

### 5. Verification Test Suite ([`scripts/verify-fayda-liveness.ts`](file:///c:/Users/mrxan/OneDrive/Desktop/Spacematching-this/scripts/verify-fayda-liveness.ts))
- Comprehensive 47-probe test suite verifying:
  - Matcher self-match, near-match, translation-shifted match, different person rejection, impostor rejection, flat image safety, and boundary edge cases.
  - Step 1 -> Step 2 dialogue progression via webhook.
  - Step 2 impostor rejection and manual text rejection.
  - Step 2 positive match persistence, database read-back guard, and zero-storage session wiping.
  - Telegram round video note ingestion.
  - Video note without thumbnail fallback guidance.
  - Fayda card upload without face thumbnail early Step 1 rejection.

---

## Verification Evidence

| Verification Phase | Command | Result | Details |
|---|---|---|---|
| **TypeScript Compilation** | `npx tsc --noEmit` | **Passed (0 errors)** | Full repository strict type check |
| **Next.js Production Build** | `npm run build` | **Compiled successfully** | 16/16 routes compiled with Turbopack |
| **Biometric Liveness Suite** | `npx tsx scripts/verify-fayda-liveness.ts` | **47 / 47 Passed (100%)** | Matcher unit tests, boundary probes, translation invariance, Step 1->2 flow, rejection guidance, video notes, zero-storage |
| **Adversarial Challenger M2** | `npx tsx scripts/adversarial-challenger-m2.ts` | **52 / 52 Passed (100%)** | Zero loop regressions, dead-end resolution |
| **Targeted Fayda Guard Suite** | `npx tsx scripts/verify-fayda-improvements.ts` | **100% Passed** | Admin search, unpersisted rejection, Wahid dossier card |
| **Challenger 3 Empirical Audit** | `npx tsx scripts/challenger3-empirical-verification.ts` | **31 / 31 Passed (100%)** | Negative budgets, FAN uniqueness, dossier sanitization, wasm fallback |
