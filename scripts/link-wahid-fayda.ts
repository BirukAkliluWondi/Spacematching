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
} catch (e) {
  console.warn('Could not load .env.local:', e);
}

import { supabaseAdmin } from '../src/lib/supabase-server';
import { persistFaydaVerification } from '../src/lib/fayda-verification';
import { GET as adminUsersGet } from '../src/app/api/admin/users/route';

async function main() {
  console.log('=== Linking & Backfilling Wahid Hussien Awol Fayda Account ===');

  const telegramId = 980853835;
  const fan = '2389675098342572';
  const fullName = 'Wahid Hussien Awol';
  const dob = '2005-06-29';
  const gender = 'Male';
  const username = 'WWEHID';

  // 1. Persist Fayda verification via official verification persistence helper
  const success = await persistFaydaVerification(telegramId, fan, fullName, {
    gender,
    dob,
    verifiedSource: 'rs256_qr',
    from: {
      first_name: 'Wahid',
      last_name: 'Hussien Awol',
      username,
    },
  });

  if (!success) {
    console.error('❌ persistFaydaVerification returned false');
    process.exit(1);
  }

  // 2. Ensure role is admin in users table
  const { error: userUpdateErr } = await supabaseAdmin
    .from('users')
    .update({ role: 'admin' })
    .eq('telegram_id', telegramId);

  if (userUpdateErr) {
    console.error('Warning updating user role to admin:', userUpdateErr);
  }

  // 3. Ensure profile has official name and verified KYC status
  const { error: profUpdateErr } = await supabaseAdmin
    .from('profiles')
    .update({
      full_name: fullName,
      kyc_status: 'verified',
      gender,
      telegram_username: `@${username}`,
    })
    .eq('telegram_id', telegramId);

  if (profUpdateErr) {
    console.warn('Warning updating profile:', profUpdateErr);
  }

  console.log('✅ Backfilled Wahid account successfully in Supabase.');

  // 4. Verify via GET /api/admin/users?query=2389675098342572
  console.log('\n=== Verifying via GET /api/admin/users?query=2389675098342572 ===');
  const req = new Request(`http://localhost:3000/api/admin/users?query=${fan}`);
  const res = await adminUsersGet(req);
  const json = await res.json();

  console.log('API Response status:', res.status);
  console.log('Found users count:', json.count);

  if (!json.success || !json.users || json.users.length === 0) {
    console.error('❌ User NOT found when searching by FAN number:', fan);
    console.error('API Response:', JSON.stringify(json, null, 2));
    process.exit(1);
  }

  const foundUser = json.users.find((u: any) => u.telegram_id === telegramId || u.fayda_id_number === fan);
  if (!foundUser) {
    console.error('❌ Wahid was not found in the search results for FAN:', fan);
    console.error('Results:', JSON.stringify(json.users, null, 2));
    process.exit(1);
  }

  console.log('User Record Details:');
  console.log('  Telegram ID:', foundUser.telegram_id);
  console.log('  Full Name:', foundUser.full_name);
  console.log('  FAN Number:', foundUser.fayda_id_number);
  console.log('  Fayda Status:', foundUser.fayda_status);
  console.log('  Gender:', foundUser.gender);
  console.log('  DOB:', foundUser.fayda_dob);
  console.log('  Role:', foundUser.role);

  if (foundUser.fayda_id_number !== fan) {
    console.error(`❌ Expected FAN ${fan}, got ${foundUser.fayda_id_number}`);
    process.exit(1);
  }
  if (foundUser.fayda_status !== 'verified') {
    console.error(`❌ Expected fayda_status 'verified', got ${foundUser.fayda_status}`);
    process.exit(1);
  }
  if (!foundUser.full_name.includes('Wahid')) {
    console.error(`❌ Expected full_name to include 'Wahid', got ${foundUser.full_name}`);
    process.exit(1);
  }

  console.log('\n🎉 ALL CHECKS PASSED! Search by FAN number successfully retrieves Wahid Hussien Awol with full verified details.');
}

main().catch((err) => {
  console.error('Fatal error running link-wahid-fayda script:', err);
  process.exit(1);
});
