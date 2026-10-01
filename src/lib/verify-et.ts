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
 * Validates Telebirr or CBE (Commercial Bank of Ethiopia) transaction receipts using the verify.et API
 * 
 * Supported Accounts:
 * - Telebirr: process.env.TELEBIRR_RECEIVER_PHONE || '0987310978'
 * - CBE Bank: process.env.CBE_ACCOUNT_NUMBER || '1000054066094'
 * 
 * Endpoint: POST https://verify.et/api/verify?waitMs=5000
 * Headers: x-api-key: process.env.VERIFY_ET_API_KEY
 */
export async function verifyTelebirrPayment(
  referenceNumber: string,
  expectedFee: number = Number(process.env.NEXT_PUBLIC_UNLOCK_FEE || '50')
): Promise<VerifyEtResult> {
  const apiKey = process.env.VERIFY_ET_API_KEY;
  const receiverPhone = process.env.TELEBIRR_RECEIVER_PHONE || '0987310978';
  const cbeAccount = process.env.CBE_ACCOUNT_NUMBER || '1000054066094';

  if (!apiKey) {
    return {
      success: false,
      message: 'Server configuration error: VERIFY_ET_API_KEY is missing.',
    };
  }

  const cleanRef = referenceNumber.trim();
  const endpoint = 'https://verify.et/api/verify?waitMs=5000';

  // Bank Options to evaluate (Telebirr & CBE)
  const bankConfigs = [
    { bank: 'telebirr', settlementAccount: receiverPhone.trim() },
    { bank: 'cbe', settlementAccount: cbeAccount.trim() },
  ];

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

      // 1. Evaluate response verification status
      const isStatusVerified =
        data.status === 'verified' ||
        data.status === 'success' ||
        data.verified === true;

      if (!isStatusVerified) {
        lastFailureMessage = data.message || `Payment status '${data.status}' not verified for ${config.bank}.`;
        continue;
      }

      // 2. Confirm settlement account matching if present
      if (data.settlementAccount && data.settlementAccount.trim() !== config.settlementAccount) {
        lastFailureMessage = `Settlement account mismatch for ${config.bank}.`;
        continue;
      }

      // 3. Ensure paid amount matches or exceeds expected fee
      const paidAmount = Number(data.amount || data.paidAmount || 0);
      if (paidAmount > 0 && paidAmount < expectedFee) {
        return {
          success: false,
          message: `Insufficient payment. Received ${paidAmount} ETB, but fee requires at least ${expectedFee} ETB.`,
          paidAmount,
          bank: config.bank,
          rawResponse: data,
        };
      }

      return {
        success: true,
        message: `Payment receipt verified successfully via ${config.bank.toUpperCase()}.`,
        transactionNumber: data.transactionNumber || cleanRef,
        paidAmount: paidAmount || expectedFee,
        senderName: data.senderName || data.payerName,
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
