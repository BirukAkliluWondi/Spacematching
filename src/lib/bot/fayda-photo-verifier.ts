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

import { decodeImage, type FaydaResult } from 'fayda-decoder';
import { verifySignature } from 'fayda-decoder/verify';
import { supabaseAdmin } from '@/lib/supabase-server';
import { persistFaydaVerification } from '@/lib/fayda-verification';

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
}

export interface FaydaErrorResult {
  success: false;
  errorCode: FaydaErrorCode;
  messageAm: string;
  messageEn: string;
  error?: string;
}

export type FaydaVerificationResult = FaydaSuccessResult | FaydaErrorResult;

// ─── Standardized Bilingual Guidance Registry ────────────────────────────────

export const FAYDA_ERROR_GUIDANCE: Record<
  FaydaErrorCode,
  { en: string; am: string; shortEn: string; shortAm: string }
> = {
  NO_QR_FOUND: {
    en: `⚠️ <b>No QR Code Detected</b>\n\n<blockquote>• Please flip your card over: the QR code is on the <b>back of the Fayda card</b>.\n• Ensure the entire card is clearly visible inside the photo frame.</blockquote>\n\n📸 <b>Please take a new photo of the back of your card:</b>`,
    am: `⚠️ <b>የፋይዳ QR ኮድ አልተገኘም</b>\n\n<blockquote>• እባክዎ የመታወቂያዎን ጀርባ ይመልከቱ: የQR ኮዱ የሚገኘው በ<b>ፋይዳ ካርድ ጀርባ</b> ላይ ነው።\n• ሙሉው ካርድ በፎቶው ውስጥ በግልጽ እንዲታይ ያድርጉ።</blockquote>\n\n📸 <b>እባክዎ የመታወቂያዎን ጀርባ አዲስ ፎቶ ያንሱ:</b>`,
    shortEn: 'No QR code detected. Please photograph the back of your card.',
    shortAm: 'የፋይዳ QR ኮድ አልተገኘም። እባክዎ የመታወቂያዎን ጀርባ ፎቶ ያንሱ።',
  },
  QR_UNREADABLE: {
    en: `⚠️ <b>QR Code Unreadable (Blurry or Glare)</b>\n\n<blockquote>• Avoid glare or flash reflections on the card.\n• Move to a well-lit area and hold your phone steady.\n• Get close enough so the QR squares look sharp and crisp.</blockquote>\n\n📸 <b>Please retake a clear, well-lit photo:</b>`,
    am: `⚠️ <b>QR ኮዱ አልተነበበም (የደበዘዘ ወይም ነጸብራቅ ያለው)</b>\n\n<blockquote>• በካርዱ ላይ የፍላሽ ነጸብራቅ ወይም ጥላ እንዳይኖር ያድርጉ።\n• በቂ ብርሃን ወዳለበት ቦታ በመሄድ ስልክዎን ሳያንቀጠቅጡ ያንሱ።\n• የQR ኮዱ በግልጽ እስኪታይ ድረስ ቀረብ ብለው ያንሱ።</blockquote>\n\n📸 <b>እባክዎ ጥራት ያለው አዲስ ፎቶ ይላኩ:</b>`,
    shortEn: 'QR code blurry or unreadable. Please upload a sharper photo.',
    shortAm: 'የQR ኮዱ አልተነበበም። እባክዎ ጥራት ያለው አዲስ ፎቶ ይላኩ።',
  },
  NOT_FAYDA: {
    en: `⚠️ <b>Not an Authentic Fayda ID</b>\n\n<blockquote>The scanned QR code is not recognized as an Ethiopian National Fayda ID.</blockquote>\n\n📸 <b>Please upload a genuine Ethiopian Fayda National ID card:</b>`,
    am: `⚠️ <b>ትክክለኛ የፋይዳ መታወቂያ አይደለም</b>\n\n<blockquote>የተላከው QR ኮድ የኢትዮጵያ ብሔራዊ የፋይዳ መታወቂያ መረጃ አልያዘም።</blockquote>\n\n📸 <b>እባክዎ ትክክለኛ የፋይዳ ብሔራዊ መታወቂያ ካርድ ፎቶ ይላኩ:</b>`,
    shortEn: 'Not recognized as an authentic Ethiopian Fayda ID.',
    shortAm: 'ትክክለኛ የኢትዮጵያ ፋይዳ ብሔራዊ መታወቂያ አልተገኘም።',
  },
  UNSUPPORTED_VERSION: {
    en: `⚠️ <b>Unsupported Fayda Version</b>\n\n<blockquote>Your Fayda document format version is not currently supported.</blockquote>\n\n💬 <b>Please contact support @birukadiyee or @WWEHID.</b>`,
    am: `⚠️ <b>ያልተደገፈ የፋይዳ ቅጂ</b>\n\n<blockquote>የፋይዳ ሰነድዎ ቅጂ በአሁኑ ሰዓት በሲስተሙ አልተደገፈም።</blockquote>\n\n💬 <b>እባክዎ ድጋፍ ለማግኘት @birukadiyee ወይም @WWEHID ያነጋግሩ።</b>`,
    shortEn: 'Unsupported Fayda document version.',
    shortAm: 'ያልተደገፈ የፋይዳ ቅጂ።',
  },
  INVALID_SIGNATURE: {
    en: `⚠️ <b>Digital Signature Verification Failed</b>\n\n<blockquote>The cryptographic signature on this Fayda document could not be validated. Only authentic, untampered cards are accepted.</blockquote>\n\n📸 <b>Please upload an original Fayda ID document:</b>`,
    am: `⚠️ <b>ዲጂታል ፊርማው አልተረጋገጠም</b>\n\n<blockquote>በዚህ ሰነድ ላይ ያለው ዲጂታል የደህንነት ፊርማ ትክክለኛነቱ አልተረጋገጠም። እባክዎ ያልተበረዘ ትክክለኛ መታወቂያ ይጠቀሙ።</blockquote>\n\n📸 <b>እባክዎ ኦሪጅናል የፋይዳ መታወቂያዎን ይላኩ:</b>`,
    shortEn: 'Digital signature invalid or tampered.',
    shortAm: 'የዲጂታል ደህንነት ፊርማው አልተረጋገጠም።',
  },
  DUPLICATE_FAN: {
    en: `⚠️ <b>Fayda ID Already Registered</b>\n\n<blockquote>This National ID is already linked to another SpaceMatch account. Each citizen may only register one account.</blockquote>`,
    am: `⚠️ <b>ይህ የፋይዳ ቁጥር ቀደም ሲል ተመዝግቧል</b>\n\n<blockquote>ይህ ብሔራዊ መታወቂያ በሌላ የስፔስማች አካውንት ላይ ተመዝግቧል። እያንዳንዱ ዜጋ መመዝገብ የሚችለው አንድ አካውንት ብቻ ነው።</blockquote>`,
    shortEn: 'This Fayda ID is already registered to another account.',
    shortAm: 'ይህ የፋይዳ ቁጥር ቀደም ሲል በሌላ አካውንት ተመዝግቧል።',
  },
  FILE_TOO_LARGE: {
    en: `⚠️ <b>File Too Large</b>\n\n<blockquote>The uploaded file exceeds the 10MB size limit. Please upload a compressed photo or smaller image.</blockquote>`,
    am: `⚠️ <b>ፋይሉ በጣም ትልቅ ነው</b>\n\n<blockquote>የተላከው ፋይል ከተፈቀደው 10 ሜጋባይት መጠን በላይ ነው። እባክዎ መጠኑ ያነሰ ፎቶ ይላኩ።</blockquote>`,
    shortEn: 'File exceeds 10MB limit.',
    shortAm: 'የፋይሉ መጠን ከ 10MB በላይ ነው።',
  },
  MANUAL_TEXT_ENTERED: {
    en: `⚠️ <b>Photo Upload Required</b>\n\n<blockquote>Manual typing of Fayda FAN digits is no longer accepted for security reasons.</blockquote>\n\n📸 <b>Please send a photo or document of your Fayda ID card showing the QR code:</b>`,
    am: `⚠️ <b>የፎቶ ማስረጃ ያስፈልጋል</b>\n\n<blockquote>ለደህንነት ሲባል የፋይዳ ቁጥርን በጽሁፍ ማስገባት አይፈቀድም።</blockquote>\n\n📸 <b>እባክዎ የQR ኮዱ የሚታይበትን የመታወቂያዎን ጀርባ ፎቶ ወይም ሰነድ ይላኩ:</b>`,
    shortEn: 'Manual typing rejected. Photo upload is required.',
    shortAm: 'በጽሁፍ ማስገባት አይፈቀድም። ፎቶ መላክ ግዴታ ነው።',
  },
};

/**
 * Returns user guidance text for a given Fayda error code in the specified language.
 */
export function getFaydaGuidance(code: FaydaErrorCode, lang: 'am' | 'en' = 'en'): string {
  const item = FAYDA_ERROR_GUIDANCE[code] || FAYDA_ERROR_GUIDANCE.QR_UNREADABLE;
  return lang === 'am' ? item.am : item.en;
}

/**
 * Returns user guidance text pair { messageAm, messageEn } for a given Fayda error code.
 */
export function getFaydaGuidancePair(code: FaydaErrorCode): { messageAm: string; messageEn: string } {
  const item = FAYDA_ERROR_GUIDANCE[code] || FAYDA_ERROR_GUIDANCE.QR_UNREADABLE;
  return { messageAm: item.am, messageEn: item.en };
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
    // Select largest resolution item
    const bestPhoto = message.photo.reduce((prev: any, curr: any) =>
      (curr?.file_size ?? 0) > (prev?.file_size ?? 0) ? curr : prev
    );

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
        messageEn: `⚠️ <b>Invalid Document Format</b>\n\nThe uploaded document is not a supported image format. Please send a clear photo or image file (JPEG, PNG, or WebP).`,
        messageAm: `⚠️ <b>የተሳሳተ የሰነድ አይነት</b>\n\nየተላከው ሰነድ ተቀባይነት ያለው የምስል አይነት አይደለም። እባክዎ ጥራት ያለው ፎቶ ወይም የምስል ሰነድ (JPEG, PNG, ወይም WebP) ይላኩ።`,
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
      error: 'Empty image buffer received.',
    };
  }

  if (buffer.byteLength > MAX_BYTES) {
    return {
      success: false,
      errorCode: 'FILE_TOO_LARGE',
      messageAm: FAYDA_ERROR_GUIDANCE.FILE_TOO_LARGE.am,
      messageEn: FAYDA_ERROR_GUIDANCE.FILE_TOO_LARGE.en,
      error: `Uploaded file size (${(buffer.byteLength / 1024 / 1024).toFixed(2)}MB) exceeds 10MB limit.`,
    };
  }

  // 1. Barcode reading & payload extraction
  let decodeResult: FaydaResult;
  try {
    const uint8 = new Uint8Array(buffer);
    decodeResult = await decodeImage(uint8, { includeFace: false });
  } catch (err: any) {
    // Sharp or WebAssembly decoding error on corrupt headers / malformed bytes
    return {
      success: false,
      errorCode: 'QR_UNREADABLE',
      messageAm: FAYDA_ERROR_GUIDANCE.QR_UNREADABLE.am,
      messageEn: FAYDA_ERROR_GUIDANCE.QR_UNREADABLE.en,
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
