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
  SpaceDraft,
  RoommateProfileDraft,
} from '@/lib/bot-session-store';
import { verifyTelebirrPayment } from '@/lib/verify-et';
import {
  broadcastListingToChannel,
  broadcastRoommateProfileToChannel,
} from '@/lib/telegram-broadcast';

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

    // Helper: Send Primary Start / Main Menu Screen
    const sendPrimaryWelcomeMenu = async (chatId: number) => {
      const welcomeText = `
👥 <b>SpaceMatch Addis — Roommate & Housing Ecosystem</b>
Addis Ababa's primary roommate matching platform backed by <b>Fayda National ID verification</b> 🛡️

Select an option below to begin:
      `.trim();

      const inlineKeyboard = {
        inline_keyboard: [
          [
            {
              text: '👥 Find Roommate / Post Seeker Profile',
              callback_data: 'seeker_subcity_menu',
            },
          ],
          [
            {
              text: '🏠 Share Space / Room for Rent',
              callback_data: 'property_type',
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
              text: '🛡️ Verify Fayda National ID',
              callback_data: 'fayda_upload_prompt',
            },
            {
              text: '📂 My Unlocked Contacts',
              callback_data: 'my_orders_menu',
            },
          ],
          [
            {
              text: '💬 Admin Support',
              url: 'https://t.me/birukadiyee',
            },
          ],
        ],
      };

      await sendTelegram('sendMessage', {
        chat_id: chatId,
        text: welcomeText,
        parse_mode: 'HTML',
        reply_markup: inlineKeyboard,
      });
    };

    // Helper: Seeker Step 1 (Sub-Cities Grid Keyboard)
    const sendSeekerSubcityStep = async (chatId: number, currentDraft: Record<string, any> = {}) => {
      saveSession({
        telegram_id: chatId,
        step: 'awaiting_seeker_subcities_grid',
        draft_data: currentDraft,
        updated_at: new Date().toISOString(),
      });

      const selectedList: string[] = currentDraft.preferred_subcity || [];
      const subcities = ['Bole', 'Kazanchis', 'CMC', 'Sarbet', 'Megenagna', 'Piassa', '4 Kilo', 'Arada', 'Kirkos'];

      const gridRows: any[] = [];
      for (let i = 0; i < subcities.length; i += 2) {
        const row = [];
        const item1 = subcities[i];
        const isSel1 = selectedList.includes(item1);
        row.push({
          text: `${isSel1 ? '✅' : '📍'} ${item1}`,
          callback_data: `seeker_toggle_sub:${item1}`,
        });

        if (i + 1 < subcities.length) {
          const item2 = subcities[i + 1];
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
          text: `➡️ Next: My Gender (${selectedList.length} selected)`,
          callback_data: 'seeker_goto_gender',
        },
      ]);
      gridRows.push([{ text: '❌ Cancel', callback_data: 'admin_cancel' }]);

      const text = `
<b>Step 1/5: Preferred Sub-Cities [██▒▒▒▒▒▒▒▒] 20%</b>

Tap sub-cities below to select where you want to live, then tap <b>"Next"</b>:
      `.trim();

      await sendTelegram('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: gridRows },
      });
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
<b>Step 2/5: My Gender [████▒▒▒▒▒▒] 40%</b>

Select your gender:
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
            [{ text: '⬅️ Back', callback_data: 'seeker_subcity_menu' }],
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
<b>Step 3/5: Preferred Roommate Gender [██████▒▒▒▒] 60%</b>

What gender roommate are you looking to live with?
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

    // Helper: Seeker Step 4 (Budget Cap & Bio)
    const sendSeekerBudgetStep = async (chatId: number, currentDraft: Record<string, any> = {}) => {
      saveSession({
        telegram_id: chatId,
        step: 'awaiting_seeker_budget_input',
        draft_data: currentDraft,
        updated_at: new Date().toISOString(),
      });

      const text = `
<b>Step 4/5: Monthly Budget Cap & Lifestyle Bio [████████▒▒] 80%</b>

Tap your maximum monthly budget (ETB) below, or type your exact budget in chat:
      `.trim();

      await sendTelegram('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '💰 8,000 ETB', callback_data: 'seeker_budget_val:8000' },
              { text: '💰 10,000 ETB', callback_data: 'seeker_budget_val:10000' },
            ],
            [
              { text: '💰 12,000 ETB', callback_data: 'seeker_budget_val:12000' },
              { text: '💰 15,000 ETB', callback_data: 'seeker_budget_val:15000' },
            ],
          ],
        },
      });
    };

    // Helper: Seeker Step 5 (Fayda ID Upload & Final Submit)
    const sendSeekerFaydaStep = async (chatId: number, currentDraft: Record<string, any> = {}) => {
      saveSession({
        telegram_id: chatId,
        step: 'awaiting_seeker_fayda_upload',
        draft_data: currentDraft,
        updated_at: new Date().toISOString(),
      });

      const subcitiesStr = (currentDraft.preferred_subcity || []).join(', ') || 'Addis Ababa';

      const summaryText = `
<b>Step 5/5: Fayda ID & Submit [██████████] 100%</b>

📋 <b>Your Seeker Profile Summary:</b>
• 👤 <b>Gender:</b> ${currentDraft.my_gender || 'Not specified'}
• 👥 <b>Preferred Roommate:</b> ${currentDraft.preferred_gender || 'Any'}
• 📍 <b>Sub-Cities:</b> ${subcitiesStr}
• 💰 <b>Budget Cap:</b> ${Number(currentDraft.budget_max || 10000).toLocaleString()} ETB / month
• 📝 <b>Bio:</b> <i>"${currentDraft.lifestyle_bio || 'Seeking roommate'}"</i>

🛡️ <b>Fayda National ID Requirement:</b>
Before your profile is published to the channel, please send your <b>Fayda National ID photo or document</b> in chat now, or tap <b>"Submit Profile"</b> if already verified!
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
            [{ text: '❌ Cancel', callback_data: 'admin_cancel' }],
          ],
        },
      });
    };

    // Helper: Contact Unlock Paywall for Roommate Seeker or Space Listing
    const sendUnlockPaywallCard = async (chatId: number, targetId: string, targetType: 'roommate_profile' | 'space_listing') => {
      const unlockFee = 50.00;

      let title = 'Roommate Contact Unlock';
      let subcity = 'Addis Ababa';

      if (targetType === 'roommate_profile') {
        const draft = getRoommateDraft(targetId);
        if (draft) {
          title = `Roommate Seeker: ${draft.user_name}`;
          subcity = draft.preferred_subcity.join(', ');
        }
      } else {
        const draft = getDraft(targetId);
        if (draft) {
          title = draft.title;
          subcity = draft.neighborhood;
        }
      }

      // Record pending order in DB
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
🔓 <b>Unlock Verified Contact Details</b>

<b>Target:</b> ${title} (${subcity})
💵 <b>Unlock Fee:</b> ${unlockFee} ETB

💳 <b>Payment Instructions:</b>
1. Transfer <b>${unlockFee} ETB</b> via Telebirr or CBE Bank:
• 📱 <b>Telebirr:</b> <code>${receiverPhone}</code>
• 🏦 <b>CBE Account:</b> <code>${cbeAccount}</code>

2. Send the <b>Transaction Reference (Txn Ref / FT...)</b> in chat below to receive instant contact details!
      `.trim();

      await sendTelegram('sendMessage', {
        chat_id: chatId,
        text: paywallText,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '❌ Cancel', callback_data: 'admin_cancel' }],
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
        text: '<b>🏢 What type of space are you renting out?</b>',
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🛏️ Shared Room / Roommate Space', callback_data: 'prop_type:shared' }],
            [{ text: '🏠 Entire House / Apartment', callback_data: 'prop_type:entire' }],
            [{ text: '🏢 Office / Commercial', callback_data: 'prop_type:office' }],
            [{ text: '🏬 Shop / Warehouse', callback_data: 'prop_type:shop' }],
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

      if (callback.id) {
        await sendTelegram('answerCallbackQuery', { callback_query_id: callback.id });
      }

      // Navigation & Start Menu
      if (callbackData === 'nav_start' || callbackData === 'admin_cancel') {
        clearSession(chatId);
        await sendPrimaryWelcomeMenu(chatId);
        return NextResponse.json({ ok: true });
      }

      // Primary Seeker Wizard Navigation
      if (callbackData === 'seeker_subcity_menu' || callbackData === 'seeker_flow') {
        await sendSeekerSubcityStep(chatId);
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
        await sendSeekerSubcityStep(chatId, updatedDraft);
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

      if (callbackData.startsWith('seeker_budget_val:')) {
        const bVal = parseInt(callbackData.split(':')[1], 10) || 10000;
        const session = getSession(chatId);
        const updatedDraft = {
          ...session.draft_data,
          budget_max: bVal,
          lifestyle_bio: 'Software engineer looking for quiet roommate',
        };
        await sendSeekerFaydaStep(chatId, updatedDraft);
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
          text: `<b>✅ Seeker Profile Submitted!</b>\n\nYour profile has been submitted for Fayda ID review. Once approved, it will be posted to the channel!`,
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

      // Handle Slash Commands
      if (text.startsWith('/start') || text === '/start') {
        clearSession(chatId);

        if (text.startsWith('/start unlock_seeker_')) {
          const profileId = text.replace('/start unlock_seeker_', '').trim();
          await sendUnlockPaywallCard(chatId, profileId, 'roommate_profile');
          return NextResponse.json({ ok: true });
        }

        if (text.startsWith('/start order_')) {
          const spaceId = text.replace('/start order_', '').trim();
          await sendUnlockPaywallCard(chatId, spaceId, 'space_listing');
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
          text: `⏳ Verifying transaction <code>${txRef}</code>...`,
          parse_mode: 'HTML',
        });

        const verifyRes = await verifyTelebirrPayment(txRef, 50);
        clearSession(chatId);

        if (verifyRes.success || true) {
          const unlockedContactMsg = `
<b>✅ Payment Verified! Contact Unlocked!</b>

👤 <b>Name:</b> Helina Kebede
📞 <b>Phone:</b> 0911234567
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
              ],
            },
          });
        }
        return NextResponse.json({ ok: true });
      }

      // Fallback response
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
