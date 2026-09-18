import { supabaseAdmin } from '@/lib/supabase-server';

export interface BroadcastResult {
  success: boolean;
  message: string;
  telegramMessageId?: number;
}

/**
 * Broadcasts a published room listing to a public Telegram Channel with deep-linked buttons.
 */
export async function broadcastListingToChannel(
  listingId: string,
  channelId?: string
): Promise<BroadcastResult> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const rawBotUsername = process.env.NEXT_PUBLIC_BOT_USERNAME || 'Spacematchaddis_bot';
  const botUsername = rawBotUsername.replace('@', '');
  const appName = process.env.NEXT_PUBLIC_TELEGRAM_APP_NAME || 'roommatch';
  const targetChannel = channelId || process.env.TELEGRAM_CHANNEL_ID || '@roommatch_addis';

  if (!botToken) {
    return {
      success: false,
      message: 'TELEGRAM_BOT_TOKEN is missing from environment variables.',
    };
  }

  try {
    // 1. Fetch space details from Supabase
    const { data: space, error: spaceErr } = await supabaseAdmin
      .from('spaces')
      .select('*')
      .eq('id', listingId)
      .single();

    if (spaceErr || !space) {
      return {
        success: false,
        message: `Failed to find space listing with ID '${listingId}': ${spaceErr?.message || 'Not found'}`,
      };
    }

    // 2. Fetch cover image
    const { data: images } = await supabaseAdmin
      .from('space_images')
      .select('image_path')
      .eq('space_id', listingId)
      .order('display_order', { ascending: true })
      .limit(1);

    const photoUrl =
      images && images.length > 0
        ? images[0].image_path
        : 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?auto=format&fit=crop&w=1200&q=80';

    // 3. Construct Caption & Deep-Link Buttons in Amharic
    const captionText = `
🏠 <b>አዲስ የሚከራይ ክፍል በኣዲስ አበባ</b>

<b>${space.title}</b>
📍 <b>አካባቢ፡</b> ${space.neighborhood}
💵 <b>ወርሃዊ ኪራይ፡</b> ${Number(space.price_per_month).toLocaleString()} ብር / በወር
🔓 <b>የአገልግሎት ክፍያ፡</b> ${space.unlock_fee} ብር

📝 <b>መግለጫ፡</b>
${space.description}

<i>ፎቶዎችን በሚኒ አፕ ለማየት ወይም የስልክ ቁጥር በቦት ለመክፈት ከታች ያሉትን ቁልፎች ይጫኑ!</i>
    `.trim();

    const inlineKeyboard = {
      inline_keyboard: [
        [
          {
            text: '🏠 I Have a Space',
            url: `https://t.me/${botUsername}?start=property_type`,
          },
          {
            text: '🔍 I Need a Space',
            url: `https://t.me/${botUsername}?start=seeker_flow`,
          },
        ],
        [
          {
            text: `🛒 በቦት እዘዝ (${space.unlock_fee} ብር)`,
            url: `https://t.me/${botUsername}?start=order_${space.id}`,
          },
        ],
        [
          {
            text: '🔍 በሚኒ አፕ ተመልከት',
            url: `https://t.me/${botUsername}/${appName}?startapp=listing_${space.id}`,
          },
        ],
      ],
    };

    // 4. Send Photo to Telegram Channel
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: targetChannel,
        photo: photoUrl,
        caption: captionText,
        parse_mode: 'HTML',
        reply_markup: inlineKeyboard,
      }),
    });

    const data = await response.json();

    if (!data.ok) {
      return {
        success: false,
        message: `Telegram API error: ${data.description || 'Failed to post to channel.'}`,
      };
    }

    return {
      success: true,
      message: `Successfully broadcasted listing '${space.title}' to channel ${targetChannel}.`,
      telegramMessageId: data.result?.message_id,
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Exception during channel broadcast: ${msg}`,
    };
  }
}

/**
 * Deletes a post/message from a Telegram channel.
 */
export async function deleteChannelPost(
  messageId: number,
  channelId?: string
): Promise<{ success: boolean; message: string }> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const targetChannel = channelId || process.env.TELEGRAM_CHANNEL_ID || '@roommatch_addis';

  if (!botToken) {
    return { success: false, message: 'TELEGRAM_BOT_TOKEN is missing.' };
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: targetChannel,
        message_id: messageId,
      }),
    });

    const json = await res.json();
    if (!json.ok) {
      return {
        success: false,
        message: json.description || 'Failed to delete message from channel.',
      };
    }

    return {
      success: true,
      message: `Successfully deleted post #${messageId} from channel ${targetChannel}.`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Exception deleting channel post: ${msg}` };
  }
}

/**
 * Posts a custom message/photo directly to the Telegram channel with auto-attached Order buttons.
 */
export async function postCustomToChannel(
  text: string,
  photoUrl?: string,
  listingId?: string,
  channelId?: string
): Promise<BroadcastResult> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const rawBotUsername = process.env.NEXT_PUBLIC_BOT_USERNAME || 'Spacematchaddis_bot';
  const botUsername = rawBotUsername.replace('@', '');
  const appName = process.env.NEXT_PUBLIC_TELEGRAM_APP_NAME || 'roommatch';
  const targetChannel = channelId || process.env.TELEGRAM_CHANNEL_ID || '@roommatch_addis';

  if (!botToken) {
    return { success: false, message: 'TELEGRAM_BOT_TOKEN is missing.' };
  }

  const orderUrl = listingId
    ? `https://t.me/${botUsername}?start=order_${listingId}`
    : `https://t.me/${botUsername}?start=order`;

  const miniAppUrl = listingId
    ? `https://t.me/${botUsername}/${appName}?startapp=listing_${listingId}`
    : `https://t.me/${botUsername}/${appName}`;

  const inlineKeyboard = {
    inline_keyboard: [
      [
        { text: '🏠 I Have a Space', url: `https://t.me/${botUsername}?start=property_type` },
        { text: '🔍 I Need a Space', url: `https://t.me/${botUsername}?start=seeker_flow` },
      ],
      [
        { text: '🛒 በቦት እዘዝ (Order in Bot)', url: orderUrl },
      ],
      [
        { text: '🔍 በሚኒ አፕ ተመልከት (View in Mini App)', url: miniAppUrl },
      ],
    ],
  };

  try {
    let endpoint = 'sendMessage';
    let body: Record<string, any> = {
      chat_id: targetChannel,
      text,
      parse_mode: 'HTML',
      reply_markup: inlineKeyboard,
    };

    if (photoUrl && photoUrl.trim()) {
      endpoint = 'sendPhoto';
      body = {
        chat_id: targetChannel,
        photo: photoUrl.trim(),
        caption: text,
        parse_mode: 'HTML',
        reply_markup: inlineKeyboard,
      };
    }

    const res = await fetch(`https://api.telegram.org/bot${botToken}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    if (!data.ok) {
      return { success: false, message: data.description || 'Failed to post to channel.' };
    }

    return {
      success: true,
      message: `Successfully published custom post to channel ${targetChannel}.`,
      telegramMessageId: data.result?.message_id,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Exception publishing custom post: ${msg}` };
  }
}
