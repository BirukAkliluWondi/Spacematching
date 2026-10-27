/**
 * lib/fayda-qr-decoder.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Offline Fayda National ID (Ethiopia / MOSIP) QR Code Decoder & Checksum Engine.
 *
 * This module parses and validates Ethiopian Fayda ID cards and digital e-Fayda
 * QR code payloads without making any network calls to government/NIDP servers.
 */

// ─── Verhoeff Checksum Algorithm (MOSIP / National ID Standard) ─────────────

// Multiplication table d
const VERHOEFF_D: number[][] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];

// Permutation table p
const VERHOEFF_P: number[][] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

// Inverse table inv
const VERHOEFF_INV: number[] = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

/**
 * Validates a number string using the Verhoeff checksum algorithm.
 */
export function validateVerhoeffChecksum(numStr: string): boolean {
  const digits = numStr.replace(/\D/g, '');
  if (!digits) return false;

  let c = 0;
  const reversedDigits = digits.split('').map(Number).reverse();

  for (let i = 0; i < reversedDigits.length; i++) {
    c = VERHOEFF_D[c][VERHOEFF_P[i % 8][reversedDigits[i]]];
  }

  return c === 0;
}

/**
 * Generates a Verhoeff check digit for an 11-digit or N-digit prefix.
 */
export function generateVerhoeffCheckDigit(numStr: string): number {
  const digits = numStr.replace(/\D/g, '');
  let c = 0;
  const reversedDigits = digits.split('').map(Number).reverse();

  for (let i = 0; i < reversedDigits.length; i++) {
    c = VERHOEFF_D[c][VERHOEFF_P[(i + 1) % 8][reversedDigits[i]]];
  }

  return VERHOEFF_INV[c];
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FaydaDecodedResult {
  success: boolean;
  faydaNumber?: string; // 12-digit normalized string
  fullName?: string;
  gender?: string;
  dob?: string;
  rawType?: string;
  error?: string;
}

// ─── QR Code Parser & Decoder ─────────────────────────────────────────────────

/**
 * Parses and validates an offline Fayda QR code payload.
 * Supports:
 *  1. JSON payloads (standard MOSIP demographic export)
 *  2. Base64-encoded JSON or demographic text
 *  3. URL with query parameters (e.g. id.gov.et verification links)
 *  4. Delimited text strings (e.g. FIN:...|Name:... or UIN:...)
 *  5. Direct 12-digit or 16-digit FIN string extracted via regex
 */
export function decodeFaydaQr(qrData: string): FaydaDecodedResult {
  if (!qrData || typeof qrData !== 'string') {
    return { success: false, error: 'QR data is empty or invalid.' };
  }

  const trimmed = qrData.trim();

  // 1. Try Parsing as Direct JSON
  try {
    const json = JSON.parse(trimmed);
    const result = extractFromJsonObject(json);
    if (result.success) return { ...result, rawType: 'json' };
  } catch {}

  // 2. Try Parsing as Base64 encoded string
  if (/^[A-Za-z0-9+/=]+$/.test(trimmed) && trimmed.length >= 16) {
    try {
      const decodedStr = Buffer.from(trimmed, 'base64').toString('utf-8');
      try {
        const json = JSON.parse(decodedStr);
        const result = extractFromJsonObject(json);
        if (result.success) return { ...result, rawType: 'base64_json' };
      } catch {
        // Try delimited text on decoded base64 string
        const textResult = extractFromTextString(decodedStr);
        if (textResult.success) return { ...textResult, rawType: 'base64_text' };
      }
    } catch {}
  }

  // 3. Try Parsing as URL (e.g. https://id.gov.et/verify?uin=...)
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      const url = new URL(trimmed);
      const uin = url.searchParams.get('uin') ||
                  url.searchParams.get('fin') ||
                  url.searchParams.get('id') ||
                  url.searchParams.get('fayda_id');

      if (uin) {
        const cleanFin = uin.replace(/\D/g, '');
        if (isValidFaydaLength(cleanFin)) {
          return {
            success: true,
            faydaNumber: cleanFin,
            fullName: url.searchParams.get('name') || undefined,
            gender: url.searchParams.get('gender') || undefined,
            dob: url.searchParams.get('dob') || undefined,
            rawType: 'url',
          };
        }
      }
    } catch {}
  }

  // 4. Try Parsing as Delimited Text (key-value pairs, pipe, or colon)
  const textResult = extractFromTextString(trimmed);
  if (textResult.success) return { ...textResult, rawType: 'text' };

  // 5. Fallback: Search for any 12-digit number sequence
  const finMatch = trimmed.match(/\b\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/);
  if (finMatch) {
    const cleanFin = finMatch[0].replace(/\D/g, '');
    if (cleanFin.length === 12) {
      return {
        success: true,
        faydaNumber: cleanFin,
        rawType: 'regex_fin',
      };
    }
  }

  return {
    success: false,
    error: 'Unrecognized Fayda QR code format. Please ensure you are scanning an authentic Ethiopian Fayda National ID card or e-Fayda document.',
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isValidFaydaLength(numStr: string): boolean {
  return numStr.length === 12 || numStr.length === 16;
}

function extractFromJsonObject(obj: Record<string, any>): FaydaDecodedResult {
  const fin = obj.uin || obj.fin || obj.fayda_number || obj.fayda_id || obj.id || obj.UIN || obj.FIN;
  if (!fin) return { success: false };

  const cleanFin = String(fin).replace(/\D/g, '');
  if (!isValidFaydaLength(cleanFin)) return { success: false };

  const name = obj.name || obj.fullName || obj.full_name || obj.resident_name || obj.NAME;
  const gender = obj.gender || obj.sex || obj.GENDER;
  const dob = obj.dob || obj.dateOfBirth || obj.birthDate || obj.DOB;

  return {
    success: true,
    faydaNumber: cleanFin,
    fullName: typeof name === 'string' ? name.trim() : undefined,
    gender: typeof gender === 'string' ? gender.trim() : undefined,
    dob: typeof dob === 'string' ? dob.trim() : undefined,
  };
}

function extractFromTextString(text: string): FaydaDecodedResult {
  // Check for common Fayda demographic markers
  let fin: string | undefined;
  let name: string | undefined;
  let gender: string | undefined;
  let dob: string | undefined;

  const finMatch = text.match(/(?:UIN|FIN|Fayda|ID)[:=\s]+([0-9\s-]{12,16})/i);
  if (finMatch) {
    const candidate = finMatch[1].replace(/\D/g, '');
    if (isValidFaydaLength(candidate)) fin = candidate;
  }

  const nameMatch = text.match(/(?:Name|Full Name|Resident)[:=\s]+([^\n\r,|]+)/i);
  if (nameMatch) name = nameMatch[1].trim();

  const genderMatch = text.match(/(?:Gender|Sex)[:=\s]+(Male|Female|M|F)/i);
  if (genderMatch) gender = genderMatch[1].trim();

  const dobMatch = text.match(/(?:DOB|Date of Birth|Birth)[:=\s]+([0-9\s\/-]{8,12})/i);
  if (dobMatch) dob = dobMatch[1].trim();

  if (fin) {
    return {
      success: true,
      faydaNumber: fin,
      fullName: name,
      gender,
      dob,
    };
  }

  return { success: false };
}

import { validateFaydaStructure } from '@/lib/fayda-verification';

/**
 * Validates a directly typed or pasted Fayda FAN / FIN number.
 * - Strips whitespace, hyphens, and non-digits.
 * - Accepts 12-digit FIN (with Verhoeff checksum validation).
 * - Accepts 16-digit FAN/VID format with MOSIP Verhoeff / Luhn checksum & pattern checks.
 */
export function validateFaydaFan(input: string): {
  valid: boolean;
  fanNumber?: string;
  error?: string;
} {
  return validateFaydaStructure(input);
}
