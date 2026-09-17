import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase-server';

const createOrderSchema = z.object({
  space_id: z.string().uuid('Invalid space_id UUID format'),
  telegram_id: z.number().or(z.string().transform((val) => parseInt(val, 10))),
});

export async function POST(request: Request) {
  try {
    const rawBody = await request.json();
    const parsed = createOrderSchema.parse({
      space_id: rawBody.space_id,
      telegram_id: rawBody.telegram_id || rawBody.renter_telegram_id,
    });

    const { space_id, telegram_id } = parsed;

    // 1. Resolve user record from telegram_id
    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .select('id, telegram_id, fayda_status')
      .eq('telegram_id', telegram_id)
      .single();

    if (userError || !user) {
      return NextResponse.json(
        { error: 'User record not found. Please authenticate via Telegram first.' },
        { status: 404 }
      );
    }

    // 2. Fetch dynamic unlock_fee and status directly from the space listing
    const { data: space, error: spaceError } = await supabaseAdmin
      .from('spaces')
      .select('id, title, unlock_fee, status')
      .eq('id', space_id)
      .single();

    if (spaceError || !space || space.status !== 'published') {
      return NextResponse.json(
        { error: 'Space listing is not available for unlock orders.' },
        { status: 400 }
      );
    }

    // 3. Check for existing completed order for this space and renter_telegram_id
    const { data: existingCompletedOrder } = await supabaseAdmin
      .from('orders')
      .select('id, payment_status')
      .eq('renter_telegram_id', telegram_id)
      .eq('space_id', space_id)
      .eq('payment_status', 'completed')
      .maybeSingle();

    if (existingCompletedOrder) {
      return NextResponse.json({
        success: true,
        already_unlocked: true,
        order_id: existingCompletedOrder.id,
        amount: Number(space.unlock_fee),
        message: 'Space contact details are already unlocked for this user.',
      });
    }

    const unlockFeeAmount = Number(space.unlock_fee || '50.00');
    const receiverPhone = process.env.TELEBIRR_RECEIVER_PHONE || '09XXXXXXXX';
    const tempTxRef = `PENDING_${crypto.randomUUID()}`;

    // 4. Insert pending order record using renter_telegram_id and dynamic space unlock_fee
    const { data: order, error: orderError } = await supabaseAdmin
      .from('orders')
      .insert({
        renter_telegram_id: telegram_id,
        space_id: space_id,
        amount: unlockFeeAmount,
        transaction_reference: tempTxRef,
        payment_status: 'pending',
      })
      .select('id, amount, payment_status, created_at')
      .single();

    if (orderError || !order) {
      console.error('Order insertion database error:', orderError);
      return NextResponse.json(
        { error: 'Failed to initialize pending order record.', details: orderError.message },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      order_id: order.id,
      amount: unlockFeeAmount,
      currency: 'ETB',
      telebirr_receiver_phone: receiverPhone,
      instructions: `Transfer ${unlockFeeAmount} ETB to Telebirr number ${receiverPhone} and submit your transaction reference number to verify.`,
    });
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation Error', details: error.issues },
        { status: 400 }
      );
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error('Orders Create Route Exception:', message);
    return NextResponse.json(
      { error: 'Internal server error processing order creation.' },
      { status: 500 }
    );
  }
}
