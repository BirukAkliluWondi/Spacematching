import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-server';
import {
  getSession,
  saveSession,
  clearSession,
  getDraft,
  saveDraft,
  getRoommateDraft,
  saveRoommateDraft,
  getAllSpaceDrafts,
  getAllRoommateDrafts,
  preloadSession,
  SpaceDraft,
  RoommateProfileDraft,
  getManagedChannels,
  saveManagedChannel,
  removeManagedChannel,
  ManagedChannel,
} from '@/lib/bot-session-store';
import { verifyTelebirrPayment } from '@/lib/verify-et';
import {
  broadcastListingToChannel,
  broadcastRoommateProfileToChannel,
  closeChannelPost,
} from '@/lib/telegram-broadcast';
import {
  sendMessage as tgSend,
  updateChannelPostAsMatched,
  parseNumericInput,
  setChatMenuButton,
  deleteMessage,
} from '@/lib/telegram';
import {
  handleOnboardingCallback,
  handleOnboardingMessage,
  isOnboardingCallback,
  isOnboardingSession,
  initiateOnboarding,
} from '@/lib/bot/onboarding';
import { validateFaydaFan } from '@/lib/fayda-qr-decoder';

const ALL_SUBCITIES = [
  'Bole',
  'Kazanchis',
  'CMC',
  'Sarbet',
  'Megenagna',
  'Piassa',
  '4 Kilo',
  'Arada',
  'Kirkos',
  'Akaki Kality',
  'Nifas Silk',
  'Kolfe Keraniyo',
  'Gullele',
  'Lideta',
];

// Module-level cache for admin IDs
let cachedAdminIds: { ids: number[]; expiresAt: number } | null = null;
export function invalidateAdminCache() {
  cachedAdminIds = null;
}

export async function POST(request: Request) {
  try {
    const update = await request.json();
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const rawBotUsername = process.env.NEXT_PUBLIC_BOT_USERNAME || 'Spacematchaddis_bot';
    const botUsername = rawBotUsername.replace('@', '');
    const appName = process.env.NEXT_PUBLIC_TELEGRAM_APP_NAME || 'roommatch';
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://spacematch1-flax.vercel.app';
    const receiverPhone = process.env.TELEBIRR_RECEIVER_PHONE || '0987310978';
    const cbeAccount = process.env.CBE_ACCOUNT_NUMBER || '1000054066094';

    // Helper to send requests to Telegram API
    const sendTelegram = async (method: string, payload: Record<string, any>) => {
      if (!botToken) return null;
      try {
        const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        return await res.json();
      } catch (err) {
        console.error(`Telegram API error (${method}):`, err);
        return null;
      }
    };

    // Helper to get Admin Telegram IDs (Super-Admins + DB Admins + Channel Admins)
    const getAdminIds = async (): Promise<number[]> => {
      const now = Date.now();
      if (cachedAdminIds && cachedAdminIds.expiresAt > now) {
        return cachedAdminIds.ids;
      }

      const defaultAdminIds = [800701176, 148318506]; // @birukadiyee & @WWEHID
      const envAdmins = (process.env.ADMIN_TELEGRAM_IDS || '')
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => !isNaN(n) && n > 0);

      const adminSet = new Set<number>([...defaultAdminIds, ...envAdmins]);

      // 1. Fetch from Supabase users where role = 'admin'
      try {
        const { data } = await supabaseAdmin.from('users').select('telegram_id').eq('role', 'admin');
        if (data && data.length > 0) {
          for (const u of data) {
            const id = Number(u.telegram_id);
            if (id) adminSet.add(id);
          }
        }
      } catch (err) {
        console.error('Error fetching DB admins:', err);
      }

      // 2. Fetch from all active Telegram channels dynamically via getChatAdministrators
      if (botToken) {
        try {
          const channels = await getManagedChannels();
          const targetChannels = new Set<string | number>();
          if (process.env.TELEGRAM_CHANNEL_ID) targetChannels.add(process.env.TELEGRAM_CHANNEL_ID);
          for (const ch of channels) {
            if (ch.is_active) {
              if (ch.channel_id) targetChannels.add(ch.channel_id);
              if (ch.channel_username) targetChannels.add(ch.channel_username);
            }
          }
          if (targetChannels.size === 0) {
            targetChannels.add('@roommatch_addis');
          }

          for (const ch of targetChannels) {
            try {
              const res = await fetch(`https://api.telegram.org/bot${botToken}/getChatAdministrators`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: ch }),
              });
              const json = await res.json();
              if (json.ok && Array.isArray(json.result)) {
                for (const member of json.result) {
                  if (member.user && !member.user.is_bot && member.user.id) {
                    adminSet.add(Number(member.user.id));
                  }
                }
              }
            } catch (chErr) {
              console.error('Error fetching admins for channel:', ch, chErr);
            }
          }
        } catch (err) {
          console.error('Error fetching channel administrators:', err);
        }
      }

      const result = Array.from(adminSet);
      cachedAdminIds = { ids: result, expiresAt: now + 5 * 60 * 1000 };
      return result;
    };

    // Helper to get the primary channel or active channels for broadcasting
    const getPrimaryChannel = async (): Promise<string | number> => {
      try {
        const channels = await getManagedChannels();
        const active = channels.filter((c) => c.is_active);
        if (active.length > 0) {
          return active[0].channel_username || active[0].channel_id;
        }
      } catch (err) {
        console.error('getPrimaryChannel error:', err);
      }
      return process.env.TELEGRAM_CHANNEL_ID || '@roommatch_addis';
    };

    const getAllActiveChannels = async (): Promise<(string | number)[]> => {
      try {
        const channels = await getManagedChannels();
        const active = channels.filter((c) => c.is_active);
        if (active.length > 0) {
          return active.map((c) => c.channel_username || c.channel_id);
        }
      } catch (err) {
        console.error('getAllActiveChannels error:', err);
      }
      return [process.env.TELEGRAM_CHANNEL_ID || '@roommatch_addis'];
    };

    // Helper to close a channel listing manually or automatically
    const executeChannelPostClose = async (
      targetIdentifier: string,
      closedByChatId: number
    ): Promise<{ success: boolean; message: string; displayCode?: string; messageId?: number }> => {
      let rawClean = targetIdentifier.trim().replace(/^#/, '');
      // Extract from URL if full link was provided (e.g. https://t.me/roommatch_addis/1542)
      const linkMatch = rawClean.match(/(?:t\.me\/[^\/]+\/|message_id=)(\d+)/);
      if (linkMatch) {
        rawClean = linkMatch[1];
      }

      // 1. Find profile in DB
      let targetProfile: any = null;
      let channelMsgId: number | null = null;
      let displayCode: string = rawClean.toUpperCase();

      const { data: pCode } = await supabaseAdmin
        .from('profiles')
        .select('*')
        .ilike('display_code', rawClean)
        .maybeSingle();

      if (pCode) {
        targetProfile = pCode;
        channelMsgId = pCode.channel_message_id;
        displayCode = pCode.display_code;
      } else {
        const { data: rmCode } = await supabaseAdmin
          .from('roommate_profiles')
          .select('*')
          .ilike('display_code', rawClean)
          .maybeSingle();

        if (rmCode) {
          targetProfile = rmCode;
          channelMsgId = rmCode.channel_message_id;
          displayCode = rmCode.display_code || rawClean.toUpperCase();
        }
      }

      // If not found by display_code, check if rawClean is a channel_message_id
      const parsedNum = parseInt(rawClean.replace(/^post_|^RM/i, ''), 10);
      if (!channelMsgId && !isNaN(parsedNum) && parsedNum > 0) {
        channelMsgId = parsedNum;
        if (!targetProfile) {
          const { data: pMsg } = await supabaseAdmin
            .from('profiles')
            .select('*')
            .eq('channel_message_id', parsedNum)
            .maybeSingle();
          if (pMsg) {
            targetProfile = pMsg;
            displayCode = pMsg.display_code;
          }
        }
      }

      if (!channelMsgId) {
        return {
          success: false,
          message: `Could not find a channel post corresponding to <b>${rawClean}</b>. Please provide a valid #RM code, message ID, or channel link.`,
        };
      }

      // 2. Call updateChannelPostAsMatched
      const primaryCh = await getPrimaryChannel();
      const closedSuccess = await updateChannelPostAsMatched(channelMsgId, displayCode, undefined, primaryCh);

      // 3. Mark DB as closed / matched
      try {
        await supabaseAdmin
          .from('profiles')
          .update({
            status: 'closed',
            updated_at: new Date().toISOString(),
          })
          .or(`display_code.ilike.${displayCode},channel_message_id.eq.${channelMsgId}`);

        await supabaseAdmin
          .from('roommate_profiles')
          .update({
            status: 'closed',
            updated_at: new Date().toISOString(),
          })
          .or(`display_code.ilike.${displayCode},channel_message_id.eq.${channelMsgId}`);
      } catch (dbErr) {
        console.error('Error updating profile status to closed in DB:', dbErr);
      }

      if (closedSuccess) {
        return {
          success: true,
          message: `Post <b>#${displayCode}</b> (Channel Message ID: <code>${channelMsgId}</code>) is now marked as <b>_____CLOSED_____</b> in the channel!`,
          displayCode,
          messageId: channelMsgId,
        };
      } else {
        return {
          success: false,
          message: `Database marked as closed, but Telegram message <code>${channelMsgId}</code> could not be updated in the channel. Please verify the bot's channel edit permissions.`,
          displayCode,
          messageId: channelMsgId,
        };
      }
    };

    // Helper: 24-Hour Automated Follow-Up Check-in Protocol
    const checkPending24hCheckins = async () => {
      try {
        const now = Date.now();

        // 1. Check sessions scheduled in bot_sessions
        const { data: pendingSessions } = await supabaseAdmin
          .from('bot_sessions')
          .select('*')
          .filter('draft_data->>checkin_scheduled', 'eq', 'true')
          .limit(20);

        if (pendingSessions && pendingSessions.length > 0) {
          for (const s of pendingSessions) {
            const due = Number(s.draft_data?.checkin_due || 0);
            if (due > 0 && due <= now) {
              const displayCode = s.draft_data?.target_display_code || 'ROOMMATE';
              const checkinText = `
👋 <b>SpaceMatch · 24-Hour Roommate Follow-Up</b>

It has been 24 hours since your roommate contact was unlocked!

<b>Do you want to keep your profile posted on the channel?</b>

• <b>Listing Code:</b> <b>#${displayCode}</b>
              `.trim();

              const checkinKeyboard = [
                [
                  {
                    text: '❌ No, close it (Roommate match was successful!)',
                    callback_data: `owner_close_listing:${displayCode}`,
                  },
                ],
                [
                  {
                    text: '✅ Keep it (I want other roommate matches)',
                    callback_data: `owner_keep_listing:${displayCode}`,
                  },
                ],
              ];

              await sendTelegram('sendMessage', {
                chat_id: s.telegram_id,
                text: checkinText,
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: checkinKeyboard },
              }).catch(() => {});

              await saveSession({
                telegram_id: s.telegram_id,
                step: s.step || 'idle',
                draft_data: {
                  ...s.draft_data,
                  checkin_scheduled: false,
                  checkin_sent_at: new Date().toISOString(),
                },
                updated_at: new Date().toISOString(),
              });
            }
          }
        }

        // 2. Dual redundancy: Also check matches table where contacts were unlocked > 24 hours ago
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { data: pendingMatches } = await supabaseAdmin
          .from('matches')
          .select('id, target:target_id(id, telegram_id, display_code, channel_message_id), contacts_unlocked_at, checkin_24h_sent')
          .eq('status', 'completed')
          .not('contacts_unlocked_at', 'is', null)
          .lte('contacts_unlocked_at', twentyFourHoursAgo)
          .or('checkin_24h_sent.is.null,checkin_24h_sent.eq.false')
          .limit(10);

        if (pendingMatches && pendingMatches.length > 0) {
          for (const m of pendingMatches) {
            const targetData = m.target as any;
            const targetTgId = targetData?.telegram_id;
            const displayCode = targetData?.display_code || 'ROOMMATE';

            if (targetTgId) {
              const checkinText = `
👋 <b>SpaceMatch · 24-Hour Roommate Follow-Up</b>

It has been 24 hours since your roommate contact was unlocked!

<b>Do you want to keep your profile posted on the channel?</b>

• <b>Listing Code:</b> <b>#${displayCode}</b>
              `.trim();

              const checkinKeyboard = [
                [
                  {
                    text: '❌ No, close it (Roommate match was successful!)',
                    callback_data: `owner_close_listing:${displayCode}`,
                  },
                ],
                [
                  {
                    text: '✅ Keep it (I want other roommate matches)',
                    callback_data: `owner_keep_listing:${displayCode}`,
                  },
                ],
              ];

              await sendTelegram('sendMessage', {
                chat_id: targetTgId,
                text: checkinText,
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: checkinKeyboard },
              }).catch(() => {});

              await supabaseAdmin
                .from('matches')
                .update({ checkin_24h_sent: true, updated_at: new Date().toISOString() })
                .eq('id', m.id);
            }
          }
        }
      } catch (err) {
        console.error('Error checking 24h follow-ups:', err);
      }
    };

    // Helper to send or edit in-place cards seamlessly
    const sendOrEditCard = async (
      chatId: number,
      text: string,
      keyboard: any[][],
      messageIdToEdit?: number
    ): Promise<number | undefined> => {
      if (messageIdToEdit) {
        const editRes = await sendTelegram('editMessageText', {
          chat_id: chatId,
          message_id: messageIdToEdit,
          text,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: keyboard },
        });
        if (editRes?.ok || editRes?.description?.includes('message is not modified')) {
          return messageIdToEdit;
        }
      }

      const sendRes = await sendTelegram('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard },
      });
      return sendRes?.result?.message_id;
    };

    // Helper to check if a user is verified via Fayda (offline Verhoeff QR or admin approved)
    const isUserFaydaVerified = async (chatId: number): Promise<boolean> => {
      try {
        const { data: user } = await supabaseAdmin
          .from('users')
          .select('fayda_status')
          .eq('telegram_id', chatId)
          .maybeSingle();

        if (user?.fayda_status === 'verified') return true;

        const { data: profile } = await supabaseAdmin
          .from('profiles')
          .select('kyc_status')
          .eq('telegram_id', chatId)
          .maybeSingle();

        if (profile?.kyc_status === 'verified') return true;
      } catch (err) {
        console.error('Error checking Fayda verification status:', err);
      }
      return false;
    };

    // Helper: Universal Fayda Gate Card (Dual-Mode: Type FAN or Scan QR)
    const sendFaydaGateCard = async (
      chatId: number,
      targetAction: string,
      messageIdToEdit?: number
    ): Promise<number | undefined> => {
      await saveSession({
        telegram_id: chatId,
        step: 'awaiting_standalone_fayda_fan',
        draft_data: { card_msg_id: messageIdToEdit, target_action: targetAction },
        updated_at: new Date().toISOString(),
      });

      const gateText = `
🛡️ <b>SpaceMatch · Fayda ID Verification Required</b>

Before you can <b>${targetAction}</b>, your Fayda National ID must be verified.

• <b>Option A:</b> Reply here with your <b>12-digit or 16-digit FAN number</b>:
<i>Example: <code>1234 5678 9012</code></i>

• <b>Option B:</b> Tap below to open your camera and scan your Fayda QR code:
      `.trim();

      const inlineKeyboard = [
        [
          {
            text: '📷 Open Camera to Scan Fayda QR ↗️',
            web_app: { url: `${appUrl}?startapp=verify_fayda` },
          },
        ],
        [
          {
            text: '🏠 Back to Main Menu',
            callback_data: 'nav_start',
          },
        ],
      ];

      return await sendOrEditCard(chatId, gateText, inlineKeyboard, messageIdToEdit);
    };

    // Helper to format dynamic context header
    const getDynamicContextHeader = (draft: Record<string, any>) => {
      if (draft.target_code) {
        const loc = draft.target_locations ? `📍 <code>${draft.target_locations}</code>` : '';
        const bud = draft.target_budget ? ` · 💰 <code>${draft.target_budget}</code>` : '';
        const subline = (loc || bud) ? `${loc}${bud}\n` : '';
        return `🤝 <b>SpaceMatch · Connecting with Roommate #${draft.target_code}</b>\n${subline}<i>Before sending your request, please tell #${draft.target_code} about yourself:</i>\n`;
      }
      return `📢 <b>SpaceMatch · Post Roommate Profile to Channel</b>\n<i>Create your verified anonymous profile for the Addis channel:</i>\n`;
    };

    // Step 1: Age (Open Numeric Input)
    const sendDynamicCardStep1Age = async (
      chatId: number,
      draft: Record<string, any> = {},
      messageIdToEdit?: number,
      errorMsg?: string
    ) => {
      const header = getDynamicContextHeader(draft);
      const activeMsgId = messageIdToEdit || draft.card_msg_id;

      await saveSession({
        telegram_id: chatId,
        step: 'dyn_card_age',
        draft_data: { ...draft, card_msg_id: activeMsgId },
        updated_at: new Date().toISOString(),
      });

      const text = `
${header}
${errorMsg ? `⚠️ <b>${errorMsg}</b>\n\n` : ''}🎂 <b>Step 1 of 5: What is your age?</b>
<i>(Please reply with your age as a number, e.g. <code>24</code>)</i>
      `.trim();

      const inlineKeyboard = [
        ...(draft.target_code
          ? [[{ text: '📢 Post My Profile to Channel Instead ↗️', callback_data: 'post_profile_start' }]]
          : []),
        [{ text: '🏠 Cancel', callback_data: 'nav_start' }],
      ];

      const newMsgId = await sendOrEditCard(chatId, text, inlineKeyboard, activeMsgId);
      if (newMsgId && !activeMsgId) {
        await saveSession({
          telegram_id: chatId,
          step: 'dyn_card_age',
          draft_data: { ...draft, card_msg_id: newMsgId },
          updated_at: new Date().toISOString(),
        });
      }
    };

    // Step 2: Gender
    const sendDynamicCardStep2Gender = async (
      chatId: number,
      draft: Record<string, any>,
      messageIdToEdit?: number
    ) => {
      const header = getDynamicContextHeader(draft);
      const activeMsgId = messageIdToEdit || draft.card_msg_id;

      await saveSession({
        telegram_id: chatId,
        step: 'dyn_card_gender',
        draft_data: { ...draft, card_msg_id: activeMsgId },
        updated_at: new Date().toISOString(),
      });

      const text = `
${header}
👤 <b>Step 2 of 5: Select your gender:</b>
      `.trim();

      const inlineKeyboard = [
        [
          { text: '👨 Male', callback_data: 'dyn_gender:Male' },
          { text: '👩 Female', callback_data: 'dyn_gender:Female' },
        ],
        [
          { text: '⬅️ Back to Age', callback_data: 'dyn_back_to_age' },
          { text: '🏠 Cancel', callback_data: 'nav_start' },
        ],
      ];

      await sendOrEditCard(chatId, text, inlineKeyboard, activeMsgId);
    };

    // Step 3: Monthly Budget (Open Numeric Input)
    const sendDynamicCardStep3Budget = async (
      chatId: number,
      draft: Record<string, any>,
      messageIdToEdit?: number,
      errorMsg?: string
    ) => {
      const header = getDynamicContextHeader(draft);
      const activeMsgId = messageIdToEdit || draft.card_msg_id;

      await saveSession({
        telegram_id: chatId,
        step: 'dyn_card_budget',
        draft_data: { ...draft, card_msg_id: activeMsgId },
        updated_at: new Date().toISOString(),
      });

      const text = `
${header}
${errorMsg ? `⚠️ <b>${errorMsg}</b>\n\n` : ''}💰 <b>Step 3 of 5: What is your monthly budget in ETB?</b>
<i>(Please reply with your budget as a number, e.g. <code>12000</code>)</i>
      `.trim();

      const inlineKeyboard = [
        [
          { text: '⬅️ Back to Gender', callback_data: 'dyn_back_to_gender' },
          { text: '🏠 Cancel', callback_data: 'nav_start' },
        ],
      ];

      await sendOrEditCard(chatId, text, inlineKeyboard, activeMsgId);
    };

    // Step 4: Sub-cities Multi-Select Grid
    const sendDynamicCardStep4Subcities = async (
      chatId: number,
      draft: Record<string, any>,
      messageIdToEdit?: number
    ) => {
      const header = getDynamicContextHeader(draft);
      const activeMsgId = messageIdToEdit || draft.card_msg_id;
      const selectedList: string[] = draft.preferred_subcity || ['Bole'];
      const isAllSelected = ALL_SUBCITIES.every((s) => selectedList.includes(s));

      await saveSession({
        telegram_id: chatId,
        step: 'dyn_card_subcities',
        draft_data: { ...draft, preferred_subcity: selectedList, card_msg_id: activeMsgId },
        updated_at: new Date().toISOString(),
      });

      const gridRows: any[] = [];
      gridRows.push([
        {
          text: isAllSelected
            ? '✅ All Selected (Proceed ➡️)'
            : '🌐 Select ALL Sub-Cities & Proceed ➡️',
          callback_data: 'dyn_sub_all',
        },
      ]);

      for (let i = 0; i < ALL_SUBCITIES.length; i += 2) {
        const row = [];
        const item1 = ALL_SUBCITIES[i];
        const isSel1 = selectedList.includes(item1);
        row.push({
          text: `${isSel1 ? '🟢' : '⚪'} ${item1}`,
          callback_data: `dyn_sub_toggle:${item1}`,
        });

        if (i + 1 < ALL_SUBCITIES.length) {
          const item2 = ALL_SUBCITIES[i + 1];
          const isSel2 = selectedList.includes(item2);
          row.push({
            text: `${isSel2 ? '🟢' : '⚪'} ${item2}`,
            callback_data: `dyn_sub_toggle:${item2}`,
          });
        }
        gridRows.push(row);
      }

      gridRows.push([
        { text: '✅ Proceed to Fayda Verification ➡️', callback_data: 'dyn_sub_proceed' },
      ]);
      gridRows.push([
        { text: '⬅️ Back to Budget', callback_data: 'dyn_back_to_budget' },
        { text: '🏠 Cancel', callback_data: 'nav_start' },
      ]);

      const text = `
${header}
📍 <b>Step 4 of 5: Select your preferred sub-cities:</b>
<i>(Tap areas to toggle checkmarks, then tap Proceed)</i>

<b>Selected:</b> <code>${selectedList.join(', ')}</code>
      `.trim();

      await sendOrEditCard(chatId, text, gridRows, activeMsgId);
    };

    // Step 5: Fayda FAN Verification (Dual-Mode: Type or Camera Scan)
    const sendDynamicCardStep5FaydaFan = async (
      chatId: number,
      draft: Record<string, any>,
      messageIdToEdit?: number,
      errorMsg?: string
    ) => {
      const header = getDynamicContextHeader(draft);
      const activeMsgId = messageIdToEdit || draft.card_msg_id;

      await saveSession({
        telegram_id: chatId,
        step: 'dyn_card_fayda_fan',
        draft_data: { ...draft, card_msg_id: activeMsgId },
        updated_at: new Date().toISOString(),
      });

      const text = `
${header}
${errorMsg ? `⚠️ <b>${errorMsg}</b>\n\n` : ''}🛡️ <b>Step 5 of 5: Fayda ID Verification</b>

SpaceMatch Addis is a 100% verified housing community.

• <b>Option A:</b> Reply here with your <b>12-digit or 16-digit FAN number</b>:
<i>Example: <code>1234 5678 9012</code></i>

• <b>Option B:</b> Tap below to scan the QR code on your card with your camera:
      `.trim();

      const inlineKeyboard = [
        [
          {
            text: '📷 Open Camera to Scan Fayda QR ↗️',
            web_app: { url: `${appUrl}?startapp=verify_fayda` },
          },
        ],
        [
          { text: '⬅️ Back to Sub-Cities', callback_data: 'dyn_back_to_subs' },
          { text: '🏠 Cancel', callback_data: 'nav_start' },
        ],
      ];

      await sendOrEditCard(chatId, text, inlineKeyboard, activeMsgId);
    };

    // Helper: Final Preview Card before publishing to channel
    const sendChannelPublishPreviewCard = async (
      chatId: number,
      profileData: Record<string, any>,
      messageIdToEdit?: number
    ) => {
      const subcitiesStr = Array.isArray(profileData.locations) && profileData.locations.length > 0
        ? profileData.locations.join(', ')
        : 'Addis Ababa';

      const text = `
📋 <b>SpaceMatch · Review Your Channel Post</b>
📍 <code>${subcitiesStr}</code> · 🛡️ <b>Fayda Verified</b>

• <b>Profile:</b> Roommate #${profileData.display_code} (${profileData.gender || 'Member'}, Age ${profileData.age || 24})
• <b>Budget Cap:</b> <code>Up to ${Number(profileData.budget_max || 10000).toLocaleString()} ETB / month</code>
• <b>Target Areas:</b> <code>${subcitiesStr}</code>
• <b>Status:</b> Ready for Channel Broadcast

<blockquote>"${profileData.roommate_traits || 'Seeking compatible roommate in Addis Ababa.'}"</blockquote>

<i>Tapping submit will send your anonymous profile to our channel admins for review and approval!</i>
      `.trim();

      const targetIdentifier = profileData.display_code || profileData.id;
      const inlineKeyboard = [
        [
          {
            text: '📢 Submit for Admin Approval 🚀',
            callback_data: `dyn_submit_channel:${targetIdentifier}`,
          },
        ],
        [
          { text: '✏️ Edit Profile Details', callback_data: 'post_profile_start' },
          { text: '🏠 Main Menu', callback_data: 'nav_start' },
        ],
      ];

      await sendOrEditCard(chatId, text, inlineKeyboard, messageIdToEdit);
    };

    // ── Helper: 2-Branch Selection: "I have a space" vs "We look for space together" ──
    const sendPostProfileBranchPrompt = async (chatId: number, messageIdToEdit?: number) => {
      await saveSession({
        telegram_id: chatId,
        step: 'post_profile_branch_select',
        draft_data: { card_msg_id: messageIdToEdit },
        updated_at: new Date().toISOString(),
      });

      const text = `
📢 <b>SpaceMatch · Post Your Profile on the Channel</b>

Please select which type of roommate profile you want to post:

• <b>Option 1:</b> 🏠 <b>I have a space and I want a roommate</b>
<i>(You already have a room/flat and want to find a roommate to share it with)</i>

• <b>Option 2:</b> 👥 <b>I want a roommate and we look for space together</b>
<i>(You are looking for a compatible roommate so you can search for a place together)</i>
      `.trim();

      const inlineKeyboard = [
        [
          {
            text: '🏠 I have a space and I want a roommate',
            callback_data: 'post_branch_space',
          },
        ],
        [
          {
            text: '👥 I want a roommate and we look for space together',
            callback_data: 'post_branch_seeker',
          },
        ],
        [
          {
            text: '🏠 Main Menu',
            callback_data: 'nav_start',
          },
        ],
      ];

      return await sendOrEditCard(chatId, text, inlineKeyboard, messageIdToEdit);
    };

    // ── Branch A: Space Owner Questionnaire Helpers ─────────────────────────
    const sendSpaceStep1Type = async (chatId: number, draft: Record<string, any> = {}, messageIdToEdit?: number) => {
      const activeMsgId = messageIdToEdit || draft.card_msg_id;
      await saveSession({
        telegram_id: chatId,
        step: 'space_type_select',
        draft_data: { ...draft, listing_category: 'space_available', card_msg_id: activeMsgId },
        updated_at: new Date().toISOString(),
      });

      const text = `
🏠 <b>SpaceMatch · Space Owner (Step 1 of 6)</b>

<b>What type of space are you offering?</b>
<i>Select your space layout below:</i>
      `.trim();

      const inlineKeyboard = [
        [{ text: '🛏️ Private Room in Shared Flat', callback_data: 'space_type:Private Room in Shared Flat' }],
        [{ text: '👑 Master Bedroom with Bath', callback_data: 'space_type:Master Bedroom with Bath' }],
        [{ text: '🏢 Studio / 1-Bedroom Flat', callback_data: 'space_type:Studio / 1-Bedroom Flat' }],
        [{ text: '👥 Shared Room / Bedspace', callback_data: 'space_type:Shared Room / Bedspace' }],
        [{ text: '⬅️ Back to Options', callback_data: 'post_profile_start' }],
        [{ text: '🏠 Cancel', callback_data: 'nav_start' }],
      ];

      return await sendOrEditCard(chatId, text, inlineKeyboard, activeMsgId);
    };

    const sendSpaceStep2Rent = async (
      chatId: number,
      draft: Record<string, any>,
      messageIdToEdit?: number,
      errorMsg?: string
    ) => {
      const activeMsgId = messageIdToEdit || draft.card_msg_id;
      await saveSession({
        telegram_id: chatId,
        step: 'space_input_rent',
        draft_data: { ...draft, card_msg_id: activeMsgId },
        updated_at: new Date().toISOString(),
      });

      const text = `
🏠 <b>SpaceMatch · Space Owner (Step 2 of 6)</b>
${errorMsg ? `⚠️ <b>${errorMsg}</b>\n\n` : ''}💰 <b>What is the total monthly rent for the entire space?</b>
<i>Tap a quick preset below or reply with the exact number in ETB (e.g. <code>12000</code>):</i>
      `.trim();

      const inlineKeyboard = [
        [
          { text: '6,000 ETB', callback_data: 'space_rent:6000' },
          { text: '8,000 ETB', callback_data: 'space_rent:8000' },
        ],
        [
          { text: '10,000 ETB', callback_data: 'space_rent:10000' },
          { text: '12,000 ETB', callback_data: 'space_rent:12000' },
        ],
        [
          { text: '15,000 ETB', callback_data: 'space_rent:15000' },
          { text: '20,000 ETB', callback_data: 'space_rent:20000' },
        ],
        [
          { text: '⬅️ Back to Space Type', callback_data: 'post_branch_space' },
          { text: '🏠 Cancel', callback_data: 'nav_start' },
        ],
      ];

      return await sendOrEditCard(chatId, text, inlineKeyboard, activeMsgId);
    };

    const sendSpaceStep3Share = async (
      chatId: number,
      draft: Record<string, any>,
      messageIdToEdit?: number,
      errorMsg?: string
    ) => {
      const activeMsgId = messageIdToEdit || draft.card_msg_id;
      await saveSession({
        telegram_id: chatId,
        step: 'space_input_share',
        draft_data: { ...draft, card_msg_id: activeMsgId },
        updated_at: new Date().toISOString(),
      });

      const rentNum = draft.space_rent || 10000;
      const halfRent = Math.round(rentNum / 2);

      const text = `
🏠 <b>SpaceMatch · Space Owner (Step 3 of 6)</b>
• <b>Total Rent:</b> <code>${Number(rentNum).toLocaleString()} ETB / month</code>

${errorMsg ? `⚠️ <b>${errorMsg}</b>\n\n` : ''}🤝 <b>What is the share / split the other person has to pay?</b>
<i>Tap 50% split below or reply with the exact ETB amount:</i>
      `.trim();

      const inlineKeyboard = [
        [
          { text: `⚖️ 50% Split (${halfRent.toLocaleString()} ETB)`, callback_data: `space_share:${halfRent}` },
        ],
        [
          { text: '4,000 ETB', callback_data: 'space_share:4000' },
          { text: '5,000 ETB', callback_data: 'space_share:5000' },
          { text: '6,000 ETB', callback_data: 'space_share:6000' },
        ],
        [
          { text: '⬅️ Back to Total Rent', callback_data: 'space_back_to_rent' },
          { text: '🏠 Cancel', callback_data: 'nav_start' },
        ],
      ];

      return await sendOrEditCard(chatId, text, inlineKeyboard, activeMsgId);
    };

    const SPACE_AMENITIES_LIST = [
      '📶 WiFi',
      '🍳 Kitchen',
      '💧 Water Tanker',
      '🧺 Washing Machine',
      '🚿 Hot Shower',
      '🚗 Parking',
      '🛋️ Furnished',
      '🔒 24/7 Security',
    ];

    const sendSpaceStep4Amenities = async (
      chatId: number,
      draft: Record<string, any>,
      messageIdToEdit?: number
    ) => {
      const activeMsgId = messageIdToEdit || draft.card_msg_id;
      const selected: string[] = draft.space_amenities || ['📶 WiFi', '🍳 Kitchen'];

      await saveSession({
        telegram_id: chatId,
        step: 'space_amenities_select',
        draft_data: { ...draft, space_amenities: selected, card_msg_id: activeMsgId },
        updated_at: new Date().toISOString(),
      });

      const gridRows: any[] = [];
      for (let i = 0; i < SPACE_AMENITIES_LIST.length; i += 2) {
        const row = [];
        const item1 = SPACE_AMENITIES_LIST[i];
        const isSel1 = selected.includes(item1);
        row.push({
          text: `${isSel1 ? '🟢' : '⚪'} ${item1}`,
          callback_data: `space_amenity_toggle:${encodeURIComponent(item1)}`,
        });

        if (i + 1 < SPACE_AMENITIES_LIST.length) {
          const item2 = SPACE_AMENITIES_LIST[i + 1];
          const isSel2 = selected.includes(item2);
          row.push({
            text: `${isSel2 ? '🟢' : '⚪'} ${item2}`,
            callback_data: `space_amenity_toggle:${encodeURIComponent(item2)}`,
          });
        }
        gridRows.push(row);
      }

      gridRows.push([
        { text: '✅ Proceed to Sub-City Location ➡️', callback_data: 'space_amenities_proceed' },
      ]);
      gridRows.push([
        { text: '⬅️ Back to Share', callback_data: 'space_back_to_share' },
        { text: '🏠 Cancel', callback_data: 'nav_start' },
      ]);

      const text = `
🏠 <b>SpaceMatch · Space Owner (Step 4 of 6)</b>
✨ <b>What I have / Amenities:</b>
<i>(Tap amenities to toggle on/off, then tap Proceed)</i>

<b>Selected:</b> <code>${selected.join(', ') || 'None selected'}</code>
      `.trim();

      return await sendOrEditCard(chatId, text, gridRows, activeMsgId);
    };

    const sendSpaceStep5Subcity = async (
      chatId: number,
      draft: Record<string, any>,
      messageIdToEdit?: number
    ) => {
      const activeMsgId = messageIdToEdit || draft.card_msg_id;
      await saveSession({
        telegram_id: chatId,
        step: 'space_subcity_select',
        draft_data: { ...draft, card_msg_id: activeMsgId },
        updated_at: new Date().toISOString(),
      });

      const gridRows: any[] = [];
      for (let i = 0; i < ALL_SUBCITIES.length; i += 2) {
        const row = [];
        const item1 = ALL_SUBCITIES[i];
        row.push({ text: item1, callback_data: `space_subcity:${item1}` });
        if (i + 1 < ALL_SUBCITIES.length) {
          const item2 = ALL_SUBCITIES[i + 1];
          row.push({ text: item2, callback_data: `space_subcity:${item2}` });
        }
        gridRows.push(row);
      }

      gridRows.push([
        { text: '⬅️ Back to Amenities', callback_data: 'space_back_to_amenities' },
        { text: '🏠 Cancel', callback_data: 'nav_start' },
      ]);

      const text = `
🏠 <b>SpaceMatch · Space Owner (Step 5 of 6)</b>
📍 <b>Which sub-city is your space located in?</b>
<i>Select the sub-city where your flat/room is:</i>
      `.trim();

      return await sendOrEditCard(chatId, text, gridRows, activeMsgId);
    };

    const sendSpaceStep6Photos = async (
      chatId: number,
      draft: Record<string, any>,
      messageIdToEdit?: number
    ) => {
      const activeMsgId = messageIdToEdit || draft.card_msg_id;
      const photos: string[] = draft.space_photos || [];

      await saveSession({
        telegram_id: chatId,
        step: 'space_input_photos',
        draft_data: { ...draft, space_photos: photos, card_msg_id: activeMsgId },
        updated_at: new Date().toISOString(),
      });

      const text = `
🏠 <b>SpaceMatch · Space Owner (Step 6 of 6)</b>
📸 <b>Upload Photos of the Space</b>

Please send 1 or more photos of your room/flat now! Prospected roommates will see these photos directly on the channel post.

<i>(Photos are shared directly in the post and are not stored in database tables)</i>

${photos.length > 0 ? `✅ <b>${photos.length} photo(s) uploaded!</b>\n\n` : ''}<i>Send photos as photos (not files). When finished, tap Proceed below:</i>
      `.trim();

      const inlineKeyboard = [
        ...(photos.length > 0
          ? [[{ text: `➡️ Proceed with ${photos.length} Photo(s) 🚀`, callback_data: 'space_photos_done' }]]
          : []),
        [{ text: '⏭️ Skip Photos (Text-Only Post)', callback_data: 'space_photos_skip' }],
        [{ text: '⬅️ Back to Subcity', callback_data: 'space_back_to_subcity' }],
        [{ text: '🏠 Cancel', callback_data: 'nav_start' }],
      ];

      return await sendOrEditCard(chatId, text, inlineKeyboard, activeMsgId);
    };

    const sendSpacePreviewCard = async (
      chatId: number,
      draft: Record<string, any>,
      messageIdToEdit?: number
    ) => {
      const subcity = draft.preferred_subcity?.[0] || draft.location || 'Addis Ababa';
      const rentStr = Number(draft.space_rent || 0).toLocaleString();
      const shareStr = Number(draft.space_share || 0).toLocaleString();
      const amenitiesStr = Array.isArray(draft.space_amenities) && draft.space_amenities.length > 0
        ? draft.space_amenities.join(', ')
        : 'WiFi, Kitchen, Water supply';
      const photosCount = draft.space_photos?.length || 0;
      const displayCode = draft.display_code || `RM${chatId.toString().slice(-4)}`;

      const text = `
🏠 <b>SpaceMatch · Preview: Roommate available with a Room</b>
📍 <code>${subcity}</code> · 🛡️ <b>Fayda Verified ✅</b>

• <b>Space Type:</b> ${draft.space_type || 'Private Bedroom in Shared Flat'}
• <b>Total Rent:</b> <code>${rentStr} ETB / month</code>
• <b>Roommate's Share:</b> <code>${shareStr} ETB / month</code>
• <b>Amenities:</b> ${amenitiesStr}
• <b>Space Photos:</b> ${photosCount} photo(s) attached
• <b>Resident:</b> ${draft.gender || 'Member'}, Age ${draft.age || 24}

<blockquote>"${draft.roommate_traits || 'Roommate available with a room in Addis Ababa.'}"</blockquote>

<i>Tapping submit will send your space listing to the channel administrators for review and approval!</i>
      `.trim();

      const inlineKeyboard = [
        [
          {
            text: '📢 Submit for Admin Approval 🚀',
            callback_data: `space_submit_admin:${displayCode}`,
          },
        ],
        [
          { text: '✏️ Edit Space Details', callback_data: 'post_branch_space' },
          { text: '🏠 Main Menu', callback_data: 'nav_start' },
        ],
      ];

      return await sendOrEditCard(chatId, text, inlineKeyboard, messageIdToEdit);
    };

    // ── Helper: Admin Channel Post Wizard Card Helpers ─────────────────────────
    const sendAdminPostCategoryStep = async (chatId: number, messageIdToEdit?: number) => {
      await saveSession({
        telegram_id: chatId,
        step: 'admin_post_cat',
        draft_data: { card_msg_id: messageIdToEdit },
        updated_at: new Date().toISOString(),
      });

      const text = `
📢 <b>SpaceMatch Admin · Publish Listing to Channel</b>
<i>Select the category of the post to broadcast to @roommatch_addis:</i>
      `.trim();

      const inlineKeyboard = [
        [{ text: '👥 Roommate Seeker (#RM...)', callback_data: 'admin_post_cat:roommate' }],
        [{ text: '🏠 Room Available in Shared Flat (#RM...)', callback_data: 'admin_post_cat:room_avail' }],
        [{ text: '🏢 Entire House / Property (#SP...)', callback_data: 'admin_post_cat:entire' }],
        [{ text: '🏠 Cancel', callback_data: 'nav_start' }],
      ];

      return await sendOrEditCard(chatId, text, inlineKeyboard, messageIdToEdit);
    };

    const sendAdminPostSubcitiesStep = async (
      chatId: number,
      draft: Record<string, any>,
      messageIdToEdit?: number
    ) => {
      const activeMsgId = messageIdToEdit || draft.card_msg_id;
      const selectedList: string[] = draft.locations || ['Bole'];
      const isAllSelected = ALL_SUBCITIES.every((s) => selectedList.includes(s));

      await saveSession({
        telegram_id: chatId,
        step: 'admin_post_subs',
        draft_data: { ...draft, locations: selectedList, card_msg_id: activeMsgId },
        updated_at: new Date().toISOString(),
      });

      const gridRows: any[] = [];
      gridRows.push([
        {
          text: isAllSelected ? '✅ All Selected' : '🌐 Select ALL Sub-Cities',
          callback_data: 'admin_post_sub_all',
        },
      ]);

      for (let i = 0; i < ALL_SUBCITIES.length; i += 2) {
        const row = [];
        const item1 = ALL_SUBCITIES[i];
        const isSel1 = selectedList.includes(item1);
        row.push({
          text: `${isSel1 ? '🟢' : '⚪'} ${item1}`,
          callback_data: `admin_post_sub_toggle:${item1}`,
        });

        if (i + 1 < ALL_SUBCITIES.length) {
          const item2 = ALL_SUBCITIES[i + 1];
          const isSel2 = selectedList.includes(item2);
          row.push({
            text: `${isSel2 ? '🟢' : '⚪'} ${item2}`,
            callback_data: `admin_post_sub_toggle:${item2}`,
          });
        }
        gridRows.push(row);
      }

      gridRows.push([
        { text: 'Proceed to Price / Rent ➡️', callback_data: 'admin_post_proceed_budget' },
      ]);
      gridRows.push([
        { text: '⬅️ Back to Category', callback_data: 'admin_post_start' },
        { text: '🏠 Cancel', callback_data: 'nav_start' },
      ]);

      const text = `
📢 <b>SpaceMatch Admin · Step 2: Select Sub-Cities</b>
<i>(Tap areas to toggle checkmarks, then tap Proceed)</i>

<b>Selected:</b> <code>${selectedList.join(', ')}</code>
      `.trim();

      await sendOrEditCard(chatId, text, gridRows, activeMsgId);
    };

    const sendAdminPostBudgetStep = async (
      chatId: number,
      draft: Record<string, any>,
      messageIdToEdit?: number,
      errorMsg?: string
    ) => {
      const activeMsgId = messageIdToEdit || draft.card_msg_id;
      await saveSession({
        telegram_id: chatId,
        step: 'admin_post_budget',
        draft_data: { ...draft, card_msg_id: activeMsgId },
        updated_at: new Date().toISOString(),
      });

      const text = `
📢 <b>SpaceMatch Admin · Step 3: Rent / Budget Cap</b>
${errorMsg ? `⚠️ <b>${errorMsg}</b>\n\n` : ''}💰 <b>Please reply with the monthly rent or budget cap in ETB:</b>
<i>(Example: <code>10000</code> or <code>15000</code>)</i>
      `.trim();

      const inlineKeyboard = [
        [{ text: '⬅️ Back to Sub-Cities', callback_data: 'admin_post_back_to_subs' }],
        [{ text: '🏠 Cancel', callback_data: 'nav_start' }],
      ];

      await sendOrEditCard(chatId, text, inlineKeyboard, activeMsgId);
    };

    const sendAdminPostGenderStep = async (
      chatId: number,
      draft: Record<string, any>,
      messageIdToEdit?: number
    ) => {
      const activeMsgId = messageIdToEdit || draft.card_msg_id;
      await saveSession({
        telegram_id: chatId,
        step: 'admin_post_gender',
        draft_data: { ...draft, card_msg_id: activeMsgId },
        updated_at: new Date().toISOString(),
      });

      const text = `
📢 <b>SpaceMatch Admin · Step 4: Gender Preference</b>
<i>Select gender preference for this listing:</i>
      `.trim();

      const inlineKeyboard = [
        [
          { text: '👨 Male', callback_data: 'admin_post_gender:Male' },
          { text: '👩 Female', callback_data: 'admin_post_gender:Female' },
          { text: '🤝 Any / No Pref', callback_data: 'admin_post_gender:Any' },
        ],
        [{ text: '⬅️ Back to Price', callback_data: 'admin_post_back_to_budget' }],
        [{ text: '🏠 Cancel', callback_data: 'nav_start' }],
      ];

      await sendOrEditCard(chatId, text, inlineKeyboard, activeMsgId);
    };

    const sendAdminPostBioStep = async (
      chatId: number,
      draft: Record<string, any>,
      messageIdToEdit?: number
    ) => {
      const activeMsgId = messageIdToEdit || draft.card_msg_id;
      await saveSession({
        telegram_id: chatId,
        step: 'admin_post_bio',
        draft_data: { ...draft, card_msg_id: activeMsgId },
        updated_at: new Date().toISOString(),
      });

      const text = `
📢 <b>SpaceMatch Admin · Step 5: Listing Description</b>

Please reply with the description, perks, or notes for this channel post.
<i>(Or reply with <code>default</code> to use standard description)</i>
      `.trim();

      const inlineKeyboard = [
        [{ text: '⚡ Use Standard Description', callback_data: 'admin_post_use_default_bio' }],
        [{ text: '🏠 Cancel', callback_data: 'nav_start' }],
      ];

      await sendOrEditCard(chatId, text, inlineKeyboard, activeMsgId);
    };

    const sendAdminPostPreviewCard = async (
      chatId: number,
      draft: Record<string, any>,
      messageIdToEdit?: number
    ) => {
      const activeMsgId = messageIdToEdit || draft.card_msg_id;
      const subcitiesStr = Array.isArray(draft.locations) && draft.locations.length > 0
        ? draft.locations.join(', ')
        : 'Addis Ababa';
      const budgetNum = draft.budget || 10000;
      const genderStr = draft.gender || 'Any';
      const bioStr = draft.details || 'Seeking compatible roommate in Addis Ababa.';
      const catTitle = draft.category === 'entire' ? 'Property Listing' : 'Roommate Listing';

      const previewText = `
📋 <b>SpaceMatch Admin · Review Channel Post</b>
<i>This listing will be saved to Supabase first, then published to @roommatch_addis with tracking buttons:</i>

━━━━━━━━━━━━━━━━━━━━━
✨ <b>SpaceMatch · ${catTitle} #RM...</b>
📍 <code>${subcitiesStr}</code> · 🛡️ <b>Fayda Verified ✅</b>

• <b>Gender:</b> ${genderStr}
• <b>Budget Cap / Rent:</b> <code>Up to ${Number(budgetNum).toLocaleString()} ETB / month</code>

<blockquote>"${bioStr}"</blockquote>

🔒 <i>Personal identity & direct contact remain sealed until mutual match unlock.</i>
━━━━━━━━━━━━━━━━━━━━━
      `.trim();

      const inlineKeyboard = [
        [{ text: '📢 Publish to Channel Live 🚀', callback_data: 'admin_post_confirm' }],
        [
          { text: '✏️ Restart / Edit Details', callback_data: 'admin_post_start' },
          { text: '🏠 Cancel', callback_data: 'nav_start' },
        ],
      ];

      await sendOrEditCard(chatId, previewText, inlineKeyboard, activeMsgId);
    };

    // Helper: Send Primary Start / Main Menu Screen
    const sendPrimaryWelcomeMenu = async (chatId: number, messageIdToEdit?: number) => {
      // Ensure the menu button in Telegram is reset to commands menu so mobile keyboards are unobstructed
      setChatMenuButton({ type: 'commands' }, chatId).catch(() => {});

      const adminIds = await getAdminIds();
      const isAdmin = adminIds.includes(chatId);

      const welcomeText = `
✨ <b>SpaceMatch Addis</b>
<i>Addis Ababa's Premier Verified Housing Community</i>

• 🛡️ <b>Fayda ID Verified</b> · 100% Genuine Renters
• 🔒 <b>Privacy-First</b> · Contacts Sealed Until Paid Match
• ⚡ <b>Instant Engine</b> · Intelligent Matchmaking

<blockquote>Select an option below to get started:</blockquote>
      `.trim();

      const inlineKeyboard = [
        [
          {
            text: '🔍 Search Roommate for Me Based on My Preferences',
            callback_data: 'search_roommate_start',
          },
        ],
        [
          {
            text: '📢 Post My Profile on the Channel',
            callback_data: 'post_profile_start',
          },
        ],
        ...(isAdmin
          ? [
              [
                {
                  text: '👑 Admin Control Panel 🛠️',
                  callback_data: 'admin_menu',
                },
              ],
            ]
          : []),
      ];

      const activeId = await sendOrEditCard(chatId, welcomeText, inlineKeyboard, messageIdToEdit);
      await saveSession({
        telegram_id: chatId,
        step: 'idle',
        draft_data: { card_msg_id: activeId },
        updated_at: new Date().toISOString(),
      });
    };

    // Helper: Send My Active Listings & Close Management Screen
    const sendMyListingsScreen = async (chatId: number, messageIdToEdit?: number) => {
      let text = `✨ <b>SpaceMatch</b> · <b>My Listings &amp; Status</b>\n\n`;
      const buttons: any[] = [];
      let count = 0;

      try {
        const { data: profs } = await supabaseAdmin
          .from('profiles')
          .select('*')
          .eq('telegram_id', chatId)
          .limit(5);

        if (profs && profs.length > 0) {
          for (const p of profs) {
            count++;
            const isClosed = p.status === 'matched' || p.status === 'closed';
            const statusBadge = isClosed ? '🔴 CLOSED' : '🟢 ACTIVE ON CHANNEL';
            text += `🤝 <b>Roommate #${p.display_code}</b> · ${statusBadge}\n• 📍 <code>${(p.locations || []).join(', ') || 'Addis Ababa'}</code>\n• 💰 <code>${Number(p.budget_max || p.budget_min || 0).toLocaleString()} ETB/month</code>\n\n`;
            if (!isClosed) {
              buttons.push([{ text: `🔴 Mark #${p.display_code} as Matched & Close`, callback_data: `user_close_listing:${p.id}` }]);
            }
          }
        }
      } catch {}

      try {
        const { data: rmList } = await supabaseAdmin
          .from('roommate_profiles')
          .select('*')
          .eq('user_telegram_id', chatId)
          .limit(5);

        if (rmList && rmList.length > 0) {
          for (const rm of rmList) {
            count++;
            const code = rm.display_code || `RM${rm.id.slice(0, 4)}`;
            const isClosed = rm.status === 'matched' || rm.status === 'closed';
            const statusBadge = isClosed ? '🔴 CLOSED' : '🟢 ACTIVE ON CHANNEL';
            text += `👥 <b>Seeker Listing #${code}</b> · ${statusBadge}\n• 📍 <code>${(rm.preferred_subcity || []).join(', ')}</code>\n• 💰 <code>${Number(rm.budget_max || 0).toLocaleString()} ETB/month</code>\n\n`;
            if (!isClosed) {
              buttons.push([{ text: `🔴 Mark #${code} as Matched & Close`, callback_data: `user_close_listing:${rm.id}` }]);
            }
          }
        }
      } catch {}

      if (count === 0) {
        text += `<blockquote>You do not have any active channel listings yet. Post your profile to broadcast to our Telegram community!</blockquote>\n\n`;
        buttons.push([{ text: '👥 Post Seeker Profile', callback_data: 'seeker_flow' }]);
      }

      buttons.push([
        { text: '⚡ Find Roommates · Matchmaker 🔍', callback_data: 'matchmaker_start' },
        { text: '🏠 Main Menu', callback_data: 'nav_start' },
      ]);

      await sendOrEditCard(chatId, text.trim(), buttons, messageIdToEdit);
    };

    // Helper: Platform Help & User Guide
    const sendHelpGuide = async (chatId: number, messageIdToEdit?: number) => {
      const guideText = `
✨ <b>SpaceMatch Addis · User Guide</b>

Welcome to SpaceMatch Addis, the premier verified housing platform in Addis Ababa!

🎯 <b>1. Roommate Matchmaker</b>
• Tap <b>Find a Roommate</b> or use <code>/match</code>
• Select your target sub-cities (Bole, Kazanchis, etc.)
• Type your exact age and rent budget
• Instantly browse verified roommate seekers sorted by compatibility!

👥 <b>2. Post Your Seeker Profile</b>
• Type <code>/seeker</code> to publish your housing requirements
• Set your lifestyle traits, habits, and move-in date
• Get featured on our channel and matched automatically!

🛡️ <b>3. Fayda ID Verification</b>
• All listings are verified with Fayda National ID to eliminate scams and ensure complete security.

💳 <b>4. Verified Contact Unlocks</b>
• Anonymous until ready: unlock verified phone numbers and Telegram handles for <b>50 ETB</b> via Telebirr or CBE.

📱 <b>Bot Commands:</b>
• <code>/start</code> — Main Menu & Dashboard
• <code>/match</code> — Roommate Matchmaker
• <code>/seeker</code> — Post Seeker Profile
• <code>/post</code> — List Room or Apartment
• <code>/myorders</code> — View Unlocked Contacts
• <code>/browse</code> — Launch SpaceMatch Mini App
• <code>/support</code> — Contact Live Support
      `.trim();

      const keyboard = [
        [
          { text: '🔍 Find a Roommate', callback_data: 'matchmaker_start' },
          { text: '👥 Post Seeker Profile', callback_data: 'seeker_flow' },
        ],
        [{ text: '🏠 Back to Main Menu', callback_data: 'nav_start' }],
      ];

      await sendOrEditCard(chatId, guideText, keyboard, messageIdToEdit);
    };

    // =========================================================================
    // MATCHMAKER PREFERENCE WIZARD STEPS
    // =========================================================================

    // Matchmaker Step 1: Sub-Cities Selection (In-Place Edit)
    const sendMatchmakerSubcityStep = async (
      chatId: number,
      currentDraft: Record<string, any> = {},
      messageIdToEdit?: number
    ) => {
      // Universal Gate: Fayda Verification required before matching/finding roommates
      if (!(await isUserFaydaVerified(chatId))) {
        await sendFaydaGateCard(chatId, 'use the Smart Matchmaker to find a roommate', messageIdToEdit);
        return;
      }

      const selectedList: string[] = currentDraft.match_subcities || [];
      const isAllSelected = ALL_SUBCITIES.every((s) => selectedList.includes(s));

      const gridRows: any[] = [];

      gridRows.push([
        {
          text: isAllSelected
            ? '✅ All Selected (Proceed ➡️)'
            : '🌐 Select ALL Sub-Cities & Proceed ➡️',
          callback_data: 'match_select_all_subs',
        },
      ]);

      for (let i = 0; i < ALL_SUBCITIES.length; i += 2) {
        const row = [];
        const item1 = ALL_SUBCITIES[i];
        const isSel1 = selectedList.includes(item1);
        row.push({
          text: `${isSel1 ? '🟢' : '⚪'} ${item1}`,
          callback_data: `match_toggle_sub:${item1}`,
        });

        if (i + 1 < ALL_SUBCITIES.length) {
          const item2 = ALL_SUBCITIES[i + 1];
          const isSel2 = selectedList.includes(item2);
          row.push({
            text: `${isSel2 ? '🟢' : '⚪'} ${item2}`,
            callback_data: `match_toggle_sub:${item2}`,
          });
        }
        gridRows.push(row);
      }

      gridRows.push([
        {
          text: `➡️ Next: My Gender (${selectedList.length} Selected)`,
          callback_data: 'match_goto_gender',
        },
      ]);
      gridRows.push([{ text: '🏠 Main Menu', callback_data: 'nav_start' }]);

      const text = `📍 <b>Where would you like to live in Addis Ababa?</b>\n<i>Choose areas below or select all:</i>`;

      const targetMsgId = messageIdToEdit || currentDraft.card_msg_id;
      const activeMsgId = await sendOrEditCard(chatId, text, gridRows, targetMsgId);
      if (activeMsgId) currentDraft.card_msg_id = activeMsgId;

      await saveSession({
        telegram_id: chatId,
        step: 'awaiting_match_subcities',
        draft_data: currentDraft,
        updated_at: new Date().toISOString(),
      });
    };

    // Matchmaker Step 2: My Gender (In-Place Edit)
    const sendMatchmakerGenderStep = async (
      chatId: number,
      currentDraft: Record<string, any> = {},
      messageIdToEdit?: number
    ) => {
      const text = `👤 <b>What is your gender?</b>`;

      const keyboard = [
        [
          { text: '👩 Female', callback_data: 'match_set_my_gender:Female' },
          { text: '👨 Male', callback_data: 'match_set_my_gender:Male' },
        ],
        [
          { text: '⬅️ Back to Areas', callback_data: 'matchmaker_start' },
          { text: '🏠 Main Menu', callback_data: 'nav_start' },
        ],
      ];

      const targetMsgId = messageIdToEdit || currentDraft.card_msg_id;
      const activeMsgId = await sendOrEditCard(chatId, text, keyboard, targetMsgId);
      if (activeMsgId) currentDraft.card_msg_id = activeMsgId;

      await saveSession({
        telegram_id: chatId,
        step: 'awaiting_match_gender',
        draft_data: currentDraft,
        updated_at: new Date().toISOString(),
      });
    };

    // Matchmaker Step 3: My Age (Direct Numerical Input - In-Place Edit)
    const sendMatchmakerAgeStep = async (
      chatId: number,
      currentDraft: Record<string, any> = {},
      messageIdToEdit?: number,
      errorMessage?: string
    ) => {
      const header = errorMessage ? `${errorMessage}\n\n` : '';
      const text = `${header}🎂 <b>How old are you?</b>\n<i>Type your age in chat (e.g. <code>24</code>):</i>`;

      const keyboard = [
        [
          { text: '⬅️ Back to Gender', callback_data: 'match_goto_gender' },
          { text: '🏠 Main Menu', callback_data: 'nav_start' },
        ],
      ];

      const targetMsgId = messageIdToEdit || currentDraft.card_msg_id;
      const activeMsgId = await sendOrEditCard(chatId, text, keyboard, targetMsgId);
      if (activeMsgId) currentDraft.card_msg_id = activeMsgId;

      await saveSession({
        telegram_id: chatId,
        step: 'awaiting_match_age',
        draft_data: currentDraft,
        updated_at: new Date().toISOString(),
      });
    };

    // Matchmaker Step 4: Roommate Gender Preference (In-Place Edit)
    const sendMatchmakerPrefGenderStep = async (
      chatId: number,
      currentDraft: Record<string, any> = {},
      messageIdToEdit?: number
    ) => {
      const text = `👥 <b>Who do you prefer to live with?</b>`;

      const keyboard = [
        [
          { text: '👩 Female Only', callback_data: 'match_set_pref_gender:Female' },
          { text: '👨 Male Only', callback_data: 'match_set_pref_gender:Male' },
        ],
        [
          { text: '👫 Any Gender Compatible', callback_data: 'match_set_pref_gender:Any' },
        ],
        [
          { text: '⬅️ Back to Age', callback_data: 'match_goto_age' },
          { text: '🏠 Main Menu', callback_data: 'nav_start' },
        ],
      ];

      const targetMsgId = messageIdToEdit || currentDraft.card_msg_id;
      const activeMsgId = await sendOrEditCard(chatId, text, keyboard, targetMsgId);
      if (activeMsgId) currentDraft.card_msg_id = activeMsgId;

      await saveSession({
        telegram_id: chatId,
        step: 'awaiting_match_pref_gender',
        draft_data: currentDraft,
        updated_at: new Date().toISOString(),
      });
    };

    // Matchmaker Step 5: Monthly Rent Budget (Direct Input or Any Budget - In-Place Edit)
    const sendMatchmakerBudgetStep = async (
      chatId: number,
      currentDraft: Record<string, any> = {},
      messageIdToEdit?: number,
      errorMessage?: string
    ) => {
      const header = errorMessage ? `${errorMessage}\n\n` : '';
      const text = `${header}💰 <b>What is your maximum monthly rent budget?</b>\n<i>Type your budget in Birr (e.g. <code>8000</code> or <code>15k</code>), or tap below:</i>`;

      const keyboard = [
        [
          { text: '⚡ Any Budget (No Cap)', callback_data: 'match_set_budget:0' },
        ],
        [
          { text: '⬅️ Back to Preference', callback_data: 'match_goto_pref_gender' },
          { text: '🏠 Main Menu', callback_data: 'nav_start' },
        ],
      ];

      const targetMsgId = messageIdToEdit || currentDraft.card_msg_id;
      const activeMsgId = await sendOrEditCard(chatId, text, keyboard, targetMsgId);
      if (activeMsgId) currentDraft.card_msg_id = activeMsgId;

      await saveSession({
        telegram_id: chatId,
        step: 'awaiting_match_budget_input',
        draft_data: currentDraft,
        updated_at: new Date().toISOString(),
      });
    };

    // =========================================================================
    // SEEKER PROFILE CREATION WIZARD STEPS
    // =========================================================================

    // Helper: Seeker Step 1 (Sub-Cities Grid Keyboard - In-Place Editing)
    const sendSeekerSubcityStep = async (
      chatId: number,
      currentDraft: Record<string, any> = {},
      messageIdToEdit?: number
    ) => {
      // Universal Gate: Fayda Verification required before posting seeker profile
      if (!(await isUserFaydaVerified(chatId))) {
        await sendFaydaGateCard(chatId, 'post a Roommate Seeker Profile', messageIdToEdit);
        return;
      }

      const selectedList: string[] = currentDraft.preferred_subcity || [];
      const isAllSelected = ALL_SUBCITIES.every((s) => selectedList.includes(s));

      const gridRows: any[] = [];

      gridRows.push([
        {
          text: isAllSelected
            ? '✅ All Selected (Proceed ➡️)'
            : '🌐 Select ALL Sub-Cities & Proceed ➡️',
          callback_data: 'seeker_select_all_and_proceed',
        },
      ]);

      for (let i = 0; i < ALL_SUBCITIES.length; i += 2) {
        const row = [];
        const item1 = ALL_SUBCITIES[i];
        const isSel1 = selectedList.includes(item1);
        row.push({
          text: `${isSel1 ? '🟢' : '⚪'} ${item1}`,
          callback_data: `seeker_toggle_sub:${item1}`,
        });

        if (i + 1 < ALL_SUBCITIES.length) {
          const item2 = ALL_SUBCITIES[i + 1];
          const isSel2 = selectedList.includes(item2);
          row.push({
            text: `${isSel2 ? '🟢' : '⚪'} ${item2}`,
            callback_data: `seeker_toggle_sub:${item2}`,
          });
        }
        gridRows.push(row);
      }

      gridRows.push([
        {
          text: `➡️ Next: My Gender (${selectedList.length} Selected)`,
          callback_data: 'seeker_goto_gender',
        },
      ]);
      gridRows.push([{ text: '🏠 Main Menu', callback_data: 'nav_start' }]);

      const text = `📍 <b>Where would you like to live in Addis Ababa?</b>\n<i>Choose areas below or select all:</i>`;

      const targetMsgId = messageIdToEdit || currentDraft.card_msg_id;
      const activeMsgId = await sendOrEditCard(chatId, text, gridRows, targetMsgId);
      if (activeMsgId) currentDraft.card_msg_id = activeMsgId;

      await saveSession({
        telegram_id: chatId,
        step: 'awaiting_seeker_subcities_grid',
        draft_data: currentDraft,
        updated_at: new Date().toISOString(),
      });
    };

    // Helper: Seeker Step 2 (My Gender)
    const sendSeekerMyGenderStep = async (chatId: number, currentDraft: Record<string, any> = {}, messageIdToEdit?: number) => {
      const text = `👤 <b>What is your gender?</b>`;

      const keyboard = [
        [
          { text: '👩 Female', callback_data: 'seeker_my_gender:Female' },
          { text: '👨 Male', callback_data: 'seeker_my_gender:Male' },
        ],
        [{ text: '⬅️ Back to Areas', callback_data: 'seeker_subcity_menu' }],
      ];

      const targetMsgId = messageIdToEdit || currentDraft.card_msg_id;
      const activeMsgId = await sendOrEditCard(chatId, text, keyboard, targetMsgId);
      if (activeMsgId) currentDraft.card_msg_id = activeMsgId;

      await saveSession({
        telegram_id: chatId,
        step: 'awaiting_seeker_my_gender',
        draft_data: currentDraft,
        updated_at: new Date().toISOString(),
      });
    };

    // Helper: Seeker Step 3 (My Age - Direct Numerical Input)
    const sendSeekerAgeStep = async (
      chatId: number,
      currentDraft: Record<string, any> = {},
      messageIdToEdit?: number,
      errorMessage?: string
    ) => {
      const header = errorMessage ? `${errorMessage}\n\n` : '';
      const text = `${header}🎂 <b>How old are you?</b>\n<i>Type your age in chat (e.g. <code>24</code>):</i>`;

      const keyboard = [
        [
          { text: '⬅️ Back to Gender', callback_data: 'seeker_goto_gender' },
          { text: '🏠 Main Menu', callback_data: 'nav_start' },
        ],
      ];

      const targetMsgId = messageIdToEdit || currentDraft.card_msg_id;
      const activeMsgId = await sendOrEditCard(chatId, text, keyboard, targetMsgId);
      if (activeMsgId) currentDraft.card_msg_id = activeMsgId;

      await saveSession({
        telegram_id: chatId,
        step: 'awaiting_seeker_age',
        draft_data: currentDraft,
        updated_at: new Date().toISOString(),
      });
    };

    // Helper: Seeker Step 4 (Preferred Roommate Gender)
    const sendSeekerPrefGenderStep = async (chatId: number, currentDraft: Record<string, any> = {}, messageIdToEdit?: number) => {
      const text = `👥 <b>Who do you prefer to live with?</b>`;

      const keyboard = [
        [
          { text: '👩 Female Only', callback_data: 'seeker_pref_gender:Female' },
          { text: '👨 Male Only', callback_data: 'seeker_pref_gender:Male' },
        ],
        [
          { text: '👫 Any Gender Compatible', callback_data: 'seeker_pref_gender:Any' },
        ],
        [
          { text: '⬅️ Back to Age', callback_data: 'seeker_goto_age' },
          { text: '🏠 Main Menu', callback_data: 'nav_start' },
        ],
      ];

      const targetMsgId = messageIdToEdit || currentDraft.card_msg_id;
      const activeMsgId = await sendOrEditCard(chatId, text, keyboard, targetMsgId);
      if (activeMsgId) currentDraft.card_msg_id = activeMsgId;

      await saveSession({
        telegram_id: chatId,
        step: 'awaiting_seeker_pref_gender',
        draft_data: currentDraft,
        updated_at: new Date().toISOString(),
      });
    };

    // Helper: Seeker Step 5 (Budget Input - Direct Numerical ETB Amount)
    const sendSeekerBudgetStep = async (
      chatId: number,
      currentDraft: Record<string, any> = {},
      messageIdToEdit?: number,
      errorMessage?: string
    ) => {
      const header = errorMessage ? `${errorMessage}\n\n` : '';
      const text = `${header}💰 <b>What is your maximum monthly rent budget in ETB?</b>\n<i>Type your budget in chat (e.g. <code>8000</code> or <code>12000</code>):</i>`;

      const keyboard = [
        [
          { text: '⬅️ Back to Preference', callback_data: 'seeker_goto_pref_gender' },
          { text: '🏠 Main Menu', callback_data: 'nav_start' },
        ],
      ];

      const targetMsgId = messageIdToEdit || currentDraft.card_msg_id;
      const activeMsgId = await sendOrEditCard(chatId, text, keyboard, targetMsgId);
      if (activeMsgId) currentDraft.card_msg_id = activeMsgId;

      await saveSession({
        telegram_id: chatId,
        step: 'awaiting_seeker_budget_text',
        draft_data: currentDraft,
        updated_at: new Date().toISOString(),
      });
    };

    // Helper: Seeker Step 6 (Lifestyle Bio - Direct Input or Skip)
    const sendSeekerBioStep = async (chatId: number, currentDraft: Record<string, any> = {}, messageIdToEdit?: number) => {
      const text = `📝 <b>Tell us briefly about yourself:</b>\n<i>Type in chat below (e.g. "Quiet accountant, non-smoker") or skip below:</i>`;

      const keyboard = [
        [{ text: '⏭️ Skip Bio', callback_data: 'seeker_skip_bio' }],
        [
          { text: '⬅️ Back to Budget', callback_data: 'seeker_goto_budget' },
          { text: '🏠 Main Menu', callback_data: 'nav_start' },
        ],
      ];

      const targetMsgId = messageIdToEdit || currentDraft.card_msg_id;
      const activeMsgId = await sendOrEditCard(chatId, text, keyboard, targetMsgId);
      if (activeMsgId) currentDraft.card_msg_id = activeMsgId;

      await saveSession({
        telegram_id: chatId,
        step: 'awaiting_seeker_bio_text',
        draft_data: currentDraft,
        updated_at: new Date().toISOString(),
      });
    };

    // Helper: Seeker Step 7 (Phone Number - Direct Numerical Input)
    const sendSeekerPhoneStep = async (
      chatId: number,
      currentDraft: Record<string, any> = {},
      messageIdToEdit?: number,
      errorMessage?: string
    ) => {
      const header = errorMessage ? `${errorMessage}\n\n` : '';
      const text = `${header}📞 <b>What is your contact phone number?</b>\n<i>Type your Ethiopian phone number in chat (e.g. <code>0912345678</code>):</i>`;

      const keyboard = [
        [
          { text: '⬅️ Back to Bio', callback_data: 'seeker_goto_bio' },
          { text: '🏠 Main Menu', callback_data: 'nav_start' },
        ],
      ];

      const targetMsgId = messageIdToEdit || currentDraft.card_msg_id;
      const activeMsgId = await sendOrEditCard(chatId, text, keyboard, targetMsgId);
      if (activeMsgId) currentDraft.card_msg_id = activeMsgId;

      await saveSession({
        telegram_id: chatId,
        step: 'awaiting_seeker_phone',
        draft_data: currentDraft,
        updated_at: new Date().toISOString(),
      });
    };

    // Helper: Seeker Review & Final Submit
    const sendSeekerFaydaStep = async (chatId: number, currentDraft: Record<string, any> = {}, messageIdToEdit?: number) => {
      const subcitiesStr = (currentDraft.preferred_subcity || []).join(', ') || 'Addis Ababa';
      const cleanBio = (currentDraft.lifestyle_bio || 'Seeking compatible roommate').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      const summaryText = `
✨ <b>SpaceMatch</b> · <b>Profile Summary &amp; Review</b>
📍 <code>${subcitiesStr}</code>

• <b>Profile:</b> ${currentDraft.my_gender || 'Not specified'}${currentDraft.age ? `, <code>${currentDraft.age} yrs</code>` : ''} · Prefers: ${currentDraft.preferred_gender || 'Any'}
• <b>Monthly Budget:</b> <code>${Number(currentDraft.budget_max || 10000).toLocaleString()} ETB / month</code>
• <b>Contact Phone:</b> <code>${currentDraft.contact_phone || 'Provided'}</code>

<blockquote>"${cleanBio}"</blockquote>

🔒 <b>Privacy Shield Active:</b> Your real name, phone number, and Telegram username are 100% hidden and will NEVER be shown on public channel posts or public feeds. Contacts unlock only after verified payment.
      `.trim();

      const keyboard = [
        [{ text: '⚡ Publish to Channel & Matchmaker 🚀', callback_data: 'seeker_final_submit' }],
        [
          { text: '⬅️ Edit Details', callback_data: 'seeker_flow' },
          { text: '🏠 Main Menu', callback_data: 'nav_start' },
        ],
      ];

      const targetMsgId = messageIdToEdit || currentDraft.card_msg_id;
      const activeMsgId = await sendOrEditCard(chatId, summaryText, keyboard, targetMsgId);
      if (activeMsgId) currentDraft.card_msg_id = activeMsgId;

      await saveSession({
        telegram_id: chatId,
        step: 'awaiting_seeker_fayda_upload',
        draft_data: currentDraft,
        updated_at: new Date().toISOString(),
      });
    };

    // Helper: Automated Matchmaking Engine Driven directly by User's Input Criteria (Live DB & In-Place Paginated Feed)
    const executeAutomatedMatchmaker = async (
      chatId: number,
      criteria: {
        match_subcities?: string[];
        my_gender?: string;
        age?: number;
        age_bracket?: string;
        preferred_gender?: string;
        budget_max?: number;
      } = {},
      messageIdToEdit?: number,
      candidateIndex: number = 0
    ) => {
      const preferredSubs = criteria.match_subcities || [];
      const prefGender = criteria.preferred_gender || 'Any';
      const myGender = criteria.my_gender || '';
      const myAge = criteria.age ? Number(criteria.age) : undefined;
      const budgetMax = criteria.budget_max !== undefined ? Number(criteria.budget_max) : 100000;
      const ageBracket = criteria.age_bracket || '';

      // 1. Fetch live profiles from Supabase DB
      let dbProfiles: any[] = [];
      try {
        const { data } = await supabaseAdmin
          .from('roommate_profiles')
          .select('*, users(*)')
          .neq('status', 'matched')
          .neq('status', 'rejected')
          .order('created_at', { ascending: false })
          .limit(50);
        if (data) dbProfiles = data;
      } catch (e) {
        console.error('Error fetching DB roommate profiles for matching:', e);
      }

      // 2. Fetch local approved roommate drafts
      const localDraftsObj = await getAllRoommateDrafts();
      const localDrafts = Object.values(localDraftsObj);

      // 3. Fetch from profiles table (active/completed)
      let appProfiles: any[] = [];
      try {
        const { data: pData } = await supabaseAdmin
          .from('profiles')
          .select('*')
          .neq('status', 'matched')
          .order('created_at', { ascending: false })
          .limit(50);
        if (pData) appProfiles = pData;
      } catch {}

      // Combine profiles without duplicates
      const allProfiles: any[] = [];
      const seenIds = new Set<string>();

      for (const p of dbProfiles) {
        if (p.users?.telegram_id && String(p.users.telegram_id) === String(chatId)) continue;
        seenIds.add(p.id);
        allProfiles.push({
          id: p.id,
          user_name: p.users?.first_name || 'Verified Seeker',
          username: p.users?.username || null,
          age: p.age || p.users?.age || undefined,
          preferred_subcity: p.preferred_subcity || ['Addis Ababa'],
          my_gender: p.my_gender || 'Female',
          preferred_gender: p.preferred_gender || 'Any',
          budget_max: p.budget_max || 10000,
          lifestyle_bio: p.lifestyle_bio || 'Looking for compatible roommate in Addis Ababa.',
          fayda_status: p.users?.fayda_status || 'verified',
          unlock_fee: p.unlock_fee || 50,
          source: 'DB',
        });
      }

      for (const d of localDrafts) {
        if (d.user_telegram_id && String(d.user_telegram_id) === String(chatId)) continue;
        if (d.status === 'approved' && !seenIds.has(d.id)) {
          seenIds.add(d.id);
          allProfiles.push({
            id: d.id,
            user_name: d.user_name || 'Roommate Seeker',
            username: d.username || null,
            age: d.age,
            preferred_subcity: d.preferred_subcity || ['Bole'],
            my_gender: d.my_gender || 'Female',
            preferred_gender: d.preferred_gender || 'Any',
            budget_max: d.budget_max || 10000,
            lifestyle_bio: d.lifestyle_bio || 'Seeking a compatible roommate in Addis Ababa.',
            fayda_status: d.fayda_status || 'verified',
            unlock_fee: d.unlock_fee || 50,
            source: 'Draft',
          });
        }
      }

      for (const p of appProfiles) {
        if (p.telegram_id && String(p.telegram_id) === String(chatId)) continue;
        if (p.status === 'onboarding' || (!p.gender && !p.roommate_traits)) continue;
        if (!seenIds.has(p.id) && p.status !== 'matched') {
          seenIds.add(p.id);
          allProfiles.push({
            id: p.id,
            user_name: p.full_name || 'Verified Seeker',
            username: p.telegram_username || null,
            age: p.age || undefined,
            preferred_subcity: p.locations || ['Addis Ababa'],
            my_gender: p.gender || 'Female',
            preferred_gender: 'Any',
            budget_max: p.budget_max || 10000,
            lifestyle_bio: p.roommate_traits || 'Looking for compatible roommate in Addis Ababa.',
            fayda_status: p.kyc_status === 'verified' ? 'verified' : 'unverified',
            unlock_fee: 50,
            source: 'Profiles',
          });
        }
      }

      // Check empty state
      if (allProfiles.length === 0) {
        const emptyText = `
🔍 <b>SpaceMatch</b> · <b>No Roommate Profiles Yet</b>

There are currently no other active roommate listings in our database.

<blockquote>🌟 <b>Be Featured on Our Channel!</b>
Post your seeker profile now — it will broadcast directly to our Telegram channel so compatible roommates can connect with you!</blockquote>
        `.trim();

        const emptyKeyboard = {
          inline_keyboard: [
            [{ text: '➕ Post My Seeker Profile', callback_data: 'seeker_flow' }],
            [{ text: '🔄 Try Again', callback_data: 'matchmaker_start' }],
            [{ text: '🏠 Main Menu', callback_data: 'nav_start' }],
          ],
        };

        if (messageIdToEdit) {
          await sendTelegram('editMessageText', {
            chat_id: chatId,
            message_id: messageIdToEdit,
            text: emptyText,
            parse_mode: 'HTML',
            reply_markup: emptyKeyboard,
          });
        } else {
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: emptyText,
            parse_mode: 'HTML',
            reply_markup: emptyKeyboard,
          });
        }
        return;
      }

      // Calculate Match Score for each profile based on user's exact input
      const scoredMatches = allProfiles.map((prof) => {
        let score = 50;

        const profSubs: string[] = Array.isArray(prof.preferred_subcity) ? prof.preferred_subcity : [];
        if (preferredSubs.length === 0) {
          score += 20;
        } else {
          const hasSubcityOverlap = preferredSubs.some((s) =>
            profSubs.some((ps) => ps.toLowerCase() === s.toLowerCase())
          );
          if (hasSubcityOverlap) score += 30;
        }

        if (!budgetMax || budgetMax === 0 || prof.budget_max <= budgetMax * 1.25) {
          score += 15;
        }

        if (prefGender === 'Any' || prof.my_gender.toLowerCase() === prefGender.toLowerCase()) {
          score += 15;
        }
        if (!myGender || prof.preferred_gender === 'Any' || prof.preferred_gender.toLowerCase() === myGender.toLowerCase()) {
          score += 10;
        }

        if (prof.age && myAge) {
          const ageDiff = Math.abs(prof.age - myAge);
          if (ageDiff <= 2) score += 15;
          else if (ageDiff <= 5) score += 10;
          else if (ageDiff <= 8) score += 5;
        } else if (prof.age && ageBracket) {
          let ageMatch = false;
          if (ageBracket === '18-22' && prof.age >= 18 && prof.age <= 22) ageMatch = true;
          if (ageBracket === '23-27' && prof.age >= 23 && prof.age <= 27) ageMatch = true;
          if (ageBracket === '28-35' && prof.age >= 28 && prof.age <= 35) ageMatch = true;
          if (ageBracket === '36+' && prof.age >= 36) ageMatch = true;
          if (ageMatch) score += 10;
        }

        const finalScore = Math.min(Math.max(score, 65), 98);
        return { ...prof, matchScore: finalScore };
      });

      scoredMatches.sort((a, b) => b.matchScore - a.matchScore);

      if (scoredMatches.length === 0) {
        const noMatchesText = `
🔍 <b>SpaceMatch</b> · <b>No Exact Matches Found</b>

We could not find an exact match for your selected filters in those specific sub-cities right now.

<blockquote>💡 Try browsing all active seekers across Addis Ababa or post your seeker profile so compatible roommates can reach out to you!</blockquote>
        `.trim();

        const noMatchesKeyboard = {
          inline_keyboard: [
            [{ text: '🌐 Browse All Active Seekers', callback_data: 'match_browse_all' }],
            [{ text: '➕ Post My Seeker Profile', callback_data: 'seeker_flow' }],
            [{ text: '🔄 Change Filters', callback_data: 'matchmaker_start' }],
            [{ text: '🏠 Main Menu', callback_data: 'nav_start' }],
          ],
        };

        if (messageIdToEdit) {
          await sendTelegram('editMessageText', {
            chat_id: chatId,
            message_id: messageIdToEdit,
            text: noMatchesText,
            parse_mode: 'HTML',
            reply_markup: noMatchesKeyboard,
          });
        } else {
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: noMatchesText,
            parse_mode: 'HTML',
            reply_markup: noMatchesKeyboard,
          });
        }
        return;
      }

      // Paginated Single Card Display
      const safeIndex = Math.max(0, Math.min(candidateIndex, scoredMatches.length - 1));
      const match = scoredMatches[safeIndex];
      const subcitiesStr = Array.isArray(match.preferred_subcity)
        ? match.preferred_subcity.join(', ')
        : 'Addis Ababa';
      const badge = match.fayda_status === 'verified' ? 'VERIFIED ✅ 🛡️' : 'PENDING REVIEW ⚠️';
      const ageDisplay = match.age ? `, ${match.age} yrs` : '';
      const bioContent = (match.lifestyle_bio || 'Seeking a compatible roommate in Addis Ababa.').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      const matchCardText = `
🎯 <b>Match #${safeIndex + 1} of ${scoredMatches.length}</b> · <b>${match.matchScore}% Match</b>
📍 <code>${subcitiesStr}</code> · 🛡️ <b>${badge}</b>

• <b>Candidate:</b> Verified Seeker (${match.my_gender}${ageDisplay})
• <b>Looking For:</b> ${match.preferred_gender} Roommate
• <b>Monthly Budget:</b> <code>Up to ${Number(match.budget_max).toLocaleString()} ETB / month</code>

<blockquote>"${bioContent}"</blockquote>

🔒 <i>Personal identity, phone number, and Telegram handle are concealed until payment.</i>
      `.trim();

      const inlineKeyboardRows: any[] = [];

      // Primary Action: Unlock Contact Information
      inlineKeyboardRows.push([
        {
          text: '🔓 Unlock Contact Information',
          callback_data: `search_unlock_contact:${match.id}`,
        },
      ]);

      // Pagination Controls
      if (scoredMatches.length > 1) {
        const navRow: any[] = [];
        if (safeIndex > 0) {
          navRow.push({ text: '⬅️ Prev', callback_data: `match_page:${safeIndex - 1}` });
        }
        navRow.push({ text: `📄 ${safeIndex + 1} / ${scoredMatches.length}`, callback_data: 'match_noop' });
        if (safeIndex < scoredMatches.length - 1) {
          navRow.push({ text: 'Next ➡️', callback_data: `match_page:${safeIndex + 1}` });
        }
        inlineKeyboardRows.push(navRow);
      }

      // Actions & Navigation
      inlineKeyboardRows.push([
        { text: '🔍 Refine Filters', callback_data: 'matchmaker_start' },
        { text: '➕ Post My Profile', callback_data: 'seeker_flow' },
      ]);
      inlineKeyboardRows.push([
        { text: '📂 My Unlocked Contacts', callback_data: 'my_unlocked_contacts' },
        { text: '🏠 Main Menu', callback_data: 'nav_start' },
      ]);

      if (messageIdToEdit) {
        await sendTelegram('editMessageText', {
          chat_id: chatId,
          message_id: messageIdToEdit,
          text: matchCardText,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: inlineKeyboardRows },
        });
      } else {
        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: matchCardText,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: inlineKeyboardRows },
        });
      }
    };

    // Helper: Exact Direct Post Lock-On & Paywall
    const sendUnlockPaywallCard = async (
      chatId: number,
      targetId: string,
      targetType: 'roommate_profile' | 'space_listing',
      messageIdToEdit?: number
    ) => {
      // Universal Gate: Fayda Verification required before unlocking contact info
      if (!(await isUserFaydaVerified(chatId))) {
        await sendFaydaGateCard(chatId, 'unlock verified contact information', messageIdToEdit);
        return;
      }

      const unlockFee = 50.00;

      let title = 'Roommate Contact Unlock';
      let subcity = 'Addis Ababa';
      let genderInfo = '';
      let budgetInfo = '';
      let bioInfo = '';

      if (targetType === 'roommate_profile') {
        try {
          const { data: dbProf } = await supabaseAdmin
            .from('roommate_profiles')
            .select('*, users(*)')
            .eq('id', targetId)
            .single();
          if (dbProf) {
            title = `Verified Roommate Seeker (${dbProf.my_gender || 'Candidate'})`;
            subcity = Array.isArray(dbProf.preferred_subcity) ? dbProf.preferred_subcity.join(', ') : 'Addis Ababa';
            genderInfo = `👤 <b>Gender:</b> ${dbProf.my_gender} (Prefers: ${dbProf.preferred_gender})`;
            budgetInfo = `💰 <b>Budget:</b> Up to ${Number(dbProf.budget_max).toLocaleString()} ETB / month`;
            bioInfo = dbProf.lifestyle_bio || '';
          }
        } catch {}

        if (title === 'Roommate Contact Unlock' || title.startsWith('Verified Roommate Seeker')) {
          const draft = await getRoommateDraft(targetId);
          if (draft) {
            title = `Verified Roommate Seeker (${draft.my_gender || 'Candidate'})`;
            subcity = Array.isArray(draft.preferred_subcity) ? draft.preferred_subcity.join(', ') : 'Addis Ababa';
            genderInfo = `👤 <b>Gender:</b> ${draft.my_gender} (Prefers: ${draft.preferred_gender})`;
            budgetInfo = `💰 <b>Budget:</b> Up to ${Number(draft.budget_max).toLocaleString()} ETB / month`;
            bioInfo = draft.lifestyle_bio || '';
          } else {
            try {
              const { data: pData } = await supabaseAdmin
                .from('profiles')
                .select('*')
                .eq('id', targetId)
                .single();
              if (pData) {
                title = `Verified Roommate Seeker (${pData.gender || 'Candidate'})`;
                subcity = Array.isArray(pData.locations) ? pData.locations.join(', ') : 'Addis Ababa';
                genderInfo = `👤 <b>Gender:</b> ${pData.gender || 'Candidate'}`;
                budgetInfo = `💰 <b>Budget:</b> Up to ${Number(pData.budget_max || 10000).toLocaleString()} ETB / month`;
                bioInfo = pData.roommate_traits || '';
              }
            } catch {}
          }
        }
      } else {
        try {
          const { data: dbSpace } = await supabaseAdmin
            .from('spaces')
            .select('*')
            .eq('id', targetId)
            .single();
          if (dbSpace) {
            title = dbSpace.title;
            subcity = dbSpace.neighborhood || 'Addis Ababa';
            budgetInfo = `💰 <b>Price:</b> ${Number(dbSpace.price_per_month).toLocaleString()} ETB / month`;
            bioInfo = dbSpace.description || '';
          }
        } catch {}

        if (title === 'Roommate Contact Unlock') {
          const draft = await getDraft(targetId);
          if (draft) {
            title = draft.title;
            subcity = draft.neighborhood || 'Addis Ababa';
            budgetInfo = `💰 <b>Price:</b> ${Number(draft.price_per_month).toLocaleString()} ETB / month`;
            bioInfo = draft.description || '';
          }
        }
      }

      let orderId = `ord_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      try {
        const { data: newOrder } = await supabaseAdmin
          .from('orders')
          .insert({
            buyer_telegram_id: chatId,
            order_type: 'unlock_contact',
            target_type: targetType,
            target_id: targetId,
            amount: unlockFee,
            transaction_reference: `PENDING_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            payment_status: 'pending',
          })
          .select('id')
          .single();

        if (newOrder) orderId = newOrder.id;
      } catch {}

      const session = getSession(chatId);
      const targetMsgId = messageIdToEdit || session.draft_data?.card_msg_id;

      await saveSession({
        telegram_id: chatId,
        step: `awaiting_payment_for_unlock:${orderId}`,
        draft_data: { order_id: orderId, target_id: targetId, target_type: targetType, card_msg_id: targetMsgId },
        updated_at: new Date().toISOString(),
      });

      const cleanBio = bioInfo ? bioInfo.replace(/</g, '&lt;').replace(/>/g, '&gt;') : '';
      const paywallText = `
🔒 <b>SpaceMatch</b> · <b>Verified Contact Unlock</b>
📍 <code>${subcity}</code> · <b>Target:</b> ${title}

• <b>Contact Unlock Fee:</b> <code>${unlockFee} ETB</code>
${genderInfo ? `• ${genderInfo}\n` : ''}${budgetInfo ? `• ${budgetInfo}\n` : ''}${cleanBio ? `<blockquote>"${cleanBio}"</blockquote>\n` : ''}
💳 <b>Instant Payment Instructions:</b>
Transfer <code>${unlockFee} ETB</code> to either account:

📱 <b>Telebirr:</b> <code>${receiverPhone}</code> (SpaceMatch Addis)
🏦 <b>CBE Account:</b> <code>${cbeAccount}</code> (SpaceMatch Addis)

💬 <i>Once transferred, type your Transaction Reference Code (e.g. <code>FT24...</code> or <code>TX...</code>) here to unlock contact details immediately!</i>
      `.trim();

      const paywallKeyboard = [
        [
          { text: '⬅️ Back to Matches', callback_data: 'matchmaker_start' },
          { text: '🏠 Main Menu', callback_data: 'nav_start' },
        ],
      ];

      await sendOrEditCard(chatId, paywallText, paywallKeyboard, targetMsgId);
    };

    // Helper: Homeowner Space Prompts
    const sendPropertyTypePrompt = async (chatId: number, messageIdToEdit?: number) => {
      // Universal Gate: Fayda Verification required before listing spaces for rent
      if (!(await isUserFaydaVerified(chatId))) {
        await sendFaydaGateCard(chatId, 'list a property or space for rent', messageIdToEdit);
        return;
      }

      await saveSession({
        telegram_id: chatId,
        step: 'awaiting_property_type',
        draft_data: messageIdToEdit ? { card_msg_id: messageIdToEdit } : {},
        updated_at: new Date().toISOString(),
      });

      const text = `
🏠 <b>SpaceMatch Addis · List Space to Rent</b>

<b>What type of space are you renting out?</b>
      `.trim();

      const inlineKeyboard = [
        [{ text: '🛏️ Shared Room / Roommate Space', callback_data: 'prop_type:shared' }],
        [{ text: '🏠 Entire House / Apartment', callback_data: 'prop_type:entire' }],
        [{ text: '🏢 Office / Commercial Space', callback_data: 'prop_type:office' }],
        [{ text: '🏬 Shop / Commercial Venue', callback_data: 'prop_type:shop' }],
        [{ text: '🏠 Back to Main Menu', callback_data: 'nav_start' }],
      ];

      await sendOrEditCard(chatId, text, inlineKeyboard, messageIdToEdit);
    };

    // -------------------------------------------------------------------------
    // -1. HANDLE BOT CHAT MEMBER UPDATES (Bot added / removed as admin in any channel)
    // -------------------------------------------------------------------------
    if (update.my_chat_member) {
      const mcm = update.my_chat_member;
      const chat = mcm.chat;
      const newStatus = mcm.new_chat_member?.status;
      const addedBy = mcm.from?.id;

      if (chat && (chat.type === 'channel' || chat.type === 'supergroup')) {
        const channelId = chat.id;
        const channelTitle = chat.title || 'Channel';
        const channelUsername = chat.username ? `@${chat.username}` : null;

        if (newStatus === 'administrator') {
          await saveManagedChannel({
            channel_id: channelId,
            channel_title: channelTitle,
            channel_username: channelUsername,
            added_by: addedBy,
            is_active: true,
            added_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });

          // Invalidate admin cache so newly discovered channel's admins are recognized immediately
          cachedAdminIds = null;

          console.log(`[webhook] Bot added as admin to channel: ${channelTitle} (${channelId}) by user ${addedBy}`);

          // Notify the administrator who added the bot
          if (addedBy) {
            await sendTelegram('sendMessage', {
              chat_id: addedBy,
              text: `🎉 <b>Channel Successfully Connected to SpaceMatch!</b>\n\nSpaceMatch Bot is now an active administrator of <b>${channelTitle}</b> (${channelUsername || channelId}).\n\n• All administrators of this channel can now manage, approve, and close roommate listings via the bot.\n• Approved roommate listings will automatically broadcast to this channel with interactive 3-button cards!`,
              parse_mode: 'HTML',
            });
          }
        } else if (newStatus === 'left' || newStatus === 'kicked') {
          await removeManagedChannel(channelId);
          cachedAdminIds = null;
          console.log(`[webhook] Bot removed from channel: ${channelTitle} (${channelId})`);
        }
      }

      return NextResponse.json({ ok: true });
    }

    // -------------------------------------------------------------------------
    // 0. HANDLE CHANNEL POSTS & EDITED CHANNEL POSTS (Bot acts as Channel Admin)
    // -------------------------------------------------------------------------
    const channelPost = update.channel_post || update.edited_channel_post;
    if (channelPost && channelPost.chat) {
      const channelId = channelPost.chat.id;
      const messageId = channelPost.message_id;
      const postText = (channelPost.text || channelPost.caption || '').trim();

      // Skip if post is already marked as matched or closed
      if (postText.includes('MATCHED') || postText.includes('CLOSED')) {
        return NextResponse.json({ ok: true });
      }

      // Check if post already has the "Contact with Roommate" button
      const existingKb = channelPost.reply_markup?.inline_keyboard;
      const hasConnectBtn = existingKb?.some((row: any[]) =>
        row.some((btn: any) => btn.text?.includes('Contact with Roommate') || btn.text?.includes('Connect with Roommate'))
      );

      // Check if post was forwarded from bot (Checklist 1.3: direct channel posts without the bot are unaffected)
      const isForwardedFromBot = !!(
        (channelPost as any).forward_from?.is_bot ||
        (channelPost as any).forward_from_chat ||
        (channelPost as any).forward_origin
      );

      // Extract display_code (#RM... or RM...)
      let displayCode: string | null = null;
      const rmMatch = postText.match(/#?(RM[A-Za-z0-9_-]+)/i);
      if (rmMatch) {
        displayCode = rmMatch[1].toUpperCase();
      } else {
        const tagMatch = postText.match(/#([A-Za-z0-9_-]+)/);
        if (tagMatch) {
          displayCode = tagMatch[1].toUpperCase();
        }
      }

      if (!displayCode) {
        displayCode = `RM${messageId}`;
      }

      // Link channel_message_id in DB if displayCode matches existing profile or roommate_profile
      let targetFound = false;
      try {
        const { data: pRows } = await supabaseAdmin
          .from('profiles')
          .update({ channel_message_id: messageId })
          .ilike('display_code', displayCode)
          .select('id');
        if (pRows && pRows.length > 0) targetFound = true;

        const { data: rmRows } = await supabaseAdmin
          .from('roommate_profiles')
          .update({ channel_message_id: messageId })
          .ilike('display_code', displayCode)
          .select('id');
        if (rmRows && rmRows.length > 0) targetFound = true;
      } catch (linkErr) {
        console.error('[webhook] Error linking channel_message_id:', linkErr);
      }

      // If forwarded from the bot and buttons missing, attach the 3 standard buttons
      if (isForwardedFromBot && !hasConnectBtn) {
        const buttonTitle = `⚡ Contact with Roommate #${displayCode} ↗️`;
        const connectPayload = `req_${displayCode}`;

        if (!targetFound) {
          try {
            const adminIds = await getAdminIds();
            const adminChatId = adminIds[0] || 800701176;

            const commonSubcities = [
              'Bole', 'Kazanchis', 'Sarbet', 'CMC', 'Gerji', 'Megenagna', 'Piassa',
              '4 Kilo', '22 Mazoria', 'Bisrate Gabriel', 'Summit', 'Lebu', 'Jomo',
              'Ayat', 'Torhailoch', 'Bethel', 'Gotera', 'Kera', 'Nifas Silk',
              'Kolfe Keraniyo', 'Gullele', 'Lideta'
            ];
            const matchedSubs = commonSubcities.filter((s) =>
              postText.toLowerCase().includes(s.toLowerCase())
            );

            const budgetMatch = postText.match(/(\d+[\d,]*)\s*(etb|birr|\/mo|\/month|k\b)/i);
            let parsedBudget = 0;
            if (budgetMatch) {
              const rawNum = budgetMatch[1].replace(/,/g, '');
              parsedBudget = parseInt(rawNum, 10);
              if (budgetMatch[2]?.toLowerCase() === 'k') parsedBudget *= 1000;
            }

            const isFemale = postText.toLowerCase().includes('female') || postText.toLowerCase().includes('ሴት');
            const isMale = postText.toLowerCase().includes('male') || postText.toLowerCase().includes('ወንድ');
            const genderVal = isFemale ? 'Female' : isMale ? 'Male' : 'Any';

            await supabaseAdmin.from('profiles').upsert(
              {
                telegram_id: adminChatId,
                display_code: displayCode,
                channel_message_id: messageId,
                gender: genderVal,
                locations: matchedSubs.length > 0 ? matchedSubs : ['Addis Ababa'],
                budget_min: 0,
                budget_max: parsedBudget || 10000,
                roommate_traits: postText.slice(0, 300) || 'Channel Roommate Listing',
                kyc_status: 'verified',
                status: 'active',
                onboarding_step: 'completed',
              },
              { onConflict: 'display_code' }
            );
          } catch (createErr) {
            console.error('[webhook] Error creating channel post profile placeholder:', createErr);
          }
        }

        const newButtons = [
          [{ text: buttonTitle, url: `https://t.me/${botUsername}?start=${connectPayload}` }],
          [{ text: '📢 Post My Profile ↗️', url: `https://t.me/${botUsername}?start=post_profile` }],
          [{ text: '🔍 Search Roommate for Me ↗️', url: `https://t.me/${botUsername}?start=search_roommate` }],
        ];

        const updatedInlineKeyboard = existingKb && existingKb.length > 0
          ? [...existingKb, ...newButtons]
          : newButtons;

        const editRes = await sendTelegram('editMessageReplyMarkup', {
          chat_id: channelId,
          message_id: messageId,
          reply_markup: {
            inline_keyboard: updatedInlineKeyboard,
          },
        });

        console.log(`[webhook] editMessageReplyMarkup for channel post ${messageId} in ${channelId}:`, editRes?.ok ? 'SUCCESS' : editRes?.description);
      }

      return NextResponse.json({ ok: true });
    }

    // Check and trigger any pending 24-hour follow-up check-ins asynchronously
    checkPending24hCheckins().catch((err) => console.error('checkPending24hCheckins error:', err));

    // -------------------------------------------------------------------------
    // 1. HANDLE INLINE CALLBACK QUERIES
    // -------------------------------------------------------------------------
    if (update.callback_query) {
      const callback = update.callback_query;
      let callbackData: string = callback.data || '';
      const chatId: number = callback.message?.chat?.id || callback.from.id;
      const msgId: number | undefined = callback.message?.message_id;
      const fromUsername: string | undefined = callback.from?.username;

      // Immediately acknowledge callback query so the button spinner clears in <100ms
      if (callback.id) {
        sendTelegram('answerCallbackQuery', { callback_query_id: callback.id }).catch(() => {});
      }

      // Load session from Supabase before any getSession() call
      await preloadSession(chatId);

      // ── NEW: Onboarding callbacks (gender, location, move-in) ──────────────
      if (isOnboardingCallback(callbackData)) {
        await handleOnboardingCallback(
          callback.id,
          callbackData,
          chatId,
          fromUsername,
          msgId
        );
        return NextResponse.json({ ok: true });
      }

      // ── Admin Channel Post Wizard Callbacks ────────────────────────────────
      if (callbackData === 'admin_post_start') {
        const adminIds = await getAdminIds();
        if (!adminIds.includes(chatId)) {
          await tgSend(chatId, `⛔ <b>Access Denied.</b> Only SpaceMatch administrators can post to the channel.`);
          return NextResponse.json({ ok: true });
        }
        await sendAdminPostCategoryStep(chatId, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData.startsWith('admin_post_cat:')) {
        const cat = callbackData.split(':')[1];
        const session = getSession(chatId);
        const updatedDraft = { ...session.draft_data, category: cat, locations: ['Bole'] };
        await sendAdminPostSubcitiesStep(chatId, updatedDraft, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData.startsWith('admin_post_sub_toggle:')) {
        const sub = callbackData.split(':')[1];
        const session = getSession(chatId);
        const currentList: string[] = session.draft_data.locations || ['Bole'];
        const newList = currentList.includes(sub)
          ? currentList.filter((s) => s !== sub)
          : [...currentList, sub];
        const updatedDraft = {
          ...session.draft_data,
          locations: newList.length > 0 ? newList : [sub],
        };
        await sendAdminPostSubcitiesStep(chatId, updatedDraft, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData === 'admin_post_sub_all') {
        const session = getSession(chatId);
        const updatedDraft = { ...session.draft_data, locations: [...ALL_SUBCITIES] };
        await sendAdminPostBudgetStep(chatId, updatedDraft, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData === 'admin_post_proceed_budget') {
        const session = getSession(chatId);
        await sendAdminPostBudgetStep(chatId, session.draft_data, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData === 'admin_post_back_to_subs') {
        const session = getSession(chatId);
        await sendAdminPostSubcitiesStep(chatId, session.draft_data, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData.startsWith('admin_post_gender:')) {
        const gender = callbackData.split(':')[1];
        const session = getSession(chatId);
        const updatedDraft = { ...session.draft_data, gender };
        await sendAdminPostBioStep(chatId, updatedDraft, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData === 'admin_post_back_to_budget') {
        const session = getSession(chatId);
        await sendAdminPostBudgetStep(chatId, session.draft_data, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData === 'admin_post_use_default_bio') {
        const session = getSession(chatId);
        const updatedDraft = {
          ...session.draft_data,
          details: 'Seeking compatible roommate in Addis Ababa.',
        };
        await sendAdminPostPreviewCard(chatId, updatedDraft, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData === 'admin_post_confirm') {
        const session = getSession(chatId);
        const draft = session.draft_data || {};

        let displayCode = `RM${Date.now().toString().slice(-4)}`;
        try {
          const { data: codeRow } = await supabaseAdmin.rpc('generate_display_code');
          if (codeRow) displayCode = codeRow;
        } catch {}

        const subcities = draft.locations || ['Bole'];
        const subcitiesStr = subcities.join(', ');
        const budgetNum = draft.budget || 10000;
        const genderStr = draft.gender || 'Any';
        const bioStr = draft.details || 'Seeking compatible roommate in Addis Ababa.';

        // 1. Save to Supabase profiles first
        const { data: savedProfile, error: saveErr } = await supabaseAdmin
          .from('profiles')
          .insert({
            telegram_id: chatId,
            display_code: displayCode,
            gender: genderStr,
            locations: subcities,
            budget_min: 0,
            budget_max: budgetNum,
            roommate_traits: bioStr,
            kyc_status: 'verified',
            status: 'active',
            onboarding_step: 'completed',
          })
          .select('*')
          .single();

        if (saveErr) {
          console.error('Error saving admin post to profiles:', saveErr);
        }

        // 2. Also save to roommate_profiles
        try {
          await supabaseAdmin.from('roommate_profiles').insert({
            user_telegram_id: chatId,
            display_code: displayCode,
            my_gender: genderStr,
            preferred_gender: 'Any',
            preferred_subcity: subcities,
            budget_min: 0,
            budget_max: budgetNum,
            lifestyle_bio: bioStr,
            unlock_fee: 50,
            status: 'approved',
          });
        } catch {}

        // 3. Broadcast to channel with the 3 mandatory buttons
        const targetChannel = await getPrimaryChannel();
        const postCardText = `
<b>Roommate Available</b> #${displayCode}
📍 <code>${subcitiesStr}</code> · 🛡️ <b>Fayda Verified ✅</b>

• <b>Gender:</b> ${genderStr}
• <b>Budget Cap:</b> <code>Up to ${Number(budgetNum).toLocaleString()} ETB / month</code>

<blockquote>"${bioStr}"</blockquote>

🔒 <i>Personal identity & direct contact remain sealed until mutual match unlock.</i>
        `.trim();

        const channelButtons = {
          inline_keyboard: [
            [{ text: `⚡ Contact with Roommate #${displayCode} ↗️`, url: `https://t.me/${botUsername}?start=req_${displayCode}` }],
            [{ text: '📢 Post My Profile ↗️', url: `https://t.me/${botUsername}?start=post_profile` }],
            [{ text: '🔍 Search Roommate for Me ↗️', url: `https://t.me/${botUsername}?start=search_roommate` }],
          ],
        };

        const postRes = await sendTelegram('sendMessage', {
          chat_id: targetChannel,
          text: postCardText,
          parse_mode: 'HTML',
          reply_markup: channelButtons,
        });

        const channelMsgId = postRes?.result?.message_id;

        // 4. Update channel_message_id in DB
        if (channelMsgId) {
          await supabaseAdmin
            .from('profiles')
            .update({ channel_message_id: channelMsgId })
            .ilike('display_code', displayCode);
          await supabaseAdmin
            .from('roommate_profiles')
            .update({ channel_message_id: channelMsgId })
            .ilike('display_code', displayCode);
        }

        await clearSession(chatId);

        // 5. Render Admin Management Card
        const channelHandle = String(targetChannel).replace('@', '');
        const postLink = channelMsgId ? `https://t.me/${channelHandle}/${channelMsgId}` : '';

        const successText = `
✅ <b>Post #${displayCode} Published Successfully!</b>

• <b>Display Code:</b> <b>#${displayCode}</b>
• <b>Channel:</b> <code>${targetChannel}</code>
• <b>Message ID:</b> <code>${channelMsgId || 'N/A'}</code>
• <b>Database Status:</b> Active & Saved ✅

When a user clicks to connect, the bot will track #${displayCode} and notify you directly.
        `.trim();

        const adminMgmtKeyboard = [
          [{ text: `🔴 Mark #${displayCode} as CLOSED in Channel`, callback_data: `admin_close:${displayCode}` }],
          ...(postLink ? [[{ text: '📢 View Post in Channel ↗️', url: postLink }]] : []),
          [{ text: '➕ Post Another Listing', callback_data: 'admin_post_start' }],
          [{ text: '🏠 Main Menu', callback_data: 'nav_start' }],
        ];

        await sendOrEditCard(chatId, successText, adminMgmtKeyboard, msgId);
        return NextResponse.json({ ok: true });
      }

      // ── Admin Manual Close Callback ────────────────────────────────────────
      if (callbackData.startsWith('admin_close:')) {
        const targetIdentifier = callbackData.split(':')[1];
        const adminIds = await getAdminIds();
        if (!adminIds.includes(chatId)) {
          await tgSend(chatId, `⛔ <b>Access Denied.</b> Only SpaceMatch administrators can mark channel listings as closed.`);
          return NextResponse.json({ ok: true });
        }

        const res = await executeChannelPostClose(targetIdentifier, chatId);

        const targetChannel = await getPrimaryChannel();
        const channelHandle = String(targetChannel).replace('@', '');
        const postLink = res.messageId ? `https://t.me/${channelHandle}/${res.messageId}` : '';

        const resultCard = `
${res.success ? '🔴' : '⚠️'} <b>Listing #${res.displayCode || targetIdentifier}</b>

${res.message}
        `.trim();

        const resultKeyboard = [
          ...(postLink ? [[{ text: '📢 View Channel Post ↗️', url: postLink }]] : []),
          [{ text: '➕ Post Another Listing', callback_data: 'admin_post_start' }],
          [{ text: '🏠 Main Menu', callback_data: 'nav_start' }],
        ];

        await sendOrEditCard(chatId, resultCard, resultKeyboard, msgId);
        return NextResponse.json({ ok: true });
      }

      // ── Flow 2 & 3: Post Profile Branches & Search Roommate Callbacks ──────
      if (callbackData === 'post_profile_start') {
        await sendPostProfileBranchPrompt(chatId, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData === 'post_branch_space') {
        await sendSpaceStep1Type(chatId, {}, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData === 'post_branch_seeker') {
        const isVerified = await isUserFaydaVerified(chatId);
        if (isVerified) {
          const { data: p } = await supabaseAdmin.from('profiles').select('*').eq('telegram_id', chatId).maybeSingle();
          if (p) {
            await sendChannelPublishPreviewCard(chatId, p, msgId);
            return NextResponse.json({ ok: true });
          }
        }
        await sendDynamicCardStep1Age(chatId, { mode: 'post_to_channel', listing_category: 'seeker' }, msgId);
        return NextResponse.json({ ok: true });
      }

      // Space Owner Wizard Callbacks
      if (callbackData.startsWith('space_type:')) {
        const spaceType = callbackData.replace('space_type:', '');
        const session = getSession(chatId);
        const updatedDraft = { ...session.draft_data, space_type: spaceType };
        await sendSpaceStep2Rent(chatId, updatedDraft, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData.startsWith('space_rent:')) {
        const rentVal = parseInt(callbackData.split(':')[1], 10);
        const session = getSession(chatId);
        const updatedDraft = { ...session.draft_data, space_rent: rentVal };
        await sendSpaceStep3Share(chatId, updatedDraft, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData === 'space_back_to_rent') {
        const session = getSession(chatId);
        await sendSpaceStep2Rent(chatId, session.draft_data, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData.startsWith('space_share:')) {
        const shareVal = parseInt(callbackData.split(':')[1], 10);
        const session = getSession(chatId);
        const updatedDraft = { ...session.draft_data, space_share: shareVal };
        await sendSpaceStep4Amenities(chatId, updatedDraft, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData === 'space_back_to_share') {
        const session = getSession(chatId);
        await sendSpaceStep3Share(chatId, session.draft_data, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData.startsWith('space_amenity_toggle:')) {
        const amenity = decodeURIComponent(callbackData.replace('space_amenity_toggle:', ''));
        const session = getSession(chatId);
        const currentList: string[] = session.draft_data.space_amenities || ['📶 WiFi', '🍳 Kitchen'];
        const newList = currentList.includes(amenity)
          ? currentList.filter((a) => a !== amenity)
          : [...currentList, amenity];
        const updatedDraft = { ...session.draft_data, space_amenities: newList };
        await sendSpaceStep4Amenities(chatId, updatedDraft, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData === 'space_amenities_proceed') {
        const session = getSession(chatId);
        await sendSpaceStep5Subcity(chatId, session.draft_data, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData === 'space_back_to_amenities') {
        const session = getSession(chatId);
        await sendSpaceStep4Amenities(chatId, session.draft_data, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData.startsWith('space_subcity:')) {
        const subcity = callbackData.replace('space_subcity:', '');
        const session = getSession(chatId);
        const updatedDraft = { ...session.draft_data, preferred_subcity: [subcity], location: subcity };
        await sendSpaceStep6Photos(chatId, updatedDraft, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData === 'space_back_to_subcity') {
        const session = getSession(chatId);
        await sendSpaceStep5Subcity(chatId, session.draft_data, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData === 'space_photos_done' || callbackData === 'space_photos_skip') {
        const session = getSession(chatId);
        const isVerified = await isUserFaydaVerified(chatId);
        if (isVerified) {
          const { data: p } = await supabaseAdmin.from('profiles').select('*').eq('telegram_id', chatId).maybeSingle();
          const mergedDraft = {
            ...session.draft_data,
            age: p?.age || session.draft_data.age || 24,
            gender: p?.gender || session.draft_data.gender || 'Member',
            roommate_traits: p?.roommate_traits || session.draft_data.roommate_traits || 'Roommate available with a room in Addis Ababa.',
          };
          await sendSpacePreviewCard(chatId, mergedDraft, msgId);
          return NextResponse.json({ ok: true });
        }
        await sendDynamicCardStep1Age(chatId, { ...session.draft_data, mode: 'post_space' }, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData.startsWith('space_submit_admin:')) {
        const cleanCode = callbackData.split(':')[1] || `RM${chatId.toString().slice(-4)}`;
        const session = getSession(chatId);
        const draft = session.draft_data || {};
        const subcity = draft.preferred_subcity?.[0] || draft.location || 'Addis Ababa';
        const rentNum = Number(draft.space_rent || 0);
        const shareNum = Number(draft.space_share || 0);
        const amenities = draft.space_amenities || [];
        const photos = draft.space_photos || [];

        // Upsert into profiles
        await supabaseAdmin.from('profiles').upsert({
          telegram_id: chatId,
          display_code: cleanCode,
          gender: draft.gender || 'Member',
          age: draft.age || 24,
          locations: [subcity],
          budget_min: shareNum,
          budget_max: rentNum,
          roommate_traits: draft.roommate_traits || 'Roommate available with a room in Addis Ababa.',
          kyc_status: 'verified',
          status: 'pending_approval',
        }, { onConflict: 'telegram_id' });

        // Save into draft store so photos and space metadata are preserved
        await saveRoommateDraft({
          id: cleanCode,
          user_telegram_id: chatId,
          display_code: cleanCode,
          user_name: 'Verified Space Owner',
          username: callback.from?.username || null,
          age: draft.age || 24,
          my_gender: draft.gender || 'Member',
          preferred_gender: 'Any',
          preferred_subcity: [subcity],
          budget_min: shareNum,
          budget_max: rentNum,
          lifestyle_bio: draft.roommate_traits || 'Roommate available with a room in Addis Ababa.',
          listing_category: 'space_available',
          space_type: draft.space_type || 'Private Bedroom in Shared Flat',
          space_rent: rentNum,
          space_share: shareNum,
          space_amenities: amenities,
          space_photos: photos,
          status: 'pending_approval',
          unlock_fee: 50,
          fayda_status: 'verified',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });

        // Notify user
        const targetChannel = await getPrimaryChannel();
        const userConfirmText = `
⏳ <b>SpaceMatch · Space Listing Submitted for Review!</b>

Your room listing (<code>#${cleanCode}</code>) has been submitted to channel administrators.

• <b>Listing Code:</b> <b>#${cleanCode}</b>
• <b>Space Type:</b> ${draft.space_type || 'Private Bedroom in Shared Flat'}
• <b>Total Rent:</b> <code>${rentNum.toLocaleString()} ETB / mo</code>
• <b>Roommate Share:</b> <code>${shareNum.toLocaleString()} ETB / mo</code>
• <b>Photos Attached:</b> ${photos.length} photo(s)
• <b>Status:</b> ⏳ <b>Pending Admin Review</b>
• <b>Target Channel:</b> <code>${targetChannel}</code>

<blockquote>🔒 Once approved, your listing will be published directly to the channel with the header <b>"Roommate available with a Room"</b>!</blockquote>
        `.trim();

        await sendOrEditCard(chatId, userConfirmText, [
          [{ text: '⚡ Search Active Roommates 🔍', callback_data: 'search_roommate_start' }],
          [{ text: '🏠 Main Menu', callback_data: 'nav_start' }],
        ], msgId);

        // Notify admins
        try {
          const adminIds = await getAdminIds();
          const cleanUser = (callback.from?.username || '').replace('@', '');
          const userIdentifier = cleanUser ? `@${cleanUser}` : `ID ${chatId}`;

          const adminNotificationText = `
🛡️ <b>SpaceMatch Admin · Space Listing Pending Review!</b>

A user has submitted a space offering for channel <code>${targetChannel}</code>:

• <b>Listing:</b> <b>#${cleanCode}</b> (Roommate with Room)
• <b>Space Type:</b> ${draft.space_type || 'Private Bedroom in Shared Flat'}
• <b>Total Rent:</b> <code>${rentNum.toLocaleString()} ETB / mo</code>
• <b>Roommate Share:</b> <code>${shareNum.toLocaleString()} ETB / mo</code>
• <b>Location:</b> <code>${subcity}</code>
• <b>Photos:</b> ${photos.length} photo(s) attached
• <b>Resident:</b> ${draft.gender || 'Member'}, Age ${draft.age || 24} (🛡️ Fayda Verified)

<i>Admin Reference: User ${userIdentifier} (<code>${chatId}</code>)</i>
          `.trim();

          const adminButtons = {
            inline_keyboard: [
              [{ text: `✅ Approve & Broadcast #${cleanCode} 🚀`, callback_data: `admin_approve_profile:${cleanCode}` }],
              [{ text: `❌ Reject Listing #${cleanCode}`, callback_data: `admin_reject_profile:${cleanCode}` }],
            ],
          };

          for (const adminId of adminIds) {
            if (photos.length > 0) {
              sendTelegram('sendPhoto', {
                chat_id: adminId,
                photo: photos[0],
                caption: adminNotificationText,
                parse_mode: 'HTML',
                reply_markup: adminButtons,
              }).catch(() => {});
            } else {
              sendTelegram('sendMessage', {
                chat_id: adminId,
                text: adminNotificationText,
                parse_mode: 'HTML',
                reply_markup: adminButtons,
              }).catch(() => {});
            }
          }
        } catch (err) {
          console.error('Error notifying admins of space listing:', err);
        }

        return NextResponse.json({ ok: true });
      }

      // Flow 3: Search Roommate Callbacks
      if (
        callbackData === 'search_roommate_start' ||
        callbackData === 'matchmaker_start' ||
        callbackData === 'execute_matchmaking'
      ) {
        const session = getSession(chatId);
        await sendMatchmakerSubcityStep(chatId, { ...session.draft_data, mode: 'search_roommate' }, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData.startsWith('search_unlock_contact:')) {
        const targetProfileId = callbackData.split(':')[1];

        // 1. Check if requester is Fayda verified and has profile
        const isVerified = await isUserFaydaVerified(chatId);
        const { data: myProfile } = await supabaseAdmin
          .from('profiles')
          .select('*')
          .eq('telegram_id', chatId)
          .maybeSingle();

        if (!isVerified || !myProfile) {
          await sendDynamicCardStep1Age(chatId, { target_id: targetProfileId }, msgId);
          return NextResponse.json({ ok: true });
        }

        // 2. Verified user -> send anonymous connection request directly
        // Reuse confirm_match flow
        const syntheticCallback = `confirm_match:${targetProfileId}`;
        callbackData = syntheticCallback;
      }

      // 24-Hour Follow-Up: Owner closes listing after match
      if (
        callbackData.startsWith('owner_close_listing:') ||
        callbackData.startsWith('close_channel_post:')
      ) {
        const targetCode = callbackData.split(':')[1];
        await executeChannelPostClose(targetCode, chatId);
        const closeMsg = `
🔴 <b>Listing Marked as CLOSED!</b>

Congratulations on finding a roommate! Post <b>#${targetCode}</b> has been updated on the channel with <b>_____CLOSED_____</b>.
        `.trim();

        await sendOrEditCard(chatId, closeMsg, [[{ text: '🏠 Main Menu', callback_data: 'nav_start' }]], msgId);
        return NextResponse.json({ ok: true });
      }

      // 24-Hour Follow-Up: Owner keeps listing open
      if (
        callbackData.startsWith('owner_keep_listing:') ||
        callbackData.startsWith('keep_channel_post:')
      ) {
        const targetCode = callbackData.split(':')[1];
        try {
          await supabaseAdmin
            .from('profiles')
            .update({ status: 'active', updated_at: new Date().toISOString() })
            .ilike('display_code', targetCode);
          await supabaseAdmin
            .from('roommate_profiles')
            .update({ status: 'approved', updated_at: new Date().toISOString() })
            .ilike('display_code', targetCode);
        } catch {}

        const keepMsg = `
✅ <b>Listing Kept Open!</b>

Your profile <b>#${targetCode}</b> remains active on the channel. We will keep directing compatible verified roommates your way!
        `.trim();

        await sendOrEditCard(chatId, keepMsg, [[{ text: '🏠 Main Menu', callback_data: 'nav_start' }]], msgId);
        return NextResponse.json({ ok: true });
      }

      // ── Dynamic Card Wizard Callbacks ──────────────────────────────────────
      // Legacy alias – redirect to the new 2-branch post profile flow
      if (callbackData === 'post_to_channel_start') {
        await sendPostProfileBranchPrompt(chatId, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData.startsWith('dyn_gender:')) {
        const gender = callbackData.split(':')[1];
        const session = getSession(chatId);
        const updatedDraft = { ...session.draft_data, gender };
        await sendDynamicCardStep3Budget(chatId, updatedDraft, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData === 'dyn_back_to_age') {
        const session = getSession(chatId);
        await sendDynamicCardStep1Age(chatId, session.draft_data, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData === 'dyn_back_to_gender') {
        const session = getSession(chatId);
        await sendDynamicCardStep2Gender(chatId, session.draft_data, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData.startsWith('dyn_sub_toggle:')) {
        const sub = callbackData.split(':')[1];
        const session = getSession(chatId);
        const currentList: string[] = session.draft_data.preferred_subcity || ['Bole'];
        const newList = currentList.includes(sub)
          ? currentList.filter((s) => s !== sub)
          : [...currentList, sub];
        const updatedDraft = {
          ...session.draft_data,
          preferred_subcity: newList.length > 0 ? newList : [sub],
        };
        await sendDynamicCardStep4Subcities(chatId, updatedDraft, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData === 'dyn_sub_all') {
        const session = getSession(chatId);
        const updatedDraft = { ...session.draft_data, preferred_subcity: [...ALL_SUBCITIES] };
        await sendDynamicCardStep5FaydaFan(chatId, updatedDraft, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData === 'dyn_sub_proceed') {
        const session = getSession(chatId);
        const currentList = session.draft_data.preferred_subcity || ['Bole'];
        const updatedDraft = {
          ...session.draft_data,
          preferred_subcity: currentList.length > 0 ? currentList : ['Bole'],
        };
        await sendDynamicCardStep5FaydaFan(chatId, updatedDraft, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData === 'dyn_back_to_budget') {
        const session = getSession(chatId);
        await sendDynamicCardStep3Budget(chatId, session.draft_data, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData === 'dyn_back_to_subs') {
        const session = getSession(chatId);
        await sendDynamicCardStep4Subcities(chatId, session.draft_data, msgId);
        return NextResponse.json({ ok: true });
      }

      // ── Roommate Profile Channel Submission & Admin Approval Workflow ────
      if (callbackData.startsWith('dyn_publish_channel:') || callbackData.startsWith('dyn_submit_channel:')) {
        const identifier = callbackData.split(':')[1] || '';
        const cleanCode = identifier.trim().replace(/^#/, '');
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanCode);

        // Fetch user's profile from profiles or roommate_profiles
        let prof: any = null;
        if (isUuid) {
          const { data } = await supabaseAdmin.from('profiles').select('*').eq('id', cleanCode).maybeSingle();
          prof = data;
        }
        if (!prof) {
          const { data } = await supabaseAdmin.from('profiles').select('*').ilike('display_code', cleanCode).maybeSingle();
          prof = data;
        }
        if (!prof) {
          const { data } = await supabaseAdmin.from('profiles').select('*').eq('telegram_id', chatId).maybeSingle();
          prof = data;
        }

        const displayCode = prof?.display_code || cleanCode || `RM${chatId.toString().slice(-4)}`;
        const subcities = Array.isArray(prof?.locations) && prof.locations.length > 0 ? prof.locations : ['Addis Ababa'];
        const subcitiesStr = subcities.join(', ');
        const budgetNum = prof?.budget_max || 10000;
        const genderStr = prof?.gender || 'Member';
        const ageStr = prof?.age ? `${prof.age} yrs` : '24 yrs';
        const bioStr = prof?.roommate_traits || 'Seeking compatible roommate in Addis Ababa.';

        // 1. Mark status as pending_approval in Supabase
        await supabaseAdmin
          .from('profiles')
          .update({ status: 'pending_approval' })
          .ilike('display_code', displayCode);

        try {
          await supabaseAdmin
            .from('roommate_profiles')
            .update({ status: 'pending_approval' })
            .ilike('display_code', displayCode);
        } catch {}

        // 2. Show confirmation waiting card to the user
        const targetChannel = await getPrimaryChannel();
        const userConfirmText = `
⏳ <b>SpaceMatch · Submitted for Admin Approval!</b>

Your anonymous roommate listing (<code>#${displayCode}</code>) has been submitted to the channel administrators.

• <b>Listing Code:</b> <b>#${displayCode}</b>
• <b>Target Areas:</b> <code>${subcitiesStr}</code>
• <b>Budget Cap:</b> <code>Up to ${Number(budgetNum).toLocaleString()} ETB / month</code>
• <b>Status:</b> ⏳ <b>Pending Admin Review</b>
• <b>Target Channel:</b> <code>${targetChannel}</code>

<blockquote>🔒 <b>Privacy Shield Active:</b> Your real name, phone number, and Telegram handle remain 100% private. Once an administrator approves your profile, it will be broadcasted to the official channel and you will be notified immediately!</blockquote>
        `.trim();

        await sendOrEditCard(
          chatId,
          userConfirmText,
          [
            [{ text: '⚡ Find Roommates Now · Matchmaker 🔍', callback_data: 'matchmaker_start' }],
            [{ text: '🏠 Main Menu', callback_data: 'nav_start' }],
          ],
          msgId
        );

        // 3. Send approval request card to all channel administrators
        try {
          const adminIds = await getAdminIds();
          const cleanUser = (callback.from?.username || '').replace('@', '');
          const userIdentifier = cleanUser ? `@${cleanUser}` : `ID ${chatId}`;

          const adminApprovalCard = `
🛡️ <b>SpaceMatch Admin · New Profile Pending Approval!</b>

A user has requested to post their profile to the channel <code>${targetChannel}</code>:

• <b>Seeker Code:</b> <b>#${displayCode}</b>
• <b>Gender & Age:</b> ${genderStr}, Age ${ageStr}
• <b>Budget Cap:</b> <code>Up to ${Number(budgetNum).toLocaleString()} ETB / month</code>
• <b>Target Areas:</b> <code>${subcitiesStr}</code>
• <b>Fayda Status:</b> 🛡️ Verified Resident ✅

<blockquote>"${bioStr}"</blockquote>

<i>Admin Reference: User ${userIdentifier} (<code>${chatId}</code>)</i>
          `.trim();

          const adminButtons = {
            inline_keyboard: [
              [
                { text: `✅ Approve & Broadcast #${displayCode} 🚀`, callback_data: `admin_approve_profile:${displayCode}` },
              ],
              [
                { text: `❌ Reject Listing #${displayCode}`, callback_data: `admin_reject_profile:${displayCode}` },
              ],
            ],
          };

          for (const adminId of adminIds) {
            sendTelegram('sendMessage', {
              chat_id: adminId,
              text: adminApprovalCard,
              parse_mode: 'HTML',
              reply_markup: adminButtons,
            }).catch(() => {});
          }
        } catch (adminErr) {
          console.error('Error notifying admins for approval:', adminErr);
        }

        return NextResponse.json({ ok: true });
      }

      // Admin Action: Approve and Broadcast Roommate Profile to Channel
      if (callbackData.startsWith('admin_approve_profile:')) {
        const targetCode = callbackData.split(':')[1];
        const adminIds = await getAdminIds();
        if (!adminIds.includes(chatId)) {
          await tgSend(chatId, `⛔ <b>Access Denied.</b> Only SpaceMatch administrators can approve listings.`);
          return NextResponse.json({ ok: true });
        }

        const res = await broadcastRoommateProfileToChannel(targetCode);
        if (!res.success) {
          await sendOrEditCard(
            chatId,
            `⚠️ <b>Broadcast Error for #${targetCode}:</b>\n${res.message}`,
            [
              [{ text: '🔄 Retry Approval', callback_data: `admin_approve_profile:${targetCode}` }],
              [{ text: '🏠 Admin Menu', callback_data: 'admin_menu' }],
            ],
            msgId
          );
          return NextResponse.json({ ok: true });
        }

        const channelMsgId = res.telegramMessageId;
        await supabaseAdmin
          .from('profiles')
          .update({ status: 'active', channel_message_id: channelMsgId })
          .ilike('display_code', targetCode);

        try {
          await supabaseAdmin
            .from('roommate_profiles')
            .update({ status: 'approved', channel_message_id: channelMsgId })
            .ilike('display_code', targetCode);
        } catch {}

        const targetChannel = await getPrimaryChannel();
        const channelHandle = String(targetChannel).replace('@', '');
        const postLink = channelMsgId ? `https://t.me/${channelHandle}/${channelMsgId}` : '';

        const adminSuccessText = `
✅ <b>Profile #${targetCode} Approved & Published!</b>

• <b>Channel:</b> <code>${targetChannel}</code>
• <b>Channel Post ID:</b> <code>${channelMsgId || 'N/A'}</code>
• <b>Status:</b> Active & Live in Channel 🚀
        `.trim();

        await sendOrEditCard(
          chatId,
          adminSuccessText,
          [
            ...(postLink ? [[{ text: '📢 View Post in Channel ↗️', url: postLink }]] : []),
            [{ text: `🔴 Mark #${targetCode} as CLOSED in Channel`, callback_data: `admin_close:${targetCode}` }],
            [{ text: '🏠 Admin Menu', callback_data: 'admin_menu' }],
          ],
          msgId
        );

        // Fetch user telegram_id from profiles to notify them
        let userTgId: number | null = null;
        try {
          const { data: p } = await supabaseAdmin
            .from('profiles')
            .select('telegram_id')
            .ilike('display_code', targetCode)
            .maybeSingle();
          if (p?.telegram_id) userTgId = Number(p.telegram_id);
        } catch {}

        if (userTgId) {
          const userCelebrationMsg = `
🎉 <b>Congratulations! Your Profile is LIVE on SpaceMatch Addis!</b>

Your anonymous listing (<code>#${targetCode}</code>) has been reviewed and approved by the admin team, and is now broadcasted to the official channel!

<blockquote>When interested roommates tap to connect with you, you will receive an instant notification here to review and accept!</blockquote>
          `.trim();

          await tgSend(userTgId, userCelebrationMsg, {
            inline_keyboard: [
              ...(postLink ? [[{ text: '📢 View Your Post on Channel ↗️', url: postLink }]] : []),
              [{ text: '⚡ Find Other Roommates · Matchmaker 🔍', callback_data: 'matchmaker_start' }],
              [{ text: '🏠 Main Menu', callback_data: 'nav_start' }],
            ],
          });
        }

        return NextResponse.json({ ok: true });
      }

      // Admin Action: Reject Roommate Profile
      if (callbackData.startsWith('admin_reject_profile:')) {
        const targetCode = callbackData.split(':')[1];
        const adminIds = await getAdminIds();
        if (!adminIds.includes(chatId)) {
          await tgSend(chatId, `⛔ <b>Access Denied.</b> Only SpaceMatch administrators can reject listings.`);
          return NextResponse.json({ ok: true });
        }

        await supabaseAdmin
          .from('profiles')
          .update({ status: 'rejected' })
          .ilike('display_code', targetCode);

        try {
          await supabaseAdmin
            .from('roommate_profiles')
            .update({ status: 'rejected' })
            .ilike('display_code', targetCode);
        } catch {}

        await sendOrEditCard(
          chatId,
          `❌ <b>Profile #${targetCode} Rejected.</b>\n\nThis listing was rejected and was not published to the channel.`,
          [[{ text: '🏠 Admin Menu', callback_data: 'admin_menu' }]],
          msgId
        );

        let userTgId: number | null = null;
        try {
          const { data: p } = await supabaseAdmin
            .from('profiles')
            .select('telegram_id')
            .ilike('display_code', targetCode)
            .maybeSingle();
          if (p?.telegram_id) userTgId = Number(p.telegram_id);
        } catch {}

        if (userTgId) {
          await tgSend(
            userTgId,
            `ℹ️ <b>SpaceMatch · Profile Review Update</b>\n\nYour listing (<code>#${targetCode}</code>) was reviewed by our admin team and could not be approved for channel broadcast at this time.\n\n<blockquote>You can edit your details and submit again anytime.</blockquote>`,
            {
              inline_keyboard: [
                [{ text: '✏️ Edit Profile', callback_data: 'post_to_channel_start' }],
                [{ text: '🏠 Main Menu', callback_data: 'nav_start' }],
              ],
            }
          );
        }

        return NextResponse.json({ ok: true });
      }

      // ── NEW: Match request confirmation (from deep-link preview card) ──────
      if (callbackData.startsWith('confirm_match:')) {
        const targetProfileId = callbackData.split(':')[1];

        // Universal Gate: Fayda Verification required before sending mutual match requests
        if (!(await isUserFaydaVerified(chatId))) {
          await sendFaydaGateCard(chatId, 'send mutual match requests', msgId);
          return NextResponse.json({ ok: true });
        }

        // Get requester's profile
        const { data: requesterProfile } = await supabaseAdmin
          .from('profiles')
          .select('*')
          .eq('telegram_id', chatId)
          .single();

        if (!requesterProfile) {
          await sendDynamicCardStep1Age(chatId, { target_id: targetProfileId }, msgId);
          return NextResponse.json({ ok: true });
        }

        // Prevent self-request
        if (requesterProfile.id === targetProfileId) {
          await sendOrEditCard(
            chatId,
            `ℹ️ <b>This is your own listing!</b>\n\nYou cannot send a match request to yourself.`,
            [[{ text: '🏠 Main Menu', callback_data: 'nav_start' }]],
            msgId
          );
          return NextResponse.json({ ok: true });
        }

        // Get target profile
        let targetProfile: any = null;
        const { data: pTarget } = await supabaseAdmin
          .from('profiles')
          .select('*')
          .eq('id', targetProfileId)
          .single();

        if (pTarget) {
          targetProfile = pTarget;
        } else {
          const { data: rmTarget } = await supabaseAdmin
            .from('roommate_profiles')
            .select('*')
            .eq('id', targetProfileId)
            .single();
          if (rmTarget) {
            targetProfile = {
              id: rmTarget.id,
              telegram_id: rmTarget.user_telegram_id,
              display_code: rmTarget.display_code || `RM${rmTarget.id.slice(0, 4)}`,
              gender: rmTarget.my_gender,
              locations: rmTarget.preferred_subcity,
              budget_min: rmTarget.budget_min,
              budget_max: rmTarget.budget_max,
              roommate_traits: rmTarget.lifestyle_bio,
            };
          }
        }

        if (!targetProfile) {
          await sendOrEditCard(
            chatId,
            `⚠️ <b>Listing Not Found</b>\n\nThis listing is no longer available.`,
            [[{ text: '🔍 Find Other Roommates', callback_data: 'matchmaker_start' }], [{ text: '🏠 Main Menu', callback_data: 'nav_start' }]],
            msgId
          );
          return NextResponse.json({ ok: true });
        }

        if (String(targetProfile.telegram_id) === String(chatId)) {
          await sendOrEditCard(
            chatId,
            `ℹ️ <b>This is your own listing!</b>\n\nYou cannot send a match request to yourself.`,
            [[{ text: '🏠 Main Menu', callback_data: 'nav_start' }]],
            msgId
          );
          return NextResponse.json({ ok: true });
        }

        // Check for existing match
        const { data: existingMatch } = await supabaseAdmin
          .from('matches')
          .select('id, status')
          .eq('requester_id', requesterProfile.id)
          .eq('target_id', targetProfileId)
          .single();

        if (existingMatch) {
          await sendOrEditCard(
            chatId,
            `ℹ️ You already sent a match request to Roommate <b>#${targetProfile.display_code}</b>.\nStatus: <b>${existingMatch.status.replace('_', ' ')}</b>`,
            [[{ text: '🔍 Find Other Roommates', callback_data: 'matchmaker_start' }], [{ text: '🏠 Main Menu', callback_data: 'nav_start' }]],
            msgId
          );
          return NextResponse.json({ ok: true });
        }

        // Create match record
        const { data: newMatch, error: matchError } = await supabaseAdmin
          .from('matches')
          .insert({
            requester_id: requesterProfile.id,
            target_id: targetProfileId,
            status: 'pending_acceptance',
            payment_status: 'unpaid',
          })
          .select('id')
          .single();

        if (matchError || !newMatch) {
          console.error('[webhook] Failed to create match:', matchError?.message);
          await sendOrEditCard(
            chatId,
            `❌ Could not send match request. Please try again later.`,
            [[{ text: '🏠 Main Menu', callback_data: 'nav_start' }]],
            msgId
          );
          return NextResponse.json({ ok: true });
        }

        // Notify requester in-place
        await sendOrEditCard(
          chatId,
          `✅ <b>Match Request Delivered!</b>\n\nYour request has been sent to Roommate <b>#${targetProfile.display_code}</b>.\n\n<blockquote>🔔 You will receive an instant notification here the moment they accept!</blockquote>`,
          [
            [{ text: '⚡ Find Other Roommates 🔍', callback_data: 'matchmaker_start' }],
            [{ text: '🏠 Main Menu', callback_data: 'nav_start' }],
          ],
          msgId
        );

        // Notify target (User B) with requester snapshot
        const requesterLocations = Array.isArray(requesterProfile.locations)
          ? requesterProfile.locations.join(', ')
          : 'Addis Ababa';

        const requesterAgeStr = requesterProfile.age ? `, Age ${requesterProfile.age}` : '';
        const requesterBudgetStr = requesterProfile.budget_max
          ? `Up to ${Number(requesterProfile.budget_max).toLocaleString()} ETB / month`
          : `${Number(requesterProfile.budget_min || 0).toLocaleString()} – ${Number(requesterProfile.budget_max || 0).toLocaleString()} ETB / month`;

        const notifyText = `🤝 <b>SpaceMatch</b> · <b>New Connection Request!</b>\n\nA verified user saw your channel listing and wants to connect!\n\n• <b>Profile:</b> ${requesterProfile.gender || 'Member'}${requesterAgeStr}\n• <b>Budget Cap:</b> <code>${requesterBudgetStr}</code>\n• <b>Target Areas:</b> <code>${requesterLocations}</code>\n\n<blockquote>Would you like to connect with this roommate?</blockquote>`;

        if (targetProfile.telegram_id) {
          await tgSend(
            targetProfile.telegram_id,
            notifyText,
            {
              inline_keyboard: [
                [
                  { text: '✅ Accept Match', callback_data: `match_accept:${newMatch.id}` },
                  { text: '❌ Decline', callback_data: `match_decline:${newMatch.id}` },
                ],
              ],
            }
          );
        }

        return NextResponse.json({ ok: true });
      }

      // ── NEW: Match Accept ──────────────────────────────────────────────────
      if (callbackData.startsWith('match_accept:')) {
        const matchId = callbackData.split(':')[1];

        // Ensure target user is Fayda verified before accepting
        if (!(await isUserFaydaVerified(chatId))) {
          await saveSession({
            telegram_id: chatId,
            step: `awaiting_target_fayda_fan:${matchId}`,
            draft_data: { match_id: matchId, card_msg_id: msgId },
            updated_at: new Date().toISOString(),
          });

          const gateText = `
🛡️ <b>Fayda ID Verification Required</b>

Before accepting this roommate connection, SpaceMatch requires both parties to be Fayda verified for maximum safety.

• <b>Option A:</b> Reply here with your <b>12-digit or 16-digit FAN number</b>:
<i>Example: <code>1234 5678 9012</code></i>

• <b>Option B:</b> Scan using your camera:
          `.trim();

          const inlineKeyboard = [
            [
              {
                text: '📷 Open Camera to Scan Fayda QR ↗️',
                web_app: { url: `${appUrl}?startapp=verify_fayda` },
              },
            ],
            [{ text: '🏠 Cancel', callback_data: 'nav_start' }],
          ];

          await sendOrEditCard(chatId, gateText, inlineKeyboard, msgId);
          return NextResponse.json({ ok: true });
        }

        const { data: match } = await supabaseAdmin
          .from('matches')
          .select('*, requester:requester_id(telegram_id, gender, budget_min, budget_max, locations, display_code), target:target_id(telegram_id, display_code)')
          .eq('id', matchId)
          .single();

        if (!match || match.status !== 'pending_acceptance') {
          await tgSend(chatId, `ℹ️ This match request is no longer pending.`);
          return NextResponse.json({ ok: true });
        }

        // Update match to pending_payment
        await supabaseAdmin
          .from('matches')
          .update({ status: 'pending_payment' })
          .eq('id', matchId);

        const receiverPhone = process.env.TELEBIRR_RECEIVER_PHONE || '0987310978';
        const cbeAccount = process.env.CBE_ACCOUNT_NUMBER || '1000054066094';

        const paymentInstructions = `🎉 <b>You Both Want to Connect!</b>\n\nTo unlock contact details, each person must pay a matching fee of <b>50 ETB</b>.\n\n🏦 <b>Payment Options:</b>\n• <b>Telebirr:</b> <code>${receiverPhone}</code> (SpaceMatch Addis)\n• <b>CBE:</b> <code>${cbeAccount}</code> (SpaceMatch Addis)\n\nℹ️ <i>After both parties have paid, contact information will be revealed to both of you. If one party refuses to pay, your payment will be fully refunded.</i>\n\nOnce transferred, submit your reference code:\n<code>/verify telebirr YOUR_REFERENCE</code>\nor\n<code>/verify cbe YOUR_REFERENCE</code>\n\n<i>Example: /verify telebirr FT260920042</i>`;

        // Send to both users
        const requesterTgId = (match.requester as any)?.telegram_id;
        const targetTgId = (match.target as any)?.telegram_id;

        if (msgId) {
          await sendOrEditCard(chatId, `✅ <b>You Accepted the Match Request!</b>\n\n${paymentInstructions}`, [], msgId);
        } else if (targetTgId) {
          await tgSend(targetTgId, paymentInstructions);
        }

        if (requesterTgId) await tgSend(requesterTgId, paymentInstructions);

        return NextResponse.json({ ok: true });
      }

      // ── NEW: Match Decline ─────────────────────────────────────────────────
      if (callbackData.startsWith('match_decline:')) {
        const matchId = callbackData.split(':')[1];

        const { data: match } = await supabaseAdmin
          .from('matches')
          .select('*, requester:requester_id(telegram_id, display_code)')
          .eq('id', matchId)
          .single();

        if (!match) {
          await tgSend(chatId, `ℹ️ Match not found.`);
          return NextResponse.json({ ok: true });
        }

        await supabaseAdmin
          .from('matches')
          .update({ status: 'declined' })
          .eq('id', matchId);

        // Notify decliner
        if (msgId) {
          await sendOrEditCard(chatId, `✅ You've declined the match request.`, [[{ text: '🏠 Main Menu', callback_data: 'nav_start' }]], msgId);
        } else {
          await tgSend(chatId, `✅ You've declined the match request.`);
        }

        // Notify requester
        const requesterTgId = (match.requester as any)?.telegram_id;
        if (requesterTgId) {
          await tgSend(
            requesterTgId,
            `📭 <b>Match Unavailable</b>\n\nPotential Roommate is unavailable. Keep looking on the channel or post your profile! 🏠`,
            {
              inline_keyboard: [
                [{ text: '📢 Post My Profile to Channel ↗️', callback_data: 'post_to_channel_start' }],
                [{ text: '⚡ Find Other Roommates · Matchmaker 🔍', callback_data: 'matchmaker_start' }],
              ],
            }
          );
        }

        return NextResponse.json({ ok: true });
      }

      // Navigation & Start Menu
      if (callbackData === 'nav_start' || callbackData === 'admin_cancel') {
        await clearSession(chatId);
        await sendPrimaryWelcomeMenu(chatId, msgId);
        return NextResponse.json({ ok: true });
      }

      // MATCHMAKER WIZARD CALLBACK HANDLERS (In-Place Single Card Flow)
      if (callbackData === 'matchmaker_start' || callbackData === 'execute_matchmaking') {
        const session = getSession(chatId);
        await sendMatchmakerSubcityStep(chatId, session.draft_data, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData === 'match_select_all_subs') {
        const session = getSession(chatId);
        const updatedDraft = { ...session.draft_data, match_subcities: [...ALL_SUBCITIES] };
        await sendMatchmakerGenderStep(chatId, updatedDraft, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData.startsWith('match_toggle_sub:')) {
        const sub = callbackData.split(':')[1];
        const session = getSession(chatId);
        const currentList: string[] = session.draft_data.match_subcities || [];

        const newList = currentList.includes(sub)
          ? currentList.filter((s) => s !== sub)
          : [...currentList, sub];

        const updatedDraft = { ...session.draft_data, match_subcities: newList };
        await sendMatchmakerSubcityStep(chatId, updatedDraft, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData === 'match_goto_gender' || callbackData === 'match_goto_identity') {
        const session = getSession(chatId);
        const currentList: string[] = session.draft_data.match_subcities || [];
        const updatedDraft = {
          ...session.draft_data,
          match_subcities: currentList.length > 0 ? currentList : [...ALL_SUBCITIES],
        };
        await sendMatchmakerGenderStep(chatId, updatedDraft, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData.startsWith('match_set_my_gender:')) {
        const myGender = callbackData.split(':')[1];
        const session = getSession(chatId);
        const updatedDraft = { ...session.draft_data, my_gender: myGender };
        await sendMatchmakerAgeStep(chatId, updatedDraft, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData === 'match_goto_age') {
        const session = getSession(chatId);
        await sendMatchmakerAgeStep(chatId, session.draft_data, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData.startsWith('match_set_pref_gender:')) {
        const prefGender = callbackData.split(':')[1];
        const session = getSession(chatId);
        const updatedDraft = { ...session.draft_data, preferred_gender: prefGender };
        await sendMatchmakerBudgetStep(chatId, updatedDraft, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData === 'match_goto_pref_gender' || callbackData === 'match_goto_prefs') {
        const session = getSession(chatId);
        await sendMatchmakerPrefGenderStep(chatId, session.draft_data, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData.startsWith('match_set_budget:')) {
        const budget = parseInt(callbackData.split(':')[1], 10);
        const session = getSession(chatId);
        const updatedDraft = { ...session.draft_data, budget_max: budget };
        await executeAutomatedMatchmaker(chatId, updatedDraft, msgId, 0);
        return NextResponse.json({ ok: true });
      }

      if (callbackData === 'match_run_search') {
        const session = getSession(chatId);
        await executeAutomatedMatchmaker(chatId, session.draft_data, msgId, 0);
        return NextResponse.json({ ok: true });
      }

      if (callbackData.startsWith('match_page:')) {
        const pageIdx = parseInt(callbackData.split(':')[1], 10);
        const session = getSession(chatId);
        await executeAutomatedMatchmaker(chatId, session.draft_data, msgId, pageIdx);
        return NextResponse.json({ ok: true });
      }

      if (callbackData === 'match_browse_all') {
        const session = getSession(chatId);
        const allAreasCriteria = { ...session.draft_data, match_subcities: [] };
        await executeAutomatedMatchmaker(chatId, allAreasCriteria, msgId, 0);
        return NextResponse.json({ ok: true });
      }

      if (callbackData === 'match_noop') {
        return NextResponse.json({ ok: true });
      }

      // PRIMARY SEEKER CREATION WIZARD CALLBACK HANDLERS
      if (callbackData === 'seeker_subcity_menu' || callbackData === 'seeker_flow') {
        await sendDynamicCardStep1Age(chatId, { mode: 'post_to_channel' }, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData === 'seeker_select_all_and_proceed') {
        const session = getSession(chatId);
        const updatedDraft = { ...session.draft_data, preferred_subcity: [...ALL_SUBCITIES] };
        await sendSeekerMyGenderStep(chatId, updatedDraft, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData.startsWith('seeker_toggle_sub:')) {
        const sub = callbackData.split(':')[1];
        const session = getSession(chatId);
        const currentList: string[] = session.draft_data.preferred_subcity || [];

        const newList = currentList.includes(sub)
          ? currentList.filter((s) => s !== sub)
          : [...currentList, sub];

        const updatedDraft = { ...session.draft_data, preferred_subcity: newList };
        await sendSeekerSubcityStep(chatId, updatedDraft, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData === 'seeker_goto_gender') {
        const session = getSession(chatId);
        const currentList: string[] = session.draft_data.preferred_subcity || [];
        const updatedDraft = {
          ...session.draft_data,
          preferred_subcity: currentList.length > 0 ? currentList : [...ALL_SUBCITIES],
        };
        await sendSeekerMyGenderStep(chatId, updatedDraft, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData.startsWith('seeker_my_gender:')) {
        const gender = callbackData.split(':')[1];
        const session = getSession(chatId);
        const updatedDraft = { ...session.draft_data, my_gender: gender };
        await sendSeekerAgeStep(chatId, updatedDraft, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData.startsWith('seeker_set_age:')) {
        const ageVal = parseInt(callbackData.split(':')[1], 10);
        const session = getSession(chatId);
        const updatedDraft = { ...session.draft_data, age: ageVal };
        await sendSeekerPrefGenderStep(chatId, updatedDraft, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData === 'seeker_goto_age') {
        const session = getSession(chatId);
        await sendSeekerAgeStep(chatId, session.draft_data, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData.startsWith('seeker_pref_gender:')) {
        const prefGender = callbackData.split(':')[1];
        const session = getSession(chatId);
        const updatedDraft = { ...session.draft_data, preferred_gender: prefGender };
        await sendSeekerBudgetStep(chatId, updatedDraft, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData === 'seeker_goto_pref_gender') {
        const session = getSession(chatId);
        await sendSeekerPrefGenderStep(chatId, session.draft_data, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData === 'seeker_goto_budget') {
        const session = getSession(chatId);
        await sendSeekerBudgetStep(chatId, session.draft_data, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData === 'seeker_skip_bio') {
        const session = getSession(chatId);
        const updatedDraft = { ...session.draft_data, lifestyle_bio: 'Seeking compatible roommate' };
        await sendSeekerPhoneStep(chatId, updatedDraft, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData === 'seeker_goto_bio') {
        const session = getSession(chatId);
        await sendSeekerBioStep(chatId, session.draft_data, msgId);
        return NextResponse.json({ ok: true });
      }

      // Callback query to start unlock for seeker
      if (callbackData.startsWith('start_unlock_seeker:') || callbackData.startsWith('unlock_seeker_')) {
        const profileId = callbackData.startsWith('start_unlock_seeker:')
          ? callbackData.split(':')[1]
          : callbackData.replace('unlock_seeker_', '');
        await sendUnlockPaywallCard(chatId, profileId, 'roommate_profile', msgId);
        return NextResponse.json({ ok: true });
      }

      // Callback query to start unlock for space
      if (callbackData.startsWith('start_unlock_space:') || callbackData.startsWith('order_')) {
        const spaceId = callbackData.startsWith('start_unlock_space:')
          ? callbackData.split(':')[1]
          : callbackData.replace('order_', '');
        await sendUnlockPaywallCard(chatId, spaceId, 'space_listing', msgId);
        return NextResponse.json({ ok: true });
      }

      // User Self-Close Channel Listing Callback
      if (callbackData.startsWith('user_close_listing:')) {
        const listingId = callbackData.split(':')[1];
        let displayCode = 'Listing';
        let channelMsgId: number | undefined;

        try {
          const { data: p } = await supabaseAdmin
            .from('profiles')
            .update({ status: 'matched' })
            .eq('id', listingId)
            .select('display_code, channel_message_id')
            .single();
          if (p) {
            displayCode = p.display_code || 'Listing';
            channelMsgId = p.channel_message_id;
          }
        } catch {}

        try {
          const { data: rm } = await supabaseAdmin
            .from('roommate_profiles')
            .update({ status: 'matched' })
            .eq('id', listingId)
            .select('channel_message_id')
            .single();
          if (rm?.channel_message_id) {
            channelMsgId = rm.channel_message_id;
          }
        } catch {}

        if (channelMsgId) {
          try {
            await updateChannelPostAsMatched(channelMsgId, displayCode);
          } catch (err) {
            console.error('Failed to update channel post:', err);
          }
        }

        const closedSuccessText = `
✅ <b>Listing Closed &amp; Updated</b>

Your listing <b>#${displayCode}</b> has been marked as matched! 🎉

<blockquote>The channel broadcast post has been updated to <b>CLOSED · MATCHED</b>, and action buttons have been removed.</blockquote>
        `.trim();

        await sendOrEditCard(chatId, closedSuccessText, [
          [{ text: '🏠 Back to Main Menu', callback_data: 'nav_start' }],
        ], msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData === 'seeker_final_submit') {
        const session = getSession(chatId);
        const draftData = session.draft_data;
        const profileId = `seeker_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

        const seekerName = [callback.from.first_name, callback.from.last_name].filter(Boolean).join(' ') || 'Seeker';

        const roommateDraft: RoommateProfileDraft = {
          id: profileId,
          user_telegram_id: callback.from.id,
          user_name: seekerName,
          username: callback.from.username || null,
          contact_phone: draftData.contact_phone || '',
          age: draftData.age || 24,
          preferred_subcity: draftData.preferred_subcity || ['Bole'],
          my_gender: draftData.my_gender || 'Female',
          preferred_gender: draftData.preferred_gender || 'Any',
          budget_min: 0,
          budget_max: draftData.budget_max || 10000,
          lifestyle_bio: draftData.lifestyle_bio || 'Looking for compatible roommate in Addis Ababa.',
          fayda_status: 'verified',
          unlock_fee: 50,
          status: 'approved',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };

        await saveRoommateDraft(roommateDraft);

        try {
          await supabaseAdmin.from('roommate_profiles').insert({
            id: profileId,
            user_id: null,
            my_gender: roommateDraft.my_gender,
            preferred_gender: roommateDraft.preferred_gender,
            age: roommateDraft.age,
            preferred_subcity: roommateDraft.preferred_subcity,
            budget_min: 0,
            budget_max: roommateDraft.budget_max,
            lifestyle_bio: roommateDraft.lifestyle_bio,
            unlock_fee: 50,
            status: 'approved',
          });
        } catch {}

        let displayCode = `RM${Date.now()}`;
        try {
          const { data: codeRow } = await supabaseAdmin.rpc('generate_display_code');
          if (codeRow) displayCode = codeRow;
          roommateDraft.display_code = displayCode;
          await saveRoommateDraft(roommateDraft);

          await supabaseAdmin.from('profiles').upsert({
            telegram_id: callback.from.id,
            display_code: displayCode,
            onboarding_step: 'completed',
            gender: roommateDraft.my_gender,
            locations: roommateDraft.preferred_subcity,
            budget_min: 0,
            budget_max: roommateDraft.budget_max,
            roommate_traits: roommateDraft.lifestyle_bio,
            phone_number: roommateDraft.contact_phone,
            full_name: seekerName,
            telegram_username: callback.from.username || null,
            status: 'active',
          }, { onConflict: 'telegram_id' });
        } catch {}

        try {
          await broadcastRoommateProfileToChannel(profileId);
        } catch (err) {
          console.error('Roommate broadcast error:', err);
        }

        // Notify Admins (Identity masked to preserve privacy)
        try {
          const adminIds = await getAdminIds();
          const subcitiesStr = (roommateDraft.preferred_subcity || []).join(', ');
          const adminNotice = `
👥 <b>SpaceMatch</b> · <b>New Profile Published</b>
📍 <code>${subcitiesStr}</code>

• <b>Seeker Identifier:</b> <code>#${displayCode}</code>
• <b>Gender & Age:</b> ${roommateDraft.my_gender}, ${roommateDraft.age} yrs · Prefers: ${roommateDraft.preferred_gender}
• <b>Budget Cap:</b> <code>${Number(roommateDraft.budget_max).toLocaleString()} ETB / month</code>
• <b>Contact Details:</b> <i>[Encrypted & Stored Securely in DB]</i>
          `.trim();
          for (const adminId of adminIds) {
            sendTelegram('sendMessage', {
              chat_id: adminId,
              text: adminNotice,
              parse_mode: 'HTML',
            }).catch(() => {});
          }
        } catch {}

        await clearSession(chatId);

        const confirmationText = `
🎉 <b>SpaceMatch</b> · <b>Profile Published!</b>

Your roommate listing (<code>#${displayCode}</code>) is now <b>LIVE</b> on our Telegram channel and in the Matchmaker!

<blockquote>🔒 <b>Privacy Shield Active:</b> Your name, phone number, and Telegram handle are completely hidden. Other users can only view your compatibility profile and must pay the matching fee to unlock your direct contact.</blockquote>

🔔 <i>You will receive instant notifications here whenever someone requests to connect with you!</i>
        `.trim();

        const successKeyboard = [
          [{ text: '⚡ Find Roommates Now · Matchmaker 🔍', callback_data: 'matchmaker_start' }],
          [{ text: '🏠 Main Menu', callback_data: 'nav_start' }],
        ];

        await sendOrEditCard(chatId, confirmationText, successKeyboard, msgId);
        return NextResponse.json({ ok: true });
      }

      // Admin Seeker Approval
      if (callbackData.startsWith('seeker_approve:')) {
        const profileId = callbackData.split(':')[1];
        const draft = await getRoommateDraft(profileId);

        if (draft) {
          draft.status = 'approved';
          await saveRoommateDraft(draft);

          try {
            await broadcastRoommateProfileToChannel(profileId);
          } catch (err) {
            console.error('Roommate broadcast error:', err);
          }

          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: `<b>✅ Seeker Profile Published to Channel!</b>`,
            parse_mode: 'HTML',
          });

          await sendTelegram('sendMessage', {
            chat_id: draft.user_telegram_id,
            text: `<b>🎉 Congratulations! Your roommate profile is now LIVE on the channel!</b>`,
            parse_mode: 'HTML',
          });
        }
        return NextResponse.json({ ok: true });
      }

      // Secondary Homeowner Space Callbacks
      if (callbackData === 'property_type') {
        await sendPropertyTypePrompt(chatId, msgId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData.startsWith('prop_type:')) {
        const propType = callbackData.split(':')[1];
        const promptText = `
🏠 <b>SpaceMatch · List Space for Rent</b>
<b>Property Type:</b> <code>${propType.toUpperCase()}</code>

Please send a message or photo in chat with:
• <b>Sub-city & Area:</b> (e.g. Bole, Kazanchis)
• <b>Monthly Rent:</b> (e.g. 12,000 ETB)
• <b>Description & contact phone number</b>

<blockquote>Our admin team will review and publish it directly to the channel!</blockquote>
        `.trim();

        await sendOrEditCard(chatId, promptText, [
          [{ text: '🏠 Back to Main Menu', callback_data: 'nav_start' }],
        ], msgId);
        return NextResponse.json({ ok: true });
      }

      // Fayda ID Verification
      if (callbackData === 'verify_fayda') {
        const isVerified = await isUserFaydaVerified(chatId);
        if (isVerified) {
          const verifiedText = `
🛡️ <b>SpaceMatch</b> · <b>Fayda ID Verified</b>

✅ <b>Your Fayda National ID is Verified!</b>

• <b>Status:</b> 🛡️ Verified Resident
• <b>Access:</b> Full Platform Access (Matchmaker, Seeker Profiles, Contact Unlocks)
• <b>Security:</b> Offline Verhoeff Checksum Validated

<blockquote>You are fully approved to match, post, and connect safely across Addis Ababa.</blockquote>
          `.trim();
          await sendOrEditCard(chatId, verifiedText, [
            [{ text: '⚡ Find a Roommate · Matchmaker 🔍', callback_data: 'matchmaker_start' }],
            [{ text: '👥 Post Seeker Profile', callback_data: 'seeker_flow' }],
            [{ text: '🏠 Back to Main Menu', callback_data: 'nav_start' }],
          ], msgId);
          return NextResponse.json({ ok: true });
        }

        await sendFaydaGateCard(chatId, 'access all SpaceMatch verified features', msgId);
        return NextResponse.json({ ok: true });
      }

      // Platform Guide
      if (callbackData === 'nav_help') {
        const helpText = `
✨ <b>SpaceMatch Addis · How It Works</b>

• <b>1. Smart Matchmaker</b>
Select your target sub-cities and budget to immediately explore compatible verified roommates.

• <b>2. Anonymous Seeker Listings</b>
Publish your profile to our channel. Your real name, phone, and Telegram handle remain 100% confidential.

• <b>3. Verified Contact Unlock</b>
Connect via mutual match or instant contact unlock with Fayda-verified security.
        `.trim();

        await sendOrEditCard(chatId, helpText, [
          [{ text: '⚡ Find a Roommate · Matchmaker 🔍', callback_data: 'matchmaker_start' }],
          [{ text: '🏠 Back to Main Menu', callback_data: 'nav_start' }],
        ], msgId);
        return NextResponse.json({ ok: true });
      }

      // My Active Listings (Manage & Close)
      if (callbackData === 'my_listings') {
        await sendMyListingsScreen(chatId, msgId);
        return NextResponse.json({ ok: true });
      }

      // My Unlocked Contacts (Real data from DB)
      if (callbackData === 'my_unlocked_contacts') {
        let ordersList: any[] = [];
        try {
          const { data } = await supabaseAdmin
            .from('orders')
            .select('*')
            .eq('buyer_telegram_id', chatId)
            .eq('payment_status', 'completed')
            .order('created_at', { ascending: false })
            .limit(10);
          if (data) ordersList = data;
        } catch {}

        if (ordersList.length === 0) {
          const emptyText = `
📂 <b>SpaceMatch</b> · <b>My Unlocked Contacts</b>

<blockquote>You haven't unlocked any contacts yet. Browse the Matchmaker to find verified roommates!</blockquote>
          `.trim();
          await sendOrEditCard(chatId, emptyText, [
            [{ text: '⚡ Find a Roommate · Matchmaker 🔍', callback_data: 'matchmaker_start' }],
            [{ text: '🏠 Main Menu', callback_data: 'nav_start' }],
          ], msgId);
          return NextResponse.json({ ok: true });
        }

        let msg = `📂 <b>SpaceMatch</b> · <b>My Unlocked Contacts (${ordersList.length})</b>\n\n`;
        const buttons: any[] = [];

        for (let idx = 0; idx < ordersList.length; idx++) {
          const ord = ordersList[idx];
          const targetId = ord.target_id;
          let contactName = 'Unlocked Roommate';
          let contactPhone = '';
          let contactUsername = '';

          try {
            const { data: prof } = await supabaseAdmin
              .from('roommate_profiles')
              .select('*, users(*)')
              .eq('id', targetId)
              .single();
            if (prof?.users) {
              contactName = [prof.users.first_name, prof.users.last_name].filter(Boolean).join(' ') || 'Roommate';
              contactPhone = prof.users.phone_number || '';
              contactUsername = prof.users.username || '';
            }
          } catch {}

          if (contactName === 'Unlocked Roommate') {
            const draft = await getRoommateDraft(targetId);
            if (draft) {
              contactName = draft.user_name || 'Roommate';
              contactPhone = draft.contact_phone || '';
              contactUsername = draft.username || '';
            }
          }

          if (contactName === 'Unlocked Roommate') {
            try {
              const { data: pData } = await supabaseAdmin
                .from('profiles')
                .select('*')
                .eq('id', targetId)
                .single();
              if (pData) {
                contactName = pData.full_name || 'Roommate Seeker';
                contactPhone = pData.phone_number || '';
                contactUsername = pData.telegram_username || '';
              }
            } catch {}
          }

          const phoneDisplay = contactPhone ? `📞 <code>${contactPhone}</code>` : '📞 Contact Verified';
          const userDisplay = contactUsername ? `| 💬 @${contactUsername.replace('@', '')}` : '';
          msg += `\n${idx + 1}. <b>${contactName}</b>\n   ${phoneDisplay} ${userDisplay}\n`;

          if (contactUsername) {
            const cleanUser = contactUsername.replace('@', '');
            buttons.push([{ text: `💬 Chat with ${contactName}`, url: `https://t.me/${cleanUser}` }]);
          }
        }

        buttons.push([
          { text: '🔍 Find Another Roommate', callback_data: 'matchmaker_start' },
          { text: '🏠 Main Menu', callback_data: 'nav_start' },
        ]);

        await sendOrEditCard(chatId, msg.trim(), buttons, msgId);
        return NextResponse.json({ ok: true });
      }

      // Admin Dashboard Menu
      if (callbackData === 'admin_menu') {
        let pendingCount = 0;
        try {
          const { count } = await supabaseAdmin
            .from('profiles')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'pending_approval');
          pendingCount = count || 0;
        } catch {}

        const adminKeyboard = {
          inline_keyboard: [
            [{ text: `⏳ Pending Approvals (${pendingCount})`, callback_data: 'admin_list_pending' }],
            [{ text: '📢 Post to Channel as Admin 🛠️', callback_data: 'admin_post_start' }],
            [{ text: '📡 Connected Channels & Settings 📢', callback_data: 'admin_list_channels' }],
            [{ text: '🔴 Active Channel Posts & Close / Match', callback_data: 'admin_list_active_posts' }],
            [{ text: '📢 Post Custom Announcement', callback_data: 'admin_custom_prompt' }],
            [{ text: '❌ Exit Admin Menu', callback_data: 'admin_cancel' }],
          ],
        };

        const menuText = `<b>👑 SpaceMatch Admin Panel</b>\nManage pending reviews, active listings, and channel posts:`;
        if (msgId) {
          await sendTelegram('editMessageText', {
            chat_id: chatId,
            message_id: msgId,
            text: menuText,
            parse_mode: 'HTML',
            reply_markup: adminKeyboard,
          });
        } else {
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: menuText,
            parse_mode: 'HTML',
            reply_markup: adminKeyboard,
          });
        }
        return NextResponse.json({ ok: true });
      }

      // Admin: List Pending Roommate Profiles for Approval
      if (callbackData === 'admin_list_pending') {
        const adminIds = await getAdminIds();
        if (!adminIds.includes(chatId)) {
          await tgSend(chatId, `⛔ <b>Access Denied.</b>`);
          return NextResponse.json({ ok: true });
        }

        let pendingList: any[] = [];
        try {
          const { data } = await supabaseAdmin
            .from('profiles')
            .select('*')
            .eq('status', 'pending_approval')
            .order('created_at', { ascending: false })
            .limit(10);
          if (data) pendingList = data;
        } catch {}

        if (pendingList.length === 0) {
          await sendOrEditCard(
            chatId,
            `⏳ <b>SpaceMatch Admin · Pending Approvals</b>\n\n<blockquote>No profiles are currently waiting for admin approval. All caught up! 🎉</blockquote>`,
            [[{ text: '⬅️ Back to Admin Menu', callback_data: 'admin_menu' }]],
            msgId
          );
          return NextResponse.json({ ok: true });
        }

        const buttons: any[] = [];
        for (const p of pendingList) {
          const code = p.display_code || p.id;
          const loc = Array.isArray(p.locations) ? p.locations[0] || 'Addis' : 'Addis';
          buttons.push([
            { text: `✅ Approve #${code} (${p.gender || 'Any'} · ${loc})`, callback_data: `admin_approve_profile:${code}` },
            { text: `❌ Reject`, callback_data: `admin_reject_profile:${code}` },
          ]);
        }
        buttons.push([{ text: '⬅️ Back to Admin Menu', callback_data: 'admin_menu' }]);

        await sendOrEditCard(
          chatId,
          `⏳ <b>SpaceMatch Admin · Pending Profiles (${pendingList.length})</b>\n\nReview the listings waiting for approval below:`,
          buttons,
          msgId
        );
        return NextResponse.json({ ok: true });
      }

      // Admin: View Connected Channels & Management
      if (callbackData === 'admin_list_channels') {
        const adminIds = await getAdminIds();
        if (!adminIds.includes(chatId)) {
          await tgSend(chatId, `⛔ <b>Access Denied.</b>`);
          return NextResponse.json({ ok: true });
        }

        const channels = await getManagedChannels();
        let text = `📢 <b>Connected Channels & Broadcasting (${channels.length})</b>\n\n`;
        if (channels.length === 0) {
          text += `<i>No channels currently registered. The bot uses the default channel (@roommatch_addis).\n\nTo link a channel, add this bot as an administrator to that channel, or send:</i>\n<code>/setchannel @your_channel</code>`;
        } else {
          for (let i = 0; i < channels.length; i++) {
            const ch = channels[i];
            const icon = ch.is_active ? '🟢' : '🔴';
            text += `${i + 1}. ${icon} <b>${ch.channel_title}</b>\n`;
            text += `   • ID: <code>${ch.channel_id}</code>\n`;
            if (ch.channel_username) text += `   • Username: <b>${ch.channel_username}</b>\n`;
            text += `   • Status: ${ch.is_active ? 'Active' : 'Inactive'}\n\n`;
          }
          text += `<i>💡 Any channel where @${botUsername} is added as administrator will automatically connect here and recognize its channel admins!</i>`;
        }

        const buttons = [
          [{ text: '⬅️ Back to Admin Menu', callback_data: 'admin_menu' }],
          [{ text: '🏠 Main Menu', callback_data: 'nav_start' }],
        ];

        await sendOrEditCard(chatId, text, buttons, msgId);
        return NextResponse.json({ ok: true });
      }

      // Admin: List Active Channel Posts
      if (callbackData === 'admin_list_active_posts') {
        let activePosts: any[] = [];

        try {
          const { data: dbProfs } = await supabaseAdmin
            .from('roommate_profiles')
            .select('*')
            .not('channel_message_id', 'is', null)
            .neq('status', 'matched')
            .order('created_at', { ascending: false })
            .limit(10);
          if (dbProfs) {
            for (const p of dbProfs) {
              activePosts.push({
                id: p.id,
                type: 'roommate',
                channel_message_id: p.channel_message_id,
                title: `Roommate Seeker (${p.my_gender || 'Candidate'})`,
                is_photo: false,
              });
            }
          }
        } catch {}

        try {
          const { data: dbSpaces } = await supabaseAdmin
            .from('spaces')
            .select('*')
            .not('channel_message_id', 'is', null)
            .neq('status', 'matched')
            .order('created_at', { ascending: false })
            .limit(10);
          if (dbSpaces) {
            for (const s of dbSpaces) {
              activePosts.push({
                id: s.id,
                type: 'space',
                channel_message_id: s.channel_message_id,
                title: s.title || 'Space Listing',
                is_photo: !!(s.photo_file_id || s.photo_url),
              });
            }
          }
        } catch {}

        const localRoommates = Object.values(await getAllRoommateDrafts());
        for (const r of localRoommates) {
          if (r.channel_message_id && r.status !== 'matched' && !activePosts.some((p) => p.id === r.id)) {
            activePosts.push({
              id: r.id,
              type: 'roommate',
              channel_message_id: r.channel_message_id,
              title: `Roommate #${r.display_code || 'RM' + r.id.slice(0, 4)}`,
              is_photo: false,
            });
          }
        }

        if (activePosts.length === 0) {
          const text = `📢 <b>SpaceMatch Admin · Active Channel Posts</b>\n\n<blockquote>No active open channel posts found at this time.</blockquote>`;
          const keyboard = {
            inline_keyboard: [[{ text: '⬅️ Back to Admin Menu', callback_data: 'admin_menu' }]],
          };
          if (msgId) {
            await sendTelegram('editMessageText', {
              chat_id: chatId,
              message_id: msgId,
              text,
              parse_mode: 'HTML',
              reply_markup: keyboard,
            });
          } else {
            await sendTelegram('sendMessage', {
              chat_id: chatId,
              text,
              parse_mode: 'HTML',
              reply_markup: keyboard,
            });
          }
          return NextResponse.json({ ok: true });
        }

        const buttons: any[] = [];
        for (const post of activePosts) {
          buttons.push([
            {
              text: `🔴 Mark Matched: #${post.channel_message_id} (${post.title.substring(0, 20)})`,
              callback_data: `admin_close_post:${post.type}:${post.id}:${post.channel_message_id}`,
            },
          ]);
        }
        buttons.push([{ text: '⬅️ Back to Admin Menu', callback_data: 'admin_menu' }]);

        const text = `📢 <b>SpaceMatch Admin</b> · <b>Active Channel Posts (${activePosts.length})</b>\n\nTap any post below to mark it as <b>CLOSED · MATCHED</b> on the channel and remove connect buttons:`;

        if (msgId) {
          await sendTelegram('editMessageText', {
            chat_id: chatId,
            message_id: msgId,
            text,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: buttons },
          });
        } else {
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: buttons },
          });
        }
        return NextResponse.json({ ok: true });
      }

      // Admin: Mark Matched & Close Channel Post
      if (callbackData.startsWith('admin_close_post:')) {
        const parts = callbackData.split(':');
        const postType = parts[1];
        const postId = parts[2];
        const channelMsgId = parseInt(parts[3], 10);

        let itemTitle = 'Listing';
        let isPhoto = false;

        if (postType === 'roommate') {
          itemTitle = 'Roommate Profile';
          try {
            await supabaseAdmin
              .from('roommate_profiles')
              .update({ status: 'matched' })
              .eq('id', postId);
          } catch {}
          try {
            const draft = await getRoommateDraft(postId);
            if (draft) {
              draft.status = 'matched';
              await saveRoommateDraft(draft);
            }
          } catch {}
        } else {
          itemTitle = 'Space Listing';
          try {
            const { data: sp } = await supabaseAdmin
              .from('spaces')
              .update({ status: 'matched' })
              .eq('id', postId)
              .select('title, photo_file_id, photo_url')
              .single();
            if (sp) {
              itemTitle = sp.title || 'Space Listing';
              isPhoto = !!(sp.photo_file_id || sp.photo_url);
            }
          } catch {}
          try {
            const draft = await getDraft(postId);
            if (draft) {
              draft.status = 'matched';
              await saveDraft(draft);
              if (draft.title) itemTitle = draft.title;
              isPhoto = !!(draft.photo_file_id || draft.photo_url);
            }
          } catch {}
        }

        const closeResult = await closeChannelPost(channelMsgId, itemTitle, isPhoto);

        const text = closeResult.success
          ? `✅ <b>Post #${channelMsgId} Officially Closed!</b>\n\n🤝 <i>"${itemTitle}" has been updated on the channel with <b>CLOSED · MATCHED</b> and action buttons were removed.</i>`
          : `⚠️ <b>Could not update channel post #${channelMsgId}:</b>\n${closeResult.message}`;

        const keyboard = {
          inline_keyboard: [
            [{ text: '📋 View Remaining Active Posts', callback_data: 'admin_list_active_posts' }],
            [{ text: '⬅️ Back to Admin Menu', callback_data: 'admin_menu' }],
          ],
        };

        if (msgId) {
          await sendTelegram('editMessageText', {
            chat_id: chatId,
            message_id: msgId,
            text,
            parse_mode: 'HTML',
            reply_markup: keyboard,
          });
        } else {
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text,
            parse_mode: 'HTML',
            reply_markup: keyboard,
          });
        }
        return NextResponse.json({ ok: true });
      }

      return NextResponse.json({ ok: true });
    }

    // -------------------------------------------------------------------------
    // 2. HANDLE INCOMING TEXT MESSAGES & COMMANDS
    // -------------------------------------------------------------------------
    const message = update.message;
    if (message && message.chat) {
      const chatId: number = message.chat.id;
      const text: string = (message.text || message.caption || '').trim();

      // Load session from Supabase before any getSession() call
      await preloadSession(chatId);
      const session = getSession(chatId);

      // Forward detection: Admin forwards a channel post to close/mark as matched
      const forwardChat = (message as any).forward_from_chat || (message as any).forward_origin?.chat;
      const forwardMsgId = (message as any).forward_from_message_id || (message as any).forward_origin?.message_id;
      if (forwardMsgId || forwardChat) {
        const adminIds = await getAdminIds();
        if (adminIds.includes(chatId)) {
          let foundCode: string | null = null;
          if (text) {
            const matchCode = text.match(/#(RM\d+|SP\d+)/i);
            if (matchCode) foundCode = matchCode[1].toUpperCase();
          }
          if (!foundCode && forwardMsgId) {
            const { data: p } = await supabaseAdmin
              .from('profiles')
              .select('display_code')
              .eq('channel_message_id', forwardMsgId)
              .maybeSingle();
            if (p?.display_code) {
              foundCode = p.display_code;
            } else {
              const { data: rm } = await supabaseAdmin
                .from('roommate_profiles')
                .select('display_code')
                .eq('channel_message_id', forwardMsgId)
                .maybeSingle();
              if (rm?.display_code) {
                foundCode = rm.display_code;
              } else {
                foundCode = `RM${forwardMsgId}`;
              }
            }
          }

          const targetIdentifier = foundCode || (forwardMsgId ? String(forwardMsgId) : 'POST');
          const targetChannel = await getPrimaryChannel();
          const channelHandle = String(targetChannel).replace('@', '');
          const postLink = forwardMsgId ? `https://t.me/${channelHandle}/${forwardMsgId}` : '';

          const forwardPromptText = `
📢 <b>SpaceMatch Admin · Channel Post Forward Detected</b>

Detected Channel Post <b>#${targetIdentifier}</b> (Message ID: <code>${forwardMsgId || 'N/A'}</code>).

Would you like to mark this channel post as <b>CLOSED / MATCHED</b>?
          `.trim();

          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: forwardPromptText,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: `🔴 Mark #${targetIdentifier} as CLOSED in Channel`, callback_data: `admin_close:${targetIdentifier}` }],
                ...(postLink ? [[{ text: '📢 View Channel Post ↗️', url: postLink }]] : []),
                [{ text: '🏠 Cancel', callback_data: 'nav_start' }],
              ],
            },
          });
          return NextResponse.json({ ok: true });
        }
      }

      // Reply Keyboard Button Handler
      if (text === '🔍 Find Roommate (Matchmaker)' || text === '🔍 Find Roommate') {
        await clearSession(chatId);
        await sendMatchmakerSubcityStep(chatId);
        return NextResponse.json({ ok: true });
      }

      if (
        text === '👥 Post Seeker Profile' ||
        text === '👥 Post Seeker Profile (Looking for Roommate)' ||
        text === '📢 Post Profile to Channel' ||
        text === '📢 Post Your Profile to Channel'
      ) {
        await clearSession(chatId);
        const isVerified = await isUserFaydaVerified(chatId);
        if (isVerified) {
          const { data: p } = await supabaseAdmin.from('profiles').select('*').eq('telegram_id', chatId).maybeSingle();
          if (p) {
            await sendChannelPublishPreviewCard(chatId, p);
            return NextResponse.json({ ok: true });
          }
        }
        await sendDynamicCardStep1Age(chatId, { mode: 'post_to_channel' });
        return NextResponse.json({ ok: true });
      }

      if (text === '🏠 Share Space to Rent' || text === '🏠 Share Space / Room for Rent') {
        await clearSession(chatId);
        await sendPropertyTypePrompt(chatId);
        return NextResponse.json({ ok: true });
      }

      if (text === '🛡️ Verify Fayda ID') {
        await clearSession(chatId);
        const isVerified = await isUserFaydaVerified(chatId);
        if (isVerified) {
          const verifiedText = `
🛡️ <b>SpaceMatch</b> · <b>Fayda ID Verified</b>

✅ <b>Your Fayda National ID is Verified!</b>

• <b>Status:</b> 🛡️ Verified Resident
• <b>Access:</b> Full Platform Access (Matchmaker, Seeker Profiles, Contact Unlocks)
• <b>Security:</b> Offline Verhoeff Checksum Validated

<blockquote>You are fully approved to match, post, and connect safely across Addis Ababa.</blockquote>
          `.trim();
          await sendOrEditCard(chatId, verifiedText, [
            [{ text: '⚡ Find a Roommate · Matchmaker 🔍', callback_data: 'matchmaker_start' }],
            [{ text: '📢 Post Profile to Channel ↗️', callback_data: 'post_to_channel_start' }],
            [{ text: '🏠 Back to Main Menu', callback_data: 'nav_start' }],
          ]);
          return NextResponse.json({ ok: true });
        }
        await sendFaydaGateCard(chatId, 'access all SpaceMatch verified features');
        return NextResponse.json({ ok: true });
      }

      // ── Space Owner Questionnaire: Message Handlers ───────────────────────
      // Space Photos Upload (handled via Telegram file_id, not stored in DB)
      if (session.step === 'space_input_photos') {
        const photos = session.draft_data?.space_photos || [];
        if (message.photo && Array.isArray(message.photo) && message.photo.length > 0) {
          const largestPhoto = message.photo[message.photo.length - 1];
          const fileId = largestPhoto.file_id;
          const updatedPhotos = [...photos, fileId];

          await saveSession({
            telegram_id: chatId,
            step: 'space_input_photos',
            draft_data: { ...session.draft_data, space_photos: updatedPhotos },
            updated_at: new Date().toISOString(),
          });

          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: `✅ <b>Photo received!</b> (Total uploaded: <b>${updatedPhotos.length}</b>)\n\nYou can send another photo, or tap below to proceed:`,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: `➡️ Proceed with ${updatedPhotos.length} Photo(s) 🚀`, callback_data: 'space_photos_done' }],
                [{ text: '🏠 Cancel', callback_data: 'nav_start' }],
              ],
            },
          });
          return NextResponse.json({ ok: true });
        }
      }

      // Space Rent Text Input
      if (session.step === 'space_input_rent') {
        if (update.message?.message_id) {
          await sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id });
        }
        const activeMsgId = session.draft_data?.card_msg_id;
        const parsedRent = parseNumericInput(text);
        if (!parsedRent || parsedRent < 500 || parsedRent > 500000) {
          await sendSpaceStep2Rent(
            chatId,
            session.draft_data,
            activeMsgId,
            'Please enter a valid monthly rent amount between 500 and 500,000 ETB:'
          );
          return NextResponse.json({ ok: true });
        }
        const updatedDraft = { ...session.draft_data, space_rent: parsedRent };
        await sendSpaceStep3Share(chatId, updatedDraft, activeMsgId);
        return NextResponse.json({ ok: true });
      }

      // Space Roommate Share Text Input
      if (session.step === 'space_input_share') {
        if (update.message?.message_id) {
          await sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id });
        }
        const activeMsgId = session.draft_data?.card_msg_id;
        const parsedShare = parseNumericInput(text);
        if (!parsedShare || parsedShare < 200 || parsedShare > 500000) {
          await sendSpaceStep3Share(
            chatId,
            session.draft_data,
            activeMsgId,
            'Please enter a valid roommate share amount between 200 and 500,000 ETB:'
          );
          return NextResponse.json({ ok: true });
        }
        const updatedDraft = { ...session.draft_data, space_share: parsedShare };
        await sendSpaceStep4Amenities(chatId, updatedDraft, activeMsgId);
        return NextResponse.json({ ok: true });
      }

      // Standalone Fayda FAN Input (from /fayda or gate cards)
      if (session.step === 'awaiting_standalone_fayda_fan') {
        if (update.message?.message_id) {
          await sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id });
        }
        const activeMsgId = session.draft_data?.card_msg_id;
        const fanResult = validateFaydaFan(text);

        if (!fanResult.valid || !fanResult.fanNumber) {
          await sendOrEditCard(
            chatId,
            `🛡️ <b>SpaceMatch · Fayda ID Verification Required</b>\n\n⚠️ <b>${fanResult.error || 'Invalid Fayda FAN number. Please check the digits and try again.'}</b>\n\nPlease reply with your 12-digit or 16-digit FAN number:`,
            [
              [{ text: '📷 Open Camera to Scan Fayda QR ↗️', web_app: { url: `${appUrl}?startapp=verify_fayda` } }],
              [{ text: '🏠 Back to Main Menu', callback_data: 'nav_start' }],
            ],
            activeMsgId
          );
          return NextResponse.json({ ok: true });
        }

        const { data: existingUser } = await supabaseAdmin
          .from('users')
          .select('id, telegram_id')
          .eq('fayda_number', fanResult.fanNumber)
          .neq('telegram_id', chatId)
          .maybeSingle();

        if (existingUser) {
          await sendOrEditCard(
            chatId,
            `⚠️ <b>Fayda ID Already Registered</b>\n\nThis Fayda National ID is already registered to another account.`,
            [[{ text: '🏠 Main Menu', callback_data: 'nav_start' }]],
            activeMsgId
          );
          return NextResponse.json({ ok: true });
        }

        await supabaseAdmin
          .from('users')
          .upsert({
            telegram_id: chatId,
            fayda_status: 'verified',
            fayda_number: fanResult.fanNumber,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'telegram_id' });

        await supabaseAdmin
          .from('profiles')
          .update({ kyc_status: 'verified', status: 'active' })
          .eq('telegram_id', chatId);

        await clearSession(chatId);

        const verifiedText = `
🎉 <b>FAYDA NATIONAL ID VERIFIED!</b>
🛡️ <b>Status:</b> VERIFIED ✅

• <b>Fayda ID:</b> <code>•••• •••• ${fanResult.fanNumber.slice(-4)}</code>
• <b>Access:</b> Full Platform Access (Matchmaker, Seeker Profiles, Mutual Connections)
• <b>Validation:</b> Instant Offline Dihedral Checksum Validated ✅

<blockquote>You are fully approved to match, post, and connect safely across Addis Ababa.</blockquote>
        `.trim();

        await sendOrEditCard(
          chatId,
          verifiedText,
          [
            [{ text: '⚡ Find a Roommate · Matchmaker 🔍', callback_data: 'matchmaker_start' }],
            [{ text: '📢 Post Your Profile to Channel ↗️', callback_data: 'post_to_channel_start' }],
            [{ text: '🏠 Back to Main Menu', callback_data: 'nav_start' }],
          ],
          activeMsgId
        );
        return NextResponse.json({ ok: true });
      }

      // ── ADMIN POST WIZARD TEXT INPUT HANDLERS ─────────────────────────────
      // Admin Post Wizard: Budget/Rent Text Input
      if (session.step === 'admin_post_budget') {
        if (update.message?.message_id) {
          await sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id });
        }
        const activeMsgId = session.draft_data?.card_msg_id;
        const budgetVal = parseNumericInput(text);
        if (!budgetVal || budgetVal < 500 || budgetVal > 1000000) {
          await sendAdminPostBudgetStep(
            chatId,
            session.draft_data,
            activeMsgId,
            'Please enter a valid monthly rent/budget in ETB (e.g. 12000):'
          );
          return NextResponse.json({ ok: true });
        }

        const updatedDraft = { ...session.draft_data, budget: budgetVal };
        await sendAdminPostGenderStep(chatId, updatedDraft, activeMsgId);
        return NextResponse.json({ ok: true });
      }

      // Admin Post Wizard: Bio / Description Text Input
      if (session.step === 'admin_post_bio') {
        if (update.message?.message_id) {
          await sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id });
        }
        const activeMsgId = session.draft_data?.card_msg_id;
        const bioText = text.toLowerCase() === 'default' || text.toLowerCase() === 'skip'
          ? 'Seeking compatible roommate in Addis Ababa.'
          : text;
        const updatedDraft = { ...session.draft_data, details: bioText };
        await sendAdminPostPreviewCard(chatId, updatedDraft, activeMsgId);
        return NextResponse.json({ ok: true });
      }

      // ── DYNAMIC CARD TEXT INPUT HANDLERS ────────────────────────────────────

      // Step 1 Text Input: Age
      if (session.step === 'dyn_card_age') {
        if (update.message?.message_id) {
          await sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id });
        }
        const activeMsgId = session.draft_data?.card_msg_id;
        const ageVal = parseNumericInput(text);
        if (!ageVal || ageVal < 18 || ageVal > 85) {
          await sendDynamicCardStep1Age(
            chatId,
            session.draft_data,
            activeMsgId,
            'Please enter a valid numerical age between 18 and 85 (e.g. 24):'
          );
          return NextResponse.json({ ok: true });
        }

        const updatedDraft = { ...session.draft_data, age: ageVal };
        await sendDynamicCardStep2Gender(chatId, updatedDraft, activeMsgId);
        return NextResponse.json({ ok: true });
      }

      // Step 3 Text Input: Monthly Budget (Open Numeric ETB)
      if (session.step === 'dyn_card_budget') {
        if (update.message?.message_id) {
          await sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id });
        }
        const activeMsgId = session.draft_data?.card_msg_id;
        const budgetVal = parseNumericInput(text);
        if (!budgetVal || budgetVal < 500 || budgetVal > 1000000) {
          await sendDynamicCardStep3Budget(
            chatId,
            session.draft_data,
            activeMsgId,
            'Please enter a valid monthly budget in ETB (e.g. 12000):'
          );
          return NextResponse.json({ ok: true });
        }

        const updatedDraft = { ...session.draft_data, budget_max: budgetVal };
        await sendDynamicCardStep4Subcities(chatId, updatedDraft, activeMsgId);
        return NextResponse.json({ ok: true });
      }

      // Step 5 Text Input: Fayda FAN Verification
      if (session.step === 'dyn_card_fayda_fan') {
        if (update.message?.message_id) {
          await sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id });
        }
        const activeMsgId = session.draft_data?.card_msg_id;
        const fanResult = validateFaydaFan(text);

        if (!fanResult.valid || !fanResult.fanNumber) {
          await sendDynamicCardStep5FaydaFan(
            chatId,
            session.draft_data,
            activeMsgId,
            fanResult.error || 'Invalid Fayda FAN number. Please check the digits and try again.'
          );
          return NextResponse.json({ ok: true });
        }

        // Check if FAN number is already bound to another account
        const { data: existingUser } = await supabaseAdmin
          .from('users')
          .select('id, telegram_id')
          .eq('fayda_number', fanResult.fanNumber)
          .neq('telegram_id', chatId)
          .maybeSingle();

        if (existingUser) {
          await sendDynamicCardStep5FaydaFan(
            chatId,
            session.draft_data,
            activeMsgId,
            'This Fayda National ID is already registered to another account.'
          );
          return NextResponse.json({ ok: true });
        }

        // Generate or retrieve display code
        let displayCode = `RM${Date.now().toString().slice(-4)}`;
        try {
          const { data: codeRow } = await supabaseAdmin.rpc('generate_display_code');
          if (codeRow) displayCode = codeRow;
        } catch {}

        // 1. Update user record
        const userFullName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ') || 'Verified Member';
        await supabaseAdmin
          .from('users')
          .upsert({
            telegram_id: chatId,
            first_name: message.from?.first_name || '',
            last_name: message.from?.last_name || '',
            username: message.from?.username || null,
            fayda_status: 'verified',
            fayda_number: fanResult.fanNumber,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'telegram_id' });

        // 2. Upsert seeker profile
        const preferredSubs = session.draft_data.preferred_subcity || ['Bole'];
        const userAge = session.draft_data.age || 24;
        const userGender = session.draft_data.gender || 'Any';
        const userBudget = session.draft_data.budget_max || 10000;
        const targetId = session.draft_data.target_id;
        const targetCode = session.draft_data.target_code;

        const { data: savedProfile } = await supabaseAdmin
          .from('profiles')
          .upsert({
            telegram_id: chatId,
            display_code: displayCode,
            onboarding_step: 'completed',
            gender: userGender,
            age: userAge,
            locations: preferredSubs,
            budget_min: 0,
            budget_max: userBudget,
            roommate_traits: `Seeking roommate in ${preferredSubs.join(', ')}. Age: ${userAge}.`,
            full_name: userFullName,
            telegram_username: message.from?.username || null,
            kyc_status: 'verified',
            status: 'active',
          }, { onConflict: 'telegram_id' })
          .select('id, display_code, gender, age, locations, budget_max, roommate_traits')
          .single();

        const { data: savedRm } = await supabaseAdmin
          .from('roommate_profiles')
          .upsert({
            user_telegram_id: chatId,
            display_code: displayCode,
            age: userAge,
            my_gender: userGender,
            preferred_gender: 'Any',
            preferred_subcity: preferredSubs,
            budget_min: 0,
            budget_max: userBudget,
            lifestyle_bio: `Seeking roommate in ${preferredSubs.join(', ')}. Age: ${userAge}.`,
            unlock_fee: 50,
            status: 'approved',
          }, { onConflict: 'user_telegram_id' })
          .select('id')
          .single();

        await clearSession(chatId);

        // Branch 1: User requested connection with a channel post target
        if (targetId || targetCode) {
          let targetProfile: any = null;
          if (targetId) {
            const { data: p } = await supabaseAdmin.from('profiles').select('*').eq('id', targetId).maybeSingle();
            targetProfile = p;
          }
          if (!targetProfile && targetCode) {
            const { data: p } = await supabaseAdmin.from('profiles').select('*').eq('display_code', targetCode).maybeSingle();
            targetProfile = p;
          }

          if (!targetProfile) {
            await sendOrEditCard(
              chatId,
              `✅ <b>Fayda Verified!</b>\n\nHowever, the roommate listing (#${targetCode || 'RM'}) is no longer active.`,
              [
                [{ text: '⚡ Find Other Roommates 🔍', callback_data: 'matchmaker_start' }],
                [{ text: '🏠 Main Menu', callback_data: 'nav_start' }],
              ],
              activeMsgId
            );
            return NextResponse.json({ ok: true });
          }

          // Check if self-request
          if (String(targetProfile.telegram_id) === String(chatId)) {
            await sendOrEditCard(
              chatId,
              `ℹ️ <b>This is your own listing!</b>\n\nYou cannot send a match request to yourself.`,
              [[{ text: '🏠 Main Menu', callback_data: 'nav_start' }]],
              activeMsgId
            );
            return NextResponse.json({ ok: true });
          }

          const myProfileId = savedProfile?.id || savedRm?.id;

          // Check if match already requested
          const { data: existingMatch } = await supabaseAdmin
            .from('matches')
            .select('id, status')
            .eq('requester_id', myProfileId)
            .eq('target_id', targetProfile.id)
            .maybeSingle();

          if (existingMatch) {
            await sendOrEditCard(
              chatId,
              `ℹ️ You already sent a match request to Roommate <b>#${targetProfile.display_code}</b>.\nStatus: <b>${existingMatch.status.replace('_', ' ')}</b>`,
              [[{ text: '🔍 Find Other Roommates', callback_data: 'matchmaker_start' }], [{ text: '🏠 Main Menu', callback_data: 'nav_start' }]],
              activeMsgId
            );
            return NextResponse.json({ ok: true });
          }

          const { data: newMatch, error: matchError } = await supabaseAdmin
            .from('matches')
            .insert({
              requester_id: myProfileId,
              target_id: targetProfile.id,
              status: 'pending_acceptance',
              payment_status: 'unpaid',
            })
            .select('id')
            .single();

          if (matchError || !newMatch) {
            console.error('Match creation error:', matchError);
            await sendOrEditCard(
              chatId,
              `❌ Could not send match request. Please try again.`,
              [[{ text: '🏠 Main Menu', callback_data: 'nav_start' }]],
              activeMsgId
            );
            return NextResponse.json({ ok: true });
          }

          // Notify Requester
          await sendOrEditCard(
            chatId,
            `✅ <b>Fayda Verified & Match Request Sent!</b>\n\nYour request has been delivered to Roommate <b>#${targetProfile.display_code}</b>.\n\n<blockquote>🔔 You will receive an instant notification the moment they accept!</blockquote>`,
            [
              [{ text: '⚡ Find Other Roommates 🔍', callback_data: 'matchmaker_start' }],
              [{ text: '🏠 Main Menu', callback_data: 'nav_start' }],
            ],
            activeMsgId
          );

          // Notify Target User
          const reqSubcities = preferredSubs.join(', ');
          const notifyText = `🤝 <b>SpaceMatch · New Connection Request!</b>\n\nA verified user saw your channel listing and wants to connect!\n\n• <b>Profile:</b> ${userGender}, Age ${userAge}\n• <b>Budget Cap:</b> <code>Up to ${Number(userBudget).toLocaleString()} ETB / month</code>\n• <b>Target Areas:</b> <code>${reqSubcities}</code>\n\n<blockquote>Would you like to connect with this roommate?</blockquote>`;

          if (targetProfile.telegram_id) {
            await tgSend(targetProfile.telegram_id, notifyText, {
              inline_keyboard: [
                [
                  { text: '✅ Accept Match', callback_data: `match_accept:${newMatch.id}` },
                  { text: '❌ Decline', callback_data: `match_decline:${newMatch.id}` },
                ],
              ],
            });
          }

          return NextResponse.json({ ok: true });
        }

        // Branch 2: Post to Channel flow
        const profileForReview = savedProfile || {
          id: savedRm?.id,
          display_code: displayCode,
          gender: userGender,
          age: userAge,
          locations: preferredSubs,
          budget_max: userBudget,
          roommate_traits: `Seeking roommate in ${preferredSubs.join(', ')}. Age: ${userAge}.`,
        };

        await sendChannelPublishPreviewCard(chatId, profileForReview, activeMsgId);
        return NextResponse.json({ ok: true });
      }

      // Target User Verification before accepting match
      if (session.step && session.step.startsWith('awaiting_target_fayda_fan:')) {
        const matchId = session.step.split(':')[1];
        if (update.message?.message_id) {
          await sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id });
        }
        const activeMsgId = session.draft_data?.card_msg_id;
        const fanResult = validateFaydaFan(text);

        if (!fanResult.valid || !fanResult.fanNumber) {
          const errMsg = fanResult.error || 'Invalid Fayda FAN number. Please check the digits and try again.';
          await sendOrEditCard(
            chatId,
            `🛡️ <b>Fayda ID Verification Required</b>\n\n⚠️ <b>${errMsg}</b>\n\nPlease reply with your 12-digit or 16-digit FAN number:`,
            [
              [{ text: '📷 Open Camera to Scan Fayda QR ↗️', web_app: { url: `${appUrl}?startapp=verify_fayda` } }],
              [{ text: '🏠 Cancel', callback_data: 'nav_start' }],
            ],
            activeMsgId
          );
          return NextResponse.json({ ok: true });
        }

        const { data: existingUser } = await supabaseAdmin
          .from('users')
          .select('id, telegram_id')
          .eq('fayda_number', fanResult.fanNumber)
          .neq('telegram_id', chatId)
          .maybeSingle();

        if (existingUser) {
          await sendOrEditCard(
            chatId,
            `⚠️ <b>Fayda ID Already Registered</b>\n\nThis Fayda ID is already associated with another account. Please use your own Fayda ID.`,
            [[{ text: '🏠 Cancel', callback_data: 'nav_start' }]],
            activeMsgId
          );
          return NextResponse.json({ ok: true });
        }

        await supabaseAdmin
          .from('users')
          .update({
            fayda_status: 'verified',
            fayda_number: fanResult.fanNumber,
            updated_at: new Date().toISOString(),
          })
          .eq('telegram_id', chatId);

        await supabaseAdmin
          .from('profiles')
          .update({
            kyc_status: 'verified',
          })
          .eq('telegram_id', chatId);

        await clearSession(chatId);

        const { data: match } = await supabaseAdmin
          .from('matches')
          .select('*, requester:requester_id(telegram_id, gender, budget_min, budget_max, locations, display_code), target:target_id(telegram_id, display_code)')
          .eq('id', matchId)
          .single();

        if (!match || match.status !== 'pending_acceptance') {
          await sendOrEditCard(chatId, `✅ <b>Fayda Verified!</b> However, this match request is no longer pending.`, [[{ text: '🏠 Main Menu', callback_data: 'nav_start' }]], activeMsgId);
          return NextResponse.json({ ok: true });
        }

        await supabaseAdmin
          .from('matches')
          .update({ status: 'pending_payment' })
          .eq('id', matchId);

        const receiverPhone = process.env.TELEBIRR_RECEIVER_PHONE || '0987310978';
        const cbeAccount = process.env.CBE_ACCOUNT_NUMBER || '1000054066094';

        const paymentInstructions = `🎉 <b>You Both Want to Connect!</b>\n\nTo unlock contact details, each person must pay a matching fee of <b>50 ETB</b>.\n\n🏦 <b>Payment Options:</b>\n• <b>Telebirr:</b> <code>${receiverPhone}</code> (SpaceMatch Addis)\n• <b>CBE:</b> <code>${cbeAccount}</code> (SpaceMatch Addis)\n\nℹ️ <i>After both parties have paid, contact information will be revealed to both of you. If one party refuses to pay, your payment will be fully refunded.</i>\n\nOnce transferred, submit your reference code:\n<code>/verify telebirr YOUR_REFERENCE</code>\nor\n<code>/verify cbe YOUR_REFERENCE</code>\n\n<i>Example: /verify telebirr FT260920042</i>`;

        await sendOrEditCard(chatId, `✅ <b>Fayda Verified Successfully!</b>\n\nYou have accepted the connection request.\n\n${paymentInstructions}`, [], activeMsgId);

        const requesterTgId = (match.requester as any)?.telegram_id;
        if (requesterTgId) {
          await tgSend(requesterTgId, paymentInstructions);
        }

        return NextResponse.json({ ok: true });
      }

      // Matchmaker Wizard: Age Text Input
      if (session.step === 'awaiting_match_identity' || session.step === 'awaiting_match_age') {
        if (update.message?.message_id) {
          await sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id });
        }
        const targetMsgId = session.draft_data.card_msg_id;
        const ageVal = parseNumericInput(text);
        if (!ageVal || ageVal < 18 || ageVal > 99) {
          await sendMatchmakerAgeStep(chatId, session.draft_data, targetMsgId, '⚠️ <b>Please type a valid numerical age between 18 and 99:</b>');
          return NextResponse.json({ ok: true });
        }

        const updatedDraft = { ...session.draft_data, age: ageVal };
        await sendMatchmakerPrefGenderStep(chatId, updatedDraft, targetMsgId);
        return NextResponse.json({ ok: true });
      }

      // Matchmaker Wizard: Budget Text Input
      if (session.step === 'awaiting_match_prefs' || session.step === 'awaiting_match_budget_input') {
        if (update.message?.message_id) {
          await sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id });
        }
        const targetMsgId = session.draft_data.card_msg_id;
        const budgetVal = parseNumericInput(text);
        if (!budgetVal || budgetVal <= 0 || budgetVal > 1000000) {
          await sendMatchmakerBudgetStep(chatId, session.draft_data, targetMsgId, '⚠️ <b>Please type a valid monthly budget cap in ETB:</b>');
          return NextResponse.json({ ok: true });
        }

        const updatedDraft = { ...session.draft_data, budget_max: budgetVal };
        await executeAutomatedMatchmaker(chatId, updatedDraft, targetMsgId, 0);
        return NextResponse.json({ ok: true });
      }

      // Seeker Wizard: Age Text Input
      if (session.step === 'awaiting_seeker_age') {
        if (update.message?.message_id) {
          await sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id });
        }
        const targetMsgId = session.draft_data.card_msg_id;
        const ageVal = parseNumericInput(text);
        if (!ageVal || ageVal < 18 || ageVal > 99) {
          await sendSeekerAgeStep(chatId, session.draft_data, targetMsgId, '⚠️ <b>Please enter a valid age between 18 and 99:</b>');
          return NextResponse.json({ ok: true });
        }

        const updatedDraft = { ...session.draft_data, age: ageVal };
        await sendSeekerPrefGenderStep(chatId, updatedDraft, targetMsgId);
        return NextResponse.json({ ok: true });
      }

      // Seeker Wizard: Budget Text Input
      if (session.step === 'awaiting_seeker_budget_text') {
        if (update.message?.message_id) {
          await sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id });
        }
        const targetMsgId = session.draft_data.card_msg_id;
        const budgetVal = parseNumericInput(text);
        if (!budgetVal || budgetVal < 500 || budgetVal > 1000000) {
          await sendSeekerBudgetStep(chatId, session.draft_data, targetMsgId, '⚠️ <b>Please type a valid monthly budget cap in ETB:</b>');
          return NextResponse.json({ ok: true });
        }

        const updatedDraft = { ...session.draft_data, budget_max: budgetVal };
        await sendSeekerBioStep(chatId, updatedDraft, targetMsgId);
        return NextResponse.json({ ok: true });
      }

      // Seeker Wizard: Bio Text Input
      if (session.step === 'awaiting_seeker_bio_text') {
        if (update.message?.message_id) {
          await sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id });
        }
        const targetMsgId = session.draft_data.card_msg_id;
        const bioText = text.toLowerCase() === 'skip' ? 'Seeking compatible roommate' : text;
        const updatedDraft = { ...session.draft_data, lifestyle_bio: bioText };
        await sendSeekerPhoneStep(chatId, updatedDraft, targetMsgId);
        return NextResponse.json({ ok: true });
      }

      // Seeker Wizard: Phone Text Input
      if (session.step === 'awaiting_seeker_phone') {
        if (update.message?.message_id) {
          await sendTelegram('deleteMessage', { chat_id: chatId, message_id: update.message.message_id });
        }
        const targetMsgId = session.draft_data.card_msg_id;
        const cleaned = text.replace(/\s+/g, '').replace(/^\+251/, '0');
        if (!/^(0[97]\d{8}|\+251[97]\d{8})$/.test(text.replace(/\s+/g, ''))) {
          await sendSeekerPhoneStep(chatId, session.draft_data, targetMsgId, '⚠️ <b>Please type a valid Ethiopian phone number (e.g. <code>0912345678</code>):</b>');
          return NextResponse.json({ ok: true });
        }

        const updatedDraft = { ...session.draft_data, contact_phone: cleaned };
        await sendSeekerFaydaStep(chatId, updatedDraft, targetMsgId);
        return NextResponse.json({ ok: true });
      }

      // Handle Slash Commands
      if (text.startsWith('/start') || text === '/start') {
        await clearSession(chatId);

        // ── NEW: Deep-link from channel button → /start req_<display_code> ──
        // ── NEW: Deep-link from channel button → /start req_<display_code_or_id> ──
        if (text.startsWith('/start req_')) {
          const rawCode = text.replace('/start req_', '').trim();
          const lookupCode = rawCode.replace(/^#/, '').trim();

          // Lookup target profile from profiles or roommate_profiles
          let targetProfile: any = null;
          const { data: pCode } = await supabaseAdmin
            .from('profiles')
            .select('*')
            .ilike('display_code', lookupCode)
            .maybeSingle();

          if (pCode) {
            targetProfile = pCode;
          } else {
            const { data: pId } = await supabaseAdmin
              .from('profiles')
              .select('*')
              .eq('id', lookupCode)
              .maybeSingle();
            if (pId) {
              targetProfile = pId;
            } else {
              const { data: rm } = await supabaseAdmin
                .from('roommate_profiles')
                .select('*')
                .or(`id.eq.${lookupCode},display_code.ilike.${lookupCode}`)
                .maybeSingle();
              if (rm) {
                targetProfile = {
                  id: rm.id,
                  telegram_id: rm.user_telegram_id,
                  display_code: rm.display_code || lookupCode,
                  gender: rm.my_gender,
                  locations: rm.preferred_subcity,
                  budget_min: rm.budget_min,
                  budget_max: rm.budget_max,
                  roommate_traits: rm.lifestyle_bio,
                  status: rm.status,
                  channel_message_id: rm.channel_message_id,
                };
              }
            }
          }

          // Check by channel_message_id if lookupCode has a number or starts with post_ / RM
          if (!targetProfile) {
            const numPart = lookupCode.replace(/^post_/i, '').replace(/^RM/i, '');
            const channelMsgId = parseInt(numPart, 10);
            if (!isNaN(channelMsgId) && channelMsgId > 0) {
              const { data: pByMsg } = await supabaseAdmin
                .from('profiles')
                .select('*')
                .eq('channel_message_id', channelMsgId)
                .maybeSingle();
              if (pByMsg) {
                targetProfile = pByMsg;
              } else {
                const { data: rmByMsg } = await supabaseAdmin
                  .from('roommate_profiles')
                  .select('*')
                  .eq('channel_message_id', channelMsgId)
                  .maybeSingle();
                if (rmByMsg) {
                  targetProfile = {
                    id: rmByMsg.id,
                    telegram_id: rmByMsg.user_telegram_id,
                    display_code: rmByMsg.display_code || lookupCode,
                    gender: rmByMsg.my_gender,
                    locations: rmByMsg.preferred_subcity,
                    budget_min: rmByMsg.budget_min,
                    budget_max: rmByMsg.budget_max,
                    roommate_traits: rmByMsg.lifestyle_bio,
                    status: rmByMsg.status,
                    channel_message_id: rmByMsg.channel_message_id,
                  };
                }
              }
            }
          }

          // Fallback: If still not found and it starts with post_ or RM, create active profile placeholder
          if (!targetProfile && (lookupCode.toLowerCase().startsWith('post_') || /^RM\d+$/i.test(lookupCode))) {
            const adminIds = await getAdminIds();
            const primaryAdmin = adminIds[0] || 800701176;
            const { data: createdProfile } = await supabaseAdmin
              .from('profiles')
              .upsert({
                telegram_id: primaryAdmin,
                display_code: lookupCode.toUpperCase(),
                gender: 'Any',
                locations: ['Addis Ababa'],
                budget_min: 0,
                budget_max: 10000,
                roommate_traits: 'Channel Roommate Listing',
                kyc_status: 'verified',
                status: 'active',
                onboarding_step: 'completed',
              }, { onConflict: 'display_code' })
              .select('*')
              .maybeSingle();
            if (createdProfile) {
              targetProfile = createdProfile;
            }
          }

          if (!targetProfile) {
            await sendOrEditCard(
              chatId,
              `⚠️ <b>SpaceMatch</b> · <b>Listing Not Available</b>\n\nRoommate <b>#${lookupCode}</b> is no longer available or was removed.\n\n<blockquote>Browse other active verified roommates below:</blockquote>`,
              [
                [{ text: '⚡ Find Active Roommates · Matchmaker 🔍', callback_data: 'matchmaker_start' }],
                [{ text: '🏠 Main Menu', callback_data: 'nav_start' }],
              ]
            );
            return NextResponse.json({ ok: true });
          }

          // Check if listing is closed / matched
          if (targetProfile.status === 'matched' || targetProfile.status === 'closed') {
            await sendOrEditCard(
              chatId,
              `🔴 <b>SpaceMatch</b> · <b>Listing Closed / Matched</b>\n\n🤝 Roommate <b>#${targetProfile.display_code || lookupCode}</b> has already found a match! 🎉\n\n<blockquote>This listing is officially closed. Browse other verified roommates below:</blockquote>`,
              [
                [{ text: '⚡ Find Roommates Now · Matchmaker 🔍', callback_data: 'matchmaker_start' }],
                [{ text: '👥 Post Seeker Profile', callback_data: 'seeker_flow' }],
                [{ text: '🏠 Main Menu', callback_data: 'nav_start' }],
              ]
            );
            return NextResponse.json({ ok: true });
          }

          // Check for self-listing
          if (String(targetProfile.telegram_id) === String(chatId)) {
            await sendOrEditCard(
              chatId,
              `ℹ️ <b>SpaceMatch</b> · <b>Your Active Channel Post</b>\n\nThis is your active listing for Roommate <b>#${targetProfile.display_code || lookupCode}</b>.\n\n<blockquote>If you have found a roommate, tap below to mark it as closed:</blockquote>`,
              [
                [{ text: '🔴 Mark as Closed / Matched', callback_data: `user_close_listing:${targetProfile.id}` }],
                [{ text: '🏠 Main Menu', callback_data: 'nav_start' }],
              ]
            );
            return NextResponse.json({ ok: true });
          }

          const targetLocations = Array.isArray(targetProfile.locations)
            ? targetProfile.locations.join(', ')
            : (Array.isArray(targetProfile.preferred_subcity) ? targetProfile.preferred_subcity.join(', ') : 'Addis Ababa');
          const targetBudgetStr = targetProfile.budget_max
            ? `${Number(targetProfile.budget_max).toLocaleString()} ETB/mo`
            : '';

          // Check if requesting user is already Fayda verified and has a completed profile
          const isVerified = await isUserFaydaVerified(chatId);
          const { data: myProfile } = await supabaseAdmin
            .from('profiles')
            .select('*')
            .eq('telegram_id', chatId)
            .maybeSingle();

          if (!isVerified || !myProfile) {
            // Unverified or new user: automatically lock target and launch dynamic card onboarding
            await sendDynamicCardStep1Age(chatId, {
              target_id: targetProfile.id,
              target_code: targetProfile.display_code || lookupCode,
              target_locations: targetLocations,
              target_budget: targetBudgetStr,
            });
            return NextResponse.json({ ok: true });
          }

          // Present the Personalized Returning User Card to verified user
          await saveSession({
            telegram_id: chatId,
            step: 'returning_user_review',
            draft_data: {
              target_id: targetProfile.id,
              target_code: targetProfile.display_code || lookupCode,
              target_locations: targetLocations,
              target_budget: targetBudgetStr,
            },
            updated_at: new Date().toISOString(),
          });

          const myCode = myProfile.display_code || 'Verified Member';
          const myLocations = Array.isArray(myProfile.locations) ? myProfile.locations.join(', ') : 'Addis Ababa';
          const myBudgetStr = myProfile.budget_max ? `Up to ${Number(myProfile.budget_max).toLocaleString()} ETB` : 'Flexible';
          const myGenderStr = myProfile.gender || 'Member';
          const myAgeStr = myProfile.age ? `, ${myProfile.age} yrs` : '';

          const inspectionCard = `
🤝 <b>SpaceMatch · Connect with Roommate #${targetProfile.display_code || lookupCode}</b>

Send your verified profile to #${targetProfile.display_code || lookupCode}?

• <b>Target Roommate:</b> #${targetProfile.display_code || lookupCode} (📍 <code>${targetLocations}</code>)
• <b>Your Profile:</b> #${myCode} (${myGenderStr}${myAgeStr})
• <b>Your Budget:</b> <code>${myBudgetStr}</code>
• <b>Your Target Areas:</b> <code>${myLocations}</code>
• <b>Status:</b> 🛡️ <b>Fayda Verified</b>

🔒 <i>Personal identity, phone number, and Telegram handle unlock instantly after mutual agreement and payment.</i>
          `.trim();

          await sendOrEditCard(
            chatId,
            inspectionCard,
            [
              [
                { text: `🚀 Send Request to #${targetProfile.display_code || lookupCode}`, callback_data: `confirm_match:${targetProfile.id}` },
              ],
              [
                { text: '✏️ Edit My Profile', callback_data: 'post_profile_start' },
                { text: '🏠 Main Menu', callback_data: 'nav_start' },
              ],
            ]
          );
          return NextResponse.json({ ok: true });
        }
        // ── END deep-link handler ─────────────────────────────────────────────

        // Channel Button 2: Post profile to channel
        if (
          text === '/start post_profile' ||
          text.startsWith('/start post_profile') ||
          text === '/start post_to_channel' ||
          text.startsWith('/start post_to_channel')
        ) {
          await sendPostProfileBranchPrompt(chatId);
          return NextResponse.json({ ok: true });
        }

        // Channel Button 3: Search Roommate for me
        if (
          text === '/start search_roommate' ||
          text.startsWith('/start search_roommate') ||
          text === '/start match' ||
          text === '/start find'
        ) {
          await sendMatchmakerSubcityStep(chatId, { mode: 'search_roommate' });
          return NextResponse.json({ ok: true });
        }

        // DIRECT POST CLICK FROM CHANNEL: Unlock Seeker Contact
        if (text.startsWith('/start unlock_seeker_')) {
          const profileId = text.replace('/start unlock_seeker_', '').trim();
          await sendUnlockPaywallCard(chatId, profileId, 'roommate_profile');
          return NextResponse.json({ ok: true });
        }

        // DIRECT POST CLICK FROM CHANNEL: Order / Unlock Space Listing
        if (text.startsWith('/start order_seeker_')) {
          const profileId = text.replace('/start order_seeker_', '').trim();
          await sendUnlockPaywallCard(chatId, profileId, 'roommate_profile');
          return NextResponse.json({ ok: true });
        }

        if (text.startsWith('/start order_')) {
          const spaceId = text.replace('/start order_', '').trim();
          await sendUnlockPaywallCard(chatId, spaceId, 'space_listing');
          return NextResponse.json({ ok: true });
        }

        if (text === '/start seeker_flow' || text === '/start seeker') {
          await sendPostProfileBranchPrompt(chatId);
          return NextResponse.json({ ok: true });
        }

        if (text === '/start property_type') {
          await sendSpaceStep1Type(chatId, {});
          return NextResponse.json({ ok: true });
        }

        // Check for pending listing connection from channel
        const { data: existingProfile } = await supabaseAdmin
          .from('profiles')
          .select('status, pending_req_code')
          .eq('telegram_id', chatId)
          .single();

        // If they had a pending req from channel button click, resume it
        if (
          existingProfile?.pending_req_code &&
          (existingProfile.status === 'active' || existingProfile.status === 'matched')
        ) {
          const pendingCode = existingProfile.pending_req_code;
          await supabaseAdmin
            .from('profiles')
            .update({ pending_req_code: null })
            .eq('telegram_id', chatId);

          // Redirect them to the original listing
          const { data: targetProfile } = await supabaseAdmin
            .from('profiles')
            .select('*')
            .eq('display_code', pendingCode)
            .single();

          if (targetProfile) {
            const targetLocations = Array.isArray(targetProfile.locations)
              ? targetProfile.locations.join(', ')
              : 'Addis Ababa';

            await tgSend(
              chatId,
              `✅ <b>Profile ready!</b> Here is the listing you wanted to connect with:\n\n🤝 <b>Roommate #${targetProfile.display_code}</b>\n📍 ${targetLocations}\n💰 ${Number(targetProfile.budget_min || 0).toLocaleString()} – ${Number(targetProfile.budget_max || 0).toLocaleString()} ETB/month`,
              {
                inline_keyboard: [
                  [
                    { text: '❤️ Send Match Request', callback_data: `confirm_match:${targetProfile.id}` },
                    { text: '❌ Cancel', callback_data: 'nav_start' },
                  ],
                ],
              }
            );
            return NextResponse.json({ ok: true });
          }
        }

        // Direct start without deep-link parameters:
        // Clear any old reply keyboards from Telegram clients to maintain clean UI
        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: '✨ <b>Welcome to SpaceMatch Addis!</b>',
          parse_mode: 'HTML',
          reply_markup: { remove_keyboard: true },
        }).then((res) => {
          if (res?.result?.message_id) {
            sendTelegram('deleteMessage', { chat_id: chatId, message_id: res.result.message_id }).catch(() => {});
          }
        }).catch(() => {});

        await sendPrimaryWelcomeMenu(chatId);
        return NextResponse.json({ ok: true });
      }

      // Search Roommate Commands
      if (text === '/search_roommate' || text === '/match' || text === '/find' || text === '/roommate') {
        await clearSession(chatId);
        await sendMatchmakerSubcityStep(chatId, { mode: 'search_roommate' });
        return NextResponse.json({ ok: true });
      }

      // Post Profile Commands
      if (text === '/post_profile' || text === '/seeker' || text === '/post_to_channel') {
        await clearSession(chatId);
        await sendPostProfileBranchPrompt(chatId);
        return NextResponse.json({ ok: true });
      }

      if (text === '/post' || text === '/property_type') {
        await clearSession(chatId);
        await sendPropertyTypePrompt(chatId);
        return NextResponse.json({ ok: true });
      }

      if (text === '/my_listings' || text === '/my_posts' || text === '/status') {
        await clearSession(chatId);
        await sendMyListingsScreen(chatId);
        return NextResponse.json({ ok: true });
      }

      if (text === '/fayda' || text === '/verify_fayda') {
        await clearSession(chatId);
        const isVerified = await isUserFaydaVerified(chatId);
        if (isVerified) {
          const verifiedText = `
🛡️ <b>SpaceMatch</b> · <b>Fayda ID Verified</b>

✅ <b>Your Fayda National ID is Verified!</b>

• <b>Status:</b> 🛡️ Verified Resident
• <b>Access:</b> Full Platform Access (Matchmaker, Seeker Profiles, Contact Unlocks)
• <b>Security:</b> Offline Verhoeff Checksum Validated

<blockquote>You are fully approved to match, post, and connect safely across Addis Ababa.</blockquote>
          `.trim();
          await sendOrEditCard(chatId, verifiedText, [
            [{ text: '⚡ Find a Roommate · Matchmaker 🔍', callback_data: 'matchmaker_start' }],
            [{ text: '👥 Post Seeker Profile', callback_data: 'seeker_flow' }],
            [{ text: '🏠 Back to Main Menu', callback_data: 'nav_start' }],
          ]);
          return NextResponse.json({ ok: true });
        }

        await sendFaydaGateCard(chatId, 'access all SpaceMatch verified features');
        return NextResponse.json({ ok: true });
      }

      // ── NEW: /verify <bank> <reference> — Dual-Escrow Payment ────────────
      // Pattern: /verify telebirr FT260920042  OR  /verify cbe TX123456
      if (text.startsWith('/verify ') && text.split(/\s+/).length >= 3) {
        const parts = text.split(/\s+/);
        const bank = parts[1]?.toLowerCase();
        const reference = parts[2]?.trim();

        if (!['telebirr', 'cbe'].includes(bank) || !reference) {
          await tgSend(
            chatId,
            `⚠️ <b>Invalid format.</b>\n\nUsage: <code>/verify telebirr YOUR_REF</code> or <code>/verify cbe YOUR_REF</code>\n\n<i>Example: /verify telebirr FT260920042</i>`
          );
          return NextResponse.json({ ok: true });
        }

        // 1. Check if reference already used (case-insensitive)
        const { data: existingPayment } = await supabaseAdmin
          .from('payments')
          .select('id')
          .ilike('reference', reference.trim())
          .maybeSingle();

        if (existingPayment) {
          await tgSend(
            chatId,
            `❌ <b>Reference Already Used</b>\n\nThis transaction reference has already been submitted. Please use a different reference number.`
          );
          return NextResponse.json({ ok: true });
        }

        // 2. Find the paying user's profile in profiles or roommate_profiles
        let payerProfile: any = null;
        const { data: pProfile } = await supabaseAdmin
          .from('profiles')
          .select('id, status')
          .eq('telegram_id', chatId)
          .maybeSingle();

        if (pProfile) {
          payerProfile = pProfile;
        } else {
          const { data: rmProfile } = await supabaseAdmin
            .from('roommate_profiles')
            .select('id, status')
            .eq('user_telegram_id', chatId)
            .maybeSingle();
          if (rmProfile) payerProfile = rmProfile;
        }

        if (!payerProfile) {
          await tgSend(chatId, `⚠️ Profile not found. Please complete your onboarding first.`);
          return NextResponse.json({ ok: true });
        }

        // 3. Find the active pending_payment match for this user
        let activeMatch: any = null;
        const { data: matchRow } = await supabaseAdmin
          .from('matches')
          .select('*, requester:requester_id(id, telegram_id, display_code, full_name, phone_number, telegram_username), target:target_id(id, telegram_id, display_code, full_name, phone_number, telegram_username, channel_message_id)')
          .or(`requester_id.eq.${payerProfile.id},target_id.eq.${payerProfile.id}`)
          .eq('status', 'pending_payment')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (matchRow) {
          activeMatch = matchRow;
        } else {
          // Fallback: check matches where requester or target has this telegram_id
          const { data: allPending } = await supabaseAdmin
            .from('matches')
            .select('*, requester:requester_id(id, telegram_id, display_code, full_name, phone_number, telegram_username), target:target_id(id, telegram_id, display_code, full_name, phone_number, telegram_username, channel_message_id)')
            .eq('status', 'pending_payment')
            .order('created_at', { ascending: false })
            .limit(10);

          if (allPending) {
            activeMatch = allPending.find(
              (m: any) =>
                Number(m.requester?.telegram_id) === chatId ||
                Number(m.target?.telegram_id) === chatId
            );
          }
        }

        if (!activeMatch) {
          await tgSend(
            chatId,
            `⚠️ No active match found waiting for payment. Please make sure your match has been accepted first.`
          );
          return NextResponse.json({ ok: true });
        }

        // 4. Sending indicator
        await tgSend(chatId, `⏳ <b>Verifying payment with Verify.ET...</b>`);

        // 5. Call Verify.ET
        const verifyResult = await verifyTelebirrPayment(reference, 50);

        if (!verifyResult.success) {
          await tgSend(
            chatId,
            `❌ <b>Verification Failed</b>\n\n${verifyResult.message}\n\nPlease double-check your reference number and try again.`
          );
          return NextResponse.json({ ok: true });
        }

        // 6. Record the payment
        await supabaseAdmin.from('payments').insert({
          match_id: activeMatch.id,
          user_id: payerProfile.id,
          bank,
          reference,
          amount: verifyResult.paidAmount ?? 50,
        });

        // 7. Determine which side paid and update the match
        const isRequester =
          (activeMatch.requester as any)?.id === payerProfile.id ||
          Number((activeMatch.requester as any)?.telegram_id) === chatId;
        const updateField = isRequester ? 'requester_paid' : 'target_paid';
        const paidAtField = isRequester ? 'requester_paid_at' : 'target_paid_at';

        const { data: updatedMatch } = await supabaseAdmin
          .from('matches')
          .update({
            [updateField]: true,
            [paidAtField]: new Date().toISOString(),
          })
          .eq('id', activeMatch.id)
          .select('requester_paid, target_paid')
          .maybeSingle();

        const bothPaid = updatedMatch?.requester_paid && updatedMatch?.target_paid;

        if (!bothPaid) {
          // Only one side paid — update payment_status and notify both
          await supabaseAdmin
            .from('matches')
            .update({ payment_status: 'one_paid' })
            .eq('id', activeMatch.id);

          await tgSend(
            chatId,
            `✅ <b>50 ETB Verified!</b>\n\nWaiting for your potential roommate to complete their payment.`
          );

          // Alert the other user
          const otherTgId = isRequester
            ? (activeMatch.target as any)?.telegram_id
            : (activeMatch.requester as any)?.telegram_id;

          if (otherTgId) {
            await tgSend(
              otherTgId,
              `🔔 <b>Your roommate has completed their payment!</b>\n\nContact information will be revealed to both of you as soon as you complete your payment.\n\n<code>/verify telebirr YOUR_REFERENCE</code> or <code>/verify cbe YOUR_REFERENCE</code>`
            );
          }
        } else {
          // ── BOTH PAID → Complete the match ─────────────────────────────────
          await supabaseAdmin
            .from('matches')
            .update({
              payment_status: 'both_paid',
              status: 'completed',
              completed_at: new Date().toISOString(),
              contacts_unlocked_at: new Date().toISOString(),
              checkin_24h_sent: false,
            })
            .eq('id', activeMatch.id);

          // Mark both profiles as matched
          const requesterProfileId = (activeMatch.requester as any)?.id;
          const targetProfileId    = (activeMatch.target as any)?.id;

          // Preserve channel message ID & display code for 24-hour follow-up check-in
          const channelMsgId = (activeMatch.target as any)?.channel_message_id;
          const targetDisplayCode = (activeMatch.target as any)?.display_code;

          // Pre-reveal disclaimer: SpaceMatch connects roommates and assumes no liability after match
          const disclaimerText = `⚠️ <b>Disclaimer:</b> Our job is to connect verified roommates. SpaceMatch Addis does not take responsibility for anything that happens after roommates are matched up.`;

          // Build contact reveal messages
          const buildRevealMsg = (other: any) => {
            const tgHandle = other?.telegram_username ? `@${other.telegram_username}` : 'N/A';
            return `🎉 <b>YOU'RE MATCHED!</b>\n\nBoth payments are verified. Your connection is complete!\n\n👤 <b>Name:</b> ${other?.full_name || 'Verified Member'}\n📞 <b>Phone:</b> <code>${other?.phone_number || 'N/A'}</code>\n💬 <b>Telegram:</b> ${tgHandle}\n\nGood luck finding your home together! 🏠🤝`;
          };

          const requesterData = activeMatch.requester as any;
          const targetData    = activeMatch.target as any;

          const requesterRevealMarkup = targetData?.telegram_username
            ? { inline_keyboard: [[{ text: '💬 Open Chat on Telegram', url: `https://t.me/${targetData.telegram_username}` }]] }
            : undefined;

          const targetRevealMarkup = requesterData?.telegram_username
            ? { inline_keyboard: [[{ text: '💬 Open Chat on Telegram', url: `https://t.me/${requesterData.telegram_username}` }]] }
            : undefined;

          const requesterTgId = requesterData?.telegram_id;
          const targetTgId    = targetData?.telegram_id;

          if (requesterTgId) {
            await tgSend(requesterTgId, disclaimerText);
            await tgSend(requesterTgId, buildRevealMsg(targetData), requesterRevealMarkup);
          }
          if (targetTgId) {
            await tgSend(targetTgId, disclaimerText);
            await tgSend(targetTgId, buildRevealMsg(requesterData), targetRevealMarkup);

            // Schedule 24-hour follow-up check-in for listing owner
            const existingSession = getSession(targetTgId);
            await saveSession({
              telegram_id: targetTgId,
              step: existingSession?.step || 'idle',
              draft_data: {
                ...(existingSession?.draft_data || {}),
                checkin_scheduled: true,
                checkin_due: Date.now() + 24 * 60 * 60 * 1000,
                target_display_code: targetDisplayCode || 'RM',
                target_channel_message_id: channelMsgId,
              },
              updated_at: new Date().toISOString(),
            });
          }
        }

        return NextResponse.json({ ok: true });
      }

      // ── Legacy: /verify (fayda) or bare /verify ────────────────────────────
      if (text === '/verify' || text === '/fayda') {
        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: `<b>🛡️ Fayda National ID Verification</b>\n\nPlease attach and send a photo of your Fayda National ID in chat now for verification!`,
          parse_mode: 'HTML',
        });
        return NextResponse.json({ ok: true });
      }

      // ── SpaceMatch Admin Commands ──────────────────────────────────────────
      if (text === '/admin') {
        const adminIds = await getAdminIds();
        if (!adminIds.includes(chatId)) {
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: `⛔ <b>Access Denied.</b> You are not authorized to view admin controls.`,
            parse_mode: 'HTML',
          });
          return NextResponse.json({ ok: true });
        }

        let pendingCount = 0;
        try {
          const { count } = await supabaseAdmin
            .from('profiles')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'pending_approval');
          pendingCount = count || 0;
        } catch {}

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: `👑 <b>SpaceMatch Admin Controls</b>\n\nSelect an action below or use admin commands:\n• <code>/post</code> - Launch channel posting wizard\n• <code>/close &lt;code&gt;</code> - Close matched listing\n• <code>/admins</code> - View and manage administrator team`,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: `⏳ Pending Channel Approvals (${pendingCount})`, callback_data: 'admin_list_pending' }],
              [{ text: '📢 Post to Channel as Admin 🛠️', callback_data: 'admin_post_start' }],
              [{ text: '🔴 Active Channel Posts & Close / Match', callback_data: 'admin_list_active_posts' }],
              [{ text: '❌ Exit Admin Menu', callback_data: 'admin_cancel' }],
            ],
          },
        });
        return NextResponse.json({ ok: true });
      }

      if (text === '/post' || text === '/admin_post') {
        const adminIds = await getAdminIds();
        if (!adminIds.includes(chatId)) {
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: `⛔ <b>Access Denied.</b> Only SpaceMatch administrators can post directly to the channel.`,
            parse_mode: 'HTML',
          });
          return NextResponse.json({ ok: true });
        }
        await clearSession(chatId);
        await sendAdminPostCategoryStep(chatId);
        return NextResponse.json({ ok: true });
      }

      if (text === '/close' || text.startsWith('/close ')) {
        const adminIds = await getAdminIds();
        if (!adminIds.includes(chatId)) {
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: `⛔ <b>Access Denied.</b> Only SpaceMatch administrators can mark channel posts as closed.`,
            parse_mode: 'HTML',
          });
          return NextResponse.json({ ok: true });
        }

        const query = text.replace('/close', '').trim();
        if (!query) {
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: `
📢 <b>SpaceMatch Admin · Close Channel Post</b>

<b>Usage:</b> <code>/close &lt;code_or_message_id_or_link&gt;</code>

<b>Examples:</b>
• <code>/close RM205</code>
• <code>/close 1542</code>
• <code>/close https://t.me/roommatch_addis/1542</code>

<i>💡 Or simply forward any channel post directly to this bot to close it!</i>
            `.trim(),
            parse_mode: 'HTML',
          });
          return NextResponse.json({ ok: true });
        }

        const res = await executeChannelPostClose(query, chatId);
        const targetChannel = await getPrimaryChannel();
        const channelHandle = String(targetChannel).replace('@', '');
        const postLink = res.messageId ? `https://t.me/${channelHandle}/${res.messageId}` : '';

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: `${res.success ? '🔴' : '⚠️'} <b>Listing #${res.displayCode || query}</b>\n\n${res.message}`,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              ...(postLink ? [[{ text: '📢 View Channel Post ↗️', url: postLink }]] : []),
              [{ text: '➕ Post Another Listing', callback_data: 'admin_post_start' }],
              [{ text: '🏠 Main Menu', callback_data: 'nav_start' }],
            ],
          },
        });
        return NextResponse.json({ ok: true });
      }

      if (text === '/admins') {
        const adminIds = await getAdminIds();
        if (!adminIds.includes(chatId)) {
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: `⛔ <b>Access Denied.</b> Admin list is restricted to SpaceMatch administrators.`,
            parse_mode: 'HTML',
          });
          return NextResponse.json({ ok: true });
        }

        // Fetch DB admins with their usernames/names
        let dbAdminList: any[] = [];
        try {
          const { data } = await supabaseAdmin
            .from('users')
            .select('telegram_id, first_name, last_name, username')
            .eq('role', 'admin');
          if (data) dbAdminList = data;
        } catch {}

        let msg = `👑 <b>SpaceMatch Administrators (${adminIds.length} Total)</b>\n\n`;
        msg += `🛡️ <b>Super Administrators:</b>\n`;
        msg += `• Biruk (@birukadiyee · <code>800701176</code>)\n`;
        msg += `• Wahid (@WWEHID · <code>148318506</code>)\n\n`;

        if (dbAdminList.length > 0) {
          msg += `👥 <b>Database Administrators:</b>\n`;
          for (const a of dbAdminList) {
            const name = [a.first_name, a.last_name].filter(Boolean).join(' ') || 'Admin';
            const handle = a.username ? `@${a.username}` : `<code>${a.telegram_id}</code>`;
            msg += `• ${name} (${handle})\n`;
          }
          msg += '\n';
        }

        msg += `📢 <b>Channel Administrators:</b>\n`;
        msg += `• Automatically synced from <code>@roommatch_addis</code> channel administrators.\n\n`;
        msg += `⚙️ <b>Commands:</b>\n`;
        msg += `• <code>/add_admin &lt;telegram_id_or_username&gt;</code>\n`;
        msg += `• <code>/remove_admin &lt;telegram_id_or_username&gt;</code>\n`;
        msg += `• <code>/post</code> - Launch channel posting wizard\n`;
        msg += `• <code>/close &lt;code&gt;</code> - Mark channel post as closed\n`;

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: msg.trim(),
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '📢 Post to Channel as Admin 🛠️', callback_data: 'admin_post_start' }],
              [{ text: '🏠 Main Menu', callback_data: 'nav_start' }],
            ],
          },
        });
        return NextResponse.json({ ok: true });
      }

      if (text === '/add_admin' || text.startsWith('/add_admin ')) {
        const adminIds = await getAdminIds();
        if (!adminIds.includes(chatId)) {
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: `⛔ <b>Access Denied.</b> Only SpaceMatch administrators can promote other admins.`,
            parse_mode: 'HTML',
          });
          return NextResponse.json({ ok: true });
        }

        const query = text.replace('/add_admin', '').trim();
        if (!query) {
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: `
👑 <b>SpaceMatch Admin · Add Administrator</b>

<b>Usage:</b> <code>/add_admin &lt;telegram_id_or_username&gt;</code>

<b>Examples:</b>
• <code>/add_admin 987654321</code>
• <code>/add_admin @username</code>
            `.trim(),
            parse_mode: 'HTML',
          });
          return NextResponse.json({ ok: true });
        }

        const cleanQuery = query.replace('@', '').trim();
        const isNumeric = /^\d+$/.test(cleanQuery);

        let userRecord: any = null;
        if (isNumeric) {
          const { data } = await supabaseAdmin.from('users').select('*').eq('telegram_id', Number(cleanQuery)).maybeSingle();
          userRecord = data;
        } else {
          const { data } = await supabaseAdmin.from('users').select('*').ilike('username', cleanQuery).maybeSingle();
          userRecord = data;
        }

        if (!userRecord) {
          if (isNumeric) {
            const { data: newUser } = await supabaseAdmin
              .from('users')
              .upsert({
                telegram_id: Number(cleanQuery),
                role: 'admin',
                updated_at: new Date().toISOString(),
              }, { onConflict: 'telegram_id' })
              .select('*')
              .single();
            userRecord = newUser;
          } else {
            await sendTelegram('sendMessage', {
              chat_id: chatId,
              text: `⚠️ User <b>@${cleanQuery}</b> was not found in SpaceMatch database. They need to start the bot at least once first, or you can add them by numeric Telegram ID: <code>/add_admin &lt;id&gt;</code>.`,
              parse_mode: 'HTML',
            });
            return NextResponse.json({ ok: true });
          }
        } else {
          await supabaseAdmin
            .from('users')
            .update({ role: 'admin', updated_at: new Date().toISOString() })
            .eq('id', userRecord.id);
        }

        // Invalidate admin cache
        invalidateAdminCache();

        const displayName = [userRecord.first_name, userRecord.last_name].filter(Boolean).join(' ') || (userRecord.username ? `@${userRecord.username}` : `ID ${userRecord.telegram_id}`);

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: `✅ <b>${displayName}</b> has been successfully promoted to SpaceMatch Administrator! 🎉\n\nThey now have access to <code>/post</code> and <code>/close</code>.`,
          parse_mode: 'HTML',
        });

        if (userRecord.telegram_id && Number(userRecord.telegram_id) !== chatId) {
          await sendTelegram('sendMessage', {
            chat_id: Number(userRecord.telegram_id),
            text: `🎉 <b>You have been appointed as a SpaceMatch Administrator!</b>\n\nYou now have administrative privileges to post listings directly to the channel and manage/close listings:\n\n• <code>/post</code> - Launch channel posting wizard\n• <code>/close &lt;code&gt;</code> - Close matched listings\n• <code>/admins</code> - View administrator team`,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '📢 Post to Channel as Admin 🛠️', callback_data: 'admin_post_start' }],
                [{ text: '🏠 Main Menu', callback_data: 'nav_start' }],
              ],
            },
          });
        }

        return NextResponse.json({ ok: true });
      }

      if (text === '/remove_admin' || text.startsWith('/remove_admin ')) {
        const adminIds = await getAdminIds();
        if (!adminIds.includes(chatId)) {
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: `⛔ <b>Access Denied.</b> Only SpaceMatch administrators can manage admins.`,
            parse_mode: 'HTML',
          });
          return NextResponse.json({ ok: true });
        }

        const query = text.replace('/remove_admin', '').trim();
        if (!query) {
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: `
👑 <b>SpaceMatch Admin · Remove Administrator</b>

<b>Usage:</b> <code>/remove_admin &lt;telegram_id_or_username&gt;</code>

<b>Examples:</b>
• <code>/remove_admin 987654321</code>
• <code>/remove_admin @username</code>
            `.trim(),
            parse_mode: 'HTML',
          });
          return NextResponse.json({ ok: true });
        }

        const cleanQuery = query.replace('@', '').trim();
        const isNumeric = /^\d+$/.test(cleanQuery);
        const superAdminIds = [800701176, 148318506];

        if (isNumeric && superAdminIds.includes(Number(cleanQuery))) {
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: `⚠️ <b>Action Blocked:</b> Super administrators cannot be removed.`,
            parse_mode: 'HTML',
          });
          return NextResponse.json({ ok: true });
        }

        let userRecord: any = null;
        if (isNumeric) {
          const { data } = await supabaseAdmin.from('users').select('*').eq('telegram_id', Number(cleanQuery)).maybeSingle();
          userRecord = data;
        } else {
          const { data } = await supabaseAdmin.from('users').select('*').ilike('username', cleanQuery).maybeSingle();
          userRecord = data;
        }

        if (!userRecord) {
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: `⚠️ User <b>${query}</b> was not found in the database.`,
            parse_mode: 'HTML',
          });
          return NextResponse.json({ ok: true });
        }

        if (superAdminIds.includes(Number(userRecord.telegram_id))) {
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: `⚠️ <b>Action Blocked:</b> Super administrators cannot be removed.`,
            parse_mode: 'HTML',
          });
          return NextResponse.json({ ok: true });
        }

        await supabaseAdmin
          .from('users')
          .update({ role: 'user', updated_at: new Date().toISOString() })
          .eq('id', userRecord.id);

        // Invalidate admin cache
        invalidateAdminCache();

        const displayName = [userRecord.first_name, userRecord.last_name].filter(Boolean).join(' ') || (userRecord.username ? `@${userRecord.username}` : `ID ${userRecord.telegram_id}`);

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: `ℹ️ <b>${displayName}</b> has been removed from SpaceMatch Administrators.`,
          parse_mode: 'HTML',
        });
        return NextResponse.json({ ok: true });
      }

      // ── SpaceMatch Channel Management Commands ─────────────────────────────
      if (text === '/channels') {
        const adminIds = await getAdminIds();
        if (!adminIds.includes(chatId)) {
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: `⛔ <b>Access Denied.</b> Channel list is restricted to SpaceMatch administrators.`,
            parse_mode: 'HTML',
          });
          return NextResponse.json({ ok: true });
        }

        const channels = await getManagedChannels();
        let channelsMsg = `📢 <b>Connected Channels (${channels.length})</b>\n\n`;
        if (channels.length === 0) {
          channelsMsg += `<i>No external channels connected yet. The bot uses the default channel (@roommatch_addis).\n\nTo connect any channel, add this bot as an administrator to the channel, or run:</i>\n<code>/setchannel @your_channel</code>`;
        } else {
          for (let i = 0; i < channels.length; i++) {
            const ch = channels[i];
            const statusIcon = ch.is_active ? '🟢' : '🔴';
            channelsMsg += `${i + 1}. ${statusIcon} <b>${ch.channel_title}</b>\n`;
            channelsMsg += `   • ID: <code>${ch.channel_id}</code>\n`;
            if (ch.channel_username) channelsMsg += `   • Username: <b>${ch.channel_username}</b>\n`;
            channelsMsg += `   • Status: ${ch.is_active ? 'Active' : 'Inactive'}\n\n`;
          }
          channelsMsg += `<i>💡 To connect a new channel, add @${botUsername} as an administrator to your channel, or run <code>/setchannel @channel</code>.</i>`;
        }

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: channelsMsg,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '👑 Admin Menu', callback_data: 'admin_menu' }],
              [{ text: '🏠 Main Menu', callback_data: 'nav_start' }],
            ],
          },
        });
        return NextResponse.json({ ok: true });
      }

      if (text === '/setchannel' || text.startsWith('/setchannel ')) {
        const adminIds = await getAdminIds();
        if (!adminIds.includes(chatId)) {
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: `⛔ <b>Access Denied.</b> Only SpaceMatch administrators can configure channels.`,
            parse_mode: 'HTML',
          });
          return NextResponse.json({ ok: true });
        }

        const channelInput = text.replace('/setchannel', '').trim();
        if (!channelInput) {
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: `
📢 <b>SpaceMatch Admin · Connect Channel</b>

<b>Usage:</b> <code>/setchannel &lt;@channel_username_or_channel_id&gt;</code>

<b>Examples:</b>
• <code>/setchannel @addis_roommates</code>
• <code>/setchannel -1001234567890</code>

<b>Instructions:</b>
1. Add @${botUsername} as an administrator in your channel with <i>Post Messages</i> & <i>Edit Messages</i> permissions.
2. Send <code>/setchannel @your_channel</code> here.
            `.trim(),
            parse_mode: 'HTML',
          });
          return NextResponse.json({ ok: true });
        }

        // Test if the bot is indeed an admin in that channel
        try {
          const res = await fetch(`https://api.telegram.org/bot${botToken}/getChatAdministrators`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: channelInput }),
          });
          const json = await res.json();

          if (!json.ok) {
            await sendTelegram('sendMessage', {
              chat_id: chatId,
              text: `⚠️ <b>Could not access channel:</b> <code>${channelInput}</code>\n\nTelegram response: <i>${json.description || 'Channel not found or bot is not an admin'}</i>\n\nPlease ensure @${botUsername} is added as an administrator to the channel first!`,
              parse_mode: 'HTML',
            });
            return NextResponse.json({ ok: true });
          }

          // Fetch chat details
          const chatRes = await fetch(`https://api.telegram.org/bot${botToken}/getChat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: channelInput }),
          });
          const chatJson = await chatRes.json();
          const chatInfo = chatJson.result || {};

          const channelId = chatInfo.id || channelInput;
          const channelTitle = chatInfo.title || 'Connected Channel';
          const channelUsername = chatInfo.username ? `@${chatInfo.username}` : (channelInput.startsWith('@') ? channelInput : null);

          await saveManagedChannel({
            channel_id: channelId,
            channel_title: channelTitle,
            channel_username: channelUsername,
            added_by: chatId,
            is_active: true,
            added_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });

          // Invalidate admin cache so newly discovered channel's admins are recognized immediately
          cachedAdminIds = null;

          const adminCount = Array.isArray(json.result) ? json.result.filter((m: any) => !m.user?.is_bot).length : 0;

          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: `
✅ <b>Channel Successfully Connected!</b> 🎉

• <b>Title:</b> <b>${channelTitle}</b>
• <b>Channel ID:</b> <code>${channelId}</code>
• <b>Username:</b> <b>${channelUsername || 'Private Channel'}</b>
• <b>Admins Recognized:</b> <code>${adminCount}</code>

All administrators of this channel can now use bot admin features, and approved listings will be posted to this channel with full 3-button tracking!
            `.trim(),
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '📢 View Connected Channels', callback_data: 'admin_list_channels' }],
                [{ text: '👑 Admin Menu', callback_data: 'admin_menu' }],
              ],
            },
          });
          return NextResponse.json({ ok: true });
        } catch (netErr: any) {
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: `❌ Error connecting channel: ${netErr.message || 'Unknown network error'}`,
            parse_mode: 'HTML',
          });
          return NextResponse.json({ ok: true });
        }
      }

      if (text === '/cancel') {
        await clearSession(chatId);
        await sendPrimaryWelcomeMenu(chatId);
        return NextResponse.json({ ok: true });
      }

      if (isOnboardingSession(session.step)) {
        const handled = await handleOnboardingMessage(
          chatId,
          session.step,
          {
            message_id: message.message_id,
            text: message.text,
            contact: message.contact,
            photo: message.photo,
          },
          message.from?.username
        );
        if (handled) return NextResponse.json({ ok: true });
      }

      // Handle Payment Reference Submission
      if (session.step.startsWith('awaiting_payment_for_unlock:')) {
        const txRef = text.trim();
        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: `⏳ <b>Verifying transaction reference <code>${txRef}</code>...</b>`,
          parse_mode: 'HTML',
        });

        const verifyRes = await verifyTelebirrPayment(txRef, 50);
        const targetId = session.draft_data?.target_id;
        const targetType = session.draft_data?.target_type || 'roommate_profile';

        let candidateName = 'Verified Roommate';
        let candidatePhone = '0911234567';
        let candidateUsername = '';

        if (targetType === 'roommate_profile') {
          try {
            const { data: dbProf } = await supabaseAdmin
              .from('roommate_profiles')
              .select('*, users(*)')
              .eq('id', targetId)
              .single();
            if (dbProf?.users) {
              candidateName = [dbProf.users.first_name, dbProf.users.last_name].filter(Boolean).join(' ') || 'Verified Seeker';
              candidatePhone = dbProf.users.phone_number || '0911234567';
              candidateUsername = dbProf.users.username || '';
            }
          } catch {}

          if (candidateName === 'Verified Roommate') {
            const draft = await getRoommateDraft(targetId);
            if (draft) {
              candidateName = draft.user_name || 'Verified Seeker';
              candidatePhone = draft.contact_phone || '0911234567';
              candidateUsername = draft.username || '';
            }
          }

          if (candidateName === 'Verified Roommate') {
            try {
              const { data: pData } = await supabaseAdmin
                .from('profiles')
                .select('*')
                .eq('id', targetId)
                .single();
              if (pData) {
                candidateName = pData.full_name || 'Roommate Seeker';
                candidatePhone = pData.phone_number || '';
                candidateUsername = pData.telegram_username || '';
              }
            } catch {}
          }
        } else {
          try {
            const { data: dbSpace } = await supabaseAdmin
              .from('spaces')
              .select('*')
              .eq('id', targetId)
              .single();
            if (dbSpace) {
              candidateName = dbSpace.title;
              candidatePhone = dbSpace.contact_phone || '0911234567';
              candidateUsername = dbSpace.contact_telegram || '';
            }
          } catch {}

          if (candidateName === 'Verified Roommate') {
            const draft = await getDraft(targetId);
            if (draft) {
              candidateName = draft.title || 'Space Listing';
              candidatePhone = draft.contact_phone || '0911234567';
              candidateUsername = draft.homeowner_username || '';
            }
          }
        }

        // Save completed order to Supabase
        try {
          await supabaseAdmin
            .from('orders')
            .insert({
              buyer_telegram_id: chatId,
              order_type: 'unlock_contact',
              target_type: targetType,
              target_id: targetId,
              amount: 50.00,
              transaction_reference: txRef,
              payment_status: 'completed',
              verified_at: new Date().toISOString(),
            });
        } catch (err) {
          console.error('Error saving completed order:', err);
        }

        await clearSession(chatId);

        const unlockedContactMsg = `
🎉 <b>SpaceMatch</b> · <b>Contact Details Unlocked!</b>
🛡️ <b>Fayda ID Verified</b>

• <b>Full Name:</b> <b>${candidateName}</b>
• <b>Phone Number:</b> <code>${candidatePhone}</code>
${candidateUsername ? `• <b>Telegram:</b> @${candidateUsername.replace('@', '')}\n` : ''}
<blockquote>✅ Payment verified successfully. This contact is permanently saved to your account under 'My Saved Contacts'.</blockquote>
        `.trim();

        const actionButtons: any[] = [];
        const contactRow: any[] = [];
        if (candidatePhone) {
          contactRow.push({ text: `📞 Call (${candidatePhone})`, url: `tel:${candidatePhone}` });
        }
        if (candidateUsername) {
          const cleanUser = candidateUsername.replace('@', '');
          contactRow.push({ text: `💬 Chat with @${cleanUser}`, url: `https://t.me/${cleanUser}` });
        }
        if (contactRow.length > 0) actionButtons.push(contactRow);

        actionButtons.push([
          { text: '📂 My Unlocked Contacts', callback_data: 'my_unlocked_contacts' },
          { text: '🏠 Main Menu', callback_data: 'nav_start' },
        ]);

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: unlockedContactMsg,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: actionButtons,
          },
        });
        return NextResponse.json({ ok: true });
      }

      // Default fallback response
      await sendPrimaryWelcomeMenu(chatId);
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Telegram Webhook POST Error:', msg);
    return NextResponse.json({ ok: true });
  }
}
