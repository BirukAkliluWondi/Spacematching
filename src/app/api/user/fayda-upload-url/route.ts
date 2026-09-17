import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase-server';

const faydaUploadUrlSchema = z.object({
  telegram_id: z.number().or(z.string().transform((val) => parseInt(val, 10))),
  file_extension: z.string().optional().default('jpg'),
});

export async function POST(request: Request) {
  try {
    const rawBody = await request.json();
    const parsed = faydaUploadUrlSchema.parse({
      telegram_id: rawBody.telegram_id,
      file_extension: rawBody.file_extension || rawBody.fileExtension,
    });

    const { telegram_id, file_extension } = parsed;

    // 1. Resolve user profile by telegram_id
    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .select('id, telegram_id, first_name, username')
      .eq('telegram_id', telegram_id)
      .single();

    if (userError || !user) {
      return NextResponse.json(
        { error: 'User record not found.' },
        { status: 404 }
      );
    }

    // 2. Generate unique storage file path inside private 'fayda-ids' bucket
    const ext = String(file_extension).replace('.', '').toLowerCase();
    const filePath = `user_${user.id}_fayda_${Date.now()}.${ext}`;

    // 3. Create presigned upload URL via Supabase Storage API
    const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
      .from('fayda-ids')
      .createSignedUploadUrl(filePath);

    if (uploadError || !uploadData) {
      console.error('Failed to create signed upload URL:', uploadError);
      return NextResponse.json(
        { error: 'Storage API failed to generate presigned URL.', details: uploadError?.message },
        { status: 500 }
      );
    }

    // 4. Update user record: store file path and set fayda_status = 'pending'
    const { error: updateError } = await supabaseAdmin
      .from('users')
      .update({
        fayda_url: filePath,
        fayda_status: 'pending',
        updated_at: new Date().toISOString(),
      })
      .eq('id', user.id);

    if (updateError) {
      console.error('Database update error for Fayda upload:', updateError);
      return NextResponse.json(
        { error: 'Failed to update user Fayda verification status in database.', details: updateError.message },
        { status: 500 }
      );
    }

    // 5. Notify all Admin users via Telegram DM with 1-Click Approval Buttons
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (botToken) {
      try {
        const { data: admins } = await supabaseAdmin
          .from('users')
          .select('telegram_id')
          .eq('role', 'admin');

        // Generate signed read URL for admin inspection
        const { data: signedRead } = await supabaseAdmin.storage
          .from('fayda-ids')
          .createSignedUrl(filePath, 86400); // Valid for 24 hours

        const viewUrl = signedRead?.signedUrl || '';
        const adminText = [
          `<b>🛡️ New Fayda ID Uploaded for Review</b>`,
          ``,
          `👤 <b>Renter Name:</b> ${user.first_name}`,
          `🆔 <b>Telegram ID:</b> <code>${user.telegram_id}</code>`,
          user.username ? `✈️ <b>Username:</b> @${user.username}` : '',
          ``,
          viewUrl ? `📄 <a href="${viewUrl}">View Uploaded ID Document</a>` : `📄 File Path: <code>${filePath}</code>`,
          ``,
          `Please review and approve or reject below:`,
        ].filter(Boolean).join('\n');

        if (admins && admins.length > 0) {
          for (const admin of admins) {
            await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: admin.telegram_id,
                text: adminText,
                parse_mode: 'HTML',
                reply_markup: {
                  inline_keyboard: [
                    [
                      { text: '✅ Approve Fayda ID', callback_data: `fayda_approve:${user.telegram_id}` },
                      { text: '❌ Reject Fayda ID', callback_data: `fayda_reject:${user.telegram_id}` },
                    ],
                  ],
                },
              }),
            });
          }
        }
      } catch (adminNotifyErr) {
        console.error('Admin notification error:', adminNotifyErr);
      }
    }

    return NextResponse.json({
      success: true,
      signed_upload_url: uploadData.signedUrl,
      token: uploadData.token,
      file_path: filePath,
      expires_in_seconds: 300,
      fayda_status: 'pending',
    });
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation Error', details: error.issues },
        { status: 400 }
      );
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error('Fayda Presigned URL Route Exception:', message);
    return NextResponse.json(
      { error: 'Internal server error processing presigned URL.' },
      { status: 500 }
    );
  }
}
