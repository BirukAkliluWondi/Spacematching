/**
 * lib/telegram.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Typed Telegram Bot API client for SpaceMatch Addis.
 * Handles all bot→user communication and channel publishing for the new
 * conversational onboarding + mutual-consent matching flow.
 *
 * Environment Variables required:
 *   TELEGRAM_BOT_TOKEN
 *   TELEGRAM_CHANNEL_ID       e.g. @spacematch_channel or -100xxxxxxxxxx
 *   NEXT_PUBLIC_BOT_USERNAME  e.g. Spacematchaddis_bot  (with or without @)
 */

import { supabaseAdmin } from '@/lib/supabase-server';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Profile {
  id: string;
  telegram_id: number;
  display_code: string;
  gender?: string | null;
  age?: number | null;
  religion?: string | null;
  job?: string | null;
  preferred_gender?: string | null;
  locations?: string[];
  budget_min?: number;
  budget_max?: number;
  move_in_date?: string | null;
  roommate_traits?: string | null;
  full_name?: string | null;
  phone_number?: string | null;
  telegram_username?: string | null;
  kyc_status?: string;
  status?: string;
  channel_message_id?: number | null;
}

export interface InlineKeyboardButton {
  text: string;
  url?: string;
  callback_data?: string;
  request_contact?: boolean;
  // [DISABLED - Mini App not ready] web_app?: { url: string };
}

export type InlineKeyboard = { inline_keyboard: InlineKeyboardButton[][] };

export interface TelegramApiResponse<T = unknown> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BOT_TOKEN = () => {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t) {
    if (process.env.MOCK_TELEGRAM_API === 'true') {
      return 'mock_bot_token';
    }
    throw new Error('TELEGRAM_BOT_TOKEN is not set');
  }
  return t;
};

const CHANNEL_ID = () => {
  const c = process.env.TELEGRAM_CHANNEL_ID;
  if (!c) {
    if (process.env.MOCK_TELEGRAM_API === 'true') {
      return '@mock_channel';
    }
    throw new Error('TELEGRAM_CHANNEL_ID is not set');
  }
  return c;
};

const BOT_USERNAME = () => {
  const u = process.env.NEXT_PUBLIC_BOT_USERNAME || 'Spacematchaddis_bot';
  return u.replace(/^@/, '');
};

/**
 * Escapes characters that carry meaning in Telegram HTML parse mode.
 * Only escapes the three truly special chars: &, <, >
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function callTelegram<T = unknown>(
  method: string,
  payload: Record<string, unknown>
): Promise<TelegramApiResponse<T>> {
  if (process.env.MOCK_TELEGRAM_API === 'true') {
    return {
      ok: true,
      result: (method === 'sendMessage' ? { message_id: 9999 } : {}) as T,
    };
  }
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN()}/${method}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connection': 'keep-alive',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8000),
      }
    );
    const json = (await res.json()) as TelegramApiResponse<T>;
    if (!json.ok) {
      console.error(`[telegram.ts] ${method} failed:`, json.description);
    }
    return json;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[telegram.ts] ${method} exception:`, msg);
    return { ok: false, description: msg };
  }
}

// ─── Core API Helpers ─────────────────────────────────────────────────────────

/**
 * Send a text message to any chat/user.
 * Always uses HTML parse mode.
 */
export async function sendMessage(
  chatId: string | number,
  text: string,
  replyMarkup?: InlineKeyboard | object
): Promise<TelegramApiResponse> {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return callTelegram('sendMessage', payload);
}

/**
 * Edit the text of an existing message (e.g. to update a loading card).
 */
export async function editMessageText(
  chatId: string | number,
  messageId: number,
  text: string,
  replyMarkup?: InlineKeyboard | object
): Promise<TelegramApiResponse> {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return callTelegram('editMessageText', payload);
}

/**
 * Delete a message from chat. In private chats, bots can delete user messages sent within 48h.
 */
export async function deleteMessage(
  chatId: string | number,
  messageId: number
): Promise<TelegramApiResponse> {
  return callTelegram('deleteMessage', { chat_id: chatId, message_id: messageId });
}

/**
 * Answer an inline button press. Optionally show a short toast/alert.
 */
export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string,
  showAlert?: boolean
): Promise<TelegramApiResponse> {
  const payload: Record<string, unknown> = { callback_query_id: callbackQueryId };
  if (text) payload.text = text;
  if (showAlert !== undefined) payload.show_alert = showAlert;
  return callTelegram('answerCallbackQuery', payload);
}

/**
 * Configure the Telegram chat menu button.
 * Setting type: 'commands' or 'default' keeps the keyboard toggle button unobstructed on mobile.
 */
export async function setChatMenuButton(
  menuButton?: {
    type: 'default' | 'commands'; // [DISABLED - Mini App not ready] | 'web_app';
    text?: string;
    // [DISABLED - Mini App not ready] web_app?: { url: string };
  },
  chatId?: number
): Promise<TelegramApiResponse> {
  const payload: Record<string, unknown> = {
    menu_button: menuButton || { type: 'commands' },
  };
  if (chatId) payload.chat_id = chatId;
  return callTelegram('setChatMenuButton', payload);
}

/**
 * Safely parses human-entered numbers from chat text.
 * Handles inputs like:
 *   "24", "24 yrs", "age 24", "i am 24", "about 24" -> 24
 *   "8000", "8,000", "15 000 birr", "15000 ETB", "birr 12000" -> 8000/15000/12000
 *   "ብር 8000", "8000 ብር" -> 8000
 *   "10k", "12.5k", "8.5 k", "around 10k", "10 ሺህ" -> 10000/12500/8500
 *   "~8000", "5000-8000", "between 5000 and 8000" -> 8000 (with preferRange: 'max')
 */
export function parseNumericInput(
  raw?: string | null,
  options?: { min?: number; max?: number; preferRange?: 'min' | 'max' }
): number | null {
  if (!raw) return null;
  let text = String(raw).trim().toLowerCase();

  // Normalize Amharic thousands notation: ሺ or ሺህ -> k
  text = text.replace(/(\d+(?:\.\d+)?)\s*(?:ሺህ|ሺ)/g, '$1k');
  // Normalize Ethiopian Birr symbol 'ብር' -> 'birr'
  text = text.replace(/ብር/g, 'birr');

  // Support range detection (e.g. "5000-8000", "5,000 - 8,000", "between 5000 and 8000", "5000 to 8000")
  const rangeMatch = text.match(/(?:between\s+)?(\d[\d,\.]*\s*k?)\s*(?:-|–|—|to|and)\s*(\d[\d,\.]*\s*k?)/i);
  if (rangeMatch) {
    const p1 = parseNumericInput(rangeMatch[1]);
    const p2 = parseNumericInput(rangeMatch[2]);
    if (p1 !== null && p2 !== null) {
      const chosen = options?.preferRange === 'min' ? Math.min(p1, p2) : Math.max(p1, p2);
      if (options?.min !== undefined && chosen < options.min) return null;
      if (options?.max !== undefined && chosen > options.max) return null;
      return chosen;
    }
  }

  // Support 'k' / multiplier notation anywhere in input: e.g. "around 10k", "8.5k ETB", "12 k"
  const kMatch = text.match(/(\d+(?:\.\d+)?)\s*k(?:\b|$)/i);
  if (kMatch) {
    const num = parseFloat(kMatch[1]);
    if (!isNaN(num) && num >= 0) {
      const val = Math.round(num * 1000);
      if (options?.min !== undefined && val < options.min) return null;
      if (options?.max !== undefined && val > options.max) return null;
      return val;
    }
  }

  // Normalize spaces between digit triplets like "15 000" -> "15000"
  text = text.replace(/(\d{1,3})\s+(\d{3})\b/g, '$1$2');

  // Strip common words, currency prefixes/suffixes, and conversational filler
  const stripped = text
    .replace(/(?:etb|birr|br|usd|\$|€|£|yrs|years|yr|old|yo|age|budget|about|around|approx|approximately|i am|iam|my|\/mo|\/month|monthly)/gi, ' ')
    .replace(/,/g, '')
    .trim();

  // Find first number sequence in the remaining text
  const match = stripped.match(/(\d+(?:\.\d+)?)/);
  if (match) {
    const parsed = Math.round(parseFloat(match[1]));
    if (!isNaN(parsed)) {
      if (options?.min !== undefined && parsed < options.min) return null;
      if (options?.max !== undefined && parsed > options.max) return null;
      return parsed;
    }
  }

  return null;
}

/**
 * Safely parses a budget range (min and max) from user text.
 * Handles inputs like:
 *   "8000 - 15000", "8,000 - 15,000", "8000–15000", "8000—15000"
 *   "8000 to 15000", "between 8000 and 15000", "8000 and 15000"
 *   "8k - 15k", "8k to 12.5k", "8000 15000"
 *   "12000" (single number fallback -> { min: 0, max: 12000 })
 */
export function formatBudgetRangeLabel(
  min?: number | null,
  max?: number | null,
  fallback = 'Flexible'
): string {
  const bMin = Number(min || 0);
  const bMax = Number(max || 0);
  if (bMin > 0 && bMax > 0 && bMin < bMax) {
    return `${bMin.toLocaleString()} – ${bMax.toLocaleString()} ETB/mo`;
  }
  if (bMin > 0 && bMax > 0 && bMin === bMax) {
    return `${bMax.toLocaleString()} ETB/mo`;
  }
  if (bMax > 0) {
    return bMin > 0 ? `${bMax.toLocaleString()} ETB/mo` : `Up to ${bMax.toLocaleString()} ETB/mo`;
  }
  if (bMin > 0) {
    return `From ${bMin.toLocaleString()} ETB/mo`;
  }
  return fallback;
}

export function parseBudgetRangeInput(
  raw?: string | null,
  options?: { minLimit?: number; maxLimit?: number }
): { min: number; max: number; isExplicitRange: boolean } | null {
  if (!raw) return null;
  let text = String(raw).trim().toLowerCase();

  // Normalize Amharic thousands notation: ሺ or ሺህ -> k
  text = text.replace(/(\d+(?:\.\d+)?)\s*(?:ሺህ|ሺ)/g, '$1k');
  // Normalize Ethiopian Birr symbol 'ብር' -> 'birr'
  text = text.replace(/ብር/g, 'birr');

  // Reject negative numbers upfront (e.g. "-500", "-8k to 15k", "-8k - 15k", "8000 - -15000")
  const dashes = text.match(/[\-–—−]/g);
  if (dashes) {
    if (dashes.length > 1) return null;
    if (/^\s*[\-–—−]/.test(text)) return null;
    if (/(?:to|and|between|እስከ)\s*[\-–—−]/.test(text)) return null;
    if (!text.match(/\d+[\d,\.]*\s*k?\s*[\-–—−]\s*\d+[\d,\.]*\s*k?/)) {
      return null;
    }
  }

  // Strip common words and currency units
  const cleaned = text
    .replace(/(?:etb|birr|br|usd|\$|€|£|\/mo|\/month|monthly|budget|rent|about|around|approx|min|max|ከ|:)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const minLimit = options?.minLimit ?? 500;
  const maxLimit = options?.maxLimit ?? 1000000;

  // 1. Detect explicit range separators ("8000 - 15000", "8k to 15k", "between 8000 and 15000", "5000 እስከ 12000")
  const rangeMatch = cleaned.match(
    /(?:between\s+)?([\d,\.]+\s*(?:\s\d{3})*\s*k?)\s*(?:-|–|—|~|\/|to|and|እስከ)\s*([\d,\.]+\s*(?:\s\d{3})*\s*k?)/i
  );

  if (rangeMatch) {
    const p1 = parseNumericInput(rangeMatch[1]);
    const p2 = parseNumericInput(rangeMatch[2]);
    if (p1 !== null && p2 !== null && p1 > 0 && p2 > 0) {
      const lower = Math.min(p1, p2);
      const upper = Math.max(p1, p2);
      if (lower >= minLimit && upper <= maxLimit) {
        return {
          min: lower,
          max: upper,
          isExplicitRange: true,
        };
      }
    }
  }

  // 1b. Detect two whitespace-separated amounts ("5000 12000", "5k 12k") while ignoring space-grouped thousands like "8 000"
  const spacePairMatch = cleaned.match(/^([\d,\.]+\s*k?)\s+([\d,\.]+\s*k?)$/i);
  if (spacePairMatch) {
    const p1 = parseNumericInput(spacePairMatch[1]);
    const p2 = parseNumericInput(spacePairMatch[2]);
    if (p1 !== null && p2 !== null && p1 >= minLimit && p2 >= minLimit && p1 <= maxLimit && p2 <= maxLimit) {
      return {
        min: Math.min(p1, p2),
        max: Math.max(p1, p2),
        isExplicitRange: true,
      };
    }
  }

  // 2. Fallback: single number provided
  const single = parseNumericInput(cleaned);
  if (single !== null && single >= minLimit && single <= maxLimit) {
    return {
      min: Math.max(0, Math.round(single * 0.7)),
      max: single,
      isExplicitRange: false,
    };
  }

  return null;
}

/**
 * Get Telegram file metadata by fileId, then download the raw bytes.
 * Returns a Buffer containing the file's content.
 */
export async function getFile(fileId: string): Promise<Buffer> {
  if (process.env.MOCK_TELEGRAM_API === 'true') {
    return Buffer.from('mock_file_content');
  }
  // Step 1: resolve the file path
  const metaRes = await callTelegram<{ file_path: string }>('getFile', {
    file_id: fileId,
  });

  if (!metaRes.ok || !metaRes.result?.file_path) {
    throw new Error(
      `getFile: could not resolve file_id "${fileId}": ${metaRes.description}`
    );
  }

  const filePath = metaRes.result.file_path;
  const downloadUrl = `https://api.telegram.org/file/bot${BOT_TOKEN()}/${filePath}`;

  // Step 2: download the raw bytes
  const fileRes = await fetch(downloadUrl, {
    signal: AbortSignal.timeout(10000),
  });
  if (!fileRes.ok) {
    throw new Error(
      `getFile: download failed with HTTP ${fileRes.status} for path "${filePath}"`
    );
  }

  const arrayBuffer = await fileRes.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ─── Post Formatting & Hashtags ───────────────────────────────────────────────

/**
 * Safely extracts user-entered bio or descriptions, stripping internal metadata prefixes.
 */
export function extractUserDescription(rawText?: string | null): string {
  if (!rawText) return '';
  let cleaned = String(rawText).trim();

  // If separated by pipes: Job: ... | Religion: ... | Prefers: ... | <user_description>
  if (cleaned.includes(' | ')) {
    const parts = cleaned.split(' | ');
    const nonMetaParts = parts.filter(
      (p) => !/^(Job|Religion|Prefers?|Age|Budget|Sex|Gender)[:\s]/i.test(p.trim())
    );
    if (nonMetaParts.length > 0) {
      cleaned = nonMetaParts.join(' | ').trim();
    } else {
      cleaned = parts[parts.length - 1].trim();
    }
  }

  // Remove any remaining leading metadata prefix
  cleaned = cleaned.replace(/^(Job|Religion|Prefers?|Age|Budget|Sex|Gender)[:\s]+[^|;\n]+(\||\n|$)/i, '').trim();

  return cleaned;
}

/**
 * Safely truncates an HTML string to at most `maxLen` characters (default 1024),
 * ensuring that no HTML tag or entity is sliced in half and that all opened HTML tags
 * (<b>, <i>, <code>, <blockquote>, <a>) are properly closed in reverse order.
 */
export function truncateTelegramHtml(html: string, maxLen: number = 1024): string {
  if (!html || html.length <= maxLen) return html;

  let truncated = '';
  let inTag = false;
  let tagBuffer = '';
  const openTags: string[] = [];

  const closingTagsLength = () =>
    openTags.reduce((sum, tag) => sum + tag.length + 3, 0);

  let i = 0;
  while (i < html.length) {
    const char = html[i];
    const reserve = 2 + closingTagsLength(); // '…' + all currently open closing tags

    if (char === '<') {
      const closeBracket = html.indexOf('>', i);
      if (closeBracket === -1) break;
      const fullTag = html.slice(i, closeBracket + 1);
      const matchClosing = fullTag.match(/^<\/([a-zA-Z0-9]+)>/);
      const matchOpening = fullTag.match(/^<([a-zA-Z0-9]+)(?:\s[^>]*)?>/);
      let extraClosing = 0;
      if (!matchClosing && matchOpening) {
        const t = matchOpening[1].toLowerCase();
        if (!['br', 'hr', 'img'].includes(t)) extraClosing = t.length + 3;
      }
      if (truncated.length + fullTag.length + reserve + extraClosing > maxLen) {
        break;
      }
      inTag = true;
      tagBuffer = '';
      if (matchClosing) {
        const tagName = matchClosing[1].toLowerCase();
        const lastIdx = openTags.lastIndexOf(tagName);
        if (lastIdx !== -1) openTags.splice(lastIdx, 1);
      } else if (matchOpening) {
        const tagName = matchOpening[1].toLowerCase();
        if (!['br', 'hr', 'img'].includes(tagName)) openTags.push(tagName);
      }
      truncated += fullTag;
      inTag = false;
      i = closeBracket + 1;
      continue;
    }

    if (char === '&') {
      const semi = html.indexOf(';', i);
      if (semi !== -1 && semi - i <= 10 && /^&[a-zA-Z0-9#]+;$/.test(html.slice(i, semi + 1))) {
        const entity = html.slice(i, semi + 1);
        if (truncated.length + entity.length + reserve > maxLen) break;
        truncated += entity;
        i = semi + 1;
        continue;
      }
    }

    if (truncated.length + 1 + reserve > maxLen) {
      break;
    }

    truncated += char;
    i++;
  }

  if (inTag) {
    tagBuffer = '';
  }

  truncated = truncated.trimEnd() + '…';

  while (openTags.length > 0) {
    const tag = openTags.pop();
    truncated += `</${tag}>`;
  }

  return truncated;
}

/**
 * Interface representing sanitized contact details for match dossiers.
 */
export interface SanitizedContact {
  fullName: string;
  phoneNumber: string;
  telegramUsername: string; // clean username without '@'
  telegramUrl?: string; // https://t.me/... or undefined
  isConciergeOrSynthetic: boolean;
}

/**
 * Contact Dossier Sanitization Helper (Invariants Rule 3):
 * - Never leaks raw admin IDs, concierge placeholders (e.g. admin:123456, admin_123456), or invalid handles.
 * - Validates Telegram handles against RFC rules (^[a-zA-Z0-9_]{5,32}$).
 * - For synthetic, concierge, or admin listings, automatically routes contact details to @WWEHID.
 */
export function sanitizeContactDossier(input: {
  fullName?: string | null;
  phoneNumber?: string | null;
  telegramUsername?: string | null;
  telegramId?: number | string | null;
  isConcierge?: boolean | null;
}): SanitizedContact {
  const tgIdNum = Number(input.telegramId);
  const isSynthetic = !isNaN(tgIdNum) && tgIdNum < 0;
  const rawName = (input.fullName || '').trim();
  const rawPhone = (input.phoneNumber || '').trim();
  const rawUsername = (input.telegramUsername || '').replace(/^@/, '').trim();

  const isConciergeOrSynthetic =
    Boolean(input.isConcierge) ||
    isSynthetic ||
    /^(admin[:_]|concierge)/i.test(rawUsername) ||
    /concierge/i.test(rawName) ||
    /concierge/i.test(rawPhone) ||
    rawPhone.toLowerCase().includes('spacematch');

  if (isConciergeOrSynthetic) {
    return {
      fullName: 'SpaceMatch Coordinator / ስፔስማች አስተባባሪ (@WWEHID)',
      phoneNumber: 'Via SpaceMatch Coordinator (@WWEHID)',
      telegramUsername: 'WWEHID',
      telegramUrl: 'https://t.me/WWEHID',
      isConciergeOrSynthetic: true,
    };
  }

  const isValidTgHandle = /^[a-zA-Z0-9_]{5,32}$/.test(rawUsername);
  const cleanUsername = isValidTgHandle ? rawUsername : '';
  const telegramUrl = cleanUsername ? `https://t.me/${cleanUsername}` : undefined;

  const cleanName = rawName || 'Verified Resident / የተረጋገጠ አባል';
  const cleanPhone = rawPhone && rawPhone !== 'N/A' && rawPhone !== 'Not provided'
    ? rawPhone
    : 'Provided on Telegram';

  return {
    fullName: cleanName,
    phoneNumber: cleanPhone,
    telegramUsername: cleanUsername,
    telegramUrl,
    isConciergeOrSynthetic: false,
  };
}

/**
 * Standard mapping of Amharic subcity & neighborhood names to clean Latin names for hashtags.
 */
const SUBCITY_AMHARIC_MAP: Record<string, string> = {
  'ሜክሲኮ': 'Mexico',
  'ቦሌ': 'Bole',
  'ካዛንቺስ': 'Kazanchis',
  'ሳርቤት': 'Sarbet',
  'መገናኛ': 'Megenagna',
  'ፒያሳ': 'Piassa',
  'ሲኤምሲ': 'CMC',
  'ገርጂ': 'Gerji',
  'አራት ኪሎ': '4Kilo',
  '4 ኪሎ': '4Kilo',
  'አራዳ': 'Arada',
  'ቂርቆስ': 'Kirkos',
  'ጉለሌ': 'Gullele',
  'ልደታ': 'Lideta',
  'ኮልፌ': 'Kolfe',
  'አቃቂ': 'Akaki',
  'ንፋስ ስልክ': 'NifasSilk',
  'አዲስ አበባ': 'AddisAbaba',
};

/**
 * Generates automated Telegram channel search hashtags matching the benchmark pattern:
 * e.g. #Mexico #LookingForRoom #FemaleRoommate #5k_10k
 * or   #Bole #RoomAvailable #AnyGender #10k_15k
 */
export function generatePostHashtags(options: {
  locations?: string[] | string | null;
  isSpace?: boolean;
  preferredGender?: string | null;
  gender?: string | null;
  budgetMin?: number | null;
  budgetMax?: number | null;
  pricePerMonth?: number | null;
}): string {
  // 1. Location hashtag (#Mexico, #Bole, etc.)
  let rawLoc = '';
  if (Array.isArray(options.locations) && options.locations.length > 0) {
    rawLoc = options.locations[0];
  } else if (typeof options.locations === 'string' && options.locations.trim()) {
    rawLoc = options.locations.split(',')[0];
  }
  rawLoc = (rawLoc || '').trim();

  let cleanLoc = '';
  if (rawLoc.includes('/')) {
    cleanLoc = rawLoc.split('/')[0].trim().replace(/[^a-zA-Z0-9]/g, '');
  }

  if (!cleanLoc) {
    for (const [amh, eng] of Object.entries(SUBCITY_AMHARIC_MAP)) {
      if (rawLoc.includes(amh)) {
        cleanLoc = eng;
        break;
      }
    }
  }

  if (!cleanLoc) {
    cleanLoc = rawLoc.replace(/[^a-zA-Z0-9]/g, '');
  }

  if (!cleanLoc) cleanLoc = 'AddisAbaba';
  const locTag = `#${cleanLoc}`;

  // 2. Listing category hashtag
  const typeTag = options.isSpace ? '#RoomAvailable' : '#LookingForRoom';

  // 3. Gender hashtag
  const pref = (options.preferredGender || '').toLowerCase();
  const gen = (options.gender || '').toLowerCase();
  let genderTag = '#AnyGender';

  if (options.isSpace) {
    if (pref.includes('any') || pref.includes('ማንኛውም') || pref.includes('both') || pref.includes('all')) {
      genderTag = '#AnyGender';
    } else if (pref.includes('female') || pref.includes('ሴት')) {
      genderTag = '#FemaleRoommate';
    } else if (pref.includes('male') || pref.includes('ወንድ')) {
      genderTag = '#MaleRoommate';
    } else if (gen.includes('female') || gen.includes('ሴት')) {
      genderTag = '#FemaleRoommate';
    } else if (gen.includes('male') || gen.includes('ወንድ')) {
      genderTag = '#MaleRoommate';
    } else {
      genderTag = '#AnyGender';
    }
  } else {
    if (pref.includes('any') || pref.includes('ማንኛውም') || pref.includes('both') || pref.includes('all')) {
      if (gen.includes('female') || gen.includes('ሴት')) {
        genderTag = '#FemaleRoommate';
      } else if (gen.includes('male') || gen.includes('ወንድ')) {
        genderTag = '#MaleRoommate';
      } else {
        genderTag = '#AnyGender';
      }
    } else if (pref.includes('female') || pref.includes('ሴት')) {
      genderTag = '#FemaleRoommate';
    } else if (pref.includes('male') || pref.includes('ወንድ')) {
      genderTag = '#MaleRoommate';
    } else if (gen.includes('female') || gen.includes('ሴት')) {
      genderTag = '#FemaleRoommate';
    } else if (gen.includes('male') || gen.includes('ወንድ')) {
      genderTag = '#MaleRoommate';
    } else {
      genderTag = '#AnyGender';
    }
  }

  // 4. Budget hashtag
  const min = options.budgetMin ? Math.round(Number(options.budgetMin)) : 0;
  const max = (options.budgetMax ? Math.round(Number(options.budgetMax)) : 0) || (options.pricePerMonth ? Math.round(Number(options.pricePerMonth)) : 0);

  const formatK = (val: number): string => {
    if (val >= 1000) {
      const k = val / 1000;
      return Number.isInteger(k) ? `${k}k` : `${k.toFixed(1)}k`;
    }
    return String(val);
  };

  let budgetTag = '';
  if (min > 0 && max > 0 && min < max) {
    budgetTag = `#${formatK(min)}_${formatK(max)}`;
  } else if (max > 0) {
    budgetTag = `#${formatK(max)}`;
  } else if (min > 0) {
    budgetTag = `#${formatK(min)}`;
  } else {
    budgetTag = '#Flexible';
  }

  return `${locTag} ${typeTag} ${genderTag} ${budgetTag}`;
}

/**
 * Formats a Roommate Seeker listing matching the benchmark layout:
 * - Header: LOOKING FOR A ROOM · ID #DISPLAY_CODE, Location, Budget & Move in
 * - Structured Sections: WHAT I'M LOOKING FOR, ROOMMATE PREFERENCES, DETAILS <blockquote>, ABOUT ME <blockquote>
 * - Brand slogan and automated channel hashtags
 */
export function formatRoommatePost(profile: Profile | Record<string, any>): string {
  const p = profile as any;
  const rawCode = (p.display_code || p.id || 'SPMARBR5').replace(/^#/, '');
  const cleanCode = escapeHtml(rawCode);

  const rawLocs = p.locations || p.preferred_subcity;
  const locList = Array.isArray(rawLocs)
    ? rawLocs
    : typeof rawLocs === 'string' && rawLocs.trim()
    ? rawLocs.split(',').map((s: string) => s.trim()).filter(Boolean)
    : [];
  const locationDisplay = locList.length > 0 ? locList.join(', ') : 'Addis Ababa / አዲስ አበባ';

  const bMin = Number(p.budget_min || 0);
  const bMax = Number(p.budget_max || 0);
  let budgetDisplay = '';
  if (bMin > 0 && bMax > 0 && bMin < bMax) {
    budgetDisplay = `${bMin.toLocaleString()}–${bMax.toLocaleString()} ETB / month`;
  } else if (bMin > 0 && bMax > 0 && bMin === bMax) {
    budgetDisplay = `${bMax.toLocaleString()} ETB / month`;
  } else if (bMax > 0) {
    budgetDisplay = bMin > 0 ? `${bMax.toLocaleString()} ETB / month` : `Up to ${bMax.toLocaleString()} ETB / month`;
  } else if (bMin > 0) {
    budgetDisplay = `From ${bMin.toLocaleString()} ETB / month`;
  } else {
    budgetDisplay = 'Flexible / ተለዋዋጭ';
  }

  const rawMoveIn = p.move_in_date || p.move_in;
  const moveInDisplay = rawMoveIn ? String(rawMoveIn).trim() : 'Within 1 month / በ1 ወር ውስጥ';

  const rawSpaceType = p.space_type || p.room_type;
  const spaceTypeDisplay = rawSpaceType
    ? String(rawSpaceType).trim()
    : 'Private room · Apartment / የግል መኝታ ቤት · አፓርታማ';

  const rawGender = (p.gender || p.my_gender || '').toLowerCase();
  const isFemale = rawGender.includes('female') || rawGender.includes('ሴት') || rawGender === 'f';
  const isMale = rawGender.includes('male') || rawGender.includes('ወንድ') || rawGender === 'm';
  const sexDisplay = isFemale ? 'Female / ሴት' : isMale ? 'Male / ወንድ' : (p.gender || p.my_gender || 'Any / ማንኛውም');

  let userAge = p.age ? Number(p.age) : null;
  if (!userAge && p.roommate_traits) {
    const m = String(p.roommate_traits).match(/Age[:\s]+(\d+)/i);
    if (m) userAge = parseInt(m[1], 10);
  }
  const ageDisplay = userAge ? `, Age ${userAge}` : '';

  let rawPrefGender = (p.preferred_gender || '').toLowerCase();
  if ((!rawPrefGender || rawPrefGender === 'any') && (p.roommate_traits || p.lifestyle_bio)) {
    const pgm = String(p.roommate_traits || p.lifestyle_bio || '').match(/Prefers?[:\s]+(Male|Female|Any)/i);
    if (pgm) rawPrefGender = pgm[1].toLowerCase();
  }
  const isPrefFemale = rawPrefGender.includes('female') || rawPrefGender.includes('ሴት');
  const isPrefMale = rawPrefGender.includes('male') || rawPrefGender.includes('ወንድ');
  const prefSexDisplay = isPrefFemale ? 'Female Only (ሴት ብቻ)' : isPrefMale ? 'Male Only (ወንድ ብቻ)' : 'Any Gender (ማንኛውም ጾታ)';

  let prefAgeStr = '';
  const ageMatch = String(p.preferred_roommate || p.roommate_traits || '').match(/(?:age[:\s]+)?(\d{2}\s*[-–—]\s*\d{2})/i);
  if (ageMatch) {
    prefAgeStr = `, ${ageMatch[1]}`;
  }

  const rawHouseRules = p.house_rules;
  const houseRulesDisplay = rawHouseRules
    ? String(rawHouseRules).trim()
    : 'Clean, respectful, no smoking / ጽዱ፣ ጨዋ፣ ሲጋራ የማያጨስ';

  let rawDetails = p.details || p.description || '';
  let cleanDetails = extractUserDescription(rawDetails);
  if (!cleanDetails) {
    cleanDetails = `${locationDisplay} • ${prefSexDisplay}`;
  }
  if (cleanDetails.length > 350) {
    cleanDetails = cleanDetails.slice(0, 345).trimEnd() + '…';
  }

  let rawBio = p.roommate_traits || p.lifestyle_bio || p.bio || '';
  let cleanBio = extractUserDescription(rawBio);
  if (!cleanBio || cleanBio === cleanDetails) {
    // Strictly never leak p.full_name or p.user_name onto the public channel
    cleanBio = 'Seeking compatible roommate in Addis Ababa. / ተስማሚ የቤት ጓደኛ ፈላጊ።';
  }
  if (cleanBio.length > 300) {
    cleanBio = cleanBio.slice(0, 295).trimEnd() + '…';
  }

  const hashtags = generatePostHashtags({
    locations: locList,
    isSpace: false,
    preferredGender: rawPrefGender,
    gender: rawGender,
    budgetMin: bMin,
    budgetMax: bMax,
  });

  return `
<b>SpaceMatch Addis / ስፔስማች አዲስ</b> · <b>#${cleanCode}</b>
<b>LOOKING FOR A ROOM · ${escapeHtml(locationDisplay)}</b>
Budget: ${escapeHtml(budgetDisplay)} · Move in: ${escapeHtml(moveInDisplay)}

<b>WHAT I'M LOOKING FOR / የምፈልገው</b>
${escapeHtml(spaceTypeDisplay)}

<b>ROOMMATE PREFERENCES / የቤት አጋር ምርጫ</b>
Roommate: ${escapeHtml(prefSexDisplay)}${escapeHtml(prefAgeStr)}
House rules: ${escapeHtml(houseRulesDisplay)}

<b>DETAILS / ዝርዝር</b>
<blockquote>${escapeHtml(cleanDetails)}</blockquote>

<b>ABOUT ME / ስለ እኔ</b>
Posted by: ${escapeHtml(sexDisplay)}${escapeHtml(ageDisplay)}
<blockquote>${escapeHtml(cleanBio)}</blockquote>

SpaceMatch Addis — Find your roommate first, then find your space together! / መጀመሪያ የቤት አጋርዎን ያግኙ፣ በመቀጠል አብራችሁ ቤታችሁን ፈልጉ!

📢 To post your profile on the channel, contact admin: @WWEHID / መረጃዎን ቻናሉ ላይ ለመለጠፍ አድሚን @WWEHID ያነጋግሩ

${hashtags}
`.trim();
}

/**
 * Formats a Space Available listing matching the benchmark layout:
 * - Header: ROOM AVAILABLE · ID #DISPLAY_CODE, Location, Rent & Move in
 * - Structured Sections: SPACE DETAILS, ROOMMATE PREFERENCES, DETAILS <blockquote>, ABOUT ME <blockquote>
 * - Brand slogan and automated channel hashtags
 */
export function formatSpacePost(space: Record<string, any>): string {
  const rawCode = (space.display_code || space.id || 'SPMARWR1').replace(/^#/, '');
  const cleanCode = escapeHtml(rawCode);

  const rawLocs = space.preferred_subcity || space.locations || space.neighborhood || space.location;
  const locList = Array.isArray(rawLocs)
    ? rawLocs
    : typeof rawLocs === 'string' && rawLocs.trim()
    ? rawLocs.split(',').map((s: string) => s.trim()).filter(Boolean)
    : [];
  const locationDisplay = locList.length > 0 ? locList.join(', ') : 'Addis Ababa / አዲስ አበባ';

  const rentVal = Number(space.space_rent || space.price_per_month || space.budget_max || 0);
  const shareVal = Number(space.space_share || 0);
  let rentDisplay = '';
  if (rentVal > 0 && shareVal > 0) {
    rentDisplay = `${rentVal.toLocaleString()} ETB / month (${shareVal.toLocaleString()} ETB split)`;
  } else if (rentVal > 0) {
    rentDisplay = `${rentVal.toLocaleString()} ETB / month`;
  } else if (shareVal > 0) {
    rentDisplay = `${shareVal.toLocaleString()} ETB split / month`;
  } else {
    rentDisplay = 'Negotiable / በስምምነት';
  }

  const rawMoveIn = space.move_in_date || space.move_in;
  const moveInDisplay = rawMoveIn ? String(rawMoveIn).trim() : 'Immediate / አፋጣኝ';

  const rawSpaceType = space.space_type;
  const spaceTypeDisplay = rawSpaceType
    ? String(rawSpaceType).trim()
    : 'Private room · Shared Flat / የግል መኝታ ቤት · የጋራ አፓርታማ';

  const rawAmenities = space.space_amenities || space.amenities;
  let amenitiesDisplay = 'WiFi, Kitchen, Water supply / ዋይፋይ፣ ወጥ ቤት፣ ውሃ';
  if (Array.isArray(rawAmenities) && rawAmenities.length > 0) {
    amenitiesDisplay = rawAmenities.join(', ');
  } else if (typeof rawAmenities === 'string' && rawAmenities.trim()) {
    amenitiesDisplay = rawAmenities.trim();
  }

  const rawHostGender = (space.owner_gender || space.gender || space.my_gender || '').toLowerCase();
  const isHostFemale = rawHostGender.includes('female') || rawHostGender.includes('ሴት') || rawHostGender === 'f';
  const isHostMale = rawHostGender.includes('male') || rawHostGender.includes('ወንድ') || rawHostGender === 'm';
  const hostSexDisplay = isHostFemale ? 'Female / ሴት' : isHostMale ? 'Male / ወንድ' : 'Space Host / አከራይ';

  let rawPrefGender = (space.preferred_tenant_gender || space.preferred_gender || '').toLowerCase();
  if ((!rawPrefGender || rawPrefGender === 'any') && (space.roommate_traits || space.lifestyle_bio)) {
    const pgm = String(space.roommate_traits || space.lifestyle_bio || '').match(/Prefers?[:\s]+(Male|Female|Any)/i);
    if (pgm) rawPrefGender = pgm[1].toLowerCase();
  }
  const isPrefFemale = rawPrefGender.includes('female') || rawPrefGender.includes('ሴት');
  const isPrefMale = rawPrefGender.includes('male') || rawPrefGender.includes('ወንድ');
  const prefSexDisplay = isPrefFemale ? 'Female Only (ሴት ብቻ)' : isPrefMale ? 'Male Only (ወንድ ብቻ)' : 'Any Gender (ማንኛውም ጾታ)';

  const rawHouseRules = space.house_rules;
  const houseRulesDisplay = rawHouseRules
    ? String(rawHouseRules).trim()
    : 'Clean, respectful, quiet hours / ጽዱ፣ ጨዋ፣ የጋራ ሰላም የሚጠብቅ';

  let rawDetails = space.details || space.description || '';
  let detailsText = extractUserDescription(rawDetails);
  if (!detailsText) {
    detailsText = `${spaceTypeDisplay} in ${locationDisplay}. Amenities: ${amenitiesDisplay}.`;
  }
  if (detailsText.length > 350) {
    detailsText = detailsText.slice(0, 345).trimEnd() + '…';
  }

  let rawBio = space.lifestyle_bio || space.roommate_traits || space.bio || space.preferred_roommate || '';
  let cleanBio = extractUserDescription(rawBio);
  if (!cleanBio || cleanBio === detailsText) {
    cleanBio = 'Verified Space Host offering a comfortable, respectful home. / ምቹ እና የተረጋጋ የመኖሪያ ቦታ የሚያጋራ የተረጋገጠ አከራይ።';
  }
  if (cleanBio.length > 300) {
    cleanBio = cleanBio.slice(0, 295).trimEnd() + '…';
  }

  const hashtags = generatePostHashtags({
    locations: locList,
    isSpace: true,
    preferredGender: rawPrefGender,
    gender: rawHostGender,
    budgetMin: shareVal > 0 ? shareVal : null,
    budgetMax: rentVal > 0 ? rentVal : null,
    pricePerMonth: rentVal,
  });

  const renderSpaceHtml = (
    det: string,
    bio: string,
    amen: string = amenitiesDisplay,
    rules: string = houseRulesDisplay,
    slogan: string = 'SpaceMatch Addis — Find your roommate first, then find your space together! / መጀመሪያ የቤት አጋርዎን ያግኙ፣ በመቀጠል አብራችሁ ቤታችሁን ፈልጉ!'
  ): string => `
<b>SpaceMatch Addis / ስፔስማች አዲስ</b> · <b>#${cleanCode}</b>
<b>ROOM AVAILABLE · ${escapeHtml(locationDisplay)}</b>
Rent: ${escapeHtml(rentDisplay)} · Move in: ${escapeHtml(moveInDisplay)}

<b>SPACE DETAILS / የቤቱ ዝርዝር</b>
${escapeHtml(spaceTypeDisplay)}
Amenities: ${escapeHtml(amen)}

<b>ROOMMATE PREFERENCES / የቤት አጋር ምርጫ</b>
Roommate: ${escapeHtml(prefSexDisplay)}
House rules: ${escapeHtml(rules)}

<b>DETAILS / ዝርዝር</b>
<blockquote>${escapeHtml(det)}</blockquote>

<b>ABOUT ME / ስለ እኔ</b>
Posted by: ${escapeHtml(hostSexDisplay)} (Space Host / አከራይ)
<blockquote>${escapeHtml(bio)}</blockquote>

${slogan}

📢 To post your profile on the channel, contact admin: @WWEHID / መረጃዎን ቻናሉ ላይ ለመለጠፍ አድሚን @WWEHID ያነጋግሩ

${hashtags}
`.trim();

  // Keep under Telegram's 1024-char photo caption limit while preserving @WWEHID footer, ABOUT ME excerpt & hashtags (Decision 3)
  let out = renderSpaceHtml(detailsText, cleanBio);
  if (out.length > 1000) {
    const compactAmen = amenitiesDisplay.length > 60 ? amenitiesDisplay.slice(0, 57).trimEnd() + '…' : amenitiesDisplay;
    const compactRules = houseRulesDisplay.length > 60 ? houseRulesDisplay.slice(0, 57).trimEnd() + '…' : houseRulesDisplay;
    const compactSlogan = 'SpaceMatch Addis — Verified Roommate Network';
    const baseTemplate = renderSpaceHtml('', '', compactAmen, compactRules, compactSlogan);
    const budget = Math.max(80, 990 - baseTemplate.length);
    const detCap = Math.max(40, Math.floor(budget * 0.55));
    const bioCap = Math.max(40, budget - detCap);
    const compactDet = detailsText.length > detCap ? detailsText.slice(0, detCap - 1).trimEnd() + '…' : detailsText;
    const compactBio = cleanBio.length > bioCap ? cleanBio.slice(0, bioCap - 1).trimEnd() + '…' : cleanBio;
    out = renderSpaceHtml(compactDet, compactBio, compactAmen, compactRules, compactSlogan);
  }
  return out;
}

// ─── Channel Publishing ───────────────────────────────────────────────────────

/**
 * Formats and publishes an anonymised roommate-seeker listing card to the
 * public Telegram channel.  Returns the channel message_id so it can be saved
 * in profiles.channel_message_id.
 */
export async function publishListingToChannel(profile: Profile): Promise<number> {
  const botUsername = BOT_USERNAME();
  const channelId = CHANNEL_ID();
  const cleanCode = (profile.display_code || 'SPMARBR5').replace(/^#/, '');

  const cardText = formatRoommatePost(profile);

  const replyMarkup: InlineKeyboard = {
    inline_keyboard: [
      [
        {
          text: 'Connect with this roommate / ከዚህ አጋር ጋር ተገናኝ >',
          url: `https://t.me/${botUsername}?start=req_${cleanCode}`,
        },
      ],
      [
        {
          text: 'Search Roommate for Me / የቤት አጋር ፈልግልኝ >',
          url: `https://t.me/${botUsername}?start=search_roommate`,
        },
      ],
    ],
  };

  const res = await callTelegram<{ message_id: number }>('sendMessage', {
    chat_id: channelId,
    text: cardText,
    parse_mode: 'HTML',
    reply_markup: replyMarkup,
  });

  if (!res.ok || !res.result?.message_id) {
    throw new Error(
      `publishListingToChannel: Telegram API error — ${res.description ?? 'unknown'}`
    );
  }

  return res.result.message_id;
}

/**
 * Edits the existing channel post to prepend "_____CLOSED_____" at the top,
 * preserves the listing details underneath, and swaps buttons to match/post links.
 */
export async function updateChannelPostAsMatched(
  channelMessageId: number,
  displayCode: string,
  existingContent?: string,
  targetChannelId?: string | number
): Promise<boolean> {
  const channelId = targetChannelId || CHANNEL_ID();
  const rawBotUsername = BOT_USERNAME();
  const botUsername = rawBotUsername.replace(/^@/, '');

  let baseContent = existingContent?.trim() || '';

  // If no existing content provided, attempt to retrieve listing from DB
  const safeCodeForFilter = displayCode.replace(/[,()*%\\]/g, '').trim();
  if (!baseContent) {
    try {
      let p: any = null;
      const { data: pFromProfiles } = await supabaseAdmin
        .from('profiles')
        .select('*')
        .or(`display_code.ilike.${safeCodeForFilter},channel_message_id.eq.${channelMessageId}`)
        .limit(1)
        .maybeSingle();

      if (pFromProfiles) {
        p = pFromProfiles;
      } else {
        const { data: pFromRoommates } = await supabaseAdmin
          .from('roommate_profiles')
          .select('*')
          .eq('channel_message_id', channelMessageId)
          .limit(1)
          .maybeSingle();
        if (pFromRoommates) {
          p = {
            display_code: displayCode,
            gender: pFromRoommates.my_gender,
            locations: pFromRoommates.preferred_subcity,
            budget_max: pFromRoommates.budget_max,
            roommate_traits: pFromRoommates.lifestyle_bio,
          };
        }
      }

      if (p) {
        const hasSpace = p.listing_category === 'space_available' || (p.space_rent && Number(p.space_rent) > 0);
        baseContent = hasSpace ? formatSpacePost(p) : formatRoommatePost(p);
      }
    } catch (err) {
      console.error('Error fetching profile for closed post formatting:', err);
    }
  }

  const closedHeader = `━━━━━━━━━━━━━━━━━━━━━━\n       <b>CLOSED / የተዘጋ</b>\nThis listing is officially closed &amp; matched! / ይህ ማስታወቂያ ተዘግቷል!\n━━━━━━━━━━━━━━━━━━━━━━`;

  const closedRaw = baseContent
    ? `${closedHeader}\n\n${baseContent}\n\nListing closed. Browse active verified roommates below: / ማስታወቂያው ተዘግቷል። ሌሎች ክፍት የሆኑ የተረጋገጡ የቤት አጋሮችን ከታች ይመልከቱ:`
    : `${closedHeader}\n\n<b>Roommate #${escapeHtml(displayCode)} has found a match / የቤት አጋር ተገኝቷል</b>\n\n<blockquote>This listing is officially closed. No further connection requests are accepted. / ይህ ማስታወቂያ ተዘግቷል። ተጨማሪ ጥያቄዎች አይቀበሉም።</blockquote>`;

  const closedText = truncateTelegramHtml(closedRaw, 4096);
  const safeCaption = truncateTelegramHtml(closedRaw, 1024);

  const closedMarkup: InlineKeyboard = {
    inline_keyboard: [
      [
        {
          text: 'Search Roommates / የቤት አጋር ፈልግ >',
          url: `https://t.me/${botUsername}?start=search_roommate`,
        },
      ],
    ],
  };

  try {
    let editOk = false;
    const res = await callTelegram('editMessageText', {
      chat_id: channelId,
      message_id: channelMessageId,
      text: closedText,
      parse_mode: 'HTML',
      reply_markup: closedMarkup,
    });
    editOk = Boolean(res.ok || (res.description && res.description.includes('message is not modified')));

    if (!editOk) {
      const capRes = await callTelegram('editMessageCaption', {
        chat_id: channelId,
        message_id: channelMessageId,
        caption: safeCaption,
        parse_mode: 'HTML',
        reply_markup: closedMarkup,
      });
      editOk = Boolean(capRes.ok || (capRes.description && capRes.description.includes('message is not modified')));
    }

    // Also update profiles, roommate_profiles, and pending_roommate_drafts with valid enum statuses
    try {
      await supabaseAdmin
        .from('profiles')
        .update({ status: 'matched' })
        .or(`display_code.ilike.${safeCodeForFilter},channel_message_id.eq.${channelMessageId}`);
      await supabaseAdmin
        .from('roommate_profiles')
        .update({ status: 'archived', updated_at: new Date().toISOString() })
        .eq('channel_message_id', channelMessageId);
      await supabaseAdmin
        .from('pending_roommate_drafts')
        .update({ status: 'archived', updated_at: new Date().toISOString() })
        .ilike('id', safeCodeForFilter);
    } catch {}

    return editOk;
  } catch (err) {
    console.error('Failed to update channel post as matched:', err);
    return false;
  }
}
