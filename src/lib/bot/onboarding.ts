/**
 * lib/bot/onboarding.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Conversational onboarding state machine for SpaceMatch Addis.
 *
 * Step progression:
 *   gender → locations → budget → move_in → traits → phone → kyc → completed
 *
 * This module exports two primary entry points consumed by the webhook route:
 *   - handleOnboardingMessage()   → called for incoming text/contact/photo messages
 *   - handleOnboardingCallback()  → called for inline button presses
 *   - isOnboardingCallback()      → predicate to route callbacks here
 *   - isOnboardingSession()       → predicate to route sessions here
 */

import { supabaseAdmin } from '@/lib/supabase-server';
import { saveSession } from '@/lib/bot-session-store';
import {
  sendMessage,
  editMessageText,
  answerCallbackQuery,
  getFile,
  publishListingToChannel,
  escapeHtml,
  setChatMenuButton,
  parseNumericInput,
  deleteMessage,
  type Profile,
} from '@/lib/telegram';

// ─── Constants ────────────────────────────────────────────────────────────────

const LOCATIONS = [
  'Bole',
  'Megenagna',
  'Kazanchis',
  'CMC',
  'Sarbet',
  'Piassa',
  'Arada',
  'Kirkos',
  '4 Kilo',
  'Lideta',
  'Nifas Silk',
  'Akaki Kality',
];

const ONBOARDING_STEPS = [
  'gender',
  'locations',
  'budget',
  'move_in',
  'traits',
  'phone',
  'kyc',
  'completed',
] as const;

type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

// ─── Predicates ───────────────────────────────────────────────────────────────

export function isOnboardingCallback(callbackData: string): boolean {
  return (
    callbackData.startsWith('onboard_gender:') ||
    callbackData.startsWith('onboard_location:') ||
    callbackData === 'onboard_select_all_locations' ||
    callbackData === 'onboard_locations_done' ||
    callbackData.startsWith('onboard_movein:') ||
    callbackData === 'onboard_start'
  );
}

export function isOnboardingSession(step: string): boolean {
  return ONBOARDING_STEPS.includes(step as OnboardingStep);
}

// ─── Profile DB Helpers ───────────────────────────────────────────────────────

async function getOrCreateProfile(telegramId: number, username?: string): Promise<Profile | null> {
  // Try to fetch existing
  const { data: existing } = await supabaseAdmin
    .from('profiles')
    .select('*')
    .eq('telegram_id', telegramId)
    .single();

  if (existing) return existing as Profile;

  // Generate next display code via SQL function
  const { data: codeRow } = await supabaseAdmin.rpc('generate_display_code');
  const displayCode: string = codeRow || `RM${Date.now()}`;

  const { data: created, error } = await supabaseAdmin
    .from('profiles')
    .insert({
      telegram_id: telegramId,
      display_code: displayCode,
      onboarding_step: 'gender',
      telegram_username: username || null,
      status: 'onboarding',
    })
    .select('*')
    .single();

  if (error) {
    console.error('[onboarding] Failed to create profile:', error.message);
    return null;
  }

  return created as Profile;
}

async function updateProfile(
  telegramId: number,
  updates: Record<string, unknown>
): Promise<Profile | null> {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .update(updates)
    .eq('telegram_id', telegramId)
    .select('*')
    .single();

  if (error) {
    console.error('[onboarding] Failed to update profile:', error.message);
    return null;
  }

  // Keep bot_sessions table in sync with onboarding step
  if (updates.onboarding_step) {
    await saveSession({
      telegram_id: telegramId,
      step: String(updates.onboarding_step),
      draft_data: {},
      updated_at: new Date().toISOString(),
    });
  }

  return data as Profile;
}

// ─── Step UIs ─────────────────────────────────────────────────────────────────

async function sendGenderStep(chatId: number) {
  // Ensure the menu button is set to commands so mobile keyboards are completely unobstructed
  setChatMenuButton({ type: 'commands' }, chatId).catch(() => {});

  await sendMessage(
    chatId,
    `✨ <b>SpaceMatch Addis · Welcome!</b>\n\nLet's find you a compatible roommate.\n\n<blockquote>First, select your gender below:</blockquote>`,
    {
      inline_keyboard: [
        [
          { text: '👨 Male', callback_data: 'onboard_gender:male' },
          { text: '👩 Female', callback_data: 'onboard_gender:female' },
        ],
      ],
    }
  );
}

async function sendLocationsStep(chatId: number, selectedLocations: string[] = [], messageId?: number) {
  const rows: { text: string; callback_data: string }[][] = [];

  rows.push([
    {
      text: selectedLocations.length === LOCATIONS.length
        ? '✅ ALL Areas Selected (Proceed ➡️)'
        : '🌐 Select ALL Areas & Proceed ➡️',
      callback_data: 'onboard_select_all_locations',
    },
  ]);

  for (let i = 0; i < LOCATIONS.length; i += 2) {
    const row = [];
    const loc1 = LOCATIONS[i];
    const sel1 = selectedLocations.includes(loc1);
    row.push({
      text: `${sel1 ? '✅' : '📍'} ${loc1}`,
      callback_data: `onboard_location:${loc1}`,
    });
    if (i + 1 < LOCATIONS.length) {
      const loc2 = LOCATIONS[i + 1];
      const sel2 = selectedLocations.includes(loc2);
      row.push({
        text: `${sel2 ? '✅' : '📍'} ${loc2}`,
        callback_data: `onboard_location:${loc2}`,
      });
    }
    rows.push(row);
  }

  rows.push([
    {
      text: `Done Selecting ✅ (${selectedLocations.length} chosen)`,
      callback_data: 'onboard_locations_done',
    },
  ]);

  const text = `📍 <b>Step 2 of 7 — Preferred Areas</b>\n\nSelect all sub-cities in Addis Ababa where you'd like to live.\nTap <b>"🌐 Select ALL Areas & Proceed"</b> or toggle individual areas below, then tap <b>Done Selecting ✅</b>`;

  if (messageId) {
    await editMessageText(chatId, messageId, text, { inline_keyboard: rows });
  } else {
    await sendMessage(chatId, text, { inline_keyboard: rows });
  }
}

async function sendBudgetStep(chatId: number) {
  await sendMessage(
    chatId,
    `💰 <b>Step 3 of 7 — Monthly Budget</b>\n\nWhat is your maximum monthly rent budget in Birr?\n\n<blockquote>Please type your budget amount as a number directly in chat (e.g. <code>8000</code> or <code>12000</code>):</blockquote>`
  );
}

async function sendMoveInStep(chatId: number) {
  await sendMessage(
    chatId,
    `📅 <b>Step 4 of 7 — Move-in Date</b>\n\n<blockquote>When are you looking to move in?</blockquote>`,
    {
      inline_keyboard: [
        [
          { text: '⚡ Immediately', callback_data: 'onboard_movein:Immediately' },
          { text: '🗓️ Within 2 Weeks', callback_data: 'onboard_movein:Within 2 Weeks' },
        ],
        [{ text: '📅 Next Month', callback_data: 'onboard_movein:Next Month' }],
      ],
    }
  );
}

async function sendTraitsStep(chatId: number) {
  await sendMessage(
    chatId,
    `🏠 <b>Step 5 of 7 — About You &amp; House Rules</b>\n\nTell us about your habits, lifestyle, or house rules.\n\n<blockquote><i>Example: Non-smoker, quiet, student, tidy, no late-night guests, etc.</i></blockquote>\n\nType your answer in chat below:`
  );
}

async function sendPhoneStep(chatId: number) {
  await sendMessage(
    chatId,
    `📞 <b>Step 6 of 7 — Phone Number</b>\n\nPlease share your phone number. Tap the button below or type it directly:`,
    {
      keyboard: [
        [{ text: '📱 Share My Contact', request_contact: true }],
      ],
      one_time_keyboard: true,
      resize_keyboard: true,
    }
  );
}

async function sendKycStep(chatId: number) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://spacematch1-flax.vercel.app';

  // Check if already verified
  try {
    const { data: user } = await supabaseAdmin
      .from('users')
      .select('fayda_status')
      .eq('telegram_id', chatId)
      .maybeSingle();

    if (user?.fayda_status === 'verified') {
      const { data: codeRow } = await supabaseAdmin.rpc('generate_display_code');
      const displayCode: string = codeRow || `RM${Date.now()}`;
      await updateProfile(chatId, {
        kyc_status: 'verified',
        status: 'active',
        onboarding_step: 'completed',
        display_code: displayCode,
      });

      await sendMessage(
        chatId,
        `🎉 <b>Profile Approved &amp; Live!</b>\n\nYour Fayda ID is verified, and listing <b>#${displayCode}</b> is active on the channel!`,
        {
          inline_keyboard: [
            [{ text: '⚡ Find Roommates · Matchmaker 🔍', callback_data: 'matchmaker_start' }],
            [{ text: '🏠 Main Menu', callback_data: 'nav_start' }],
          ],
        }
      );
      return;
    }
  } catch {}

  await sendMessage(
    chatId,
    `🔒 <b>Step 7 of 7 — Fayda ID Verification</b>\n\nSpaceMatch Addis requires all members to verify their identity.\n\n<blockquote>Scan the QR code on your Fayda card or digital slip using your camera in the Mini App for instant offline verification.</blockquote>`,
    {
      inline_keyboard: [
        [
          {
            text: '🛡️ Scan Fayda QR Code in Mini App ↗️',
            web_app: { url: `${appUrl}?startapp=verify_fayda` },
          },
        ],
      ],
    }
  );
}

// ─── Primary Entry Points ─────────────────────────────────────────────────────

/**
 * Handle inline button presses that belong to the onboarding flow.
 */
export async function handleOnboardingCallback(
  callbackQueryId: string,
  callbackData: string,
  chatId: number,
  telegramUsername?: string,
  messageId?: number
): Promise<void> {
  answerCallbackQuery(callbackQueryId).catch(() => {});

  // ── /start → begin onboarding ─────────────────────────────────────────────
  if (callbackData === 'onboard_start') {
    await getOrCreateProfile(chatId, telegramUsername);
    await sendGenderStep(chatId);
    return;
  }

  // ── Gender selection ──────────────────────────────────────────────────────
  if (callbackData.startsWith('onboard_gender:')) {
    const gender = callbackData.split(':')[1]; // 'male' | 'female'
    const normalised = gender.charAt(0).toUpperCase() + gender.slice(1);

    await updateProfile(chatId, {
      gender: normalised,
      onboarding_step: 'locations',
    });

    // Retrieve current profile to get empty locations list
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('locations')
      .eq('telegram_id', chatId)
      .single();

    await sendLocationsStep(chatId, profile?.locations ?? [], messageId);
    return;
  }

  // ── Select all locations & proceed ────────────────────────────────────────
  if (callbackData === 'onboard_select_all_locations') {
    await updateProfile(chatId, {
      locations: [...LOCATIONS],
      onboarding_step: 'budget',
    });
    await sendBudgetStep(chatId);
    return;
  }

  // ── Location toggle ───────────────────────────────────────────────────────
  if (callbackData.startsWith('onboard_location:')) {
    const loc = callbackData.split(':')[1];

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('locations')
      .eq('telegram_id', chatId)
      .single();

    const current: string[] = profile?.locations ?? [];
    const updated = current.includes(loc)
      ? current.filter((l) => l !== loc)
      : [...current, loc];

    await supabaseAdmin
      .from('profiles')
      .update({ locations: updated })
      .eq('telegram_id', chatId);

    await sendLocationsStep(chatId, updated, messageId);
    return;
  }

  // ── Locations done ────────────────────────────────────────────────────────
  if (callbackData === 'onboard_locations_done') {
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('locations')
      .eq('telegram_id', chatId)
      .single();

    if (!profile?.locations || profile.locations.length === 0) {
      // Default to all areas so user is never stuck repeating preferred areas
      await updateProfile(chatId, { locations: [...LOCATIONS], onboarding_step: 'budget' });
      await sendBudgetStep(chatId);
      return;
    }

    await updateProfile(chatId, { onboarding_step: 'budget' });
    await sendBudgetStep(chatId);
    return;
  }

  // ── Move-in date selection ────────────────────────────────────────────────
  if (callbackData.startsWith('onboard_movein:')) {
    const moveIn = callbackData.split(':').slice(1).join(':');
    await updateProfile(chatId, {
      move_in_date: moveIn,
      onboarding_step: 'traits',
    });
    await sendTraitsStep(chatId);
    return;
  }
}

/**
 * Handle text messages, contact shares, and photo uploads in the onboarding flow.
 * Returns true if the message was handled (so the webhook can return early).
 */
export async function handleOnboardingMessage(
  chatId: number,
  step: string,
  message: {
    message_id?: number;
    text?: string;
    contact?: { phone_number: string; first_name?: string; last_name?: string };
    photo?: { file_id: string; file_size?: number }[];
  },
  telegramUsername?: string
): Promise<boolean> {
  if (message.message_id) {
    deleteMessage(chatId, message.message_id).catch(() => {});
  }
  // ── Budget text input ─────────────────────────────────────────────────────
  if (step === 'budget') {
    const raw = (message.text || '').trim();
    const rangeMatch = raw.match(/(\d[\d,]*)[\s\-–—to]+(\d[\d,]*)/);

    let budgetMin = 0;
    let budgetMax = 0;

    if (rangeMatch) {
      budgetMin = parseInt(rangeMatch[1].replace(/,/g, ''), 10);
      budgetMax = parseInt(rangeMatch[2].replace(/,/g, ''), 10);
    } else {
      const parsed = parseNumericInput(raw);
      if (parsed && parsed > 0) {
        budgetMax = parsed;
        budgetMin = 0;
      }
    }

    if (budgetMax <= 0 || budgetMax > 1000000) {
      await sendMessage(
        chatId,
        `⚠️ <b>Please type a valid numerical monthly budget in ETB:</b>\n<i>(For example: <code>8000</code> or <code>12000</code>)</i>`
      );
      return true;
    }

    await updateProfile(chatId, {
      budget_min: budgetMin,
      budget_max: budgetMax,
      onboarding_step: 'move_in',
    });
    await sendMoveInStep(chatId);
    return true;
  }

  // ── Traits text input ─────────────────────────────────────────────────────
  if (step === 'traits') {
    const traits = (message.text || '').trim();
    if (!traits || traits.length < 5) {
      await sendMessage(chatId, `⚠️ Please describe your lifestyle in a few words (min 5 characters).`);
      return true;
    }
    await updateProfile(chatId, {
      roommate_traits: traits,
      onboarding_step: 'phone',
    });
    await sendPhoneStep(chatId);
    return true;
  }

  // ── Phone: contact share or text ─────────────────────────────────────────
  if (step === 'phone') {
    let phone: string | null = null;
    let fullName: string | null = null;

    if (message.contact) {
      phone = message.contact.phone_number;
      const parts = [message.contact.first_name, message.contact.last_name].filter(Boolean);
      fullName = parts.join(' ') || null;
    } else if (message.text) {
      const cleaned = message.text.replace(/\s+/g, '').replace(/^\+251/, '0');
      if (/^(0[97]\d{8}|\+251[97]\d{8})$/.test(message.text.replace(/\s+/g, ''))) {
        phone = cleaned;
      } else {
        await sendMessage(
          chatId,
          `⚠️ Please enter a valid Ethiopian phone number (e.g. <code>0912345678</code>) or tap the <b>Share My Contact</b> button.`
        );
        return true;
      }
    }

    if (!phone) return true;

    await updateProfile(chatId, {
      phone_number: phone,
      full_name: fullName,
      onboarding_step: 'kyc',
    });

    await sendKycStep(chatId);
    return true;
  }

  // ── KYC photo upload ──────────────────────────────────────────────────────
  if (step === 'kyc' && message.photo && message.photo.length > 0) {
    // Pick highest-resolution photo
    const bestPhoto = message.photo.reduce((a, b) =>
      (b.file_size ?? 0) > (a.file_size ?? 0) ? b : a
    );

    try {
      await sendMessage(chatId, `⏳ <b>Uploading your document securely...</b>`);

      // 1. Download from Telegram
      const fileBuffer = await getFile(bestPhoto.file_id);

      // 2. Upload to Supabase Storage (private bucket)
      const storagePath = `${chatId}/${Date.now()}.jpg`;
      const { error: uploadError } = await supabaseAdmin.storage
        .from('kyc-documents')
        .upload(storagePath, fileBuffer, {
          contentType: 'image/jpeg',
          upsert: true,
        });

      if (uploadError) {
        console.error('[onboarding] KYC upload failed:', uploadError.message);
        await sendMessage(
          chatId,
          `❌ <b>Upload failed.</b> Please try again by sending your ID photo.`
        );
        return true;
      }

      // 3. Generate display code and finalise profile
      const { data: codeRow } = await supabaseAdmin.rpc('generate_display_code');
      const displayCode: string = codeRow || `RM${Date.now()}`;

      const updatedProfile = await updateProfile(chatId, {
        kyc_doc_path: storagePath,
        kyc_status: 'pending',
        status: 'active',
        onboarding_step: 'completed',
        display_code: displayCode,
        telegram_username: telegramUsername || null,
      });

      if (!updatedProfile) {
        await sendMessage(chatId, `❌ Could not save your profile. Please try again later.`);
        return true;
      }

      // 4. Publish listing to the channel
      try {
        const channelMsgId = await publishListingToChannel(updatedProfile);
        await supabaseAdmin
          .from('profiles')
          .update({ channel_message_id: channelMsgId })
          .eq('telegram_id', chatId);
      } catch (publishErr) {
        console.error('[onboarding] Channel publish failed:', publishErr);
        // Non-fatal — profile is saved, just not posted yet
      }

      // 5. Confirmation message
      await sendMessage(
        chatId,
        `🎉 <b>Profile Approved &amp; Posted!</b>

Your listing <b>#${escapeHtml(displayCode)}</b> is now live on our channel. ✅

We will alert you here the moment someone wants to connect!

🔒 <i>Your contact details remain private until both parties match and verify payment.</i>`,
        {
          inline_keyboard: [
            [{ text: '📋 View My Listing', url: `https://t.me/${(process.env.NEXT_PUBLIC_BOT_USERNAME || 'Spacematchaddis_bot').replace('@', '')}` }],
          ],
        }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[onboarding] KYC handler error:', msg);
      await sendMessage(
        chatId,
        `❌ <b>Something went wrong.</b> Please send your ID photo again.`
      );
    }

    return true;
  }

  // Not handled by onboarding
  return false;
}

/**
 * Entry point when a new user sends /start with no parameters.
 * Checks if they already have a profile; if so, skip onboarding.
 * Returns the current onboarding step (or 'completed').
 */
export async function initiateOnboarding(
  chatId: number,
  telegramUsername?: string
): Promise<string> {
  const { data: existing } = await supabaseAdmin
    .from('profiles')
    .select('onboarding_step, status')
    .eq('telegram_id', chatId)
    .single();

  if (existing?.status === 'active' || existing?.status === 'matched') {
    return 'completed';
  }

  if (existing?.onboarding_step && existing.onboarding_step !== 'gender') {
    // Resume mid-flow
    await resumeOnboardingStep(chatId, existing.onboarding_step as OnboardingStep);
    return existing.onboarding_step;
  }

  // Fresh start
  await getOrCreateProfile(chatId, telegramUsername);
  await sendGenderStep(chatId);
  return 'gender';
}

/**
 * Re-sends the appropriate step prompt when resuming a mid-flow session.
 */
async function resumeOnboardingStep(chatId: number, step: OnboardingStep) {
  switch (step) {
    case 'gender':
      await sendGenderStep(chatId);
      break;
    case 'locations': {
      const { data: p } = await supabaseAdmin
        .from('profiles')
        .select('locations')
        .eq('telegram_id', chatId)
        .single();
      await sendLocationsStep(chatId, p?.locations ?? []);
      break;
    }
    case 'budget':
      await sendBudgetStep(chatId);
      break;
    case 'move_in':
      await sendMoveInStep(chatId);
      break;
    case 'traits':
      await sendTraitsStep(chatId);
      break;
    case 'phone':
      await sendPhoneStep(chatId);
      break;
    case 'kyc':
      await sendKycStep(chatId);
      break;
    default:
      break;
  }
}
