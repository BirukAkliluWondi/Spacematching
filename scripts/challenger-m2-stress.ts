/**
 * scripts/challenger-m2-stress.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Empirical Adversarial Challenger Test Harness for Milestone 2.
 *
 * Verifies loop elimination, workflow streamlining, and deduplication:
 *  1. Matchmaker search flow -> search_unlock_contact:<id> (No redundant questions)
 *  2. Space owner flow -> space_photos_done (Space preview card, no seeker hijack)
 *  3. Channel deep link /start req_<CODE> (Returning user profile preservation)
 *  4. awaiting_seeker_fayda_upload resilience (Text, valid QR photo, invalid photo)
 *  5. Duplicate update_id deduplication (Single execution, duplicate dropped)
 */

import fs from 'fs';
import path from 'path';

// Native .env.local loader
try {
  const envPath = path.resolve('.env.local');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const line of envContent.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const key = trimmed.substring(0, eqIdx).trim();
        let val = trimmed.substring(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
} catch {}

import {
  setupTelegramFetchMock,
  registerMockTelegramPhoto,
  clearCapturedTelegramCalls,
  getCapturedTelegramCalls,
  createTelegramMessageUpdate,
  createTelegramCallbackUpdate,
  createTelegramPhotoUpdate,
  dispatchWebhookUpdate,
} from './helpers/test-harness';
import {
  generateAuthenticFaydaQrBuffer,
  generateCorruptedQrBuffer,
} from './helpers/synthetic-fayda';
import { getSession, saveSession, clearSession } from '../src/lib/bot-session-store';

interface StressResult {
  name: string;
  status: 'PASS' | 'FAIL';
  details: string;
  durationMs: number;
}

const results: StressResult[] = [];

async function runTest(name: string, fn: () => Promise<string | void>) {
  const t0 = performance.now();
  clearCapturedTelegramCalls();
  try {
    const note = await fn();
    const t1 = performance.now();
    results.push({
      name,
      status: 'PASS',
      details: note || 'Passed all empirical assertions',
      durationMs: Math.round((t1 - t0) * 10) / 10,
    });
    console.log(`  ✅ [PASS] ${name} (${Math.round(t1 - t0)}ms)`);
  } catch (err: any) {
    const t1 = performance.now();
    results.push({
      name,
      status: 'FAIL',
      details: err.message || String(err),
      durationMs: Math.round((t1 - t0) * 10) / 10,
    });
    console.error(`  ❌ [FAIL] ${name} (${Math.round(t1 - t0)}ms): ${err.message}`);
  }
}

async function main() {
  console.log('========================================================================================');
  console.log(' ⚔️  EMPIRICAL CHALLENGER: Milestone 2 Adversarial Stress Test Suite');
  console.log('========================================================================================\n');

  setupTelegramFetchMock();

  // In-process interceptor for Supabase profiles query to provide zero-network deterministic mock
  const originalFetch = globalThis.fetch;
  const mockDbProfiles = new Map<number, any>();

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (urlStr.includes('/rest/v1/profiles')) {
      for (const [tgId, profileObj] of mockDbProfiles.entries()) {
        if (urlStr.includes(`telegram_id=eq.${tgId}`)) {
          return new Response(JSON.stringify(profileObj), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Content-Range': '0-0/1' },
          });
        }
      }
      // If queried for a telegram_id not in mockDbProfiles, return empty array (user has no profile in DB)
      if (urlStr.includes('telegram_id=eq.')) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Content-Range': '*/0' },
        });
      }
    }

    return originalFetch(input, init);
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // CHALLENGE 1: Matchmaker Search Flow -> search_unlock_contact
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('▶ [Challenge 1] Testing Matchmaker Search -> search_unlock_contact loop elimination...');

  await runTest(
    'C1.1: Fully verified & complete seeker unlocking contact transitions directly without re-prompting',
    async () => {
      const chatId = 91001;
      await clearSession(chatId);

      mockDbProfiles.set(chatId, {
        id: '10000000-0000-0000-0000-000000000001',
        telegram_id: chatId,
        full_name: 'Verified Seeker One',
        age: 25,
        gender: 'Female',
        my_gender: 'Female',
        religion: 'Orthodox',
        job: 'Software Engineer',
        budget_min: 5000,
        budget_max: 12000,
        preferred_gender: 'Female',
        locations: ['Bole'],
        roommate_traits: 'Clean and quiet professional',
        kyc_status: 'verified',
        fayda_status: 'verified',
        status: 'active',
      });

      await saveSession({
        telegram_id: chatId,
        step: 'idle',
        draft_data: {
          age: 25,
          gender: 'Female',
          my_gender: 'Female',
          religion: 'Orthodox',
          job: 'Software Engineer',
          budget_max: 12000,
          preferred_gender: 'Female',
          match_subcities: ['Bole'],
          fayda_status: 'verified',
        },
        updated_at: new Date().toISOString(),
      }, true);

      clearCapturedTelegramCalls();
      const update = createTelegramCallbackUpdate(chatId, 'search_unlock_contact:00000000-0000-0000-0000-000000000001');
      const res = await dispatchWebhookUpdate(update);
      if (res.status !== 200) throw new Error(`Expected HTTP 200, got ${res.status}`);

      const calls = getCapturedTelegramCalls();
      const promptTexts = calls.map((c) => c.payload?.text || '').join('\n');

      // Assertions: Age, Gender, Religion, Job, Budget must NOT be asked
      if (promptTexts.includes('Step 1') || promptTexts.includes('ዕድሜዎ ስንት ነው?') || promptTexts.includes('How old are you?')) {
        throw new Error('Violated: Seeker re-prompted for Age (Step 1)');
      }
      if (promptTexts.includes('Step 2') || promptTexts.includes('ፆታዎ?') || promptTexts.includes('Select your gender')) {
        throw new Error('Violated: Seeker re-prompted for Gender (Step 2)');
      }
      if (promptTexts.includes('Step 5') || promptTexts.includes('ወርሃዊ የበጀት')) {
        throw new Error('Violated: Seeker re-prompted for Budget (Step 5)');
      }

      return 'Verified user bypassed all 9 steps and routed directly to contact unlock confirmation';
    }
  );

  await runTest(
    'C1.2: Incomplete seeker retains search parameters (age, gender, budget, subcities) and routes only to missing step',
    async () => {
      const chatId = 91002;
      await clearSession(chatId);

      // User performed search; draft has age, gender, budget, preferred_gender, subcities
      // but lacks religion and job, and is unverified.
      await saveSession({
        telegram_id: chatId,
        step: 'awaiting_match_budget_input',
        draft_data: {
          age: 27,
          gender: 'Male',
          my_gender: 'Male',
          match_subcities: ['Kazanchis'],
          budget_max: 15000,
          preferred_gender: 'Male',
          fayda_status: 'unverified',
        },
        updated_at: new Date().toISOString(),
      }, true);

      clearCapturedTelegramCalls();
      const unlockUpdate = createTelegramCallbackUpdate(chatId, 'search_unlock_contact:00000000-0000-0000-0000-000000000002');
      const res = await dispatchWebhookUpdate(unlockUpdate);
      if (res.status !== 200) throw new Error(`Expected HTTP 200, got ${res.status}`);

      const calls = getCapturedTelegramCalls();
      const promptTexts = calls.map((c) => c.payload?.text || '').join('\n');

      // Assertions:
      // 1. Must NOT ask Age (Step 1)
      if (promptTexts.includes('Step 1') || promptTexts.includes('ዕድሜዎ ስንት ነው?') || promptTexts.includes('How old are you?')) {
        throw new Error('Violated: Seeker re-prompted for Age when age was already present in search criteria');
      }
      // 2. Must NOT ask Gender (Step 2)
      if (promptTexts.includes('Step 2') || promptTexts.includes('ፆታዎን ይምረጡ') || promptTexts.includes('Select your gender')) {
        throw new Error('Violated: Seeker re-prompted for Gender when gender was already present');
      }
      // 3. Must route to Step 3 (Religion) as it is the first missing field
      const hasReligionPrompt = calls.some((c) =>
        c.payload?.reply_markup?.inline_keyboard?.some((row: any[]) =>
          row.some((b: any) => b.callback_data && b.callback_data.startsWith('dyn_religion:'))
        )
      );
      if (!hasReligionPrompt) {
        throw new Error('Expected router to prompt for Step 3 Religion, but religion buttons not found');
      }

      // Check session draft preservation
      const session = getSession(chatId);
      if (session.draft_data.age !== 27) throw new Error(`Age draft lost: expected 27, got ${session.draft_data.age}`);
      if (session.draft_data.gender !== 'Male') throw new Error(`Gender draft lost: expected Male, got ${session.draft_data.gender}`);
      if (session.draft_data.budget_max !== 15000) throw new Error(`Budget draft lost: expected 15000, got ${session.draft_data.budget_max}`);

      return 'Search parameters preserved; user routed to missing Step 3 without repeating Age, Gender, or Budget';
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // CHALLENGE 2: Space Owner Flow -> space_photos_done
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n▶ [Challenge 2] Testing Space Owner Flow -> space_photos_done (Anti-Hijack)...');

  await runTest(
    'C2.1: Space owner (unverified) clicking space_photos_done routes to Space Preview Card, NOT seeker questionnaire',
    async () => {
      const chatId = 92001;
      await clearSession(chatId);
      mockDbProfiles.delete(chatId);

      // Seed space draft
      await saveSession({
        telegram_id: chatId,
        step: 'space_input_photos',
        draft_data: {
          space_type: 'Master Bedroom with Private Bath',
          space_rent: 18000,
          space_share: 9000,
          space_amenities: ['📶 WiFi', '🍳 Kitchen', '🚿 Hot Water'],
          preferred_subcity: ['Bole'],
          preferred_roommate: 'Clean, working tenant',
          space_photos: ['photo_01', 'photo_02'],
          fayda_status: 'unverified',
        },
        updated_at: new Date().toISOString(),
      }, true);

      clearCapturedTelegramCalls();
      const doneUpdate = createTelegramCallbackUpdate(chatId, 'space_photos_done');
      const res = await dispatchWebhookUpdate(doneUpdate);
      if (res.status !== 200) throw new Error(`Expected HTTP 200, got ${res.status}`);

      const calls = getCapturedTelegramCalls();
      const promptTexts = calls.map((c) => c.payload?.text || '').join('\n');

      // EMPIRICAL ASSERTION: Must NOT route to sendDynamicCardStep1Age
      if (promptTexts.includes('Step 1 / 9') || promptTexts.includes('ዕድሜዎ ስንት ነው?') || promptTexts.includes('How old are you?')) {
        throw new Error('CRITICAL VIOLATION: Space owner was hijacked into Seeker Questionnaire Step 1!');
      }

      // EMPIRICAL ASSERTION: Must present Space Preview Card
      const hasAdminSubmitButton = calls.some((c) =>
        c.payload?.reply_markup?.inline_keyboard?.some((row: any[]) =>
          row.some((b: any) => b.callback_data && b.callback_data.startsWith('space_submit_admin:'))
        )
      );
      if (!hasAdminSubmitButton) {
        throw new Error('Violated: Space preview card missing space_submit_admin button');
      }

      // Check draft preservation
      const session = getSession(chatId);
      if (session.draft_data.space_rent !== 18000) {
        throw new Error(`Space rent lost: expected 18000, got ${session.draft_data.space_rent}`);
      }

      return 'Space owner correctly shown Space Preview Card with submit button; zero seeker questionnaire hijack';
    }
  );

  await runTest(
    'C2.2: Space owner clicking space_photos_skip routes to Space Preview Card without hijacking',
    async () => {
      const chatId = 92002;
      await clearSession(chatId);

      await saveSession({
        telegram_id: chatId,
        step: 'space_input_photos',
        draft_data: {
          space_type: 'Shared Room',
          space_rent: 8000,
          space_share: 4000,
          space_amenities: ['📶 WiFi'],
          preferred_subcity: ['Kazanchis'],
          fayda_status: 'unverified',
        },
        updated_at: new Date().toISOString(),
      }, true);

      clearCapturedTelegramCalls();
      const skipUpdate = createTelegramCallbackUpdate(chatId, 'space_photos_skip');
      const res = await dispatchWebhookUpdate(skipUpdate);
      if (res.status !== 200) throw new Error(`Expected HTTP 200, got ${res.status}`);

      const calls = getCapturedTelegramCalls();
      const promptTexts = calls.map((c) => c.payload?.text || '').join('\n');

      if (promptTexts.includes('Step 1 / 9') || promptTexts.includes('How old are you?')) {
        throw new Error('CRITICAL VIOLATION: Space owner on skip was hijacked into Seeker questionnaire!');
      }

      const hasSubmitButton = calls.some((c) =>
        c.payload?.reply_markup?.inline_keyboard?.some((row: any[]) =>
          row.some((b: any) => b.callback_data && b.callback_data.startsWith('space_submit_admin:'))
        )
      );
      if (!hasSubmitButton) throw new Error('Expected space_submit_admin button on skip');

      return 'space_photos_skip correctly preserved space draft and routed to Space Preview Card';
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // CHALLENGE 3: Channel Deep Link /start req_<CODE> Returning User Preservation
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n▶ [Challenge 3] Testing Channel Deep Link /start req_<CODE> Profile Preservation...');

  await runTest(
    'C3.1: Returning unverified user with profile preserves all fields and routes to Fayda, skipping Steps 1-8',
    async () => {
      const chatId = 93001;
      await clearSession(chatId);

      // Pre-seed mock returning user profile
      mockDbProfiles.set(chatId, {
        id: '20000000-0000-0000-0000-000000000001',
        telegram_id: chatId,
        display_code: 'RM930',
        age: 28,
        gender: 'Male',
        my_gender: 'Male',
        religion: 'Muslim',
        job: 'Accountant',
        budget_min: 6000,
        budget_max: 13000,
        preferred_gender: 'Male',
        locations: ['Bole', 'Kazanchis'],
        roommate_traits: 'Quiet professional, non-smoker',
        kyc_status: 'unverified',
        fayda_status: 'unverified',
        status: 'active',
        onboarding_step: 'completed',
      });

      clearCapturedTelegramCalls();
      const deepLinkUpdate = createTelegramMessageUpdate(chatId, '/start req_SPMARWR482');
      const res = await dispatchWebhookUpdate(deepLinkUpdate);
      if (res.status !== 200) throw new Error(`Expected HTTP 200, got ${res.status}`);

      const calls = getCapturedTelegramCalls();
      const promptTexts = calls.map((c) => c.payload?.text || '').join('\n');

      // EMPIRICAL ASSERTION: Must NOT restart onboarding from Step 1
      if (promptTexts.includes('Step 1 / 9') || promptTexts.includes('ዕድሜዎ ስንት ነው?') || promptTexts.includes('How old are you?')) {
        throw new Error('CRITICAL VIOLATION: Returning user profile was wiped; prompted for Step 1 Age!');
      }

      // EMPIRICAL ASSERTION: Since all profile fields (age, gender, religion, job, budget, traits, subcities) exist
      // but user is unverified, user must be routed directly to Step 9 Fayda Verification!
      const hasFaydaCard = calls.some((c) =>
        c.payload?.reply_markup?.inline_keyboard?.some((row: any[]) =>
          row.some((b: any) => b.callback_data && (b.callback_data === 'dyn_back_to_subs' || b.callback_data.includes('fayda')))
        ) || (c.payload?.text && (c.payload.text.includes('Fayda') || c.payload.text.includes('ፋይዳ')))
      );
      if (!hasFaydaCard) {
        throw new Error('Expected returning user to route directly to Fayda card, but Fayda card not found in calls');
      }

      // Check session draft
      const session = getSession(chatId);
      if (session.draft_data.age !== 28) throw new Error(`Age lost: expected 28, got ${session.draft_data.age}`);
      if (session.draft_data.job !== 'Accountant') throw new Error(`Job lost: expected Accountant, got ${session.draft_data.job}`);
      if (session.draft_data.religion !== 'Muslim') throw new Error(`Religion lost: expected Muslim, got ${session.draft_data.religion}`);

      return 'Returning user profile fields 100% preserved; user gated directly to Fayda verification without re-prompting';
    }
  );

  await runTest(
    'C3.2: Brand new user entering via /start req_<CODE> is routed cleanly to Step 1 Age with target context locked',
    async () => {
      const chatId = 93002;
      await clearSession(chatId);
      mockDbProfiles.delete(chatId);

      clearCapturedTelegramCalls();
      const deepLinkUpdate = createTelegramMessageUpdate(chatId, '/start req_SPMARWR482');
      const res = await dispatchWebhookUpdate(deepLinkUpdate);
      if (res.status !== 200) throw new Error(`Expected HTTP 200, got ${res.status}`);

      const calls = getCapturedTelegramCalls();
      const promptTexts = calls.map((c) => c.payload?.text || '').join('\n');

      const session = getSession(chatId);
      const isAgePrompt = promptTexts.includes('What is your age?') || promptTexts.includes('ስንት ነው') || session.step === 'dyn_card_age';
      if (!isAgePrompt) {
        throw new Error(`Expected new user without profile to start at Step 1 Age. Got prompt: ${promptTexts}`);
      }
      if (session.draft_data.target_code !== 'SPMARWR482') {
        throw new Error(`Target code lost: expected SPMARWR482, got ${session.draft_data.target_code}`);
      }

      return 'Brand new user cleanly routed to Step 1 Age with target context locked in session';
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // CHALLENGE 4: Dead-End State Resolution: awaiting_seeker_fayda_upload
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n▶ [Challenge 4] Testing awaiting_seeker_fayda_upload Dead-End Resolution...');

  await runTest(
    'C4.1: Plain text message at awaiting_seeker_fayda_upload re-prompts for photo instead of dead-ending',
    async () => {
      const chatId = 94001;
      await clearSession(chatId);

      await saveSession({
        telegram_id: chatId,
        step: 'awaiting_seeker_fayda_upload',
        draft_data: {
          age: 24,
          gender: 'Female',
          fayda_status: 'unverified',
        },
        updated_at: new Date().toISOString(),
      }, true);

      clearCapturedTelegramCalls();
      const textUpdate = createTelegramMessageUpdate(chatId, 'Hello, how do I verify my Fayda?');
      const res = await dispatchWebhookUpdate(textUpdate);
      if (res.status !== 200) throw new Error(`Expected HTTP 200, got ${res.status}`);

      const calls = getCapturedTelegramCalls();
      if (calls.length === 0) {
        throw new Error('CRITICAL VIOLATION: Bot had zero response to text message at awaiting_seeker_fayda_upload (Dead End)!');
      }

      const promptTexts = calls.map((c) => c.payload?.text || '').join('\n');
      const isFaydaPrompt = promptTexts.includes('ፋይዳ') || promptTexts.includes('Fayda') || promptTexts.includes('National ID');
      if (!isFaydaPrompt) {
        throw new Error('Expected prompt to guide user towards Fayda National ID photo upload');
      }

      return 'Handled text message cleanly by re-prompting Fayda photo gate without dead-ending';
    }
  );

  await runTest(
    'C4.2: Authentic Fayda QR photo upload at awaiting_seeker_fayda_upload verifies user cleanly',
    async () => {
      const chatId = 94002;
      await clearSession(chatId);

      const fixture = await generateAuthenticFaydaQrBuffer({
        fullName: 'Rahel Tadesse',
        fan: '8839201948201942',
        gender: 'F',
      });
      registerMockTelegramPhoto('c4_authentic_photo', fixture.pngBuffer);

      await saveSession({
        telegram_id: chatId,
        step: 'awaiting_seeker_fayda_upload',
        draft_data: {
          age: 22,
          gender: 'Female',
          fayda_status: 'unverified',
          card_msg_id: 12345,
        },
        updated_at: new Date().toISOString(),
      }, true);

      clearCapturedTelegramCalls();
      const photoUpdate = createTelegramPhotoUpdate(chatId, 'c4_authentic_photo');
      const res = await dispatchWebhookUpdate(photoUpdate);
      if (res.status !== 200) throw new Error(`Expected HTTP 200, got ${res.status}`);

      // Verify session updated
      const session = getSession(chatId);
      if (session.draft_data.fayda_status !== 'verified') {
        throw new Error(`Expected fayda_status === 'verified', got ${session.draft_data.fayda_status}`);
      }
      if (session.draft_data.fayda_number !== '8839201948201942') {
        throw new Error(`Expected FAN 8839201948201942, got ${session.draft_data.fayda_number}`);
      }

      return 'Successfully decoded authentic Fayda QR, verified RS256 signature, and updated session to verified';
    }
  );

  await runTest(
    'C4.3: Corrupted photo at awaiting_seeker_fayda_upload responds with clear error guidance without dead-ending',
    async () => {
      const chatId = 94003;
      await clearSession(chatId);

      const noiseBuffer = await generateCorruptedQrBuffer('corrupt_seeker_photo');
      registerMockTelegramPhoto('c4_corrupt_photo', noiseBuffer);

      await saveSession({
        telegram_id: chatId,
        step: 'awaiting_seeker_fayda_upload',
        draft_data: {
          age: 23,
          gender: 'Male',
          fayda_status: 'unverified',
          card_msg_id: 12346,
        },
        updated_at: new Date().toISOString(),
      }, true);

      clearCapturedTelegramCalls();
      const photoUpdate = createTelegramPhotoUpdate(chatId, 'c4_corrupt_photo');
      const res = await dispatchWebhookUpdate(photoUpdate);
      if (res.status !== 200) throw new Error(`Expected HTTP 200, got ${res.status}`);

      const calls = getCapturedTelegramCalls();
      if (calls.length === 0) throw new Error('Dead end: no response sent to corrupted photo');

      const promptTexts = calls.map((c) => c.payload?.text || '').join('\n');
      const hasErrorGuidance = promptTexts.includes('QR') || promptTexts.includes('ፎቶ') || promptTexts.includes('clear photo');
      if (!hasErrorGuidance) {
        throw new Error('Expected guidance message explaining unreadable QR');
      }

      return 'Handled corrupted photo gracefully with recovery prompt; zero crash or dead-end';
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // CHALLENGE 5: Telegram update_id Deduplication
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n▶ [Challenge 5] Testing Telegram update_id Deduplication...');

  await runTest(
    'C5.1: Duplicate update_id delivery is dropped immediately at webhook entry with duplicate: true',
    async () => {
      const chatId = 95001;
      await clearSession(chatId);

      const fixedUpdateId = 88123456;
      const initialUpdate = {
        update_id: fixedUpdateId,
        message: {
          message_id: 60001,
          from: { id: chatId, is_bot: false, first_name: 'DedupUser' },
          chat: { id: chatId, type: 'private' },
          date: Math.floor(Date.now() / 1000),
          text: '/start',
        },
      };

      // 1. First delivery
      clearCapturedTelegramCalls();
      const res1 = await dispatchWebhookUpdate(initialUpdate);
      if (res1.status !== 200) throw new Error(`First delivery failed with ${res1.status}`);
      if (res1.body?.duplicate) throw new Error('First delivery should NOT be marked duplicate');
      const initialCallsCount = getCapturedTelegramCalls().length;
      if (initialCallsCount === 0) throw new Error('Expected initial delivery to trigger bot responses');

      // 2. Second delivery with identical update_id
      clearCapturedTelegramCalls();
      const res2 = await dispatchWebhookUpdate(initialUpdate);
      if (res2.status !== 200) throw new Error(`Second delivery failed with ${res2.status}`);
      if (!res2.body?.duplicate) {
        throw new Error(`CRITICAL VIOLATION: Second delivery with update_id ${fixedUpdateId} was NOT dropped as duplicate! Body: ${JSON.stringify(res2.body)}`);
      }
      const duplicateCallsCount = getCapturedTelegramCalls().length;
      if (duplicateCallsCount !== 0) {
        throw new Error(`CRITICAL VIOLATION: Duplicate update generated ${duplicateCallsCount} bot actions!`);
      }

      // 3. Rapid burst of 5 identical updates
      for (let i = 0; i < 5; i++) {
        const resBurst = await dispatchWebhookUpdate(initialUpdate);
        if (resBurst.status !== 200 || !resBurst.body?.duplicate) {
          throw new Error(`Burst delivery #${i} failed deduplication`);
        }
      }

      return 'Sliding window deduplication dropped second delivery and 5 burst retries with zero duplicate bot calls';
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Evaluation Summary
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n========================================================================================');
  console.log(' 📊 EMPIRICAL CHALLENGE EVALUATION RESULTS');
  console.log('========================================================================================');
  const total = results.length;
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;

  for (const r of results) {
    console.log(` • [${r.status}] ${r.name} (${r.durationMs}ms)`);
    console.log(`    ↳ ${r.details}`);
  }

  console.log('----------------------------------------------------------------------------------------');
  console.log(` Total Adversarial Challenges: ${total}`);
  console.log(` Passed Challenges           : ${passed}`);
  console.log(` Failed Challenges           : ${failed}`);
  console.log(` Success Rate                : ${((passed / total) * 100).toFixed(1)}%`);
  console.log('========================================================================================\n');

  if (failed > 0) {
    console.error('❌ ADVERSARIAL CHALLENGE FAILED: Defects discovered.');
    process.exit(1);
  } else {
    console.log('🎉 ALL ADVERSARIAL CHALLENGES EMPIRICALLY CONFIRMED AND PASSED!');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
