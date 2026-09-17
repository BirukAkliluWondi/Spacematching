import { supabaseAdmin } from '@/lib/supabase-server';

export interface BroadcastResult {
  success: boolean;
  message: string;
  telegramMessageId?: number;
}

/**
 * Broadcasts a published room listing to a public Telegram Channel with deep-linked buttons.
 *
 * Deep Links:
 * 1. Mini App: https://t.me/{BOT_USERNAME}/{APP_NAME}?startapp=listing_{id}
 * 2. Bot Checkout: https://t.me/{BOT_USERNAME}?start=order_{id}
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

    // 3. Construct Caption & Deep-Link Buttons
    const captionText = `
🏠 <b>NEW ROOM LISTING IN ADDIS ABABA</b>

<b>${space.title}</b>
📍 <b>Neighborhood:</b> ${space.neighborhood}
💵 <b>Monthly Rent:</b> ETB ${Number(space.price_per_month).toLocaleString()} / month
🔓 <b>Unlock Fee:</b> ETB ${space.unlock_fee}

📝 <b>Overview:</b>
${space.description}

<i>Tap a button below to explore photos in the Mini App or unlock host contact details directly in Bot Chat!</i>
    `.trim();

    const inlineKeyboard = {
      inline_keyboard: [
        [
          {
            text: `🛒 Order in Bot (ETB ${space.unlock_fee})`,
            url: `https://t.me/${botUsername}?start=order_${space.id}`,
          },
        ],
        [
          {
            text: '🔍 View in Mini App',
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
