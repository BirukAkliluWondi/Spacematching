/**
 * scripts/helpers/synthetic-fayda.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Zero-Network In-Memory Synthetic Fayda National ID QR Generator & Fixtures.
 *
 * Implements NIDP Version 4 payload construction, compact detached JWS RS256
 * cryptographic signing, and barcode synthesis via `zxing-wasm/writer`.
 *
 * Provides:
 *  1. Authentic NIDP V4 QR code with valid RS256 signature
 *  2. Non-Fayda QR code (standard URLs or plain text)
 *  3. Tampered / Invalid signature Fayda QR code
 *  4. Corrupted / unparseable QR code (noise, broken headers)
 *  5. Direct test key management and offline payload verification helpers
 */

import crypto from 'crypto';
import { writeBarcode } from 'zxing-wasm/writer';
import { decodeImage, decodePayload, type FaydaFields } from 'fayda-decoder';
import { verifySignature, FAYDA_V4_PUBLIC_KEY_PEM, type SignatureVerification } from 'fayda-decoder/verify';

export interface SyntheticFaydaOptions {
  fullName?: string;
  fan?: string;
  gender?: 'M' | 'F';
  dob?: string; // YYYY/MM/DD
  faceBase64Url?: string;
  privateKeyPem?: string;
  publicKeyPem?: string;
}

export interface SyntheticFaydaResult {
  fullPayload: string;
  basePayload: string;
  signature: string;
  pngBuffer: Buffer;
  options: {
    fullName: string;
    fan: string;
    gender: 'M' | 'F';
    dob: string;
  };
}

export interface SyntheticKeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
}

// Global cached test key pair (generated once in-memory for speed)
let _cachedKeyPair: SyntheticKeyPair | null = null;

/**
 * Returns a cached or newly generated RSA 2048-bit test keypair.
 */
export function getSyntheticTestKeyPair(): SyntheticKeyPair {
  if (!_cachedKeyPair) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    _cachedKeyPair = {
      publicKeyPem: publicKey,
      privateKeyPem: privateKey,
    };
  }
  return _cachedKeyPair;
}

// Valid minimal WebP base64url string with RIFF header for in-memory biometric testing
export const DEFAULT_SYNTHETIC_FACE_WEBP_BASE64URL =
  'UklGRjIAAABXRUJQVlA4ICYAAADQAgCdASogACAAPm0ylkekIyIhKAgAgA2JaQAAPaOgAP7r1IAAAA';

/**
 * Generates an authentic NIDP V4 Fayda QR payload string and compact detached JWS.
 */
export function createAuthenticFaydaPayload(options: SyntheticFaydaOptions = {}): {
  basePayload: string;
  fullPayload: string;
  signature: string;
  keyPair: SyntheticKeyPair;
  meta: {
    fullName: string;
    fan: string;
    gender: 'M' | 'F';
    dob: string;
  };
} {
  const keyPair = options.privateKeyPem && options.publicKeyPem
    ? { publicKeyPem: options.publicKeyPem, privateKeyPem: options.privateKeyPem }
    : getSyntheticTestKeyPair();

  const fullName = options.fullName || 'Tsehay Gemechu';
  const fan = options.fan || '6140987654321098';
  const gender = options.gender || 'F';
  const dob = options.dob || '1998/05/12';
  const face = options.faceBase64Url !== undefined ? options.faceBase64Url : DEFAULT_SYNTHETIC_FACE_WEBP_BASE64URL;

  // Base payload format: <face>:DLT:<fullName>:V:4:G:<gender>:A:<fan>:D:<dob>
  const basePayload = `${face}:DLT:${fullName}:V:4:G:${gender}:A:${fan}:D:${dob}`;

  // RS256 detached JWS
  const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
  const externalPayloadB64 = Buffer.from(basePayload, 'utf-8').toString('base64url');
  const signingInput = `${header}.${externalPayloadB64}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  const signature = signer.sign(keyPair.privateKeyPem).toString('base64url');

  const fullPayload = `${basePayload}:SIGN:${header}..${signature}`;

  return {
    basePayload,
    fullPayload,
    signature,
    keyPair,
    meta: { fullName, fan, gender, dob },
  };
}

/**
 * Generates an in-memory PNG Buffer for an Authentic NIDP V4 Fayda QR code.
 */
export async function generateAuthenticFaydaQrBuffer(
  options: SyntheticFaydaOptions = {}
): Promise<SyntheticFaydaResult> {
  const payloadData = createAuthenticFaydaPayload(options);
  const qr = await writeBarcode(payloadData.fullPayload, { format: 'QRCode' });
  if (!qr.image) throw new Error('writeBarcode failed to create image');
  const pngArrayBuffer = await qr.image.arrayBuffer();
  const pngBuffer = Buffer.from(pngArrayBuffer);

  return {
    fullPayload: payloadData.fullPayload,
    basePayload: payloadData.basePayload,
    signature: payloadData.signature,
    pngBuffer,
    options: payloadData.meta,
  };
}

/**
 * Generates an in-memory PNG Buffer for a Non-Fayda QR code (e.g. standard URL).
 */
export async function generateNonFaydaQrBuffer(
  content: string = 'https://t.me/spacematchaddis_bot'
): Promise<{ content: string; pngBuffer: Buffer }> {
  const qr = await writeBarcode(content, { format: 'QRCode' });
  if (!qr.image) throw new Error('writeBarcode failed to create image');
  const pngArrayBuffer = await qr.image.arrayBuffer();
  return {
    content,
    pngBuffer: Buffer.from(pngArrayBuffer),
  };
}

/**
 * Generates an in-memory PNG Buffer for a Tampered / Invalid Signature Fayda QR code.
 */
export async function generateTamperedFaydaQrBuffer(
  options: SyntheticFaydaOptions = {}
): Promise<SyntheticFaydaResult> {
  const payloadData = createAuthenticFaydaPayload(options);
  // Deliberately tamper with the payload after signing (change the FAN)
  const tamperedBasePayload = payloadData.basePayload.replace(
    payloadData.meta.fan,
    '9999888877776666'
  );
  const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
  const tamperedFullPayload = `${tamperedBasePayload}:SIGN:${header}..${payloadData.signature}`;

  const qr = await writeBarcode(tamperedFullPayload, { format: 'QRCode' });
  if (!qr.image) throw new Error('writeBarcode failed to create image');
  const pngArrayBuffer = await qr.image.arrayBuffer();
  const pngBuffer = Buffer.from(pngArrayBuffer);

  return {
    fullPayload: tamperedFullPayload,
    basePayload: tamperedBasePayload,
    signature: payloadData.signature,
    pngBuffer,
    options: {
      ...payloadData.meta,
      fan: '9999888877776666',
    },
  };
}

/**
 * Generates an in-memory Buffer for a Corrupted / Unparseable QR code.
 */
export async function generateCorruptedQrBuffer(mode: 'corrupted_bytes' | 'blank_image' | 'corrupt_seeker_photo' = 'corrupted_bytes'): Promise<Buffer> {
  if (mode === 'corrupted_bytes' || mode === 'corrupt_seeker_photo') {
    // Generate broken PNG header and random noise bytes
    const fakeHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG header
    const noise = crypto.randomBytes(512);
    return Buffer.concat([fakeHeader, noise]);
  } else {
    // Generate an image of pure noise that contains no barcode
    // Create a 200x200 pixel barcode of spaces or dots
    const qr = await writeBarcode('   ', { format: 'QRCode' });
    if (!qr.image) throw new Error('writeBarcode failed to create image');
    const pngArrayBuffer = await qr.image.arrayBuffer();
    return Buffer.from(pngArrayBuffer);
  }
}

/**
 * Direct decoder and signature verifier for synthetic test fixtures.
 */
export async function verifySyntheticQrBuffer(
  buffer: Buffer | Uint8Array,
  publicKeyPem?: string
): Promise<{
  decodedOk: boolean;
  fields?: FaydaFields;
  signatureVerification?: SignatureVerification;
  error?: string;
}> {
  try {
    const uint8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const decoded = await decodeImage(uint8, { includeFace: false });

    if (!decoded.ok) {
      return {
        decodedOk: false,
        error: decoded.error.message,
      };
    }

    const key = publicKeyPem || getSyntheticTestKeyPair().publicKeyPem;
    const sigResult = await verifySignature(decoded, { publicKeyPem: key });

    return {
      decodedOk: true,
      fields: decoded.fields,
      signatureVerification: sigResult,
    };
  } catch (err: any) {
    return {
      decodedOk: false,
      error: err.message,
    };
  }
}
