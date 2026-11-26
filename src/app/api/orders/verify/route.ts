import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase-server';
import { verifyTelebirrPayment, normalizeCanonicalTransactionRef } from '@/lib/verify-et';
import { extractTransactionReferenceFromImage } from '@/lib/receipt-extractor';
import {
  acquireActionLock,
  releaseActionLock,
  activateUserMembership,
  computeReceiptImageSha256,
  findRedeemedOrderByCanonicalRef,
  isReceiptHashRedeemed,
  recordRedeemedReceiptHash,
} from '@/lib/bot-session-store';
import { validateTelegramInitData } from '@/lib/telegram-auth';
import { escapeHtml } from '@/lib/telegram';

export const maxDuration = 60;

const verifyOrderSchema = z.object({
  order_id: z.string().uuid('Invalid order_id UUID format'),
  telegram_id: z.number().or(z.string().transform((val) => parseInt(val, 10))),
  transaction_reference: z.string().optional(),
  receipt_image: z.string().optional(),
});

export async function POST(request: Request) {
  let lockKey: string | null = null;
  try {
    const rawBody = await request.json();
    const initData = request.headers.get('x-telegram-init-data') || rawBody.initData;
    if (!initData || typeof initData !== 'string') {
      return NextResponse.json(
        { error: 'Telegram authentication required to verify orders.' },
        { status: 401 }
      );
    }

    let validatedTg;
    try {
      validatedTg = validateTelegramInitData(initData);
    } catch {
      return NextResponse.json({ error: 'Invalid Telegram session signature.' }, { status: 401 });
    }

    const parsed = verifyOrderSchema.parse({
      order_id: rawBody.order_id,
      telegram_id: rawBody.telegram_id || rawBody.renter_telegram_id || validatedTg.user.id,
      transaction_reference: typeof rawBody.transaction_reference === 'string' ? rawBody.transaction_reference : undefined,
      receipt_image: typeof rawBody.receipt_image === 'string' ? rawBody.receipt_image : undefined,
    });

    if (validatedTg.user.id !== parsed.telegram_id) {
      return NextResponse.json({ error: 'Forbidden: Telegram identity mismatch.' }, { status: 403 });
    }

    const { order_id, telegram_id, transaction_reference, receipt_image } = parsed;

    let cleanTxRef = transaction_reference ? normalizeCanonicalTransactionRef(transaction_reference) : '';
    let ocrBankHint: string | undefined;
    let receiptSha256: string | undefined;

    if (!cleanTxRef && receipt_image) {
      const base64Body = receipt_image.replace(/^data:image\/[a-z0-9+.-]+;base64,/i, '');
      const imgBuf = Buffer.from(base64Body, 'base64');
      if (imgBuf.length < 256 || imgBuf.length > 10 * 1024 * 1024) {
        return NextResponse.json(
          { error: 'Invalid receipt image size. Upload a clear screenshot under 10 MB.' },
          { status: 400 }
        );
      }
      receiptSha256 = computeReceiptImageSha256(imgBuf);
      const hashCheck = await isReceiptHashRedeemed(receiptSha256);
      if (hashCheck.redeemed) {
        return NextResponse.json(
          {
            error: hashCheck.dbError
              ? 'Unable to validate receipt uniqueness right now. Please try again.'
              : 'Replay Security Alert: This payment receipt screenshot has already been used and cannot be reused.',
          },
          { status: hashCheck.dbError ? 500 : 409 }
        );
      }
      const ocr = await extractTransactionReferenceFromImage(imgBuf);
      if (ocr?.reference) {
        cleanTxRef = normalizeCanonicalTransactionRef(ocr.reference) || ocr.reference.toUpperCase();
        ocrBankHint = ocr.bankHint;
      }
    }

    if (!cleanTxRef) {
      return NextResponse.json(
        { error: 'Could not extract a valid transaction reference. Please enter your reference code or upload a clearer receipt screenshot.' },
        { status: 400 }
      );
    }

    lockKey = `tx_pay:${cleanTxRef.toUpperCase()}`;
    if (!(await acquireActionLock(lockKey, 15000))) {
      lockKey = null; // do not release someone else's active lock
      return NextResponse.json(
        { error: 'Transaction verification already in progress for this reference.' },
        { status: 429 }
      );
    }

    // 1. Retrieve order record and confirm caller owns this order
    const { data: order, error: orderFetchError } = await supabaseAdmin
      .from('orders')
      .select('id, space_id, renter_telegram_id, buyer_telegram_id, amount, payment_status, spaces(title)')
      .eq('id', order_id)
      .single();

    if (orderFetchError || !order) {
      return NextResponse.json({ error: 'Order record not found.' }, { status: 404 });
    }

    if (
      Number(order.renter_telegram_id) !== telegram_id &&
      Number(order.buyer_telegram_id) !== telegram_id
    ) {
      return NextResponse.json({ error: 'Forbidden: You do not own this order.' }, { status: 403 });
    }

    const spaceObj = Array.isArray(order.spaces) ? order.spaces[0] : order.spaces;
    const botUser = (process.env.NEXT_PUBLIC_BOT_USERNAME || 'Spacematchaddis_bot').replace('@', '');

    if (order.payment_status === 'completed') {
      return NextResponse.json({
        success: true,
        already_completed: true,
        pass_active: true,
        double_blind_ready: true,
        space_id: order.space_id,
        message: '3-Month Pass active! Proceed in @' + botUser + ' to send a mutually consented connection request.',
        bot_connect_url: `https://t.me/${botUser}?start=order_${order.space_id}`,
      });
    }

    // 2. Anti-Replay Check: Reject if transaction_reference (bare code OR URL form) is already attached to any completed order
    const preReplay = await findRedeemedOrderByCanonicalRef(cleanTxRef);
    if (preReplay.redeemed) {
      if (preReplay.dbError) {
        return NextResponse.json(
          { error: 'Unable to validate transaction uniqueness right now. Please try again.' },
          { status: 500 }
        );
      }
      return NextResponse.json(
        { error: 'Replay Security Alert: This transaction reference has already been used on a completed order.' },
        { status: 409 }
      );
    }

    // 3. Call Verify.ET against at least 100 ETB (Invariant 7). Note: do NOT force 'cbe' on bare FT... codes (BoA uses FT... too)
    const requiredFee = Math.max(Number(order.amount || 100), 100);
    const refUpper = cleanTxRef.toUpperCase();
    const refLower = cleanTxRef.toLowerCase();
    const bankHint =
      ocrBankHint ||
      (refLower.includes('cbe.com.et')
        ? 'cbe'
        : refUpper.startsWith('TX') || refLower.includes('abyssinia')
        ? 'boa'
        : refUpper.startsWith('DTS') || refLower.includes('dashen')
        ? 'dashen'
        : refUpper.startsWith('DK') ||
          refUpper.startsWith('DT') ||
          refUpper.startsWith('DM') ||
          refLower.includes('ethiotelecom')
        ? 'telebirr'
        : undefined);

    const verification = await verifyTelebirrPayment(cleanTxRef, requiredFee, bankHint);

    if (!verification.success) {
      return NextResponse.json(
        {
          error: verification.message,
          message: verification.message,
          messageAm: verification.messageAm,
          errorCode: verification.errorCode,
        },
        { status: 400 }
      );
    }

    const canonicalTxRef = (
      normalizeCanonicalTransactionRef(verification.transactionNumber || cleanTxRef) ||
      cleanTxRef
    ).toUpperCase();

    if (canonicalTxRef !== cleanTxRef.toUpperCase()) {
      const canonReplay = await findRedeemedOrderByCanonicalRef(canonicalTxRef);
      if (canonReplay.redeemed) {
        if (canonReplay.dbError) {
          return NextResponse.json(
            { error: 'Unable to confirm canonical transaction uniqueness.' },
            { status: 500 }
          );
        }
        return NextResponse.json(
          { error: 'Replay Security Alert: This verified transaction has already been redeemed.' },
          { status: 409 }
        );
      }
    }

    // 4. Update order status to 'completed' with optimistic lock guard and activate 90-day membership pass
    const nowIso = new Date().toISOString();
    const { data: updatedOrder, error: updateError } = await supabaseAdmin
      .from('orders')
      .update({
        buyer_telegram_id: telegram_id,
        renter_telegram_id: telegram_id,
        order_type: 'membership_pass',
        target_type: 'membership_90d',
        target_id: 'pass_90d',
        amount: verification.paidAmount ?? requiredFee,
        payment_status: 'completed',
        transaction_reference: canonicalTxRef,
        verified_at: nowIso,
        updated_at: nowIso,
      })
      .eq('id', order_id)
      .neq('payment_status', 'completed')
      .select('id')
      .maybeSingle();

    if (updateError || !updatedOrder) {
      console.error('Database update error on verified order:', updateError);
      return NextResponse.json(
        { error: 'Payment could not be finalized (reference may already be used).' },
        { status: 409 }
      );
    }

    if (receiptSha256) {
      await recordRedeemedReceiptHash(receiptSha256, canonicalTxRef, telegram_id);
    }
    await activateUserMembership(telegram_id, order.id, canonicalTxRef);

    // 5. Notify user in Telegram to trigger double-blind mutual consent (NO unconsented PII revealed)
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const botConnectUrl = `https://t.me/${botUser}?start=order_${order.space_id}`;
    if (botToken && telegram_id) {
      try {
        const spaceTitle = escapeHtml(spaceObj?.title || 'Room Listing');
        const telegramMessage = [
          `<b>Payment Verified / ክፍያዎ ተረጋግጧል (3-Month Pass Active)</b>`,
          ``,
          `<blockquote>Your <b>100 ETB 3-Month All-Access Pass</b> is now active!`,
          `• Listing: <b>${spaceTitle}</b>`,
          `• Double-Blind Privacy: Tap below to send a mutually consented connection request to the host. Contact details are revealed automatically once both parties accept.`,
          `</blockquote>`,
        ].join('\n');

        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: telegram_id,
            text: telegramMessage,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '🤝 Connect with Host / ጥያቄ ላክ',
                    url: botConnectUrl,
                  },
                ],
              ],
            },
          }),
        });
      } catch (tgError) {
        console.error('Telegram DM notification error:', tgError);
      }
    }

    return NextResponse.json({
      success: true,
      pass_active: true,
      double_blind_ready: true,
      message: 'Payment verified and 3-Month Pass activated! Proceed in Telegram to send a mutually consented connection request.',
      order_id: order.id,
      space_id: order.space_id,
      bot_connect_url: botConnectUrl,
    });
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation Error', details: error.issues }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error('Orders Verify Route Exception:', message);
    return NextResponse.json({ error: 'Internal server error verifying transaction.' }, { status: 500 });
  } finally {
    if (lockKey) {
      await releaseActionLock(lockKey);
    }
  }
}
