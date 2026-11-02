export interface VerifyEtResult {
  success: boolean;
  message: string;
  transactionNumber?: string;
  paidAmount?: number;
  senderName?: string;
  bank?: string;
  rawResponse?: unknown;
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
  const apiKey = process.env.VERIFY_ET_API_KEY;
  const receiverPhone = process.env.TELEBIRR_RECEIVER_PHONE || '0987310978';
  const abyssiniaAccount = process.env.ABYSSINIA_ACCOUNT_NUMBER || '256861771';
  const dashenAccount = process.env.DASHEN_ACCOUNT_NUMBER || '2922175078411';
  const cbeAccount = process.env.CBE_ACCOUNT_NUMBER || '1000054066094';

  const cleanRef = referenceNumber.trim();

  if (!apiKey) {
    if (process.env.ALLOW_MOCK_PAYMENTS === 'true' || process.env.NODE_ENV === 'development') {
      const bank = cleanRef.toUpperCase().startsWith('FT') ? 'cbe' : (preferredBank || 'telebirr');
      return {
        success: true,
        message: 'Payment receipt verified successfully (Test Mode).',
        transactionNumber: cleanRef.toUpperCase(),
        paidAmount: expectedFee,
        senderName: 'Verified Payer (Wahid)',
        bank,
      };
    }
    return {
      success: false,
      message: 'Server configuration error: VERIFY_ET_API_KEY is missing. Please add your Verify.ET API key to .env.local.',
    };
  }

  const endpoint = 'https://verify.et/api/verify?waitMs=5000';

  // Bank Options to evaluate (Telebirr, Abyssinia, Dashen & CBE) - supports current and fallback accounts
  const allConfigs = [
    { bank: 'telebirr', settlementAccount: receiverPhone.trim() },
    { bank: 'telebirr', settlementAccount: '0987310978' },
    { bank: 'telebirr', settlementAccount: '0901570707' },
    { bank: 'abyssinia', settlementAccount: abyssiniaAccount.trim() },
    { bank: 'abyssinia', settlementAccount: '256861771' },
    { bank: 'boa', settlementAccount: abyssiniaAccount.trim() },
    { bank: 'boa', settlementAccount: '256861771' },
    { bank: 'dashen', settlementAccount: dashenAccount.trim() },
    { bank: 'dashen', settlementAccount: '2922175078411' },
    { bank: 'cbe', settlementAccount: cbeAccount.trim() },
    { bank: 'cbe', settlementAccount: '1000720760416' },
    { bank: 'cbe', settlementAccount: '1000054066094' },
  ].filter((item, index, self) => index === self.findIndex((t) => t.bank === item.bank && t.settlementAccount === item.settlementAccount));

  // Infer bank from reference prefix if not explicitly passed (e.g. FT... -> CBE)
  let normalizedBank = preferredBank?.toLowerCase().trim();
  if (!normalizedBank && cleanRef.toUpperCase().startsWith('FT')) {
    normalizedBank = 'cbe';
  }

  const bankConfigs = normalizedBank
    ? [
        ...allConfigs.filter((c) => c.bank === normalizedBank || (normalizedBank === 'abyssinia' && c.bank === 'boa') || (normalizedBank === 'boa' && c.bank === 'abyssinia')),
        ...allConfigs.filter((c) => c.bank !== normalizedBank && !((normalizedBank === 'abyssinia' && c.bank === 'boa') || (normalizedBank === 'boa' && c.bank === 'abyssinia'))),
      ]
    : allConfigs;

  let lastFailureMessage = 'Payment transaction status is not verified.';
  let lastRawResponse: unknown = null;

  for (const config of bankConfigs) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({
          bank: config.bank,
          transactionNumber: cleanRef,
          referenceNumber: cleanRef,
          receiptNumber: cleanRef,
          settlementAccount: config.settlementAccount,
        }),
      });

      if (!response.ok) {
        const errorPayload = await response.text();
        lastFailureMessage = `verify.et verification request failed (${config.bank}): ${errorPayload}`;
        continue;
      }

      const data = await response.json();
      lastRawResponse = data;

      // Verify.ET may return record in data.data[0] or data.data or root
      const record = Array.isArray(data.data) ? data.data[0] : (data.data && typeof data.data === 'object' ? data.data : data);
      const verificationObj = (data.verification && typeof data.verification === 'object') ? data.verification : {};

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
        lastFailureMessage =
          data.error?.message ||
          record?.error?.message ||
          data.message ||
          record?.message ||
          `Payment status not verified for ${config.bank}.`;
        continue;
      }

      // 2. Confirm settlement account matching if present
      const returnedSettlementAccount = record?.settlementAccount || data.settlementAccount;
      if (returnedSettlementAccount && returnedSettlementAccount.trim() !== config.settlementAccount) {
        lastFailureMessage = `Settlement account mismatch for ${config.bank}.`;
        continue;
      }

      // 3. Ensure paid amount matches or exceeds expected fee
      const paidAmount = Number(record?.amount || record?.paidAmount || data.amount || data.paidAmount || 0);
      if (paidAmount > 0 && paidAmount < expectedFee) {
        return {
          success: false,
          message: `Insufficient payment. Received ${paidAmount} ETB, but fee requires at least ${expectedFee} ETB.`,
          paidAmount,
          bank: config.bank,
          rawResponse: data,
        };
      }

      const senderName = record?.senderName || record?.payerName || data.senderName || data.payerName || 'Verified Payer';
      const txNum = record?.referenceNumber || record?.transactionNumber || data.transactionNumber || cleanRef;

      return {
        success: true,
        message: `Payment receipt verified successfully via ${config.bank.toUpperCase()}.`,
        transactionNumber: txNum,
        paidAmount: paidAmount || expectedFee,
        senderName,
        bank: config.bank,
        rawResponse: data,
      };
    } catch (error: unknown) {
      const errMessage = error instanceof Error ? error.message : String(error);
      lastFailureMessage = `Connection error during verify.et verification (${config.bank}): ${errMessage}`;
    }
  }

  return {
    success: false,
    message: lastFailureMessage,
    rawResponse: lastRawResponse,
  };
}

export const verifyPayment = verifyTelebirrPayment;
