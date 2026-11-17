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

// ─── Profile In-Memory Cache ──────────────────────────────────────────────────
const _profileCache = new Map<number, any>();

// ─── Profile DB Helpers ───────────────────────────────────────────────────────

async function getOrCreateProfile(telegramId: number, username?: string): Promise<Profile | null> {
  const cached = _profileCache.get(telegramId);
  if (cached && cached.display_code) return cached as Profile;

  // Try to fetch existing
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

  _profileCache.set(telegramId, created as Profile);
  return created as Profile;
}

async function updateProfile(
  telegramId: number,
  updates: Record<string, unknown>
): Promise<Profile | null> {
  const cached = _profileCache.get(telegramId) || {};
  _profileCache.set(telegramId, { ...cached, ...updates } as Profile);

  const { data, error } = await supabaseAdmin
    .from('profiles')
    .update(updates)
    .eq('telegram_id', telegramId)
    .select('*')
    .maybeSingle();

  if (error) {
    console.error('[onboarding] Failed to update profile:', error.message);
    return null;
  }

  if (data) {
    _profileCache.set(telegramId, data as Profile);
  }

  // Keep bot_sessions table in sync with onboarding step (non-blocking)
  if (updates.onboarding_step) {
    saveSession({
      telegram_id: telegramId,
      step: String(updates.onboarding_step),
      draft_data: {},
      updated_at: new Date().toISOString(),
    }, false).catch(() => {});
  }

  return (data || _profileCache.get(telegramId)) as Profile;
}

// ─── Step UIs ─────────────────────────────────────────────────────────────────

async function sendGenderStep(chatId: number) {
  // Ensure the menu button is set to commands so mobile keyboards are completely unobstructed
  setChatMenuButton({ type: 'commands' }, chatId).catch(() => {});

  await sendMessage(
    chatId,
    `<b>Select Gender / ጾታዎን ይምረጡ</b>\n\n<blockquote>Please select your gender to personalize roommate matches.\nትክክለኛ የቤት አጋር ለማግኘት ጾታዎን ይምረጡ።</blockquote>`,
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
    `<b>Monthly Budget / ወርሃዊ በጀት</b>\n\n<blockquote>Enter your monthly rent budget in ETB.\nወርሃዊ የኪራይ በጀትዎን በብር ያስገቡ።\n\nExample / ምሳሌ: <code>8000 - 15000</code></blockquote>`
  );
}

async function sendMoveInStep(chatId: number) {
  await sendMessage(
    chatId,
    `<b>Move-in Timeline / የመግቢያ ቀን</b>\n\n<blockquote>When are you looking to move in?\nወደ ቤቱ መቼ ነው መግባት የሚፈልጉት?</blockquote>`,
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
    `<b>Lifestyle & Habits / አኗኗርና ልምዶች</b>\n\n<blockquote>Describe your lifestyle and roommate habits.\nስለ አኗኗርዎና የቤት ህጎችዎ አጭር መግለጫ ይስጡ።\n\nExample / ምሳሌ: Non-smoker, clean, quiet</blockquote>`
  );
}

async function sendPhoneStep(chatId: number) {
  await sendMessage(
    chatId,
    `<b>Contact Information / የስልክ ቁጥር</b>\n\n<blockquote>Tap the button below or type your phone number (e.g. <code>0912345678</code>).\nከታች ያለውን ቁልፍ ይጫኑ ወይም ስልክ ቁጥርዎን ይጻፉ።</blockquote>\n\nPrivacy Protected: Contact details remain sealed until mutual match. / ፈቃድ እስካልሰጡ ድረስ ስልክዎ ለማንም አይታይም።`,
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
        `<b>Listing Draft Ready / የማስታወቂያ ረቂቅ ተዘጋጅቷል</b>\n\n<blockquote><b>Draft Overview • Addis Ababa</b>\n• <b>Listing Code / ኮድ:</b> <code>#${displayCode}</code>\n• <b>Status / ሁኔታ:</b> <b>Verified & Live / የጸደቀ</b>\n• <b>Channel / ቻናል:</b> @spacematch_aa</blockquote>\n\nContacts remain private until mutual match. / ሁለታችሁም እስክትስማሙ ድረስ ስልክና መረጃ ሚስጥራዊ ነው።`,
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
    `<b>Fayda National ID Verification / የፋይዳ ብሔራዊ መታወቂያ ማረጋገጫ</b>\n\n<blockquote>To maintain a verified network, please upload a clear photo of your Fayda ID showing the official QR code.\nየተረጋገጠ ማህበረሰብ ለመገንባት፣ የፋይዳ መታወቂያዎን ይፋዊ QR ኮድ በግልጽ የሚያሳይ ፎቶ ይላኩ።</blockquote>\n\nVerified instantly via digital signature. Photos are never stored. / መረጃዎ በዲጂታል ፊርማ ወዲያው ይረጋገጣል፤ ፎቶዎች አይቀመጡም።`,
    {
      inline_keyboard: [
        [
          {
            text: 'Upload Fayda Photo / የፋይዳ ፎቶ ላክ',
            callback_data: 'dyn_upload_fayda',
          },
        ],
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

    const cached = _profileCache.get(chatId) || {};
    _profileCache.set(chatId, { ...cached, gender: normalised, onboarding_step: 'locations', locations: [] });

    updateProfile(chatId, {
      gender: normalised,
      onboarding_step: 'locations',
    }).catch((err) => console.error('[onboarding] gender update error:', err));

    await sendLocationsStep(chatId, [], messageId);
    return;
  }

  // ── Select all locations & proceed ────────────────────────────────────────
  if (callbackData === 'onboard_select_all_locations') {
    const cached = _profileCache.get(chatId) || {};
    _profileCache.set(chatId, { ...cached, locations: [...LOCATIONS], onboarding_step: 'budget' });

    updateProfile(chatId, {
      locations: [...LOCATIONS],
      onboarding_step: 'budget',
    }).catch((err) => console.error('[onboarding] select all error:', err));

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

    // Non-blocking background update to Supabase
    (async () => {
      await supabaseAdmin
        .from('profiles')
        .update({ locations: updated })
        .eq('telegram_id', chatId);
    })().catch((err: unknown) => console.error('[onboarding] location bg update error:', err));

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
    from?: { first_name?: string; last_name?: string; username?: string };
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

    if (!phone) return true;

    await updateProfile(chatId, {
      phone_number: phone,
      full_name: fullName,
      onboarding_step: 'kyc',
    });

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
        await sendMessage(chatId, `${verifyResult.messageEn}\n\n${verifyResult.messageAm}`);
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
        status: 'active',
        onboarding_step: 'completed',
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

      // 5. Publish listing to the channel
      try {
        const channelMsgId = await publishListingToChannel(updatedProfile);
        await supabaseAdmin
          .from('profiles')
          .update({ channel_message_id: channelMsgId })
          .eq('telegram_id', chatId);
      } catch (publishErr) {
        console.error('[onboarding] Channel publish failed:', publishErr);
      }

      // 6. Confirmation message
      await sendMessage(
        chatId,
        `<b>Listing Draft Ready / የማስታወቂያ ረቂቅ ተዘጋጅቷል</b>\n\n<blockquote><b>Draft Overview • Addis Ababa</b>\n• <b>Listing Code / ኮድ:</b> <code>#${escapeHtml(displayCode)}</code>\n• <b>Status / ሁኔታ:</b> <b>Verified & Live / የጸደቀ</b>\n• <b>Budget / በጀት:</b> <code>${updatedProfile.budget_min || 0} – ${updatedProfile.budget_max || 0} ETB</code>\n• <b>Areas / ሰፈሮች:</b> <code>${(updatedProfile.locations || []).join(', ') || 'Addis Ababa'}</code>\n• <b>Note:</b> "${escapeHtml(updatedProfile.roommate_traits || 'Roommate profile')}"</blockquote>\n\nContacts remain private until mutual match. / ሁለታችሁም እስክትስማሙ ድረስ ስልክና መረጃ ሚስጥራዊ ነው።`,
        {
          inline_keyboard: [
            [{ text: 'View on Channel / በቻናል ላይ እይ >', url: 'https://t.me/spacematch_aa' }],
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
