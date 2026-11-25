import { NextResponse } from 'next/server';
import { z } from 'zod';
import { validateTelegramInitData } from '@/lib/telegram-auth';
import { supabaseAdmin } from '@/lib/supabase-server';

const authPayloadSchema = z.object({
  initData: z.string().min(1, 'initData string is required'),
});

export async function POST(request: Request) {
  try {
    const rawBody = await request.json();
    const parsedPayload = authPayloadSchema.parse({
      initData: rawBody.initData || rawBody.init_data,
    });

    // 1. Validate Telegram HMAC signature and check replay freshness
    const validatedData = validateTelegramInitData(parsedPayload.initData);
    const { user } = validatedData;

    const { data: existingUser } = await supabaseAdmin
      .from('users')
      .select('id, role, fayda_status, first_name, last_name')
      .eq('telegram_id', user.id)
      .maybeSingle();

    const envAdminIds = (process.env.ADMIN_TELEGRAM_IDS || '800701176,148318506,980853835')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => !isNaN(n) && n > 0);
    const isConfiguredAdmin = envAdminIds.includes(user.id) || existingUser?.role === 'admin';
    const isFaydaVerified = existingUser?.fayda_status === 'verified';

    const upsertPayload: Record<string, any> = {
      telegram_id: user.id,
      first_name: isFaydaVerified && existingUser?.first_name ? existingUser.first_name : user.first_name,
      last_name: isFaydaVerified && existingUser?.last_name ? existingUser.last_name : (user.last_name || null),
      username: user.username || null,
      updated_at: new Date().toISOString(),
    };

    if (isConfiguredAdmin) {
      upsertPayload.role = 'admin';
    }

    // 2. Upsert user in Supabase 'users' table by telegram_id
    const { data: dbUser, error: dbError } = await supabaseAdmin
      .from('users')
      .upsert(upsertPayload, { onConflict: 'telegram_id' })
      .select('id, telegram_id, first_name, last_name, username, phone_number, role, fayda_url, fayda_status, created_at')
      .single();

    if (dbError) {
      console.error('Supabase user upsert database error:', dbError);
      return NextResponse.json(
        { error: 'Failed to sync user profile in database.', details: dbError.message },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      user: dbUser,
    });
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid input parameters.', details: error.issues },
        { status: 400 }
      );
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error('Telegram Auth Route Error:', message);
    return NextResponse.json(
      { error: message || 'Telegram authentication failed.' },
      { status: 401 }
    );
  }
}
