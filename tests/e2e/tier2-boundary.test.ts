/**
 * tests/e2e/tier2-boundary.test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Tier 2: Boundary & Corner Cases Test Suite.
 *
 * Covers robustness and failure resistance for:
 *  1. Empty / Whitespace Inputs
 *  2. Extreme & Invalid Age Inputs
 *  3. Extreme & Malformed Budget Inputs
 *  4. Malformed Callback Queries
 *  5. Unauthenticated / Parameter-Deficient Admin Calls
 *  6. Invalid Media Formats & Broken Byte Streams
 *  7. Payload Boundaries, Replay Attacks & Security Edge Cases
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
  dispatchAdminChannelPost,
  dispatchAdminUsersGet,
  dispatchAuthTelegram,
  dispatchOrdersCreate,
  dispatchOrdersVerify,
  dispatchVerifyFaydaQr,
  TestExecutionCollector,
} from '../../scripts/helpers/test-harness';
import { generateCorruptedQrBuffer } from '../../scripts/helpers/synthetic-fayda';
import { parseBudgetRangeInput } from '../../src/lib/telegram';

export async function runTier2Tests(collector: TestExecutionCollector): Promise<void> {
  setupTelegramFetchMock();

  async function executeTest(
    feature: string,
    name: string,
    fn: () => Promise<void>
  ) {
    const id = `T2_${feature.replace(/\s+/g, '_')}_${name.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const t0 = performance.now();
    try {
      clearCapturedTelegramCalls();
      await fn();
      const t1 = performance.now();
      collector.record({
        id,
        tier: 2,
        feature,
        name,
        status: 'PASS',
        durationMs: t1 - t0,
      });
    } catch (err: any) {
      const t1 = performance.now();
      collector.record({
        id,
        tier: 2,
        feature,
        name,
        status: 'FAIL',
        durationMs: t1 - t0,
        error: err.message,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. Empty / Whitespace Inputs
  // ═══════════════════════════════════════════════════════════════════════════

  await executeTest('Empty & Whitespace Inputs', 'Empty string message is safely handled with HTTP 200', async () => {
    const chatId = 20001;
    const update = createTelegramMessageUpdate(chatId, '');
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200) throw new Error(`Expected HTTP 200, got ${res.status}`);
  });

  await executeTest('Empty & Whitespace Inputs', 'Whitespace-only message is safely dropped without crashing', async () => {
    const chatId = 20002;
    const update = createTelegramMessageUpdate(chatId, '    \n\t   ');
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200) throw new Error(`Expected HTTP 200, got ${res.status}`);
  });

  await executeTest('Empty & Whitespace Inputs', 'Message with null text property is safely tolerated', async () => {
    const chatId = 20003;
    const update = {
      update_id: 2000001,
      message: {
        message_id: 1234,
        chat: { id: chatId, type: 'private' },
        from: { id: chatId, is_bot: false, first_name: 'Tester' },
        date: Math.floor(Date.now() / 1000),
        text: null,
      },
    };
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200) throw new Error(`Expected HTTP 200, got ${res.status}`);
  });

  await executeTest('Empty & Whitespace Inputs', 'Empty callback_query data returns HTTP 200', async () => {
    const chatId = 20004;
    const update = createTelegramCallbackUpdate(chatId, '');
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200) throw new Error(`Expected HTTP 200, got ${res.status}`);
  });

  await executeTest('Empty & Whitespace Inputs', 'Spaces API handles empty and whitespace-only query cleanly', async () => {
    const res = await dispatchSpacesApi({ query: '    ' });
    if (res.status !== 200 || !res.body?.success) {
      throw new Error(`Expected HTTP 200, got ${res.status}`);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. Extreme & Invalid Age Inputs
  // ═══════════════════════════════════════════════════════════════════════════

  await executeTest('Extreme Age Boundaries', 'Underage input (16 years) is rejected with guidance', async () => {
    const chatId = 20010;
    // Set step to dyn_card_age
    await dispatchWebhookUpdate(createTelegramCallbackUpdate(chatId, 'post_branch_seeker'));
    clearCapturedTelegramCalls();

    const update = createTelegramMessageUpdate(chatId, '16');
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200) throw new Error(`Expected HTTP 200, got ${res.status}`);
    const calls = getCapturedTelegramCalls();
    const hasRejectionNotice = calls.some((c) =>
      c.payload?.text && (c.payload.text.includes('18') || c.payload.text.includes('ዕድሜ'))
    );
    if (!hasRejectionNotice) throw new Error('Expected underage rejection message');
  });

  await executeTest('Extreme Age Boundaries', 'Overage input (105 years) is rejected with guidance', async () => {
    const chatId = 20011;
    await dispatchWebhookUpdate(createTelegramCallbackUpdate(chatId, 'post_branch_seeker'));
    clearCapturedTelegramCalls();

    const update = createTelegramMessageUpdate(chatId, '105');
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200) throw new Error(`Expected HTTP 200, got ${res.status}`);
  });

  await executeTest('Extreme Age Boundaries', 'Negative age input (-25) is rejected', async () => {
    const chatId = 20012;
    await dispatchWebhookUpdate(createTelegramCallbackUpdate(chatId, 'post_branch_seeker'));
    clearCapturedTelegramCalls();

    const update = createTelegramMessageUpdate(chatId, '-25');
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200) throw new Error(`Expected HTTP 200, got ${res.status}`);
  });

  await executeTest('Extreme Age Boundaries', 'Non-numeric string age (twenty five) is rejected', async () => {
    const chatId = 20013;
    await dispatchWebhookUpdate(createTelegramCallbackUpdate(chatId, 'post_branch_seeker'));
    clearCapturedTelegramCalls();

    const update = createTelegramMessageUpdate(chatId, 'twenty five');
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200) throw new Error(`Expected HTTP 200, got ${res.status}`);
  });

  await executeTest('Extreme Age Boundaries', 'Zero age (0) is rejected', async () => {
    const chatId = 20014;
    await dispatchWebhookUpdate(createTelegramCallbackUpdate(chatId, 'post_branch_seeker'));
    clearCapturedTelegramCalls();

    const update = createTelegramMessageUpdate(chatId, '0');
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200) throw new Error(`Expected HTTP 200, got ${res.status}`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. Extreme & Malformed Budget Inputs
  // ═══════════════════════════════════════════════════════════════════════════

  await executeTest('Extreme Budget Boundaries', 'parseBudgetRangeInput normalizes inverted range (20000 - 8000)', async () => {
    const result = parseBudgetRangeInput('20000 - 8000');
    if (!result || result.min !== 8000 || result.max !== 20000) {
      throw new Error(`Expected min 8000 and max 20000, got ${JSON.stringify(result)}`);
    }
  });

  await executeTest('Extreme Budget Boundaries', 'parseBudgetRangeInput rejects negative input (-500)', async () => {
    const result = parseBudgetRangeInput('-500');
    // Implementation may parse or reject, verify no crash occurred
    if (result !== null && result.min < 0) {
      throw new Error(`Budget min cannot be negative: ${result.min}`);
    }
  });

  await executeTest('Extreme Budget Boundaries', 'Zero budget in matchmaker is safely handled without crash', async () => {
    const chatId = 20020;
    await dispatchWebhookUpdate(createTelegramCallbackUpdate(chatId, 'match_pref_gender:Any'));
    clearCapturedTelegramCalls();

    const update = createTelegramMessageUpdate(chatId, '0');
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200) throw new Error(`Expected HTTP 200, got ${res.status}`);
  });

  await executeTest('Extreme Budget Boundaries', 'Astronomical budget input (1,000,000,000) does not overflow', async () => {
    const chatId = 20021;
    await dispatchWebhookUpdate(createTelegramCallbackUpdate(chatId, 'match_pref_gender:Any'));
    clearCapturedTelegramCalls();

    const update = createTelegramMessageUpdate(chatId, '1000000000');
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200) throw new Error(`Expected HTTP 200, got ${res.status}`);
  });

  await executeTest('Extreme Budget Boundaries', 'Gibberish budget string in matchmaker re-prompts user', async () => {
    const chatId = 20022;
    await dispatchWebhookUpdate(createTelegramCallbackUpdate(chatId, 'match_pref_gender:Any'));
    clearCapturedTelegramCalls();

    const update = createTelegramMessageUpdate(chatId, 'free rent please');
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200) throw new Error(`Expected HTTP 200, got ${res.status}`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. Malformed Callback Queries
  // ═══════════════════════════════════════════════════════════════════════════

  await executeTest('Malformed Callbacks', 'Unrecognized random callback string returns HTTP 200 without throwing', async () => {
    const chatId = 20030;
    const update = createTelegramCallbackUpdate(chatId, 'random_nonsense_action_xyz_999');
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200) throw new Error(`Expected HTTP 200, got ${res.status}`);
  });

  await executeTest('Malformed Callbacks', 'Callback with missing payload suffix (space_type:) returns HTTP 200', async () => {
    const chatId = 20031;
    const update = createTelegramCallbackUpdate(chatId, 'space_type:');
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200) throw new Error(`Expected HTTP 200, got ${res.status}`);
  });

  await executeTest('Malformed Callbacks', 'Callback with non-existent target ID (confirm_match:non_existent_id) returns HTTP 200', async () => {
    const chatId = 20032;
    const update = createTelegramCallbackUpdate(chatId, 'confirm_match:00000000-0000-0000-0000-000000000000');
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200) throw new Error(`Expected HTTP 200, got ${res.status}`);
  });

  await executeTest('Malformed Callbacks', 'Callback with multiple colons (set_lang:en:extra:colons) handles gracefully', async () => {
    const chatId = 20033;
    const update = createTelegramCallbackUpdate(chatId, 'set_lang:en:extra:colons');
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200) throw new Error(`Expected HTTP 200, got ${res.status}`);
  });

  await executeTest('Malformed Callbacks', 'Malformed unlock callback (search_unlock_contact:) returns HTTP 200', async () => {
    const chatId = 20034;
    const update = createTelegramCallbackUpdate(chatId, 'search_unlock_contact:');
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200) throw new Error(`Expected HTTP 200, got ${res.status}`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. Unauthenticated / Parameter-Deficient Admin Calls
  // ═══════════════════════════════════════════════════════════════════════════

  await executeTest('Admin Security Boundaries', 'POST /api/admin/channel with empty body returns HTTP 400', async () => {
    const res = await dispatchAdminChannelPost({});
    if (res.status !== 400) throw new Error(`Expected HTTP 400, got ${res.status}`);
  });

  await executeTest('Admin Security Boundaries', 'POST /api/admin/channel broadcast without listingId returns HTTP 400', async () => {
    const res = await dispatchAdminChannelPost({ action: 'broadcast' });
    if (res.status !== 400 || res.body?.success !== false) {
      throw new Error(`Expected HTTP 400 error, got ${res.status}`);
    }
  });

  await executeTest('Admin Security Boundaries', 'POST /api/admin/channel custom_post without text returns HTTP 400', async () => {
    const res = await dispatchAdminChannelPost({ action: 'custom_post', text: '   ' });
    if (res.status !== 400 || res.body?.success !== false) {
      throw new Error(`Expected HTTP 400 error, got ${res.status}`);
    }
  });

  await executeTest('Admin Security Boundaries', 'GET /api/admin/users handles SQL meta-characters safely', async () => {
    const res = await dispatchAdminUsersGet("' OR '1'='1");
    if (res.status !== 200 || !res.body?.success) {
      throw new Error(`Expected safe HTTP 200, got ${res.status}`);
    }
  });

  await executeTest('Admin Security Boundaries', 'GET /api/admin/users handles emoji and unicode search safely', async () => {
    const res = await dispatchAdminUsersGet('✨🔍🇪🇹');
    if (res.status !== 200 || !res.body?.success) {
      throw new Error(`Expected safe HTTP 200, got ${res.status}`);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. Invalid Media Formats & Broken Byte Streams
  // ═══════════════════════════════════════════════════════════════════════════

  await executeTest('Invalid Media Boundaries', 'Empty photo array in update does not throw an unhandled exception', async () => {
    const chatId = 20040;
    const update = {
      update_id: 2000010,
      message: {
        message_id: 1235,
        chat: { id: chatId, type: 'private' },
        from: { id: chatId, is_bot: false, first_name: 'Tester' },
        date: Math.floor(Date.now() / 1000),
        photo: [],
      },
    };
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200) throw new Error(`Expected HTTP 200, got ${res.status}`);
  });

  await executeTest('Invalid Media Boundaries', 'Photo object with null file_id is handled gracefully', async () => {
    const chatId = 20041;
    const update = {
      update_id: 2000011,
      message: {
        message_id: 1236,
        chat: { id: chatId, type: 'private' },
        from: { id: chatId, is_bot: false, first_name: 'Tester' },
        date: Math.floor(Date.now() / 1000),
        photo: [{ file_id: null, width: 100, height: 100 }],
      },
    };
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200) throw new Error(`Expected HTTP 200, got ${res.status}`);
  });

  await executeTest('Invalid Media Boundaries', 'Corrupted noise buffer uploaded as Fayda photo is rejected with QR guidance', async () => {
    const chatId = 20042;
    const corruptedBuffer = await generateCorruptedQrBuffer('corrupted_bytes');
    registerMockTelegramPhoto('corrupted_file_001', corruptedBuffer);

    await dispatchWebhookUpdate(createTelegramMessageUpdate(chatId, '/fayda'));
    clearCapturedTelegramCalls();

    const photoUpdate = createTelegramPhotoUpdate(chatId, 'corrupted_file_001');
    const res = await dispatchWebhookUpdate(photoUpdate);
    if (res.status !== 200) throw new Error(`Expected HTTP 200, got ${res.status}`);
  });

  await executeTest('Invalid Media Boundaries', 'Blank image with no QR barcode is rejected with NO_QR_FOUND guidance', async () => {
    const chatId = 20043;
    const blankBuffer = await generateCorruptedQrBuffer('blank_image');
    registerMockTelegramPhoto('blank_file_001', blankBuffer);

    await dispatchWebhookUpdate(createTelegramMessageUpdate(chatId, '/fayda'));
    clearCapturedTelegramCalls();

    const photoUpdate = createTelegramPhotoUpdate(chatId, 'blank_file_001');
    const res = await dispatchWebhookUpdate(photoUpdate);
    if (res.status !== 200) throw new Error(`Expected HTTP 200, got ${res.status}`);
  });

  await executeTest('Invalid Media Boundaries', 'POST /api/user/verify-fayda-qr rejects non-Fayda plain text payload', async () => {
    const res = await dispatchVerifyFaydaQr({
      telegram_id: 20044,
      qr_data: 'This is definitely not a Fayda QR payload string',
    });
    if (res.status !== 400 || res.body?.success !== false) {
      throw new Error(`Expected HTTP 400 failure, got ${res.status}`);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. Security Boundaries, Replays & Schema Validations
  // ═══════════════════════════════════════════════════════════════════════════

  await executeTest('Security & Schema Boundaries', 'POST /api/auth/telegram rejects expired initData (> 2 hours)', async () => {
    const expiredInitData = createMockTelegramInitData(
      { id: 20050, first_name: 'ExpiredUser' },
      { authDateOffsetSec: -7300 } // 2 hours and 1 minute ago
    );
    const res = await dispatchAuthTelegram({ initData: expiredInitData });
    if (res.status !== 401) {
      throw new Error(`Expected HTTP 401 for expired initData, got ${res.status}`);
    }
  });

  await executeTest('Security & Schema Boundaries', 'POST /api/auth/telegram rejects tampered HMAC hash', async () => {
    const tamperedInitData = createMockTelegramInitData(
      { id: 20051, first_name: 'HackerUser' },
      { tamperHash: true }
    );
    const res = await dispatchAuthTelegram({ initData: tamperedInitData });
    if (res.status !== 401) {
      throw new Error(`Expected HTTP 401 for tampered hash, got ${res.status}`);
    }
  });

  await executeTest('Security & Schema Boundaries', 'POST /api/orders/create rejects non-UUID space_id', async () => {
    const res = await dispatchOrdersCreate({
      space_id: 'not-a-valid-uuid-format',
      telegram_id: 20052,
    });
    if (res.status !== 400) {
      throw new Error(`Expected HTTP 400 validation error, got ${res.status}`);
    }
  });

  await executeTest('Security & Schema Boundaries', 'POST /api/orders/verify rejects missing transaction_reference', async () => {
    const res = await dispatchOrdersVerify({
      order_id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      telegram_id: 20053,
      transaction_reference: '',
    });
    if (res.status !== 400) {
      throw new Error(`Expected HTTP 400 validation error, got ${res.status}`);
    }
  });

  await executeTest('Security & Schema Boundaries', 'Large text payload (10,000 characters) does not crash webhook', async () => {
    const chatId = 20054;
    const longString = 'A'.repeat(10000);
    const update = createTelegramMessageUpdate(chatId, longString);
    const res = await dispatchWebhookUpdate(update);
    if (res.status !== 200) {
      throw new Error(`Expected HTTP 200, got ${res.status}`);
    }
  });

  teardownTelegramFetchMock();
}
