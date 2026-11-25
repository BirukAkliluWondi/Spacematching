/**
 * lib/fayda-qr-decoder.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Universal Offline Fayda National ID (Ethiopia / MOSIP) QR Code Decoder.
 *
 * Supports:
 *  1. MOSIP Claim 169 (Base45 -> zlib Inflate -> CBOR/CWT / COSE_Sign1)
 *  2. Raw CBOR / CWT binary structures
 *  3. JSON payloads (standard MOSIP demographic exports)
 *  4. Base64-encoded JSON or demographic text
 *  5. NIDP Verification URLs (id.gov.et / resident.fayda.et)
 *  6. Delimited text strings (FIN:...|Name:... or UIN:...)
 *  7. Direct 12-digit FIN or 16-digit FAN fallback with anti-spoofing guards
 */

import zlib from 'zlib';
import { decode as decodeCbor } from 'cbor-x';
import { decodePayload } from 'fayda-decoder';
import { validateFaydaStructure } from '@/lib/fayda-verification';

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

// ─── RFC 9285 Base45 Decoder ──────────────────────────────────────────────────

const B45_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
const B45_LOOKUP = new Int16Array(256).fill(-1);
for (let i = 0; i < B45_CHARSET.length; i++) {
  B45_LOOKUP[B45_CHARSET.charCodeAt(i)] = i;
}

/**
 * Decodes an RFC 9285 Base45 string into a Uint8Array.
 */
export function decodeBase45(input: string): Uint8Array | null {
  if (typeof input !== 'string') return null;
  // Strip whitespace, carriage returns, newlines, and non-base45 control characters
  const clean = input.replace(/[\r\n\t]/g, '').trim();
  const len = clean.length;
  if (len === 0) return null;

  const out: number[] = [];
  let i = 0;

  try {
    while (i < len) {
      const remaining = len - i;
      if (remaining >= 3) {
        const c1 = B45_LOOKUP[clean.charCodeAt(i)];
        const c2 = B45_LOOKUP[clean.charCodeAt(i + 1)];
        const c3 = B45_LOOKUP[clean.charCodeAt(i + 2)];

        if (c1 === -1 || c2 === -1 || c3 === -1) return null;

        const val = c1 + c2 * 45 + c3 * 2025;
        if (val > 65535) return null;

        out.push(Math.floor(val / 256), val % 256);
        i += 3;
      } else if (remaining === 2) {
        const c1 = B45_LOOKUP[clean.charCodeAt(i)];
        const c2 = B45_LOOKUP[clean.charCodeAt(i + 1)];

        if (c1 === -1 || c2 === -1) return null;

        const val = c1 + c2 * 45;
        if (val > 255) return null;

        out.push(val);
        i += 2;
      } else {
        return null;
      }
    }
    return new Uint8Array(out);
  } catch {
    return null;
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FaydaDecodedResult {
  success: boolean;
  faydaNumber?: string; // 12-digit or 16-digit normalized string
  fullName?: string;
  gender?: string;
  dob?: string;
  phone?: string;
  rawType?: string;
  error?: string;
}

// ─── QR Code Parser & Decoder ─────────────────────────────────────────────────

/**
 * Parses and validates an offline Fayda QR code payload across all official
 * and real-world Ethiopian ID formats.
 */
export function decodeFaydaQr(qrData: string | Uint8Array | Buffer): FaydaDecodedResult {
  if (!qrData) {
    return { success: false, error: 'QR data is empty or invalid.' };
  }

  // Convert buffer to string if needed
  let rawStr = '';
  let rawBytes: Buffer | null = null;

  if (typeof qrData === 'string') {
    rawStr = qrData.trim();
  } else {
    rawBytes = Buffer.from(qrData);
    rawStr = rawBytes.toString('utf-8').trim();
  }

  // 0. Try Fayda V4 Payload (:DLT: / :SIGN: / :A:)
  if (rawStr && (rawStr.includes(':DLT:') || rawStr.includes(':SIGN:') || rawStr.includes(':A:'))) {
    try {
      // Direct string-split parsing for maximum resilience (independent of library version restrictions)
      const dltIdx = rawStr.indexOf(':DLT:');
      const rest = dltIdx !== -1 ? rawStr.slice(dltIdx + 5) : rawStr;
      const signIdx = rest.indexOf(':SIGN:');
      const fieldsStr = signIdx !== -1 ? rest.slice(0, signIdx) : rest;
      const parts = fieldsStr.split(':');
      const directName = parts[0]?.trim() || '';
      const map: Record<string, string> = {};
      for (let i = 1; i + 1 < parts.length; i += 2) {
        map[parts[i]] = parts[i + 1];
      }
      const rawFan = map['A'] || map['FIN'] || map['UIN'] || map['FAN'];
      if (rawFan) {
        const cleanFan = rawFan.replace(/\D/g, '');
        const struct = validateFaydaStructure(cleanFan);
        if (struct.valid) {
          const rawGen = (map['G'] || '').toUpperCase();
          const normGender = rawGen === 'M' ? 'Male' : rawGen === 'F' ? 'Female' : rawGen || undefined;
          return {
            success: true,
            faydaNumber: struct.fanNumber || cleanFan,
            fullName: directName || undefined,
            gender: normGender,
            dob: map['D'] || undefined,
            rawType: 'fayda_v4_direct',
          };
        }
      }

      // Also try official fayda-decoder
      const v4 = decodePayload(rawStr);
      if (v4.ok && v4.fields?.fan) {
        const cleanFan = String(v4.fields.fan).replace(/\D/g, '');
        const struct = validateFaydaStructure(cleanFan);
        if (struct.valid) {
          const rawGen = String(v4.fields.gender || '').toUpperCase();
          const normGender =
            rawGen === 'M' || rawGen === 'MALE'
              ? 'Male'
              : rawGen === 'F' || rawGen === 'FEMALE'
              ? 'Female'
              : (v4.fields.gender as string) || undefined;

          return {
            success: true,
            faydaNumber: struct.fanNumber || cleanFan,
            fullName: v4.fields.full_name || undefined,
            gender: normGender,
            dob: v4.fields.date_of_birth || undefined,
            rawType: 'fayda_v4_payload',
          };
        }
      } else if (v4.raw?.map) {
        const rawFanFromMap = v4.raw.map['A'] || v4.raw.map['UIN'] || v4.raw.map['FIN'];
        if (rawFanFromMap) {
          const cleanFan = String(rawFanFromMap).replace(/\D/g, '');
          const struct = validateFaydaStructure(cleanFan);
          if (struct.valid) {
            return {
              success: true,
              faydaNumber: struct.fanNumber || cleanFan,
              fullName: directName || undefined,
              gender: v4.raw.map['G'] === 'M' ? 'Male' : v4.raw.map['G'] === 'F' ? 'Female' : undefined,
              dob: v4.raw.map['D'] || undefined,
              rawType: 'fayda_v4_raw_map',
            };
          }
        }
      }
    } catch {}
  }

  // 1. Try MOSIP Claim 169 via RFC 9285 Base45
  if (rawStr) {
    const cleanB45 = rawStr.replace(/^(?:C169|MOSIP|ETH|FAYDA|HC1|M|1)[:=\s]+/i, '').replace(/[\r\n\t]/g, '').trim();
    const b45Bytes = decodeBase45(cleanB45) || decodeBase45(rawStr.replace(/[\r\n\t]/g, '').trim());
    if (b45Bytes && b45Bytes.length > 4) {
      const cborRes = extractFromCborPayload(b45Bytes);
      if (cborRes.success) return { ...cborRes, rawType: 'mosip_claim169_base45' };
    }
  }

  // 2. Try Raw Binary / Buffer as CBOR or compressed zlib/brotli
  if (rawBytes) {
    const cborRes = extractFromCborPayload(rawBytes);
    if (cborRes.success) return { ...cborRes, rawType: 'mosip_claim169_raw' };
  }

  // 3. Try Parsing as Base64 encoded CBOR or JSON
  if (rawStr && /^[A-Za-z0-9+/=]+$/.test(rawStr) && rawStr.length >= 16) {
    try {
      const b64Buf = Buffer.from(rawStr, 'base64');
      // Try CBOR first
      const cborRes = extractFromCborPayload(b64Buf);
      if (cborRes.success) return { ...cborRes, rawType: 'mosip_claim169_base64' };

      // Try decoded string
      const decodedStr = b64Buf.toString('utf-8');
      try {
        const json = JSON.parse(decodedStr);
        const result = extractFromJsonObject(json);
        if (result.success) return { ...result, rawType: 'base64_json' };
      } catch {
        const textResult = extractFromTextString(decodedStr);
        if (textResult.success) return { ...textResult, rawType: 'base64_text' };
      }
    } catch {}
  }

  // 4. Try Direct JSON
  if (rawStr) {
    try {
      const json = JSON.parse(rawStr);
      const result = extractFromJsonObject(json);
      if (result.success) return { ...result, rawType: 'json' };
    } catch {}
  }

  // 5. Try Official NIDP URL (strictly id.gov.et, fayda.et, nidp.gov.et, or fayda.gov.et domains)
  if (rawStr && (rawStr.startsWith('http://') || rawStr.startsWith('https://'))) {
    try {
      const url = new URL(rawStr);
      const host = url.hostname.toLowerCase();
      const isOfficialFaydaHost =
        host === 'id.gov.et' ||
        host.endsWith('.id.gov.et') ||
        host === 'fayda.et' ||
        host.endsWith('.fayda.et') ||
        host === 'nidp.gov.et' ||
        host.endsWith('.nidp.gov.et') ||
        host === 'fayda.gov.et' ||
        host.endsWith('.fayda.gov.et');

      if (isOfficialFaydaHost) {
        let uin =
          url.searchParams.get('uin') ||
          url.searchParams.get('fin') ||
          url.searchParams.get('id') ||
          url.searchParams.get('fayda_id') ||
          url.searchParams.get('fan');

        if (!uin) {
          const pathMatches = url.pathname.match(/\b\d{12}\b|\b\d{16}\b/);
          if (pathMatches) uin = pathMatches[0];
        }

        if (uin) {
          const cleanFin = uin.replace(/\D/g, '');
          const struct = validateFaydaStructure(cleanFin);
          if (struct.valid) {
            return {
              success: true,
              faydaNumber: struct.fanNumber || cleanFin,
              fullName: url.searchParams.get('name') || url.searchParams.get('full_name') || undefined,
              gender: url.searchParams.get('gender') || undefined,
              dob: url.searchParams.get('dob') || undefined,
              rawType: 'url',
            };
          }
        }
      }
    } catch {}
  }

  // 6. Try Delimited Text (key-value pairs, pipe, colon)
  if (rawStr) {
    const textResult = extractFromTextString(rawStr);
    if (textResult.success) return { ...textResult, rawType: 'text' };
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

/**
 * Extracts demographic claims from a CBOR / CWT / MOSIP Claim 169 structure.
 * Supports:
 *  - zlib (inflate, inflateRaw) and Brotli compression
 *  - Standard MOSIP Claim 169 integer keys (1=UIN, 4=Name, 8=DOB, 9=Gender, 12=Phone)
 *  - String and named attribute keys
 */
function extractFromCborPayload(bytes: Uint8Array | Buffer): FaydaDecodedResult {
  try {
    let cborBytes: Buffer = Buffer.from(bytes);

    // 1. Try decompressing zlib/deflate or brotli if compressed
    try {
      cborBytes = zlib.inflateSync(cborBytes);
    } catch {
      try {
        cborBytes = zlib.inflateRawSync(cborBytes);
      } catch {
        try {
          cborBytes = zlib.brotliDecompressSync(cborBytes);
        } catch {
          // Raw uncompressed CBOR
        }
      }
    }

    // 2. Decode CBOR
    let decoded: any;
    try {
      decoded = decodeCbor(cborBytes);
    } catch {
      return { success: false };
    }
    if (!decoded) return { success: false };

    // Helper to unwrap cbor-x Tag instances recursively
    const unwrapTag = (val: any): any => {
      let cur = val;
      while (cur && typeof cur === 'object' && ('value' in cur || 'tag' in cur)) {
        if ('value' in cur && cur.value !== undefined) {
          cur = cur.value;
        } else {
          break;
        }
      }
      return cur;
    };

    let unwrapped = unwrapTag(decoded);

    // 3. Unwrap COSE_Sign1 or CWT array [protected, unprotected, payload, signature]
    let claims: any = unwrapped;
    if (Array.isArray(unwrapped) && unwrapped.length >= 3) {
      const payloadCandidate = unwrapped[2];
      if (Buffer.isBuffer(payloadCandidate) || payloadCandidate instanceof Uint8Array) {
        let payloadBuf = Buffer.from(payloadCandidate);
        try { payloadBuf = zlib.inflateSync(payloadBuf); } catch {}
        try { payloadBuf = zlib.inflateRawSync(payloadBuf); } catch {}
        try { payloadBuf = zlib.brotliDecompressSync(payloadBuf); } catch {}
        try {
          claims = decodeCbor(payloadBuf);
        } catch {
          claims = payloadCandidate;
        }
      }
    }

    claims = unwrapTag(claims);

    // 4. Resolve Claim 169 (identity-data) or root claims
    let identityData: any =
      (claims instanceof Map
        ? claims.get(169) || claims.get('169')
        : claims?.[169] || claims?.['169']) || claims;

    identityData = unwrapTag(identityData);

    // If Claim 169 is serialized as a nested CBOR byte string (bstr .cbor IdentityData per MOSIP spec), decode it
    if (Buffer.isBuffer(identityData) || identityData instanceof Uint8Array) {
      try {
        let innerBuf: Buffer = Buffer.from(identityData);
        try { innerBuf = zlib.inflateSync(innerBuf); } catch {}
        try { innerBuf = zlib.inflateRawSync(innerBuf); } catch {}
        try { innerBuf = zlib.brotliDecompressSync(innerBuf); } catch {}
        const innerDecoded = decodeCbor(innerBuf);
        if (innerDecoded && typeof innerDecoded === 'object') {
          identityData = unwrapTag(innerDecoded);
        }
      } catch {}
    }

    if (!identityData || typeof identityData !== 'object') {
      return { success: false };
    }

    const getVal = (keys: (string | number)[]): any => {
      if (!identityData) return undefined;
      for (const k of keys) {
        if (identityData instanceof Map) {
          if (identityData.has(k)) return identityData.get(k);
          const num = Number(k);
          if (!isNaN(num) && identityData.has(num)) return identityData.get(num);
          const str = String(k);
          if (identityData.has(str)) return identityData.get(str);
        } else if (typeof identityData === 'object') {
          if (identityData[k] !== undefined) return identityData[k];
          const str = String(k);
          if (identityData[str] !== undefined) return identityData[str];
        }
      }
      return undefined;
    };

    // Key 1 in MOSIP Claim 169 is UIN / ID, Key 2 is sub (Subject ID)
    let fin = getVal([
      1, '1',
      2, '2',
      'uin', 'fin', 'fayda_number', 'fayda_id', 'id',
      'UIN', 'FIN', 'sub', 'fan', 'FAN'
    ]);

    // Handle binary-encoded UIN buffer or byte array
    if (Buffer.isBuffer(fin) || fin instanceof Uint8Array) {
      fin = Buffer.from(fin).toString('utf-8');
    }

    // Fallback: Recursively search CBOR structure if direct key was absent (exclude Ethiopian phone numbers)
    if (!fin) {
      const isPhoneLike = (s: string) => /^(?:251|0)[79]\d{8}$/.test(s);
      const findFaydaNumberRecursive = (node: any): string | null => {
        if (!node) return null;
        if (typeof node === 'string') {
          const clean = node.replace(/\D/g, '');
          if ((clean.length === 12 || clean.length === 16) && !isPhoneLike(clean)) return clean;
        }
        if (typeof node === 'number') {
          const s = String(node);
          if ((s.length === 12 || s.length === 16) && !isPhoneLike(s)) return s;
        }
        if (Buffer.isBuffer(node) || node instanceof Uint8Array) {
          const s = Buffer.from(node).toString('utf-8');
          const clean = s.replace(/\D/g, '');
          if ((clean.length === 12 || clean.length === 16) && !isPhoneLike(clean)) return clean;
        }
        if (node instanceof Map) {
          for (const [k, v] of node.entries()) {
            const found = findFaydaNumberRecursive(v);
            if (found) return found;
          }
        } else if (typeof node === 'object') {
          for (const key of Object.keys(node)) {
            const found = findFaydaNumberRecursive(node[key]);
            if (found) return found;
          }
        }
        return null;
      };
      fin = findFaydaNumberRecursive(identityData) || findFaydaNumberRecursive(claims);
    }

    if (!fin) return { success: false };

    const cleanFin = String(fin).replace(/\D/g, '');
    const finStruct = validateFaydaStructure(cleanFin);
    if (!finStruct.valid) return { success: false };

    // Key 4: Full Name, Key 5: First Name, 6: Middle Name, 7: Last Name, Key 19: Secondary (Amharic) Name
    let name = getVal([4, '4', 'name', 'fullName', 'full_name', 'resident_name', 'NAME', 'residentName']);
    if (Buffer.isBuffer(name) || name instanceof Uint8Array) {
      name = Buffer.from(name).toString('utf-8');
    }
    if (!name) {
      name = getVal([19, '19', 'secondaryName', 'nameAm', 'fullNameAm']);
      if (Buffer.isBuffer(name) || name instanceof Uint8Array) {
        name = Buffer.from(name).toString('utf-8');
      }
    }
    if (!name) {
      const first = getVal([5, '5', 'firstName', 'first_name']);
      const middle = getVal([6, '6', 'middleName', 'middle_name']);
      const last = getVal([7, '7', 'lastName', 'last_name', 'surname']);
      if (first || last) {
        name = [first, middle, last].filter(Boolean).map(v => Buffer.isBuffer(v) ? Buffer.from(v).toString('utf-8') : String(v)).join(' ');
      }
    }

    // Key 9: Gender (1 = Male, 2 = Female, or 'M'/'F'/'Male'/'Female')
    let rawGender = getVal([9, '9', 'gender', 'sex', 'GENDER', 'Sex']);
    let gender: string | undefined;
    if (rawGender === 1 || rawGender === '1' || rawGender === 'M' || String(rawGender).toLowerCase() === 'male') {
      gender = 'Male';
    } else if (rawGender === 2 || rawGender === '2' || rawGender === 'F' || String(rawGender).toLowerCase() === 'female') {
      gender = 'Female';
    } else if (rawGender) {
      gender = String(rawGender);
    }

    // Key 8: Date of Birth (YYYYMMDD or YYYY-MM-DD or YYYY/MM/DD)
    let rawDob = getVal([8, '8', 'dob', 'dateOfBirth', 'birthDate', 'DOB', 'DateOfBirth']);
    let dob: string | undefined;
    if (rawDob) {
      const dobStr = String(rawDob).replace(/\D/g, '');
      if (dobStr.length === 8) {
        dob = `${dobStr.slice(0, 4)}-${dobStr.slice(4, 6)}-${dobStr.slice(6, 8)}`;
      } else {
        dob = String(rawDob);
      }
    }

    // Key 12: Phone number
    const phone = getVal([12, '12', 'phone', 'phoneNumber', 'mobile']);

    return {
      success: true,
      faydaNumber: cleanFin,
      fullName: typeof name === 'string' ? name.trim() : undefined,
      gender,
      dob,
      phone: typeof phone === 'string' ? phone.trim() : undefined,
    };
  } catch {
    return { success: false };
  }
}

function extractFromJsonObject(obj: Record<string, any>): FaydaDecodedResult {
  const fin =
    obj.uin ||
    obj.fin ||
    obj.fayda_number ||
    obj.fayda_id ||
    obj.id ||
    obj.UIN ||
    obj.FIN ||
    obj.fan ||
    obj.FAN;
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
  let fin: string | undefined;
  let name: string | undefined;
  let gender: string | undefined;
  let dob: string | undefined;

  const finMatch = text.match(/(?:UIN|FIN|FAN|Fayda|ID|A)[:=\s]+([0-9\s-]{12,19})/i);
  if (finMatch) {
    const candidate = finMatch[1].replace(/\D/g, '');
    const struct = validateFaydaStructure(candidate);
    if (struct.valid) fin = struct.fanNumber || candidate;
  }

  const nameMatch = text.match(/(?:Name|Full Name|Resident)[:=\s]+([^\n\r,|:]+)/i);
  if (nameMatch) name = nameMatch[1].trim();

  const genderMatch = text.match(/(?:Gender|Sex|G)[:=\s]+(Male|Female|M|F)/i);
  if (genderMatch) {
    const g = genderMatch[1].trim().toUpperCase();
    gender = g === 'M' || g === 'MALE' ? 'Male' : g === 'F' || g === 'FEMALE' ? 'Female' : g;
  }

  const dobMatch = text.match(/(?:DOB|Date of Birth|Birth|D)[:=\s]+([0-9\s\/-]{8,12})/i);
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

/**
 * Validates a directly typed or pasted Fayda FAN / FIN number.
 */
export function validateFaydaFan(input: string): {
  valid: boolean;
  fanNumber?: string;
  error?: string;
} {
  return validateFaydaStructure(input);
}
