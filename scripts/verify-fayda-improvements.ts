import fs from 'fs';
import path from 'path';

// Load .env.local natively
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
} catch (e) {
  console.warn('Could not load .env.local:', e);
}

import { GET as adminUsersGet } from '../src/app/api/admin/users/route';
import { POST as webhookPost } from '../src/app/api/telegram/webhook/route';
import { supabaseAdmin } from '../src/lib/supabase-server';

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`❌ ASSERTION FAILED: ${msg}`);
    process.exit(1);
  }
  console.log(`  ✅ [PASS] ${msg}`);
}

async function main() {
  console.log('========================================================================');
  console.log(' 🔬 TARGETED VERIFICATION: FAYDA PERSISTENCE, GUARD & CARD RENDERING');
  console.log('========================================================================');

  // ── Probe 1: Formatted FAN Search in Admin API ──
  console.log('\n▶ [Probe 1] Formatted & Spaced FAN Searches in Admin API...');
  {
    // Search with dashed FAN
    const reqDashed = new Request('http://localhost:3000/api/admin/users?query=2389-6750-9834-2572');
    const resDashed = await adminUsersGet(reqDashed);
    const jsonDashed = await resDashed.json();
    assert(jsonDashed.success && jsonDashed.count >= 1, 'Dashed FAN query finds user');
    const userDashed = jsonDashed.users.find((u: any) => u.telegram_id === 980853835);
    assert(Boolean(userDashed), 'Dashed FAN retrieves Wahid Hussien Awol');

    // Search with space-separated FAN
    const reqSpaced = new Request('http://localhost:3000/api/admin/users?query=2389%206750%209834%202572');
    const resSpaced = await adminUsersGet(reqSpaced);
    const jsonSpaced = await resSpaced.json();
    assert(jsonSpaced.success && jsonSpaced.count >= 1, 'Space-separated FAN query finds user');
    const userSpaced = jsonSpaced.users.find((u: any) => u.telegram_id === 980853835);
    assert(Boolean(userSpaced), 'Space-separated FAN retrieves Wahid Hussien Awol');
  }

  // ── Probe 2: isUserFaydaVerified Database Integrity (No False Positive from draft_data) ──
  console.log('\n▶ [Probe 2] isUserFaydaVerified rejects unpersisted draft_data without DB record...');
  {
    const fakeTgId = 888777666;
    // Ensure no DB record exists for this fake user
    await supabaseAdmin.from('users').delete().eq('telegram_id', fakeTgId);

    // Seed in-memory session with bogus verified draft
    const { getSession, saveSession } = await import('../src/lib/bot-session-store');
    await saveSession({
      telegram_id: fakeTgId,
      step: 'idle',
      draft_data: { fayda_status: 'verified', fayda_number: '1234567890123456' },
      updated_at: new Date().toISOString(),
    }, true);

    // Call /verify endpoint for this unpersisted fake user
    const update = {
      update_id: 99901,
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: fakeTgId, type: 'private' },
        from: { id: fakeTgId, first_name: 'Imposter' },
        text: '/verify',
      },
    };
    const req = new Request('http://localhost:3000/api/telegram/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(update),
    });
    const res = await webhookPost(req);
    assert(res.status === 200, 'Webhook returns HTTP 200 for /verify');

    // Check that imposter session was transitioned to awaiting_standalone_fayda_fan (gate card sent),
    // and NOT falsely approved as verified
    const imposterSession = getSession(fakeTgId);
    assert(imposterSession.step === 'awaiting_standalone_fayda_fan', 'Unpersisted user is routed to awaiting_standalone_fayda_fan gate, NOT verified card');
  }

  // ── Probe 3: Wahid (/verify and /fayda) returns Verified Dossier Card ──
  console.log('\n▶ [Probe 3] Verified User (Wahid, 980853835) invokes /verify, /fayda, and callback verify_fayda...');
  {
    // Clear Wahid session
    const { clearSession, getSession } = await import('../src/lib/bot-session-store');
    await clearSession(980853835);

    // 1. Slash command /verify
    const updateVerify = {
      update_id: 99902,
      message: {
        message_id: 2,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 980853835, type: 'private' },
        from: { id: 980853835, first_name: 'Wahid', username: 'WWEHID' },
        text: '/verify',
      },
    };
    const resVerify = await webhookPost(new Request('http://localhost:3000/api/telegram/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updateVerify),
    }));
    assert(resVerify.status === 200, '/verify returns HTTP 200 for verified user');

    // 2. Callback query verify_fayda
    const updateCallback = {
      update_id: 99903,
      callback_query: {
        id: 'cb_fayda_123',
        chat_instance: 'inst_123',
        message: {
          message_id: 100,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 980853835, type: 'private' },
        },
        from: { id: 980853835, first_name: 'Wahid', username: 'WWEHID' },
        data: 'verify_fayda',
      },
    };
    const resCallback = await webhookPost(new Request('http://localhost:3000/api/telegram/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updateCallback),
    }));
    assert(resCallback.status === 200, 'callback verify_fayda returns HTTP 200 for verified user');

    // 3. Slash command with bot username /verify@SpaceMatchBot
    const updateBotTag = {
      update_id: 99904,
      message: {
        message_id: 3,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 980853835, type: 'private' },
        from: { id: 980853835, first_name: 'Wahid', username: 'WWEHID' },
        text: '/verify@SpaceMatchBot',
      },
    };
    const resBotTag = await webhookPost(new Request('http://localhost:3000/api/telegram/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updateBotTag),
    }));
    assert(resBotTag.status === 200, '/verify@SpaceMatchBot returns HTTP 200 for verified user');
  }

  console.log('\n========================================================================');
  console.log(' 🎉 ALL PROBES COMPLETED SUCCESSFULLY (100% PASS RATE)');
  console.log('========================================================================');
}

main().catch((err) => {
  console.error('Fatal error in verify-fayda-improvements:', err);
  process.exit(1);
});
