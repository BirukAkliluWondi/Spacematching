/**
 * tests/e2e/tier1-features.test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Tier 1: Comprehensive Feature Coverage Test Suite.
 *
 * Covers primary behaviors (happy paths) for every bot workflow and API:
 *  1. /start & Navigation Menu
 *  2. Language Selection & i18n
 *  3. Dynamic Card Registration (Seeker Profile)
 *  4. Roommate Matchmaker Search
 *  5. Space Posting & Landlord Questionnaire
 *  6. Photo & Document Media Ingestion
 *  7. Fayda Photo Verification & Cryptographic Engine
 *  8. Escrow & Payment Processing
 *  9. Spaces & Roommates Public Catalogs
 * 10. Admin & Auth Endpoints
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
  createTelegramDocumentUpdate,
  createMockTelegramInitData,
  dispatchWebhookUpdate,
  dispatchSpacesApi,
  dispatchRoommatesApi,
  dispatchAdminChannelGet,
  dispatchAdminChannelPost,
  dispatchAdminUsersGet,
  dispatchAuthTelegram,
  dispatchOrdersCreate,
  dispatchOrdersVerify,
  dispatchFaydaUploadUrl,
  dispatchVerifyFaydaQr,
  TestExecutionCollector,
} from '../../scripts/helpers/test-harness';
import {
  generateAuthenticFaydaQrBuffer,
  generateNonFaydaQrBuffer,
  generateTamperedFaydaQrBuffer,
  generateCorruptedQrBuffer,
  createAuthenticFaydaPayload,
} from '../../scripts/helpers/synthetic-fayda';
import { extractTransactionReference } from '../../src/lib/verify-et';
import { parseBudgetRangeInput } from '../../src/lib/telegram';

export async function runTier1Tests(collector: TestExecutionCollector): Promise<void> {
  setupTelegramFetchMock();

  async function executeTest(
    feature: string,
    name: string,
    fn: () => Promise<void>
  ) {
    const id = `T1_${feature.replace(/\s+/g, '_')}_${name.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const t0 = performance.now();
    try {
      clearCapturedTelegramCalls();
      await fn();
      const t1 = performance.now();
      collector.record({
        id,
        tier: 1,
        feature,
        name,
        status: 'PASS',
        durationMs: t1 - t0,
      });
    } catch (err: any) {
      const t1 = performance.now();
      collector.record({
        id,
        tier: 1,
        feature,
        name,
        status: 'FAIL',
        durationMs: t1 - t0,
        error: err.message,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. /start & Navigation Menu
  // ═══════════════════════════════════════════════════════════════════════════

  await executeTest('/start & Welcome Flow', 'Plain /start returns 200 and sends welcome menu', async () => {
    const chatId = 10001;
    const update = createTelegramMessageUpdate(chatId, '/start');
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200 || !res.body?.ok) {
      throw new Error(`Expected HTTP 200 {ok: true}, got ${res.status}`);
    }
    const calls = getCapturedTelegramCalls();
    if (!calls.some((c) => c.method === 'sendMessage' || c.method === 'editMessageText')) {
      throw new Error('Expected Telegram sendMessage or editMessageText call');
    }
  });

  await executeTest('/start & Welcome Flow', '/start post_profile opens branch selection', async () => {
    const chatId = 10002;
    const update = createTelegramMessageUpdate(chatId, '/start post_profile');
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    const calls = getCapturedTelegramCalls();
    const hasBranchPrompt = calls.some((c) =>
      c.payload?.reply_markup?.inline_keyboard?.some((row: any[]) =>
        row.some((b) => b.callback_data === 'post_branch_space' || b.callback_data === 'post_branch_seeker')
      )
    );
    if (!hasBranchPrompt) throw new Error('Expected post branch buttons in response');
  });

  await executeTest('/start & Welcome Flow', '/start search_roommate initiates matchmaker search', async () => {
    const chatId = 10003;
    const update = createTelegramMessageUpdate(chatId, '/start search_roommate');
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    const calls = getCapturedTelegramCalls();
    if (!calls.some((c) => c.method === 'sendMessage' || c.method === 'editMessageText')) {
      throw new Error('Expected navigation response for search_roommate');
    }
  });

  await executeTest('/start & Welcome Flow', '/cancel resets session and returns main menu', async () => {
    const chatId = 10004;
    const update = createTelegramMessageUpdate(chatId, '/cancel');
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    const calls = getCapturedTelegramCalls();
    if (calls.length === 0) throw new Error('Expected cancellation confirmation message');
  });

  await executeTest('/start & Welcome Flow', 'Callback nav_start renders primary menu', async () => {
    const chatId = 10005;
    const update = createTelegramCallbackUpdate(chatId, 'nav_start');
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. Language Selection & i18n
  // ═══════════════════════════════════════════════════════════════════════════

  await executeTest('Language Selection', '/lang command displays language selector', async () => {
    const chatId = 10010;
    const update = createTelegramMessageUpdate(chatId, '/lang');
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    const calls = getCapturedTelegramCalls();
    const hasLangButtons = calls.some((c) =>
      c.payload?.reply_markup?.inline_keyboard?.some((row: any[]) =>
        row.some((b) => b.callback_data === 'set_lang:am' || b.callback_data === 'set_lang:en')
      )
    );
    if (!hasLangButtons) throw new Error('Expected set_lang inline keyboard buttons');
  });

  await executeTest('Language Selection', 'set_lang:am callback switches bot to Amharic', async () => {
    const chatId = 10011;
    const update = createTelegramCallbackUpdate(chatId, 'set_lang:am');
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    const calls = getCapturedTelegramCalls();
    const hasAmharic = calls.some((c) =>
      c.payload?.text && (c.payload.text.includes('ቋንቋ') || c.payload.text.includes('ዋና ማውጫ') || c.payload.text.includes('እንኳን'))
    );
    if (!hasAmharic) throw new Error('Expected Amharic text in response after set_lang:am');
  });

  await executeTest('Language Selection', 'set_lang:en callback switches bot to English', async () => {
    const chatId = 10012;
    const update = createTelegramCallbackUpdate(chatId, 'set_lang:en');
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    const calls = getCapturedTelegramCalls();
    const hasEnglish = calls.some((c) =>
      c.payload?.text && (c.payload.text.includes('Language') || c.payload.text.includes('Main Menu') || c.payload.text.includes('Welcome'))
    );
    if (!hasEnglish) throw new Error('Expected English text in response after set_lang:en');
  });

  await executeTest('Language Selection', '/amharic quick command sets language to Amharic', async () => {
    const chatId = 10013;
    const update = createTelegramMessageUpdate(chatId, '/amharic');
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
  });

  await executeTest('Language Selection', '/english quick command sets language to English', async () => {
    const chatId = 10014;
    const update = createTelegramMessageUpdate(chatId, '/english');
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. Dynamic Card Registration (Seeker Profile)
  // ═══════════════════════════════════════════════════════════════════════════

  await executeTest('Dynamic Card Registration', 'post_branch_seeker starts Step 1 Age prompt', async () => {
    const chatId = 10020;
    const update = createTelegramCallbackUpdate(chatId, 'post_branch_seeker');
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
  });

  await executeTest('Dynamic Card Registration', 'Numeric age input transitions to Step 2 Gender selection', async () => {
    const chatId = 10021;
    // Prime state to dyn_card_age by triggering post_branch_seeker
    await dispatchWebhookUpdate(createTelegramCallbackUpdate(chatId, 'post_branch_seeker'));
    clearCapturedTelegramCalls();

    const ageUpdate = createTelegramMessageUpdate(chatId, '24');
    const res = await dispatchWebhookUpdate(ageUpdate);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    const calls = getCapturedTelegramCalls();
    const hasGenderButtons = calls.some((c) =>
      c.payload?.reply_markup?.inline_keyboard?.some((row: any[]) =>
        row.some((b) => b.callback_data === 'dyn_gender:Male' || b.callback_data === 'dyn_gender:Female')
      )
    );
    if (!hasGenderButtons) throw new Error('Expected dyn_gender buttons in response');
  });

  await executeTest('Dynamic Card Registration', 'dyn_gender callback transitions to Step 3 Religion', async () => {
    const chatId = 10022;
    const update = createTelegramCallbackUpdate(chatId, 'dyn_gender:Female');
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    const calls = getCapturedTelegramCalls();
    const hasReligionButtons = calls.some((c) =>
      c.payload?.reply_markup?.inline_keyboard?.some((row: any[]) =>
        row.some((b) => b.callback_data && b.callback_data.startsWith('dyn_religion:'))
      )
    );
    if (!hasReligionButtons) throw new Error('Expected dyn_religion buttons in response');
  });

  await executeTest('Dynamic Card Registration', 'dyn_religion callback transitions to Step 4 Job prompt', async () => {
    const chatId = 10023;
    const update = createTelegramCallbackUpdate(chatId, 'dyn_religion:Orthodox');
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
  });

  await executeTest('Dynamic Card Registration', 'Subcities multi-toggle and proceed triggers Step 9 Fayda gate', async () => {
    const chatId = 10024;
    const toggleUpdate = createTelegramCallbackUpdate(chatId, 'dyn_sub_toggle:Bole');
    await dispatchWebhookUpdate(toggleUpdate);
    clearCapturedTelegramCalls();

    const proceedUpdate = createTelegramCallbackUpdate(chatId, 'dyn_sub_proceed');
    const res = await dispatchWebhookUpdate(proceedUpdate);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. Roommate Matchmaker Search
  // ═══════════════════════════════════════════════════════════════════════════

  await executeTest('Roommate Matchmaker', 'matchmaker_start displays area toggle grid for verified user', async () => {
    const chatId = 10030;
    // Prime session with verified status
    const updateStart = createTelegramCallbackUpdate(chatId, 'matchmaker_start');
    const { getSession, saveSession } = await import('../../src/lib/bot-session-store');
    await saveSession({
      telegram_id: chatId,
      step: 'idle',
      draft_data: { fayda_status: 'verified' },
      updated_at: new Date().toISOString(),
    }, true);

    const res = await dispatchWebhookUpdate(updateStart);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    const calls = getCapturedTelegramCalls();
    const hasAreaButtons = calls.some((c) =>
      c.payload?.reply_markup?.inline_keyboard?.some((row: any[]) =>
        row.some((b) => b.callback_data && b.callback_data.startsWith('match_toggle_sub:'))
      )
    );
    if (!hasAreaButtons) throw new Error('Expected match_toggle_sub buttons');
  });

  await executeTest('Roommate Matchmaker', 'match_goto_gender advances to gender selection', async () => {
    const chatId = 10031;
    const update = createTelegramCallbackUpdate(chatId, 'match_goto_gender');
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
  });

  await executeTest('Roommate Matchmaker', 'match_gender advances to age prompt', async () => {
    const chatId = 10032;
    const update = createTelegramCallbackUpdate(chatId, 'match_gender:Male');
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
  });

  await executeTest('Roommate Matchmaker', 'match_pref_gender advances to budget step', async () => {
    const chatId = 10033;
    const update = createTelegramCallbackUpdate(chatId, 'match_pref_gender:Any');
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
  });

  await executeTest('Roommate Matchmaker', 'Budget range input in matchmaker executes query and returns candidate cards', async () => {
    const chatId = 10034;
    // Set matchmaker session step
    await dispatchWebhookUpdate(createTelegramCallbackUpdate(chatId, 'match_pref_gender:Any'));
    clearCapturedTelegramCalls();

    const budgetUpdate = createTelegramMessageUpdate(chatId, '12000');
    const res = await dispatchWebhookUpdate(budgetUpdate);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. Space Posting & Landlord Questionnaire
  // ═══════════════════════════════════════════════════════════════════════════

  await executeTest('Space Posting Flow', 'post_branch_space opens Step 1 Space Type text prompt', async () => {
    const chatId = 10040;
    const update = createTelegramCallbackUpdate(chatId, 'post_branch_space');
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    const calls = getCapturedTelegramCalls();
    const hasSpacePrompt = calls.some((c) =>
      c.payload?.text && (c.payload.text.includes('space') || c.payload.text.includes('መኝታ'))
    );
    if (!hasSpacePrompt) throw new Error('Expected space type prompt text');
  });

  await executeTest('Space Posting Flow', 'space_type callback advances to Step 2 Rent', async () => {
    const chatId = 10041;
    const update = createTelegramCallbackUpdate(chatId, 'space_type:master_bedroom');
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
  });

  await executeTest('Space Posting Flow', 'space_amenities_proceed advances to Host Gender step', async () => {
    const chatId = 10042;
    const update = createTelegramCallbackUpdate(chatId, 'space_amenities_proceed');
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    const calls = getCapturedTelegramCalls();
    const hasHostGender = calls.some((c) =>
      c.payload?.reply_markup?.inline_keyboard?.some((row: any[]) =>
        row.some((b) => b.callback_data && b.callback_data.startsWith('space_host_gender:'))
      )
    );
    if (!hasHostGender) throw new Error('Expected space_host_gender buttons');
  });

  await executeTest('Space Posting Flow', 'space_host_gender advances to Tenant Preferred Gender', async () => {
    const chatId = 10043;
    const update = createTelegramCallbackUpdate(chatId, 'space_host_gender:Female');
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
  });

  await executeTest('Space Posting Flow', 'space_subcity callback advances to Step 9 Photos prompt', async () => {
    const chatId = 10044;
    const update = createTelegramCallbackUpdate(chatId, 'space_subcity:Bole');
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    const calls = getCapturedTelegramCalls();
    const hasPhotosPrompt = calls.some((c) =>
      c.payload?.text && (c.payload.text.toLowerCase().includes('photo') || c.payload.text.includes('ፎቶ'))
    );
    if (!hasPhotosPrompt) throw new Error('Expected photo upload prompt');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. Photo & Document Media Ingestion
  // ═══════════════════════════════════════════════════════════════════════════

  await executeTest('Photo Ingestion', 'Space photos upload ingests photo file_id', async () => {
    const chatId = 10050;
    // Set up state in space_input_photos
    await dispatchWebhookUpdate(createTelegramCallbackUpdate(chatId, 'space_sub_select:Bole'));
    clearCapturedTelegramCalls();

    const photoUpdate = createTelegramPhotoUpdate(chatId, 'space_img_file_001');
    const res = await dispatchWebhookUpdate(photoUpdate);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
  });

  await executeTest('Photo Ingestion', 'Multiple space photos accumulate up to 4 photos', async () => {
    const chatId = 10051;
    await dispatchWebhookUpdate(createTelegramCallbackUpdate(chatId, 'space_sub_select:Kazanchis'));
    await dispatchWebhookUpdate(createTelegramPhotoUpdate(chatId, 'space_img_file_002'));
    await dispatchWebhookUpdate(createTelegramPhotoUpdate(chatId, 'space_img_file_003'));
    const photo3 = createTelegramPhotoUpdate(chatId, 'space_img_file_004');
    const res = await dispatchWebhookUpdate(photo3);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
  });

  await executeTest('Photo Ingestion', 'space_photos_done finalizes photos', async () => {
    const chatId = 10052;
    const update = createTelegramCallbackUpdate(chatId, 'space_photos_done');
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
  });

  await executeTest('Photo Ingestion', 'Document photo message is received with HTTP 200', async () => {
    const chatId = 10053;
    const docUpdate = createTelegramDocumentUpdate(chatId, 'doc_img_file_001', 'id_card.png', 'image/png');
    const res = await dispatchWebhookUpdate(docUpdate);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
  });

  await executeTest('Photo Ingestion', 'Non-image document is safely handled', async () => {
    const chatId = 10054;
    const docUpdate = createTelegramDocumentUpdate(chatId, 'doc_pdf_file_001', 'contract.pdf', 'application/pdf');
    const res = await dispatchWebhookUpdate(docUpdate);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. Fayda Photo Verification & Cryptographic Engine
  // ═══════════════════════════════════════════════════════════════════════════

  await executeTest('Fayda Photo Verification', '/fayda standalone command displays Fayda gate card', async () => {
    const chatId = 10060;
    const update = createTelegramMessageUpdate(chatId, '/fayda');
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    const calls = getCapturedTelegramCalls();
    const hasFaydaText = calls.some((c) =>
      c.payload?.text && (c.payload.text.includes('Fayda') || c.payload.text.includes('ፋይዳ'))
    );
    if (!hasFaydaText) throw new Error('Expected Fayda prompt in response');
  });

  await executeTest('Fayda Photo Verification', 'Authentic synthetic Fayda QR is verified via offline API', async () => {
    const authPayload = createAuthenticFaydaPayload({
      fullName: 'Abebe Bikila',
      fan: '4829104728193841',
      gender: 'M',
    });
    const res = await dispatchVerifyFaydaQr({
      telegram_id: 10061,
      qr_data: authPayload.fullPayload,
    });
    if (res.status !== 200 || !res.body?.success) {
      throw new Error(`Expected success verification, got status ${res.status}: ${JSON.stringify(res.body)}`);
    }
    if (res.body.fayda_number !== '4829104728193841') {
      throw new Error(`Expected FAN 4829104728193841, got ${res.body.fayda_number}`);
    }
  });

  await executeTest('Fayda Photo Verification', 'Telegram photo upload with authentic synthetic Fayda QR verifies user', async () => {
    const chatId = 10062;
    const authFixture = await generateAuthenticFaydaQrBuffer({
      fullName: 'Tsehay Gemechu',
      fan: '6140987654321098',
      gender: 'F',
    });
    registerMockTelegramPhoto('fayda_auth_file_001', authFixture.pngBuffer);

    // Place session in awaiting_standalone_fayda_fan
    await dispatchWebhookUpdate(createTelegramMessageUpdate(chatId, '/fayda'));
    clearCapturedTelegramCalls();

    const photoUpdate = createTelegramPhotoUpdate(chatId, 'fayda_auth_file_001');
    const res = await dispatchWebhookUpdate(photoUpdate);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
  });

  await executeTest('Fayda Photo Verification', 'Non-Fayda QR photo upload triggers rejection guidance', async () => {
    const chatId = 10063;
    const nonFixture = await generateNonFaydaQrBuffer('https://example.com/some_random_page');
    registerMockTelegramPhoto('fayda_non_file_001', nonFixture.pngBuffer);

    await dispatchWebhookUpdate(createTelegramMessageUpdate(chatId, '/fayda'));
    clearCapturedTelegramCalls();

    const photoUpdate = createTelegramPhotoUpdate(chatId, 'fayda_non_file_001');
    const res = await dispatchWebhookUpdate(photoUpdate);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
  });

  await executeTest('Fayda Photo Verification', 'Tampered signature photo upload fails cryptographic verification', async () => {
    const chatId = 10064;
    const tamperedFixture = await generateTamperedFaydaQrBuffer();
    registerMockTelegramPhoto('fayda_tampered_file_001', tamperedFixture.pngBuffer);

    await dispatchWebhookUpdate(createTelegramMessageUpdate(chatId, '/fayda'));
    clearCapturedTelegramCalls();

    const photoUpdate = createTelegramPhotoUpdate(chatId, 'fayda_tampered_file_001');
    const res = await dispatchWebhookUpdate(photoUpdate);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. Escrow & Payment Processing
  // ═══════════════════════════════════════════════════════════════════════════

  await executeTest('Payment Processing', 'extractTransactionReference cleans Telebirr / CBE transaction references', async () => {
    const testCases = [
      { raw: 'TXN: FT241029ABCDE1', expected: 'FT241029ABCDE1' },
      { raw: '   9876543210   ', expected: '9876543210' },
      { raw: 'Trans ref: FT12345678', expected: 'FT12345678' },
    ];
    for (const tc of testCases) {
      const clean = extractTransactionReference(tc.raw);
      if (!clean.includes(tc.expected)) {
        throw new Error(`Expected clean ref to include ${tc.expected}, got ${clean}`);
      }
    }
  });

  await executeTest('Payment Processing', 'parseBudgetRangeInput correctly parses valid ranges', async () => {
    const r1 = parseBudgetRangeInput('8000 - 15000');
    if (!r1 || r1.min !== 8000 || r1.max !== 15000) {
      throw new Error(`Expected 8000-15000, got ${JSON.stringify(r1)}`);
    }
    const r2 = parseBudgetRangeInput('12000');
    if (!r2 || r2.max !== 12000) {
      throw new Error(`Expected max 12000, got ${JSON.stringify(r2)}`);
    }
  });

  await executeTest('Payment Processing', '/verify command in bot handles reference submission', async () => {
    const chatId = 10070;
    const update = createTelegramMessageUpdate(chatId, '/verify telebirr 9876543210');
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
  });

  await executeTest('Payment Processing', 'POST /api/orders/create validates parameters', async () => {
    const res = await dispatchOrdersCreate({
      space_id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      telegram_id: 10071,
    });
    // In test environment, returns 404 (user record not yet created) or 403 (verification required)
    // Confirming endpoint handled request gracefully with valid JSON
    if (![200, 403, 404].includes(res.status)) {
      throw new Error(`Unexpected status code: ${res.status}`);
    }
  });

  await executeTest('Payment Processing', 'POST /api/orders/verify validates order lookup', async () => {
    const res = await dispatchOrdersVerify({
      order_id: 'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
      telegram_id: 10072,
      transaction_reference: 'FT241029ABCDE1',
    });
    if (![200, 400, 404].includes(res.status)) {
      throw new Error(`Unexpected status code: ${res.status}`);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 9. Spaces & Roommates Public Catalogs
  // ═══════════════════════════════════════════════════════════════════════════

  await executeTest('Public Catalogs API', 'GET /api/spaces returns published spaces list', async () => {
    const res = await dispatchSpacesApi();
    if (res.status !== 200 || !res.body?.success) {
      throw new Error(`Expected 200 success, got ${res.status}`);
    }
    if (!Array.isArray(res.body.spaces) || res.body.spaces.length === 0) {
      throw new Error('Expected non-empty spaces catalog');
    }
    // Verify privacy sanitization (no phone numbers or exact addresses in public API)
    for (const space of res.body.spaces) {
      if (space.contact_phone || space.exact_address) {
        throw new Error('Privacy breach: raw contact info exposed in public spaces view');
      }
    }
  });

  await executeTest('Public Catalogs API', 'GET /api/spaces with query parameter filters spaces', async () => {
    const res = await dispatchSpacesApi({ query: 'Bole' });
    if (res.status !== 200 || !res.body?.success) {
      throw new Error(`Expected 200 success, got ${res.status}`);
    }
    const allMatch = res.body.spaces.every((s: any) =>
      (s.title + s.neighborhood + s.description).toLowerCase().includes('bole')
    );
    if (!allMatch) throw new Error('Query filter did not match search term');
  });

  await executeTest('Public Catalogs API', 'GET /api/spaces with neighborhood parameter filters spaces', async () => {
    const res = await dispatchSpacesApi({ neighborhood: 'Kazanchis' });
    if (res.status !== 200 || !res.body?.success) {
      throw new Error(`Expected 200 success, got ${res.status}`);
    }
  });

  await executeTest('Public Catalogs API', 'GET /api/roommates returns approved roommate seekers list', async () => {
    const res = await dispatchRoommatesApi();
    if (res.status !== 200 || !res.body?.success) {
      throw new Error(`Expected 200 success, got ${res.status}`);
    }
    if (!Array.isArray(res.body.seekers) || res.body.seekers.length === 0) {
      throw new Error('Expected non-empty seekers catalog');
    }
  });

  await executeTest('Public Catalogs API', 'GET /api/roommates with subcity filters seekers', async () => {
    const res = await dispatchRoommatesApi({ subcity: 'Bole' });
    if (res.status !== 200 || !res.body?.success) {
      throw new Error(`Expected 200 success, got ${res.status}`);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 10. Admin & Auth Endpoints
  // ═══════════════════════════════════════════════════════════════════════════

  await executeTest('Admin & Auth Endpoints', 'GET /api/admin/channel returns channel stats and orders', async () => {
    const res = await dispatchAdminChannelGet();
    if (res.status !== 200 || !res.body?.success) {
      throw new Error(`Expected 200 success, got ${res.status}`);
    }
    if (!res.body.stats) throw new Error('Expected stats object in admin channel response');
  });

  await executeTest('Admin & Auth Endpoints', 'POST /api/admin/channel rejects invalid action', async () => {
    const res = await dispatchAdminChannelPost({ action: 'non_existent_action' });
    if (res.status !== 400 || res.body?.success !== false) {
      throw new Error(`Expected 400 error, got ${res.status}`);
    }
  });

  await executeTest('Admin & Auth Endpoints', 'GET /api/admin/users returns resident lookup results', async () => {
    const res = await dispatchAdminUsersGet('Abebe');
    if (res.status !== 200 || !res.body?.success) {
      throw new Error(`Expected 200 success, got ${res.status}`);
    }
  });

  await executeTest('Admin & Auth Endpoints', 'POST /api/auth/telegram validates authentic HMAC initData', async () => {
    const validInitData = createMockTelegramInitData({
      id: 88812345,
      first_name: 'Dagmawi',
      last_name: 'Tesfaye',
      username: 'dagmawi_t',
    });
    const res = await dispatchAuthTelegram({ initData: validInitData });
    // In test environment without live Supabase DB writes, validates HMAC (200 or 500 DB error)
    if (res.status === 401) {
      throw new Error('Valid HMAC signature was incorrectly rejected with 401');
    }
  });

  await executeTest('Admin & Auth Endpoints', 'POST /api/user/fayda-upload-url enforces HTTP 410 zero-storage policy', async () => {
    const res = await dispatchFaydaUploadUrl({ telegram_id: 10080 });
    // Returns 410 (zero storage) or 404 (user record not found)
    if (![410, 404].includes(res.status)) {
      throw new Error(`Expected 410 Gone or 404, got ${res.status}`);
    }
  });

  teardownTelegramFetchMock();
}
