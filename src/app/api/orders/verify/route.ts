import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase-server';
import { verifyTelebirrPayment } from '@/lib/verify-et';

const verifyOrderSchema = z.object({
  order_id: z.string().uuid('Invalid order_id UUID format'),
  telegram_id: z.number().or(z.string().transform((val) => parseInt(val, 10))),
  transaction_reference: z.string().min(1, 'transaction_reference is required'),
});

export async function POST(request: Request) {
  try {
    const rawBody = await request.json();
    const parsed = verifyOrderSchema.parse({
      order_id: rawBody.order_id,
      telegram_id: rawBody.telegram_id || rawBody.renter_telegram_id,
      transaction_reference: rawBody.transaction_reference,
    });

    const { order_id, telegram_id, transaction_reference } = parsed;
    const cleanTxRef = transaction_reference.trim();

    // 1. Retrieve order record from database
    const { data: order, error: orderFetchError } = await supabaseAdmin
      .from('orders')
      .select('id, space_id, renter_telegram_id, amount, payment_status, spaces(title)')
      .eq('id', order_id)
      .single();

    if (orderFetchError || !order) {
      return NextResponse.json(
        { error: 'Order record not found.' },
        { status: 404 }
      );
    }

    const spaceObj = Array.isArray(order.spaces) ? order.spaces[0] : order.spaces;

    // Handle case if order is already completed
    if (order.payment_status === 'completed') {
      const { data: unlockedData, error: rpcError } = await supabaseAdmin.rpc(
        'get_unlocked_space_details',
        {
          p_space_id: order.space_id,
          p_telegram_id: telegram_id,
        }
      );

      if (rpcError) {
        console.error('RPC lookup error on already completed order:', rpcError);
        return NextResponse.json({ error: 'Failed to retrieve unlocked details.' }, { status: 500 });
      }

      const unlocked = Array.isArray(unlockedData) ? unlockedData[0] : unlockedData;

      return NextResponse.json({
        success: true,
        already_completed: true,
        message: 'Order was already verified and unlocked.',
        unlocked_details: unlocked,
      });
    }

    // 2. Anti-Replay Check: Reject if transaction_reference is already attached to a completed order
    const { data: replayCheck } = await supabaseAdmin
      .from('orders')
      .select('id')
      .eq('transaction_reference', cleanTxRef)
      .eq('payment_status', 'completed')
      .maybeSingle();

    if (replayCheck) {
      return NextResponse.json(
        { error: 'Replay Security Alert: This transaction reference has already been used on a completed order.' },
        { status: 409 }
      );
    }

    // 3. Call verify.et to validate Telebirr receipt against the specific order fee amount
    const requiredFee = Number(order.amount);
    const verification = await verifyTelebirrPayment(cleanTxRef, requiredFee);

    if (!verification.success) {
      return NextResponse.json(
        { error: `Payment Verification Failed: ${verification.message}` },
        { status: 400 }
      );
    }

    // 4. Update order status to 'completed' and set verified_at timestamp
    const nowIso = new Date().toISOString();
    const { error: updateError } = await supabaseAdmin
      .from('orders')
      .update({
        payment_status: 'completed',
        transaction_reference: cleanTxRef,
        verified_at: nowIso,
        updated_at: nowIso,
      })
      .eq('id', order_id);

    if (updateError) {
      console.error('Database update error on verified order:', updateError);
      return NextResponse.json(
        { error: 'Payment verified, but failed to record order completion.', details: updateError.message },
        { status: 500 }
      );
    }

    // 5. Call Supabase RPC get_unlocked_space_details for authorized details
    const { data: unlockedRpcResult, error: rpcError } = await supabaseAdmin.rpc(
      'get_unlocked_space_details',
      {
        p_space_id: order.space_id,
        p_telegram_id: telegram_id,
      }
    );

    if (rpcError) {
      console.error('Supabase RPC get_unlocked_space_details failed:', rpcError);
      return NextResponse.json(
        { error: 'Payment verified, but authorization RPC failed.', details: rpcError.message },
        { status: 500 }
      );
    }

    const unlocked = Array.isArray(unlockedRpcResult) ? unlockedRpcResult[0] : unlockedRpcResult;

    // 6. Call Telegram Bot API sendMessage to DM renter with details and Google Maps link
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (botToken && telegram_id) {
      try {
        const spaceTitle = spaceObj?.title || 'Room Listing';
        const mapsUrl = `https://www.google.com/maps?q=${unlocked.latitude},${unlocked.longitude}`;

        const telegramMessage = [
          `<b>🎉 Payment Verified!</b>`,
          ``,
          `Your reservation access to <b>${spaceTitle}</b> has been unlocked:`,
          ``,
          `📍 <b>Exact Address:</b> ${unlocked.exact_address}`,
          `👤 <b>Homeowner Name:</b> ${unlocked.contact_name}`,
          `📞 <b>Phone Number:</b> ${unlocked.contact_phone}`,
          unlocked.contact_telegram ? `✈️ <b>Telegram:</b> @${unlocked.contact_telegram.replace('@', '')}` : '',
          `🗺️ <a href="${mapsUrl}">Google Maps Directions</a>`,
        ].filter(Boolean).join('\n');

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

    // 7. Return unlocked data in HTTP response payload
    return NextResponse.json({
      success: true,
      message: 'Payment verified successfully and contact details unlocked.',
      order_id: order.id,
      unlocked_details: {
        exact_address: unlocked.exact_address,
        latitude: unlocked.latitude,
        longitude: unlocked.longitude,
        contact_name: unlocked.contact_name,
        contact_phone: unlocked.contact_phone,
        contact_telegram: unlocked.contact_telegram,
        google_maps_url: `https://www.google.com/maps?q=${unlocked.latitude},${unlocked.longitude}`,
      },
    });
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation Error', details: error.issues },
        { status: 400 }
      );
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error('Orders Verify Route Exception:', message);
    return NextResponse.json(
      { error: 'Internal server error verifying transaction.' },
      { status: 500 }
    );
  }
}
