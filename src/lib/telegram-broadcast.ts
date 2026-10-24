import { supabaseAdmin } from '@/lib/supabase-server';
import { getRoommateDraft, getDraft, getAllRoommateDrafts, getManagedChannels } from '@/lib/bot-session-store';

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

  let targetChannel = channelId;
  if (!targetChannel) {
    try {
      const channels = await getManagedChannels();
      const active = channels.filter((c) => c.is_active);
      if (active.length > 0) {
        targetChannel = String(active[0].channel_username || active[0].channel_id);
      }
    } catch {}
  }
  if (!targetChannel) {
    targetChannel = process.env.TELEGRAM_CHANNEL_ID || '@roommate_addis';
  }

  if (!botToken) {
    return {
      success: false,
      message: 'TELEGRAM_BOT_TOKEN is missing from environment variables.',
    };
  }

  try {
    let profile: any = null;
    let dbProfile: any = null;

    const cleanCode = (profileId || '').trim().replace(/^#/, '');
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanCode);

    // 1. Try profiles table first (primary profiles table used across bot)
    let pFromProfiles: any = null;
    if (isUuid) {
      try {
        const { data } = await supabaseAdmin.from('profiles').select('*').eq('id', cleanCode).maybeSingle();
        if (data) pFromProfiles = data;
      } catch {}
    }

    if (!pFromProfiles) {
      try {
        const { data } = await supabaseAdmin.from('profiles').select('*').ilike('display_code', cleanCode).maybeSingle();
        if (data) pFromProfiles = data;
      } catch {}
    }

    if (!pFromProfiles && /^\d+$/.test(cleanCode)) {
      try {
        const { data } = await supabaseAdmin.from('profiles').select('*').eq('telegram_id', Number(cleanCode)).maybeSingle();
        if (data) pFromProfiles = data;
      } catch {}
    }

    if (pFromProfiles) {
      dbProfile = {
        id: pFromProfiles.id,
        display_code: pFromProfiles.display_code || cleanCode,
        user_telegram_id: pFromProfiles.telegram_id,
        my_gender: pFromProfiles.gender || 'Member',
        age: pFromProfiles.age,
        preferred_gender: 'Any',
        preferred_subcity: Array.isArray(pFromProfiles.locations) ? pFromProfiles.locations : [],
        budget_max: pFromProfiles.budget_max || 10000,
        lifestyle_bio: pFromProfiles.roommate_traits || 'Seeking compatible roommate in Addis Ababa.',
        listing_category: pFromProfiles.listing_category || 'seeker',
        space_type: pFromProfiles.space_type,
        space_rent: pFromProfiles.space_rent,
        space_share: pFromProfiles.space_share,
        space_amenities: pFromProfiles.space_amenities || [],
        space_photos: Array.isArray(pFromProfiles.space_photos) ? pFromProfiles.space_photos : [],
        unlock_fee: 50,
        users: {
          first_name: pFromProfiles.full_name || 'Seeker',
          fayda_status: pFromProfiles.kyc_status || 'verified',
        },
      };
    }

    // 2. Try roommate_profiles table
    if (!dbProfile) {
      if (isUuid) {
        try {
          const { data: pById } = await supabaseAdmin
            .from('roommate_profiles')
            .select('*, users(*)')
            .eq('id', cleanCode)
            .maybeSingle();
          if (pById) dbProfile = pById;
        } catch {}
      }

      if (!dbProfile) {
        try {
          const { data: pByCode } = await supabaseAdmin
            .from('roommate_profiles')
            .select('*, users(*)')
            .ilike('display_code', cleanCode)
            .maybeSingle();
          if (pByCode) dbProfile = pByCode;
        } catch {}
      }

      if (!dbProfile && /^\d+$/.test(cleanCode)) {
        try {
          const { data: pByTg } = await supabaseAdmin
            .from('roommate_profiles')
            .select('*, users(*)')
            .eq('user_telegram_id', Number(cleanCode))
            .maybeSingle();
          if (pByTg) dbProfile = pByTg;
        } catch {}
      }
    }

    if (dbProfile) {
      profile = {
        id: dbProfile.id,
        display_code: dbProfile.display_code || cleanCode,
        user_telegram_id: dbProfile.user_telegram_id,
        user_name: dbProfile.users?.first_name || 'Seeker',
        preferred_subcity: dbProfile.preferred_subcity || [],
        my_gender: dbProfile.my_gender || 'Member',
        age: dbProfile.age,
        preferred_gender: dbProfile.preferred_gender || 'Any',
        budget_max: dbProfile.budget_max || 10000,
        lifestyle_bio: dbProfile.lifestyle_bio || 'Seeking compatible roommate in Addis Ababa.',
        listing_category: dbProfile.listing_category || 'seeker',
        space_type: dbProfile.space_type,
        space_rent: dbProfile.space_rent,
        space_share: dbProfile.space_share,
        space_amenities: dbProfile.space_amenities || [],
        space_photos: Array.isArray(dbProfile.space_photos) ? dbProfile.space_photos : [],
        unlock_fee: dbProfile.unlock_fee || 50,
        fayda_status: dbProfile.users?.fayda_status || 'verified',
      };
    } else {
      // 3. Fallback to session drafts
      const draft = await getRoommateDraft(cleanCode);
      if (draft) {
        profile = draft;
      } else {
        const allDrafts = Object.values(await getAllRoommateDrafts());
        const matchDraft = allDrafts.find(
          (d: any) =>
            d.display_code?.toLowerCase() === cleanCode.toLowerCase() ||
            String(d.user_telegram_id) === cleanCode ||
            d.id === cleanCode
        );
        if (matchDraft) profile = matchDraft;
      }
    }

    // 4. Secondary fallback: Search bot_sessions directly if still not found
    if (!profile) {
      try {
        const { data: sessions } = await supabaseAdmin.from('bot_sessions').select('*');
        if (sessions && Array.isArray(sessions)) {
          const last4 = cleanCode.replace(/^rm/i, '');
          const matchedSession = sessions.find((s: any) => {
            const d = s.draft_data || {};
            const code = (d.display_code || '').toLowerCase();
            const tgStr = String(s.telegram_id || '');
            return (
              code === cleanCode.toLowerCase() ||
              code === `rm${last4.toLowerCase()}` ||
              tgStr === cleanCode ||
              (last4.length >= 3 && tgStr.endsWith(last4))
            );
          });

          if (matchedSession && matchedSession.draft_data) {
            const d = matchedSession.draft_data;
            profile = {
              id: cleanCode,
              display_code: d.display_code || cleanCode,
              user_telegram_id: Number(matchedSession.telegram_id),
              user_name: d.user_name || 'Verified Space Owner',
              preferred_subcity: d.preferred_subcity || [d.location || 'Addis Ababa'],
              my_gender: d.gender || d.my_gender || 'Member',
              age: d.age || 24,
              preferred_gender: d.preferred_gender || 'Any',
              budget_max: d.space_rent || d.budget_max || 10000,
              lifestyle_bio: d.roommate_traits || d.lifestyle_bio || 'Roommate available with a room in Addis Ababa.',
              listing_category: d.listing_category || (d.space_rent ? 'space_available' : 'seeker'),
              space_type: d.space_type || 'Private Bedroom in Shared Flat',
              space_rent: d.space_rent ? Number(d.space_rent) : undefined,
              space_share: d.space_share ? Number(d.space_share) : undefined,
              space_amenities: d.space_amenities || [],
              space_photos: d.space_photos || [],
              unlock_fee: 50,
              fayda_status: 'verified',
            };
          }
        }
      } catch (sessErr) {
        console.warn('[broadcastRoommateProfileToChannel] bot_sessions lookup error:', sessErr);
      }
    }

    // 5. Enrich with space details from bot_sessions if profile was loaded from profiles table without space info
    if (profile && (!profile.space_rent || profile.listing_category !== 'space_available')) {
      try {
        const tgId = profile.user_telegram_id;
        if (tgId) {
          const { data: sRow } = await supabaseAdmin
            .from('bot_sessions')
            .select('draft_data')
            .eq('telegram_id', String(tgId))
            .maybeSingle();

          if (sRow?.draft_data?.listing_category === 'space_available' || sRow?.draft_data?.space_rent) {
            const d = sRow.draft_data;
            profile.listing_category = 'space_available';
            profile.space_type = d.space_type || profile.space_type || 'Private Bedroom in Shared Flat';
            profile.space_rent = d.space_rent ? Number(d.space_rent) : profile.space_rent;
            profile.space_share = d.space_share ? Number(d.space_share) : profile.space_share;
            profile.space_amenities = d.space_amenities || profile.space_amenities || [];
            profile.space_photos = d.space_photos || profile.space_photos || [];
            if (d.age) profile.age = d.age;
            if (d.preferred_subcity) profile.preferred_subcity = d.preferred_subcity;
          }
        }
      } catch (enrichErr) {
        console.warn('[broadcastRoommateProfileToChannel] space enrichment warning:', enrichErr);
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

    const displayCode = profile.display_code || cleanCode;
    const codeTag = `#${displayCode.replace(/^#/, '')}`;
    const bioContent = (profile.lifestyle_bio || 'Seeking a compatible roommate in Addis Ababa.').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const hasSpace = profile.listing_category === 'space_available' || (profile.space_rent && profile.space_rent > 0);
    const hasPhotos = Array.isArray(profile.space_photos) && profile.space_photos.length > 0;

    let text = '';
    if (hasSpace) {
      const amenitiesStr = Array.isArray(profile.space_amenities) && profile.space_amenities.length > 0
        ? profile.space_amenities.join(', ')
        : 'WiFi, Kitchen, Water supply';
      const rentStr = profile.space_rent ? `${Number(profile.space_rent).toLocaleString()} ETB / month` : 'Negotiable';
      const shareStr = profile.space_share ? `${Number(profile.space_share).toLocaleString()} ETB / month` : 'Split equally';

      text = `
<b>Roommate available with a Room</b> ${codeTag}
📍 <code>${subcitiesStr}</code> · 🛡️ <b>${faydaBadge}</b>

• <b>Space Type:</b> ${profile.space_type || 'Private Bedroom in Shared Flat'}
• <b>Total Monthly Rent:</b> <code>${rentStr}</code>
• <b>Your Share / Split:</b> <code>${shareStr}</code>
• <b>What I Have / Amenities:</b> ${amenitiesStr}
• <b>Roommate Preference:</b> ${profile.my_gender || 'Member'} (Prefers: ${profile.preferred_gender || 'Any'})

<blockquote>"${bioContent}"</blockquote>

🔒 <i>Personal identity & direct contact remain sealed until mutual match unlock.</i>
      `.trim();
    } else {
      const ageStr = profile.age ? `, ${profile.age} yrs` : '';
      text = `
<b>Roommate Available</b> ${codeTag}
📍 <code>${subcitiesStr}</code> · 🛡️ <b>${faydaBadge}</b>

• <b>Gender & Age:</b> ${profile.my_gender || 'Member'}${ageStr} (Prefers: ${profile.preferred_gender || 'Any'})
• <b>Budget Cap:</b> <code>Up to ${Number(profile.budget_max).toLocaleString()} ETB / month</code>
• <b>Target Areas:</b> <code>${subcitiesStr}</code>

<blockquote>"${bioContent}"</blockquote>

🔒 <i>Personal identity & direct contact remain sealed until mutual match unlock.</i>
      `.trim();
    }

    const inlineKeyboard = {
      inline_keyboard: [
        [
          {
            text: `⚡ Contact with Roommate ${codeTag} ↗️`,
            url: `https://t.me/${botUsername}?start=req_${cleanCode}`,
          },
        ],
        [
          {
            text: '📢 Post My Profile ↗️',
            url: `https://t.me/${botUsername}?start=post_profile`,
          },
        ],
        [
          {
            text: '🔍 Search Roommate for Me ↗️',
            url: `https://t.me/${botUsername}?start=search_roommate`,
          },
        ],
      ],
    };

    let response: any;
    let data: any = null;
    if (hasPhotos) {
      try {
        response = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: targetChannel,
            photo: profile.space_photos[0],
            caption: text.length > 1024 ? text.slice(0, 1020) + '…' : text,
            parse_mode: 'HTML',
            reply_markup: inlineKeyboard,
          }),
        });
        data = await response.json();
      } catch {
        data = { ok: false };
      }

      // Fallback to text message if photo delivery failed
      if (!data || !data.ok) {
        response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: targetChannel,
            text,
            parse_mode: 'HTML',
            reply_markup: inlineKeyboard,
          }),
        });
        data = await response.json();
      }
    } else {
      response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: targetChannel,
          text,
          parse_mode: 'HTML',
          reply_markup: inlineKeyboard,
        }),
      });
      data = await response.json();
    }

    if (!data.ok) {
      return {
        success: false,
        message: `Telegram API error: ${data.description || 'Failed to post roommate profile.'}`,
      };
    }

    const messageId = data.result?.message_id;
    if (messageId) {
      if (displayCode) {
        try {
          await supabaseAdmin
            .from('profiles')
            .update({ channel_message_id: messageId, status: 'active' })
            .ilike('display_code', displayCode);
        } catch {}

        try {
          await supabaseAdmin
            .from('roommate_profiles')
            .update({ channel_message_id: messageId, status: 'approved' })
            .ilike('display_code', displayCode);
        } catch {}
      }

      if (isUuid) {
        try {
          await supabaseAdmin
            .from('profiles')
            .update({ channel_message_id: messageId, status: 'active' })
            .eq('id', cleanCode);
        } catch {}

        try {
          await supabaseAdmin
            .from('roommate_profiles')
            .update({ channel_message_id: messageId, status: 'approved' })
            .eq('id', cleanCode);
        } catch {}
      }

      try {
        await supabaseAdmin
          .from('pending_roommate_drafts')
          .update({ channel_message_id: messageId })
          .eq('id', cleanCode);
      } catch {}
    }

    return {
      success: true,
      message: `Successfully broadcasted roommate profile for ${profile.user_name} to channel ${targetChannel}.`,
      telegramMessageId: messageId,
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
  const targetChannel = channelId || process.env.TELEGRAM_CHANNEL_ID || '@roommate_addis';

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
      const draft = await getDraft(listingId);
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

    const descContent = (space.description || 'Verified space available for rent in Addis Ababa.').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const captionText = `
🏠 <b>SpaceMatch</b> · <b>Space for Rent</b>
📍 <code>${space.neighborhood || 'Addis Ababa'}</code> · 🛡️ <b>Host Verified</b>

• <b>Property:</b> <b>${space.title}</b>
• <b>Monthly Rent:</b> <code>${Number(space.price_per_month).toLocaleString()} ETB / month</code>
• <b>Unlock Fee:</b> <code>${space.unlock_fee || 50} ETB</code>

<blockquote>"${descContent}"</blockquote>

🔒 <i>Host contact details unlock instantly via @${botUsername}</i>
    `.trim();

    const inlineKeyboard = {
      inline_keyboard: [
        [
          {
            text: '🔑 View & Connect with Host ↗️',
            url: `https://t.me/${botUsername}?start=order_${space.id}`,
          },
        ],
        [
          {
            text: '📢 Post My Profile ↗️',
            url: `https://t.me/${botUsername}?start=post_profile`,
          },
        ],
        [
          {
            text: '📱 View in Mini App ↗️',
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

    const messageId = data.result?.message_id;
    if (messageId) {
      try {
        await supabaseAdmin
          .from('spaces')
          .update({ channel_message_id: messageId })
          .eq('id', listingId);
      } catch {}

      try {
        await supabaseAdmin
          .from('pending_space_drafts')
          .update({ channel_message_id: messageId })
          .eq('id', listingId);
      } catch {}
    }

    return {
      success: true,
      message: `Successfully broadcasted space listing '${space.title}' to channel ${targetChannel}.`,
      telegramMessageId: messageId,
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
  const targetChannel = channelId || process.env.TELEGRAM_CHANNEL_ID || '@roommate_addis';

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
        { text: '🏠 I Have a Space', url: `https://t.me/${botUsername}?start=property_type`, style: 'primary' },
        { text: '🔍 I Need a Space', url: `https://t.me/${botUsername}?start=seeker_flow`, style: 'primary' },
      ],
      [
        { text: '🛒 በቦት እዘዝ (Order in Bot)', url: orderUrl, style: 'success' },
      ],
      [
        { text: '🔍 በሚኒ አፕ ተመልከት (View in Mini App)', url: miniAppUrl, style: 'primary' },
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
  const targetChannel = channelId || process.env.TELEGRAM_CHANNEL_ID || '@roommate_addis';

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
 * Updates an active Telegram channel post to mark it as '__CLOSED__' and removes all action buttons.
 */
export async function closeChannelPost(
  messageId: number,
  itemTitle: string,
  isPhoto: boolean = false,
  channelId?: string,
  existingContent?: string
): Promise<{ success: boolean; message: string }> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const rawBotUsername = process.env.NEXT_PUBLIC_BOT_USERNAME || 'Spacematchaddis_bot';
  const botUsername = rawBotUsername.replace('@', '');
  const targetChannel = channelId || process.env.TELEGRAM_CHANNEL_ID || '@roommate_addis';

  if (!botToken) {
    return { success: false, message: 'TELEGRAM_BOT_TOKEN is missing.' };
  }

  const closedHeader = `🔴 ━━━━━━━━━━━━━━━━━━━━━━ 🔴\n       <b>_____CLOSED_____</b>\n🤝 <i>This listing is officially closed &amp; matched!</i>\n🔴 ━━━━━━━━━━━━━━━━━━━━━━ 🔴`;

  const closedNotice = existingContent?.trim()
    ? `${closedHeader}\n\n${existingContent.trim()}\n\n🔒 <i>Listing closed. Browse active verified roommates below:</i>`
    : `${closedHeader}\n\n✨ <b>${itemTitle} has found a match! 🎉</b>\n\n<blockquote>✅ This listing is officially closed. No further connection requests are accepted.</blockquote>`;

  const safeCaption = closedNotice.length > 1024 ? closedNotice.slice(0, 1020) + '…' : closedNotice;

  const closedMarkup = {
    inline_keyboard: [
      [
        {
          text: '🔒 Listing Closed · Search Roommates ↗️',
          url: `https://t.me/${botUsername}?start=search_roommate`,
        },
      ],
      [
        {
          text: '📢 Post My Profile ↗️',
          url: `https://t.me/${botUsername}?start=post_profile`,
        },
      ],
    ],
  };

  try {
    const endpoint = isPhoto ? 'editMessageCaption' : 'editMessageText';
    const body: Record<string, any> = {
      chat_id: targetChannel,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: closedMarkup,
    };

    if (isPhoto) {
      body.caption = safeCaption;
    } else {
      body.text = closedNotice;
    }

    const res = await fetch(`https://api.telegram.org/bot${botToken}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const json = await res.json();
    if (!json.ok) {
      // Try alternate endpoint if caption vs text mismatch
      const fallbackEndpoint = isPhoto ? 'editMessageText' : 'editMessageCaption';
      const fallbackBody = { ...body };
      if (isPhoto) {
        delete fallbackBody.caption;
        fallbackBody.text = closedNotice;
      } else {
        delete fallbackBody.text;
        fallbackBody.caption = safeCaption;
      }

      const res2 = await fetch(`https://api.telegram.org/bot${botToken}/${fallbackEndpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fallbackBody),
      });

      const json2 = await res2.json();
      if (!json2.ok) {
        return {
          success: false,
          message: json2.description || json.description || 'Failed to update channel post.',
        };
      }
    }

    return {
      success: true,
      message: `Successfully marked post #${messageId} as CLOSED on channel ${targetChannel}.`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Exception updating channel post: ${msg}` };
  }
}

