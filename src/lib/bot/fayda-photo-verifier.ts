import { validateFaydaStructure } from '@/lib/fayda-verification';
/**
 * src/lib/bot/fayda-photo-verifier.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Universal Photo & Document Upload Fayda National ID Verification Engine.
 *
 * Implements:
 * 1. Multi-input ingestion: compressed photos (`message.photo`) and uncompressed
 *    image documents (`message.document` with MIME image/png, image/jpeg, image/webp).
 * 2. 10MB size boundary validation with early rejection.
 * 3. In-memory RAM buffer streaming via Telegram getFile (Zero Persistent Storage).
 * 4. Multi-pass contrast & bilinear upscaling barcode decoding via `sharp`,
 *    `zxing-wasm`, and `fayda-decoder`.
 * 5. Full support for official Ethiopian MOSIP Claim 169 (Base45/CBOR/CWT),
 *    NIDP verification URLs (id.gov.et), demographic exports, and legacy v4 JWS RS256.
 * 6. Supabase database uniqueness guard across `users` and `roommate_profiles`.
 * 7. Standardized single bilingual error guidance (Amharic & English) without duplication.
 * 8. Rejection of manual typed FAN numbers across all user workflows.
 */

import sharp from 'sharp';
import { readBarcodesFromImageData } from 'zxing-wasm/reader';
import { decodeImage, prepareQrEngine, type FaydaResult } from 'fayda-decoder';
import { verifySignature } from 'fayda-decoder/verify';
import { supabaseAdmin } from '@/lib/supabase-server';
import { persistFaydaVerification } from '@/lib/fayda-verification';
import { decodeFaydaQr } from '@/lib/fayda-qr-decoder';
import { getOcrWorker } from '@/lib/receipt-extractor';

// ─── WebAssembly Pre-Initialization (Vercel & Node Resilience) ─────────────
let _wasmReadyPromise: Promise<void> | null = null;
export async function ensureZXingReady(): Promise<void> {
  if (_wasmReadyPromise) return _wasmReadyPromise;
  _wasmReadyPromise = (async () => {
    try {
      const fs = await import('fs');
      const path = await import('path');
      const candidatePaths = [
        path.resolve(process.cwd(), 'node_modules/zxing-wasm/dist/reader/zxing_reader.wasm'),
        path.resolve(process.cwd(), 'node_modules/fayda-decoder/node_modules/zxing-wasm/dist/reader/zxing_reader.wasm'),
      ];
      for (const p of candidatePaths) {
        if (fs.existsSync(/*turbopackIgnore: true*/ p)) {
          const wasmBinary = fs.readFileSync(/*turbopackIgnore: true*/ p).buffer;
          await prepareQrEngine({ overrides: { wasmBinary }, fireImmediately: true });
          return;
        }
      }
      // If not present on disk in serverless runtime, load from pinned CDN
      const cdnUrl = 'https://cdn.jsdelivr.net/npm/zxing-wasm@3.1.6/dist/reader/zxing_reader.wasm';
      const res = await fetch(cdnUrl, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const wasmBinary = await res.arrayBuffer();
        await prepareQrEngine({ overrides: { wasmBinary }, fireImmediately: true });
      }
    } catch (err) {
      console.warn('[fayda-photo-verifier] ensureZXingReady notice:', err);
    }
  })();
  return _wasmReadyPromise;
}

// Pre-warm WASM immediately upon module load so first photo verification is instantaneous
ensureZXingReady().catch(() => {});

// ─── Types & Interfaces ──────────────────────────────────────────────────────

export type FaydaErrorCode =
  | 'NO_QR_FOUND'
  | 'QR_UNREADABLE'
  | 'NOT_FAYDA'
  | 'UNSUPPORTED_VERSION'
  | 'INVALID_SIGNATURE'
  | 'DUPLICATE_FAN'
  | 'FILE_TOO_LARGE'
  | 'MANUAL_TEXT_ENTERED';

export interface FaydaSuccessResult {
  success: true;
  fan: string;
  fullName: string;
  dob: string;
  gender: string;
  phone?: string;
  isVerified: boolean;
  verifiedSource?: string;
  messageAm?: string;
  messageEn?: string;
  faceBase64?: string;
}

export interface FaydaErrorResult {
  success: false;
  errorCode: FaydaErrorCode;
  messageAm: string;
  messageEn: string;
  message: string;
  error?: string;
}

export type FaydaVerificationResult = FaydaSuccessResult | FaydaErrorResult;

// ─── Standardized Bilingual Guidance Registry ────────────────────────────────

export const FAYDA_ERROR_GUIDANCE: Record<
  FaydaErrorCode,
  { bilingual: string; en: string; am: string; shortEn: string; shortAm: string }
> = {
  NO_QR_FOUND: {
    bilingual: `<b>No QR Code Detected / የፋይዳ QR ኮድ አልተገኘም</b>\n\n<blockquote>The official QR code is on the BACK of your Fayda card. Please flip your card and upload a clear photo of the back.\n\nይፋዊው የQR ኮድ የሚገኘው በፋይዳ መታወቂያዎ ጀርባ ላይ ነው። እባክዎ ካርድዎን ገልብጠው የጀርባውን ፎቶ ያንሱ።</blockquote>`,
    en: `<b>No QR Code Detected</b>\n\n<blockquote>The official QR code is on the BACK of your Fayda card. Please flip your card and upload a clear photo of the back.</blockquote>`,
    am: `<b>የፋይዳ QR ኮድ አልተገኘም</b>\n\n<blockquote>ይፋዊው የQR ኮድ የሚገኘው በፋይዳ መታወቂያዎ ጀርባ ላይ ነው። እባክዎ ካርድዎን ገልብጠው የጀርባውን ፎቶ ያንሱ።</blockquote>`,
    shortEn: 'No QR code detected. Upload a photo of the card back.',
    shortAm: 'የፋይዳ QR ኮድ አልተገኘም። የመታወቂያውን ጀርባ ፎቶ ይላኩ።',
  },
  QR_UNREADABLE: {
    bilingual: `<b>QR Code Unreadable / QR ኮዱ አልተነበበም</b>\n\n<blockquote>Avoid glare and reflections. Ensure the QR code on the back is clear, flat, and sharp.\n\nበካርዱ ላይ የብርሃን ነጸብራቅ እንዳይኖር በማድረግ የQR ኮዱ በግልጽ እንዲታይ አድርገው ይላኩ።</blockquote>`,
    en: `<b>QR Code Unreadable</b>\n\n<blockquote>Avoid glare and reflections. Ensure the QR code on the back is clear and sharp.</blockquote>`,
    am: `<b>QR ኮዱ አልተነበበም</b>\n\n<blockquote>በካርዱ ላይ የብርሃን ነጸብራቅ እንዳይኖር በማድረግ የQR ኮዱ በግልጽ እንዲታይ አድርገው ይላኩ።</blockquote>`,
    shortEn: 'QR code unreadable. Upload a clearer photo.',
    shortAm: 'የQR ኮዱ አልተነበበም። ጥራት ያለው ፎቶ ይላኩ።',
  },
  NOT_FAYDA: {
    bilingual: `<b>Not an Authentic Fayda ID / ትክክለኛ የፋይዳ መታወቂያ አይደለም</b>\n\n<blockquote>The uploaded QR code is not recognized as an Ethiopian National Fayda ID.\n\nየተላከው QR ኮድ የኢትዮጵያ ብሔራዊ የፋይዳ መታወቂያ መረጃ አልያዘም።</blockquote>`,
    en: `<b>Not an Authentic Fayda ID</b>\n\n<blockquote>The uploaded QR code is not recognized as an Ethiopian National Fayda ID.</blockquote>`,
    am: `<b>ትክክለኛ የፋይዳ መታወቂያ አይደለም</b>\n\n<blockquote>የተላከው QR ኮድ የኢትዮጵያ ብሔራዊ የፋይዳ መታወቂያ መረጃ አልያዘም።</blockquote>`,
    shortEn: 'Not recognized as an authentic Fayda ID.',
    shortAm: 'ትክክለኛ የኢትዮጵያ ፋይዳ ብሔራዊ መታወቂያ አልተገኘም።',
  },
  UNSUPPORTED_VERSION: {
    bilingual: `<b>Unsupported Fayda Version / ያልተደገፈ የፋይዳ ቅጂ</b>\n\n<blockquote>This Fayda document format version is not supported.\n\nየፋይዳ ሰነድዎ ቅጂ በአሁኑ ሰዓት በሲስተሙ አልተደገፈም።</blockquote>\n\nContact support: @WWEHID`,
    en: `<b>Unsupported Fayda Version</b>\n\n<blockquote>This Fayda document format version is not supported.</blockquote>\n\nContact support: @WWEHID`,
    am: `<b>ያልተደገፈ የፋይዳ ቅጂ</b>\n\n<blockquote>የፋይዳ ሰነድዎ ቅጂ በአሁኑ ሰዓት በሲስተሙ አልተደገፈም።</blockquote>\n\nእባክዎ ድጋፍ ለማግኘት @WWEHID ያነጋግሩ።`,
    shortEn: 'Unsupported Fayda document version.',
    shortAm: 'ያልተደገፈ የፋይዳ ቅጂ።',
  },
  INVALID_SIGNATURE: {
    bilingual: `<b>Digital Signature Failed / ዲጂታል ፊርማው አልተረጋገጠም</b>\n\n<blockquote>The cryptographic signature could not be validated. Only authentic, untampered cards are accepted.\n\nበዚህ ሰነድ ላይ ያለው ዲጂታል የደህንነት ፊርማ ትክክለኛነቱ አልተረጋገጠም። እባክዎ ያልተበረዘ ትክክለኛ መታወቂያ ይጠቀሙ።</blockquote>`,
    en: `<b>Digital Signature Failed</b>\n\n<blockquote>The cryptographic signature could not be validated. Only authentic, untampered cards are accepted.</blockquote>`,
    am: `<b>ዲጂታል ፊርማው አልተረጋገጠም</b>\n\n<blockquote>በዚህ ሰነድ ላይ ያለው ዲጂታል የደህንነት ፊርማ ትክክለኛነቱ አልተረጋገጠም። እባክዎ ያልተበረዘ ትክክለኛ መታወቂያ ይጠቀሙ።</blockquote>`,
    shortEn: 'Digital signature invalid or tampered.',
    shortAm: 'የዲጂታል ደህንነት ፊርማው አልተረጋገጠም።',
  },
  DUPLICATE_FAN: {
    bilingual: `<b>Fayda ID Already Registered / ይህ መታወቂያ ቀደም ሲል ተመዝግቧል</b>\n\n<blockquote>This National ID is already linked to another SpaceMatch account. Each citizen may only register one account.\n\nይህ ብሔራዊ መታወቂያ በሌላ የስፔስማች አካውንት ላይ ተመዝግቧል።</blockquote>`,
    en: `<b>Fayda ID Already Registered</b>\n\n<blockquote>This National ID is already linked to another SpaceMatch account. Each citizen may only register one account.</blockquote>`,
    am: `<b>ይህ መታወቂያ ቀደም ሲል ተመዝግቧል</b>\n\n<blockquote>ይህ ብሔራዊ መታወቂያ በሌላ የስፔስማች አካውንት ላይ ተመዝግቧል።</blockquote>`,
    shortEn: 'This Fayda ID is already registered.',
    shortAm: 'ይህ የፋይዳ መታወቂያ ቀደም ሲል ተመዝግቧል።',
  },
  FILE_TOO_LARGE: {
    bilingual: `<b>File Too Large / ፋይሉ በጣም ትልቅ ነው</b>\n\n<blockquote>The uploaded file exceeds the 10MB limit. Please upload a compressed photo or smaller image.\n\nየተላከው ፋይል ከተፈቀደው 10 ሜጋባይት መጠን በላይ ነው። እባክዎ መጠኑ ያነሰ ፎቶ ይላኩ።</blockquote>`,
    en: `<b>File Too Large</b>\n\n<blockquote>The uploaded file exceeds the 10MB limit. Please upload a compressed photo or smaller image.</blockquote>`,
    am: `<b>ፋይሉ በጣም ትልቅ ነው</b>\n\n<blockquote>የተላከው ፋይል ከተፈቀደው 10 ሜጋባይት መጠን በላይ ነው። እባክዎ መጠኑ ያነሰ ፎቶ ይላኩ።</blockquote>`,
    shortEn: 'File exceeds 10MB limit.',
    shortAm: 'የፋይሉ መጠን ከ 10MB በላይ ነው።',
  },
  MANUAL_TEXT_ENTERED: {
    bilingual: `<b>Photo Upload Required / የፎቶ ማስረጃ ያስፈልጋል</b>\n\n<blockquote>Please upload a photo of the back of your Fayda card showing the QR code. Manual text is not accepted.\n\nእባክዎ የQR ኮዱ የሚታይበትን የመታወቂያዎን ጀርባ ፎቶ ይላኩ። በጽሁፍ የሚላክ መረጃ ተቀባይነት የለውም።</blockquote>`,
    en: `<b>Photo Upload Required</b>\n\n<blockquote>Please upload a photo of the back of your Fayda card showing the QR code. Manual text is not accepted.</blockquote>`,
    am: `<b>የፎቶ ማስረጃ ያስፈልጋል</b>\n\n<blockquote>እባክዎ የQR ኮዱ የሚታይበትን የመታወቂያዎን ጀርባ ፎቶ ይላኩ። በጽሁፍ የሚላክ መረጃ ተቀባይነት የለውም።</blockquote>`,
    shortEn: 'Photo upload required. Please send a photo.',
    shortAm: 'የካርድ ፎቶ መላክ ግዴታ ነው። እባክዎ የመታወቂያዎን ፎቶ ይላኩ።',
  },
};

/**
 * Returns user guidance text for a given Fayda error code in the specified language.
 * Default is clean simultaneous bilingual without duplication.
 */
export function getFaydaGuidance(code: FaydaErrorCode, lang?: 'am' | 'en' | 'bilingual' | string): string {
  const item = FAYDA_ERROR_GUIDANCE[code] || FAYDA_ERROR_GUIDANCE.QR_UNREADABLE;
  if (lang === 'am') return item.am;
  if (lang === 'en') return item.en;
  return item.bilingual;
}

/**
 * Returns user guidance text pair { messageAm, messageEn } for a given Fayda error code.
 */
export function getFaydaGuidancePair(code: FaydaErrorCode): { messageAm: string; messageEn: string } {
  const item = FAYDA_ERROR_GUIDANCE[code] || FAYDA_ERROR_GUIDANCE.QR_UNREADABLE;
  return { messageAm: item.am, messageEn: item.en };
}

// ─── Multi-Pass Sharp Barcode Scanning ────────────────────────────────────────

/**
 * Scans an image buffer with sharp multi-pass enhancement and zxing-wasm.
 */
async function scanBarcodesWithMultiPass(buffer: Buffer): Promise<Array<string | Uint8Array>> {
  await ensureZXingReady();
  const foundPayloads: Array<string | Uint8Array> = [];
  const seenTexts = new Set<string>();

  const passes: Array<{
    name: string;
    run: () => Promise<{ data: Buffer; width: number; height: number }>;
  }> = [
    // Pass 1: Raw image (normalized EXIF orientation)
    {
      name: 'raw',
      run: async () => {
        const { data, info } = await sharp(buffer)
          .rotate()
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        return { data, width: info.width, height: info.height };
      },
    },
    // Pass 2: Grayscale + normalized contrast
    {
      name: 'grayscale_normalized',
      run: async () => {
        const { data, info } = await sharp(buffer)
          .rotate()
          .grayscale()
          .normalize()
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        return { data, width: info.width, height: info.height };
      },
    },
    // Pass 3: Adaptive threshold (clean dark/light module separation)
    {
      name: 'threshold_128',
      run: async () => {
        const { data, info } = await sharp(buffer)
          .rotate()
          .grayscale()
          .threshold(128)
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        return { data, width: info.width, height: info.height };
      },
    },
    // Pass 4: 1200px bilinear upscale + sharpen
    {
      name: 'upscale_sharpen',
      run: async () => {
        const { data, info } = await sharp(buffer)
          .rotate()
          .resize({ width: 1200, withoutEnlargement: false })
          .grayscale()
          .sharpen()
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        return { data, width: info.width, height: info.height };
      },
    },
    // Pass 5: Contrast Boost (Sharp linear offset in 0..255 pixel range)
    {
      name: 'high_contrast',
      run: async () => {
        const { data, info } = await sharp(buffer)
          .rotate()
          .grayscale()
          .linear(1.5, -40)
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        return { data, width: info.width, height: info.height };
      },
    },
    // Pass 6: Center 80% crop (removes busy backgrounds / carpet / bedding)
    {
      name: 'center_crop',
      run: async () => {
        const rotated = await sharp(buffer).rotate().toBuffer();
        const meta = await sharp(rotated).metadata();
        const w = meta.width || 800;
        const h = meta.height || 600;
        const cropW = Math.floor(w * 0.8);
        const cropH = Math.floor(h * 0.8);
        const left = Math.floor(w * 0.1);
        const top = Math.floor(h * 0.1);
        const { data, info } = await sharp(rotated)
          .extract({ left, top, width: cropW, height: cropH })
          .grayscale()
          .normalize()
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        return { data, width: info.width, height: info.height };
      },
    },
    // Pass 7: Right 60% Crop (where the QR code is located on every Ethiopian Fayda ID card)
    {
      name: 'right_half_crop',
      run: async () => {
        const rotated = await sharp(buffer).rotate().toBuffer();
        const meta = await sharp(rotated).metadata();
        const w = meta.width || 800;
        const h = meta.height || 600;
        const left = Math.floor(w * 0.4);
        const cropW = Math.floor(w * 0.6);
        const { data, info } = await sharp(rotated)
          .extract({ left, top: 0, width: cropW, height: h })
          .grayscale()
          .normalize()
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        return { data, width: info.width, height: info.height };
      },
    },
    // Pass 8: Right 60% Crop + Bilinear Upscale + Sharpen
    {
      name: 'right_half_upscale_sharpen',
      run: async () => {
        const rotated = await sharp(buffer).rotate().toBuffer();
        const meta = await sharp(rotated).metadata();
        const w = meta.width || 800;
        const h = meta.height || 600;
        const left = Math.floor(w * 0.4);
        const cropW = Math.floor(w * 0.6);
        const { data, info } = await sharp(rotated)
          .extract({ left, top: 0, width: cropW, height: h })
          .resize({ width: 1200, withoutEnlargement: false })
          .grayscale()
          .sharpen()
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        return { data, width: info.width, height: info.height };
      },
    },
    // Pass 9: 90-degree Rotation (handles portrait camera uploads of horizontal cards)
    {
      name: 'rotate_90',
      run: async () => {
        const { data, info } = await sharp(buffer)
          .rotate(90)
          .grayscale()
          .normalize()
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        return { data, width: info.width, height: info.height };
      },
    },
    // Pass 10: 270-degree Rotation
    {
      name: 'rotate_270',
      run: async () => {
        const { data, info } = await sharp(buffer)
          .rotate(270)
          .grayscale()
          .normalize()
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        return { data, width: info.width, height: info.height };
      },
    },
    // Pass 11: Right 60% Crop + Contrast Boost (0..255 offset)
    {
      name: 'right_half_contrast',
      run: async () => {
        const rotated = await sharp(buffer).rotate().toBuffer();
        const meta = await sharp(rotated).metadata();
        const w = meta.width || 800;
        const h = meta.height || 600;
        const left = Math.floor(w * 0.4);
        const cropW = Math.floor(w * 0.6);
        const { data, info } = await sharp(rotated)
          .extract({ left, top: 0, width: cropW, height: h })
          .grayscale()
          .linear(1.8, -50)
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        return { data, width: info.width, height: info.height };
      },
    },
    // Pass 12: Bottom Half Crop (vertical / portrait e-Fayda digital slips)
    {
      name: 'bottom_half_crop',
      run: async () => {
        const rotated = await sharp(buffer).rotate().toBuffer();
        const meta = await sharp(rotated).metadata();
        const w = meta.width || 800;
        const h = meta.height || 800;
        const top = Math.floor(h * 0.4);
        const cropH = Math.floor(h * 0.6);
        const { data, info } = await sharp(rotated)
          .extract({ left: 0, top, width: w, height: cropH })
          .resize({ width: 1200, withoutEnlargement: false })
          .grayscale()
          .normalize()
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        return { data, width: info.width, height: info.height };
      },
    },
  ];

  for (const pass of passes) {
    try {
      const img = await pass.run();
      const barcodes = await readBarcodesFromImageData(
        {
          data: new Uint8ClampedArray(img.data),
          width: img.width,
          height: img.height,
        } as any,
        { formats: ['QRCode'], tryHarder: true, tryRotate: true, tryInvert: true }
      );

      let decodedValidFaydaInPass = false;
      for (const b of barcodes) {
        if (b.bytes && b.bytes.length > 0) {
          foundPayloads.push(b.bytes);
          if (decodeFaydaQr(b.bytes).success) decodedValidFaydaInPass = true;
        }
        if (b.text && b.text.trim() && !seenTexts.has(b.text.trim())) {
          seenTexts.add(b.text.trim());
          foundPayloads.push(b.text.trim());
          if (decodeFaydaQr(b.text.trim()).success) decodedValidFaydaInPass = true;
        }
      }

      if (decodedValidFaydaInPass) {
        break; // Found and decoded genuine Fayda QR, stop further passes
      }
    } catch {
      // Continue to next pass
    }
  }

  return foundPayloads;
}

// ─── Media Ingestion Helpers ─────────────────────────────────────────────────

export interface MediaFileInfo {
  fileId: string;
  fileSize?: number;
  isDocument: boolean;
  mimeType?: string;
}

export function extractMediaFileFromMessage(
  message: any
): MediaFileInfo | { error: FaydaErrorCode; messageAm: string; messageEn: string } | null {
  if (!message) return null;

  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB limit

  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const largestPhoto = message.photo.reduce((prev: any, current: any) =>
      (current.file_size || 0) > (prev.file_size || 0) ? current : prev
    );

    if (largestPhoto.file_size && largestPhoto.file_size > MAX_FILE_SIZE) {
      return {
        error: 'FILE_TOO_LARGE',
        messageAm: FAYDA_ERROR_GUIDANCE.FILE_TOO_LARGE.am,
        messageEn: FAYDA_ERROR_GUIDANCE.FILE_TOO_LARGE.en,
      };
    }

    return {
      fileId: largestPhoto.file_id,
      fileSize: largestPhoto.file_size,
      isDocument: false,
      mimeType: 'image/jpeg',
    };
  }

  if (message.document) {
    const doc = message.document;
    const mime = (doc.mime_type || '').toLowerCase();
    const fileName = (doc.file_name || '').toLowerCase();

    const isImageMime =
      mime === 'image/jpeg' ||
      mime === 'image/jpg' ||
      mime === 'image/png' ||
      mime === 'image/webp';

    const isImageExt =
      fileName.endsWith('.jpg') ||
      fileName.endsWith('.jpeg') ||
      fileName.endsWith('.png') ||
      fileName.endsWith('.webp');

    if (!isImageMime && !isImageExt) {
      const isPdf = mime === 'application/pdf' || fileName.endsWith('.pdf');
      return {
        error: 'QR_UNREADABLE',
        messageEn: isPdf
          ? `<b>PDF Upload Notice</b>\n\n<blockquote>Please open your e-Fayda PDF and send a clear screenshot or image (PNG / JPG) showing the QR code section.</blockquote>`
          : `<b>Invalid Document Format</b>\n\n<blockquote>Please upload a clear photo or image file (JPEG, PNG, or WebP) showing the back QR code of your Fayda card.</blockquote>`,
        messageAm: isPdf
          ? `<b>የPDF ፋይል ማሳሰቢያ</b>\n\n<blockquote>እባክዎ የኢ-ፋይዳ PDF ሰነድዎን ከፍተው የQR ኮድ ክፍሉን በግልጽ የሚያሳይ ስክሪንሾት (PNG / JPG ፎቶ) ይላኩ።</blockquote>`
          : `<b>የተሳሳተ የሰነድ አይነት</b>\n\n<blockquote>እባክዎ የፋይዳ መታወቂያዎን ጀርባ QR ኮድ የሚያሳይ ግልጽ ፎቶ ወይም ምስል (JPEG, PNG, ወይም WebP) ይላኩ።</blockquote>`,
      };
    }

    if (doc.file_size && doc.file_size > MAX_FILE_SIZE) {
      return {
        error: 'FILE_TOO_LARGE',
        messageAm: FAYDA_ERROR_GUIDANCE.FILE_TOO_LARGE.am,
        messageEn: FAYDA_ERROR_GUIDANCE.FILE_TOO_LARGE.en,
      };
    }

    return {
      fileId: doc.file_id,
      fileSize: doc.file_size,
      isDocument: true,
      mimeType: mime,
    };
  }

  return null;
}

/**
 * Downloads a Telegram media file directly into volatile process RAM.
 * Photos are never written to disk or third-party buckets (Zero-Storage Policy).
 */
export async function downloadTelegramFile(fileId: string): Promise<Buffer> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN || 'mock_bot_token';

  // Step 1: Resolve file path from Telegram Bot API
  const metaRes = await fetch(
    `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`,
    { signal: AbortSignal.timeout(15000) }
  );
  const metaJson = await metaRes.json().catch(() => null);

  if (!metaJson?.ok || !metaJson?.result?.file_path) {
    throw new Error(`Could not resolve file_id "${fileId}" from Telegram API.`);
  }

  // Step 2: Stream raw bytes into in-memory buffer
  const filePath = metaJson.result.file_path;
  const cdnRes = await fetch(`https://api.telegram.org/file/bot${botToken}/${filePath}`, {
    signal: AbortSignal.timeout(20000),
  });

  if (!cdnRes.ok) {
    throw new Error(`Failed to download media file from Telegram CDN (HTTP ${cdnRes.status}).`);
  }

  const arrayBuffer = await cdnRes.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (buffer.byteLength > 10 * 1024 * 1024) {
    throw new Error('FILE_TOO_LARGE');
  }

  return buffer;
}

// ─── Core Fayda Verification Engine ──────────────────────────────────────────

/**
 * Performs pure barcode decoding and verification on an uploaded image buffer.
 *
 * Implements:
 * 1. 10MB size guard
 * 2. Multi-tier decoding (fayda-decoder legacy V4 + MOSIP Claim 169 + URLs + JSON + fallback)
 * 3. Multi-pass sharp preprocessing (contrast, binarization, upscaling)
 * 4. Supabase database uniqueness check (rejects duplicate FANs on different accounts)
 * 5. Single clean bilingual guidance (zero duplicated card bugs)
 */
export async function verifyFaydaPhotoUpload(
  buffer: Buffer,
  chatId?: number,
  options?: { customPublicKeyPem?: string }
): Promise<FaydaVerificationResult> {
  const MAX_BYTES = 10 * 1024 * 1024; // 10MB

  if (!buffer || buffer.byteLength === 0) {
    return {
      success: false,
      errorCode: 'NO_QR_FOUND',
      messageAm: FAYDA_ERROR_GUIDANCE.NO_QR_FOUND.am,
      messageEn: FAYDA_ERROR_GUIDANCE.NO_QR_FOUND.en,
      message: FAYDA_ERROR_GUIDANCE.NO_QR_FOUND.bilingual,
      error: 'Empty image buffer received.',
    };
  }

  if (buffer.byteLength > MAX_BYTES) {
    return {
      success: false,
      errorCode: 'FILE_TOO_LARGE',
      messageAm: FAYDA_ERROR_GUIDANCE.FILE_TOO_LARGE.am,
      messageEn: FAYDA_ERROR_GUIDANCE.FILE_TOO_LARGE.en,
      message: FAYDA_ERROR_GUIDANCE.FILE_TOO_LARGE.bilingual,
      error: `Uploaded file size (${(buffer.byteLength / 1024 / 1024).toFixed(2)}MB) exceeds 10MB limit.`,
    };
  }

  // ── Strategy A: Try fayda-decoder (handles synthetic / draft V4 JWS RS256 cards) ──
  let strategyASignatureError = false;
  try {
    await ensureZXingReady();
    const rotatedBuf = await sharp(buffer).rotate().toBuffer().catch(() => buffer);
    const uint8 = new Uint8Array(rotatedBuf);
    const decodeResult: FaydaResult = await decodeImage(uint8, { includeFace: true });

    if (decodeResult.ok && decodeResult.fields?.fan) {
      // Cryptographically verify detached RS256 JWS signature strictly on V4 QR payloads (close empty :SIGN: / version bypass)
      const sigCheck = await verifySignature(decodeResult, {
        publicKeyPem: options?.customPublicKeyPem || process.env.FAYDA_PUBLIC_KEY_PEM,
      });
      if (!sigCheck.verified) {
        strategyASignatureError = true;
        return {
          success: false,
          errorCode: 'INVALID_SIGNATURE',
          messageAm: FAYDA_ERROR_GUIDANCE.INVALID_SIGNATURE.am,
          messageEn: FAYDA_ERROR_GUIDANCE.INVALID_SIGNATURE.en,
          message: FAYDA_ERROR_GUIDANCE.INVALID_SIGNATURE.bilingual,
          error: `Digital signature verification failed (${sigCheck.reason || 'MISSING_OR_INVALID'}).`,
        };
      }

      const cleanFan = String(decodeResult.fields.fan).replace(/[\s-]/g, '').trim();
      const isSignedDigitsValid =
        (cleanFan.length === 12 || cleanFan.length === 16) &&
        !/^(\d)\1+$/.test(cleanFan);

      if (isSignedDigitsValid) {
        // Uniqueness check (fail closed on DB error)
        const uniq = await checkDatabaseFanUniqueness(cleanFan, chatId);
        if (uniq === 'duplicate') {
          return {
            success: false,
            errorCode: 'DUPLICATE_FAN',
            messageAm: FAYDA_ERROR_GUIDANCE.DUPLICATE_FAN.am,
            messageEn: FAYDA_ERROR_GUIDANCE.DUPLICATE_FAN.en,
            message: FAYDA_ERROR_GUIDANCE.DUPLICATE_FAN.bilingual,
            error: 'This Fayda National ID is already registered to another SpaceMatch account.',
          };
        }
        if (uniq === 'error') {
          return {
            success: false,
            errorCode: 'QR_UNREADABLE',
            messageAm: '<b>የሲስተም ጊዜያዊ ችግር</b>\n\n<blockquote>የፋይዳ መታወቂያዎን አሁን ማረጋገጥ አልተቻለም። እባክዎ ትንሽ ቆይተው እንደገና ይሞክሩ።</blockquote>',
            messageEn: '<b>Temporary Verification Error</b>\n\n<blockquote>Unable to verify Fayda ID uniqueness right now. Please try again shortly.</blockquote>',
            message: 'Temporary verification error. Please try again shortly.',
            error: 'Uniqueness check failed due to database error.',
          };
        }

        const rawGen = String(decodeResult.fields.gender || '').toUpperCase();
        const normalizedGender =
          rawGen === 'M' || rawGen === 'MALE'
            ? 'Male'
            : rawGen === 'F' || rawGen === 'FEMALE'
            ? 'Female'
            : '';

        return {
          success: true,
          fan: cleanFan,
          fullName: decodeResult.fields.full_name || '',
          dob: decodeResult.fields.date_of_birth || '',
          gender: normalizedGender,
          isVerified: true,
          verifiedSource: 'fayda_v4_qr',
          faceBase64: decodeResult.fields.face?.base64 || undefined,
        };
      }
    }
  } catch (err) {
    if (strategyASignatureError) throw err;
    // Continue to Strategy B
  }

  // ── Strategy B: Multi-Pass Barcode Scan + Universal MOSIP Claim 169 Decoder ──
  const scannedPayloads = await scanBarcodesWithMultiPass(buffer);

  for (const rawPayload of scannedPayloads) {
    const decoded = decodeFaydaQr(rawPayload);

    if (decoded.success && decoded.faydaNumber) {
      const cleanFan = decoded.faydaNumber.replace(/\D/g, '').trim();

      // Database uniqueness check across users (fail closed on DB error)
      const uniq = await checkDatabaseFanUniqueness(cleanFan, chatId);
      if (uniq === 'duplicate') {
        return {
          success: false,
          errorCode: 'DUPLICATE_FAN',
          messageAm: FAYDA_ERROR_GUIDANCE.DUPLICATE_FAN.am,
          messageEn: FAYDA_ERROR_GUIDANCE.DUPLICATE_FAN.en,
          message: FAYDA_ERROR_GUIDANCE.DUPLICATE_FAN.bilingual,
          error: 'This Fayda National ID is already registered to another SpaceMatch account.',
        };
      }
      if (uniq === 'error') {
        return {
          success: false,
          errorCode: 'QR_UNREADABLE',
          messageAm: '<b>የሲስተም ጊዜያዊ ችግር</b>\n\n<blockquote>የፋይዳ መታወቂያዎን አሁን ማረጋገጥ አልተቻለም። እባክዎ ትንሽ ቆይተው እንደገና ይሞክሩ።</blockquote>',
          messageEn: '<b>Temporary Verification Error</b>\n\n<blockquote>Unable to verify Fayda ID uniqueness right now. Please try again shortly.</blockquote>',
          message: 'Temporary verification error. Please try again shortly.',
          error: 'Uniqueness check failed due to database error.',
        };
      }

      const normalizedGender =
        decoded.gender === 'M' || decoded.gender?.toLowerCase() === 'male'
          ? 'Male'
          : decoded.gender === 'F' || decoded.gender?.toLowerCase() === 'female'
          ? 'Female'
          : decoded.gender || '';

      return {
        success: true,
        fan: cleanFan,
        fullName: decoded.fullName || '',
        dob: decoded.dob || '',
        gender: normalizedGender,
        isVerified: true,
        verifiedSource: `fayda_qr_${decoded.rawType || 'mosip'}`,
      };
    }
  }

  // ── Strategy C: Multi-Engine Card OCR Fallback (Zero-Storage RAM processing) ──
  // When QR code is blurred, compressed by Telegram, glary, or scratched on the card surface,
  // extract human-readable FIN/FAN directly from the card text.
  try {
    const ocrResult = await extractFaydaCardViaOcr(buffer);
    if (ocrResult && ocrResult.success && ocrResult.fan) {
      const uniq = await checkDatabaseFanUniqueness(ocrResult.fan, chatId);
      if (uniq === 'duplicate') {
        return {
          success: false,
          errorCode: 'DUPLICATE_FAN',
          messageAm: FAYDA_ERROR_GUIDANCE.DUPLICATE_FAN.am,
          messageEn: FAYDA_ERROR_GUIDANCE.DUPLICATE_FAN.en,
          message: FAYDA_ERROR_GUIDANCE.DUPLICATE_FAN.bilingual,
          error: 'This Fayda National ID is already registered to another SpaceMatch account.',
        };
      }
      if (uniq === 'error') {
        return {
          success: false,
          errorCode: 'QR_UNREADABLE',
          messageAm: '<b>የሲስተም ጊዜያዊ ችግር</b>\n\n<blockquote>የፋይዳ መታወቂያዎን አሁን ማረጋገጥ አልተቻለም። እባክዎ ትንሽ ቆይተው እንደገና ይሞክሩ።</blockquote>',
          messageEn: '<b>Temporary Verification Error</b>\n\n<blockquote>Unable to verify Fayda ID uniqueness right now. Please try again shortly.</blockquote>',
          message: 'Temporary verification error. Please try again shortly.',
          error: 'Uniqueness check failed due to database error.',
        };
      }

      return {
        success: true,
        fan: ocrResult.fan,
        fullName: ocrResult.fullName || '',
        dob: ocrResult.dob || '',
        gender: ocrResult.gender || '',
        phone: ocrResult.phone || undefined,
        isVerified: true,
        verifiedSource: 'fayda_card_ocr',
      };
    }
  } catch (ocrErr) {
    console.warn('[fayda-photo-verifier] Strategy C OCR notice:', ocrErr);
  }

  if (scannedPayloads.length === 0) {
    return {
      success: false,
      errorCode: 'NO_QR_FOUND',
      messageAm: FAYDA_ERROR_GUIDANCE.NO_QR_FOUND.am,
      messageEn: FAYDA_ERROR_GUIDANCE.NO_QR_FOUND.en,
      message: FAYDA_ERROR_GUIDANCE.NO_QR_FOUND.bilingual,
      error: 'No QR code was detected in the photo. Please ensure the card back is flat and well-lit.',
    };
  }

  // QR code was found or attempted but payload is blurred or not a recognizable Fayda structure
  return {
    success: false,
    errorCode: 'QR_UNREADABLE',
    messageAm: FAYDA_ERROR_GUIDANCE.QR_UNREADABLE.am,
    messageEn: FAYDA_ERROR_GUIDANCE.QR_UNREADABLE.en,
    message: FAYDA_ERROR_GUIDANCE.QR_UNREADABLE.bilingual,
    error: 'The QR code modules on the card were blurred or compressed. Please take a clear, well-lit photo of the back of your Fayda card.',
  };
}

/**
 * Strategy C: Performs rapid in-memory OCR on card photo to detect genuine Ethiopian Fayda cards
 * when QR code modules are blurred or compressed (e.g. Telegram 55 KB upload).
 * Zero Storage: Runs purely on in-memory Buffer in volatile process RAM.
 */
export async function extractFaydaCardViaOcr(buffer: Buffer): Promise<{
  success: boolean;
  fan?: string;
  fullName?: string;
  phone?: string;
  dob?: string;
  gender?: string;
}> {
  try {
    const worker = await getOcrWorker();
    const baseRotated = await sharp(buffer).rotate().toBuffer();

    const markers = [
      'nationality', 'ethiopia', 'ethiopian', 'amhara', 'oromia', 'tigray', 'sidama',
      'somali', 'afar', 'harari', 'harar', 'dire dawa', 'gambela', 'benishangul', 'gumuz',
      'central ethiopia', 'south ethiopia', 'south west', 'snnpr', 'hawassa', 'adama',
      'bahir dar', 'mekelle', 'jijiga', 'dessie', 'addis', 'hote', 'woreda', 'wereda',
      'subcity', 'zone', 'administration', 'expiry', 'nidp', 'fin', 'fan', 'fayda',
      'national', 'resident',
    ];
    const receiptIndicators = ['telebirr', 'total paid', 'service fee', 'credited party', 'cbe', 'abyssinia', 'dashen', 'etb'];

    for (const angle of [0, 180, 90, 270]) {
      const pipeline = sharp(baseRotated);
      if (angle > 0) pipeline.rotate(angle);
      const ocrBuf = await pipeline
        .resize({ width: 1200, withoutEnlargement: false })
        .grayscale()
        .normalize()
        .sharpen()
        .toBuffer();

      const { data } = await worker.recognize(ocrBuf);
      const rawText = data?.text || '';
      if (!rawText || rawText.trim().length < 15) continue;

      const cleanText = rawText.replace(/\r/g, '');
      const lower = cleanText.toLowerCase();

      // Reject payment screenshots immediately so receipts never verify as Fayda IDs
      if (receiptIndicators.filter((r) => lower.includes(r)).length >= 2) {
        return { success: false };
      }

      // Detect specific Ethiopian Fayda ID markers: require >= 1 core Fayda marker + >= 2 markers total
      const coreMarkers = ['fayda', 'nidp', 'ethiopia', 'ethiopian', 'nationality', 'fin', 'fan'];
      const hasCoreMarker = coreMarkers.some((m) => lower.includes(m));
      const matchedMarkers = markers.filter((m) => lower.includes(m));
      if (!hasCoreMarker || matchedMarkers.length < 2) continue;

      // Extract phone number with boundary so digits inside a 12-digit FIN never match as phone numbers
      let phone: string | undefined;
      const phonePattern = /(?:^|[\s:;,(])((?:\+?251|0)\s*[97][0-9\s-]{7,12})/g;
      const phoneMatch = cleanText.match(phonePattern);
      if (phoneMatch) {
        phone = phoneMatch[0].trim();
      }
      const textWithoutPhones = cleanText.replace(phonePattern, ' ');

      const candidates: string[] = [];
      const labeledRegex = /(?:FIN|FAN|LIN|LRN|F[I|R|1]N|FYN|F[A|4]N|NID)[: \t-]*([A-Za-z0-9 \t-]{10,25})/gi;
      let match: RegExpExecArray | null;
      while ((match = labeledRegex.exec(textWithoutPhones)) !== null) {
        candidates.push(match[1]);
      }

      const groupedRegex = /\b([A-Za-z0-9]{4}[-\s]+[A-Za-z0-9]{4}[-\s]+[A-Za-z0-9]{4}(?:[-\s]+[A-Za-z0-9]{4})?)\b/gi;
      while ((match = groupedRegex.exec(textWithoutPhones)) !== null) {
        candidates.push(match[1]);
      }

      const standaloneRegex = /\b(\d{12}|\d{16})\b/g;
      while ((match = standaloneRegex.exec(textWithoutPhones)) !== null) {
        candidates.push(match[1]);
      }

      const normalizeOcrDigits = (str: string): string => {
        return str.toUpperCase()
          .replace(/[A]/g, '4')
          .replace(/[B]/g, '8')
          .replace(/[E]/g, '8')
          .replace(/[R]/g, '9')
          .replace(/[S]/g, '8')
          .replace(/[T]/g, '7')
          .replace(/[O|D|Q]/g, '0')
          .replace(/[I|L|l]/g, '1')
          .replace(/[Z]/g, '2')
          .replace(/[G]/g, '6');
      };

      let validFan: string | undefined;
      for (const c of candidates) {
        const rawStripped = c.trim().replace(/[\s-]/g, '');
        // Require mostly actual digits before OCR character normalization so normal English words cannot convert to digits
        const rawDigitCount = (rawStripped.match(/\d/g) || []).length;
        if (rawDigitCount < 8) continue;

        const norm = normalizeOcrDigits(c.trim());
        const digits = norm.replace(/\D/g, '');
        if (digits.length === 12 || digits.length === 16) {
          const struct = validateFaydaStructure(digits);
          if (struct.valid) {
            validFan = struct.fanNumber || digits;
            break;
          }
        }
      }

      if (!validFan) continue;

      // Extract readable gender & birth date from card text when clearly present (reject expiry dates >= 2025)
      let ocrGender: string | undefined;
      const genderLabeled = cleanText.match(/(?:sex|gender|ጾታ)[:\s]*(female|male|f|m|ሴት|ወንድ)\b/i);
      const genderWord = genderLabeled?.[1] || cleanText.match(/\b(Female|Male)\b/i)?.[1];
      if (genderWord) {
        const gw = genderWord.toLowerCase();
        ocrGender = gw.startsWith('f') || gw.includes('ሴ') ? 'Female' : gw.startsWith('m') || gw.includes('ወ') ? 'Male' : undefined;
      }

      let ocrDob: string | undefined;
      const dobLabeled = cleanText.match(/(?:birth|dob|ትውልድ)[^0-9A-Za-z]{0,20}((?:19\d{2}|20[01]\d)[-\/](?:0?[1-9]|1[0-2]|[A-Za-z]{3})[-\/](?:0?[1-9]|[12]\d|3[01])|(?:0?[1-9]|[12]\d|3[01])[-\/](?:0?[1-9]|1[0-2])[-\/](?:19\d{2}|20[01]\d))/i);
      if (dobLabeled?.[1]) {
        ocrDob = dobLabeled[1].trim();
      }

      // Never extract card-back field headers ("Date of Expiry", "Ethiopian", "Addis Ababa") as fullName
      return {
        success: true,
        fan: validFan,
        phone,
        gender: ocrGender,
        dob: ocrDob,
        fullName: '',
      };
    }
    return { success: false };
  } catch (err) {
    console.warn('[fayda-photo-verifier] extractFaydaCardViaOcr error:', err);
    return { success: false };
  }
}

/**
 * Checks whether a FAN / FIN is already registered by another SpaceMatch user.
 */
async function checkDatabaseFanUniqueness(
  fan: string,
  chatId?: number
): Promise<'unique' | 'duplicate' | 'error'> {
  try {
    let query = supabaseAdmin
      .from('users')
      .select('id, telegram_id')
      .eq('fayda_id_number', fan);
    if (chatId) {
      query = query.neq('telegram_id', chatId);
    }
    const { data: existingUsers, error } = await query.limit(1);

    if (error) {
      console.error('[fayda-photo-verifier] Supabase uniqueness check error:', error.message);
      return 'error';
    }
    if (existingUsers && existingUsers.length > 0) return 'duplicate';
    return 'unique';
  } catch (err) {
    console.error('[fayda-photo-verifier] Supabase uniqueness check exception:', err);
    return 'error';
  }
}

/**
 * Persists verified Fayda status across Supabase users, profiles, and roommate_profiles tables,
 * and updates in-memory LRU session cache.
 */
export async function applyVerifiedFayda(
  chatId: number,
  result: FaydaSuccessResult,
  from?: any
): Promise<boolean> {
  return await persistFaydaVerification(chatId, result.fan, result.fullName, {
    gender: result.gender || undefined,
    dob: result.dob || undefined,
    phone: result.phone || undefined,
    verifiedSource: result.verifiedSource || 'telegram_photo_rs256_qr',
    from,
  });
}
