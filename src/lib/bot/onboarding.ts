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
import { BoundedLRUCache, getSession, saveSession, getUserMembershipStatus, getManagedChannels } from '@/lib/bot-session-store';
import {
  verifyFaydaPhotoUpload,
  extractMediaFileFromMessage,
  downloadTelegramFile,
  FAYDA_ERROR_GUIDANCE,
  applyVerifiedFayda,
} from '@/lib/bot/fayda-photo-verifier';
import {
  sendMessage,
  editMessageText,
  answerCallbackQuery,
  getFile,
  publishListingToChannel,
  escapeHtml,
  setChatMenuButton,
  parseNumericInput,
  parseBudgetRangeInput,
  deleteMessage,
  type Profile,
} from '@/lib/telegram';

// ─── Constants ────────────────────────────────────────────────────────────────

const LOCATIONS = [
  'Bole',
  'Kazanchis',
  'CMC',
  'Sarbet',
  'Megenagna',
  'Piassa',
  'Bisrate Gabriel',
  '4 Kilo',
  'Lideta',
  'Kirkos',
  'Arada',
  'Nifas Silk',
  'Akaki Kality',
];

const LOCATION_AMHARIC: Record<string, string> = {
  Bole: 'ቦሌ',
  Kazanchis: 'ካዛንቺስ',
  CMC: 'ሲኤምሲ',
  Sarbet: 'ሳርቤት',
  Megenagna: 'መገናኛ',
  Piassa: 'ፒያሳ',
  'Bisrate Gabriel': 'ብስራተ ገብርኤል',
  '4 Kilo': '4 ኪሎ',
  Lideta: 'ልደታ',
  Kirkos: 'ቂርቆስ',
  Arada: 'አራዳ',
  'Nifas Silk': 'ንፋስ ስልክ',
  'Akaki Kality': 'አቃቂ ቃሊቲ',
};

const ONBOARDING_STEPS = [
  'gender',
  'locations',
  'budget',
  'move_in',
  'traits',
  'phone',
  'kyc',
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

// ─── Profile In-Memory Cache (Bounded LRU) ─────────────────────────────────────
const _profileCache = new BoundedLRUCache<number, any>(2000, 30 * 1000);

// ─── Profile DB Helpers ───────────────────────────────────────────────────────

async function getOrCreateProfile(telegramId: number, username?: string): Promise<Profile | null> {
  // Always read latest from DB to avoid cross-Lambda staleness
  const { data: existing } = await supabaseAdmin
    .from('profiles')
    .select('*')
    .eq('telegram_id', telegramId)
    .maybeSingle();

  if (existing) {
    _profileCache.set(telegramId, existing as Profile);
    return existing as Profile;
  }

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

  await saveSession({
    telegram_id: telegramId,
    step: 'gender',
    draft_data: { ...(getSession(telegramId).draft_data || {}) },
    updated_at: new Date().toISOString(),
  }, true);

  _profileCache.set(telegramId, created as Profile);
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
    .maybeSingle();

  if (error || !data) {
    console.error('[onboarding] Failed to update profile:', error?.message || 'No matching row');
    return null;
  }

  _profileCache.set(telegramId, data as Profile);

  // Keep bot_sessions table in sync with onboarding step while preserving existing draft_data (e.g. lang)
  if (updates.onboarding_step) {
    const existingSession = getSession(telegramId);
    const nextStep = String(updates.onboarding_step) === 'completed' ? 'idle' : String(updates.onboarding_step);
    await saveSession({
      telegram_id: telegramId,
      step: nextStep,
      draft_data: existingSession.draft_data || {},
      updated_at: new Date().toISOString(),
    }, true);
  }

  return data as Profile;
}

// ─── Step UIs ─────────────────────────────────────────────────────────────────

async function sendGenderStep(chatId: number) {
  // Ensure the menu button is set to commands so mobile keyboards are completely unobstructed
  setChatMenuButton({ type: 'commands' }, chatId).catch(() => {});

  await sendMessage(
    chatId,
    `<b>Select Gender / ጾታዎን ይምረጡ</b>

<blockquote>Select your gender.
ጾታዎን ይምረጡ:</blockquote>`,
    {
      inline_keyboard: [
        [
          { text: 'Male / ወንድ', callback_data: 'onboard_gender:male' },
          { text: 'Female / ሴት', callback_data: 'onboard_gender:female' },
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
        ? '✅ All Areas Selected / ሁሉም ተመርጠዋል >'
        : 'Select All Areas / ሁሉንም ምረጥ >',
      callback_data: 'onboard_select_all_locations',
    },
  ]);

  for (let i = 0; i < LOCATIONS.length; i += 2) {
    const row = [];
    const loc1 = LOCATIONS[i];
    const sel1 = selectedLocations.includes(loc1);
    const am1 = LOCATION_AMHARIC[loc1] || loc1;
    row.push({
      text: `${sel1 ? '✅ ' : ''}${loc1} (${am1})`,
      callback_data: `onboard_location:${loc1}`,
    });
    if (i + 1 < LOCATIONS.length) {
      const loc2 = LOCATIONS[i + 1];
      const sel2 = selectedLocations.includes(loc2);
      const am2 = LOCATION_AMHARIC[loc2] || loc2;
      row.push({
        text: `${sel2 ? '✅ ' : ''}${loc2} (${am2})`,
        callback_data: `onboard_location:${loc2}`,
      });
    }
    rows.push(row);
  }

  rows.push([
    {
      text: `Proceed to Budget / በጀት ወስን (${selectedLocations.length}) >`,
      callback_data: 'onboard_locations_done',
    },
  ]);

  const text = `<b>Preferred Sub-cities / ተመራጭ ሰፈሮች</b>\n\n<blockquote>Tap locations to toggle your preferred zones in Addis Ababa.\nየሚመርጧቸውን ሰፈሮች ይጫኑ።</blockquote>`;

  if (messageId) {
    await editMessageText(chatId, messageId, text, { inline_keyboard: rows });
  } else {
    await sendMessage(chatId, text, { inline_keyboard: rows });
  }
}

async function sendBudgetStep(chatId: number) {
  await sendMessage(
    chatId,
    `<b>Monthly Budget / ወርሃዊ በጀት</b>

<blockquote>Enter monthly budget in ETB (e.g. <code>8000 - 15000</code>).
ወርሃዊ የኪራይ በጀትዎን በብር ያስገቡ:</blockquote>`
  );
}

async function sendMoveInStep(chatId: number) {
  await sendMessage(
    chatId,
    `<b>Move-in Timeline / የመግቢያ ቀን</b>

<blockquote>When are you looking to move in?
መቼ መግባት ይፈልጋሉ?</blockquote>`,
    {
      inline_keyboard: [
        [
          { text: 'Immediately / ወዲያውኑ', callback_data: 'onboard_movein:Immediately' },
          { text: 'Within 2 Weeks / በ2 ሳምንት ውስጥ', callback_data: 'onboard_movein:Within 2 Weeks' },
        ],
        [{ text: 'Next Month / በሚቀጥለው ወር', callback_data: 'onboard_movein:Next Month' }],
      ],
    }
  );
}

async function sendTraitsStep(chatId: number) {
  await sendMessage(
    chatId,
    `<b>Lifestyle & Habits / አኗኗርና ልምዶች</b>

<blockquote>Describe your habits (e.g. clean, quiet, non-smoker).
ስለ አኗኗርዎ በአጭሩ ይግለጹ (ምሳሌ: ጽዱ፣ ጨዋ):</blockquote>`
  );
}

async function sendPhoneStep(chatId: number) {
  await sendMessage(
    chatId,
    `<b>Phone Number / ስልክ ቁጥር</b>

<blockquote>Tap below to share or enter phone (09...).
ከታች ይጫኑ ወይም ስልክ ቁጥርዎን ያስገቡ:</blockquote>`,
    {
      keyboard: [
        [{ text: 'Share My Contact / ስልክ ቁጥሬን አጋራ', request_contact: true }],
      ],
      one_time_keyboard: true,
      resize_keyboard: true,
    }
  );
}

async function sendKycStep(chatId: number) {
  // [DISABLED - Mini App not ready] const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://spacematch1-flax.vercel.app';

  // Check if already verified
  try {
    const { data: user } = await supabaseAdmin
      .from('users')
      .select('fayda_status, fayda_id_number')
      .eq('telegram_id', chatId)
      .maybeSingle();

    if (user?.fayda_status === 'verified' && user?.fayda_id_number) {
      const { data: codeRow } = await supabaseAdmin.rpc('generate_display_code');
      const displayCode: string = codeRow || `RM${Date.now()}`;
      const memStatus = await getUserMembershipStatus(chatId);
      const savedProf = await updateProfile(chatId, {
        kyc_status: 'verified',
        status: memStatus.isActive ? 'active' : 'paused',
        onboarding_step: 'completed',
        display_code: displayCode,
      });

      if (!memStatus.isActive) {
        const currentSess = getSession(chatId);
        await saveSession({
          telegram_id: chatId,
          step: 'idle',
          draft_data: {
            ...(currentSess.draft_data || {}),
            membership_purpose: 'post_channel',
            membership_metadata: { ...(savedProf || {}), display_code: displayCode },
          },
          updated_at: new Date().toISOString(),
        }, true);

        await sendMessage(
          chatId,
          `<b>Fayda ID Verified! / የፋይዳ መታወቂያዎ ተረጋግጧል!</b>\n\n<blockquote>Your profile (<code>#${escapeHtml(displayCode)}</code>) is saved! Activate your <b>3-Month Membership Pass (100 ETB)</b> to submit for channel review and send unlimited roommate requests.\n\nመረጃዎ (<code>#${escapeHtml(displayCode)}</code>) ተመዝግቧል! ወደ ቻናሉ ለመላክ የ<b>3 ወር አባልነት (100 ETB)</b> ያግብሩ።</blockquote>`,
          {
            inline_keyboard: [
              [{ text: 'Activate 3-Month Pass (100 ETB) / አባልነት ክፈት >', callback_data: 'view_membership_pass' }],
              [{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }],
            ],
          }
        );
        return;
      }

      await sendMessage(
        chatId,
        `<b>Profile Ready / መረጃዎ ተዘጋጅቷል</b>\n\n<blockquote><b>Listing Overview • Addis Ababa</b>\n• <b>Listing Code / ኮድ:</b> <code>#${escapeHtml(displayCode)}</code>\n• <b>Status / ሁኔታ:</b> <b>Verified Resident / የተረጋገጠ</b></blockquote>\n\nContacts remain private until mutual match. / ሁለታችሁም እስክትስማሙ ድረስ ስልክና መረጃ ሚስጥራዊ ነው።`,
        {
          inline_keyboard: [
            [{ text: 'Find Roommates / የቤት አጋር ፈልግ', callback_data: 'matchmaker_start' }],
            [{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }],
          ],
        }
      );
      return;
    }
  } catch {}

  await sendMessage(
    chatId,
    `<b>Fayda ID Verification / የፋይዳ ማረጋገጫ</b>

<blockquote>Send a clear photo of the back of your Fayda card showing the QR code right here in chat.
የQR ኮዱ የሚታይበትን የመታወቂያዎን ጀርባ ፎቶ እዚሁ ይላኩ።</blockquote>`,
    {
      inline_keyboard: [
        [
          {
            text: 'Why Fayda ID? / ለምን ፋይዳ አስፈለገ?',
            callback_data: 'why_fayda_id',
          },
        ],
        [
          {
            text: 'Main Menu / ዋና ማውጫ',
            callback_data: 'nav_start',
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
  _callbackQueryId: string,
  callbackData: string,
  chatId: number,
  telegramUsername?: string,
  messageId?: number
): Promise<void> {
  // Callback query is already answered in webhook handler before routing

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

    const cached = _profileCache.get(chatId) || {};
    _profileCache.set(chatId, { ...cached, gender: normalised, onboarding_step: 'locations', locations: [] });

    await updateProfile(chatId, {
      gender: normalised,
      onboarding_step: 'locations',
    });

    await sendLocationsStep(chatId, [], messageId);
    return;
  }

  // ── Select all locations & proceed ────────────────────────────────────────
  if (callbackData === 'onboard_select_all_locations') {
    const cached = _profileCache.get(chatId) || {};
    _profileCache.set(chatId, { ...cached, locations: [...LOCATIONS], onboarding_step: 'budget' });

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

    let cached = _profileCache.get(chatId);
    let current: string[] = cached?.locations ?? [];

    if (!cached || !cached.locations) {
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('locations')
        .eq('telegram_id', chatId)
        .maybeSingle();
      current = profile?.locations ?? [];
    }

    const updated = current.includes(loc)
      ? current.filter((l) => l !== loc)
      : [...current, loc];

    _profileCache.set(chatId, { ...cached, locations: updated });

    await supabaseAdmin
      .from('profiles')
      .update({ locations: updated })
      .eq('telegram_id', chatId);

    await sendLocationsStep(chatId, updated, messageId);
    return;
  }

  // ── Locations done ────────────────────────────────────────────────────────
  if (callbackData === 'onboard_locations_done') {
    let cached = _profileCache.get(chatId);
    let current = cached?.locations;
    if (!current) {
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('locations')
        .eq('telegram_id', chatId)
        .maybeSingle();
      current = profile?.locations ?? [];
    }

    if (!current || current.length === 0) {
      current = [...LOCATIONS];
      _profileCache.set(chatId, { ...cached, locations: current, onboarding_step: 'budget' });
      await updateProfile(chatId, { locations: current, onboarding_step: 'budget' });
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
    caption?: string;
    from?: { first_name?: string; last_name?: string; username?: string };
    contact?: { phone_number: string; user_id?: number; first_name?: string; last_name?: string };
    photo?: { file_id: string; file_size?: number }[];
    document?: { file_id: string; file_size?: number; mime_type?: string; file_name?: string };
  },
  telegramUsername?: string
): Promise<boolean> {
  if (message.text && message.text.startsWith('/')) {
    return false;
  }
  if (message.message_id) {
    deleteMessage(chatId, message.message_id).catch(() => {});
  }
  if (step === 'gender' || step === 'locations' || step === 'move_in') {
    await sendMessage(
      chatId,
      `<b>Please tap a button above / እባክዎ ከላይ ያሉትን ቁልፎች ይጠቀሙ</b>\n\n<blockquote>Select your option using the interactive buttons.\nምርጫዎን ከላይ ካሉት ቁልፎች ውስጥ ይምረጡ።</blockquote>`
    );
    return true;
  }
  // ── Budget text input ─────────────────────────────────────────────────────
  if (step === 'budget') {
    const raw = (message.text || '').trim();
    const parsedRange = parseBudgetRangeInput(raw);

    if (!parsedRange || parsedRange.max <= 0) {
      await sendMessage(
        chatId,
        `<b>Invalid Budget Range / የተሳሳተ የበጀት መጠን</b>\n\n<blockquote>Please enter a valid monthly budget range in ETB.\nእባክዎ ትክክለኛ ወርሃዊ የኪራይ መጠን በብር ያስገቡ።\n\nExample / ምሳሌ: <code>8000 - 14000</code></blockquote>`
      );
      return true;
    }

    await updateProfile(chatId, {
      budget_min: parsedRange.min,
      budget_max: parsedRange.max,
      onboarding_step: 'move_in',
    });
    await sendMoveInStep(chatId);
    return true;
  }

  // ── Traits text input ─────────────────────────────────────────────────────
  if (step === 'traits') {
    const traits = (message.text || '').trim();
    if (!traits || traits.length < 5) {
      await sendMessage(
        chatId,
        `<b>More Details Required / ተጨማሪ መረጃ ያስፈልጋል</b>\n\n<blockquote>Please describe your lifestyle in a few words (min 5 characters).\nእባክዎ ስለ ባህሪዎ ወይም አኗኗርዎ በጥቂት ቃላት ይግለጹ (ቢያንስ 5 ፊደላት)።</blockquote>`
      );
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
      if (message.contact.user_id && Number(message.contact.user_id) !== chatId) {
        await sendMessage(
          chatId,
          `<b>Own Contact Required / የራስዎን ስልክ ይላኩ</b>\n\n<blockquote>Please tap the "Share My Contact" button below or type your own phone number.\nእባክዎ የራስዎን ስልክ ቁጥር በመላክ ያረጋግጡ።</blockquote>`
        );
        return true;
      }
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
          `<b>Invalid Phone Number / የተሳሳተ ስልክ ቁጥር</b>\n\n<blockquote>Please enter a valid phone number (e.g. <code>0912345678</code>) or tap the button below.\nእባክዎ ትክክለኛ ስልክ ቁጥር ያስገቡ (ምሳሌ፡ <code>0912345678</code>) ወይም ከታች ያለውን ቁልፍ ይጫኑ።</blockquote>`
        );
        return true;
      }
    }

    if (!phone) {
      await sendMessage(
        chatId,
        `<b>Phone Number Required / ስልክ ቁጥር ያስፈልጋል</b>\n\n<blockquote>Please type your phone number (e.g. <code>0912345678</code>) or tap Share Contact.\nእባክዎ ስልክ ቁጥርዎን ይላኩ።</blockquote>`
      );
      return true;
    }

    const phoneUpdates: Record<string, unknown> = {
      phone_number: phone,
      onboarding_step: 'kyc',
    };
    if (fullName) phoneUpdates.full_name = fullName;
    await updateProfile(chatId, phoneUpdates);

    await sendKycStep(chatId);
    return true;
  }

  // ── KYC photo & document upload (In-memory extraction only - 0 bytes saved to storage) ──
  const kycMedia = extractMediaFileFromMessage(message);

  // Reject any non-media message during KYC with bilingual guidance
  if (step === 'kyc' && !kycMedia) {
    const guidance = FAYDA_ERROR_GUIDANCE.MANUAL_TEXT_ENTERED;
    await sendMessage(chatId, `${guidance.en}\n\n${guidance.am}`);
    return true;
  }

  if (step === 'kyc' && kycMedia) {
    if ('error' in kycMedia) {
      await sendMessage(chatId, `${kycMedia.messageEn}\n\n${kycMedia.messageAm}`);
      return true;
    }

    try {
      await sendMessage(
        chatId,
        `<b>Processing Identity Document in Memory... / ሰነዱ እየተመረመረ ነው...</b>\n\n<blockquote>Validating official cryptographic signature... Zero images are saved to storage.\nይፋዊ ዲጂታል ፊርማው እየተረጋገጠ ነው... ፎቶው በሲስተሙ ውስጥ አይቀመጥም።</blockquote>`
      );

      // 1. Download into RAM buffer (Zero persistent storage)
      const fileBuffer = await downloadTelegramFile(kycMedia.fileId);

      // 2. Decode & verify cryptographically
      const verifyResult = await verifyFaydaPhotoUpload(fileBuffer, chatId);

      if (!verifyResult.success) {
        await sendMessage(chatId, verifyResult.message || `${verifyResult.messageEn}\n\n${verifyResult.messageAm}`);
        return true;
      }

      // 3. Persist verified status across users, profiles, roommate_profiles
      await applyVerifiedFayda(chatId, verifyResult, message.from);

      // 4. Generate display code and finalize profile
      const { data: codeRow } = await supabaseAdmin.rpc('generate_display_code');
      const displayCode: string = codeRow || `RM${Date.now()}`;

      const updatedProfile = await updateProfile(chatId, {
        kyc_doc_path: null, // ZERO STORAGE: Free tier database safe (no images stored)
        kyc_status: 'verified',
        status: 'paused',
        onboarding_step: 'pending_approval',
        display_code: displayCode,
        telegram_username: telegramUsername || null,
        full_name: verifyResult.fullName || undefined,
      });

      if (!updatedProfile) {
        await sendMessage(
          chatId,
          `<b>Could Not Save Profile / መረጃውን ማስቀመጥ አልተቻለም</b>\n\n<blockquote>Please try again later or contact the coordinator.\nእባክዎ ትንሽ ቆይተው እንደገና ይሞክሩ ወይም አስተዳዳሪውን ያነጋግሩ።</blockquote>`
        );
        return true;
      }

      // 5. Enforce 100 ETB 3-Month Membership Pass before public channel broadcast (Invariant 7 & 8)
      const memStatus = await getUserMembershipStatus(chatId);
      const channels = await getManagedChannels();
      const activeCh = channels.find((c) => c.is_active);
      const rawChRef = String(activeCh?.channel_username || activeCh?.channel_id || process.env.TELEGRAM_CHANNEL_ID || '@Spacematch_Addis').trim();
      const chUrl = rawChRef.startsWith('-100')
        ? `https://t.me/c/${rawChRef.slice(4)}`
        : /^-\d+$/.test(rawChRef)
        ? ''
        : `https://t.me/${rawChRef.replace(/^@/, '')}`;

      if (!memStatus.isActive) {
        const currentSess = getSession(chatId);
        await saveSession({
          telegram_id: chatId,
          step: 'idle',
          draft_data: {
            ...(currentSess.draft_data || {}),
            membership_purpose: 'post_channel',
            membership_metadata: { ...updatedProfile, display_code: displayCode },
          },
          updated_at: new Date().toISOString(),
        }, true);

        await sendMessage(
          chatId,
          `<b>Fayda ID Verified! / የፋይዳ መታወቂያዎ ተረጋግጧል!</b>\n\n<blockquote>Your profile (<code>#${escapeHtml(displayCode)}</code>) is saved! Activate your <b>3-Month Membership Pass (100 ETB)</b> to submit for channel broadcast or send unlimited roommate connection requests.\n\nመረጃዎ (<code>#${escapeHtml(displayCode)}</code>) ተመዝግቧል! ወደ ቻናሉ ለመለጠፍ እና የግንኙነት ጥያቄዎችን ለመላክ የ<b>3 ወር አባልነት (100 ETB)</b> ያግብሩ።</blockquote>`,
          {
            inline_keyboard: [
              [{ text: 'Activate 3-Month Pass (100 ETB) / አባልነት ክፈት >', callback_data: 'view_membership_pass' }],
              [{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }],
            ],
          }
        );
        return true;
      }

      let publishedMsgId: number | null = null;
      try {
        publishedMsgId = await publishListingToChannel(updatedProfile);
        await supabaseAdmin
          .from('profiles')
          .update({ status: 'active', onboarding_step: 'completed', channel_message_id: publishedMsgId })
          .eq('telegram_id', chatId);
      } catch (publishErr) {
        console.error('[onboarding] Channel publish failed:', publishErr);
      }

      // 6. Confirmation message
      await sendMessage(
        chatId,
        `<b>Listing Live / ማስታወቂያዎ ተለጥፏል</b>\n\n<blockquote><b>Listing Overview • Addis Ababa</b>\n• <b>Listing Code / ኮድ:</b> <code>#${escapeHtml(displayCode)}</code>\n• <b>Status / ሁኔታ:</b> <b>${publishedMsgId ? 'Verified & Live / የጸደቀ' : 'Pending Review / በግምገማ ላይ'}</b>\n• <b>Budget / በጀት:</b> <b>${updatedProfile.budget_min || 0} – ${updatedProfile.budget_max || 0} ETB</b>\n• <b>Areas / ሰፈሮች:</b> <b>${(updatedProfile.locations || []).join(', ') || 'Addis Ababa'}</b>\n• <b>Note:</b> "${escapeHtml(updatedProfile.roommate_traits || 'Roommate profile')}"</blockquote>\n\nContacts remain private until mutual match. / ሁለታችሁም እስክትስማሙ ድረስ ስልክና መረጃ ሚስጥራዊ ነው።`,
        {
          inline_keyboard: [
            ...(chUrl ? [[{ text: 'View on Channel / በቻናል ላይ እይ >', url: chUrl }]] : []),
            [{ text: 'Find Roommates / የቤት አጋር ፈልግ', callback_data: 'matchmaker_start' }],
            [{ text: 'Main Menu / ዋና ማውጫ', callback_data: 'nav_start' }],
          ],
        }
      );
      return true;
    } catch (err: any) {
      console.error('[onboarding] KYC handler error:', err);
      await sendMessage(
        chatId,
        `<b>Verification Error / የማረጋገጫ ስህተት</b>\n\n<blockquote>Could not process the uploaded file. Please try again with a clear photo of the QR code on the back of your Fayda ID card.\nየተላከውን ሰነድ ማንበብ አልተቻለም። እባክዎ የQR ኮዱ በግልጽ የሚታይበትን የመታወቂያዎን ጀርባ ፎቶ ይላኩ።</blockquote>`
      );
      return true;
    }
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
      let locs = _profileCache.get(chatId)?.locations;
      if (!locs) {
        const { data: p } = await supabaseAdmin
          .from('profiles')
          .select('locations')
          .eq('telegram_id', chatId)
          .maybeSingle();
        locs = p?.locations ?? [];
      }
      await sendLocationsStep(chatId, locs);
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
