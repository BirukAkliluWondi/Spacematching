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
    const queryId = extracted.match(/[?&](?:id|trx|ref)=([A-Z0-9_-]{6,32})/i);
    if (queryId?.[1]) return queryId[1].toUpperCase();
    const pathTail = extracted.match(/\/(?:receipt|verify|tx)\/([A-Z0-9_-]{6,32})(?:[/?#]|$)/i);
    if (pathTail?.[1]) return pathTail[1].toUpperCase();
    const cbeShortMatch = extracted.match(/cbe\.com\.et\/(FT[A-Z0-9]{6,16})(?:-\d{6,10})?(?:[/?#]|$)/i);
    if (cbeShortMatch?.[1]) return cbeShortMatch[1].toUpperCase();
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
    /https?:\/\/(?:[a-z0-9-]+\.)*(?:cbe\.com\.et|ethiotelecom\.et\/receipt|transactioninfo\.ethiotelecom\.et|bankofabyssinia\.com|dashenbanksc\.com|dashensuperapp\.com|awashbank\.com|zemenbank\.com|cbebirr\.et|coopbankoromia\.com\.et)[^\s<>'"`]+[A-Za-z0-9]/i
  );
  if (receiptUrlMatch) {
    return receiptUrlMatch[0].trim().replace(/[.,;)]+$/, '');
  }

  // 2. Normalize spaced FT reference codes anywhere in text (e.g. "FT 260920042", "FT 2609 20042", "FT-260920042")
  cleaned = cleaned.replace(/\bFT[\s\-_.:/]+([0-9](?:[\s\-_.:/]*[0-9]){5,15}[A-Z0-9]?)\b/gi, (_, digits) => {
    return 'FT' + digits.replace(/[\s\-_.:/]/g, '').toUpperCase();
  });

  // 3. CBE / BoA FT Reference (e.g., FT2412345678 or FT260920042)
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

  // 4. Amharic labeled pattern (checked BEFORE generic heuristics so labels win over word-like tokens)
  const amharicRegex =
    /(?:የ(?:ግብይት|ደረሰኝ|ማጣቀሻ|ክፍያ)\s*(?:ቁጥር|መለያ)?|መለያ\s*ቁጥር|ትራንዛክሽን\s*(?:ቁጥር|መለያ)?)\s*[:=\-#፡፦\s]*([A-Za-z0-9_-]+)/u;
  const amharicMatch = cleaned.match(amharicRegex);
  if (amharicMatch && amharicMatch[1]) {
    const candidate = amharicMatch[1].trim();
    if (!/^(?:09|07|2519|2517)\d{8}$/.test(candidate) && candidate.length >= 6 && /\d/.test(candidate)) {
      return candidate.toUpperCase();
    }
  }

  // 5. English labeled pattern: requires explicit punctuation/is delimiter & digit presence
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

  // 6a. Telebirr 10-char (or 11-char OCR split-glyph) Alphanumeric Reference (e.g., DKM7J1EXAP, DKQ1OR1E0P, DKQ1OR1EQOP)
  const tbRegex = /\b((?:D[A-LN-Z]|C[A-Z]|E[A-Z])[A-Z0-9]{8,9})\b/i;
  let tbMatch: RegExpExecArray | null;
  const tbGlobal = new RegExp(tbRegex.source, 'gi');
  while ((tbMatch = tbGlobal.exec(cleaned)) !== null) {
    const token = tbMatch[1].trim().toUpperCase();
    const digitCount = (token.match(/\d/g) || []).length;
    if (
      digitCount >= 2 &&
      !token.startsWith('DTS') &&
      !/^(?:DATE|DASHEN|CUSTOMER|DECEMBER|NOVEMBER|COMPLETED|CLEARING)/.test(token)
    ) {
      return token;
    }
  }

  // 6b. Alphanumeric transaction codes (TX..., TB..., 9AC4827X19) — excluding dates & phone numbers
  const mixedTxMatch = cleaned.match(/\b((?:[A-Z]{1,3}[0-9]{6,15}|[0-9][A-Z0-9]{7,13})[A-Z0-9]*)\b/i);
  if (mixedTxMatch && mixedTxMatch[1]) {
    const tok = mixedTxMatch[1].trim().toUpperCase();
    if (
      /\d/.test(tok) &&
      /[A-Z]/i.test(tok) &&
      !/^(?:2519|2517|09|07)\d{8}$/.test(tok) &&
      !/^\d{1,2}(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\d{4}$/i.test(tok)
    ) {
      return tok;
    }
  }

  // 7. Standalone 8-16 digit numbers excluding phones, YYYYMMDD/DDMMYYYY dates, and known settlement accounts
  const phoneRegex = /^(?:\+?251|0)?[97]\d{8}$/;
  const isoDateRegex = /^(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d*$/;
  const dmyDateRegex = /^(?:0[1-9]|[12]\d|3[01])(?:0[1-9]|1[0-2])(?:19|20)\d{2}$/;
  const knownSettlementDigits = new Set(
    [
      '0987310978',
      '256861771',
      '2922175078411',
      '1000054066094',
      process.env.TELEBIRR_RECEIVER_PHONE || '',
      process.env.ABYSSINIA_ACCOUNT_NUMBER || '',
      process.env.DASHEN_ACCOUNT_NUMBER || '',
      process.env.CBE_ACCOUNT_NUMBER || '',
    ]
      .map((s) => s.replace(/\D/g, ''))
      .filter(Boolean)
  );
  const numericTokens = cleaned.match(/\b\d{8,16}\b/g);
  if (numericTokens) {
    const validToken = numericTokens.find(
      (token) =>
        !phoneRegex.test(token) &&
        !isoDateRegex.test(token) &&
        !dmyDateRegex.test(token) &&
        !knownSettlementDigits.has(token)
    );
    if (validToken) {
      return validToken;
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

function getLinksEtApiKey(): string {
  const direct = (process.env.LINKS_ET_API_KEY || '').trim();
  if (direct) return direct;
  const legacy = (process.env.VERIFY_ET_API_KEY || '').trim();
  return legacy.startsWith('vk_live_') || legacy.startsWith('vk_test_') ? legacy : '';
}

function getConfiguredAccounts() {
  const receiverPhone = (process.env.TELEBIRR_RECEIVER_PHONE || '0987310978').trim() || '0987310978';
  const abyssiniaAccount = (process.env.ABYSSINIA_ACCOUNT_NUMBER || '256861771').trim() || '256861771';
  const dashenAccount = (process.env.DASHEN_ACCOUNT_NUMBER || '2922175078411').trim() || '2922175078411';
  const cbeAccount = (process.env.CBE_ACCOUNT_NUMBER || '1000054066094').trim() || '1000054066094';
  const allConfigs = [
    { bank: 'telebirr', settlementAccount: receiverPhone },
    { bank: 'boa', settlementAccount: abyssiniaAccount },
    { bank: 'dashen', settlementAccount: dashenAccount },
    { bank: 'cbe', settlementAccount: cbeAccount },
  ];
  return { receiverPhone, abyssiniaAccount, dashenAccount, cbeAccount, allConfigs };
}

function matchesSettlementAccount(returnedSettlementAccount: unknown, expectedAccount: string): boolean {
  const cleanSettlement = expectedAccount.replace(/\D/g, '');
  if (!cleanSettlement) return false;
  const settlementVariants = new Set<string>([cleanSettlement]);
  if (/^0[79]\d{8}$/.test(cleanSettlement)) {
    settlementVariants.add('251' + cleanSettlement.slice(1));
    settlementVariants.add(cleanSettlement.slice(1));
  } else if (/^251[79]\d{8}$/.test(cleanSettlement)) {
    settlementVariants.add('0' + cleanSettlement.slice(3));
    settlementVariants.add(cleanSettlement.slice(3));
  }

  const rawStr = String(returnedSettlementAccount);
  const cleanReturned = rawStr.replace(/\D/g, '');
  if (/[*xX]/.test(rawStr)) {
    const prefixDigits = (rawStr.split(/[*xX]/)[0] || '').replace(/\D/g, '');
    const suffixDigits = (rawStr.split(/[*xX]/).pop() || '').replace(/\D/g, '');
    return Array.from(settlementVariants).some((variant) => {
      const prefixOk = !prefixDigits || variant.startsWith(prefixDigits);
      const suffixOk = suffixDigits.length >= 2 && variant.endsWith(suffixDigits);
      return prefixOk && suffixOk;
    });
  }
  return Array.from(settlementVariants).some((variant) => {
    const vLast4 = variant.slice(-4);
    return (
      variant === cleanReturned ||
      (cleanReturned.length >= 4 && vLast4.length === 4 && cleanReturned.endsWith(vLast4))
    );
  });
}

function normalizeProviderBank(rawProvider?: string | null): string {
  const norm = (rawProvider || '').toLowerCase().trim();
  if (!norm) return 'bank';
  if (norm === 'abyssinia' || norm === 'boa-json' || norm === 'boa-qr') return 'boa';
  if (norm === 'cbebirr' || norm === 'cbe birr' || norm === 'cbe-pdf' || norm === 'mb-json') return 'cbe';
  if (norm === 'telebirr-html') return 'telebirr';
  if (norm === 'dashen-html' || norm === 'dashen-pdf') return 'dashen';
  return norm;
}

/**
 * Builds Links.et POST /api/verify payloads:
 * - Full receipt URLs: { url, expect, waitMs: 8000 }
 * - Telebirr short refs: { reference, expect, waitMs: 8000 }
 * - CBE FT... short refs: reconstructed https://mbreciept.cbe.com.et/<FT_REF>-<8_DIGIT_SUFFIX>
 * - Other bare bank refs without a URL require screenshot upload or full receipt URL
 */
function buildLinksEtVerifyPayload(
  bank: string,
  cleanRef: string,
  settlementAccount: string,
  expectedFee: number,
  cbeAccount: string
): { payload: Record<string, unknown> } | { needsFullUrl: true } {
  const expectObj: Record<string, unknown> = {
    amount: expectedFee,
    ...(settlementAccount ? { receiverAccount: settlementAccount } : {}),
  };

  if (/^https?:\/\//i.test(cleanRef)) {
    return {
      payload: {
        url: cleanRef,
        expect: expectObj,
        waitMs: 8000,
      },
    };
  }

  const norm = bank.toLowerCase();
  if (norm === 'telebirr') {
    return {
      payload: {
        reference: cleanRef,
        expect: expectObj,
        waitMs: 8000,
      },
    };
  }

  if (norm === 'cbe' && /^FT[0-9A-Z]{6,16}$/i.test(cleanRef)) {
    const suffix8 = cbeAccount.replace(/\D/g, '').slice(-8);
    if (suffix8.length === 8) {
      return {
        payload: {
          url: `https://mbreciept.cbe.com.et/${cleanRef.toUpperCase()}-${suffix8}`,
          expect: expectObj,
          waitMs: 8000,
        },
      };
    }
  }

  return { needsFullUrl: true };
}

/**
 * Maps upstream bank verification responses and HTTP errors to friendly, white-labeled English & Amharic messages.
 * Never exposes third-party verifier branding or raw technical errors to end users.
 */
function mapVerifyError(
  upstreamText: string,
  statusCode?: number,
  bank?: string,
  apiErrorCode?: string
): { message: string; messageAm: string; errorCode: string } {
  const lower = (upstreamText || '').toLowerCase();
  const codeLower = (apiErrorCode || '').toLowerCase();
  const bankName = bank ? bank.toUpperCase() : 'ባንክ';

  if (
    codeLower === 'provider_needs_full_url' ||
    codeLower === 'no_reference' ||
    codeLower === 'unsupported_provider'
  ) {
    return {
      message:
        'Please upload a clear screenshot of your payment receipt or paste the full bank receipt link so we can verify it with your bank.',
      messageAm:
        'ክፍያውን ከባንክ ጋር ለማረጋገጥ እባክዎ የክፍያ ደረሰኝዎን ግልጽ ስክሪንሽት ፎቶ ይላኩ ወይም ሙሉ የባንክ ደረሰኝ ማስፈንጠሪያ (link) ያስገቡ።',
      errorCode: 'NEEDS_FULL_URL_OR_SCREENSHOT',
    };
  }

  // 1. Auth/Config/Quota errors (never burn retries on 401/402/403 or quota caps)
  if (
    statusCode === 401 ||
    statusCode === 402 ||
    statusCode === 403 ||
    codeLower === 'missing_key' ||
    codeLower === 'invalid_key' ||
    codeLower === 'revoked_key' ||
    codeLower === 'quota_exceeded' ||
    codeLower === 'image_cap_reached' ||
    codeLower === 'ocr_daily_cap_reached' ||
    codeLower === 'ai_not_configured' ||
    lower.includes('unauthorized') ||
    lower.includes('api key') ||
    lower.includes('insufficient credits') ||
    lower.includes('quota')
  ) {
    return {
      message: 'The bank verification system is undergoing maintenance. Please try again in a few minutes.',
      messageAm: 'የባንክ ማረጋገጫ ስርዓት ለጊዜው በጥገና ላይ ነው። እባክዎ ከጥቂት ደቂቃዎች በኋላ እንደገና ይሞክሩ።',
      errorCode: 'SERVICE_MAINTENANCE',
    };
  }

  // 2. High traffic / Rate limited
  if (
    statusCode === 429 ||
    codeLower === 'rate_limited' ||
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

  // 3. Screenshot detection / upload errors
  if (
    codeLower === 'detection_failed' ||
    codeLower === 'image_too_large' ||
    codeLower === 'not_an_image'
  ) {
    return {
      message:
        'Could not clearly read this receipt screenshot. Please upload a sharper, closer image or paste the full receipt link/reference.',
      messageAm:
        'ይህን የደረሰኝ ፎቶ በግልጽ ማንበብ አልተቻለም። እባክዎ የደረሰኙ ቁጥር በግልጽ የሚታይበትን ፎቶ ይላኩ ወይም የግብይት ቁጥሩን ይጻፉ።',
      errorCode: 'IMAGE_READ_FAILED',
    };
  }

  // 4. Transaction not found in bank system
  if (
    statusCode === 404 ||
    codeLower === 'not_found' ||
    lower.includes('not found') ||
    lower.includes('not_found') ||
    /no\s+[a-z\s]*\bfound\b/i.test(lower) ||
    lower.includes('no record') ||
    lower.includes('does not exist') ||
    lower.includes('cannot find') ||
    lower.includes('not exist')
  ) {
    return {
      message:
        'Transaction record was not found with the bank. Please ensure the payment was completed and the reference number or receipt screenshot is correct.',
      messageAm:
        'ይህ የክፍያ ግብይት በባንኩ አልተገኘም። እባክዎ ክፍያው በተሳካ ሁኔታ መጠናቀቁን እና የደረሰኝ ቁጥሩ ወይም ፎቶው ትክክል መሆኑን ያረጋግጡ።',
      errorCode: 'NOT_FOUND',
    };
  }

  // 5. Payment still pending or queued
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

  // 6. Invalid or malformed reference format
  if (
    statusCode === 400 ||
    statusCode === 422 ||
    codeLower === 'invalid_json' ||
    codeLower === 'invalid_request' ||
    lower.includes('receipt link') ||
    lower.includes('must be') ||
    lower.includes('invalid') ||
    lower.includes('format') ||
    lower.includes('malformed') ||
    lower.includes('unsupported')
  ) {
    return {
      message:
        'Invalid transaction reference format. Please upload a clear payment receipt screenshot or provide a valid transaction code (e.g. Telebirr reference) or full receipt link.',
      messageAm:
        'የግብይት ደረሰኝ ቁጥር ቅርጸት ልክ አይደለም። እባክዎ የከፈሉበትን የደረሰኝ ስክሪንሽት ፎቶ ይላኩ ወይም ትክክለኛ የግብይት ቁጥር / ሙሉ ማስፈንጠሪያ ያስገቡ።',
      errorCode: 'INVALID_FORMAT',
    };
  }

  // 7. Upstream service downtime / Server error
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

  // 8. Payment cancelled or failed
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
      ? `Payment transaction could not be verified via ${bank.toUpperCase()}. Please check your receipt or upload a clearer screenshot.`
      : 'Payment transaction status could not be verified. Please check your reference code or upload a receipt screenshot.',
    messageAm: bank
      ? `ይህ የክፍያ ግብይት በ${bankName} ሊረጋገጥ አልቻለም። እባክዎ ደረሰኝዎን አረጋግጠው ወይም ግልጽ ፎቶ ይላኩ።`
      : 'የክፍያ ግብይቱ ሊረጋገጥ አልቻለም። እባክዎ የደረሰኝ ቁጥርዎን አረጋግጠው ወይም ፎቶ ይላኩ።',
    errorCode: 'VERIFICATION_FAILED',
  };
}

function parseNumericAmount(raw: unknown): number {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  }
  if (raw == null) return 0;
  const match = String(raw).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!match) return 0;
  const val = parseFloat(match[0]);
  return Number.isFinite(val) && val > 0 ? val : 0;
}

/**
 * Validates Links.et /api/verify (or /api/verify-image upstream result) envelope strictly:
 * confirms ok=true, non-cancelled status, settlement receiver account match, and net paidAmount >= expectedFee.
 */
function validateLinksEtEnvelope(
  envelope: Record<string, any>,
  expectedFee: number,
  expectedAccount: string | undefined,
  bankHint: string | undefined,
  fallbackRef: string
): VerifyEtResult {
  const { allConfigs } = getConfiguredAccounts();
  const providerKey = normalizeProviderBank(
    envelope.providerKey || envelope.receipt?.source || bankHint
  );
  const receipt = (envelope.receipt && typeof envelope.receipt === 'object' ? envelope.receipt : {}) as Record<string, any>;
  const nestedTx = (receipt.transaction && typeof receipt.transaction === 'object' ? receipt.transaction : {}) as Record<string, any>;

  const txStatusStr = String(
    receipt.transactionStatus || receipt.upstreamStatus || receipt.status || ''
  ).toLowerCase();
  if (txStatusStr.includes('pending') || txStatusStr.includes('process') || txStatusStr.includes('queue')) {
    return {
      success: false,
      message: 'Payment verification is still processing by the bank. Please wait a minute and submit again.',
      messageAm: 'የክፍያ ማረጋገጫው በባንኩ በሂደት ላይ ነው። እባክዎ ጥቂት ደቂቃዎች ቆይተው እንደገና ይላኩ።',
      errorCode: 'PAYMENT_PENDING',
      bank: providerKey,
      rawResponse: envelope,
    };
  }
  if (txStatusStr.includes('fail') || txStatusStr.includes('cancel') || txStatusStr.includes('reject')) {
    return {
      success: false,
      message: 'This bank transaction was unsuccessful or cancelled.',
      messageAm: 'ይህ የባንክ ግብይት ያልተሳካ ወይም የተሰረዘ ነው።',
      errorCode: 'TRANSACTION_FAILED',
      bank: providerKey,
      rawResponse: envelope,
    };
  }

  // Settlement account verification
  const receiverCheck = envelope.receiverCheck as Record<string, any> | undefined;
  const returnedSettlementAccount =
    receipt.creditedPartyAccountNo ||
    receipt.receiverAccount ||
    receipt.recipientAccount ||
    receipt.receiverNumber ||
    receipt.bankAccountNumber ||
    nestedTx.beneficiaryAccount ||
    receiverCheck?.receiver?.account;

  const targetExpectedAccount =
    expectedAccount ||
    allConfigs.find((c) => c.bank === providerKey)?.settlementAccount;

  if (receiverCheck?.account === 'mismatch') {
    return {
      success: false,
      message:
        'Payment was sent to a different account number. Please ensure payment was transferred to our designated account.',
      messageAm:
        'ክፍያው የተላከው ወደ ሌላ የባንክ/ቴሌብር ሂሳብ ነው። እባክዎ ክፍያው ወደ ተሰጠው ትክክለኛ የሂሳብ ቁጥር መላኩን ያረጋግጡ።',
      errorCode: 'ACCOUNT_MISMATCH',
      bank: providerKey,
      rawResponse: envelope,
    };
  }

  if (returnedSettlementAccount) {
    const allowedAccounts = targetExpectedAccount
      ? [targetExpectedAccount]
      : allConfigs.map((c) => c.settlementAccount);
    const anyMatch = allowedAccounts.some((acc) => matchesSettlementAccount(returnedSettlementAccount, acc));
    if (!anyMatch) {
      console.warn(
        `[verify-et] Settlement account mismatch for ${providerKey}: expected ${targetExpectedAccount || 'configured accounts'}, got ${returnedSettlementAccount}`
      );
      return {
        success: false,
        message:
          'Payment was sent to a different account number. Please ensure payment was transferred to our designated account.',
        messageAm:
          'ክፍያው የተላከው ወደ ሌላ የባንክ/ቴሌብር ሂሳብ ነው። እባክዎ ክፍያው ወደ ተሰጠው ትክክለኛ የሂሳብ ቁጥር መላኩን ያረጋግጡ።',
        errorCode: 'ACCOUNT_MISMATCH',
        bank: providerKey,
        rawResponse: envelope,
      };
    }
  }

  // Net paid amount validation across all provider receipt shapes
  const amountCheck = envelope.amountCheck as Record<string, any> | undefined;
  const netAmountCandidates = [
    amountCheck?.paid,
    receipt.settledAmount,
    receipt.transferredAmount,
    receipt.creditAmount,
    nestedTx.amount,
    receipt.totalAmountPaid,
    receipt.totalPaidAmount,
    receipt.totalAmount,
    receipt.amount,
  ];
  let paidAmount = 0;
  for (const cand of netAmountCandidates) {
    const num = parseNumericAmount(cand);
    if (num > 0) {
      paidAmount = num;
      break;
    }
  }

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
      bank: providerKey,
      rawResponse: envelope,
    };
  }

  const senderName =
    receipt.payerName ||
    nestedTx.senderName ||
    receipt.sourceAccountName ||
    receipt.customer?.customerName ||
    'Verified Payer';

  const txNum =
    receipt.receiptNo ||
    receipt.reference ||
    receipt.transactionReference ||
    receipt.transactionId ||
    nestedTx.transactionId ||
    receipt.paymentReference ||
    fallbackRef;

  const bankLabel = providerKey.toUpperCase();
  return {
    success: true,
    message: `Payment receipt verified successfully via ${bankLabel}.`,
    messageAm: `የክፍያ ደረሰኝ በ${bankLabel} በተሳካ ሁኔታ ተረጋግጧል።`,
    transactionNumber: String(txNum || fallbackRef).trim(),
    paidAmount,
    senderName: String(senderName).trim(),
    bank: providerKey,
    rawResponse: envelope,
  };
}

/**
 * Verifies a payment receipt screenshot directly using Links.et POST /api/verify-image.
 * Automatically resizes oversized buffers (>3.5MB) via sharp so the base64 payload stays under 5MB.
 */
export async function verifyReceiptImageWithLinksEt(
  imageBuffer: Buffer,
  expectedFee: number = Number(process.env.NEXT_PUBLIC_UNLOCK_FEE || '100'),
  preferredBank?: string
): Promise<VerifyEtResult> {
  const apiKey = getLinksEtApiKey();
  if (!apiKey) {
    return {
      success: false,
      message: 'Server configuration error: Payment verification is temporarily unavailable.',
      messageAm: 'የአገልጋይ ውቅር ችግር፡ የክፍያ ማረጋገጫ አገልግሎት ለጊዜው አይሰራም።',
      errorCode: 'CONFIG_ERROR',
    };
  }

  const { receiverPhone, abyssiniaAccount, dashenAccount, cbeAccount, allConfigs } = getConfiguredAccounts();
  const normHint = preferredBank ? normalizeProviderBank(preferredBank) : undefined;
  const expectedConfig = normHint ? allConfigs.find((c) => c.bank === normHint) : undefined;

  let uploadBuffer = imageBuffer;
  try {
    if (uploadBuffer.byteLength > 3_500_000) {
      const sharp = (await import('sharp')).default;
      uploadBuffer = await sharp(uploadBuffer)
        .rotate()
        .resize({ width: 1600, withoutEnlargement: true })
        .jpeg({ quality: 86 })
        .toBuffer();
    }
  } catch {
    // Keep original buffer if sharp resize fails
  }

  const imageBase64 = uploadBuffer.toString('base64');
  const expectObj: Record<string, unknown> = {
    amount: expectedFee,
    ...(expectedConfig?.settlementAccount
      ? { receiverAccount: expectedConfig.settlementAccount }
      : {}),
  };

  try {
    const response = await fetch('https://links.et/api/verify-image', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        imageBase64,
        expect: expectObj,
      }),
      signal: AbortSignal.timeout(25000),
    });

    const rawText = await response.text();
    let data: Record<string, any> = {};
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      data = {};
    }

    if (!response.ok) {
      const errCode = data.error?.code;
      const errMsg = typeof data.error === 'string' ? data.error : (data.error?.message || data.message || rawText);
      const mapped = mapVerifyError(errMsg, response.status, normHint, errCode);
      return { ...mapped, success: false, rawResponse: data || rawText };
    }

    const upstream = data.upstream as Record<string, any> | undefined;
    const detected = data.detected as Record<string, any> | undefined;
    const detectedProvider = normalizeProviderBank(detected?.provider);

    // Handle Bank of Abyssinia QR-only confirmation
    if (upstream?.reason === 'qr_receipt' && upstream?.receipt) {
      const mergedEnvelope = {
        providerKey: upstream.provider || detectedProvider || 'boa',
        receipt: upstream.receipt,
        receiverCheck: data.receiverCheck,
        amountCheck: data.amountCheck,
      };
      return validateLinksEtEnvelope(
        mergedEnvelope,
        expectedFee,
        abyssiniaAccount,
        'boa',
        String(detected?.reference || upstream.receipt?.transactionReference || '')
      );
    }

    if (upstream?.attempted && upstream?.result) {
      const resultObj = upstream.result as Record<string, any>;
      if (resultObj.quotaExceeded) {
        return {
          ...mapVerifyError('quota exceeded', 429, detectedProvider, 'quota_exceeded'),
          success: false,
          rawResponse: data,
        };
      }
      if (resultObj.ok === true) {
        const mergedEnvelope = {
          ...resultObj,
          receiverCheck: resultObj.receiverCheck ?? data.receiverCheck,
          amountCheck: resultObj.amountCheck ?? data.amountCheck,
        };
        const fallbackAccount =
          detectedProvider === 'telebirr'
            ? receiverPhone
            : detectedProvider === 'cbe'
            ? cbeAccount
            : detectedProvider === 'boa'
            ? abyssiniaAccount
            : detectedProvider === 'dashen'
            ? dashenAccount
            : expectedConfig?.settlementAccount;
        return validateLinksEtEnvelope(
          mergedEnvelope,
          expectedFee,
          fallbackAccount,
          detectedProvider,
          String(detected?.reference || upstream.url || '')
        );
      }
      const errStr = typeof resultObj.error === 'string' ? resultObj.error : '';
      return {
        ...mapVerifyError(errStr || 'Bank verification failed', resultObj.httpStatus || 502, detectedProvider),
        success: false,
        rawResponse: data,
      };
    }

    const reason = String(upstream?.reason || '');
    const mapped = mapVerifyError(
      upstream?.error || reason || 'Could not detect receipt reference',
      400,
      detectedProvider,
      reason || undefined
    );
    return { ...mapped, success: false, rawResponse: data };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.warn('[verify-et] Screenshot verification connection warning:', errMsg);
    return {
      success: false,
      message: 'Network connection error while verifying your receipt screenshot. Please try again.',
      messageAm: 'የደረሰኝ ፎቶውን በማረጋገጥ ላይ የመረብ ግንኙነት ችግር አጋጥሟል። እባክዎ ትንሽ ቆይተው እንደገና ይሞክሩ።',
      errorCode: 'NETWORK_ERROR',
    };
  }
}

/**
 * Validates Telebirr, Bank of Abyssinia, Dashen Bank, or CBE transaction receipts.
 * Tier 1 checks Telebirr receipts directly at zero API cost; Tier 2 routes via Links.et /api/verify.
 */
export async function verifyTelebirrPayment(
  referenceNumber: string,
  expectedFee: number = Number(process.env.NEXT_PUBLIC_UNLOCK_FEE || '100'),
  preferredBank?: string
): Promise<VerifyEtResult> {
  const apiKey = getLinksEtApiKey();
  const { receiverPhone, abyssiniaAccount, dashenAccount, cbeAccount, allConfigs } = getConfiguredAccounts();
  const cleanRef = extractTransactionReference(referenceNumber);

  type DirectTelebirrOutcome =
    | { kind: 'terminal'; result: VerifyEtResult }
    | { kind: 'not_found'; authoritative: boolean }
    | { kind: 'unavailable' };

  const extractTelebirrReceiptId = (candidateRef: string): string => {
    const trimmed = candidateRef.trim();
    const urlMatch = trimmed.match(/ethiotelecom\.et\/receipt\/([A-Z0-9_-]{6,32})/i);
    if (urlMatch?.[1]) return urlMatch[1].toUpperCase();
    return trimmed.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '').toUpperCase();
  };

  const verifyTelebirrDirect = async (
    candidateRef: string,
    expectedTelebirrAccount: string
  ): Promise<DirectTelebirrOutcome> => {
    const txId = extractTelebirrReceiptId(candidateRef);
    if (!txId || !/^[A-Z0-9]{6,20}$/.test(txId)) {
      return { kind: 'unavailable' };
    }
    try {
      const res = await fetch(`https://transactioninfo.ethiotelecom.et/receipt/${encodeURIComponent(txId)}`, {
        method: 'GET',
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': 'Mozilla/5.0 (compatible; SpaceMatchAddis/1.0)',
        },
        signal: AbortSignal.timeout(7000),
      });

      if (res.status === 404) {
        return { kind: 'not_found', authoritative: false };
      }
      if (!res.ok) {
        return { kind: 'unavailable' };
      }

      const html = await res.text();
      if (/this request is not correct/i.test(html)) {
        return { kind: 'not_found', authoritative: true };
      }
      if (!/(?:telebirr|ethiotelecom|credited\s*party)/i.test(html) || !/<td\b/i.test(html)) {
        return { kind: 'unavailable' };
      }

      const tdCells = [...html.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
        .map((m) =>
          m[1]
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/gi, ' ')
            .replace(/&amp;/gi, '&')
            .replace(/\s+/g, ' ')
            .trim()
        )
        .filter(Boolean);

      const findNextCell = (labelRe: RegExp): string => {
        const idx = tdCells.findIndex((c) => labelRe.test(c));
        return idx !== -1 && idx + 1 < tdCells.length ? tdCells[idx + 1] : '';
      };

      let txStatus = '';
      const statusIdx = tdCells.findIndex((c) => /transaction\s*status/i.test(c));
      if (statusIdx !== -1) {
        const inlineMatch = tdCells[statusIdx].match(/transaction\s*status\s*[:\-]?\s*([A-Za-z]+)/i);
        txStatus = (inlineMatch?.[1] || tdCells[statusIdx + 1] || '').trim().toLowerCase();
      }

      if (!txStatus) {
        return { kind: 'unavailable' };
      }
      if (txStatus.includes('pending') || txStatus.includes('process') || txStatus.includes('queue')) {
        return {
          kind: 'terminal',
          result: {
            success: false,
            message: 'Payment verification is still processing by Telebirr. Please wait a minute and submit again.',
            messageAm: 'የቴሌብር ክፍያው በሂደት ላይ ነው። እባክዎ ትንሽ ቆይተው እንደገና ይሞክሩ።',
            errorCode: 'PAYMENT_PENDING',
            bank: 'telebirr',
          },
        };
      }
      if (txStatus.includes('fail') || txStatus.includes('cancel') || txStatus.includes('reject')) {
        return {
          kind: 'terminal',
          result: {
            success: false,
            message: 'This Telebirr transaction was unsuccessful or cancelled.',
            messageAm: 'ይህ የቴሌብር ግብይት ያልተሳካ ወይም የተሰረዘ ነው።',
            errorCode: 'TRANSACTION_FAILED',
            bank: 'telebirr',
          },
        };
      }
      if (txStatus !== 'completed' && txStatus !== 'success' && txStatus !== 'paid') {
        return { kind: 'unavailable' };
      }

      const creditedAccount = findNextCell(/credited\s*party\s*account\s*no/i);
      if (!creditedAccount) {
        // Fail closed rather than accepting a receipt without a verifiable receiver account
        return { kind: 'unavailable' };
      }
      if (!matchesSettlementAccount(creditedAccount, expectedTelebirrAccount)) {
        return {
          kind: 'terminal',
          result: {
            success: false,
            message:
              'Payment was sent to a different account number. Please ensure payment was transferred to our designated account.',
            messageAm:
              'ክፍያው የተላከው ወደ ሌላ የባንክ/ቴሌብር ሂሳብ ነው። እባክዎ ክፍያው ወደ ተሰጠው ትክክለኛ የሂሳብ ቁጥር መላኩን ያረጋግጡ።',
            errorCode: 'ACCOUNT_MISMATCH',
            bank: 'telebirr',
          },
        };
      }

      const parseBirrAmount = (raw: string): number => {
        const m = raw.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(?:birr|etb)/i);
        return m ? parseFloat(m[1]) : 0;
      };

      let settledAmount = 0;
      const settledIdx = tdCells.findIndex((c) => /settled\s*amount/i.test(c));
      if (settledIdx !== -1) {
        for (let k = settledIdx + 1; k < Math.min(settledIdx + 6, tdCells.length); k++) {
          const val = parseBirrAmount(tdCells[k]);
          if (val > 0) {
            settledAmount = val;
            break;
          }
        }
      }
      if (settledAmount <= 0) {
        const totalPaidStr = findNextCell(/total\s*paid\s*amount/i);
        settledAmount = parseBirrAmount(totalPaidStr);
      }

      if (!Number.isFinite(settledAmount) || settledAmount < expectedFee) {
        return {
          kind: 'terminal',
          result: {
            success: false,
            message:
              settledAmount > 0
                ? `Insufficient payment. Received ${settledAmount} ETB, but fee requires at least ${expectedFee} ETB.`
                : `Could not verify a valid payment amount (requires at least ${expectedFee} ETB). Please double-check your receipt.`,
            messageAm:
              settledAmount > 0
                ? `የተከፈለው ገንዘብ መጠን በቂ አይደለም። የተከፈለው ${settledAmount} ብር ሲሆን የሚያስፈልገው ክፍያ ${expectedFee} ብር ነው።`
                : `የተከፈለው የገንዘብ መጠን (ቢያንስ ${expectedFee} ብር) ማረጋገጥ አልተቻለም። እባክዎ ደረሰኝዎን ያረጋግጡ።`,
            errorCode: 'INSUFFICIENT_AMOUNT',
            paidAmount: settledAmount,
            bank: 'telebirr',
          },
        };
      }

      let invoiceNo = txId;
      const invIdx = tdCells.findIndex((c) => /invoice\s*no/i.test(c));
      if (invIdx !== -1) {
        for (let k = invIdx + 1; k < Math.min(invIdx + 6, tdCells.length); k++) {
          if (/^[A-Z0-9]{6,20}$/i.test(tdCells[k]) && /\d/.test(tdCells[k])) {
            invoiceNo = tdCells[k].toUpperCase();
            break;
          }
        }
      }

      const payerName = findNextCell(/payer\s*name/i) || 'Verified Payer';

      return {
        kind: 'terminal',
        result: {
          success: true,
          message: 'Payment receipt verified successfully via TELEBIRR.',
          messageAm: 'የክፍያ ደረሰኝ በTELEBIRR በተሳካ ሁኔታ ተረጋግጧል።',
          transactionNumber: invoiceNo,
          paidAmount: settledAmount,
          senderName: payerName,
          bank: 'telebirr',
        },
      };
    } catch {
      return { kind: 'unavailable' };
    }
  };

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

  const endpoint = 'https://links.et/api/verify';

  // Infer bank from reference prefix if not explicitly passed
  let normalizedBank = preferredBank?.toLowerCase().trim();
  if (normalizedBank === 'abyssinia') {
    normalizedBank = 'boa';
  } else if (normalizedBank === 'cbebirr' || normalizedBank === 'cbe birr') {
    normalizedBank = 'cbe';
  }
  const refUpper = cleanRef.toUpperCase();
  const refLower = cleanRef.toLowerCase();
  const isFullUrl = /^https?:\/\//i.test(cleanRef);
  const isExplicitCbeUrl = refLower.includes('cbe.com.et');
  const isFtRef = refUpper.startsWith('FT');
  const isDashenRef = refUpper.startsWith('DTS') || refLower.includes('dashen');
  const isBoaRef = refUpper.startsWith('TX') || refLower.includes('abyssinia');
  const isTelebirrRef =
    refUpper.startsWith('DK') ||
    refUpper.startsWith('DL') ||
    (refUpper.startsWith('DT') && !refUpper.startsWith('DTS')) ||
    refUpper.startsWith('DM') ||
    refLower.includes('ethiotelecom') ||
    refLower.includes('telebirr');

  // Strictly target identified bank, evaluate URL once, or check CBE/BoA for bare FT... codes
  let bankConfigs: typeof allConfigs;
  if (normalizedBank) {
    bankConfigs = allConfigs.filter((c) => c.bank === normalizedBank);
    if (bankConfigs.length === 0) {
      bankConfigs = [{ bank: normalizedBank, settlementAccount: isFullUrl ? '' : receiverPhone }];
    }
  } else if (isExplicitCbeUrl) {
    bankConfigs = allConfigs.filter((c) => c.bank === 'cbe');
  } else if (isBoaRef) {
    bankConfigs = allConfigs.filter((c) => c.bank === 'boa');
  } else if (isDashenRef) {
    bankConfigs = allConfigs.filter((c) => c.bank === 'dashen');
  } else if (isTelebirrRef) {
    bankConfigs = allConfigs.filter((c) => c.bank === 'telebirr');
  } else if (isFullUrl) {
    // Full receipt URLs (e.g. Awash, Zemen, M-Pesa, etc.) route through /api/verify in a single call
    bankConfigs = [{ bank: 'auto', settlementAccount: '' }];
  } else if (isFtRef) {
    bankConfigs = allConfigs.filter((c) => c.bank === 'cbe' || c.bank === 'boa');
  } else {
    bankConfigs = allConfigs;
  }

  const toSafeStr = (v: unknown): string => {
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map(toSafeStr).filter(Boolean).join(' ');
    if (v && typeof v === 'object') {
      const m = (v as Record<string, unknown>).message ?? (v as Record<string, unknown>).error;
      return typeof m === 'string' ? m : JSON.stringify(v);
    }
    return v == null ? '' : String(v);
  };

  const priorityRank = (code?: string): number => {
    if (code === 'ACCOUNT_MISMATCH' || code === 'INSUFFICIENT_AMOUNT') return 3;
    if (code === 'RATE_LIMITED' || code === 'NETWORK_ERROR' || code === 'CONFIG_ERROR') return 2;
    return 1;
  };
  type VerifyFailureInfo = { message: string; messageAm: string; errorCode: string };
  const updateFailure = (
    current: VerifyFailureInfo | null,
    next: VerifyFailureInfo
  ): VerifyFailureInfo => (!current || priorityRank(next.errorCode) >= priorityRank(current.errorCode) ? next : current);

  const state: { lastFailure: VerifyFailureInfo | null; lastRawResponse: unknown } = {
    lastFailure: null,
    lastRawResponse: null,
  };

  // Generate bounded OCR ambiguity variants (split-glyph 11->10 collapse + 0<->O, Q->0/O, 1<->I, L->1/I, 8<->B) ONLY for non-URL codes when initial lookup fails
  const buildOcrAmbiguityVariants = (baseRef: string): string[] => {
    if (/^https?:\/\//i.test(baseRef)) return [];
    const upper = baseRef.toUpperCase();
    const CONFUSIONS: Record<string, string[]> = {
      '0': ['O'],
      'O': ['0'],
      'Q': ['0', 'O'],
      '1': ['I'],
      'I': ['1'],
      'L': ['1', 'I'],
      '8': ['B'],
      'B': ['8'],
    };

    const seen = new Set<string>([upper]);
    const out: string[] = [];
    const maxVariants = 16;
    const addVariant = (s: string) => {
      if (out.length >= maxVariants) return;
      if (!seen.has(s) && /\d/.test(s)) {
        seen.add(s);
        out.push(s);
      }
    };

    // 0. If OCR split a single Telebirr glyph into two adjacent characters (11-char Telebirr token -> 10-char ID, e.g. DKQ1OR1EQOP -> DKQ1OR1E0P)
    const collapsedBases: string[] = [];
    if (/^(?:DK|DL|DT|DM|CJ|EA)[A-Z0-9]{9}$/.test(upper)) {
      for (let i = 2; i < upper.length - 1; i++) {
        const a = upper[i];
        const b = upper[i + 1];
        const replacements: string[] = [];
        if ('0OQ'.includes(a) && '0OQ'.includes(b)) {
          replacements.push('0', 'O');
        } else if ('1IL'.includes(a) && '1IL'.includes(b)) {
          replacements.push('1', 'I');
        } else if (a === b) {
          replacements.push(a);
        }
        for (const rep of replacements) {
          const collapsed = upper.slice(0, i) + rep + upper.slice(i + 2);
          // Prefer exact 10-char collapse candidate before expanding suffix permutations
          addVariant(collapsed);
          if (!collapsedBases.includes(collapsed)) collapsedBases.push(collapsed);
        }
      }
    }

    const expandSubstitutions = (seed: string) => {
      const startIdx = seed.startsWith('DTS') ? 3 : /^(?:DK|DL|DT|DM|FT|TX|CJ|EA)/.test(seed) ? 2 : 0;
      const ge3Primary: number[] = [];
      const ge3Secondary: number[] = [];
      const prefix2: number[] = [];
      for (let i = startIdx; i < seed.length; i++) {
        if (CONFUSIONS[seed[i]]) {
          if (i >= 3) {
            if ('0OQIL'.includes(seed[i])) ge3Primary.push(i);
            else ge3Secondary.push(i);
          } else {
            prefix2.push(i);
          }
        }
      }
      const ge3 = [...ge3Primary, ...ge3Secondary];
      const positions = [...ge3, ...prefix2];
      if (positions.length === 0) return;

      // 1. Single-character swaps first (ge3 positions then prefix2)
      for (const pos of positions) {
        if (out.length >= maxVariants) return;
        for (const rep of CONFUSIONS[seed[pos]]) {
          const arr = seed.split('');
          arr[pos] = rep;
          addVariant(arr.join(''));
        }
      }

      // 2. Pairwise swaps strictly on suffix (>=3) positions first
      for (let a = 0; a < ge3.length && out.length < maxVariants; a++) {
        for (let b = a + 1; b < ge3.length && out.length < maxVariants; b++) {
          for (const repA of CONFUSIONS[seed[ge3[a]]]) {
            for (const repB of CONFUSIONS[seed[ge3[b]]]) {
              const arr = seed.split('');
              arr[ge3[a]] = repA;
              arr[ge3[b]] = repB;
              addVariant(arr.join(''));
            }
          }
        }
      }

      // 3. Bounded triple swaps strictly on suffix (>=3) positions
      for (let a = 0; a < ge3.length && out.length < maxVariants; a++) {
        for (let b = a + 1; b < ge3.length && out.length < maxVariants; b++) {
          for (let c = b + 1; c < ge3.length && out.length < maxVariants; c++) {
            for (const repA of CONFUSIONS[seed[ge3[a]]]) {
              for (const repB of CONFUSIONS[seed[ge3[b]]]) {
                for (const repC of CONFUSIONS[seed[ge3[c]]]) {
                  const arr = seed.split('');
                  arr[ge3[a]] = repA;
                  arr[ge3[b]] = repB;
                  arr[ge3[c]] = repC;
                  addVariant(arr.join(''));
                }
              }
            }
          }
        }
      }

      // 4. Pairwise swaps involving prefix2 only if slots remain
      for (const p2 of prefix2) {
        for (const p3 of ge3) {
          if (out.length >= maxVariants) break;
          for (const rep2 of CONFUSIONS[seed[p2]]) {
            for (const rep3 of CONFUSIONS[seed[p3]]) {
              const arr = seed.split('');
              arr[p2] = rep2;
              arr[p3] = rep3;
              addVariant(arr.join(''));
            }
          }
        }
      }
    };

    expandSubstitutions(upper);
    for (const cBase of collapsedBases) {
      if (out.length >= maxVariants) break;
      expandSubstitutions(cBase);
    }

    return out.slice(0, maxVariants);
  };

  const evaluateBankConfig = async (
    config: { bank: string; settlementAccount: string },
    candidateRef: string
  ): Promise<VerifyEtResult | null> => {
    try {
      const built = buildLinksEtVerifyPayload(
        config.bank,
        candidateRef,
        config.settlementAccount,
        expectedFee,
        cbeAccount
      );
      if ('needsFullUrl' in built) {
        state.lastFailure = updateFailure(
          state.lastFailure,
          mapVerifyError('provider_needs_full_url', 400, config.bank, 'provider_needs_full_url')
        );
        return null;
      }

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify(built.payload),
        signal: AbortSignal.timeout(12000),
      });

      const rawText = await response.text();
      let data: Record<string, any> = {};
      try {
        data = rawText ? JSON.parse(rawText) : {};
      } catch {
        data = {};
      }
      state.lastRawResponse = Object.keys(data).length > 0 ? data : rawText;

      // Poll async statusUrl if Links.et returned 202 queued
      const pollUrlPath = data.statusUrl || (data.requestId ? `/api/verify/${data.requestId}` : null);
      if (
        (response.status === 202 || String(data.processingStatus || '').toLowerCase() === 'queued') &&
        pollUrlPath
      ) {
        const pollFullUrl = String(pollUrlPath).startsWith('http')
          ? String(pollUrlPath)
          : `https://links.et${pollUrlPath}`;

        for (let pollAttempt = 1; pollAttempt <= 4; pollAttempt++) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          try {
            const pollRes = await fetch(pollFullUrl, {
              headers: { 'x-api-key': apiKey },
              signal: AbortSignal.timeout(6000),
            });
            if (!pollRes.ok) continue;
            const pollData = await pollRes.json();
            state.lastRawResponse = pollData;
            const procSt = String(pollData.processingStatus || '').toLowerCase();
            if (pollData.ok === true || procSt === 'completed' || procSt === 'failed' || procSt === 'error') {
              data = pollData;
              break;
            }
          } catch (pollErr) {
            console.warn(`[verify-et] Poll attempt ${pollAttempt} error for ${config.bank}:`, pollErr);
          }
        }
      }

      if ((!response.ok && response.status !== 202) || data.ok !== true) {
        const apiErrorCode = typeof data.error === 'object' ? data.error?.code : undefined;
        const extractedMsg =
          typeof data.error === 'string'
            ? data.error
            : toSafeStr(data.error?.message || data.message || rawText || response.statusText);

        console.warn(
          `[verify-et] Bank lookup error (${config.bank}, HTTP ${response.status}):`,
          extractedMsg || response.statusText
        );

        state.lastFailure = updateFailure(
          state.lastFailure,
          mapVerifyError(extractedMsg, response.status, config.bank, apiErrorCode)
        );
        return null;
      }

      const validated = validateLinksEtEnvelope(
        data,
        expectedFee,
        config.settlementAccount || undefined,
        config.bank === 'auto' ? undefined : config.bank,
        candidateRef
      );

      if (validated.success) {
        return validated;
      }

      if (validated.errorCode === 'INSUFFICIENT_AMOUNT') {
        return validated;
      }

      state.lastFailure = updateFailure(state.lastFailure, {
        message: validated.message,
        messageAm: validated.messageAm,
        errorCode: validated.errorCode || 'VERIFICATION_FAILED',
      });
      return null;
    } catch (error: unknown) {
      const errMessage = error instanceof Error ? error.message : String(error);
      console.warn(`[verify-et] Connection error during verification (${config.bank}):`, errMessage);
      state.lastFailure = updateFailure(state.lastFailure, {
        message: 'Network connection error while contacting verification service. Please try again.',
        messageAm: 'የመረብ ግንኙነት ችግር አጋጥሟል። እባክዎ ጥቂት ደቂቃዎች ቆይተው እንደገና ይሞክሩ።',
        errorCode: 'NETWORK_ERROR',
      });
      return null;
    }
  };

  const telebirrAccount = receiverPhone.trim() || '0987310978';
  const isTelebirrCandidate =
    bankConfigs.some((c) => c.bank === 'telebirr') &&
    (normalizedBank === 'telebirr' ||
      isTelebirrRef ||
      refLower.includes('ethiotelecom.et/receipt') ||
      (!normalizedBank && !isFtRef && !isBoaRef && !isDashenRef && !isExplicitCbeUrl));

  // ── Tier 1 (Zero-Credit Official Telebirr Direct Verification) ───────────
  let telebirrAuthoritativeNotFound = false;
  if (isTelebirrCandidate) {
    const directRes = await verifyTelebirrDirect(cleanRef, telebirrAccount);
    if (directRes.kind === 'terminal') {
      return directRes.result;
    }
    if (directRes.kind === 'not_found') {
      if (directRes.authoritative) telebirrAuthoritativeNotFound = true;
      const ocrVariants = buildOcrAmbiguityVariants(cleanRef);
      const DIRECT_BATCH = 6;
      for (let i = 0; i < ocrVariants.length; i += DIRECT_BATCH) {
        const batch = ocrVariants.slice(i, i + DIRECT_BATCH);
        const batchOutcomes = await Promise.all(batch.map((v) => verifyTelebirrDirect(v, telebirrAccount)));
        const terminalHit = batchOutcomes.find(
          (o): o is { kind: 'terminal'; result: VerifyEtResult } => o.kind === 'terminal'
        );
        if (terminalHit) return terminalHit.result;
        if (batchOutcomes.some((o) => o.kind === 'not_found' && o.authoritative)) {
          telebirrAuthoritativeNotFound = true;
        }
      }
    }

    // If Ethio Telecom's official server explicitly responded "This request is not correct" for a Telebirr reference,
    // return NOT_FOUND directly without wasting Verify.ET credits or masking NOT_FOUND behind 402 maintenance.
    if (telebirrAuthoritativeNotFound && (normalizedBank === 'telebirr' || isTelebirrRef || refLower.includes('ethiotelecom'))) {
      return {
        success: false,
        message:
          'Transaction record was not found with Telebirr. Please ensure the payment was completed and the reference number is correct.',
        messageAm:
          'ይህ የክፍያ ግብይት በቴሌብር አልተገኘም። እባክዎ ክፍያው በተሳካ ሁኔታ መጠናቀቁን እና የደረሰኝ ቁጥሩ ትክክል መሆኑን ያረጋግጡ።',
        errorCode: 'NOT_FOUND',
      };
    }
  }

  // ── Tier 2 (Bank API Lookup for CBE, BoA, Dashen, or Telebirr Fallback) ───
  if (!apiKey) {
    return {
      success: false,
      message: 'Server configuration error: Payment verification is temporarily unavailable.',
      messageAm: 'የአገልጋይ ውቅር ችግር፡ የክፍያ ማረጋገጫ አገልግሎት ለጊዜው አይሰራም።',
      errorCode: 'CONFIG_ERROR',
    };
  }

  const isAuthOrCreditStop = (code?: string) =>
    code === 'SERVICE_MAINTENANCE' || code === 'CONFIG_ERROR' || code === 'SERVICE_BUSY';

  for (const config of bankConfigs) {
    // Avoid double-checking Telebirr if official Ethio Telecom already confirmed NOT_FOUND
    if (config.bank === 'telebirr' && telebirrAuthoritativeNotFound) continue;
    const res = await evaluateBankConfig(config, cleanRef);
    if (res) return res;
    if (isAuthOrCreditStop(state.lastFailure?.errorCode)) {
      break;
    }
  }

  // Retry bounded OCR ambiguity swaps only on codes (never URLs or non-Telebirr bare refs needing a full URL)
  const canRetryOcrSwaps =
    !isFullUrl &&
    !isAuthOrCreditStop(state.lastFailure?.errorCode) &&
    (!state.lastFailure ||
      state.lastFailure.errorCode === 'NOT_FOUND' ||
      state.lastFailure.errorCode === 'VERIFICATION_FAILED');
  if (canRetryOcrSwaps) {
    const rawVariants = buildOcrAmbiguityVariants(cleanRef);
    // Cap paid Verify.ET variant fan-out on multi-bank guesses to protect API credits
    const ocrVariants =
      bankConfigs.length === 1 && bankConfigs[0].bank === 'telebirr' ? rawVariants : rawVariants.slice(0, 4);
    const BATCH_SIZE = 4;
    for (let i = 0; i < ocrVariants.length; i += BATCH_SIZE) {
      const batch = ocrVariants.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (variantRef) => {
          for (const config of bankConfigs) {
            if (config.bank === 'telebirr' && telebirrAuthoritativeNotFound) continue;
            const res = await evaluateBankConfig(config, variantRef);
            if (res) return res;
            if (isAuthOrCreditStop(state.lastFailure?.errorCode)) return null;
          }
          return null;
        })
      );
      const verifiedHit = batchResults.find((r) => r && r.success);
      if (verifiedHit) return verifiedHit;
      const terminalHit = batchResults.find((r) => r !== null);
      if (terminalHit) return terminalHit;
      if (
        state.lastFailure &&
        ['ACCOUNT_MISMATCH', 'INSUFFICIENT_AMOUNT', 'SERVICE_MAINTENANCE', 'SERVICE_BUSY', 'CONFIG_ERROR'].includes(
          state.lastFailure.errorCode
        )
      ) {
        break;
      }
    }
  }

  return {
    success: false,
    message:
      state.lastFailure?.message ||
      'Payment transaction status could not be verified. Please check your reference code and try again.',
    messageAm:
      state.lastFailure?.messageAm ||
      'የክፍያ ግብይቱ ሊረጋገጥ አልቻለም። እባክዎ የደረሰኝ ቁጥርዎን አረጋግጠው እንደገና ይሞክሩ።',
    errorCode: state.lastFailure?.errorCode || 'VERIFICATION_FAILED',
    rawResponse: state.lastRawResponse,
  };
}

/**
 * Unified hybrid verifier for Telegram bot and Mini-App submissions:
 * - Saves /api/verify-image monthly quota when local QR/Telebirr extraction is valid
 * - Escalates automatically to screenshot verification when local extraction failed,
 *   lacks a full bank URL for CBE/BoA/Dashen, or initial reference lookup fails.
 */
export async function verifyPaymentSubmission(params: {
  referenceOrUrl?: string;
  screenshotBuffer?: Buffer;
  expectedFee?: number;
  preferredBank?: string;
}): Promise<VerifyEtResult> {
  const expectedFee = params.expectedFee ?? Number(process.env.NEXT_PUBLIC_UNLOCK_FEE || '100');
  const rawRef = (params.referenceOrUrl || '').trim();
  const normBank = params.preferredBank ? normalizeProviderBank(params.preferredBank) : undefined;
  const isUrl = /^https?:\/\//i.test(rawRef);

  let triedImage = false;
  let lastResult: VerifyEtResult | null = null;

  // Prefer image verification upfront when no reference was decoded OR bare non-Telebirr code lacks a full receipt URL
  if (
    params.screenshotBuffer &&
    (!rawRef || (!isUrl && normBank && normBank !== 'telebirr'))
  ) {
    triedImage = true;
    lastResult = await verifyReceiptImageWithLinksEt(params.screenshotBuffer, expectedFee, normBank);
    if (
      lastResult.success ||
      lastResult.errorCode === 'INSUFFICIENT_AMOUNT' ||
      lastResult.errorCode === 'ACCOUNT_MISMATCH' ||
      lastResult.errorCode === 'PAYMENT_PENDING' ||
      lastResult.errorCode === 'TRANSACTION_FAILED'
    ) {
      return lastResult;
    }
  }

  if (rawRef) {
    const refResult = await verifyTelebirrPayment(rawRef, expectedFee, normBank);
    if (
      refResult.success ||
      refResult.errorCode === 'INSUFFICIENT_AMOUNT' ||
      refResult.errorCode === 'ACCOUNT_MISMATCH' ||
      refResult.errorCode === 'PAYMENT_PENDING' ||
      refResult.errorCode === 'TRANSACTION_FAILED'
    ) {
      return refResult;
    }
    lastResult = refResult;

    // Rescue blurred/misread Telebirr or bank screenshots via image AI check
    if (
      params.screenshotBuffer &&
      !triedImage &&
      ['NOT_FOUND', 'INVALID_FORMAT', 'NEEDS_FULL_URL_OR_SCREENSHOT', 'VERIFICATION_FAILED'].includes(
        refResult.errorCode || ''
      )
    ) {
      const rescueResult = await verifyReceiptImageWithLinksEt(params.screenshotBuffer, expectedFee, normBank);
      if (rescueResult.success || rescueResult.errorCode !== 'IMAGE_READ_FAILED') {
        return rescueResult;
      }
    }
  }

  return (
    lastResult || {
      success: false,
      message:
        'Could not verify this payment receipt. Please send a clearer screenshot or paste the full bank receipt link.',
      messageAm:
        'ይህን የክፍያ ደረሰኝ ማረጋገጥ አልተቻለም። እባክዎ ግልጽ የደረሰኝ ስክሪንሽት ፎቶ ወይም ሙሉ የባንክ ደረሰኝ ማስፈንጠሪያ ይላኩ።',
      errorCode: 'VERIFICATION_FAILED',
    }
  );
}

export const verifyPayment = verifyTelebirrPayment;
