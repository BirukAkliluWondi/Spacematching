import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase-server';
import { decodePayload } from 'fayda-decoder';
import { verifySignature } from 'fayda-decoder/verify';
import { decodeFaydaQr } from '@/lib/fayda-qr-decoder';
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

    // 1. Decode Fayda QR data offline: try signed NIDP V4 first, then hardened MOSIP Claim 169 / official NIDP URLs
    let fan = '';
    let fullName: string | undefined;
    let gender: string | undefined;
    let dob: string | undefined;
    let verifiedSource = 'offline_rs256_qr';

    const decoded = decodePayload(qr_data, { includeFace: false });
    if (decoded.ok && decoded.fields?.fan) {
      const signatureVerification = await verifySignature(decoded, {
        publicKeyPem: process.env.FAYDA_PUBLIC_KEY_PEM,
      });
      const cleanFanForCheck = String(decoded.fields.fan).replace(/\D/g, '');
      const isSignedDigitsValid =
        (cleanFanForCheck.length === 12 || cleanFanForCheck.length === 16) &&
        !/^(\d)\1+$/.test(cleanFanForCheck);

      if (!signatureVerification.verified || !isSignedDigitsValid) {
        return NextResponse.json(
          {
            success: false,
            error: `Cryptographic signature verification failed: ${signatureVerification.reason || (!isSignedDigitsValid ? 'Invalid FAN format' : 'Invalid digital signature')}.`,
          },
          { status: 400 }
        );
      }

      fan = cleanFanForCheck;
      fullName = decoded.fields.full_name || undefined;
      gender = decoded.fields.gender === 'M' ? 'Male' : decoded.fields.gender === 'F' ? 'Female' : (decoded.fields.gender || undefined);
      dob = decoded.fields.date_of_birth || undefined;
    } else {
      // Fallback to hardened MOSIP Claim 169 CBOR / official NIDP URL decoder (rejects raw forged V4 JWS)
      const isForgedV4 = qr_data.includes(':SIGN:') || qr_data.includes(':DLT:');
      if (isForgedV4) {
        return NextResponse.json(
          {
            success: false,
            error: 'Invalid or tampered Fayda V4 digital signature.',
          },
          { status: 400 }
        );
      }

      const fallbackDecoded = decodeFaydaQr(qr_data);
      if (!fallbackDecoded.success || !fallbackDecoded.faydaNumber) {
        const decodeErrMsg = !decoded.ok ? decoded.error?.message : undefined;
        return NextResponse.json(
          {
            success: false,
            error: fallbackDecoded.error || decodeErrMsg || 'Invalid Fayda QR code. Please scan an authentic Ethiopian Fayda card or e-Fayda document.',
          },
          { status: 400 }
        );
      }

      const structCheck = validateFaydaStructure(fallbackDecoded.faydaNumber);
      if (!structCheck.valid) {
        return NextResponse.json(
          { success: false, error: structCheck.error || 'Invalid Fayda ID number.' },
          { status: 400 }
        );
      }

      fan = structCheck.fanNumber || fallbackDecoded.faydaNumber;
      fullName = fallbackDecoded.fullName;
      gender = fallbackDecoded.gender;
      dob = fallbackDecoded.dob;
      verifiedSource = `offline_${fallbackDecoded.rawType || 'qr'}`;
    }

    // 2. Uniqueness check: Ensure Fayda number is not claimed by another Telegram user (fail closed on DB error)
    const { data: existingUsers, error: uniquenessErr } = await supabaseAdmin
      .from('users')
      .select('id, telegram_id')
      .eq('fayda_id_number', fan)
      .neq('telegram_id', telegram_id)
      .limit(1);

    if (uniquenessErr) {
      return NextResponse.json(
        { success: false, error: 'Unable to validate Fayda ID uniqueness right now. Please try again.' },
        { status: 500 }
      );
    }

    if (existingUsers && existingUsers.length > 0) {
      return NextResponse.json(
        {
          success: false,
          error: 'This Fayda National ID is already registered to another SpaceMatch account.',
        },
        { status: 409 }
      );
    }

    // 3. Persist verified Fayda status to users and profiles tables (pass validated Telegram user metadata)
    const persisted = await persistFaydaVerification(telegram_id, fan, fullName, {
      gender,
      dob,
      verifiedSource,
      from: validatedTg.user,
    });
    if (!persisted) {
      return NextResponse.json(
        { success: false, error: 'Failed to save verification status. Please try again.' },
        { status: 500 }
      );
    }

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
          .eq('role', 'admin')
          .gt('telegram_id', 0);

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
