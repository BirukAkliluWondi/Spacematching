export interface VerifyEtResult {
  success: boolean;
  message: string;
  transactionNumber?: string;
  paidAmount?: number;
  senderName?: string;
  rawResponse?: unknown;
}

/**
 * Validates Telebirr transaction receipts using the official verify.et API
 * 
 * Endpoint: POST https://verify.et/api/verify?waitMs=5000
 * Headers: x-api-key: process.env.VERIFY_ET_API_KEY
 */
export async function verifyTelebirrPayment(
  referenceNumber: string,
  expectedFee: number = Number(process.env.NEXT_PUBLIC_UNLOCK_FEE || '100')
): Promise<VerifyEtResult> {
  const apiKey = process.env.VERIFY_ET_API_KEY;
  const receiverPhone = process.env.TELEBIRR_RECEIVER_PHONE;

  if (!apiKey) {
    return {
      success: false,
      message: 'Server configuration error: VERIFY_ET_API_KEY is missing.',
    };
  }

  if (!receiverPhone) {
    return {
      success: false,
      message: 'Server configuration error: TELEBIRR_RECEIVER_PHONE is missing.',
    };
  }

  const endpoint = 'https://verify.et/api/verify?waitMs=5000';

  const payload = {
    bank: 'telebirr',
    transactionNumber: referenceNumber.trim(),
    settlementAccount: receiverPhone.trim(),
  };

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorPayload = await response.text();
      return {
        success: false,
        message: `verify.et verification request failed (HTTP ${response.status}): ${errorPayload}`,
      };
    }

    const data = await response.json();

    // 1. Evaluate response verification status
    const isStatusVerified =
      data.status === 'verified' ||
      data.status === 'success' ||
      data.verified === true;

    if (!isStatusVerified) {
      return {
        success: false,
        message: data.message || `Payment transaction status '${data.status}' is not verified.`,
        rawResponse: data,
      };
    }

    // 2. Confirm settlement account matching
    if (data.settlementAccount && data.settlementAccount.trim() !== receiverPhone.trim()) {
      return {
        success: false,
        message: `Settlement account mismatch. Received ${data.settlementAccount}, expected ${receiverPhone}.`,
        rawResponse: data,
      };
    }

    // 3. Ensure paid amount matches or exceeds expected fee
    const paidAmount = Number(data.amount || data.paidAmount || 0);
    if (paidAmount < expectedFee) {
      return {
        success: false,
        message: `Insufficient payment. Received ${paidAmount} ETB, but fee requires at least ${expectedFee} ETB.`,
        paidAmount,
        rawResponse: data,
      };
    }

    return {
      success: true,
      message: 'Payment receipt verified successfully.',
      transactionNumber: data.transactionNumber || referenceNumber,
      paidAmount,
      senderName: data.senderName || data.payerName,
      rawResponse: data,
    };
  } catch (error: unknown) {
    const errMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Network/API connection error during verify.et verification: ${errMessage}`,
    };
  }
}
