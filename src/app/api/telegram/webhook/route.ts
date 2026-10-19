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

    // Helper to get Admin Telegram IDs
    const getAdminIds = async (): Promise<number[]> => {
      const defaultAdminIds = [800701176, 148318506]; // @birukadiyee & @WWEHID
      try {
        const { data } = await supabaseAdmin.from('users').select('telegram_id').eq('role', 'admin');
        if (data && data.length > 0) {
          const ids = data.map((u: any) => Number(u.telegram_id)).filter((id: number) => id);
          return Array.from(new Set([...ids, ...defaultAdminIds]));
        }
      } catch {}
      return defaultAdminIds;
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

    // Helper: Universal Fayda Gate Card
    const sendFaydaGateCard = async (
      chatId: number,
      targetAction: string,
      messageIdToEdit?: number
    ): Promise<number | undefined> => {
      const gateText = `
🛡️ <b>SpaceMatch</b> · <b>Fayda ID Verification Required</b>

Before you can <b>${targetAction}</b>, your Fayda National ID must be verified.

• ⚡ <b>100% Instant &amp; Offline</b>: Decoded on-device via QR code checksum.
• 🔒 <b>Privacy-First</b>: Your data never leaves our secure system.
• 🛡️ <b>Fraud-Free Community</b>: Every roommate and space is verified.

<i>Tap below to open your camera in the SpaceMatch Mini App and scan your Fayda QR code (from your physical ID card or digital e-Fayda slip).</i>
      `.trim();

      const inlineKeyboard = [
        [
          {
            text: '🛡️ Scan Fayda QR Code in Mini App ↗️',
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

    // Helper: Send Primary Start / Main Menu Screen
    const sendPrimaryWelcomeMenu = async (chatId: number, messageIdToEdit?: number) => {
      // Ensure the menu button in Telegram is reset to commands menu so mobile keyboards are unobstructed
      setChatMenuButton({ type: 'commands' }, chatId).catch(() => {});

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
            text: '⚡ Find a Roommate · Matchmaker 🔍',
            callback_data: 'matchmaker_start',
          },
        ],
        [
          {
            text: '👥 Post Seeker Profile',
            callback_data: 'seeker_flow',
          },
          {
            text: '🏠 List Space for Rent',
            callback_data: 'property_type',
          },
        ],
        [
          {
            text: '🛡️ Verify Fayda ID',
            callback_data: 'verify_fayda',
          },
          {
            text: '📂 My Saved Contacts',
            callback_data: 'my_unlocked_contacts',
          },
        ],
        [
          {
            text: '📋 My Active Listings & Close',
            callback_data: 'my_listings',
          },
          {
            text: '❓ Platform Guide',
            callback_data: 'nav_help',
          },
        ],
        [
          {
            text: '📱 Open SpaceMatch Mini App ↗️',
            web_app: { url: appUrl },
          },
          {
            text: '💬 Live Admin Support',
            url: 'https://t.me/birukadiyee',
          },
        ],
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

      // Primary Action: Unlock Contact (Only revealed after payment!)
      inlineKeyboardRows.push([
        {
          text: `🔒 Unlock Verified Contact · ${match.unlock_fee || 50} ETB ⚡`,
          callback_data: `start_unlock_seeker:${match.id}`,
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
    // 1. HANDLE INLINE CALLBACK QUERIES
    // -------------------------------------------------------------------------
    if (update.callback_query) {
      const callback = update.callback_query;
      const callbackData: string = callback.data || '';
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
          await sendOrEditCard(
            chatId,
            `⚠️ <b>Profile Needed for Mutual Match</b>\n\nTo send a mutual connection request, create a quick seeker profile so they can review your preferences.\n\n<blockquote>Alternatively, you can unlock their verified direct contact:</blockquote>`,
            [
              [{ text: '👥 Create Seeker Profile', callback_data: 'seeker_flow' }],
              [{ text: '🔒 Direct Contact Unlock · 50 ETB ⚡', callback_data: `start_unlock_seeker:${targetProfileId}` }],
              [{ text: '🏠 Back to Main Menu', callback_data: 'nav_start' }],
            ],
            msgId
          );
          return NextResponse.json({ ok: true });
        }

        // Prevent self-request
        if (requesterProfile.id === targetProfileId || String(requesterProfile.telegram_id) === String(chatId)) {
          // Check if target is indeed the user's own listing
          const { data: ownTarget } = await supabaseAdmin
            .from('profiles')
            .select('telegram_id')
            .eq('id', targetProfileId)
            .single();

          if (ownTarget && String(ownTarget.telegram_id) === String(chatId)) {
            await sendOrEditCard(
              chatId,
              `ℹ️ <b>This is your own listing!</b>\n\nYou cannot send a match request to yourself.`,
              [[{ text: '🏠 Main Menu', callback_data: 'nav_start' }]],
              msgId
            );
            return NextResponse.json({ ok: true });
          }
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

        const notifyText = `🤝 <b>SpaceMatch</b> · <b>New Connection Request!</b>\n\nA verified user saw your channel listing and wants to connect!\n\n• <b>Profile:</b> ${requesterProfile.gender || 'Not specified'}\n• <b>Budget:</b> <code>${Number(requesterProfile.budget_min || 0).toLocaleString()} – ${Number(requesterProfile.budget_max || 0).toLocaleString()} ETB</code>\n• <b>Target Areas:</b> <code>${requesterLocations}</code>\n\n<blockquote>Would you like to connect with this roommate?</blockquote>`;

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

        const paymentInstructions = `🎉 <b>You Both Want to Connect!</b>\n\nTo unlock contact details, each person must pay a matching fee of <b>300 ETB</b>.\n\n🏦 <b>Payment Options:</b>\n• <b>Telebirr:</b> <code>${receiverPhone}</code> (SpaceMatch Addis)\n• <b>CBE:</b> <code>${cbeAccount}</code> (SpaceMatch Addis)\n\nOnce transferred, submit your reference code:\n<code>/verify telebirr YOUR_REFERENCE</code>\nor\n<code>/verify cbe YOUR_REFERENCE</code>\n\n<i>Example: /verify telebirr FT260920042</i>`;

        // Send to both users
        const requesterTgId = (match.requester as any)?.telegram_id;
        const targetTgId = (match.target as any)?.telegram_id;

        if (requesterTgId) await tgSend(requesterTgId, paymentInstructions);
        if (targetTgId) await tgSend(targetTgId, paymentInstructions);

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
        await tgSend(chatId, `✅ You've declined the match request.`);

        // Notify requester
        const requesterTgId = (match.requester as any)?.telegram_id;
        if (requesterTgId) {
          await tgSend(
            requesterTgId,
            `📭 <b>Match Unavailable</b>\n\nPotential Roommate is unavailable. Keep looking on the channel! 🏠`
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
        const session = getSession(chatId);
        await sendSeekerSubcityStep(chatId, session.draft_data, msgId);
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
        const adminKeyboard = {
          inline_keyboard: [
            [{ text: '📢 Active Channel Posts & Close / Match', callback_data: 'admin_list_active_posts' }],
            [{ text: '📢 Post Custom Announcement', callback_data: 'admin_custom_prompt' }],
            [{ text: '❌ Exit Admin Menu', callback_data: 'admin_cancel' }],
          ],
        };

        if (msgId) {
          await sendTelegram('editMessageText', {
            chat_id: chatId,
            message_id: msgId,
            text: `<b>👑 SpaceMatch Admin Panel</b>\nManage active listings and channel posts:`,
            parse_mode: 'HTML',
            reply_markup: adminKeyboard,
          });
        } else {
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: `<b>👑 SpaceMatch Admin Panel</b>\nManage active listings and channel posts:`,
            parse_mode: 'HTML',
            reply_markup: adminKeyboard,
          });
        }
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


      // Reply Keyboard Button Handler
      if (text === '🔍 Find Roommate (Matchmaker)' || text === '🔍 Find Roommate') {
        await clearSession(chatId);
        await sendMatchmakerSubcityStep(chatId);
        return NextResponse.json({ ok: true });
      }

      if (text === '👥 Post Seeker Profile' || text === '👥 Post Seeker Profile (Looking for Roommate)') {
        await clearSession(chatId);
        await sendSeekerSubcityStep(chatId);
        return NextResponse.json({ ok: true });
      }

      if (text === '🏠 Share Space to Rent' || text === '🏠 Share Space / Room for Rent') {
        await clearSession(chatId);
        await sendPropertyTypePrompt(chatId);
        return NextResponse.json({ ok: true });
      }

      if (text === '🛡️ Verify Fayda ID') {
        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: `<b>🛡️ Fayda National ID Verification</b>\n\nPlease attach and send a photo of your Fayda National ID in chat now for verification!`,
          parse_mode: 'HTML',
        });
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
          const lookupCode = text.replace('/start req_', '').trim();

          // Lookup target profile from profiles or roommate_profiles
          let targetProfile: any = null;
          const { data: pCode } = await supabaseAdmin
            .from('profiles')
            .select('*')
            .eq('display_code', lookupCode)
            .single();

          if (pCode) {
            targetProfile = pCode;
          } else {
            const { data: pId } = await supabaseAdmin
              .from('profiles')
              .select('*')
              .eq('id', lookupCode)
              .single();
            if (pId) {
              targetProfile = pId;
            } else {
              const { data: rm } = await supabaseAdmin
                .from('roommate_profiles')
                .select('*')
                .eq('id', lookupCode)
                .single();
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

          // Present the Listing Inspection Card
          const targetLocations = Array.isArray(targetProfile.locations)
            ? targetProfile.locations.join(', ')
            : 'Addis Ababa';

          const budgetStr = targetProfile.budget_max
            ? `Up to ${Number(targetProfile.budget_max).toLocaleString()} ETB/month`
            : `${Number(targetProfile.budget_min || 0).toLocaleString()} – ${Number(targetProfile.budget_max || 0).toLocaleString()} ETB/month`;

          const bioContent = (targetProfile.roommate_traits || 'Seeking a compatible roommate in Addis Ababa.').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const inspectionCard = `
🤝 <b>Verified Roommate · #${targetProfile.display_code || lookupCode}</b>
📍 <code>${targetLocations}</code> · 🛡️ <b>Fayda Verified</b>

• <b>Profile:</b> ${targetProfile.gender || 'Not specified'}
• <b>Budget Range:</b> <code>${budgetStr}</code>

<blockquote>"${bioContent}"</blockquote>

🔒 <i>Personal identity, direct phone, and Telegram handle unlock instantly after payment verification.</i>
          `.trim();

          await sendOrEditCard(
            chatId,
            inspectionCard,
            [
              [
                { text: '❤️ Send Mutual Match Request', callback_data: `confirm_match:${targetProfile.id}` },
              ],
              [
                { text: '🔒 Direct Contact Unlock · 50 ETB ⚡', callback_data: `start_unlock_seeker:${targetProfile.id}` },
              ],
              [
                { text: '🏠 Main Menu', callback_data: 'nav_start' },
              ],
            ]
          );
          return NextResponse.json({ ok: true });
        }
        // ── END deep-link handler ─────────────────────────────────────────────

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

        if (text === '/start match' || text === '/start find') {
          await sendMatchmakerSubcityStep(chatId);
          return NextResponse.json({ ok: true });
        }

        if (text === '/start seeker_flow' || text === '/start seeker') {
          await sendSeekerSubcityStep(chatId);
          return NextResponse.json({ ok: true });
        }

        if (text === '/start property_type') {
          await sendPropertyTypePrompt(chatId);
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

        await sendPrimaryWelcomeMenu(chatId);
        return NextResponse.json({ ok: true });
      }

      // Matchmaker Commands
      if (text === '/match' || text === '/find' || text === '/roommate') {
        await clearSession(chatId);
        await sendMatchmakerSubcityStep(chatId);
        return NextResponse.json({ ok: true });
      }

      if (text === '/seeker' || text === '/seeker_flow') {
        await clearSession(chatId);
        await sendSeekerSubcityStep(chatId);
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

        // 1. Check if reference already used
        const { data: existingPayment } = await supabaseAdmin
          .from('payments')
          .select('id')
          .eq('reference', reference)
          .single();

        if (existingPayment) {
          await tgSend(
            chatId,
            `❌ <b>Reference Already Used</b>\n\nThis transaction reference has already been submitted. Please use a different reference number.`
          );
          return NextResponse.json({ ok: true });
        }

        // 2. Find the paying user's profile
        const { data: payerProfile } = await supabaseAdmin
          .from('profiles')
          .select('id, status')
          .eq('telegram_id', chatId)
          .single();

        if (!payerProfile) {
          await tgSend(chatId, `⚠️ Profile not found. Please complete your onboarding first.`);
          return NextResponse.json({ ok: true });
        }

        // 3. Find the active pending_payment match for this user
        const { data: activeMatch } = await supabaseAdmin
          .from('matches')
          .select('*, requester:requester_id(id, telegram_id, display_code, full_name, phone_number, telegram_username), target:target_id(id, telegram_id, display_code, full_name, phone_number, telegram_username, channel_message_id)')
          .or(`requester_id.eq.${payerProfile.id},target_id.eq.${payerProfile.id}`)
          .eq('status', 'pending_payment')
          .order('created_at', { ascending: false })
          .limit(1)
          .single();

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
        const verifyResult = await verifyTelebirrPayment(reference, 300);

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
          amount: verifyResult.paidAmount ?? 300,
        });

        // 7. Determine which side paid and update the match
        const isRequester = (activeMatch.requester as any)?.id === payerProfile.id;
        const updateField = isRequester ? 'requester_paid' : 'target_paid';

        const { data: updatedMatch } = await supabaseAdmin
          .from('matches')
          .update({ [updateField]: true })
          .eq('id', activeMatch.id)
          .select('requester_paid, target_paid')
          .single();

        const bothPaid = updatedMatch?.requester_paid && updatedMatch?.target_paid;

        if (!bothPaid) {
          // Only one side paid — update payment_status and notify both
          await supabaseAdmin
            .from('matches')
            .update({ payment_status: 'one_paid' })
            .eq('id', activeMatch.id);

          await tgSend(
            chatId,
            `✅ <b>300 ETB Verified!</b>\n\nWaiting for your potential roommate to complete their payment.`
          );

          // Alert the other user
          const otherTgId = isRequester
            ? (activeMatch.target as any)?.telegram_id
            : (activeMatch.requester as any)?.telegram_id;

          if (otherTgId) {
            await tgSend(
              otherTgId,
              `🔔 <b>Your potential roommate has paid!</b>\n\nPay your 300 ETB fee to unlock contact details.\n\n<code>/verify telebirr YOUR_REFERENCE</code> or <code>/verify cbe YOUR_REFERENCE</code>`
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
            })
            .eq('id', activeMatch.id);

          // Mark both profiles as matched
          const requesterProfileId = (activeMatch.requester as any)?.id;
          const targetProfileId    = (activeMatch.target as any)?.id;

          await supabaseAdmin
            .from('profiles')
            .update({ status: 'matched' })
            .in('id', [requesterProfileId, targetProfileId].filter(Boolean));

          // Update channel post to MATCHED & CLOSED
          const channelMsgId = (activeMatch.target as any)?.channel_message_id;
          const targetDisplayCode = (activeMatch.target as any)?.display_code;
          if (channelMsgId && targetDisplayCode) {
            try {
              await updateChannelPostAsMatched(channelMsgId, targetDisplayCode);
            } catch (err) {
              console.error('[webhook] Failed to update channel post:', err);
            }
          }

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
            await tgSend(requesterTgId, buildRevealMsg(targetData), requesterRevealMarkup);
          }
          if (targetTgId) {
            await tgSend(targetTgId, buildRevealMsg(requesterData), targetRevealMarkup);
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

      if (text === '/admin') {
        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: `<b>👑 SpaceMatch Admin Controls</b>`,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '📢 Admin Dashboard', callback_data: 'admin_menu' }],
            ],
          },
        });
        return NextResponse.json({ ok: true });
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
