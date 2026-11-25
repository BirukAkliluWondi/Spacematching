/**
 * src/lib/receipt-extractor.ts
 *
 * High-speed, in-memory payment receipt screenshot extractor for Ethiopian banking systems.
 * Supports Telebirr, Commercial Bank of Ethiopia (CBE / CBE Birr), Bank of Abyssinia (BOA), and Dashen.
 *
 * Performance Architecture ("Make it quick"):
 * 1. Fast Path (~10-30ms): Scans for embedded receipt QR codes / barcodes via zxing-wasm.
 * 2. OCR Path (~700-1100ms): Uses a warm, reusable Tesseract worker with sharp image downscaling
 *    (max 1200px) and contrast normalization.
 * 3. Zero-Storage Policy: Operates purely on in-memory Buffers in RAM; never persists to disk or cloud storage.
 */

import sharp from 'sharp';
import { prepareZXingModule, readBarcodesFromImageData } from 'zxing-wasm/reader';
import { createWorker } from 'tesseract.js';
import { extractTransactionReference } from '@/lib/verify-et';

export interface ReceiptExtractionResult {
  success: boolean;
  reference?: string;
  bankHint?: 'telebirr' | 'cbe' | 'boa' | 'dashen';
  amountDetected?: number;
  rawText?: string;
  source?: 'qr' | 'ocr';
  latencyMs?: number;
}

// Warm singleton Tesseract worker for instant recognition without cold-spawn overhead
let _ocrWorkerPromise: Promise<any> | null = null;
let _receiptZxingReady: Promise<void> | null = null;

async function ensureReceiptZxingReady(): Promise<void> {
  if (_receiptZxingReady) return _receiptZxingReady;
  _receiptZxingReady = (async () => {
    try {
      const fs = await import('fs');
      const path = await import('path');
      const p = path.resolve(process.cwd(), 'node_modules/zxing-wasm/dist/reader/zxing_reader.wasm');
      if (fs.existsSync(/*turbopackIgnore: true*/ p)) {
        const fileBuf = fs.readFileSync(/*turbopackIgnore: true*/ p);
        const wasmBinary = fileBuf.buffer.slice(fileBuf.byteOffset, fileBuf.byteOffset + fileBuf.byteLength);
        await prepareZXingModule({ overrides: { wasmBinary }, fireImmediately: true });
      }
    } catch (err) {
      console.warn('[receipt-extractor] ensureReceiptZxingReady warning:', err);
    }
  })();
  return _receiptZxingReady;
}

export async function getOcrWorker() {
  if (!_ocrWorkerPromise) {
    _ocrWorkerPromise = (async () => {
      try {
        const fs = await import('fs');
        const path = await import('path');
        const localTrainedData = path.resolve(process.cwd(), 'eng.traineddata');
        const hasLocalLang = fs.existsSync(/*turbopackIgnore: true*/ localTrainedData);
        const worker = await createWorker(
          'eng',
          1,
          hasLocalLang
            ? { langPath: process.cwd(), cachePath: '/tmp', gzip: false }
            : { cachePath: '/tmp' }
        );
        return worker;
      } catch (err) {
        _ocrWorkerPromise = null;
        throw err;
      }
    })();
  }
  return _ocrWorkerPromise;
}

/**
 * Normalizes EXIF rotation FIRST and scales/enhances screenshot image for rapid OCR analysis.
 */
async function preprocessReceiptImage(buffer: Buffer, darkMode = false): Promise<Buffer> {
  try {
    const rotatedBuf = await sharp(buffer).rotate().toBuffer();
    const meta = await sharp(rotatedBuf).metadata();
    const width = meta.width || 0;
    const pipeline = sharp(rotatedBuf);
    if (width > 0 && width < 1000) {
      pipeline.resize({ width: 1400, withoutEnlargement: false });
    } else {
      pipeline.resize({ width: 1400, withoutEnlargement: true });
    }
    pipeline.grayscale();
    if (darkMode) pipeline.negate({ alpha: false });
    return await pipeline
      .normalize()
      .sharpen()
      .toBuffer();
  } catch {
    return buffer;
  }
}

/**
 * Determines bank hint from text context or reference structure.
 */
function detectBankHint(text: string, reference?: string): 'telebirr' | 'cbe' | 'boa' | 'dashen' | undefined {
  const lower = text.toLowerCase();
  const refUpper = (reference || '').toUpperCase();

  if (refUpper.startsWith('FT') || lower.includes('cbe') || lower.includes('commercial bank') || lower.includes('ንግድ ባንክ')) {
    return 'cbe';
  }
  if (refUpper.startsWith('DTS') || lower.includes('dashen') || lower.includes('ዳሸን') || lower.includes('amole')) {
    return 'dashen';
  }
  if (refUpper.startsWith('TX') || lower.includes('abyssinia') || lower.includes('አቢሲንያ') || lower.includes('boa')) {
    return 'boa';
  }
  if (
    refUpper.startsWith('DK') ||
    refUpper.startsWith('DL') ||
    (refUpper.startsWith('DT') && !refUpper.startsWith('DTS')) ||
    lower.includes('telebirr') ||
    lower.includes('ቴሌብር') ||
    lower.includes('ethiotelecom')
  ) {
    return 'telebirr';
  }

  return undefined;
}

/**
 * Extracts amount from receipt text if present (e.g., "100.00 ETB", "104.00 ETB", "100 ብር")
 */
function detectAmount(text: string): number | undefined {
  const match = text.match(/(?:[-+]?\s*|ETB\s*|ብር\s*)(\d{2,5}(?:\.\d{1,2})?)\s*(?:ETB|ብር|\.00)/i) ||
                text.match(/\b(\d{2,5}\.00)\b/);
  if (match && match[1]) {
    const num = parseFloat(match[1]);
    if (!isNaN(num) && num >= 50 && num <= 100000) {
      return num;
    }
  }
  return undefined;
}

/**
 * In-memory receipt screenshot extractor.
 * Zero files are written to disk.
 */
export async function extractTransactionReferenceFromImage(
  imageBuffer: Buffer
): Promise<ReceiptExtractionResult> {
  const startTime = Date.now();

  if (!imageBuffer || imageBuffer.length === 0) {
    return { success: false };
  }

  // ── Step 1: Fast Path via Embedded Barcode / QR Code (10-30ms) ───────────
  try {
    await ensureReceiptZxingReady();
    const baseImg = await sharp(imageBuffer).rotate().toBuffer();
    const scanPasses = [
      () => sharp(baseImg).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
      () => sharp(baseImg).resize({ width: 1200, withoutEnlargement: false }).grayscale().normalize().ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
      () => sharp(baseImg).grayscale().negate({ alpha: false }).normalize().ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    ];

    for (const makePass of scanPasses) {
      const { data, info } = await makePass();
      const barcodes = await readBarcodesFromImageData(
        {
          data: new Uint8ClampedArray(data),
          width: info.width,
          height: info.height,
        } as any,
        {
          tryHarder: true,
          formats: ['QRCode', 'DataMatrix', 'PDF417'],
        }
      );

      for (const b of barcodes) {
        if (b.text && b.text.trim()) {
          const qrText = b.text.trim();
          const extracted = extractTransactionReference(qrText);
          if (extracted && extracted.length >= 6) {
            const bankHint = detectBankHint(qrText, extracted);
            return {
              success: true,
              reference: extracted,
              bankHint,
              rawText: qrText,
              source: 'qr',
              latencyMs: Date.now() - startTime,
            };
          }
        }
      }
    }
  } catch (err) {
    console.warn('[receipt-extractor] QR fast-path check warning:', err);
  }

  // ── Step 2: High-Speed OCR Path (Light Mode + Dark Mode fallback) ────────
  const tryParseOcrText = (ocrText: string): ReceiptExtractionResult | null => {
    const lowerOcr = ocrText.toLowerCase();
    // Guard against misclassifying Fayda National ID cards as payment receipts
    const looksLikeFayda =
      (lowerOcr.includes('fayda') || lowerOcr.includes('nationality') || lowerOcr.includes('administration')) &&
      !lowerOcr.includes('telebirr') &&
      !lowerOcr.includes('etb') &&
      !lowerOcr.includes('transaction') &&
      !lowerOcr.includes('receipt') &&
      !lowerOcr.includes('service fee');
    if (looksLikeFayda) {
      return { success: false, latencyMs: Date.now() - startTime };
    }

    const refCandidate = extractTransactionReference(ocrText);
    const bankHint = detectBankHint(ocrText, refCandidate);
    const amount = detectAmount(ocrText);

    if (refCandidate && refCandidate.length >= 6) {
      return {
        success: true,
        reference: refCandidate,
        bankHint,
        amountDetected: amount,
        rawText: ocrText,
        source: 'ocr',
        latencyMs: Date.now() - startTime,
      };
    }

    // Fallback line-by-line scan
    const lines = ocrText.split(/\r?\n/);
    for (const line of lines) {
      const lineCandidate = extractTransactionReference(line);
      if (lineCandidate && lineCandidate.length >= 6) {
        return {
          success: true,
          reference: lineCandidate,
          bankHint: detectBankHint(line, lineCandidate),
          amountDetected: amount,
          rawText: ocrText,
          source: 'ocr',
          latencyMs: Date.now() - startTime,
        };
      }

      // Direct token search for CBE FT / Dashen DTS / BoA TX / Telebirr codes
      const ftTokenMatch = line.match(/\b(FT[0-9A-Z]{6,16})\b/i);
      if (ftTokenMatch?.[1]) {
        return {
          success: true,
          reference: ftTokenMatch[1].toUpperCase(),
          bankHint: 'cbe',
          amountDetected: amount,
          rawText: ocrText,
          source: 'ocr',
          latencyMs: Date.now() - startTime,
        };
      }

      const dtsTokenMatch = line.match(/\b(DTS[A-Z0-9]{5,14})\b/i);
      if (dtsTokenMatch?.[1]) {
        return {
          success: true,
          reference: dtsTokenMatch[1].toUpperCase(),
          bankHint: 'dashen',
          amountDetected: amount,
          rawText: ocrText,
          source: 'ocr',
          latencyMs: Date.now() - startTime,
        };
      }

      const tbTokenMatch = line.match(/\b((?:D[A-LN-Z]|C[A-Z])[A-Z0-9]{8})\b/i);
      if (tbTokenMatch?.[1] && /\d/.test(tbTokenMatch[1])) {
        return {
          success: true,
          reference: tbTokenMatch[1].toUpperCase(),
          bankHint: 'telebirr',
          amountDetected: amount,
          rawText: ocrText,
          source: 'ocr',
          latencyMs: Date.now() - startTime,
        };
      }
    }
    return null;
  };

  try {
    const worker = await getOcrWorker();
    for (const darkMode of [false, true]) {
      const preprocessed = await preprocessReceiptImage(imageBuffer, darkMode);
      const ret = await worker.recognize(preprocessed);
      const ocrText = (ret?.data?.text || '').trim();
      if (ocrText) {
        const parsed = tryParseOcrText(ocrText);
        if (parsed) return parsed;
      }
    }
  } catch (err) {
    console.error('[receipt-extractor] OCR execution error:', err);
    _ocrWorkerPromise = null;
  }

  return {
    success: false,
    latencyMs: Date.now() - startTime,
  };
}
