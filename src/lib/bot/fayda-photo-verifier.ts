/**
 * src/lib/bot/fayda-photo-verifier.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure Photo & Document Upload Fayda National ID Verification Engine.
 *
 * Implements:
 * 1. Multi-input ingestion: compressed photos (`message.photo`) and uncompressed
 *    image documents (`message.document` with MIME image/png, image/jpeg, image/webp).
 * 2. 10MB size boundary validation with early rejection.
 * 3. In-memory RAM buffer streaming via Telegram getFile (Zero Persistent Storage).
 * 4. Multi-pass contrast & bilinear upscaling barcode decoding via `fayda-decoder`
 *    and WebAssembly `zxing-wasm`.
 * 5. Official NIDP Version 4 detached JWS RS256 cryptographic signature validation
 *    against the pinned NIDP RSA public key.
 * 6. Supabase database uniqueness guard across `users` and `profiles`.
 * 7. Standardized bilingual error guidance (Amharic & English) across all 8 failure codes.
 * 8. Rejection of manual typed FAN numbers across all user workflows.
 */

import { decodeImage, prepareQrEngine, type FaydaResult } from 'fayda-decoder';
import { verifySignature } from 'fayda-decoder/verify';
import { supabaseAdmin } from '@/lib/supabase-server';
import { persistFaydaVerification } from '@/lib/fayda-verification';

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
  { en: string; am: string; shortEn: string; shortAm: string }
> = {
  NO_QR_FOUND: {
    en: `<b>No QR Code Detected / የፋይዳ QR ኮድ አልተገኘም</b>\n\n<blockquote>The official QR code is on the BACK of your Fayda card. Please flip your card and upload a clear photo of the back.\nይፋዊው የQR ኮድ የሚገኘው በፋይዳ መታወቂያዎ ጀርባ ላይ ነው። እባክዎ ካርድዎን ገልብጠው የጀርባውን ፎቶ ያንሱ።</blockquote>`,
    am: `<b>የፋይዳ QR ኮድ አልተገኘም / No QR Code Detected</b>\n\n<blockquote>ይፋዊው የQR ኮድ የሚገኘው በፋይዳ መታወቂያዎ ጀርባ ላይ ነው። እባክዎ ካርድዎን ገልብጠው የጀርባውን ፎቶ ያንሱ።\nThe official QR code is on the BACK of your Fayda card. Please flip your card and upload a clear photo of the back.</blockquote>`,
    shortEn: 'No QR code detected. Upload a photo of the card back.',
    shortAm: 'የፋይዳ QR ኮድ አልተገኘም። የመታወቂያውን ጀርባ ፎቶ ይላኩ።',
  },
  QR_UNREADABLE: {
    en: `<b>QR Code Unreadable / QR ኮዱ አልተነበበም</b>\n\n<blockquote>Avoid glare and reflections. Ensure the QR code on the back is clear and sharp.\nበካርዱ ላይ የብርሃን ነጸብራቅ እንዳይኖር በማድረግ የQR ኮዱ በግልጽ እንዲታይ አድርገው ይላኩ።</blockquote>`,
    am: `<b>QR ኮዱ አልተነበበም / QR Code Unreadable</b>\n\n<blockquote>በካርዱ ላይ የብርሃን ነጸብራቅ እንዳይኖር በማድረግ የQR ኮዱ በግልጽ እንዲታይ አድርገው ይላኩ።\nAvoid glare and reflections. Ensure the QR code on the back is clear and sharp.</blockquote>`,
    shortEn: 'QR code unreadable. Upload a clearer photo.',
    shortAm: 'የQR ኮዱ አልተነበበም። ጥራት ያለው ፎቶ ይላኩ።',
  },
  NOT_FAYDA: {
    en: `<b>Not an Authentic Fayda ID / ትክክለኛ የፋይዳ መታወቂያ አይደለም</b>\n\n<blockquote>The uploaded QR code is not recognized as an Ethiopian National Fayda ID.\nየተላከው QR ኮድ የኢትዮጵያ ብሔራዊ የፋይዳ መታወቂያ መረጃ አልያዘም።</blockquote>`,
    am: `<b>ትክክለኛ የፋይዳ መታወቂያ አይደለም / Not an Authentic Fayda ID</b>\n\n<blockquote>የተላከው QR ኮድ የኢትዮጵያ ብሔራዊ የፋይዳ መታወቂያ መረጃ አልያዘም።\nThe uploaded QR code is not recognized as an Ethiopian National Fayda ID.</blockquote>`,
    shortEn: 'Not recognized as an authentic Fayda ID.',
    shortAm: 'ትክክለኛ የኢትዮጵያ ፋይዳ ብሔራዊ መታወቂያ አልተገኘም።',
  },
  UNSUPPORTED_VERSION: {
    en: `<b>Unsupported Fayda Version / ያልተደገፈ የፋይዳ ቅጂ</b>\n\n<blockquote>This Fayda document format version is not supported.\nየፋይዳ ሰነድዎ ቅጂ በአሁኑ ሰዓት በሲስተሙ አልተደገፈም።</blockquote>\n\nContact support: @birukadiyee or @WWEHID`,
    am: `<b>ያልተደገፈ የፋይዳ ቅጂ / Unsupported Fayda Version</b>\n\n<blockquote>የፋይዳ ሰነድዎ ቅጂ በአሁኑ ሰዓት በሲስተሙ አልተደገፈም።\nThis Fayda document format version is not supported.</blockquote>\n\nእባክዎ ድጋፍ ለማግኘት @birukadiyee ወይም @WWEHID ያነጋግሩ።`,
    shortEn: 'Unsupported Fayda document version.',
    shortAm: 'ያልተደገፈ የፋይዳ ቅጂ።',
  },
  INVALID_SIGNATURE: {
    en: `<b>Digital Signature Failed / ዲጂታል ፊርማው አልተረጋገጠም</b>\n\n<blockquote>The cryptographic signature could not be validated. Only authentic, untampered cards are accepted.\nበዚህ ሰነድ ላይ ያለው ዲጂታል የደህንነት ፊርማ ትክክለኛነቱ አልተረጋገጠም። እባክዎ ያልተበረዘ ትክክለኛ መታወቂያ ይጠቀሙ።</blockquote>`,
    am: `<b>ዲጂታል ፊርማው አልተረጋገጠም / Digital Signature Failed</b>\n\n<blockquote>በዚህ ሰነድ ላይ ያለው ዲጂታል የደህንነት ፊርማ ትክክለኛነቱ አልተረጋገጠም። እባክዎ ያልተበረዘ ትክክለኛ መታወቂያ ይጠቀሙ።\nThe cryptographic signature could not be validated. Only authentic, untampered cards are accepted.</blockquote>`,
    shortEn: 'Digital signature invalid or tampered.',
    shortAm: 'የዲጂታል ደህንነት ፊርማው አልተረጋገጠም።',
  },
  DUPLICATE_FAN: {
    en: `<b>Fayda ID Already Registered / ይህ መታወቂያ ቀደም ሲል ተመዝግቧል</b>\n\n<blockquote>This National ID is already linked to another SpaceMatch account. Each citizen may only register one account.\nይህ ብሔራዊ መታወቂያ በሌላ የስፔስማች አካውንት ላይ ተመዝግቧል።</blockquote>`,
    am: `<b>ይህ መታወቂያ ቀደም ሲል ተመዝግቧል / Fayda ID Already Registered</b>\n\n<blockquote>ይህ ብሔራዊ መታወቂያ በሌላ የስፔስማች አካውንት ላይ ተመዝግቧል።\nThis National ID is already linked to another SpaceMatch account. Each citizen may only register one account.</blockquote>`,
    shortEn: 'This Fayda ID is already registered.',
    shortAm: 'ይህ የፋይዳ መታወቂያ ቀደም ሲል ተመዝግቧል።',
  },
  FILE_TOO_LARGE: {
    en: `<b>File Too Large / ፋይሉ በጣም ትልቅ ነው</b>\n\n<blockquote>The uploaded file exceeds the 10MB limit. Please upload a compressed photo or smaller image.\nየተላከው ፋይል ከተፈቀደው 10 ሜጋባይት መጠን በላይ ነው። እባክዎ መጠኑ ያነሰ ፎቶ ይላኩ።</blockquote>`,
    am: `<b>ፋይሉ በጣም ትልቅ ነው / File Too Large</b>\n\n<blockquote>የተላከው ፋይል ከተፈቀደው 10 ሜጋባይት መጠን በላይ ነው። እባክዎ መጠኑ ያነሰ ፎቶ ይላኩ።\nThe uploaded file exceeds the 10MB limit. Please upload a compressed photo or smaller image.</blockquote>`,
    shortEn: 'File exceeds 10MB limit.',
    shortAm: 'የፋይሉ መጠን ከ 10MB በላይ ነው።',
  },
  MANUAL_TEXT_ENTERED: {
    en: `<b>Photo Upload Required / የፎቶ ማስረጃ ያስፈልጋል</b>\n\n<blockquote>Please upload a photo of the back of your Fayda card showing the QR code. Manual text is not accepted.\nእባክዎ የQR ኮዱ የሚታይበትን የመታወቂያዎን ጀርባ ፎቶ ይላኩ። በጽሁፍ የሚላክ መረጃ ተቀባይነት የለውም።</blockquote>`,
    am: `<b>የፎቶ ማስረጃ ያስፈልጋል / Photo Upload Required</b>\n\n<blockquote>እባክዎ የQR ኮዱ የሚታይበትን የመታወቂያዎን ጀርባ ፎቶ ይላኩ። በጽሁፍ የሚላክ መረጃ ተቀባይነት የለውም።\nPlease upload a photo of the back of your Fayda card showing the QR code. Manual text is not accepted.</blockquote>`,
    shortEn: 'Photo upload required. Please send a photo.',
    shortAm: 'የካርድ ፎቶ መላክ ግዴታ ነው። እባክዎ የመታወቂያዎን ፎቶ ይላኩ።',
  },
};

/**
 * Returns user guidance text for a given Fayda error code in the specified language.
 */
export function getFaydaGuidance(code: FaydaErrorCode, _lang?: 'am' | 'en' | string): string {
  const item = FAYDA_ERROR_GUIDANCE[code] || FAYDA_ERROR_GUIDANCE.QR_UNREADABLE;
  return `${item.en}\n\n${item.am}`;
}

/**
 * Returns user guidance text pair { messageAm, messageEn } for a given Fayda error code.
 * Both fields are enriched with simultaneous bilingual presentation.
 */
export function getFaydaGuidancePair(code: FaydaErrorCode): { messageAm: string; messageEn: string } {
  const item = FAYDA_ERROR_GUIDANCE[code] || FAYDA_ERROR_GUIDANCE.QR_UNREADABLE;
  const combined = `${item.en}\n\n${item.am}`;
  return { messageAm: combined, messageEn: combined };
}

// ─── Telegram File Ingestion (Zero Disk Storage) ─────────────────────────────

export interface ExtractedMediaFile {
  fileId: string;
  fileSize?: number;
  isDocument: boolean;
  mimeType?: string;
}

/**
 * Inspects a Telegram update message to find an uploaded photo or image document.
 * Enforces image mime types and 10MB size boundary.
 */
export function extractMediaFileFromMessage(
  message?: any
): ExtractedMediaFile | { error: FaydaErrorCode; messageAm: string; messageEn: string } | null {
  if (!message) return null;

  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

  // 1. Check compressed photo array
  if (message.photo && Array.isArray(message.photo) && message.photo.length > 0) {
    // Select largest resolution item by pixel area (width * height), falling back to the last element.
    // In Telegram Bot API, file_size is optional and often undefined on the highest resolution photo,
    // which previously caused reduce to mistakenly pick a low-resolution 320px thumbnail.
    const getArea = (p: any) => (Number(p?.width) || 0) * (Number(p?.height) || 0);
    const bestPhoto = message.photo.reduce((prev: any, curr: any) => {
      const prevArea = getArea(prev);
      const currArea = getArea(curr);
      if (currArea > prevArea) return curr;
      if (currArea === prevArea && (Number(curr?.file_size) || 0) > (Number(prev?.file_size) || 0)) return curr;
      return prev;
    }, message.photo[message.photo.length - 1]);

    if (!bestPhoto || !bestPhoto.file_id) {
      return null;
    }

    if (bestPhoto.file_size && bestPhoto.file_size > MAX_FILE_SIZE) {
      return {
        error: 'FILE_TOO_LARGE',
        messageAm: FAYDA_ERROR_GUIDANCE.FILE_TOO_LARGE.am,
        messageEn: FAYDA_ERROR_GUIDANCE.FILE_TOO_LARGE.en,
      };
    }

    return {
      fileId: bestPhoto.file_id,
      fileSize: bestPhoto.file_size,
      isDocument: false,
    };
  }

  // 2. Check uncompressed document
  if (message.document && message.document.file_id) {
    const doc = message.document;
    const mime = (doc.mime_type || '').toLowerCase();
    const fileName = (doc.file_name || '').toLowerCase();

    const isImageMime =
      mime === 'image/jpeg' ||
      mime === 'image/png' ||
      mime === 'image/webp' ||
      mime === 'image/jpg';

    const isImageExt =
      fileName.endsWith('.jpg') ||
      fileName.endsWith('.jpeg') ||
      fileName.endsWith('.png') ||
      fileName.endsWith('.webp');

    if (!isImageMime && !isImageExt) {
      return {
        error: 'QR_UNREADABLE',
        messageEn: `<b>Invalid Document Format / የተሳሳተ የሰነድ አይነት</b>\n\n<blockquote>Please upload a supported image file (JPEG, PNG, or WebP).\nእባክዎ ተቀባይነት ያለው የምስል ሰነድ (JPEG, PNG, ወይም WebP) ይላኩ።</blockquote>`,
        messageAm: `<b>የተሳሳተ የሰነድ አይነት / Invalid Document Format</b>\n\n<blockquote>እባክዎ ተቀባይነት ያለው የምስል ሰነድ (JPEG, PNG, ወይም WebP) ይላኩ።\nPlease upload a supported image file (JPEG, PNG, or WebP).</blockquote>`,
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
 * Photos are never written to disk or third-party buckets.
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
 * Performs pure barcode decoding and cryptographic verification on an uploaded image buffer.
 *
 * Implements:
 * 1. 10MB size guard
 * 2. Multi-pass decoding via `fayda-decoder`
 * 3. Version 4 detached JWS RS256 signature verification against pinned NIDP public key
 * 4. Supabase database uniqueness check (rejects duplicate FANs on different accounts)
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
      message: `${FAYDA_ERROR_GUIDANCE.NO_QR_FOUND.en}\n\n${FAYDA_ERROR_GUIDANCE.NO_QR_FOUND.am}`,
      error: 'Empty image buffer received.',
    };
  }

  if (buffer.byteLength > MAX_BYTES) {
    return {
      success: false,
      errorCode: 'FILE_TOO_LARGE',
      messageAm: FAYDA_ERROR_GUIDANCE.FILE_TOO_LARGE.am,
      messageEn: FAYDA_ERROR_GUIDANCE.FILE_TOO_LARGE.en,
      message: `${FAYDA_ERROR_GUIDANCE.FILE_TOO_LARGE.en}\n\n${FAYDA_ERROR_GUIDANCE.FILE_TOO_LARGE.am}`,
      error: `Uploaded file size (${(buffer.byteLength / 1024 / 1024).toFixed(2)}MB) exceeds 10MB limit.`,
    };
  }

  // 1. Barcode reading & payload extraction
  let decodeResult: FaydaResult;
  try {
    await ensureZXingReady();
    const uint8 = new Uint8Array(buffer);
    decodeResult = await decodeImage(uint8, { includeFace: true });
  } catch (err: any) {
    console.error('[fayda-photo-verifier] decodeImage failed:', err);
    // Sharp or WebAssembly decoding error on corrupt headers / malformed bytes
    return {
      success: false,
      errorCode: 'QR_UNREADABLE',
      messageAm: FAYDA_ERROR_GUIDANCE.QR_UNREADABLE.am,
      messageEn: FAYDA_ERROR_GUIDANCE.QR_UNREADABLE.en,
      message: `${FAYDA_ERROR_GUIDANCE.QR_UNREADABLE.en}\n\n${FAYDA_ERROR_GUIDANCE.QR_UNREADABLE.am}`,
      error: err?.message || 'Failed to process image buffer.',
    };
  }

  // 2. Map decoder failures to standardized error codes
  if (!decodeResult.ok) {
    const code = decodeResult.error.code;
    let mappedCode: FaydaErrorCode = 'QR_UNREADABLE';

    if (code === 'NO_QR_FOUND') mappedCode = 'NO_QR_FOUND';
    else if (code === 'QR_UNREADABLE') mappedCode = 'QR_UNREADABLE';
    else if (code === 'NOT_FAYDA') mappedCode = 'NOT_FAYDA';
    else if (code === 'UNSUPPORTED_VERSION') mappedCode = 'UNSUPPORTED_VERSION';

    return {
      success: false,
      errorCode: mappedCode,
      messageAm: FAYDA_ERROR_GUIDANCE[mappedCode].am,
      messageEn: FAYDA_ERROR_GUIDANCE[mappedCode].en,
      message: `${FAYDA_ERROR_GUIDANCE[mappedCode].en}\n\n${FAYDA_ERROR_GUIDANCE[mappedCode].am}`,
      error: decodeResult.error.message,
    };
  }

  // 3. Structural validation
  const fan = decodeResult.fields.fan;
  if (!fan || !fan.trim()) {
    return {
      success: false,
      errorCode: 'NOT_FAYDA',
      messageAm: FAYDA_ERROR_GUIDANCE.NOT_FAYDA.am,
      messageEn: FAYDA_ERROR_GUIDANCE.NOT_FAYDA.en,
      message: `${FAYDA_ERROR_GUIDANCE.NOT_FAYDA.en}\n\n${FAYDA_ERROR_GUIDANCE.NOT_FAYDA.am}`,
      error: 'Fayda QR payload is missing the Fayda Account Number (FAN).',
    };
  }

  // 4. Detached JWS RS256 signature verification
  const publicKeyPem = options?.customPublicKeyPem || process.env.FAYDA_PUBLIC_KEY_PEM;
  const sigResult = await verifySignature(decodeResult, { publicKeyPem });

  if (!sigResult.verified) {
    return {
      success: false,
      errorCode: 'INVALID_SIGNATURE',
      messageAm: FAYDA_ERROR_GUIDANCE.INVALID_SIGNATURE.am,
      messageEn: FAYDA_ERROR_GUIDANCE.INVALID_SIGNATURE.en,
      message: `${FAYDA_ERROR_GUIDANCE.INVALID_SIGNATURE.en}\n\n${FAYDA_ERROR_GUIDANCE.INVALID_SIGNATURE.am}`,
      error: `Cryptographic digital signature verification failed: ${sigResult.reason || 'Invalid signature'}.`,
    };
  }

  const cleanFan = String(fan).replace(/[\s-]/g, '').trim();

  // 5. Database uniqueness check across accounts (users & roommate_profiles)
  if (chatId) {
    try {
      const { data: existingUser } = await supabaseAdmin
        .from('users')
        .select('id, telegram_id')
        .or(`fayda_id_number.eq.${cleanFan},fayda_id_number.eq.${fan}`)
        .neq('telegram_id', chatId)
        .maybeSingle();

      if (existingUser) {
        return {
          success: false,
          errorCode: 'DUPLICATE_FAN',
          messageAm: FAYDA_ERROR_GUIDANCE.DUPLICATE_FAN.am,
          messageEn: FAYDA_ERROR_GUIDANCE.DUPLICATE_FAN.en,
          message: `${FAYDA_ERROR_GUIDANCE.DUPLICATE_FAN.en}\n\n${FAYDA_ERROR_GUIDANCE.DUPLICATE_FAN.am}`,
          error: 'This Fayda National ID is already registered to another SpaceMatch account.',
        };
      }

      const { data: existingRoommate } = await supabaseAdmin
        .from('roommate_profiles')
        .select('id, telegram_id')
        .or(`fayda_id_number.eq.${cleanFan},fayda_id_number.eq.${fan}`)
        .neq('telegram_id', chatId)
        .maybeSingle();

      if (existingRoommate) {
        return {
          success: false,
          errorCode: 'DUPLICATE_FAN',
          messageAm: FAYDA_ERROR_GUIDANCE.DUPLICATE_FAN.am,
          messageEn: FAYDA_ERROR_GUIDANCE.DUPLICATE_FAN.en,
          message: `${FAYDA_ERROR_GUIDANCE.DUPLICATE_FAN.en}\n\n${FAYDA_ERROR_GUIDANCE.DUPLICATE_FAN.am}`,
          error: 'This Fayda National ID is already registered to another SpaceMatch account.',
        };
      }
    } catch (dbErr) {
      console.warn('[fayda-photo-verifier] Supabase uniqueness check warning:', dbErr);
    }
  }

  const normalizedGender =
    decodeResult.fields.gender === 'M'
      ? 'Male'
      : decodeResult.fields.gender === 'F'
      ? 'Female'
      : decodeResult.fields.gender || '';

  return {
    success: true,
    fan: cleanFan,
    fullName: decodeResult.fields.full_name || '',
    dob: decodeResult.fields.date_of_birth || '',
    gender: normalizedGender,
    isVerified: true,
    verifiedSource: 'telegram_photo_rs256_qr',
    faceBase64: decodeResult.fields.face?.base64 || undefined,
  };
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
  await persistFaydaVerification(chatId, result.fan, result.fullName, {
    gender: result.gender || undefined,
    dob: result.dob || undefined,
    verifiedSource: result.verifiedSource || 'telegram_photo_rs256_qr',
    from,
  });

  return true;
}
