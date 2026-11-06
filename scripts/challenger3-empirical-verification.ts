/**
 * scripts/challenger3-empirical-verification.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Empirical Deep-Verification Test Suite:
 * 1. Amharic budget range parser: "8 ሺህ - 15 ሺህ", negative inputs, unicode boundaries
 * 2. Contact reveal dossier sanitization: absolute elimination of "admin:980853835" placeholders
 * 3. In-memory Fayda duplicate detection across users and roommate_profiles tables
 * 4. Concurrent match_accept idempotency and lock deduplication
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

import { parseBudgetRangeInput, parseNumericInput } from '../src/lib/telegram';
import { verifyFaydaPhotoUpload, FAYDA_ERROR_GUIDANCE } from '../src/lib/bot/fayda-photo-verifier';
import { generateAuthenticFaydaQrBuffer } from './helpers/synthetic-fayda';
import { supabaseAdmin } from '../src/lib/supabase-server';
import {
  setupTelegramFetchMock,
  teardownTelegramFetchMock,
  clearCapturedTelegramCalls,
  getCapturedTelegramCalls,
  createTelegramCallbackUpdate,
  dispatchWebhookUpdate,
} from './helpers/test-harness';

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`  ✅ [PASS] ${testName}`);
    passed++;
  } else {
    console.error(`  ❌ [FAIL] ${testName} ${detail ? `(${detail})` : ''}`);
    failed++;
    throw new Error(`Assertion failed: ${testName} - ${detail || ''}`);
  }
}

async function runEmpiricalProbes() {
  console.log('========================================================================');
  console.log(' 🔬 CHALLENGER 3: EMPIRICAL AUDIT & TARGETED VERIFICATION HARNESS');
  console.log('========================================================================\n');

  // ─── 1. Amharic Budget Range Parsing & Negative Input Hardening ────────────
  console.log('▶ [Probe 1] Testing Amharic Budget Range Parsing & Strict Negative Rejections...');

  const amharicValid1 = parseBudgetRangeInput('8 ሺህ - 15 ሺህ');
  assert(
    amharicValid1 !== null && amharicValid1.min === 8000 && amharicValid1.max === 15000,
    'Amharic range "8 ሺህ - 15 ሺህ" parses correctly to 8000 - 15000',
    `got ${JSON.stringify(amharicValid1)}`
  );

  const amharicValid2 = parseBudgetRangeInput('15 ሺህ - 8 ሺህ');
  assert(
    amharicValid2 !== null && amharicValid2.min === 8000 && amharicValid2.max === 15000,
    'Inverted Amharic range "15 ሺህ - 8 ሺህ" normalizes min and max',
    `got ${JSON.stringify(amharicValid2)}`
  );

  const amharicSingle = parseBudgetRangeInput('10 ሺህ');
  assert(
    amharicSingle !== null && amharicSingle.max === 10000 && amharicSingle.min === 7000,
    'Amharic single amount "10 ሺህ" parses to fallback range',
    `got ${JSON.stringify(amharicSingle)}`
  );

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
    '-8 ሺህ',
    '-8 ሺህ - 15 ሺህ',
  ];

  for (const neg of negativeCases) {
    const res = parseBudgetRangeInput(neg);
    assert(res === null, `Negative budget input "${neg}" must be rejected`, `got ${JSON.stringify(res)}`);
  }

  // ─── 2. Fayda Duplicate FAN Detection Across Tables ────────────────────────
  console.log('\n▶ [Probe 2] Testing In-Memory Fayda Uniqueness Checks Across Supabase Tables...');

  const testFan = '9999888877776666';
  const fixture = await generateAuthenticFaydaQrBuffer({
    fan: testFan,
    fullName: 'Empirical Tester',
    gender: 'M',
  });
  const buffer = fixture.pngBuffer;

  // Seed user with this FAN in users table
  const userA = 77001;
  const userB = 77002;

  const { error: upsertErr } = await supabaseAdmin.from('users').upsert({
    telegram_id: userA,
    first_name: 'Tester',
    fayda_id_number: testFan,
    fayda_status: 'verified',
    updated_at: new Date().toISOString(),
  });
  if (upsertErr) console.error('userA upsert error:', upsertErr);

  // User B tries to upload the same FAN
  const resultForUserB = await verifyFaydaPhotoUpload(buffer, userB);
  if (resultForUserB.success) console.error('Unexpected success for userB:', resultForUserB);
  assert(!resultForUserB.success, 'Duplicate FAN upload from another user is rejected');
  if (!resultForUserB.success) {
    assert(resultForUserB.errorCode === 'DUPLICATE_FAN', 'Error code is DUPLICATE_FAN', `got ${resultForUserB.errorCode}`);
    assert(resultForUserB.messageAm.includes('ይህ የፋይዳ ቁጥር'), 'Bilingual Amharic guidance provided');
    assert(resultForUserB.messageEn.toLowerCase().includes('already'), 'Bilingual English guidance provided');
  }

  // Same user re-uploading their own card succeeds
  const resultForUserA = await verifyFaydaPhotoUpload(buffer, userA);
  assert(resultForUserA.success, 'Same user uploading their own card is permitted');

  // Clean up
  await supabaseAdmin.from('users').delete().eq('telegram_id', userA);

  // ─── 3. Contact Dossier Reveal Placeholder Sanitization ─────────────────────
  console.log('\n▶ [Probe 3] Testing Contact Reveal Dossier Sanitization (Zero Placeholder Leaks)...');

  setupTelegramFetchMock();

  const requesterTgId = 88001;
  const conciergeTgId = -100;
  const matchId = '00000000-0000-0000-0000-000000000099';

  // Create match where target has admin:980853835 placeholder in telegram_username & phone_number
  await supabaseAdmin.from('matches').delete().eq('id', matchId);
  await supabaseAdmin.from('profiles').delete().eq('telegram_id', requesterTgId);
  await supabaseAdmin.from('profiles').delete().eq('telegram_id', conciergeTgId);

  const reqProfId = '00000000-0000-0000-0000-000000000088';
  const targetProfId = '00000000-0000-0000-0000-000000000089';

  const { error: profErr } = await supabaseAdmin.from('profiles').insert([
    {
      id: reqProfId,
      telegram_id: requesterTgId,
      display_code: 'RM_TEST_REQ_88',
      full_name: 'Requester Citizen',
      telegram_username: '@requester_citizen',
      phone_number: '+251911223344',
      status: 'active',
      kyc_status: 'verified',
    },
    {
      id: targetProfId,
      telegram_id: conciergeTgId,
      display_code: 'RM_TEST_TGT_89',
      full_name: 'Verified Listing',
      telegram_username: 'admin:980853835',
      phone_number: 'admin:980853835',
      status: 'active',
      kyc_status: 'verified',
    },
  ]);
  if (profErr) console.error('profErr:', profErr);

  const { error: matchErr } = await supabaseAdmin.from('matches').insert({
    id: matchId,
    requester_id: reqProfId,
    target_id: targetProfId,
    status: 'pending_acceptance',
    payment_status: 'unpaid',
  });
  if (matchErr) console.error('matchErr:', matchErr);

  clearCapturedTelegramCalls();

  // Trigger match_accept callback
  const acceptUpdate = createTelegramCallbackUpdate(conciergeTgId, `match_accept:${matchId}`, { messageId: 55555 });
  const acceptRes = await dispatchWebhookUpdate(acceptUpdate);
  assert(acceptRes.status === 200, 'match_accept callback processed successfully');

  const capturedCalls = getCapturedTelegramCalls();
  console.log('DEBUG: capturedCalls count:', capturedCalls.length, 'calls:', capturedCalls.map((c) => ({ method: c.method, text: (c.payload?.text as string)?.substring(0, 40) })));
  const sentTexts = capturedCalls
    .map((c) => (c.payload?.text as string) || '')
    .filter(Boolean);

  const fullText = sentTexts.join('\n');

  assert(!fullText.includes('admin:980853835'), 'Full dossier text NEVER contains raw "admin:980853835"');
  assert(!fullText.includes('@admin:'), 'Full dossier text NEVER contains invalid "@admin:" handle');
  assert(!fullText.includes('admin_980853835'), 'Full dossier text NEVER contains "admin_980853835"');

  const matchCall = capturedCalls.find((c) =>
    (c.payload?.text as string)?.includes("YOU'RE MATCHED") ||
    (c.payload?.text as string)?.includes('እንኳን ደስ አላችሁ')
  );

  assert(Boolean(matchCall), 'Mutual match celebration message dispatched to requester');
  if (matchCall) {
    const text = matchCall.payload.text as string;
    assert(text.includes('@WWEHID'), 'Contact handle correctly routes to coordinator @WWEHID');
    assert(
      text.includes('SpaceMatch Coordinator') || text.includes('በስፔስማች አስተዳዳሪ'),
      'Phone placeholder sanitized to official coordinator routing'
    );
  }

  // ─── 4. Rapid Concurrent match_accept Idempotency ──────────────────────────
  console.log('\n▶ [Probe 4] Testing Rapid Concurrent match_accept Idempotency & Concurrency Lock...');

  clearCapturedTelegramCalls();

  // Fire 10 rapid concurrent callbacks for the same match
  const concurrentPromises = Array.from({ length: 10 }).map((_, i) => {
    const burstUpdate = createTelegramCallbackUpdate(conciergeTgId, `match_accept:${matchId}`, { messageId: 55555 + i });
    return dispatchWebhookUpdate(burstUpdate);
  });

  const responses = await Promise.all(concurrentPromises);
  const all200 = responses.every((r) => r.status === 200);
  assert(all200, 'All 10 concurrent match_accept requests returned HTTP 200 without crashes');

  // Verify that duplicate push notifications were not spammed
  const newCalls = getCapturedTelegramCalls();
  const celebrationCalls = newCalls.filter((c) =>
    (c.payload?.text as string)?.includes("YOU'RE MATCHED") ||
    (c.payload?.text as string)?.includes('እንኳን ደስ አላችሁ')
  );

  assert(
    celebrationCalls.length <= 1,
    'Deduplication lock prevents duplicate push notifications on rapid burst clicks',
    `received ${celebrationCalls.length} celebrations (expected <= 1)`
  );

  // Clean up
  await supabaseAdmin.from('matches').delete().eq('id', matchId);
  await supabaseAdmin.from('profiles').delete().eq('telegram_id', requesterTgId);
  await supabaseAdmin.from('profiles').delete().eq('telegram_id', conciergeTgId);
  teardownTelegramFetchMock();

  console.log('\n========================================================================');
  console.log(`📊 EMPIRICAL PROBES COMPLETE: ${passed} PASSED | ${failed} FAILED`);
  console.log('========================================================================\n');
}

runEmpiricalProbes().catch((err) => {
  console.error('Fatal probe error:', err);
  process.exit(1);
});
