import { NextResponse } from 'next/server';
import {
  ADMIN_SESSION_COOKIE,
  signAdminToken,
  verifyAdminPasscode,
  verifyAdminRequest,
  verifyAdminToken,
} from '@/lib/admin-auth';
import { validateTelegramInitData } from '@/lib/telegram-auth';
import { getAdminTelegramIds } from '@/lib/bot-session-store';

export async function GET(request: Request) {
  const auth = await verifyAdminRequest(request);
  return NextResponse.json({
    authenticated: auth.authenticated,
    telegramId: auth.telegramId || null,
    passcodeEnabled: Boolean((process.env.ADMIN_PASSCODE || '').trim()),
  });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { initData, auth_token, passcode } = body || {};

    let verifiedAdminId: number | null = null;

    if (typeof auth_token === 'string' && auth_token.trim()) {
      const check = await verifyAdminToken(auth_token.trim());
      if (check.valid && check.telegramId) {
        verifiedAdminId = check.telegramId;
      }
    } else if (typeof initData === 'string' && initData.trim()) {
      try {
        const validated = validateTelegramInitData(initData);
        const adminIds = await getAdminTelegramIds();
        if (adminIds.includes(validated.user.id)) {
          verifiedAdminId = validated.user.id;
        }
      } catch {
        verifiedAdminId = null;
      }
    } else if (typeof passcode === 'string' && passcode.trim()) {
      if (verifyAdminPasscode(passcode)) {
        const adminIds = await getAdminTelegramIds();
        verifiedAdminId = adminIds[0] || 800701176;
      }
    }

    if (!verifiedAdminId) {
      return NextResponse.json(
        { success: false, error: 'Invalid or unauthorized admin credentials.' },
        { status: 401 }
      );
    }

    const sessionToken = signAdminToken(verifiedAdminId, 24 * 60 * 60);
    const response = NextResponse.json({ success: true, authenticated: true, telegramId: verifiedAdminId });
    response.cookies.set(ADMIN_SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 24 * 60 * 60,
    });
    return response;
  } catch {
    return NextResponse.json({ success: false, error: 'Authentication error' }, { status: 400 });
  }
}

export async function DELETE() {
  const response = NextResponse.json({ success: true, authenticated: false });
  response.cookies.set(ADMIN_SESSION_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return response;
}
