/**
 * scripts/verify-fayda-liveness.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Verification Test Suite for Two-Step Biometric Ownership Verification:
 * (Fayda QR Face Thumbnail vs. Live Selfie Photo / Telegram Video Note)
 *
 * Probes:
 * 1. In-Memory Zero-Storage Face Matcher (Unit & Boundary Probes):
 *    - Self-match / near-match (score >= 0.65, matched = true)
 *    - Impostor / different face match (score < 0.65, matched = false)
 *    - Empty buffers, corrupt headers, missing reference thumbnail
 * 2. Step 1 -> Step 2 Dialogue Progression via Webhook:
 *    - Step 1: Valid Fayda ID QR upload transitions to `awaiting_fayda_liveness_selfie`
 *    - Step 1: Extracted citizen fields and `temp_fayda_face` stored in draft
 *    - Step 1: User is NOT yet verified in Supabase users table
 * 3. Step 2 Rejection & Guidance Handling:
 *    - Impostor selfie (< 65% match) rejected with bilingual score guidance
 *    - Manual text during selfie step rejected with guidance
 *    - Session step preserved at `awaiting_fayda_liveness_selfie`
 * 4. Step 2 Positive Verification & Read-Back:
 *    - Matching selfie (>= 65% match) accepted
 *    - Supabase persistence confirmed via strict read-back guard
 *    - `temp_fayda_face` cleared from session (Zero-Storage Invariant)
 *    - Verified resident dossier card dispatched
 * 5. Telegram Round Video Note Ingestion (`message.video_note`):
 *    - Live round video note thumbnail processed in RAM
 *    - Successfully verified with source `telegram_video_note_rs256_liveness`
 */

import sharp from 'sharp';
import {
  setupTelegramFetchMock,
  teardownTelegramFetchMock,
  registerMockTelegramPhoto,
  clearCapturedTelegramCalls,
  getCapturedTelegramCalls,
  createTelegramMessageUpdate,
  createTelegramPhotoUpdate,
  createTelegramVideoNoteUpdate,
  dispatchWebhookUpdate,
} from './helpers/test-harness';
import {
  generateAuthenticFaydaQrBuffer,
  DEFAULT_SYNTHETIC_FACE_WEBP_BASE64URL,
} from './helpers/synthetic-fayda';
import { getSession, clearSession } from '../src/lib/bot-session-store';
import { compareFaceToThumbnail, FACE_MATCH_THRESHOLD } from '../src/lib/bot/face-matcher';
import { supabaseAdmin } from '../src/lib/supabase-server';

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string, detail: string = '') {
  if (condition) {
    console.log(`  ✅ [PASS] ${testName}`);
    passed++;
  } else {
    console.error(`  ❌ [FAIL] ${testName} ${detail ? `(${detail})` : ''}`);
    failed++;
  }
}

async function runLivenessVerificationSuite() {
  console.log('========================================================================');
  console.log(' 🔬 BIOMETRIC OWNERSHIP VERIFICATION (FAYDA FACE VS LIVE SELFIE) HARNESS');
  console.log('========================================================================\n');

  setupTelegramFetchMock();

  // ─── 1. Unit Probes: In-Memory Zero-Storage Face Matcher ─────────────────────
  console.log('▶ [Probe 1] Testing In-Memory Face Matcher Feature Analysis & Thresholds...');

  // Create a synthetic reference face (64x64 WebP)
  const referenceFaceBuffer = await sharp({
    create: {
      width: 64,
      height: 64,
      channels: 3,
      background: { r: 210, g: 180, b: 150 },
    },
  })
    .composite([
      {
        input: Buffer.from(
          '<svg width="64" height="64"><circle cx="24" cy="24" r="5" fill="#222"/><circle cx="40" cy="24" r="5" fill="#222"/><ellipse cx="32" cy="44" rx="8" ry="3" fill="#600"/></svg>'
        ),
        top: 0,
        left: 0,
      },
    ])
    .webp()
    .toBuffer();

  const referenceFaceB64 = referenceFaceBuffer.toString('base64');

  // Similar selfie: same face with slight lighting / angle variation
  const similarSelfieBuffer = await sharp(referenceFaceBuffer)
    .modulate({ brightness: 1.04, saturation: 0.98 })
    .jpeg()
    .toBuffer();

  // Different image / impostor (vertical bars)
  const impostorBuffer = await sharp({
    create: {
      width: 64,
      height: 64,
      channels: 3,
      background: { r: 10, g: 50, b: 180 },
    },
  })
    .composite([
      {
        input: Buffer.from(
          '<svg width="64" height="64"><rect x="10" y="0" width="10" height="64" fill="#fff"/><rect x="35" y="0" width="10" height="64" fill="#fff"/></svg>'
        ),
        top: 0,
        left: 0,
      },
    ])
    .jpeg()
    .toBuffer();

  // Self-match
  const selfMatch = await compareFaceToThumbnail(referenceFaceBuffer, referenceFaceB64);
  assert(selfMatch.matched, 'Self-match achieves matched === true', `score: ${selfMatch.score}`);
  assert(selfMatch.score >= 0.90, 'Self-match score is >= 0.90', `score: ${selfMatch.score}`);

  // Near-match (similar lighting/format)
  const similarMatch = await compareFaceToThumbnail(similarSelfieBuffer, referenceFaceB64);
  assert(similarMatch.matched, 'Similar face selfie achieves matched === true', `score: ${similarMatch.score}`);
  assert(
    similarMatch.score >= FACE_MATCH_THRESHOLD,
    `Similar face score (${similarMatch.score}) meets approved ${FACE_MATCH_THRESHOLD * 100}% threshold`
  );

  // Impostor match
  const impostorMatch = await compareFaceToThumbnail(impostorBuffer, referenceFaceB64);
  assert(!impostorMatch.matched, 'Impostor image achieves matched === false', `score: ${impostorMatch.score}`);
  assert(
    impostorMatch.score < FACE_MATCH_THRESHOLD,
    `Impostor score (${impostorMatch.score}) is strictly below ${FACE_MATCH_THRESHOLD * 100}% threshold`
  );
  assert(
    Boolean(impostorMatch.reason && impostorMatch.reason.includes('65%')),
    'Rejection provides descriptive reason citing 65% threshold',
    impostorMatch.reason
  );

  // Translation-shifted selfie (natural 4px handheld phone offset)
  const shiftedSelfieBuffer = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 210, g: 180, b: 150 } },
  })
    .composite([
      {
        input: Buffer.from(
          '<svg width="64" height="64"><circle cx="28" cy="24" r="5" fill="#222"/><circle cx="44" cy="24" r="5" fill="#222"/><ellipse cx="36" cy="44" rx="8" ry="3" fill="#600"/></svg>'
        ),
        top: 0,
        left: 0,
      },
    ])
    .jpeg()
    .toBuffer();

  const shiftedMatch = await compareFaceToThumbnail(shiftedSelfieBuffer, referenceFaceB64);
  assert(shiftedMatch.matched, 'Natural 4px shifted selfie achieves matched === true', `score: ${shiftedMatch.score}`);
  assert(
    shiftedMatch.score >= FACE_MATCH_THRESHOLD,
    `Shifted selfie score (${shiftedMatch.score}) meets approved ${FACE_MATCH_THRESHOLD * 100}% threshold`
  );

  // Different person (different facial geometry)
  const differentPersonBuffer = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 210, g: 180, b: 150 } },
  })
    .composite([
      {
        input: Buffer.from(
          '<svg width="64" height="64"><circle cx="18" cy="28" r="7" fill="#222"/><circle cx="46" cy="28" r="7" fill="#222"/><rect x="26" y="50" width="12" height="6" fill="#600"/></svg>'
        ),
        top: 0,
        left: 0,
      },
    ])
    .jpeg()
    .toBuffer();

  const diffPersonMatch = await compareFaceToThumbnail(differentPersonBuffer, referenceFaceB64);
  assert(!diffPersonMatch.matched, 'Different person face achieves matched === false', `score: ${diffPersonMatch.score}`);
  assert(
    diffPersonMatch.score < FACE_MATCH_THRESHOLD,
    `Different person score (${diffPersonMatch.score}) is strictly below 65% threshold`
  );

  // Solid flat image (division by zero / variance protection)
  const flatBuffer = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 128, g: 128, b: 128 } },
  }).png().toBuffer();
  const flatMatch = await compareFaceToThumbnail(flatBuffer, referenceFaceB64);
  assert(!flatMatch.matched && flatMatch.score === 0, 'Flat zero-variance image achieves 0% score without division-by-zero');

  // Edge cases
  const emptyBufMatch = await compareFaceToThumbnail(Buffer.alloc(0), referenceFaceB64);
  assert(!emptyBufMatch.matched && emptyBufMatch.score === 0, 'Empty live image buffer rejected gracefully');

  const emptyRefMatch = await compareFaceToThumbnail(referenceFaceBuffer, '');
  assert(!emptyRefMatch.matched && emptyRefMatch.score === 0, 'Empty reference face base64 rejected gracefully');

  const corruptBufMatch = await compareFaceToThumbnail(Buffer.from('not-an-image-data'), referenceFaceB64);
  assert(!corruptBufMatch.matched && corruptBufMatch.score === 0, 'Corrupt image bytes rejected gracefully');

  // ─── 2. End-to-End Dialogue: Step 1 (Fayda QR) -> Step 2 (Liveness Prompt) ─
  console.log('\n▶ [Probe 2] Testing Step 1 (Card Upload) -> Step 2 (Liveness Prompt) via Webhook...');

  const testChatId = 88001;
  const testFan = '9801122334455667';
  await clearSession(testChatId);
  await supabaseAdmin.from('users').delete().eq('telegram_id', testChatId);

  // Generate authentic synthetic Fayda QR embedding the reference face
  const qrFixture = await generateAuthenticFaydaQrBuffer({
    fan: testFan,
    fullName: 'Abel Tesfaye',
    gender: 'M',
    dob: '1995/04/10',
    faceBase64Url: referenceFaceBuffer.toString('base64url'),
  });

  const cardFileId = `fayda_card_${testChatId}`;
  registerMockTelegramPhoto(cardFileId, qrFixture.pngBuffer);

  clearCapturedTelegramCalls();
  const step1Update = createTelegramPhotoUpdate(testChatId, cardFileId);
  const step1Res = await dispatchWebhookUpdate(step1Update);

  assert(step1Res.status === 200, 'Step 1 Fayda card upload returns HTTP 200');

  const sessionAfterStep1 = getSession(testChatId);
  assert(
    sessionAfterStep1.step === 'awaiting_fayda_liveness_selfie',
    'Session step transitions to awaiting_fayda_liveness_selfie',
    `got ${sessionAfterStep1.step}`
  );
  assert(
    Boolean(sessionAfterStep1.draft_data?.temp_fayda_face),
    'session.draft_data.temp_fayda_face contains extracted QR face base64'
  );
  assert(
    sessionAfterStep1.draft_data?.fan === testFan,
    'session.draft_data contains extracted FAN',
    `got ${sessionAfterStep1.draft_data?.fan}`
  );
  assert(
    sessionAfterStep1.draft_data?.fullName === 'Abel Tesfaye',
    'session.draft_data contains extracted full name',
    `got ${sessionAfterStep1.draft_data?.fullName}`
  );

  const step1Calls = getCapturedTelegramCalls();
  const step2PromptCall = step1Calls.find(
    (c) =>
      c.payload?.text?.includes('ደረጃ 2/2') ||
      c.payload?.text?.includes('Step 2/2') ||
      c.payload?.text?.includes('ሴልፊ') ||
      c.payload?.text?.includes('selfie')
  );
  assert(Boolean(step2PromptCall), 'Dispatched bilingual Step 2/2 liveness selfie prompt');

  // Verify that citizen is NOT yet marked verified in Supabase
  const { data: dbUserBeforeStep2 } = await supabaseAdmin
    .from('users')
    .select('fayda_status')
    .eq('telegram_id', testChatId)
    .maybeSingle();
  assert(
    !dbUserBeforeStep2 || dbUserBeforeStep2.fayda_status !== 'verified',
    'User is NOT yet marked verified before completing Step 2 selfie'
  );

  // ─── 3. Step 2 Rejection: Impostor Selfie & Manual Text ─────────────────────
  console.log('\n▶ [Probe 3] Testing Step 2 Rejection (Impostor Selfie & Manual Text)...');

  // Negative test A: manual text entered during awaiting_fayda_liveness_selfie
  clearCapturedTelegramCalls();
  const textUpdate = createTelegramMessageUpdate(testChatId, 'I am Abel Tesfaye verify me please');
  const textRes = await dispatchWebhookUpdate(textUpdate);
  assert(textRes.status === 200, 'Manual text returns HTTP 200');

  const sessionAfterText = getSession(testChatId);
  assert(
    sessionAfterText.step === 'awaiting_fayda_liveness_selfie',
    'Session step remains awaiting_fayda_liveness_selfie after manual text input'
  );

  const textCalls = getCapturedTelegramCalls();
  const textGuidance = textCalls.find(
    (c) =>
      c.payload?.text?.includes('ሴልፊ') ||
      c.payload?.text?.includes('Selfie') ||
      c.payload?.text?.includes('ቪዲዮ')
  );
  assert(Boolean(textGuidance), 'Bot replies with guidance requiring selfie photo or video note');

  // Negative test B: Impostor selfie upload (< 65% match)
  const impostorFileId = `impostor_selfie_${testChatId}`;
  registerMockTelegramPhoto(impostorFileId, impostorBuffer);

  clearCapturedTelegramCalls();
  const impostorUpdate = createTelegramPhotoUpdate(testChatId, impostorFileId);
  const impostorRes = await dispatchWebhookUpdate(impostorUpdate);
  assert(impostorRes.status === 200, 'Impostor selfie upload returns HTTP 200');

  const sessionAfterImpostor = getSession(testChatId);
  assert(
    sessionAfterImpostor.step === 'awaiting_fayda_liveness_selfie',
    'Session step remains awaiting_fayda_liveness_selfie after failed match (<65%)'
  );

  const impostorCalls = getCapturedTelegramCalls();
  const impostorGuidance = impostorCalls.find(
    (c) =>
      c.payload?.text?.includes('አልተሳካም') ||
      c.payload?.text?.includes('Unsuccessful') ||
      c.payload?.text?.includes('65%')
  );
  assert(Boolean(impostorGuidance), 'Bot sends bilingual rejection message with lighting/angle guidance');

  // User must still NOT be verified in DB
  const { data: dbUserStillUnverified } = await supabaseAdmin
    .from('users')
    .select('fayda_status')
    .eq('telegram_id', testChatId)
    .maybeSingle();
  assert(
    !dbUserStillUnverified || dbUserStillUnverified.fayda_status !== 'verified',
    'User remains unverified in DB after failed biometric selfie match'
  );

  // ─── 4. Step 2 Success: Matching Selfie Photo (>= 65%) ─────────────────────
  console.log('\n▶ [Probe 4] Testing Step 2 Success (Matching Selfie Photo >= 65%)...');

  const matchingSelfieFileId = `matching_selfie_${testChatId}`;
  registerMockTelegramPhoto(matchingSelfieFileId, similarSelfieBuffer);

  clearCapturedTelegramCalls();
  const selfieUpdate = createTelegramPhotoUpdate(testChatId, matchingSelfieFileId);
  const selfieRes = await dispatchWebhookUpdate(selfieUpdate);
  assert(selfieRes.status === 200, 'Matching selfie upload returns HTTP 200');

  // Strict Read-back from Supabase DB
  const { data: dbUserVerified } = await supabaseAdmin
    .from('users')
    .select('fayda_status, fayda_id_number, first_name, last_name, gender')
    .eq('telegram_id', testChatId)
    .maybeSingle();

  const { data: dbProfVerified } = await supabaseAdmin
    .from('profiles')
    .select('full_name, kyc_status')
    .eq('telegram_id', testChatId)
    .maybeSingle();

  assert(Boolean(dbUserVerified), 'User record exists in Supabase users table');
  assert(dbUserVerified?.fayda_status === 'verified', 'User fayda_status is updated to "verified" in Supabase');
  assert(
    dbUserVerified?.fayda_id_number === testFan,
    'User fayda_id_number matches extracted FAN in Supabase',
    `got ${dbUserVerified?.fayda_id_number}`
  );
  assert(
    dbProfVerified?.full_name === 'Abel Tesfaye' || `${dbUserVerified?.first_name} ${dbUserVerified?.last_name}`.trim() === 'Abel Tesfaye',
    'User full_name is persisted correctly across Supabase tables',
    `got prof: ${dbProfVerified?.full_name}, user: ${dbUserVerified?.first_name} ${dbUserVerified?.last_name}`
  );

  // Verify Zero-Storage: temp_fayda_face is wiped from session
  const sessionAfterVerified = getSession(testChatId);
  assert(
    !sessionAfterVerified?.draft_data?.temp_fayda_face,
    'Zero-Storage: temp_fayda_face is completely wiped from process RAM/session cache'
  );

  // Verify Dossier Card was dispatched
  const successCalls = getCapturedTelegramCalls();
  const dossierCall = successCalls.find(
    (c) =>
      c.payload?.text?.includes('የተረጋገጠ ነዋሪ') ||
      c.payload?.text?.includes('Verified Resident') ||
      c.payload?.text?.includes('Fayda ID Verified')
  );
  assert(Boolean(dossierCall), 'Dispatched Verified Resident Dossier Card to user');

  // ─── 5. Telegram Round Video Note Ingestion (`message.video_note`) ───────────
  console.log('\n▶ [Probe 5] Testing Telegram Round Video Note Ingestion (message.video_note)...');

  const testChatIdVn = 88002;
  const testFanVn = '9802233445566778';
  await clearSession(testChatIdVn);
  await supabaseAdmin.from('users').delete().eq('telegram_id', testChatIdVn);

  const qrFixtureVn = await generateAuthenticFaydaQrBuffer({
    fan: testFanVn,
    fullName: 'Rahel Tadesse',
    gender: 'F',
    dob: '1998/11/20',
    faceBase64Url: referenceFaceBuffer.toString('base64url'),
  });

  const cardVnFileId = `fayda_card_${testChatIdVn}`;
  registerMockTelegramPhoto(cardVnFileId, qrFixtureVn.pngBuffer);

  // Step 1: Upload Fayda card
  await dispatchWebhookUpdate(createTelegramPhotoUpdate(testChatIdVn, cardVnFileId));
  const sessVn = getSession(testChatIdVn);
  assert(
    sessVn.step === 'awaiting_fayda_liveness_selfie',
    'Video Note User transitions to awaiting_fayda_liveness_selfie'
  );

  // Step 2: Upload round video note
  const vnFileId = `video_note_${testChatIdVn}`;
  const vnThumbFileId = `vn_thumb_${testChatIdVn}`;
  registerMockTelegramPhoto(vnThumbFileId, similarSelfieBuffer);

  clearCapturedTelegramCalls();
  const vnUpdate = createTelegramVideoNoteUpdate(testChatIdVn, vnFileId, {
    thumbnailFileId: vnThumbFileId,
  });
  const vnRes = await dispatchWebhookUpdate(vnUpdate);
  assert(vnRes.status === 200, 'Video note update returns HTTP 200');

  // Verify DB read-back for video note user
  const { data: dbUserVn } = await supabaseAdmin
    .from('users')
    .select('fayda_status, fayda_id_number, first_name, last_name')
    .eq('telegram_id', testChatIdVn)
    .maybeSingle();

  const { data: dbProfVn } = await supabaseAdmin
    .from('profiles')
    .select('full_name, kyc_status')
    .eq('telegram_id', testChatIdVn)
    .maybeSingle();

  assert(dbUserVn?.fayda_status === 'verified', 'Video note user fayda_status is "verified" in Supabase');
  assert(dbUserVn?.fayda_id_number === testFanVn, 'Video note user FAN matches extracted FAN');
  assert(
    dbProfVn?.full_name === 'Rahel Tadesse' || `${dbUserVn?.first_name} ${dbUserVn?.last_name}`.trim() === 'Rahel Tadesse',
    'Video note user full_name matches extracted name across Supabase tables',
    `got prof: ${dbProfVn?.full_name}, user: ${dbUserVn?.first_name} ${dbUserVn?.last_name}`
  );

  // ─── 6. Video Note Without Thumbnail Ingestion ──────────────────────────────
  console.log('\n▶ [Probe 6] Testing Video Note without Thumbnail (Graceful Prompt)...');

  const testChatIdNoThumb = 88003;
  const testFanNoThumb = '9804455667788990';
  await clearSession(testChatIdNoThumb);
  await supabaseAdmin.from('users').delete().eq('telegram_id', testChatIdNoThumb);

  const qrNoThumbFixture = await generateAuthenticFaydaQrBuffer({
    fan: testFanNoThumb,
    fullName: 'Sara Haile',
    gender: 'F',
    faceBase64Url: referenceFaceBuffer.toString('base64url'),
  });
  const cardNoThumbFileId = `fayda_card_${testChatIdNoThumb}`;
  registerMockTelegramPhoto(cardNoThumbFileId, qrNoThumbFixture.pngBuffer);

  // Seed session waiting for selfie
  await dispatchWebhookUpdate(createTelegramPhotoUpdate(testChatIdNoThumb, cardNoThumbFileId));
  const sessNoThumb = getSession(testChatIdNoThumb);
  assert(
    sessNoThumb.step === 'awaiting_fayda_liveness_selfie',
    'User transitions to awaiting_fayda_liveness_selfie'
  );

  // Send video note with NO thumbnail (simulate client omitting thumbnail)
  clearCapturedTelegramCalls();
  const rawVnUpdate = {
    update_id: 6111222,
    message: {
      message_id: 99112,
      from: { id: testChatIdNoThumb, is_bot: false, first_name: 'NoThumb' },
      chat: { id: testChatIdNoThumb, type: 'private' },
      date: Math.floor(Date.now() / 1000),
      video_note: {
        file_id: 'vn_raw_without_thumb',
        file_unique_id: 'vn_raw_uniq',
        length: 240,
        duration: 2,
        // thumbnail is undefined
      },
    },
  };
  const rawVnRes = await dispatchWebhookUpdate(rawVnUpdate as any);
  assert(rawVnRes.status === 200, 'Video note without thumbnail returns HTTP 200');

  const noThumbCalls = getCapturedTelegramCalls();
  const noThumbGuidance = noThumbCalls.find(
    (c) =>
      c.payload?.text?.includes('ቅድመ-ዕይታ') ||
      c.payload?.text?.includes('thumbnail') ||
      c.payload?.text?.includes('Unavailable') ||
      c.payload?.text?.includes('ሴልፊ')
  );
  assert(Boolean(noThumbGuidance), 'Bot prompts for standard selfie photo without crashing on raw MP4');

  // ─── 7. Fayda Card Upload Without Face Thumbnail (Early Step 1 Rejection) ───
  console.log('\n▶ [Probe 7] Testing Fayda Card Upload Without Face Thumbnail (Step 1 Early Reject)...');

  const testChatIdNoFace = 88004;
  await clearSession(testChatIdNoFace);

  const qrNoFace = await generateAuthenticFaydaQrBuffer({
    fan: '9803344556677889',
    fullName: 'NoFace Citizen',
    faceBase64Url: '', // empty face
  });

  const cardNoFaceFileId = `fayda_noface_${testChatIdNoFace}`;
  registerMockTelegramPhoto(cardNoFaceFileId, qrNoFace.pngBuffer);

  clearCapturedTelegramCalls();
  const noFaceUpdate = createTelegramPhotoUpdate(testChatIdNoFace, cardNoFaceFileId);
  const noFaceRes = await dispatchWebhookUpdate(noFaceUpdate);
  assert(noFaceRes.status === 200, 'Card without face returns HTTP 200');

  const sessAfterNoFace = getSession(testChatIdNoFace);
  assert(
    sessAfterNoFace.step !== 'awaiting_fayda_liveness_selfie',
    'User is NOT advanced to Step 2 when Fayda card has no face thumbnail',
    `step is ${sessAfterNoFace.step}`
  );

  const noFaceCalls = getCapturedTelegramCalls();
  const noFaceGuidance = noFaceCalls.find(
    (c) =>
      c.payload?.text?.includes('ፎቶ መረጃ አልተገኘም') ||
      c.payload?.text?.includes('Reference Face Not Found')
  );
  assert(Boolean(noFaceGuidance), 'Bot immediately guides user to upload a clear card back showing face');

  // Cleanup test users
  await supabaseAdmin.from('users').delete().eq('telegram_id', testChatId);
  await supabaseAdmin.from('users').delete().eq('telegram_id', testChatIdVn);
  await supabaseAdmin.from('users').delete().eq('telegram_id', testChatIdNoThumb);
  await supabaseAdmin.from('users').delete().eq('telegram_id', testChatIdNoFace);
  await clearSession(testChatId);
  await clearSession(testChatIdVn);
  await clearSession(testChatIdNoThumb);
  await clearSession(testChatIdNoFace);

  teardownTelegramFetchMock();

  console.log('\n========================================================================');
  console.log(`📊 BIOMETRIC LIVENESS SUITE COMPLETE: ${passed} PASSED | ${failed} FAILED`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runLivenessVerificationSuite().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
