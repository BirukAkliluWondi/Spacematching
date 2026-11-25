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
/**
 * Canonicalizes a transaction reference or receipt URL for case-insensitive anti-replay storage/matching.
 * Converts bank receipt URLs (e.g. transactioninfo.ethiotelecom.et/receipt/DKM7J1EXAP or apps.cbe.com.et/?id=FT...)
 * into their canonical uppercase transaction ID when unambiguous.
 */
export function normalizeCanonicalTransactionRef(input: string): string {
  const extracted = extractTransactionReference(input);
  if (!extracted) return '';
  if (/^https?:\/\//i.test(extracted)) {
    const cbeId = extracted.match(/[?&]id=([A-Z0-9_-]{6,32})/i);
    if (cbeId?.[1]) return cbeId[1].toUpperCase();
    const pathTail = extracted.match(/\/(?:receipt|verify|tx)\/([A-Z0-9_-]{6,32})(?:[/?#]|$)/i);
    if (pathTail?.[1]) return pathTail[1].toUpperCase();
    return extracted.trim();
  }
  return extracted.trim().toUpperCase();
}

export function extractTransactionReference(input: string): string {
  if (!input || typeof input !== 'string') return '';
  // Strip common HTML markup (e.g. <code>...</code>, <b>...</b>)
  let cleaned = input.replace(/<[^>]*>/g, ' ').trim();
  if (!cleaned) return '';

  // 1. Official Ethiopian bank/Telebirr receipt URL extraction (never hijack on promo/footer URLs)
  const receiptUrlMatch = cleaned.match(
    /https?:\/\/(?:[a-z0-9-]+\.)*(?:cbe\.com\.et|ethiotelecom\.et\/receipt|transactioninfo\.ethiotelecom\.et|bankofabyssinia\.com|dashenbanksc\.com|verify\.et)[^\s<>'"`]+[A-Za-z0-9]/i
  );
  if (receiptUrlMatch) {
    return receiptUrlMatch[0].trim().replace(/[.,;)]+$/, '');
  }

  // 2. Normalize spaced FT reference codes anywhere in text (e.g. "FT 260920042", "FT 2609 20042", "FT-260920042")
  cleaned = cleaned.replace(/\bFT[\s\-_.:/]+([0-9](?:[\s\-_.:/]*[0-9]){5,15}[A-Z0-9]?)\b/gi, (_, digits) => {
    return 'FT' + digits.replace(/[\s\-_.:/]/g, '').toUpperCase();
  });

  // 3. CBE FT Reference (e.g., FT2412345678 or FT260920042)
  const ftRegex = /\b(FT[0-9A-Z]{6,16})\b/i;
  const ftMatch = cleaned.match(ftRegex);
  if (ftMatch && ftMatch[1] && /\d/.test(ftMatch[1])) {
    return ftMatch[1].trim().toUpperCase();
  }

  // 3b. Dashen Bank Reference (e.g., DTS41AB2C90) — checked before Telebirr generic D*
  const dashenRegex = /\b(DTS[A-Z0-9]{5,14})\b/i;
  const dashenMatch = cleaned.match(dashenRegex);
  if (dashenMatch && dashenMatch[1] && /\d/.test(dashenMatch[1])) {
    return dashenMatch[1].trim().toUpperCase();
  }

  // 3c. Bank of Abyssinia TX Reference (e.g., TX...)
  const boaRegex = /\b(TX[0-9A-Z]{6,16})\b/i;
  const boaMatch = cleaned.match(boaRegex);
  if (boaMatch && boaMatch[1] && /\d/.test(boaMatch[1])) {
    return boaMatch[1].trim().toUpperCase();
  }

  // 3d. Telebirr 10-char Alphanumeric Reference (e.g., DKM7J1EXAP, DK29M7PCJT, DL..., DA..., CJA...)
  const tbRegex = /\b((?:D[A-LN-Z]|C[A-Z])[A-Z0-9]{8})\b/i;
  let tbMatch: RegExpExecArray | null;
  const tbGlobal = new RegExp(tbRegex.source, 'gi');
  while ((tbMatch = tbGlobal.exec(cleaned)) !== null) {
    const token = tbMatch[1].trim().toUpperCase();
    if (/\d/.test(token) && !token.startsWith('DTS')) {
      return token;
    }
  }

  // 4. Amharic labeled pattern
  // Matches: የግብይት ቁጥር, የደረሰኝ ቁጥር, የማጣቀሻ ቁጥር, የክፍያ መለያ, ትራንዛክሽን ቁጥር, etc.
  const amharicRegex =
    /(?:የ(?:ግብይት|ደረሰኝ|ማጣቀሻ|ክፍያ)\s*(?:ቁጥር|መለያ)?|መለያ\s*ቁጥር|ትራንዛክሽን\s*(?:ቁጥር|መለያ)?)\s*[:=\-#፡፦\s]*([A-Za-z0-9_-]+)/u;
  const amharicMatch = cleaned.match(amharicRegex);
  if (amharicMatch && amharicMatch[1]) {
    const candidate = amharicMatch[1].trim();
    if (!/^(?:09|07|2519|2517)\d{8}$/.test(candidate) && candidate.length >= 6 && /\d/.test(candidate)) {
      return candidate.toUpperCase();
    }
  }

  // 5. English labeled pattern: requires explicit punctuation/is delimiter & digit presence (blocks "Transaction Status", "Reference Code")
  const labeledRegex =
    /(?:ref(?:erence)?(?:\s*no\.?|\s*id)?|txn(?:\s*ref|\s*id)?|transaction\s*(?:id|no\.?|number|ref(?:erence)?)|receipt\s*(?:no\.?|id)|tid|code)\s*(?:[:=\-#፡፦]+|\bis\b)\s*([A-Za-z0-9_-]{6,32})/i;
  const labeledMatch = cleaned.match(labeledRegex);
  if (labeledMatch && labeledMatch[1]) {
    const candidate = labeledMatch[1].trim();
    const headerWords = new Set(['is', 'was', 'the', 'status', 'completed', 'amount', 'detail', 'details', 'receipt', 'code', 'number', 'pending', 'verified']);
    if (
      !headerWords.has(candidate.toLowerCase()) &&
      !/^(?:09|07|2519|2517)\d{8}$/.test(candidate) &&
      /\d/.test(candidate)
    ) {
      return candidate.toUpperCase();
    }
  }

  // 6. Alphanumeric transaction codes (TX..., TB..., DTS..., 9AC4827X19)
  const mixedTxMatch = cleaned.match(/\b((?:[A-Z]{1,3}[0-9]{6,15}|[0-9][A-Z0-9]{7,13})[A-Z0-9]*)\b/i);
  if (mixedTxMatch && mixedTxMatch[1]) {
    const tok = mixedTxMatch[1].trim().toUpperCase();
    if (/\d/.test(tok) && /[A-Z]/i.test(tok) && !/^(?:2519|2517|09|07)\d{8}$/.test(tok)) {
      return tok;
    }
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

  // 8. Strip outer punctuation and quotes from single alphanumeric code tokens (>= 6 chars, contains digit)
  const cleanSingleToken = cleaned.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '');
  const commonWordBlacklist = /^(?:verify|receipt|payment|telebirr|abyssinia|dashen|fayda|ethiopia|success|completed|failed|hello|start|cancel|search|profile|roommate|spacematch|status|amount)$/i;
  if (/^[a-zA-Z0-9_-]{6,32}$/.test(cleanSingleToken) && !commonWordBlacklist.test(cleanSingleToken) && /\d/.test(cleanSingleToken)) {
    return cleanSingleToken.toUpperCase();
  }

  return '';
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
  expectedFee: number = Number(process.env.NEXT_PUBLIC_UNLOCK_FEE || '100'),
  preferredBank?: string
): Promise<VerifyEtResult> {
  const apiKey = (process.env.VERIFY_ET_API_KEY || '').trim();
  const accountHolder = (process.env.PAYMENT_ACCOUNT_HOLDER || 'Wahid').trim();
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
    return {
      success: false,
      message: 'Server configuration error: Payment verification is temporarily unavailable.',
      messageAm: 'የአገልጋይ ውቅር ችግር፡ የክፍያ ማረጋገጫ አገልግሎት ለጊዜው አይሰራም።',
      errorCode: 'CONFIG_ERROR',
    };
  }

  const endpoint = 'https://verify.et/api/verify?waitMs=5000';

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
  } else if (normalizedBank === 'cbebirr' || normalizedBank === 'cbe birr') {
    normalizedBank = 'cbe';
  }
  const refUpper = cleanRef.toUpperCase();
  const refLower = cleanRef.toLowerCase();
  const isCbeRef = refUpper.startsWith('FT') || refLower.includes('cbe.com.et');
  const isDashenRef = refUpper.startsWith('DTS') || refLower.includes('dashen');
  const isBoaRef = refUpper.startsWith('TX') || refLower.includes('abyssinia');
  const isTelebirrRef =
    refUpper.startsWith('DK') ||
    refUpper.startsWith('DL') ||
    (refUpper.startsWith('DT') && !refUpper.startsWith('DTS')) ||
    refLower.includes('ethiotelecom') ||
    refLower.includes('telebirr');

  if (!normalizedBank) {
    if (isCbeRef) {
      normalizedBank = 'cbe';
    } else if (isBoaRef) {
      normalizedBank = 'boa';
    } else if (isDashenRef) {
      normalizedBank = 'dashen';
    } else if (isTelebirrRef) {
      normalizedBank = 'telebirr';
    }
  }

  // Strictly target identified bank, or evaluate all banks (Telebirr, CBE, BoA, Dashen)
  let bankConfigs: typeof allConfigs;
  if (normalizedBank) {
    bankConfigs = allConfigs.filter((c) => c.bank === normalizedBank);
    if (bankConfigs.length === 0) {
      bankConfigs = [{ bank: normalizedBank, settlementAccount: receiverPhone.trim() || '0987310978' }];
    }
  } else {
    bankConfigs = allConfigs;
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
        signal: AbortSignal.timeout(8500),
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

      let data = await response.json();
      lastRawResponse = data;

      // If Verify.ET queued or marked the request pending, poll the status URL
      const pollUrlPath =
        data.links?.statusUrl ||
        data.statusUrl ||
        (data.requestId ? `/api/verify/${data.requestId}` : null);

      if (
        (response.status === 202 ||
          data.status === 'pending' ||
          data.verification?.processingStatus === 'queued' ||
          data.verification?.status === 'pending' ||
          data.message === 'Verification queued.') &&
        pollUrlPath
      ) {
        const pollFullUrl = pollUrlPath.startsWith('http')
          ? pollUrlPath
          : `https://verify.et${pollUrlPath}`;
        const pollInterval = Math.max(1000, Number(data.links?.pollAfterMs || 1500));

        for (let pollAttempt = 1; pollAttempt <= 4; pollAttempt++) {
          await new Promise((resolve) => setTimeout(resolve, pollInterval));
          try {
            const pollRes = await fetch(pollFullUrl, {
              headers: { 'x-api-key': apiKey },
              signal: AbortSignal.timeout(5000),
            });
            if (!pollRes.ok) continue;
            const pollData = await pollRes.json();
            lastRawResponse = pollData;

            const isPolledVerified =
              pollData.verification?.verified === true ||
              pollData.verification?.status === 'success' ||
              pollData.verified === true ||
              pollData.status === 'success' ||
              pollData.status === 'verified' ||
              pollData.message === 'Verification completed.' ||
              (Array.isArray(pollData.data)
                ? pollData.data[0]?.verified === true || pollData.data[0]?.status === 'success'
                : pollData.data?.verified === true || pollData.data?.status === 'success') ||
              pollData.data?.result?.verified === true;

            if (isPolledVerified || pollData.verification?.processingStatus === 'completed') {
              data = pollData;
              break;
            }
            const procStatus = String(pollData.verification?.processingStatus || pollData.status || '').toLowerCase();
            if (procStatus === 'failed' || procStatus === 'rejected' || procStatus === 'error') {
              data = pollData;
              break;
            }
          } catch (pollErr) {
            console.warn(`[verify-et] Poll attempt ${pollAttempt} error for ${config.bank}:`, pollErr);
          }
        }
      }

      // Verify.ET may return record in data.data?.result, data.verification?.result, data.data[0], data.data, or root
      const record =
        data.data?.result ||
        data.verification?.result ||
        (Array.isArray(data.data)
          ? data.data[0]
          : data.data && typeof data.data === 'object'
          ? data.data
          : data);
      const verificationObj =
        data.verification && typeof data.verification === 'object' ? data.verification : {};

      // 1. Evaluate response verification status across both root and nested schemas (respect explicit verified === false)
      const explicitRejected =
        data.verified === false ||
        record?.verified === false ||
        verificationObj?.verified === false ||
        data.status === 'failed' ||
        data.status === 'rejected' ||
        record?.status === 'failed' ||
        record?.status === 'rejected';
      const isStatusVerified =
        !explicitRejected &&
        (data.status === 'verified' ||
          data.status === 'success' ||
          data.verified === true ||
          record?.status === 'verified' ||
          record?.status === 'success' ||
          record?.verified === true ||
          verificationObj?.status === 'success' ||
          verificationObj?.status === 'verified' ||
          verificationObj?.verified === true);

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
      const returnedSettlementAccount =
        record?.settlementAccount ||
        record?.receiverAccount ||
        data.settlementAccount;
      if (returnedSettlementAccount) {
        const cleanSettlement = config.settlementAccount.replace(/\D/g, '');
        const cleanReturned = String(returnedSettlementAccount).replace(/\D/g, '');
        const last4 = cleanSettlement.slice(-4);
        const isMatched =
          cleanSettlement === cleanReturned ||
          (cleanReturned.length >= 4 && last4.length === 4 && cleanReturned.endsWith(last4));
        if (!isMatched) {
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
      }

      // 3. Ensure paid amount matches or exceeds expected fee
      const rawAmtCandidate =
        record?.amount ??
        record?.paidAmount ??
        record?.settledAmountValue ??
        record?.settledAmount ??
        data.amount ??
        data.paidAmount ??
        0;
      const parsedAmtNum =
        typeof rawAmtCandidate === 'number'
          ? rawAmtCandidate
          : parseFloat(String(rawAmtCandidate).replace(/,/g, '').replace(/[^0-9.]/g, ''));
      const paidAmount = Number.isFinite(parsedAmtNum) ? parsedAmtNum : 0;

      if (paidAmount < expectedFee) {
        return {
          success: false,
          message:
            paidAmount > 0
              ? `Insufficient payment. Received ${paidAmount} ETB, but fee requires at least ${expectedFee} ETB.`
              : `Could not verify a valid payment amount (requires at least ${expectedFee} ETB). Please double-check your receipt.`,
          messageAm:
            paidAmount > 0
              ? `የተከፈለው ገንዘብ መጠን በቂ አይደለም። የተከፈለው ${paidAmount} ብር ሲሆን የሚያስፈልገው ክፍያ ${expectedFee} ብር ነው።`
              : `የተከፈለው የገንዘብ መጠን (ቢያንስ ${expectedFee} ብር) ማረጋገጥ አልተቻለም። እባክዎ ደረሰኝዎን ያረጋግጡ።`,
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
        paidAmount,
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
