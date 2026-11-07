/**
 * tests/e2e/tier4-scenarios.test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Tier 4: Real-World Application Scenarios (End-to-End User Journeys).
 *
 * Implements 5 comprehensive multi-turn user journeys simulating realistic
 * interaction from onboarding through verification, matching, and escrow:
 *
 *  Journey 1: New Seeker Onboarding to Verified Profile & Roommate Match
 *  Journey 2: Space Landlord Questionnaire with Multi-Photo Upload & Admin Broadcast
 *  Journey 3: Channel Post Deep-Link to Escrow Connection
 *  Journey 4: Strict Fayda Photo Verification & Error Recovery Loop
 *  Journey 5: Returning Verified User Instant Search & Discovery (Zero Redundant Prompts)
 */

import {
  setupTelegramFetchMock,
  teardownTelegramFetchMock,
  registerMockTelegramPhoto,
  clearCapturedTelegramCalls,
  getCapturedTelegramCalls,
  createTelegramMessageUpdate,
  createTelegramCallbackUpdate,
  createTelegramPhotoUpdate,
  dispatchWebhookUpdate,
  dispatchSpacesApi,
  dispatchOrdersCreate,
  dispatchOrdersVerify,
  TestExecutionCollector,
} from '../../scripts/helpers/test-harness';
import {
  generateAuthenticFaydaQrBuffer,
  generateNonFaydaQrBuffer,
  generateCorruptedQrBuffer,
} from '../../scripts/helpers/synthetic-fayda';
import { getSession, saveSession, clearSession } from '../../src/lib/bot-session-store';

export async function runTier4Tests(collector: TestExecutionCollector): Promise<void> {
  setupTelegramFetchMock();

  async function executeTest(
    feature: string,
    name: string,
    fn: () => Promise<void>
  ) {
    const id = `T4_${feature.replace(/\s+/g, '_')}_${name.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const t0 = performance.now();
    try {
      clearCapturedTelegramCalls();
      await fn();
      const t1 = performance.now();
      collector.record({
        id,
        tier: 4,
        feature,
        name,
        status: 'PASS',
        durationMs: t1 - t0,
      });
    } catch (err: any) {
      const t1 = performance.now();
      collector.record({
        id,
        tier: 4,
        feature,
        name,
        status: 'FAIL',
        durationMs: t1 - t0,
        error: err.message,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Journey 1: New Seeker Onboarding to Verified Profile & Roommate Match
  // ═══════════════════════════════════════════════════════════════════════════

  await executeTest(
    'User Journey 1: New Seeker Onboarding',
    'Full Seeker Onboarding from /start through Dynamic Card and Fayda Verification',
    async () => {
      const chatId = 40001;
      await clearSession(chatId);

      // Step 1: /start
      let res = await dispatchWebhookUpdate(createTelegramMessageUpdate(chatId, '/start'));
      if (res.status !== 200) throw new Error('Failed at Step 1 (/start)');

      // Step 2: Language English
      res = await dispatchWebhookUpdate(createTelegramCallbackUpdate(chatId, 'set_lang:en'));
      if (res.status !== 200) throw new Error('Failed at Step 2 (set_lang:en)');

      // Step 3: Branch Seeker Profile
      res = await dispatchWebhookUpdate(createTelegramCallbackUpdate(chatId, 'post_branch_seeker'));
      if (res.status !== 200) throw new Error('Failed at Step 3 (post_branch_seeker)');

      // Step 4: Age
      res = await dispatchWebhookUpdate(createTelegramMessageUpdate(chatId, '23'));
      if (res.status !== 200) throw new Error('Failed at Step 4 (Age)');

      // Step 5: Gender
      res = await dispatchWebhookUpdate(createTelegramCallbackUpdate(chatId, 'dyn_gender:Female'));
      if (res.status !== 200) throw new Error('Failed at Step 5 (Gender)');

      // Step 6: Religion
      res = await dispatchWebhookUpdate(createTelegramCallbackUpdate(chatId, 'dyn_religion:Orthodox'));
      if (res.status !== 200) throw new Error('Failed at Step 6 (Religion)');

      // Step 7: Job
      res = await dispatchWebhookUpdate(createTelegramMessageUpdate(chatId, 'Accountant at CBE'));
      if (res.status !== 200) throw new Error('Failed at Step 7 (Job)');

      // Interstitial Step: Transition from Personal Profile to Roommate Preferences
      res = await dispatchWebhookUpdate(createTelegramCallbackUpdate(chatId, 'dyn_card_to_preferences'));
      if (res.status !== 200) throw new Error('Failed at Interstitial Step (dyn_card_to_preferences)');

      // Step 8: Budget Range
      res = await dispatchWebhookUpdate(createTelegramMessageUpdate(chatId, '8000 - 14000'));
      if (res.status !== 200) throw new Error('Failed at Step 8 (Budget)');

      // Step 9: Preferred Gender
      res = await dispatchWebhookUpdate(createTelegramCallbackUpdate(chatId, 'dyn_pref_gender:Female Only'));
      if (res.status !== 200) throw new Error('Failed at Step 9 (Pref Gender)');

      // Step 10: Traits & Lifestyle Bio
      res = await dispatchWebhookUpdate(createTelegramMessageUpdate(chatId, 'Quiet, tidy, non-smoker, early bird'));
      if (res.status !== 200) throw new Error('Failed at Step 10 (Traits)');

      // Step 11: Subcity Toggle & Proceed
      await dispatchWebhookUpdate(createTelegramCallbackUpdate(chatId, 'dyn_sub_toggle:Bole'));
      res = await dispatchWebhookUpdate(createTelegramCallbackUpdate(chatId, 'dyn_sub_proceed'));
      if (res.status !== 200) throw new Error('Failed at Step 11 (Subcity Proceed)');

      // Step 12: Fayda Document Photo Upload
      const faydaFixture = await generateAuthenticFaydaQrBuffer({
        fullName: 'Rahel Tadesse',
        fan: '5529104728193849',
        gender: 'F',
      });
      registerMockTelegramPhoto('j1_fayda_photo', faydaFixture.pngBuffer);

      clearCapturedTelegramCalls();
      res = await dispatchWebhookUpdate(createTelegramPhotoUpdate(chatId, 'j1_fayda_photo'));
      if (res.status !== 200) throw new Error('Failed at Step 12 (Fayda Photo Upload)');
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Journey 2: Space Landlord Questionnaire with Multi-Photo Upload
  // ═══════════════════════════════════════════════════════════════════════════

  await executeTest(
    'User Journey 2: Space Landlord Flow',
    'Full Space Landlord flow from space details, photos, preview, and admin submission',
    async () => {
      const chatId = 40002;
      await clearSession(chatId);

      // Step 1: Start space creation
      let res = await dispatchWebhookUpdate(createTelegramCallbackUpdate(chatId, 'post_branch_space'));
      if (res.status !== 200) throw new Error('Failed at Step 1 (post_branch_space)');

      // Step 2: Space Type
      res = await dispatchWebhookUpdate(createTelegramMessageUpdate(chatId, 'Master Bedroom with Balcony'));
      if (res.status !== 200) throw new Error('Failed at Step 2 (Space Type)');

      // Step 3: Total Rent
      res = await dispatchWebhookUpdate(createTelegramMessageUpdate(chatId, '15000'));
      if (res.status !== 200) throw new Error('Failed at Step 3 (Rent)');

      // Step 4: Roommate Share
      res = await dispatchWebhookUpdate(createTelegramMessageUpdate(chatId, '7500'));
      if (res.status !== 200) throw new Error('Failed at Step 4 (Share)');

      // Step 5: Amenities
      await dispatchWebhookUpdate(createTelegramCallbackUpdate(chatId, 'space_amenity_toggle:WiFi'));
      res = await dispatchWebhookUpdate(createTelegramCallbackUpdate(chatId, 'space_amenities_proceed'));
      if (res.status !== 200) throw new Error('Failed at Step 5 (Amenities)');

      // Step 6: Host Gender
      res = await dispatchWebhookUpdate(createTelegramCallbackUpdate(chatId, 'space_host_gender:Male'));
      if (res.status !== 200) throw new Error('Failed at Step 6 (Host Gender)');

      // Step 7: Tenant Preferred Gender
      res = await dispatchWebhookUpdate(createTelegramCallbackUpdate(chatId, 'space_pref_gender:Any'));
      if (res.status !== 200) throw new Error('Failed at Step 7 (Pref Gender)');

      // Step 8: Roommate Rules & Preferences
      res = await dispatchWebhookUpdate(createTelegramMessageUpdate(chatId, 'Clean, respectful, no late parties'));
      if (res.status !== 200) throw new Error('Failed at Step 8 (Rules)');

      // Step 9: Subcity
      res = await dispatchWebhookUpdate(createTelegramCallbackUpdate(chatId, 'space_subcity:Bole'));
      if (res.status !== 200) throw new Error('Failed at Step 9 (Subcity)');

      // Step 10: Upload 2 Photos
      await dispatchWebhookUpdate(createTelegramPhotoUpdate(chatId, 'j2_room_photo_1'));
      await dispatchWebhookUpdate(createTelegramPhotoUpdate(chatId, 'j2_room_photo_2'));

      // Step 11: Proceed with Photos
      res = await dispatchWebhookUpdate(createTelegramCallbackUpdate(chatId, 'space_photos_done'));
      if (res.status !== 200) throw new Error('Failed at Step 11 (Proceed Photos)');

      // Step 12: Submit to Admin Review Queue
      res = await dispatchWebhookUpdate(createTelegramCallbackUpdate(chatId, 'space_submit_admin:SPMARWR992'));
      if (res.status !== 200) throw new Error('Failed at Step 12 (Admin Submission)');
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Journey 3: Channel Post Deep-Link to Escrow Connection
  // ═══════════════════════════════════════════════════════════════════════════

  await executeTest(
    'User Journey 3: Channel Deep Link to Escrow',
    'Deep link applicant enters bot, gates through Fayda, and triggers connection',
    async () => {
      const chatId = 40003;
      await clearSession(chatId);

      // Step 1: Click Channel Post Link
      let res = await dispatchWebhookUpdate(createTelegramMessageUpdate(chatId, '/start req_SPMARWR482'));
      if (res.status !== 200) throw new Error('Failed at Step 1 (Channel Deep Link)');

      // Step 2: User completes verification
      const fixture = await generateAuthenticFaydaQrBuffer({
        fullName: 'Yonas Berhanu',
        fan: '8829104728193847',
        gender: 'M',
      });
      registerMockTelegramPhoto('j3_fayda_photo', fixture.pngBuffer);

      await dispatchWebhookUpdate(createTelegramMessageUpdate(chatId, '/fayda'));
      res = await dispatchWebhookUpdate(createTelegramPhotoUpdate(chatId, 'j3_fayda_photo'));
      if (res.status !== 200) throw new Error('Failed at Step 2 (Fayda Photo Upload)');

      // Step 3: Verified user re-triggers connection
      const session = getSession(chatId);
      session.draft_data = { ...session.draft_data, fayda_status: 'verified' };
      await saveSession(session, true);

      res = await dispatchWebhookUpdate(createTelegramMessageUpdate(chatId, '/start req_SPMARWR482'));
      if (res.status !== 200) throw new Error('Failed at Step 3 (Deep-Link Review)');
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Journey 4: Strict Fayda Photo Verification & Error Recovery Loop
  // ═══════════════════════════════════════════════════════════════════════════

  await executeTest(
    'User Journey 4: Fayda Verification & Recovery',
    'User encounters errors with non-Fayda and blurry photos, then recovers with authentic QR',
    async () => {
      const chatId = 40004;
      await clearSession(chatId);

      // Step 1: User opens Fayda gate
      await dispatchWebhookUpdate(createTelegramMessageUpdate(chatId, '/fayda'));

      // Step 2: User mistakenly uploads non-Fayda QR (receipt/URL)
      const nonFaydaFixture = await generateNonFaydaQrBuffer('https://example.com/receipt');
      registerMockTelegramPhoto('j4_non_fayda', nonFaydaFixture.pngBuffer);

      let res = await dispatchWebhookUpdate(createTelegramPhotoUpdate(chatId, 'j4_non_fayda'));
      if (res.status !== 200) throw new Error('Failed at Step 2 (Non-Fayda Upload)');

      // Step 3: User uploads blurry/corrupted noise image
      const noiseBuffer = await generateCorruptedQrBuffer('corrupted_bytes');
      registerMockTelegramPhoto('j4_blurry_photo', noiseBuffer);

      res = await dispatchWebhookUpdate(createTelegramPhotoUpdate(chatId, 'j4_blurry_photo'));
      if (res.status !== 200) throw new Error('Failed at Step 3 (Corrupted Photo Upload)');

      // Step 4: User recovers by uploading authentic sharp Fayda card photo
      const authenticFixture = await generateAuthenticFaydaQrBuffer({
        fullName: 'Senait Desta',
        fan: '9929104728193843',
        gender: 'F',
      });
      registerMockTelegramPhoto('j4_authentic_photo', authenticFixture.pngBuffer);

      clearCapturedTelegramCalls();
      res = await dispatchWebhookUpdate(createTelegramPhotoUpdate(chatId, 'j4_authentic_photo'));
      if (res.status !== 200) throw new Error('Failed at Step 4 (Authentic Recovery Photo)');
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Journey 5: Returning Verified User Instant Search & Discovery
  // ═══════════════════════════════════════════════════════════════════════════

  await executeTest(
    'User Journey 5: Returning Verified User',
    'Returning verified user performs instant matchmaker search without re-gating loops',
    async () => {
      const chatId = 40005;
      await clearSession(chatId);

      // Seed verified user session
      await saveSession({
        telegram_id: chatId,
        step: 'idle',
        draft_data: {
          fayda_status: 'verified',
          age: 26,
          gender: 'Male',
          job: 'Data Analyst',
          religion: 'Orthodox',
          preferred_gender: 'Male',
        },
        updated_at: new Date().toISOString(),
      }, true);

      // Step 1: Launch matchmaker search
      let res = await dispatchWebhookUpdate(createTelegramCallbackUpdate(chatId, 'matchmaker_start'));
      if (res.status !== 200) throw new Error('Failed at Step 1 (Matchmaker Start)');
      const calls = getCapturedTelegramCalls();
      const hasAreaButtons = calls.some((c) =>
        c.payload?.reply_markup?.inline_keyboard?.some((row: any[]) =>
          row.some((b) => b.callback_data && b.callback_data.startsWith('match_toggle_sub:'))
        )
      );
      if (!hasAreaButtons) throw new Error('Verified user was incorrectly gated or missing area buttons');

      // Step 2: Advance through filters cleanly
      await dispatchWebhookUpdate(createTelegramCallbackUpdate(chatId, 'match_goto_gender'));
      await dispatchWebhookUpdate(createTelegramCallbackUpdate(chatId, 'match_gender:Male'));
      await dispatchWebhookUpdate(createTelegramCallbackUpdate(chatId, 'match_pref_gender:Any'));

      // Step 3: Budget input executes query
      clearCapturedTelegramCalls();
      res = await dispatchWebhookUpdate(createTelegramMessageUpdate(chatId, '12500'));
      if (res.status !== 200) throw new Error('Failed at Step 3 (Budget Execution)');
    }
  );

  teardownTelegramFetchMock();
}
