import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase-server';
import { decodePayload } from 'fayda-decoder';
import { verifySignature } from 'fayda-decoder/verify';
import { persistFaydaVerification } from '@/lib/fayda-verification';

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
    const decoded = decodePayload(qr_data, { includeFace: false });
    if (!decoded.ok) {
      return NextResponse.json(
        {
          success: false,
          error: decoded.error.message || 'Invalid Fayda QR code. Please scan an authentic Ethiopian Fayda card or e-Fayda document.',
        },
        { status: 400 }
      );
    }

    // Guard against partial success: fan must be present
    if (!decoded.fields.fan) {
      return NextResponse.json(
        {
          success: false,
          error: 'Fayda QR payload is missing the Fayda Account Number (FAN).',
        },
        { status: 400 }
      );
    }

    // Cryptographically verify RS256 signature
    const signatureVerification = await verifySignature(decoded, {
      publicKeyPem: process.env.FAYDA_PUBLIC_KEY_PEM,
    });
    if (!signatureVerification.verified) {
      return NextResponse.json(
        {
          success: false,
          error: `Cryptographic signature verification failed: ${signatureVerification.reason || 'Invalid digital signature'}.`,
        },
        { status: 400 }
      );
    }

    const fan = decoded.fields.fan;
    const fullName = decoded.fields.full_name || undefined;
    const gender = decoded.fields.gender === 'M' ? 'Male' : decoded.fields.gender === 'F' ? 'Female' : (decoded.fields.gender || undefined);
    const dob = decoded.fields.date_of_birth || undefined;

    // 2. Uniqueness check: Ensure Fayda number is not claimed by another Telegram user
    try {
      const { data: existingUser } = await supabaseAdmin
        .from('users')
        .select('id, telegram_id')
        .eq('fayda_id_number', fan)
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

    // 3. Persist verified Fayda status to users and profiles tables (with non-null first_name guarantee and profile creation)
    await persistFaydaVerification(telegram_id, fan, fullName, {
      gender,
      dob,
      verifiedSource: 'offline_rs256_qr',
    });

    // 5. Send direct Telegram DM to the user confirming instant verification
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (botToken) {
      const maskedFin = `•••• •••• ${fan.slice(-4)}`;
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
      fayda_number: fan,
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
