export interface VerifyEtResult {
  success: boolean;
  message: string;
  messageAm: string;
  errorCode?: string;
  transactionNumber?: string;
  paidAmount?: number;
  senderName?: string;
  bank?: string;
  rawResponse?: unknown;
}

/**
 * Extracts a clean transaction reference code or receipt URL from raw user input,
 * forwarded SMS messages, or copy-pasted bank notifications.
 *
 * Examples:
 * - "FT 2412345678" -> "FT2412345678"
 * - "FT 2609 20042" -> "FT260920042"
 * - "Ref: FT260920042" -> "FT260920042"
 * - "My ref is FT260920042." -> "FT260920042"
 * - "https://mbreciept.cbe.com.et/fHCxExampleRcpt01" -> URL preserved
 * - "ውድ ደንበኛ፣ ወደ 0901570707 ETB 300.00 አስተላልፈዋል። የግብይት ቁጥር፡ 10839482938 ነው።" -> "10839482938"
 * - "የደረሰኝ ቁጥር: FT260920042" -> "FT260920042"
 * - "TID: DTS41AB2C90" -> "DTS41AB2C90"
 */
export function extractTransactionReference(input: string): string {
  if (!input || typeof input !== 'string') return '';
  // Strip common HTML markup (e.g. <code>...</code>, <b>...</b>)
  let cleaned = input.replace(/<[^>]*>/g, ' ').trim();
  if (!cleaned) return '';

  // 1. URL extraction (CBE receipt link or any http(s) URL)
  const urlMatch = cleaned.match(/https?:\/\/[^\s<>'"`]+[A-Za-z0-9]/i);
  if (urlMatch) {
    return urlMatch[0].trim().replace(/[.,;)]+$/, '');
  }

  // 2. Normalize spaced FT reference codes anywhere in text (e.g. "FT 260920042", "FT 2609 20042", "FT-260920042")
  cleaned = cleaned.replace(/\bFT[\s\-_.:/]+([0-9](?:[\s\-_.:/]*[0-9]){5,15}[A-Z0-9]?)\b/gi, (_, digits) => {
    return 'FT' + digits.replace(/[\s\-_.:/]/g, '').toUpperCase();
  });

  // 3. CBE FT Reference (e.g., FT2412345678 or FT260920042)
  const ftRegex = /\b(FT[0-9A-Z]{6,16})\b/i;
  const ftMatch = cleaned.match(ftRegex);
  if (ftMatch && ftMatch[1]) {
    return ftMatch[1].trim().toUpperCase();
  }

  // 4. Amharic labeled pattern
  // Matches: የግብይት ቁጥር, የደረሰኝ ቁጥር, የማጣቀሻ ቁጥር, የክፍያ መለያ, ትራንዛክሽን ቁጥር, etc.
  const amharicRegex =
    /(?:የ(?:ግብይት|ደረሰኝ|ማጣቀሻ|ክፍያ)\s*(?:ቁጥር|መለያ)?|መለያ\s*ቁጥር|ትራንዛክሽን\s*(?:ቁጥር|መለያ)?)\s*[:=\-#፡፦\s]*([A-Za-z0-9_-]+)/u;
  const amharicMatch = cleaned.match(amharicRegex);
  if (amharicMatch && amharicMatch[1]) {
    const candidate = amharicMatch[1].trim();
    if (!/^(?:09|07|2519|2517)\d{8}$/.test(candidate) && candidate.length >= 6) {
      return candidate;
    }
  }

  // 5. English labeled pattern: Ref: ..., Txn ID: ..., TID: ..., Receipt No: ..., Code: ...
  const labeledRegex =
    /(?:ref(?:erence)?(?:\s*no\.?|\s*id)?|txn(?:\s*ref|\s*id)?|transaction\s*(?:id|no\.?|number|reference)?|receipt(?:\s*no\.?)?|tid|code)\s*(?:[:=\-#፡፦]|\bis\b|\s)\s*([A-Za-z0-9_-]+)/i;
  const labeledMatch = cleaned.match(labeledRegex);
  if (labeledMatch && labeledMatch[1]) {
    const candidate = labeledMatch[1].trim();
    const stopWords = new Set(['is', 'was', 'the', 'a', 'to', 'in', 'of', 'for', 'and']);
    if (
      !stopWords.has(candidate.toLowerCase()) &&
      !/^(?:09|07|2519|2517)\d{8}$/.test(candidate) &&
      candidate.length >= 4
    ) {
      return candidate;
    }
  }

  // 6. Alphanumeric transaction codes (TX..., TB..., DTS...)
  const txMatch = cleaned.match(/\b([A-Z]{1,3}[0-9]{7,15}[A-Z0-9]*)\b/i);
  if (txMatch && txMatch[1]) {
    return txMatch[1].trim().toUpperCase();
  }

  // 7. Standalone 8-16 digit numbers (telebirr transaction number or bank reference numbers)
  const phoneRegex = /^(?:\+?251|0)?[97]\d{8}$/;
  const numericTokens = cleaned.match(/\b\d{8,16}\b/g);
  if (numericTokens) {
    const nonPhoneToken = numericTokens.find((token) => !phoneRegex.test(token));
    if (nonPhoneToken) {
      return nonPhoneToken;
    }
  }

  // 8. Strip outer punctuation and quotes from single tokens
  const cleanSingleToken = cleaned.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '');
  if (/^[a-zA-Z0-9_-]+$/.test(cleanSingleToken)) {
    return cleanSingleToken;
  }

  return cleaned;
}

/**
 * Builds tailored Verify.ET payloads matching bank-specific API contracts:
 * - CBE: receiptNumber and referenceNumber
 * - Telebirr: transactionNumber and reference
 * - Bank of Abyssinia (abyssinia/boa): bank 'boa', reference, suffix and accountSuffix (last 5 digits of settlementAccount)
 * - Dashen Bank: reference and referenceNumber
 */
function buildVerifyPayload(
  bank: string,
  cleanRef: string,
  settlementAccount: string
): Record<string, string> {
  const norm = bank.toLowerCase();
  if (norm === 'cbe') {
    return {
      bank: 'cbe',
      receiptNumber: cleanRef,
      referenceNumber: cleanRef,
      settlementAccount,
    };
  }
  if (norm === 'telebirr') {
    return {
      bank: 'telebirr',
      transactionNumber: cleanRef,
      reference: cleanRef,
      settlementAccount,
    };
  }
  if (norm === 'abyssinia' || norm === 'boa') {
    const suffix = settlementAccount.slice(-5);
    return {
      bank: 'boa',
      reference: cleanRef,
      suffix,
      accountSuffix: suffix,
      settlementAccount,
    };
  }
  if (norm === 'dashen') {
    return {
      bank: 'dashen',
      reference: cleanRef,
      referenceNumber: cleanRef,
      settlementAccount,
    };
  }
  return {
    bank: norm,
    reference: cleanRef,
    referenceNumber: cleanRef,
    transactionNumber: cleanRef,
    receiptNumber: cleanRef,
    settlementAccount,
  };
}

/**
 * Maps upstream Verify.ET responses and HTTP errors to friendly, human-readable English and Amharic messages.
 * Never leaks raw JSON or system stack errors to end users.
 */
function mapVerifyError(
  upstreamText: string,
  statusCode?: number,
  bank?: string
): { message: string; messageAm: string; errorCode: string } {
  const lower = (upstreamText || '').toLowerCase();
  const bankName = bank ? bank.toUpperCase() : 'ባንክ';

  // 1. Auth/Config errors
  if (
    statusCode === 401 ||
    statusCode === 403 ||
    lower.includes('unauthorized') ||
    lower.includes('api key')
  ) {
    return {
      message: 'The bank verification system is undergoing maintenance. Please try again in a few minutes.',
      messageAm: 'የባንክ ማረጋገጫ ስርዓት ለጊዜው በጥገና ላይ ነው። እባክዎ ከጥቂት ደቂቃዎች በኋላ እንደገና ይሞክሩ።',
      errorCode: 'SERVICE_MAINTENANCE',
    };
  }

  // 2. Invalid or malformed reference format / missing required fields
  if (
    statusCode === 422 ||
    lower.includes('requires `receiptnumber`') ||
    lower.includes('requires receiptnumber') ||
    lower.includes('receipt link') ||
    lower.includes('referencenumber') ||
    lower.includes('accountsuffix') ||
    lower.includes('must be strings') ||
    lower.includes('invalid') ||
    lower.includes('format') ||
    lower.includes('malformed') ||
    lower.includes('length')
  ) {
    return {
      message:
        'Invalid transaction reference format. Please double-check your receipt code (e.g. FT... for CBE or your Telebirr reference) or receipt link.',
      messageAm:
        'የግብይት ደረሰኝ ቁጥር ቅርጸት ልክ አይደለም። እባክዎ የደረሰኝ ቁጥርዎን (ለምሳሌ ለCBE በ FT... የሚጀምር ወይም የቴሌብር ቁጥር) ወይም የደረሰኝ ማስፈንጠሪያ አረጋግጠው እንደገና ይሞክሩ።',
      errorCode: 'INVALID_FORMAT',
    };
  }

  // 3. Transaction not found in bank system
  if (
    statusCode === 404 ||
    lower.includes('not found') ||
    lower.includes('no record') ||
    lower.includes('does not exist') ||
    lower.includes('cannot find') ||
    lower.includes('not exist')
  ) {
    return {
      message:
        'Transaction record was not found with the bank. Please ensure the payment was completed and the reference number is correct.',
      messageAm:
        'ይህ የክፍያ ግብይት በባንኩ አልተገኘም። እባክዎ ክፍያው በተሳካ ሁኔታ መጠናቀቁን እና የደረሰኝ ቁጥሩ ትክክል መሆኑን ያረጋግጡ።',
      errorCode: 'NOT_FOUND',
    };
  }

  // 4. Payment still pending or queued
  if (
    statusCode === 202 ||
    lower.includes('queued') ||
    lower.includes('pending') ||
    lower.includes('in progress') ||
    lower.includes('processing')
  ) {
    return {
      message: 'Payment verification is still processing by the bank. Please wait a minute and submit again.',
      messageAm: 'የክፍያ ማረጋገጫው በባንኩ በሂደት ላይ ነው። እባክዎ ጥቂት ደቂቃዎች ቆይተው እንደገና ይላኩ።',
      errorCode: 'PAYMENT_PENDING',
    };
  }

  // 5. High traffic / Rate limited
  if (
    statusCode === 429 ||
    lower.includes('rate limit') ||
    lower.includes('too many') ||
    lower.includes('throttl')
  ) {
    return {
      message: 'The verification service is temporarily busy due to high traffic. Please wait a moment and try again.',
      messageAm: 'የማረጋገጫ አገልግሎቱ በከፍተኛ ጥሪዎች ምክንያት ለጊዜው ተጠምዷል። እባክዎ ጥቂት ደቂቃዎች ቆይተው እንደገና ይሞክሩ።',
      errorCode: 'SERVICE_BUSY',
    };
  }

  // 6. Upstream service downtime / Server error
  if (
    (statusCode && statusCode >= 500) ||
    lower.includes('server error') ||
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('unavailable') ||
    lower.includes('gateway')
  ) {
    return {
      message: 'The bank verification service is temporarily unavailable. Please try again in a few minutes.',
      messageAm: 'የባንክ ማረጋገጫ አገልግሎት ለጊዜው አልተገኘም። እባክዎ ከጥቂት ደቂቃዎች በኋላ እንደገና ይሞክሩ።',
      errorCode: 'SERVICE_UNAVAILABLE',
    };
  }

  // 7. Payment cancelled or failed
  if (lower.includes('cancel') || lower.includes('fail') || lower.includes('reject')) {
    return {
      message: 'This bank transaction was unsuccessful or cancelled.',
      messageAm: 'ይህ የባንክ ግብይት ያልተሳካ ወይም የተሰረዘ ነው።',
      errorCode: 'TRANSACTION_FAILED',
    };
  }

  // Fallback
  return {
    message: bank
      ? `Payment transaction could not be verified via ${bank.toUpperCase()}. Please check your reference code.`
      : 'Payment transaction status could not be verified. Please check your reference code and try again.',
    messageAm: bank
      ? `ይህ የክፍያ ግብይት በ${bankName} ሊረጋገጥ አልቻለም። እባክዎ የደረሰኝ ቁጥርዎን አረጋግጠው እንደገና ይሞክሩ።`
      : 'የክፍያ ግብይቱ ሊረጋገጥ አልቻለም። እባክዎ የደረሰኝ ቁጥርዎን አረጋግጠው እንደገና ይሞክሩ።',
    errorCode: 'VERIFICATION_FAILED',
  };
}

/**
 * Validates Telebirr, Bank of Abyssinia, Dashen Bank, or CBE transaction receipts using the verify.et API
 *
 * Supported Accounts (Account Holder: Wahid):
 * - Telebirr: process.env.TELEBIRR_RECEIVER_PHONE || '0987310978' (Wahid)
 * - Bank of Abyssinia: process.env.ABYSSINIA_ACCOUNT_NUMBER || '256861771' (Wahid)
 * - Dashen Bank: process.env.DASHEN_ACCOUNT_NUMBER || '2922175078411' (Wahid)
 * - CBE (Fallback): process.env.CBE_ACCOUNT_NUMBER || '1000054066094'
 *
 * Endpoint: POST https://verify.et/api/verify?waitMs=5000
 * Headers: x-api-key: process.env.VERIFY_ET_API_KEY
 */
export async function verifyTelebirrPayment(
  referenceNumber: string,
  expectedFee: number = Number(process.env.NEXT_PUBLIC_UNLOCK_FEE || '300'),
  preferredBank?: string
): Promise<VerifyEtResult> {
  const apiKey =
    process.env.VERIFY_ET_API_KEY ||
    'VERIFY_BANK_ET_KR3fTQgvo-2DvqSxGFeT7m-cX4Qd7El55LyRwxnHrPVjV9EVKmelfN8hz9Necag1';
  const receiverPhone = process.env.TELEBIRR_RECEIVER_PHONE || '0987310978';
  const abyssiniaAccount = process.env.ABYSSINIA_ACCOUNT_NUMBER || '256861771';
  const dashenAccount = process.env.DASHEN_ACCOUNT_NUMBER || '2922175078411';
  const cbeAccount = process.env.CBE_ACCOUNT_NUMBER || '1000054066094';

  const cleanRef = extractTransactionReference(referenceNumber);

  if (!cleanRef) {
    return {
      success: false,
      message:
        'Invalid or missing transaction reference. Please provide a valid transaction reference code (e.g. FT... or TX...) or receipt link.',
      messageAm:
        'የተሳሳተ ወይም የጎደለ የደረሰኝ ቁጥር። እባክዎ ትክክለኛ የግብይት ቁጥር (ለምሳሌ FT... ወይም TX...) ወይም ማስፈንጠሪያ ያስገቡ።',
      errorCode: 'INVALID_FORMAT',
    };
  }

  if (!apiKey) {
    if (process.env.ALLOW_MOCK_PAYMENTS === 'true' || process.env.NODE_ENV === 'development') {
      const bank = cleanRef.toUpperCase().startsWith('FT') ? 'cbe' : (preferredBank || 'telebirr');
      return {
        success: true,
        message: 'Payment receipt verified successfully (Test Mode).',
        messageAm: 'የክፍያ ደረሰኝ በተሳካ ሁኔታ ተረጋግጧል (የሙከራ ሁነታ)።',
        transactionNumber: cleanRef.toUpperCase(),
        paidAmount: expectedFee,
        senderName: 'Verified Payer (Wahid)',
        bank,
      };
    }
    return {
      success: false,
      message: 'Server configuration error: Payment verification is temporarily unavailable.',
      messageAm: 'የአገልጋይ ውቅር ችግር፡ የክፍያ ማረጋገጫ አገልግሎት ለጊዜው አይሰራም።',
      errorCode: 'CONFIG_ERROR',
    };
  }

  const endpoint = 'https://verify.et/api/verify?waitMs=1500';

  // Bank Options to evaluate (Telebirr, BoA, Dashen & CBE) - deduplicated accounts
  const allConfigs = [
    { bank: 'telebirr', settlementAccount: receiverPhone.trim() || '0987310978' },
    { bank: 'boa', settlementAccount: abyssiniaAccount.trim() || '256861771' },
    { bank: 'dashen', settlementAccount: dashenAccount.trim() || '2922175078411' },
    { bank: 'cbe', settlementAccount: cbeAccount.trim() || '1000054066094' },
  ];

  // Infer bank from reference prefix if not explicitly passed
  let normalizedBank = preferredBank?.toLowerCase().trim();
  if (normalizedBank === 'abyssinia') {
    normalizedBank = 'boa';
  }
  const isCbeRef = cleanRef.toUpperCase().startsWith('FT') || cleanRef.toLowerCase().includes('cbe.com.et');
  const isTelebirrRef = /^\d{8,16}$/.test(cleanRef);
  const isDashenRef = cleanRef.toUpperCase().startsWith('DTS');

  if (!normalizedBank) {
    if (isCbeRef) {
      normalizedBank = 'cbe';
    } else if (isTelebirrRef) {
      normalizedBank = 'telebirr';
    } else if (isDashenRef) {
      normalizedBank = 'dashen';
    }
  }

  // Strictly target the specific bank if identified, or evaluate at most 2 configs to avoid blocking delays
  let bankConfigs: typeof allConfigs;
  if (normalizedBank) {
    bankConfigs = allConfigs.filter((c) => c.bank === normalizedBank);
    if (bankConfigs.length === 0) {
      bankConfigs = [{ bank: normalizedBank, settlementAccount: receiverPhone.trim() || '0987310978' }];
    }
  } else {
    // Default prioritized: Telebirr first, CBE second
    bankConfigs = allConfigs.filter((c) => c.bank === 'telebirr' || c.bank === 'cbe');
  }

  let lastFailure: { message: string; messageAm: string; errorCode: string } | null = null;
  let lastRawResponse: unknown = null;

  for (const config of bankConfigs) {
    try {
      const payload = buildVerifyPayload(config.bank, cleanRef, config.settlementAccount);

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(6000),
      });

      if (!response.ok) {
        let rawErrorText = '';
        let extractedMsg = '';
        try {
          rawErrorText = await response.text();
          const parsed = JSON.parse(rawErrorText);
          extractedMsg = parsed.message || parsed.error?.message || parsed.error || '';
        } catch {
          extractedMsg = rawErrorText;
        }

        console.warn(
          `[verify-et] Verify.ET API error (${config.bank}, HTTP ${response.status}):`,
          rawErrorText || response.statusText
        );

        lastFailure = mapVerifyError(extractedMsg || rawErrorText, response.status, config.bank);
        lastRawResponse = rawErrorText;
        continue;
      }

      const data = await response.json();
      lastRawResponse = data;

      // Verify.ET may return record in data.data[0] or data.data or root
      const record = Array.isArray(data.data)
        ? data.data[0]
        : data.data && typeof data.data === 'object'
        ? data.data
        : data;
      const verificationObj =
        data.verification && typeof data.verification === 'object' ? data.verification : {};

      // 1. Evaluate response verification status across both root and nested schemas
      const isStatusVerified =
        data.status === 'verified' ||
        data.status === 'success' ||
        data.verified === true ||
        record?.status === 'verified' ||
        record?.status === 'success' ||
        record?.verified === true ||
        verificationObj?.status === 'success' ||
        verificationObj?.status === 'verified' ||
        verificationObj?.verified === true;

      if (!isStatusVerified) {
        const upstreamMsg =
          data.error?.message ||
          record?.error?.message ||
          data.message ||
          record?.message ||
          '';

        console.warn(`[verify-et] Payment not verified for ${config.bank}:`, upstreamMsg || data);

        lastFailure = mapVerifyError(upstreamMsg, response.status, config.bank);
        continue;
      }

      // 2. Confirm settlement account matching if present
      const returnedSettlementAccount = record?.settlementAccount || data.settlementAccount;
      if (returnedSettlementAccount && returnedSettlementAccount.trim() !== config.settlementAccount) {
        console.warn(
          `[verify-et] Settlement account mismatch for ${config.bank}: expected ${config.settlementAccount}, got ${returnedSettlementAccount}`
        );
        lastFailure = {
          message:
            'Payment was sent to a different account number. Please ensure payment was transferred to our designated account.',
          messageAm:
            'ክፍያው የተላከው ወደ ሌላ የባንክ/ቴሌብር ሂሳብ ነው። እባክዎ ክፍያው ወደ ተሰጠው ትክክለኛ የሂሳብ ቁጥር መላኩን ያረጋግጡ።',
          errorCode: 'ACCOUNT_MISMATCH',
        };
        continue;
      }

      // 3. Ensure paid amount matches or exceeds expected fee
      const paidAmount = Number(
        record?.amount || record?.paidAmount || data.amount || data.paidAmount || 0
      );
      if (paidAmount > 0 && paidAmount < expectedFee) {
        return {
          success: false,
          message: `Insufficient payment. Received ${paidAmount} ETB, but fee requires at least ${expectedFee} ETB.`,
          messageAm: `የተከፈለው ገንዘብ መጠን በቂ አይደለም። የተከፈለው ${paidAmount} ብር ሲሆን የሚያስፈልገው ክፍያ ${expectedFee} ብር ነው።`,
          errorCode: 'INSUFFICIENT_AMOUNT',
          paidAmount,
          bank: config.bank,
          rawResponse: data,
        };
      }

      const senderName =
        record?.senderName || record?.payerName || data.senderName || data.payerName || 'Verified Payer';
      const txNum =
        record?.referenceNumber || record?.transactionNumber || data.transactionNumber || cleanRef;

      return {
        success: true,
        message: `Payment receipt verified successfully via ${config.bank.toUpperCase()}.`,
        messageAm: `የክፍያ ደረሰኝ በ${config.bank.toUpperCase()} በተሳካ ሁኔታ ተረጋግጧል።`,
        transactionNumber: txNum,
        paidAmount: paidAmount || expectedFee,
        senderName,
        bank: config.bank,
        rawResponse: data,
      };
    } catch (error: unknown) {
      const errMessage = error instanceof Error ? error.message : String(error);
      console.warn(`[verify-et] Connection error during verification (${config.bank}):`, errMessage);
      lastFailure = {
        message: 'Network connection error while contacting verification service. Please try again.',
        messageAm: 'የመረብ ግንኙነት ችግር አጋጥሟል። እባክዎ ጥቂት ደቂቃዎች ቆይተው እንደገና ይሞክሩ።',
        errorCode: 'NETWORK_ERROR',
      };
    }
  }

  return {
    success: false,
    message:
      lastFailure?.message ||
      'Payment transaction status could not be verified. Please check your reference code and try again.',
    messageAm:
      lastFailure?.messageAm ||
      'የክፍያ ግብይቱ ሊረጋገጥ አልቻለም። እባክዎ የደረሰኝ ቁጥርዎን አረጋግጠው እንደገና ይሞክሩ።',
    errorCode: lastFailure?.errorCode || 'VERIFICATION_FAILED',
    rawResponse: lastRawResponse,
  };
}

export const verifyPayment = verifyTelebirrPayment;
