import crypto from 'crypto';
import { z } from 'zod';

export const telegramUserSchema = z.object({
  id: z.number(),
  first_name: z.string(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  language_code: z.string().optional(),
  allows_write_to_pm: z.boolean().optional(),
});

export type TelegramUser = z.infer<typeof telegramUserSchema>;

export interface ValidatedTelegramData {
  user: TelegramUser;
  auth_date: number;
  hash: string;
  query_id?: string;
}

/**
 * Validates Telegram Mini App initData string according to official Telegram specification:
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-web-app
 * 
 * Enforces:
 * 1. HMAC-SHA256 signature verification against TELEGRAM_BOT_TOKEN
 * 2. Replay freshness enforcement (auth_date <= 2 hours old)
 * 3. Zod Schema Validation on Telegram User Object
 */
export function validateTelegramInitData(initData: string): ValidatedTelegramData {
  if (!initData || typeof initData !== 'string') {
    throw new Error('Telegram initData is missing or invalid');
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is not configured on server');
  }

  const urlParams = new URLSearchParams(initData);
  const hash = urlParams.get('hash');

  if (!hash) {
    throw new Error('Invalid initData: Missing hash parameter');
  }

  // 1. Sort all parameters (except hash) lexicographically
  const dataCheckArr: string[] = [];
  urlParams.forEach((value, key) => {
    if (key !== 'hash') {
      dataCheckArr.push(`${key}=${value}`);
    }
  });

  dataCheckArr.sort();
  const dataCheckString = dataCheckArr.join('\n');

  // 2. Compute Secret Key = HMAC-SHA256("WebAppData", botToken)
  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();

  // 3. Compute calculated hash = HMAC-SHA256(secretKey, dataCheckString)
  const calculatedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  // 4. Safe timing comparison
  const calculatedBuffer = Buffer.from(calculatedHash, 'hex');
  const receivedBuffer = Buffer.from(hash, 'hex');

  if (calculatedBuffer.length !== receivedBuffer.length || !crypto.timingSafeEqual(calculatedBuffer, receivedBuffer)) {
    throw new Error('Telegram authentication failed: Signature verification hash mismatch');
  }

  // 5. Replay Freshness Enforcement (reject auth_date > 2 hours old)
  const authDateStr = urlParams.get('auth_date');
  if (!authDateStr) {
    throw new Error('Invalid initData: Missing auth_date parameter');
  }

  const authDate = parseInt(authDateStr, 10);
  const currentTime = Math.floor(Date.now() / 1000);
  const maxAgeInSeconds = 2 * 60 * 60; // 2 hours

  if (currentTime - authDate > maxAgeInSeconds) {
    throw new Error('Telegram authentication failed: Session expired (auth_date is older than 2 hours)');
  }

  // 6. Parse & Validate User Object with Zod
  const userJson = urlParams.get('user');
  if (!userJson) {
    throw new Error('Invalid initData: Missing user object');
  }

  let rawUser: unknown;
  try {
    rawUser = JSON.parse(userJson);
  } catch {
    throw new Error('Invalid initData: Failed to parse user JSON payload');
  }

  const parsedUser = telegramUserSchema.parse(rawUser);

  return {
    user: parsedUser,
    auth_date: authDate,
    hash,
    query_id: urlParams.get('query_id') || undefined,
  };
}
