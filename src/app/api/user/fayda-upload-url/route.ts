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

    const { telegram_id } = parsed;

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

    // 2. Zero-storage policy: Direct file uploads to Supabase storage are disabled to prevent free tier quota exhaustion.
    // Clients must use offline in-memory QR decoding via /api/user/verify-fayda-qr.
    return NextResponse.json(
      {
        success: false,
        error: 'Direct file storage is disabled to prevent database quota exhaustion. Please scan and verify your Fayda QR code directly via /api/user/verify-fayda-qr or in the Telegram bot.',
      },
      { status: 410 }
    );
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
