import crypto from 'crypto';
import { validateTelegramInitData } from '@/lib/telegram-auth';
import { getAdminTelegramIds } from '@/lib/bot-session-store';

export const ADMIN_SESSION_COOKIE = 'sm_admin_session';

function getSigningSecret(): string | null {
  const raw = (process.env.ADMIN_SECRET || process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!raw) return null;
  return crypto.createHash('sha256').update(`${raw}:spacematch_admin_auth_v1`).digest('hex');
}

/**
 * Signs a stateless HMAC-SHA256 admin token for a verified admin Telegram ID.
 */
export function signAdminToken(telegramId: number, ttlSeconds = 86400): string {
  const secret = getSigningSecret();
  if (!secret) {
    throw new Error('Admin auth secret/bot token is not configured.');
  }
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = Buffer.from(JSON.stringify({ tid: telegramId, exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

/**
 * Verifies a signed admin token and confirms the Telegram ID is still an active Admin.
 */
export async function verifyAdminToken(token: string | undefined | null): Promise<{ valid: boolean; telegramId?: number }> {
  if (!token || typeof token !== 'string') return { valid: false };
  const secret = getSigningSecret();
  if (!secret) return { valid: false };

  const parts = token.trim().split('.');
  if (parts.length !== 2) return { valid: false };
  const [payload, sig] = parts;
  if (!payload || !sig) return { valid: false };

  const expectedSig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { valid: false };
  }

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const exp = Number(parsed?.exp || 0);
    const tid = Number(parsed?.tid || 0);
    if (!exp || exp < Math.floor(Date.now() / 1000) || !tid) {
      return { valid: false };
    }
    const adminIds = await getAdminTelegramIds();
    if (!adminIds.includes(tid)) {
      return { valid: false };
    }
    return { valid: true, telegramId: tid };
  } catch {
    return { valid: false };
  }
}

/**
 * Verifies an optional configured ADMIN_PASSCODE in a timing-safe way.
 */
export function verifyAdminPasscode(passcode: string | undefined | null): boolean {
  const expected = (process.env.ADMIN_PASSCODE || '').trim();
  if (!expected || !passcode || typeof passcode !== 'string') return false;
  const a = Buffer.from(passcode.trim());
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function parseCookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

/**
 * Verifies whether an incoming Request is authorized as a SpaceMatch Admin
 * via signed session cookie, bearer token, or Telegram WebApp initData HMAC.
 */
export async function verifyAdminRequest(
  request: Request
): Promise<{ authenticated: boolean; telegramId?: number }> {
  // 1. Check signed HttpOnly cookie
  const cookieToken = parseCookieValue(request.headers.get('cookie'), ADMIN_SESSION_COOKIE);
  if (cookieToken) {
    const res = await verifyAdminToken(cookieToken);
    if (res.valid) return { authenticated: true, telegramId: res.telegramId };
  }

  // 2. Check Authorization Bearer or x-admin-token header
  const authHeader = request.headers.get('authorization');
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  const headerToken = bearer || request.headers.get('x-admin-token');
  if (headerToken) {
    const res = await verifyAdminToken(headerToken);
    if (res.valid) return { authenticated: true, telegramId: res.telegramId };
  }

  // 3. Check Telegram WebApp initData HMAC header
  const initData = request.headers.get('x-telegram-init-data');
  if (initData) {
    try {
      const validated = validateTelegramInitData(initData);
      const adminIds = await getAdminTelegramIds();
      if (adminIds.includes(validated.user.id)) {
        return { authenticated: true, telegramId: validated.user.id };
      }
    } catch {
      return { authenticated: false };
    }
  }

  return { authenticated: false };
}
