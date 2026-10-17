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

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Profile {
  id: string;
  telegram_id: number;
  display_code: string;
  gender?: string | null;
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
  web_app?: { url: string };
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
  if (!t) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  return t;
};

const CHANNEL_ID = () => {
  const c = process.env.TELEGRAM_CHANNEL_ID;
  if (!c) throw new Error('TELEGRAM_CHANNEL_ID is not set');
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
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN()}/${method}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
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
 * Get Telegram file metadata by fileId, then download the raw bytes.
 * Returns a Buffer containing the file's content.
 */
export async function getFile(fileId: string): Promise<Buffer> {
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
  const fileRes = await fetch(downloadUrl);
  if (!fileRes.ok) {
    throw new Error(
      `getFile: download failed with HTTP ${fileRes.status} for path "${filePath}"`
    );
  }

  const arrayBuffer = await fileRes.arrayBuffer();
  return Buffer.from(arrayBuffer);
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

  const locations =
    Array.isArray(profile.locations) && profile.locations.length > 0
      ? profile.locations.join(', ')
      : 'Addis Ababa';

  const budgetMin = Number(profile.budget_min || 0).toLocaleString();
  const budgetMax = Number(profile.budget_max || 0).toLocaleString();

  const moveIn = profile.move_in_date
    ? escapeHtml(profile.move_in_date)
    : 'Flexible';

  const traits = profile.roommate_traits
    ? escapeHtml(profile.roommate_traits)
    : 'Open to compatible housemates.';

  const cardText = `
🤝 <b>New Roommate Seeker #${escapeHtml(profile.display_code)}</b>
━━━━━━━━━━━━━━━━━━━
👤 <b>Gender:</b> ${escapeHtml(profile.gender || 'Not specified')}
📍 <b>Preferred Areas:</b> ${escapeHtml(locations)}
💰 <b>Budget Range:</b> ${budgetMin} – ${budgetMax} ETB/month
📅 <b>Move-in Date:</b> ${moveIn}
🏠 <b>About / Rules:</b> <i>${traits}</i>

🔒 <i>Contact details remain sealed until both match &amp; verify.</i>
`.trim();

  const replyMarkup: InlineKeyboard = {
    inline_keyboard: [
      [
        {
          text: `🤝 Connect with Roommate #${profile.display_code}`,
          url: `https://t.me/${botUsername}?start=req_${profile.display_code}`,
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
 * Edits the existing channel post to show "MATCHED & CLOSED" and removes
 * the inline connect button so no further requests can be made.
 */
export async function updateChannelPostAsMatched(
  channelMessageId: number,
  displayCode: string
): Promise<void> {
  const channelId = CHANNEL_ID();

  const closedText = `
🤝 <b>MATCHED &amp; CLOSED: Roommate #${escapeHtml(displayCode)} has found a match! 🎉</b>

✅ <i>This listing is no longer available. Stay tuned for new seekers!</i>
`.trim();

  await callTelegram('editMessageText', {
    chat_id: channelId,
    message_id: channelMessageId,
    text: closedText,
    parse_mode: 'HTML',
    // reply_markup omitted → removes all inline buttons
  });
}
