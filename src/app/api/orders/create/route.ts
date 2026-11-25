import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase-server';
import { validateTelegramInitData } from '@/lib/telegram-auth';
import { getUserMembershipStatus } from '@/lib/bot-session-store';

const createOrderSchema = z.object({
  space_id: z.string().uuid('Invalid space_id UUID format'),
  telegram_id: z.number().or(z.string().transform((val) => parseInt(val, 10))),
});

export async function POST(request: Request) {
  try {
    const rawBody = await request.json();
    const initData = request.headers.get('x-telegram-init-data') || rawBody.initData;
    if (!initData || typeof initData !== 'string') {
      return NextResponse.json(
        { error: 'Please open SpaceMatch inside Telegram (@Spacematchaddis_bot) to continue.' },
        { status: 401 }
      );
    }

    let validatedTg;
    try {
      validatedTg = validateTelegramInitData(initData);
    } catch {
      return NextResponse.json({ error: 'Invalid Telegram session signature.' }, { status: 401 });
    }

    const parsed = createOrderSchema.parse({
      space_id: rawBody.space_id,
      telegram_id: rawBody.telegram_id || rawBody.renter_telegram_id || validatedTg.user.id,
    });

    if (validatedTg.user.id !== parsed.telegram_id) {
      return NextResponse.json({ error: 'Forbidden: Telegram identity mismatch.' }, { status: 403 });
    }

    const { space_id, telegram_id } = parsed;

    // 1, 2, 3, 4: Fetch user, space, existing completed order, and active 3-month pass in parallel
    const [userRes, spaceRes, existingOrderRes, membershipStatus] = await Promise.all([
      supabaseAdmin
        .from('users')
        .select('id, telegram_id, fayda_status')
        .eq('telegram_id', telegram_id)
        .maybeSingle(),
      supabaseAdmin
        .from('spaces')
        .select('id, title, unlock_fee, status')
        .eq('id', space_id)
        .maybeSingle(),
      supabaseAdmin
        .from('orders')
        .select('id, payment_status')
        .eq('renter_telegram_id', telegram_id)
        .eq('space_id', space_id)
        .eq('payment_status', 'completed')
        .maybeSingle(),
      getUserMembershipStatus(telegram_id),
    ]);

    const user = userRes.data;
    if (userRes.error || !user) {
      return NextResponse.json(
        { error: 'User record not found. Please send /start in @Spacematchaddis_bot first.' },
        { status: 404 }
      );
    }

    // Enforce Fayda Verification
    if (user.fayda_status !== 'verified') {
      return NextResponse.json(
        {
          error: 'FAYDA_VERIFICATION_REQUIRED',
          message: 'Fayda National ID verification is required before unlocking space contacts.',
        },
        { status: 403 }
      );
    }

    const space = spaceRes.data;
    if (spaceRes.error || !space || space.status !== 'published') {
      return NextResponse.json(
        { error: 'Space listing is not available for unlock orders.' },
        { status: 400 }
      );
    }

    const existingCompletedOrder = existingOrderRes.data;
    if (existingCompletedOrder || membershipStatus.isActive) {
      const { data: unlockedData } = await supabaseAdmin.rpc('get_unlocked_space_details', {
        p_space_id: space_id,
        p_telegram_id: telegram_id,
      });
      const unlocked = Array.isArray(unlockedData) ? unlockedData[0] : unlockedData;

      return NextResponse.json({
        success: true,
        already_unlocked: true,
        order_id: existingCompletedOrder?.id || membershipStatus.orderId,
        amount: 100,
        message: '3-Month Pass active — space contact details are unlocked.',
        unlocked_details: unlocked || null,
      });
    }

    // Invariant 7: SpaceMatch All-Access Membership Pass is strictly 100 ETB for 3 Months
    const unlockFeeAmount = 100;
    const receiverPhone = process.env.TELEBIRR_RECEIVER_PHONE || '0987310978';
    const abyssiniaAccount = process.env.ABYSSINIA_ACCOUNT_NUMBER || '256861771';
    const dashenAccount = process.env.DASHEN_ACCOUNT_NUMBER || '2922175078411';
    const accountHolder = 'Wahid';
    const tempTxRef = `PENDING_${crypto.randomUUID()}`;

    const { data: order, error: orderError } = await supabaseAdmin
      .from('orders')
      .insert({
        buyer_telegram_id: telegram_id,
        renter_telegram_id: telegram_id,
        order_type: 'membership_pass',
        target_type: 'membership_90d',
        target_id: 'pass_90d',
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
        { error: 'Failed to initialize pending order record.', details: orderError?.message },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      order_id: order.id,
      amount: unlockFeeAmount,
      currency: 'ETB',
      telebirr_receiver_phone: receiverPhone,
      abyssinia_account: abyssiniaAccount,
      dashen_account: dashenAccount,
      account_holder: accountHolder,
      instructions: `Transfer ${unlockFeeAmount} ETB for your 3-Month All-Access Pass via Telebirr (${receiverPhone}), Bank of Abyssinia (${abyssiniaAccount}), or Dashen Bank (${dashenAccount}) to ${accountHolder} and submit your transaction reference number to verify.`,
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
