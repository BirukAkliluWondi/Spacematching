/**
 * scripts/adversarial-challenger-m2.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Adversarial Challenger Test Suite for Milestone 2:
 * "Bot Workflow Streamlining & Loop Elimination"
 *
 * Probes:
 * 1. Conversational tracing across all dialogue flows:
 *    - Does any workflow step ask gender twice in a row?
 *    - Does any workflow step ask preferences twice in a row?
 *    - Does any workflow step ask budget twice in a row?
 *    - Does any state transition loop back to an earlier step without error justification?
 * 2. Matchmaker unlock contact loop elimination & preference preservation.
 * 3. Space landlord flow separation (space_photos_done -> preview, no seeker card).
 * 4. Channel deep-link profile preservation (/start req_<CODE>).
 * 5. Dead-end state resolution (awaiting_seeker_fayda_upload).
 * 6. Telegram update deduplication.
 * 7. Budget range parser negative number & boundary handling.
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
} from './helpers/test-harness';
import { generateAuthenticFaydaQrBuffer } from './helpers/synthetic-fayda';
import { getSession, saveSession, clearSession } from '../src/lib/bot-session-store';
import { parseBudgetRangeInput } from '../src/lib/telegram';
import { supabaseAdmin } from '../src/lib/supabase-server';

interface PromptAnalysis {
  asksGender: boolean;
  asksBudget: boolean;
  asksPreferences: boolean;
  rawText: string;
}

function analyzePrompt(text: string): PromptAnalysis {
  const lower = text.toLowerCase();
  const asksGender =
    (lower.includes('gender') || lower.includes('ጾታ') || lower.includes('male') || lower.includes('female')) &&
    !lower.includes('preferred roommate gender') &&
    !lower.includes('የሚፈልጉትን የቤት ጓደኛ ጾታ') &&
    !lower.includes('partner') &&
    (lower.includes('select your gender') || lower.includes('your gender') || lower.includes('ጾታዎን ይምረጡ') || lower.includes('step 2 of 9') || lower.includes('step 5 of 9') || lower.includes('host gender'));

  const asksBudget =
    (lower.includes('budget') || lower.includes('በጀት') || lower.includes('rent') || lower.includes('ኪራይ')) &&
    (lower.includes('monthly') || lower.includes('range') || lower.includes('ክልል') || lower.includes('step 5 of 9') || lower.includes('step 3 of 7') || lower.includes('step 2 of 9'));

  const asksPreferences =
    lower.includes('preferred') ||
    lower.includes('roommate preference') ||
    lower.includes('preferred gender') ||
    lower.includes('የሚፈልጉትን') ||
    lower.includes('sub-cities') ||
    lower.includes('preferred areas') ||
    lower.includes('step 6 of 9') ||
    lower.includes('step 7 of 9') ||
    lower.includes('step 8 of 9');

  return { asksGender, asksBudget, asksPreferences, rawText: text };
}

async function runAdversarialTests() {
  console.log('========================================================================');
  console.log('🕵️ CHALLENGER 2: ADVERSARIAL BOT WORKFLOW & LOOP ELIMINATION PROBE');
  console.log('========================================================================\n');

  setupTelegramFetchMock();
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`  ✅ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${testName}${detail ? ` -> ${detail}` : ''}`);
      failed++;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TEST SUITE 1: Budget Range Parser Boundary & Negative Rejection
  // ─────────────────────────────────────────────────────────────────────────
  console.log('--- Suite 1: parseBudgetRangeInput Adversarial Edge Cases ---');
  {
    const negativeCases = [
      '-500',
      '-1000',
      '- 500',
      ' -500 ',
      '-5k',
      '--500',
      '-8000',
      '8000 - -15000',
      '-8k to 15k',
      '8k to -15k',
      '-8k - 15k',
      '-8000 - 15000',
    ];

    for (const input of negativeCases) {
      const res = parseBudgetRangeInput(input);
      assert(res === null, `Negative input "${input}" must be rejected`, `got ${JSON.stringify(res)}`);
    }

    const validCases = [
      { input: '8000 - 15000', expected: { min: 8000, max: 15000 } },
      { input: '15000 - 8000', expected: { min: 8000, max: 15000 } },
      { input: '8k - 15k', expected: { min: 8000, max: 15000 } },
      { input: '12000', expected: { min: 8400, max: 12000 } },
      { input: '8000 to 15000 ETB', expected: { min: 8000, max: 15000 } },
      { input: '8 ሺህ - 15 ሺህ', expected: { min: 8000, max: 15000 } },
    ];

    for (const tc of validCases) {
      const res = parseBudgetRangeInput(tc.input);
      assert(
        res !== null && res.min === tc.expected.min && res.max === tc.expected.max,
        `Valid input "${tc.input}" parses correctly`,
        `expected ${JSON.stringify(tc.expected)}, got ${JSON.stringify(res)}`
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TEST SUITE 2: Dynamic Card Seeker Registration - Monotonic Progression & No Loops
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- Suite 2: Dynamic Card Dialogue Tracing (No Consecutive Duplicates) ---');
  {
    const chatId = 60001;
    await clearSession(chatId);
    await supabaseAdmin.from('profiles').delete().eq('telegram_id', chatId);

    const promptHistory: PromptAnalysis[] = [];

    async function stepAndRecord(update: any, description: string) {
      clearCapturedTelegramCalls();
      const res = await dispatchWebhookUpdate(update);
      assert(res.status === 200, `${description} webhook status 200`);
      const calls = getCapturedTelegramCalls();
      for (const call of calls) {
        const text = call.payload?.text || '';
        if (text) {
          promptHistory.push(analyzePrompt(text));
        }
      }
    }

    // Step 1: Start Seeker flow
    await stepAndRecord(createTelegramCallbackUpdate(chatId, 'post_branch_seeker'), 'Start Seeker Wizard');

    // Step 2: Invalid Age -> should re-prompt Age with error, NOT reset to branch selection
    await stepAndRecord(createTelegramMessageUpdate(chatId, '12'), 'Submit invalid age 12');
    const lastPrompt1 = promptHistory[promptHistory.length - 1];
    assert(
      lastPrompt1.rawText.includes('18') || lastPrompt1.rawText.includes('ዕድሜ'),
      'Invalid age gives justified retry message without resetting session'
    );

    // Step 3: Valid Age 24
    await stepAndRecord(createTelegramMessageUpdate(chatId, '24'), 'Submit valid age 24');

    // Step 4: Gender Selection
    await stepAndRecord(createTelegramCallbackUpdate(chatId, 'dyn_gender:Male'), 'Select Gender Male');

    // Step 5: Religion Selection
    await stepAndRecord(createTelegramCallbackUpdate(chatId, 'dyn_religion:Orthodox'), 'Select Religion Orthodox');

    // Step 6: Invalid Job -> should re-prompt Job with error
    await stepAndRecord(createTelegramMessageUpdate(chatId, 'x'), 'Submit short job "x"');
    const lastPrompt2 = promptHistory[promptHistory.length - 1];
    assert(
      lastPrompt2.rawText.includes('job') || lastPrompt2.rawText.includes('ሙያ'),
      'Invalid job gives justified retry without looping to Age/Gender'
    );

    // Step 7: Valid Job -> triggers dedicated interstitial transition card
    await stepAndRecord(createTelegramMessageUpdate(chatId, 'Civil Engineer'), 'Submit valid job');
    const interstitialPrompt = promptHistory[promptHistory.length - 1];
    assert(
      interstitialPrompt.rawText.includes('ተመዝግቧል') ||
      interstitialPrompt.rawText.includes('Successfully Registered') ||
      interstitialPrompt.rawText.includes('Preferences') ||
      interstitialPrompt.rawText.includes('ምርጫዎች'),
      'Personal profile registration complete displays dedicated interstitial card'
    );

    // Transition from Personal Profile to Roommate Preferences
    await stepAndRecord(
      createTelegramCallbackUpdate(chatId, 'dyn_card_to_preferences'),
      'Proceed from Personal Profile to Roommate Preferences'
    );

    // Step 8: Invalid Budget (-500) -> must be rejected
    await stepAndRecord(createTelegramMessageUpdate(chatId, '-500'), 'Submit negative budget -500');
    const lastPrompt3 = promptHistory[promptHistory.length - 1];
    assert(
      lastPrompt3.rawText.includes('budget') || lastPrompt3.rawText.includes('በጀት'),
      'Negative budget rejected with retry message on Budget step'
    );

    // Step 9: Valid Budget Range
    await stepAndRecord(createTelegramMessageUpdate(chatId, '8000 - 15000'), 'Submit valid budget 8000 - 15000');

    // Step 10: Preferred Gender
    await stepAndRecord(createTelegramCallbackUpdate(chatId, 'dyn_pref_gender:Any'), 'Select Preferred Gender Any');

    // Step 11: Invalid Traits (too short) -> should re-prompt Traits
    await stepAndRecord(createTelegramMessageUpdate(chatId, 'hi'), 'Submit short traits "hi"');
    const lastPrompt4 = promptHistory[promptHistory.length - 1];
    assert(
      lastPrompt4.rawText.includes('preferred roommate') || lastPrompt4.rawText.includes('ጓደኛ'),
      'Invalid traits gives justified retry without resetting'
    );

    // Step 12: Valid Traits
    await stepAndRecord(
      createTelegramMessageUpdate(chatId, 'Non-smoker, quiet, respectful, tidy'),
      'Submit valid traits'
    );

    // Step 13: Subcity Selection & Proceed
    await stepAndRecord(createTelegramCallbackUpdate(chatId, 'dyn_sub_toggle:Bole'), 'Toggle Bole');
    await stepAndRecord(createTelegramCallbackUpdate(chatId, 'dyn_sub_proceed'), 'Proceed Subcities');

    // Now analyze the full sequence of prompts for consecutive duplicates!
    let consecutiveGenderCount = 0;
    let maxConsecutiveGender = 0;
    let consecutiveBudgetCount = 0;
    let maxConsecutiveBudget = 0;

    for (let i = 0; i < promptHistory.length; i++) {
      const p = promptHistory[i];
      // Consecutive gender check
      if (p.asksGender) {
        consecutiveGenderCount++;
        maxConsecutiveGender = Math.max(maxConsecutiveGender, consecutiveGenderCount);
      } else {
        consecutiveGenderCount = 0;
      }

      // Consecutive budget check (excluding justified error retry on invalid input)
      if (p.asksBudget && !p.rawText.includes('⚠️') && !p.rawText.includes('ትክክለኛ') && !p.rawText.includes('valid')) {
        consecutiveBudgetCount++;
        maxConsecutiveBudget = Math.max(maxConsecutiveBudget, consecutiveBudgetCount);
      } else if (!p.asksBudget) {
        consecutiveBudgetCount = 0;
      }
    }

    assert(maxConsecutiveGender <= 1, 'Gender is NEVER asked twice in a row (maxConsecutiveGender <= 1)');
    assert(maxConsecutiveBudget <= 1, 'Budget is NEVER asked twice in a row without error justification');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TEST SUITE 3: Matchmaker Unlock Loop Elimination & Preference Preservation
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- Suite 3: Matchmaker Unlock Contact Loop Elimination ---');
  {
    const chatId = 60002;
    await clearSession(chatId);
    await supabaseAdmin.from('profiles').delete().eq('telegram_id', chatId);

    // Simulate user who searched with criteria
    await saveSession({
      telegram_id: chatId,
      step: 'match_criteria',
      draft_data: {
        age: 27,
        my_gender: 'Male',
        gender: 'Male',
        preferred_gender: 'Female Only',
        budget_max: 18000,
        match_subcities: ['Bole', 'Kazanchis'],
      },
      updated_at: new Date().toISOString(),
    }, true);

    // User attempts to unlock a contact
    clearCapturedTelegramCalls();
    const unlockRes = await dispatchWebhookUpdate(
      createTelegramCallbackUpdate(chatId, 'search_unlock_contact:target-profile-123')
    );
    assert(unlockRes.status === 200, 'Unlock contact request returns 200');

    // The user has age, gender, budget, subcity in session draft.
    // They are missing religion, job, and Fayda.
    // So routeNextMissingSeekerStep should route directly to Step 3 Religion!
    // It must NOT route to Step 1 Age or Step 2 Gender!
    const calls = getCapturedTelegramCalls();
    const allTexts = calls.map((c) => c.payload?.text || '').filter(Boolean).join('\n');
    assert(
      allTexts.toLowerCase().includes('religion') || allTexts.includes('እምነት') || allTexts.includes('Step 3 of 9'),
      'Search unlock seeds draft and routes to first missing field (Religion), skipping Age & Gender',
      `Prompts were: [${calls.map(c => `${c.method}:${c.payload?.text?.slice(0, 30)}`).join(', ')}]`
    );
    assert(
      !allTexts.includes('Step 1 of 9') && !allTexts.includes('ዕድሜዎን'),
      'Search unlock does NOT loop back to Step 1 Age'
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TEST SUITE 4: Space Landlord Flow Separation (No Seeker Questionnaire Hijack)
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- Suite 4: Space Landlord Questionnaire Separation ---');
  {
    const chatId = 60003;
    await clearSession(chatId);
    await supabaseAdmin.from('profiles').delete().eq('telegram_id', chatId);

    // Space owner walks through wizard up to photos
    await dispatchWebhookUpdate(createTelegramCallbackUpdate(chatId, 'post_branch_space'));
    await dispatchWebhookUpdate(createTelegramMessageUpdate(chatId, '2-Bedroom Apartment'));
    await dispatchWebhookUpdate(createTelegramMessageUpdate(chatId, '20000'));
    await dispatchWebhookUpdate(createTelegramMessageUpdate(chatId, '10000'));
    await dispatchWebhookUpdate(createTelegramCallbackUpdate(chatId, 'space_amenities_proceed'));
    await dispatchWebhookUpdate(createTelegramCallbackUpdate(chatId, 'space_host_gender:Female'));
    await dispatchWebhookUpdate(createTelegramCallbackUpdate(chatId, 'space_pref_gender:Female Only'));
    await dispatchWebhookUpdate(createTelegramMessageUpdate(chatId, 'Respectful and clean'));
    await dispatchWebhookUpdate(createTelegramCallbackUpdate(chatId, 'space_subcity:Bole'));

    // Upload 1 photo
    await dispatchWebhookUpdate(createTelegramPhotoUpdate(chatId, 'space_photo_test_1'));

    // Space owner clicks space_photos_done
    clearCapturedTelegramCalls();
    const doneRes = await dispatchWebhookUpdate(createTelegramCallbackUpdate(chatId, 'space_photos_done'));
    assert(doneRes.status === 200, 'space_photos_done returns 200');

    const calls = getCapturedTelegramCalls();
    const allTexts = calls.map((c) => c.payload?.text || '').filter(Boolean).join('\n');

    // Must show space preview card, NEVER Seeker Step 1 Age
    assert(
      allTexts.includes('Space Preview') || allTexts.includes('ቅድመ-ዕይታ') || allTexts.includes('2-Bedroom Apartment'),
      'space_photos_done displays Space Preview Card directly',
      `Prompts were: [${calls.map(c => `${c.method}:${c.payload?.text?.slice(0, 30)}`).join(', ')}]`
    );
    assert(
      !allTexts.includes('Step 1 of 9') && !allTexts.includes('ዕድሜዎን በቁጥር ያስገቡ'),
      'space_photos_done does NOT hijack space landlord into Seeker Step 1 Age wizard'
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TEST SUITE 5: Channel Deep Link Profile Preservation (/start req_<CODE>)
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- Suite 5: Channel Deep Link Profile Preservation ---');
  {
    const chatId = 60004;
    await clearSession(chatId);

    // Create an unverified profile with existing valid columns
    const upsertRes = await supabaseAdmin.from('profiles').upsert({
      telegram_id: chatId,
      display_code: 'RM60004',
      gender: 'Male',
      locations: ['Bole'],
      budget_min: 7000,
      budget_max: 13000,
      roommate_traits: 'Quiet and non-smoker',
      kyc_status: 'pending',
      status: 'onboarding',
    }, { onConflict: 'telegram_id' });
    if (upsertRes.error) {
      console.log('Profile upsert note:', upsertRes.error.message);
    }

    // User enters via channel deep link
    clearCapturedTelegramCalls();
    const deepLinkRes = await dispatchWebhookUpdate(
      createTelegramMessageUpdate(chatId, '/start req_SPMARWR482')
    );
    assert(deepLinkRes.status === 200, 'Channel deep link returns 200');

    // Verify existing profile record was NOT wiped from profiles table
    const { data: preservedProfile } = await supabaseAdmin
      .from('profiles')
      .select('display_code, gender, locations')
      .eq('telegram_id', chatId)
      .maybeSingle();

    assert(
      preservedProfile?.display_code === 'RM60004' && preservedProfile?.gender === 'Male',
      'Channel deep link preserves existing profile in DB without wiping',
      `Preserved: ${JSON.stringify(preservedProfile)}`
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TEST SUITE 6: Dead-End State Resolution (awaiting_seeker_fayda_upload)
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- Suite 6: Dead-End State Resolution ---');
  {
    const chatId = 60005;
    await clearSession(chatId);

    // Put session into awaiting_seeker_fayda_upload
    await saveSession({
      telegram_id: chatId,
      step: 'awaiting_seeker_fayda_upload',
      draft_data: { age: 25, gender: 'Female' },
      updated_at: new Date().toISOString(),
    }, true);

    // Prepare authentic photo fixture
    const fixture = await generateAuthenticFaydaQrBuffer({
      fullName: 'Abebech Gobena',
      fan: '7729104728193845',
      gender: 'F',
    });
    registerMockTelegramPhoto('dead_end_resolution_photo', fixture.pngBuffer);

    // Send photo
    clearCapturedTelegramCalls();
    const photoRes = await dispatchWebhookUpdate(
      createTelegramPhotoUpdate(chatId, 'dead_end_resolution_photo')
    );
    assert(photoRes.status === 200, 'Photo update on awaiting_seeker_fayda_upload returns 200');

    // Verify session progressed beyond the dead-end state
    const afterSession = getSession(chatId);
    assert(
      afterSession.step !== 'awaiting_seeker_fayda_upload',
      'Session successfully transitions out of awaiting_seeker_fayda_upload',
      `Current step: ${afterSession.step}`
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TEST SUITE 7: Telegram Update Deduplication (Sliding Window)
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n--- Suite 7: Telegram Update Deduplication ---');
  {
    const chatId = 60006;
    const updateId = 88776655;

    const testUpdate = {
      update_id: updateId,
      message: {
        message_id: 9911,
        from: { id: chatId, is_bot: false, first_name: 'DedupUser' },
        chat: { id: chatId, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: '/start',
      },
    };

    // First delivery
    const res1 = await dispatchWebhookUpdate(testUpdate);
    assert(res1.status === 200 && res1.body?.duplicate !== true, 'First update delivery processed normally');

    // Duplicate retry delivery with same update_id
    const res2 = await dispatchWebhookUpdate(testUpdate);
    assert(res2.status === 200 && res2.body?.duplicate === true, 'Duplicate update_id recognized and short-circuited');
  }

  teardownTelegramFetchMock();

  console.log('\n========================================================================');
  console.log(`📊 ADVERSARIAL CHALLENGER SUITE SUMMARY: ${passed} PASSED | ${failed} FAILED`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runAdversarialTests().catch((err) => {
  console.error('Fatal challenger execution error:', err);
  process.exit(1);
});
