import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase-server';
import { verifyTelebirrPayment, normalizeCanonicalTransactionRef } from '@/lib/verify-et';
import { acquireActionLock, releaseActionLock, activateUserMembership } from '@/lib/bot-session-store';
import { validateTelegramInitData } from '@/lib/telegram-auth';
import { escapeHtml } from '@/lib/telegram';

const verifyOrderSchema = z.object({
  order_id: z.string().uuid('Invalid order_id UUID format'),
  telegram_id: z.number().or(z.string().transform((val) => parseInt(val, 10))),
  transaction_reference: z.string().min(1, 'transaction_reference is required'),
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
      transaction_reference: rawBody.transaction_reference,
    });

    if (validatedTg.user.id !== parsed.telegram_id) {
      return NextResponse.json({ error: 'Forbidden: Telegram identity mismatch.' }, { status: 403 });
    }

    const { order_id, telegram_id, transaction_reference } = parsed;
    const cleanTxRef = normalizeCanonicalTransactionRef(transaction_reference);

    if (!cleanTxRef) {
      return NextResponse.json(
        { error: 'Invalid or unrecognized transaction reference code.' },
        { status: 400 }
      );
    }

    lockKey = `tx_ref_verify:${cleanTxRef.toUpperCase()}`;
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

    if (order.payment_status === 'completed') {
      const { data: unlockedData, error: rpcError } = await supabaseAdmin.rpc(
        'get_unlocked_space_details',
        { p_space_id: order.space_id, p_telegram_id: telegram_id }
      );

      if (rpcError) {
        return NextResponse.json({ error: 'Failed to retrieve unlocked details.' }, { status: 500 });
      }

      const unlocked = Array.isArray(unlockedData) ? unlockedData[0] : unlockedData;
      return NextResponse.json({
        success: true,
        already_completed: true,
        message: 'Order was already verified and unlocked.',
        unlocked_details: unlocked || null,
      });
    }

    // 2. Anti-Replay Check: Reject if transaction_reference is already attached to any completed order
    const safeLikeRef = cleanTxRef.replace(/[%_\\]/g, '\\$&');
    const { data: replayRows } = await supabaseAdmin
      .from('orders')
      .select('id')
      .ilike('transaction_reference', safeLikeRef)
      .eq('payment_status', 'completed')
      .limit(1);

    if (replayRows && replayRows.length > 0) {
      return NextResponse.json(
        { error: 'Replay Security Alert: This transaction reference has already been used on a completed order.' },
        { status: 409 }
      );
    }

    // 3. Call Verify.ET against at least 100 ETB (Invariant 7)
    const requiredFee = Math.max(Number(order.amount || 100), 100);
    const refUpper = cleanTxRef.toUpperCase();
    const refLower = cleanTxRef.toLowerCase();
    const bankHint =
      refUpper.startsWith('FT') || refLower.includes('cbe.com.et')
        ? 'cbe'
        : refUpper.startsWith('TX') || refLower.includes('abyssinia')
        ? 'boa'
        : refUpper.startsWith('DTS') || refLower.includes('dashen')
        ? 'dashen'
        : refUpper.startsWith('DK') || refUpper.startsWith('DT') || refLower.includes('ethiotelecom')
        ? 'telebirr'
        : undefined;

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

    // 4. Update order status to 'completed' and activate 90-day membership cache
    const nowIso = new Date().toISOString();
    const { error: updateError } = await supabaseAdmin
      .from('orders')
      .update({
        buyer_telegram_id: telegram_id,
        renter_telegram_id: telegram_id,
        order_type: 'membership_pass',
        target_type: 'membership_90d',
        target_id: 'pass_90d',
        amount: verification.paidAmount ?? requiredFee,
        payment_status: 'completed',
        transaction_reference: cleanTxRef,
        verified_at: nowIso,
        updated_at: nowIso,
      })
      .eq('id', order_id);

    if (updateError) {
      console.error('Database update error on verified order:', updateError);
      return NextResponse.json(
        { error: 'Payment could not be finalized (reference may already be used).', details: updateError.message },
        { status: 409 }
      );
    }

    await activateUserMembership(telegram_id, order.id, cleanTxRef);

    // 5. Retrieve authorized details via RPC
    const { data: unlockedRpcResult, error: rpcError } = await supabaseAdmin.rpc(
      'get_unlocked_space_details',
      { p_space_id: order.space_id, p_telegram_id: telegram_id }
    );

    if (rpcError) {
      return NextResponse.json(
        { error: 'Payment verified, but authorization RPC failed.', details: rpcError.message },
        { status: 500 }
      );
    }

    const unlocked = Array.isArray(unlockedRpcResult) ? unlockedRpcResult[0] : unlockedRpcResult;

    // 6. Send Telegram confirmation DM if unlocked data exists
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (botToken && telegram_id && unlocked) {
      try {
        const spaceTitle = escapeHtml(spaceObj?.title || 'Room Listing');
        const mapsUrl =
          unlocked.latitude && unlocked.longitude
            ? `https://www.google.com/maps?q=${unlocked.latitude},${unlocked.longitude}`
            : null;

        const telegramMessage = [
          `<b>Payment Verified / ክፍያዎ ተረጋግጧል (3-Month Pass Active)</b>`,
          ``,
          `<blockquote>Your access to <b>${spaceTitle}</b> is unlocked:`,
          unlocked.exact_address ? `• <b>Address / አድራሻ:</b> ${escapeHtml(String(unlocked.exact_address))}` : '',
          unlocked.contact_name ? `• <b>Contact Name / ስም:</b> ${escapeHtml(String(unlocked.contact_name))}` : '',
          unlocked.contact_phone ? `• <b>Phone Number / ስልክ:</b> ${escapeHtml(String(unlocked.contact_phone))}` : '',
          unlocked.contact_telegram ? `• <b>Telegram:</b> @${escapeHtml(String(unlocked.contact_telegram).replace('@', ''))}` : '',
          mapsUrl ? `• <a href="${mapsUrl}">Google Maps Directions</a>` : '',
          `</blockquote>`,
        ]
          .filter(Boolean)
          .join('\n');

        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: telegram_id,
            text: telegramMessage,
            parse_mode: 'HTML',
          }),
        });
      } catch (tgError) {
        console.error('Telegram DM notification error:', tgError);
      }
    }

    return NextResponse.json({
      success: true,
      message: 'Payment verified successfully and 3-Month Pass activated.',
      order_id: order.id,
      unlocked_details: unlocked
        ? {
            exact_address: unlocked.exact_address,
            latitude: unlocked.latitude,
            longitude: unlocked.longitude,
            contact_name: unlocked.contact_name,
            contact_phone: unlocked.contact_phone,
            contact_telegram: unlocked.contact_telegram,
            google_maps_url:
              unlocked.latitude && unlocked.longitude
                ? `https://www.google.com/maps?q=${unlocked.latitude},${unlocked.longitude}`
                : null,
          }
        : null,
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
