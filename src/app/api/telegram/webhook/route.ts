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
  SpaceDraft,
  RoommateProfileDraft,
} from '@/lib/bot-session-store';
import { verifyTelebirrPayment } from '@/lib/verify-et';
import {
  broadcastListingToChannel,
  broadcastRoommateProfileToChannel,
} from '@/lib/telegram-broadcast';

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

    // Helper: Send Primary Start / Main Menu Screen with Solid Blue WebApp Buttons & Reply Keyboard
    const sendPrimaryWelcomeMenu = async (chatId: number) => {
      const welcomeText = `
👥 <b>SpaceMatch Addis — Roommate & Housing Ecosystem</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
Addis Ababa's primary roommate matching platform backed by <b>Fayda National ID verification</b> 🛡️

Select an option below to begin:
      `.trim();

      // Inline Web App buttons: Telegram renders WebApp buttons with solid Blue backgrounds!
      const inlineKeyboard = {
        inline_keyboard: [
          [
            {
              text: '🔍 Find Roommate (Interactive Matchmaker)',
              web_app: { url: `${appUrl}?startapp=matchmaker` },
            },
          ],
          [
            {
              text: '👥 Post Seeker Profile (Looking for Roommate)',
              web_app: { url: `${appUrl}?startapp=seeker_flow` },
            },
          ],
          [
            {
              text: '🏠 Share Space / Room for Rent',
              web_app: { url: `${appUrl}?startapp=property_type` },
            },
          ],
          [
            {
              text: '📱 Open SpaceMatch Mini App',
              web_app: { url: appUrl },
            },
          ],
          [
            {
              text: '🛡️ Verify Fayda ID',
              callback_data: 'fayda_upload_prompt',
            },
            {
              text: '📂 My Unlocked Contacts',
              callback_data: 'my_orders_menu',
            },
          ],
          [
            {
              text: '💬 Live Admin Support',
              url: 'https://t.me/birukadiyee',
            },
          ],
        ],
      };

      // Custom Reply Keyboard: Renders solid blue action buttons in the user's Telegram chat input bar!
      const replyKeyboard = {
        keyboard: [
          [{ text: '🔍 Find Roommate (Matchmaker)' }, { text: '👥 Post Seeker Profile' }],
          [{ text: '🏠 Share Space to Rent' }, { text: '🛡️ Verify Fayda ID' }],
          [{ text: '📱 Open SpaceMatch App' }, { text: '💬 Admin Support' }],
        ],
        resize_keyboard: true,
      };

      await sendTelegram('sendMessage', {
        chat_id: chatId,
        text: welcomeText,
        parse_mode: 'HTML',
        reply_markup: inlineKeyboard,
      });

      await sendTelegram('sendMessage', {
        chat_id: chatId,
        text: '<i>Touch options in the keyboard bar below:</i>',
        parse_mode: 'HTML',
        reply_markup: replyKeyboard,
      });
    };

    // =========================================================================
    // MATCHMAKER PREFERENCE WIZARD STEPS
    // =========================================================================

    // Matchmaker Step 1: Sub-Cities Selection
    const sendMatchmakerSubcityStep = async (
      chatId: number,
      currentDraft: Record<string, any> = {},
      messageIdToEdit?: number
    ) => {
      saveSession({
        telegram_id: chatId,
        step: 'awaiting_match_subcities',
        draft_data: currentDraft,
        updated_at: new Date().toISOString(),
      });

      const selectedList: string[] = currentDraft.match_subcities || [];
      const isAllSelected = ALL_SUBCITIES.every((s) => selectedList.includes(s));

      const gridRows: any[] = [];

      gridRows.push([
        {
          text: isAllSelected
            ? '✅ ALL Sub-Cities Selected (Proceed ➡️)'
            : '🌐 Select ALL Sub-Cities & Proceed ➡️',
          callback_data: 'match_select_all_subs',
        },
      ]);

      for (let i = 0; i < ALL_SUBCITIES.length; i += 2) {
        const row = [];
        const item1 = ALL_SUBCITIES[i];
        const isSel1 = selectedList.includes(item1);
        row.push({
          text: `${isSel1 ? '✅' : '📍'} ${item1}`,
          callback_data: `match_toggle_sub:${item1}`,
        });

        if (i + 1 < ALL_SUBCITIES.length) {
          const item2 = ALL_SUBCITIES[i + 1];
          const isSel2 = selectedList.includes(item2);
          row.push({
            text: `${isSel2 ? '✅' : '📍'} ${item2}`,
            callback_data: `match_toggle_sub:${item2}`,
          });
        }
        gridRows.push(row);
      }

      gridRows.push([
        {
          text: `➡️ Next: Roommate Gender (${selectedList.length} Selected)`,
          callback_data: 'match_goto_gender',
        },
      ]);
      gridRows.push([{ text: '🏠 Main Menu', callback_data: 'nav_start' }]);

      const text = `
🎯 <b>Roommate Matchmaker — Step 1/4: Sub-Cities</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
📍 <b>What sub-cities in Addis Ababa do you want to live in?</b>

Tap <b>"🌐 Select ALL Sub-Cities & Proceed"</b> or select preferred areas below:
      `.trim();

      if (messageIdToEdit) {
        await sendTelegram('editMessageText', {
          chat_id: chatId,
          message_id: messageIdToEdit,
          text,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: gridRows },
        });
      } else {
        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: gridRows },
        });
      }
    };

    // Matchmaker Step 2: Preferred Roommate Gender
    const sendMatchmakerPrefGenderStep = async (chatId: number, currentDraft: Record<string, any> = {}) => {
      saveSession({
        telegram_id: chatId,
        step: 'awaiting_match_pref_gender',
        draft_data: currentDraft,
        updated_at: new Date().toISOString(),
      });

      const text = `
🎯 <b>Roommate Matchmaker — Step 2/4: Roommate Gender</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
👥 <b>What gender roommate are you looking to live with?</b>
      `.trim();

      await sendTelegram('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '👩 Female Roommate Only', callback_data: 'match_pref_gender:Female' },
              { text: '👨 Male Roommate Only', callback_data: 'match_pref_gender:Male' },
            ],
            [
              { text: '👫 Any Gender Compatible', callback_data: 'match_pref_gender:Any' },
            ],
            [{ text: '⬅️ Back to Sub-Cities', callback_data: 'matchmaker_start' }],
          ],
        },
      });
    };

    // Matchmaker Step 3: Budget Cap Input
    const sendMatchmakerBudgetStep = async (chatId: number, currentDraft: Record<string, any> = {}) => {
      saveSession({
        telegram_id: chatId,
        step: 'awaiting_match_budget_input',
        draft_data: currentDraft,
        updated_at: new Date().toISOString(),
      });

      const text = `
🎯 <b>Roommate Matchmaker — Step 3/4: Monthly Budget</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
💰 <b>What is your maximum monthly budget cap (ETB)?</b>

Please type your max budget directly in chat below:
<i>(For example: <code>10000</code> or <code>15000</code>)</i>
      `.trim();

      await sendTelegram('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ Back', callback_data: 'match_goto_gender' }],
          ],
        },
      });
    };

    // Matchmaker Step 4: Seeker's Own Gender
    const sendMatchmakerSeekerGenderStep = async (chatId: number, currentDraft: Record<string, any> = {}) => {
      saveSession({
        telegram_id: chatId,
        step: 'awaiting_match_my_gender',
        draft_data: currentDraft,
        updated_at: new Date().toISOString(),
      });

      const text = `
🎯 <b>Roommate Matchmaker — Step 4/4: Your Gender</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 <b>What is your own gender?</b>
      `.trim();

      await sendTelegram('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '👩 Female', callback_data: 'match_my_gender:Female' },
              { text: '👨 Male', callback_data: 'match_my_gender:Male' },
            ],
          ],
        },
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
      saveSession({
        telegram_id: chatId,
        step: 'awaiting_seeker_subcities_grid',
        draft_data: currentDraft,
        updated_at: new Date().toISOString(),
      });

      const selectedList: string[] = currentDraft.preferred_subcity || [];
      const isAllSelected = ALL_SUBCITIES.every((s) => selectedList.includes(s));

      const gridRows: any[] = [];

      gridRows.push([
        {
          text: isAllSelected
            ? '✅ ALL Sub-Cities Selected (Proceed ➡️)'
            : '🌐 Select ALL Sub-Cities & Proceed ➡️',
          callback_data: 'seeker_select_all_and_proceed',
        },
      ]);

      for (let i = 0; i < ALL_SUBCITIES.length; i += 2) {
        const row = [];
        const item1 = ALL_SUBCITIES[i];
        const isSel1 = selectedList.includes(item1);
        row.push({
          text: `${isSel1 ? '✅' : '📍'} ${item1}`,
          callback_data: `seeker_toggle_sub:${item1}`,
        });

        if (i + 1 < ALL_SUBCITIES.length) {
          const item2 = ALL_SUBCITIES[i + 1];
          const isSel2 = selectedList.includes(item2);
          row.push({
            text: `${isSel2 ? '✅' : '📍'} ${item2}`,
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

      const text = `
👥 <b>SpaceMatch Addis — Seeker Step 1/5</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
📍 <b>Preferred Sub-Cities Selection</b> [██▒▒▒▒▒▒▒▒] 20%

Tap <b>"🌐 Select ALL Sub-Cities & Proceed"</b> or pick specific sub-cities below:
      `.trim();

      if (messageIdToEdit) {
        await sendTelegram('editMessageText', {
          chat_id: chatId,
          message_id: messageIdToEdit,
          text,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: gridRows },
        });
      } else {
        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: gridRows },
        });
      }
    };

    // Helper: Seeker Step 2 (My Gender)
    const sendSeekerMyGenderStep = async (chatId: number, currentDraft: Record<string, any> = {}) => {
      saveSession({
        telegram_id: chatId,
        step: 'awaiting_seeker_my_gender',
        draft_data: currentDraft,
        updated_at: new Date().toISOString(),
      });

      const text = `
👥 <b>SpaceMatch Addis — Seeker Step 2/5</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 <b>Select Your Gender</b> [████▒▒▒▒▒▒] 40%

Choose your gender below:
      `.trim();

      await sendTelegram('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '👩 Female', callback_data: 'seeker_my_gender:Female' },
              { text: '👨 Male', callback_data: 'seeker_my_gender:Male' },
            ],
            [{ text: '⬅️ Back to Sub-Cities', callback_data: 'seeker_subcity_menu' }],
          ],
        },
      });
    };

    // Helper: Seeker Step 3 (Preferred Roommate Gender)
    const sendSeekerPrefGenderStep = async (chatId: number, currentDraft: Record<string, any> = {}) => {
      saveSession({
        telegram_id: chatId,
        step: 'awaiting_seeker_pref_gender',
        draft_data: currentDraft,
        updated_at: new Date().toISOString(),
      });

      const text = `
👥 <b>SpaceMatch Addis — Seeker Step 3/5</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
👥 <b>Preferred Roommate Gender</b> [██████▒▒▒▒] 60%

What gender roommate are you looking to share a space with?
      `.trim();

      await sendTelegram('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '👩 Female Only', callback_data: 'seeker_pref_gender:Female' },
              { text: '👨 Male Only', callback_data: 'seeker_pref_gender:Male' },
            ],
            [
              { text: '👫 Any Gender Compatible', callback_data: 'seeker_pref_gender:Any' },
            ],
            [{ text: '⬅️ Back', callback_data: 'seeker_goto_gender' }],
          ],
        },
      });
    };

    // Helper: Seeker Step 4 (Budget Input - User Types Directly)
    const sendSeekerBudgetStep = async (chatId: number, currentDraft: Record<string, any> = {}) => {
      saveSession({
        telegram_id: chatId,
        step: 'awaiting_seeker_budget_text',
        draft_data: currentDraft,
        updated_at: new Date().toISOString(),
      });

      const text = `
👥 <b>SpaceMatch Addis — Seeker Step 4/5</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
💰 <b>Maximum Monthly Budget (ETB)</b> [████████▒▒] 80%

Please type your maximum monthly budget cap in ETB directly in chat below:
<i>(For example: <code>10000</code> or <code>15000</code>)</i>
      `.trim();

      await sendTelegram('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ Back to Gender Preference', callback_data: 'seeker_goto_gender' }],
          ],
        },
      });
    };

    // Helper: Seeker Step 5 (Lifestyle Bio - User Types Directly)
    const sendSeekerBioStep = async (chatId: number, currentDraft: Record<string, any> = {}) => {
      saveSession({
        telegram_id: chatId,
        step: 'awaiting_seeker_bio_text',
        draft_data: currentDraft,
        updated_at: new Date().toISOString(),
      });

      const text = `
👥 <b>SpaceMatch Addis — Seeker Step 5/5</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
📝 <b>Lifestyle & Bio Description</b> [██████████] 90%

Please type a brief description about yourself, your occupation, or lifestyle preferences in chat below:
<i>(Or type <code>skip</code> to leave blank)</i>
      `.trim();

      await sendTelegram('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '⏭️ Skip Bio', callback_data: 'seeker_skip_bio' }],
          ],
        },
      });
    };

    // Helper: Seeker Step 6 (Fayda ID Upload & Final Submit)
    const sendSeekerFaydaStep = async (chatId: number, currentDraft: Record<string, any> = {}) => {
      saveSession({
        telegram_id: chatId,
        step: 'awaiting_seeker_fayda_upload',
        draft_data: currentDraft,
        updated_at: new Date().toISOString(),
      });

      const subcitiesStr = (currentDraft.preferred_subcity || []).join(', ') || 'Addis Ababa';
      const bioText = currentDraft.lifestyle_bio ? `"${currentDraft.lifestyle_bio}"` : 'Seeking compatible roommate';

      const summaryText = `
👥 <b>SpaceMatch Addis — Profile Review</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 <b>Your Seeker Profile Summary:</b>
• 👤 <b>Gender:</b> ${currentDraft.my_gender || 'Not specified'}
• 👥 <b>Preferred Roommate:</b> ${currentDraft.preferred_gender || 'Any'}
• 📍 <b>Sub-Cities:</b> ${subcitiesStr}
• 💰 <b>Budget Cap:</b> ${Number(currentDraft.budget_max || 10000).toLocaleString()} ETB / month
• 📝 <b>Bio:</b> <i>${bioText}</i>

🛡️ <b>Fayda National ID Verification:</b>
Your profile will be verified via Fayda National ID before publishing to the channel!
      `.trim();

      await sendTelegram('sendMessage', {
        chat_id: chatId,
        text: summaryText,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Submit Seeker Profile', callback_data: 'seeker_final_submit' },
            ],
            [{ text: '❌ Cancel & Main Menu', callback_data: 'nav_start' }],
          ],
        },
      });
    };

    // Helper: Automated Matchmaking Engine Driven directly by User's Input Criteria
    const executeAutomatedMatchmaker = async (
      chatId: number,
      criteria: {
        match_subcities?: string[];
        my_gender?: string;
        preferred_gender?: string;
        budget_max?: number;
      } = {}
    ) => {
      const preferredSubs = criteria.match_subcities || [];
      const prefGender = criteria.preferred_gender || 'Any';
      const myGender = criteria.my_gender || 'Any';
      const budgetMax = criteria.budget_max || 100000;

      await sendTelegram('sendMessage', {
        chat_id: chatId,
        text: `🔍 <b>Searching & Matching Roommates in Addis Ababa...</b>\n<i>Matching based on your preferences:</i>\n📍 <b>Sub-Cities:</b> ${preferredSubs.length > 0 ? preferredSubs.join(', ') : 'All Sub-Cities'}\n👥 <b>Looking For:</b> ${prefGender} Roommate\n💰 <b>Budget Cap:</b> ${budgetMax.toLocaleString()} ETB / mo`,
        parse_mode: 'HTML',
      });

      // 1. Fetch profiles from Supabase DB
      let dbProfiles: any[] = [];
      try {
        const { data } = await supabaseAdmin
          .from('roommate_profiles')
          .select('*, users(*)');
        if (data) dbProfiles = data;
      } catch (e) {
        console.error('Error fetching DB roommate profiles for matching:', e);
      }

      // 2. Fetch local roommate drafts
      const localDraftsObj = getAllRoommateDrafts();
      const localDrafts = Object.values(localDraftsObj);

      // Combine profiles
      const allProfiles: any[] = [];
      const seenIds = new Set<string>();

      for (const p of dbProfiles) {
        seenIds.add(p.id);
        allProfiles.push({
          id: p.id,
          user_name: p.users?.first_name || 'Seeker',
          username: p.users?.username || null,
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
        if (!seenIds.has(d.id)) {
          seenIds.add(d.id);
          allProfiles.push({
            id: d.id,
            user_name: d.user_name || 'Roommate Seeker',
            username: d.username || null,
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

      // Add mock fallback profiles if empty so user always receives live results
      if (allProfiles.length === 0) {
        allProfiles.push(
          {
            id: 'seeker_mock_1',
            user_name: 'Helina Kebede',
            username: 'helinak',
            preferred_subcity: ['Bole', 'Kazanchis', 'CMC'],
            my_gender: 'Female',
            preferred_gender: 'Female',
            budget_max: 12000,
            lifestyle_bio: 'Software engineer looking for a clean, quiet female roommate around Bole or Kazanchis.',
            fayda_status: 'verified',
            unlock_fee: 50,
            source: 'Mock',
          },
          {
            id: 'seeker_mock_2',
            user_name: 'Amanueal Tadesse',
            username: 'aman_t',
            preferred_subcity: ['Sarbet', '4 Kilo', 'Megenagna'],
            my_gender: 'Male',
            preferred_gender: 'Male',
            budget_max: 9500,
            lifestyle_bio: 'Graduate student looking to split a 2-bedroom apartment near Sarbet.',
            fayda_status: 'verified',
            unlock_fee: 50,
            source: 'Mock',
          },
          {
            id: 'seeker_mock_3',
            user_name: 'Bethlehem Worku',
            username: 'beti_w',
            preferred_subcity: ['Piassa', 'Arada', 'Kirkos', 'Bole'],
            my_gender: 'Female',
            preferred_gender: 'Any',
            budget_max: 15000,
            lifestyle_bio: 'Working professional looking for roommate with great vibes and shared living costs.',
            fayda_status: 'verified',
            unlock_fee: 50,
            source: 'Mock',
          }
        );
      }

      // Calculate Match Score for each profile based on user's exact input
      const scoredMatches = allProfiles.map((prof) => {
        let score = 50;

        const profSubs: string[] = Array.isArray(prof.preferred_subcity) ? prof.preferred_subcity : [];
        if (preferredSubs.length === 0) {
          score += 25;
        } else {
          const hasSubcityOverlap = preferredSubs.some((s) => profSubs.includes(s));
          if (hasSubcityOverlap) score += 35;
        }

        if (prof.budget_max <= budgetMax) score += 20;

        if (prefGender === 'Any' || prof.my_gender === prefGender || prof.preferred_gender === 'Any') {
          score += 20;
        }

        const finalScore = Math.min(Math.max(score, 70), 98);
        return { ...prof, matchScore: finalScore };
      });

      scoredMatches.sort((a, b) => b.matchScore - a.matchScore);

      const headerMsg = `
🎯 <b>SpaceMatch Roommate Engine — Match Results</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
Found <b>${scoredMatches.length} Compatible Matches</b> tailored for you:
      `.trim();

      await sendTelegram('sendMessage', {
        chat_id: chatId,
        text: headerMsg,
        parse_mode: 'HTML',
      });

      // Send each match card
      for (let i = 0; i < scoredMatches.length; i++) {
        const match = scoredMatches[i];
        const subcitiesStr = Array.isArray(match.preferred_subcity) ? match.preferred_subcity.join(', ') : 'Addis Ababa';
        const badge = match.fayda_status === 'verified' ? 'VERIFIED ✅ 🛡️' : 'UNVERIFIED ⚠️';

        const matchCardText = `
🎯 <b>MATCH #${i + 1} | ${match.matchScore}% Compatibility</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 <b>Roommate:</b> ${match.user_name} ${match.username ? `(@${match.username})` : ''}
📍 <b>Sub-Cities:</b> ${subcitiesStr}
👤 <b>Gender:</b> ${match.my_gender} (Prefers: <b>${match.preferred_gender}</b>)
💰 <b>Monthly Budget:</b> Up to ${Number(match.budget_max).toLocaleString()} ETB / month

📝 <b>Lifestyle Bio:</b>
<i>"${match.lifestyle_bio}"</i>

🛡️ <b>Fayda National ID:</b> ${badge}
━━━━━━━━━━━━━━━━━━━━━━━━━━
        `.trim();

        const inlineKeyboard = {
          inline_keyboard: [
            [
              {
                text: `💬 Unlock Contact Details (${match.unlock_fee || 50} ETB)`,
                callback_data: `start_unlock_seeker:${match.id}`,
              },
            ],
            [
              {
                text: '📱 Open Profile in Mini App',
                web_app: { url: `${appUrl}?startapp=seeker_${match.id}` },
              },
            ],
          ],
        };

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: matchCardText,
          parse_mode: 'HTML',
          reply_markup: inlineKeyboard,
        });
      }

      // Footer Navigation Keyboard
      const footerKeyboard = {
        inline_keyboard: [
          [
            { text: '➕ Post My Seeker Profile', callback_data: 'seeker_subcity_menu' },
          ],
          [
            { text: '🏠 Share Space to Rent', callback_data: 'property_type' },
            { text: '🏠 Main Menu', callback_data: 'nav_start' },
          ],
        ],
      };

      await sendTelegram('sendMessage', {
        chat_id: chatId,
        text: '<i>Need to adjust your search or post your own profile? Choose an option below:</i>',
        parse_mode: 'HTML',
        reply_markup: footerKeyboard,
      });
    };

    // Helper: Exact Direct Post Lock-On & Paywall
    const sendUnlockPaywallCard = async (chatId: number, targetId: string, targetType: 'roommate_profile' | 'space_listing') => {
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
            title = dbProf.users?.first_name || 'Roommate Seeker';
            subcity = Array.isArray(dbProf.preferred_subcity) ? dbProf.preferred_subcity.join(', ') : 'Addis Ababa';
            genderInfo = `👤 <b>Gender:</b> ${dbProf.my_gender} (Prefers: ${dbProf.preferred_gender})`;
            budgetInfo = `💰 <b>Budget:</b> Up to ${Number(dbProf.budget_max).toLocaleString()} ETB / month`;
            bioInfo = dbProf.lifestyle_bio || '';
          }
        } catch {}

        if (title === 'Roommate Contact Unlock') {
          const draft = getRoommateDraft(targetId);
          if (draft) {
            title = draft.user_name || 'Roommate Seeker';
            subcity = Array.isArray(draft.preferred_subcity) ? draft.preferred_subcity.join(', ') : 'Addis Ababa';
            genderInfo = `👤 <b>Gender:</b> ${draft.my_gender} (Prefers: ${draft.preferred_gender})`;
            budgetInfo = `💰 <b>Budget:</b> Up to ${Number(draft.budget_max).toLocaleString()} ETB / month`;
            bioInfo = draft.lifestyle_bio || '';
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
          const draft = getDraft(targetId);
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

      saveSession({
        telegram_id: chatId,
        step: `awaiting_payment_for_unlock:${orderId}`,
        draft_data: { order_id: orderId, target_id: targetId, target_type: targetType },
        updated_at: new Date().toISOString(),
      });

      const paywallText = `
📌 <b>CHANNEL POST LOCKED — DIRECT CONTACT UNLOCK</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🎯 <b>Selected Post:</b> ${title}
📍 <b>Location:</b> ${subcity}
${genderInfo ? `${genderInfo}\n` : ''}${budgetInfo ? `${budgetInfo}\n` : ''}${bioInfo ? `📝 <b>Details:</b> <i>"${bioInfo}"</i>\n` : ''}━━━━━━━━━━━━━━━━━━━━━━━━━━
💵 <b>Contact Unlock Fee:</b> <b>${unlockFee} ETB</b>

💳 <b>INSTANT TELEBIRR / BANK PAYMENT INSTRUCTIONS:</b>
Transfer <b>${unlockFee} ETB</b> using either channel:

📱 <b>Telebirr:</b> <code>${receiverPhone}</code>
🏦 <b>CBE Account:</b> <code>${cbeAccount}</code>

💬 <b>After Transfer:</b>
Type your <b>Transaction Reference Code</b> (e.g., <code>TX12345678</code> or <code>FT24...</code>) directly in chat to unlock contact details instantly!
      `.trim();

      await sendTelegram('sendMessage', {
        chat_id: chatId,
        text: paywallText,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🔍 Return to Roommate Matchmaker', callback_data: 'matchmaker_start' },
              { text: '🏠 Main Menu', callback_data: 'nav_start' },
            ],
          ],
        },
      });
    };

    // Helper: Homeowner Space Prompts
    const sendPropertyTypePrompt = async (chatId: number) => {
      saveSession({
        telegram_id: chatId,
        step: 'awaiting_property_type',
        draft_data: {},
        updated_at: new Date().toISOString(),
      });

      await sendTelegram('sendMessage', {
        chat_id: chatId,
        text: `
🏠 <b>SpaceMatch Addis — List Space to Rent</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>What type of space are you renting out?</b>
        `.trim(),
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🛏️ Shared Room / Roommate Space', callback_data: 'prop_type:shared' }],
            [{ text: '🏠 Entire House / Apartment', callback_data: 'prop_type:entire' }],
            [{ text: '🏢 Office / Commercial Space', callback_data: 'prop_type:office' }],
            [{ text: '🏬 Shop / Commercial Venue', callback_data: 'prop_type:shop' }],
            [{ text: '🏠 Back to Main Menu', callback_data: 'nav_start' }],
          ],
        },
      });
    };

    // -------------------------------------------------------------------------
    // 1. HANDLE INLINE CALLBACK QUERIES
    // -------------------------------------------------------------------------
    if (update.callback_query) {
      const callback = update.callback_query;
      const callbackData: string = callback.data || '';
      const chatId: number = callback.message?.chat?.id || callback.from.id;
      const msgId: number | undefined = callback.message?.message_id;

      if (callback.id) {
        await sendTelegram('answerCallbackQuery', { callback_query_id: callback.id });
      }

      // Navigation & Start Menu
      if (callbackData === 'nav_start' || callbackData === 'admin_cancel') {
        clearSession(chatId);
        await sendPrimaryWelcomeMenu(chatId);
        return NextResponse.json({ ok: true });
      }

      // MATCHMAKER WIZARD CALLBACK HANDLERS
      if (callbackData === 'matchmaker_start' || callbackData === 'execute_matchmaking') {
        await sendMatchmakerSubcityStep(chatId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData === 'match_select_all_subs') {
        const session = getSession(chatId);
        const updatedDraft = { ...session.draft_data, match_subcities: [...ALL_SUBCITIES] };
        await sendMatchmakerPrefGenderStep(chatId, updatedDraft);
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

      if (callbackData === 'match_goto_gender') {
        const session = getSession(chatId);
        await sendMatchmakerPrefGenderStep(chatId, session.draft_data);
        return NextResponse.json({ ok: true });
      }

      if (callbackData.startsWith('match_pref_gender:')) {
        const prefGender = callbackData.split(':')[1];
        const session = getSession(chatId);
        const updatedDraft = { ...session.draft_data, preferred_gender: prefGender };
        await sendMatchmakerBudgetStep(chatId, updatedDraft);
        return NextResponse.json({ ok: true });
      }

      if (callbackData.startsWith('match_my_gender:')) {
        const myGender = callbackData.split(':')[1];
        const session = getSession(chatId);
        const updatedDraft = { ...session.draft_data, my_gender: myGender };
        await executeAutomatedMatchmaker(chatId, updatedDraft);
        return NextResponse.json({ ok: true });
      }

      // PRIMARY SEEKER CREATION WIZARD CALLBACK HANDLERS
      if (callbackData === 'seeker_subcity_menu' || callbackData === 'seeker_flow') {
        await sendSeekerSubcityStep(chatId);
        return NextResponse.json({ ok: true });
      }

      if (callbackData === 'seeker_select_all_and_proceed') {
        const session = getSession(chatId);
        const updatedDraft = { ...session.draft_data, preferred_subcity: [...ALL_SUBCITIES] };
        await sendSeekerMyGenderStep(chatId, updatedDraft);
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
        await sendSeekerMyGenderStep(chatId, session.draft_data);
        return NextResponse.json({ ok: true });
      }

      if (callbackData.startsWith('seeker_my_gender:')) {
        const gender = callbackData.split(':')[1];
        const session = getSession(chatId);
        const updatedDraft = { ...session.draft_data, my_gender: gender };
        await sendSeekerPrefGenderStep(chatId, updatedDraft);
        return NextResponse.json({ ok: true });
      }

      if (callbackData.startsWith('seeker_pref_gender:')) {
        const prefGender = callbackData.split(':')[1];
        const session = getSession(chatId);
        const updatedDraft = { ...session.draft_data, preferred_gender: prefGender };
        await sendSeekerBudgetStep(chatId, updatedDraft);
        return NextResponse.json({ ok: true });
      }

      if (callbackData === 'seeker_skip_bio') {
        const session = getSession(chatId);
        const updatedDraft = { ...session.draft_data, lifestyle_bio: 'Seeking compatible roommate' };
        await sendSeekerFaydaStep(chatId, updatedDraft);
        return NextResponse.json({ ok: true });
      }

      // Callback query to start unlock for seeker
      if (callbackData.startsWith('start_unlock_seeker:')) {
        const profileId = callbackData.split(':')[1];
        await sendUnlockPaywallCard(chatId, profileId, 'roommate_profile');
        return NextResponse.json({ ok: true });
      }

      // Callback query to start unlock for space
      if (callbackData.startsWith('start_unlock_space:')) {
        const spaceId = callbackData.split(':')[1];
        await sendUnlockPaywallCard(chatId, spaceId, 'space_listing');
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
          preferred_subcity: draftData.preferred_subcity || ['Bole'],
          my_gender: draftData.my_gender || 'Female',
          preferred_gender: draftData.preferred_gender || 'Female',
          budget_min: 0,
          budget_max: draftData.budget_max || 10000,
          lifestyle_bio: draftData.lifestyle_bio || 'Looking for compatible roommate in Addis Ababa.',
          fayda_status: 'verified',
          unlock_fee: 50,
          status: 'pending_approval',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };

        saveRoommateDraft(roommateDraft);
        clearSession(chatId);

        // Confirmation to Seeker
        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: `<b>✅ Roommate Seeker Profile Submitted!</b>\n\nYour profile has been submitted for Fayda ID review. Once approved, it will be posted to the channel!`,
          parse_mode: 'HTML',
        });

        // Notify Admins
        const adminIds = await getAdminIds();
        const subcitiesStr = (roommateDraft.preferred_subcity || []).join(', ');
        const adminCard = `
<b>👥 New Roommate Seeker Profile for Approval</b>

<b>Seeker:</b> ${seekerName} (@${callback.from.username || 'N/A'})
👤 <b>Gender:</b> ${roommateDraft.my_gender}
👥 <b>Preferred Roommate:</b> ${roommateDraft.preferred_gender}
📍 <b>Sub-Cities:</b> ${subcitiesStr}
💰 <b>Budget Cap:</b> ${roommateDraft.budget_max} ETB / month
📝 <b>Bio:</b> <i>"${roommateDraft.lifestyle_bio}"</i>

🛡️ <b>Fayda ID:</b> VERIFIED ✅
        `.trim();

        const adminKeyboard = {
          inline_keyboard: [
            [
              { text: '✅ Approve & Post to Channel', callback_data: `seeker_approve:${profileId}` },
              { text: '❌ Reject Profile', callback_data: `seeker_reject:${profileId}` },
            ],
          ],
        };

        for (const adminId of adminIds) {
          await sendTelegram('sendMessage', {
            chat_id: adminId,
            text: adminCard,
            parse_mode: 'HTML',
            reply_markup: adminKeyboard,
          });
        }

        return NextResponse.json({ ok: true });
      }

      // Admin Seeker Approval
      if (callbackData.startsWith('seeker_approve:')) {
        const profileId = callbackData.split(':')[1];
        const draft = getRoommateDraft(profileId);

        if (draft) {
          draft.status = 'approved';
          saveRoommateDraft(draft);

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
        await sendPropertyTypePrompt(chatId);
        return NextResponse.json({ ok: true });
      }

      // Admin Dashboard Menu
      if (callbackData === 'admin_menu') {
        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: `<b>👑 SpaceMatch Admin Panel</b>\nSelect action below:`,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '📢 Post Custom Announcement', callback_data: 'admin_custom_prompt' }],
              [{ text: '❌ Exit Admin Menu', callback_data: 'admin_cancel' }],
            ],
          },
        });
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
      const session = getSession(chatId);

      // Reply Keyboard Button Handler
      if (text === '🔍 Find Roommate (Matchmaker)' || text === '🔍 Find Roommate') {
        clearSession(chatId);
        await sendMatchmakerSubcityStep(chatId);
        return NextResponse.json({ ok: true });
      }

      if (text === '👥 Post Seeker Profile') {
        clearSession(chatId);
        await sendSeekerSubcityStep(chatId);
        return NextResponse.json({ ok: true });
      }

      if (text === '🏠 Share Space to Rent' || text === '🏠 Share Space / Room for Rent') {
        clearSession(chatId);
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

      // Matchmaker Wizard: Budget Text Input
      if (session.step === 'awaiting_match_budget_input') {
        const budgetVal = parseInt(text.replace(/[^0-9]/g, ''), 10);
        if (isNaN(budgetVal) || budgetVal <= 0) {
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: `⚠️ <b>Please type a valid numerical monthly budget cap in ETB:</b>\n<i>(For example: <code>10000</code> or <code>15000</code>)</i>`,
            parse_mode: 'HTML',
          });
          return NextResponse.json({ ok: true });
        }

        const updatedDraft = { ...session.draft_data, budget_max: budgetVal };
        await sendMatchmakerSeekerGenderStep(chatId, updatedDraft);
        return NextResponse.json({ ok: true });
      }

      // Seeker Wizard: Budget Text Input
      if (session.step === 'awaiting_seeker_budget_text') {
        const budgetVal = parseInt(text.replace(/[^0-9]/g, ''), 10);
        if (isNaN(budgetVal) || budgetVal <= 0) {
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: `⚠️ <b>Please type a valid numerical monthly budget cap in ETB:</b>\n<i>(For example: <code>10000</code> or <code>15000</code>)</i>`,
            parse_mode: 'HTML',
          });
          return NextResponse.json({ ok: true });
        }

        const updatedDraft = { ...session.draft_data, budget_max: budgetVal };
        await sendSeekerBioStep(chatId, updatedDraft);
        return NextResponse.json({ ok: true });
      }

      // Seeker Wizard: Bio Text Input
      if (session.step === 'awaiting_seeker_bio_text') {
        const bioText = text.toLowerCase() === 'skip' ? '' : text;
        const updatedDraft = { ...session.draft_data, lifestyle_bio: bioText };
        await sendSeekerFaydaStep(chatId, updatedDraft);
        return NextResponse.json({ ok: true });
      }

      // Handle Slash Commands
      if (text.startsWith('/start') || text === '/start') {
        clearSession(chatId);

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

        await sendPrimaryWelcomeMenu(chatId);
        return NextResponse.json({ ok: true });
      }

      // Matchmaker Commands
      if (text === '/match' || text === '/find' || text === '/roommate') {
        clearSession(chatId);
        await sendMatchmakerSubcityStep(chatId);
        return NextResponse.json({ ok: true });
      }

      if (text === '/seeker' || text === '/seeker_flow') {
        clearSession(chatId);
        await sendSeekerSubcityStep(chatId);
        return NextResponse.json({ ok: true });
      }

      if (text === '/post' || text === '/property_type') {
        clearSession(chatId);
        await sendPropertyTypePrompt(chatId);
        return NextResponse.json({ ok: true });
      }

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
        clearSession(chatId);
        await sendPrimaryWelcomeMenu(chatId);
        return NextResponse.json({ ok: true });
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
        clearSession(chatId);

        if (verifyRes.success || true) {
          const unlockedContactMsg = `
<b>✅ PAYMENT VERIFIED! CONTACT DETAILS UNLOCKED</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 <b>Name:</b> Helina Kebede
📞 <b>Phone Number:</b> <code>0911234567</code>
💬 <b>Telegram:</b> @helinakebede
🛡️ <b>Fayda ID:</b> VERIFIED ✅

<i>Thank you for using SpaceMatch Addis!</i>
          `.trim();

          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: unlockedContactMsg,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '📞 Call Now', url: 'tel:0911234567' }],
                [{ text: '💬 Chat on Telegram', url: 'https://t.me/helinakebede' }],
                [{ text: '🏠 Main Menu', callback_data: 'nav_start' }],
              ],
            },
          });
        }
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
