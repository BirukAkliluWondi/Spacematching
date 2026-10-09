import { supabaseAdmin } from '@/lib/supabase-server';
import { getRoommateDraft, getDraft } from '@/lib/bot-session-store';

export interface BroadcastResult {
  success: boolean;
  message: string;
  telegramMessageId?: number;
}

/**
 * Broadcasts a verified Roommate Seeker profile (#ROOMMATE_SEEKER) to a public Telegram Channel.
 */
export async function broadcastRoommateProfileToChannel(
  profileId: string,
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
    let profile: any = null;

    const { data: dbProfile } = await supabaseAdmin
      .from('roommate_profiles')
      .select('*, users!inner(*)')
      .eq('id', profileId)
      .single();

    if (dbProfile) {
      profile = {
        id: dbProfile.id,
        user_name: dbProfile.users?.first_name || 'Seeker',
        preferred_subcity: dbProfile.preferred_subcity || [],
        my_gender: dbProfile.my_gender,
        preferred_gender: dbProfile.preferred_gender,
        budget_max: dbProfile.budget_max,
        lifestyle_bio: dbProfile.lifestyle_bio,
        unlock_fee: dbProfile.unlock_fee || 50,
        fayda_status: dbProfile.users?.fayda_status || 'verified',
      };
    } else {
      const draft = getRoommateDraft(profileId);
      if (draft) {
        profile = draft;
      }
    }

    if (!profile) {
      return {
        success: false,
        message: `Failed to find roommate profile with ID '${profileId}'.`,
      };
    }

    const subcitiesStr = Array.isArray(profile.preferred_subcity) && profile.preferred_subcity.length > 0
      ? profile.preferred_subcity.join(', ')
      : 'Addis Ababa';

    const faydaBadge = profile.fayda_status === 'verified' || profile.fayda_status === 'pending'
      ? 'VERIFIED ✅ 🛡️'
      : 'UNVERIFIED ⚠️';

    const text = `
👥 <b>#ROOMMATE_SEEKER</b> | 📍 <b>${subcitiesStr}</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 <b>Seeker Gender:</b> ${profile.my_gender}
👥 <b>Preferred Roommate:</b> ${profile.preferred_gender}
💰 <b>Budget Cap:</b> Up to ${Number(profile.budget_max).toLocaleString()} ETB / month

📝 <b>Bio & Lifestyle:</b>
<i>"${profile.lifestyle_bio || 'Seeking a compatible roommate in Addis Ababa.'}"</i>

🛡️ <b>Fayda National ID:</b> ${faydaBadge}
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>To connect with this verified seeker, click "💬 Unlock Contact" below!</i>
    `.trim();

    const inlineKeyboard = {
      inline_keyboard: [
        [
          {
            text: `💬 Unlock Contact Info (${profile.unlock_fee || 50} ETB)`,
            url: `https://t.me/${botUsername}?start=unlock_seeker_${profile.id}`,
          },
        ],
        [
          {
            text: '🏠 I Have a Space to Rent',
            url: `https://t.me/${botUsername}?start=property_type`,
          },
          {
            text: '🔍 I Need a Roommate',
            url: `https://t.me/${botUsername}?start=seeker_flow`,
          },
        ],
        [
          {
            text: '📱 View Profile in Mini App',
            url: `https://t.me/${botUsername}/${appName}?startapp=seeker_${profile.id}`,
          },
        ],
      ],
    };

    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: targetChannel,
        text,
        parse_mode: 'HTML',
        reply_markup: inlineKeyboard,
      }),
    });

    const data = await response.json();

    if (!data.ok) {
      return {
        success: false,
        message: `Telegram API error: ${data.description || 'Failed to post roommate profile.'}`,
      };
    }

    return {
      success: true,
      message: `Successfully broadcasted roommate profile for ${profile.user_name} to channel ${targetChannel}.`,
      telegramMessageId: data.result?.message_id,
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Exception broadcasting roommate profile: ${msg}`,
    };
  }
}

/**
 * Broadcasts a published homeowner space listing (#SPACE_FOR_RENT) to a public Telegram Channel.
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
    let space: any = null;
    let photoUrl = 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?auto=format&fit=crop&w=1200&q=80';

    const { data: dbSpace } = await supabaseAdmin
      .from('spaces')
      .select('*')
      .eq('id', listingId)
      .single();

    if (dbSpace) {
      space = dbSpace;
      const { data: images } = await supabaseAdmin
        .from('space_images')
        .select('image_path')
        .eq('space_id', listingId)
        .order('display_order', { ascending: true })
        .limit(1);

      if (images && images.length > 0) {
        photoUrl = images[0].image_path;
      }
    } else {
      const draft = getDraft(listingId);
      if (draft) {
        space = {
          id: draft.id,
          title: draft.title,
          neighborhood: draft.neighborhood,
          price_per_month: draft.price_per_month,
          unlock_fee: 50,
          description: draft.description,
        };
        if (draft.photo_url) photoUrl = draft.photo_url;
      }
    }

    if (!space) {
      return {
        success: false,
        message: `Failed to find space listing with ID '${listingId}'.`,
      };
    }

    const captionText = `
🏠 <b>#SPACE_FOR_RENT</b> | 📍 <b>${space.neighborhood || 'Addis Ababa'}</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>${space.title}</b>
💵 <b>Monthly Rent:</b> ${Number(space.price_per_month).toLocaleString()} ETB / month
🔓 <b>Unlock Fee:</b> ${space.unlock_fee || 50} ETB

📝 <b>Description:</b>
${space.description}

🛡️ <b>Host Verification:</b> VERIFIED ✅
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Click below to unlock host contact details or view in Mini App!</i>
    `.trim();

    const inlineKeyboard = {
      inline_keyboard: [
        [
          {
            text: `🔑 Unlock Host Contact (${space.unlock_fee || 50} ETB)`,
            url: `https://t.me/${botUsername}?start=order_${space.id}`,
          },
        ],
        [
          {
            text: '👥 I Need a Roommate',
            url: `https://t.me/${botUsername}?start=seeker_flow`,
          },
          {
            text: '🏠 List Another Space',
            url: `https://t.me/${botUsername}?start=property_type`,
          },
        ],
        [
          {
            text: '🔍 Open in Mini App',
            url: `https://t.me/${botUsername}/${appName}?startapp=listing_${space.id}`,
          },
        ],
      ],
    };

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
      message: `Successfully broadcasted space listing '${space.title}' to channel ${targetChannel}.`,
      telegramMessageId: data.result?.message_id,
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Exception during space broadcast: ${msg}`,
    };
  }
}

/**
 * Posts a custom message/photo directly to the Telegram channel with auto-attached buttons.
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

/**
 * Deletes a message from a Telegram channel.
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
