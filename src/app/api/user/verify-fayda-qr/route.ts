import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase-server';
import { decodePayload } from 'fayda-decoder';
import { verifySignature } from 'fayda-decoder/verify';
import { persistFaydaVerification, validateFaydaStructure } from '@/lib/fayda-verification';
import { validateTelegramInitData } from '@/lib/telegram-auth';

const escapeHtmlSafe = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const verifyFaydaQrSchema = z.object({
  telegram_id: z.number().or(z.string().transform((val) => parseInt(val, 10))),
  qr_data: z.string().min(1, 'QR data is required'),
});

export async function POST(request: Request) {
  try {
    const rawBody = await request.json();
    const initData = request.headers.get('x-telegram-init-data') || rawBody.initData;
    if (!initData || typeof initData !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Please open SpaceMatch inside Telegram (@Spacematchaddis_bot) to verify Fayda ID.' },
        { status: 401 }
      );
    }

    let validatedTg;
    try {
      validatedTg = validateTelegramInitData(initData);
    } catch {
      return NextResponse.json({ success: false, error: 'Invalid Telegram session signature.' }, { status: 401 });
    }

    const parsed = verifyFaydaQrSchema.parse({
      telegram_id: rawBody.telegram_id || validatedTg.user.id,
      qr_data: rawBody.qr_data,
    });
    if (validatedTg.user.id !== parsed.telegram_id) {
      return NextResponse.json({ success: false, error: 'Forbidden: Telegram identity mismatch.' }, { status: 403 });
    }
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

    if (!decoded.fields.fan) {
      return NextResponse.json(
        {
          success: false,
          error: 'Fayda QR payload is missing the Fayda Account Number (FAN).',
        },
        { status: 400 }
      );
    }

    // Cryptographically verify RS256 signature strictly (close forged :SIGN: bypass)
    const signatureVerification = await verifySignature(decoded, {
      publicKeyPem: process.env.FAYDA_PUBLIC_KEY_PEM,
    });
    const cleanFanForCheck = String(decoded.fields.fan).replace(/\D/g, '');
    const structCheck = validateFaydaStructure(cleanFanForCheck);

    if (!signatureVerification.verified || !structCheck.valid) {
      return NextResponse.json(
        {
          success: false,
          error: `Cryptographic signature verification failed: ${signatureVerification.reason || structCheck.error || 'Invalid digital signature'}.`,
        },
        { status: 400 }
      );
    }

    const fan = structCheck.fanNumber || cleanFanForCheck;
    const fullName = decoded.fields.full_name || undefined;
    const gender = decoded.fields.gender === 'M' ? 'Male' : decoded.fields.gender === 'F' ? 'Female' : (decoded.fields.gender || undefined);
    const dob = decoded.fields.date_of_birth || undefined;

    // 2. Uniqueness check: Ensure Fayda number is not claimed by another Telegram user
    const { data: existingUsers } = await supabaseAdmin
      .from('users')
      .select('id, telegram_id')
      .eq('fayda_id_number', fan)
      .neq('telegram_id', telegram_id)
      .limit(1);

    if (existingUsers && existingUsers.length > 0) {
      return NextResponse.json(
        {
          success: false,
          error: 'This Fayda National ID is already registered to another SpaceMatch account.',
        },
        { status: 409 }
      );
    }

    // 3. Persist verified Fayda status to users and profiles tables
    await persistFaydaVerification(telegram_id, fan, fullName, {
      gender,
      dob,
      verifiedSource: 'offline_rs256_qr',
    });

    // 4. Send direct Telegram DM confirming instant verification
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (botToken) {
      const maskedFin = `•••• •••• ${fan.slice(-4)}`;
      const safeName = fullName ? escapeHtmlSafe(fullName) : '';
      const verificationMsg = `
<b>Fayda National ID Verified / የፋይዳ መታወቂያ ተረጋግጧል</b>

<blockquote>• <b>Status / ሁኔታ:</b> Verified / የጸደቀ
• <b>Fayda ID / ፋይዳ:</b> <code>${maskedFin}</code>
${safeName ? `• <b>Name / ስም:</b> <b>${safeName}</b>\n` : ''}${gender ? `• <b>Gender / ጾታ:</b> ${escapeHtmlSafe(gender)}\n` : ''}Your identity has been verified via official Fayda QR code.
መታወቂያዎ በይፋዊው የፋይዳ QR ኮድ ተረጋግጧል።</blockquote>
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
              [{ text: 'Search Roommate / የቤት አጋር ፈልግ', callback_data: 'search_roommate_start' }],
              [{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }],
            ],
          },
        }),
      }).catch(() => {});

      try {
        const { data: admins } = await supabaseAdmin
          .from('users')
          .select('telegram_id')
          .eq('role', 'admin');

        const adminNotice = `
<b>New Fayda Verification (QR Scan)</b>
• <b>Telegram ID:</b> <code>${telegram_id}</code>
• <b>Fayda ID:</b> <code>${maskedFin}</code>
${safeName ? `• <b>Name:</b> ${safeName}\n` : ''}• <b>Verification:</b> Cryptographic QR Validated
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
