import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase-server';
import { decodeFaydaQr } from '@/lib/fayda-qr-decoder';

const verifyFaydaQrSchema = z.object({
  telegram_id: z.number().or(z.string().transform((val) => parseInt(val, 10))),
  qr_data: z.string().min(1, 'QR data is required'),
});

export async function POST(request: Request) {
  try {
    const rawBody = await request.json();
    const parsed = verifyFaydaQrSchema.parse(rawBody);
    const { telegram_id, qr_data } = parsed;

    // 1. Decode Fayda QR data offline
    const decodeResult = decodeFaydaQr(qr_data);
    if (!decodeResult.success || !decodeResult.faydaNumber) {
      return NextResponse.json(
        {
          success: false,
          error: decodeResult.error || 'Invalid Fayda QR code. Please scan an authentic Ethiopian Fayda card or e-Fayda document.',
        },
        { status: 400 }
      );
    }

    const { faydaNumber, fullName, gender, dob } = decodeResult;

    // 2. Uniqueness check: Ensure Fayda number is not claimed by another Telegram user
    try {
      const { data: existingUser } = await supabaseAdmin
        .from('users')
        .select('id, telegram_id')
        .eq('fayda_number', faydaNumber)
        .neq('telegram_id', telegram_id)
        .limit(1)
        .single();

      if (existingUser) {
        return NextResponse.json(
          {
            success: false,
            error: 'This Fayda National ID is already registered to another SpaceMatch account.',
          },
          { status: 409 }
        );
      }
    } catch {}

    // 3. Update 'users' table
    try {
      await supabaseAdmin
        .from('users')
        .update({
          fayda_status: 'verified',
          fayda_number: faydaNumber,
          updated_at: new Date().toISOString(),
        })
        .eq('telegram_id', telegram_id);
    } catch (userErr) {
      console.error('Error updating users table with verified Fayda:', userErr);
    }

    // 4. Update 'profiles' table
    try {
      await supabaseAdmin
        .from('profiles')
        .update({
          kyc_status: 'verified',
          status: 'active',
        })
        .eq('telegram_id', telegram_id);
    } catch (profErr) {
      console.error('Error updating profiles table with verified Fayda:', profErr);
    }

    // 5. Send direct Telegram DM to the user confirming instant verification
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (botToken) {
      const maskedFin = `•••• •••• ${faydaNumber.slice(-4)}`;
      const verificationMsg = `
🎉 <b>FAYDA NATIONAL ID VERIFIED!</b>
🛡️ <b>Status:</b> VERIFIED ✅

• <b>Fayda ID:</b> <code>${maskedFin}</code>
${fullName ? `• <b>Verified Name:</b> <b>${fullName}</b>\n` : ''}${gender ? `• <b>Gender:</b> ${gender}\n` : ''}
<blockquote>✅ Your identity has been verified offline via official Fayda QR code. You now have full, unrestricted access to the Matchmaker and Seeker Listings!</blockquote>
      `.trim();

      fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: telegram_id,
          text: verificationMsg,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '⚡ Open Matchmaker Now 🔍', callback_data: 'matchmaker_start' }],
              [{ text: '👥 Post Seeker Profile', callback_data: 'seeker_flow' }],
              [{ text: '🏠 Main Menu', callback_data: 'nav_start' }],
            ],
          },
        }),
      }).catch(() => {});

      // 6. Notify Admins
      try {
        const { data: admins } = await supabaseAdmin
          .from('users')
          .select('telegram_id')
          .eq('role', 'admin');

        const adminNotice = `
🛡️ <b>New Fayda Verification (QR Scan)</b>
• <b>Telegram ID:</b> <code>${telegram_id}</code>
• <b>Fayda ID:</b> <code>${maskedFin}</code>
${fullName ? `• <b>Name:</b> ${fullName}\n` : ''}• <b>Verification:</b> Instant Offline QR Validated ✅
        `.trim();

        if (admins && admins.length > 0) {
          for (const admin of admins) {
            fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: admin.telegram_id,
                text: adminNotice,
                parse_mode: 'HTML',
              }),
            }).catch(() => {});
          }
        }
      } catch {}
    }

    return NextResponse.json({
      success: true,
      message: 'Fayda ID verified successfully via offline QR scan.',
      fayda_number: faydaNumber,
      full_name: fullName,
      gender,
      dob,
    });
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { success: false, error: 'Invalid input parameters.', details: error.issues },
        { status: 400 }
      );
    }
    const msg = error instanceof Error ? error.message : String(error);
    console.error('API verify-fayda-qr error:', msg);
    return NextResponse.json(
      { success: false, error: 'An unexpected error occurred during QR verification.' },
      { status: 500 }
    );
  }
}
