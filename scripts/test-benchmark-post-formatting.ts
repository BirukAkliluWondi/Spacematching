/**
 * scripts/test-benchmark-post-formatting.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Verification script for the Benchmark Post layout, clean bilingual formatting,
 * native Telegram blockquotes, and automated hashtags.
 */

import {
  formatRoommatePost,
  formatSpacePost,
  generatePostHashtags,
  extractUserDescription,
  truncateTelegramHtml,
  sanitizeContactDossier,
} from '../src/lib/telegram';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
  console.log(`  ✅ [PASS] ${message}`);
}

async function runTests() {
  console.log('========================================================================');
  console.log(' 🔬 TARGETED VERIFICATION: BENCHMARK POST FORMATTING & HASHTAGS');
  console.log('========================================================================\n');

  // ── Test 1: Exact Benchmark Seeker Case ──
  console.log('▶ [Test 1] Benchmark Seeker Post (Mexico, Female, 5k–10k ETB)...');
  const benchmarkProfile = {
    display_code: 'be9e0c0b',
    locations: ['Mexico'],
    budget_min: 5000,
    budget_max: 10000,
    move_in_date: 'Within 1 month',
    space_type: 'Private room · Apartment',
    preferred_gender: 'Female',
    preferred_roommate: 'Age: 25-34',
    house_rules: 'Pets okay, no smoking',
    details: 'I want a place near Mexico',
    gender: 'Female',
    full_name: 'Mekdes',
  };

  const seekerPost = formatRoommatePost(benchmarkProfile);
  console.log('Generated Seeker Post:\n' + seekerPost + '\n');

  // Verify Header
  assert(seekerPost.includes('<b>LOOKING FOR A ROOM · ID #be9e0c0b</b>'), 'Header includes LOOKING FOR A ROOM with code');
  assert(seekerPost.includes('<b>Mexico</b>'), 'Location header formatted properly');
  assert(seekerPost.includes('Budget: 5,000–10,000 ETB / month · Move in: Within 1 month'), 'Budget and Move-in timeline line');

  // Verify Sections & Bilingual Headers
  assert(seekerPost.includes("<b>WHAT I'M LOOKING FOR / የምፈልገው</b>"), "Contains WHAT I'M LOOKING FOR / የምፈልገው section");
  assert(seekerPost.includes('Private room · Apartment'), 'Contains requested space type');
  assert(seekerPost.includes('<b>ROOMMATE PREFERENCES / የቤት አጋር ምርጫ</b>'), 'Contains ROOMMATE PREFERENCES / የቤት አጋር ምርጫ section');
  assert(seekerPost.includes('Roommate: Female Only (ሴት ብቻ), 25-34'), 'Roommate preference includes gender and age');
  assert(seekerPost.includes('House rules: Pets okay, no smoking'), 'House rules formatted properly');

  // Verify Native Blockquotes
  assert(seekerPost.includes('<b>DETAILS / ዝርዝር</b>\n<blockquote>I want a place near Mexico</blockquote>'), 'DETAILS section wrapped in blockquote');
  assert(seekerPost.includes('<b>ABOUT ME / ስለ እኔ</b>\nPosted by: Female / ሴት\n<blockquote>Mekdes</blockquote>'), 'ABOUT ME section wrapped in blockquote with name/bio');

  // Verify Slogan and Hashtags
  assert(seekerPost.includes('🔑 SpaceMatch Addis'), 'Brand slogan present');
  assert(seekerPost.includes('#Mexico #LookingForRoom #FemaleRoommate #5k_10k'), 'Hashtags match exact benchmark requirement');

  // ── Test 2: Space Available Benchmark Case ──
  console.log('\n▶ [Test 2] Space Available Post (Bole, Female Host, 8k rent, 4k share)...');
  const benchmarkSpace = {
    display_code: 'SPMARWR797',
    locations: ['Bole'],
    space_rent: 8000,
    space_share: 4000,
    move_in_date: 'Immediate',
    space_type: 'Private Bedroom in Shared Flat',
    space_amenities: ['WiFi', 'Kitchen', 'Water supply'],
    preferred_tenant_gender: 'Female',
    house_rules: 'Clean, respectful, quiet hours',
    details: 'Spacious room in modern Bole apartment near Edna Mall.',
    gender: 'Female',
    lifestyle_bio: 'Working professional looking for a quiet housemate.',
  };

  const spacePost = formatSpacePost(benchmarkSpace);
  console.log('Generated Space Available Post:\n' + spacePost + '\n');

  assert(spacePost.includes('<b>ROOM AVAILABLE · ID #SPMARWR797</b>'), 'Header includes ROOM AVAILABLE with code');
  assert(spacePost.includes('<b>Bole</b>'), 'Space location header formatted properly');
  assert(spacePost.includes('Rent: 8,000 ETB / month (4,000 ETB split) · Move in: Immediate'), 'Rent and split display line');
  assert(spacePost.includes('<b>SPACE DETAILS / የቤቱ ዝርዝር</b>'), 'Contains SPACE DETAILS / የቤቱ ዝርዝር section');
  assert(spacePost.includes('Amenities: WiFi, Kitchen, Water supply'), 'Contains amenities');
  assert(spacePost.includes('<b>ROOMMATE PREFERENCES / የቤት አጋር ምርጫ</b>'), 'Contains ROOMMATE PREFERENCES');
  assert(spacePost.includes('Roommate: Female Only (ሴት ብቻ)'), 'Roommate gender requirement');
  assert(spacePost.includes('<blockquote>Spacious room in modern Bole apartment near Edna Mall.</blockquote>'), 'Space DETAILS wrapped in blockquote');
  assert(spacePost.includes('Posted by: Female / ሴት (Space Host / አከራይ)'), 'Space Host header');
  assert(spacePost.includes('<blockquote>Working professional looking for a quiet housemate.</blockquote>'), 'Host bio in blockquote');
  assert(spacePost.includes('#Bole #RoomAvailable #FemaleRoommate #4k_8k'), 'Space hashtags generated properly');

  // ── Test 3: Edge Cases (Empty, Null, Metadata Stripping, Slashes) ──
  console.log('\n▶ [Test 3] Edge Cases (Defaults, Slash Locations, Pipe Metadata Stripping)...');
  const dirtyProfile = {
    display_code: '#SPMARBR99',
    locations: ['Kazanchis / ካዛንቺስ', 'Bole'],
    budget_min: 0,
    budget_max: 12000,
    roommate_traits: 'Job: Software Engineer | Religion: Orthodox | Prefers: Male | Friendly quiet guy working remotely',
    gender: 'Male',
  };

  const dirtyPost = formatRoommatePost(dirtyProfile);
  console.log('Generated Edge-Case Post:\n' + dirtyPost + '\n');

  assert(dirtyPost.includes('<b>LOOKING FOR A ROOM · ID #SPMARBR99</b>'), 'Code leading hash cleanly stripped');
  assert(dirtyPost.includes('<b>Kazanchis / ካዛንቺስ, Bole</b>'), 'Bilingual locations displayed cleanly');
  assert(dirtyPost.includes('Budget: Up to 12,000 ETB / month'), 'Single max budget formatted properly');
  assert(dirtyPost.includes('Within 1 month / በ1 ወር ውስጥ'), 'Default move in timeline applied');
  assert(dirtyPost.includes('<blockquote>Friendly quiet guy working remotely</blockquote>'), 'Metadata prefixes stripped from bio blockquote');
  assert(dirtyPost.includes('#Kazanchis #LookingForRoom #MaleRoommate #12k'), 'Hashtags cleaned from slash subcity and single budget');

  // ── Test 4: generatePostHashtags Unit Test ──
  console.log('\n▶ [Test 4] Hashtag Generator Exhaustive Probing...');
  const h1 = generatePostHashtags({ locations: ['Mexico'], isSpace: false, gender: 'Female', budgetMin: 5000, budgetMax: 10000 });
  assert(h1 === '#Mexico #LookingForRoom #FemaleRoommate #5k_10k', 'H1 matches benchmark');

  const h2 = generatePostHashtags({ locations: ['Bole'], isSpace: true, preferredGender: 'Any', budgetMin: 10000, budgetMax: 15000 });
  assert(h2 === '#Bole #RoomAvailable #AnyGender #10k_15k', 'H2 matches benchmark');

  const h3 = generatePostHashtags({ locations: [], isSpace: false, gender: 'Male', budgetMax: 8000 });
  assert(h3 === '#AddisAbaba #LookingForRoom #MaleRoommate #8k', 'H3 default location and single budget');

  // ── Test 5: Amharic Subcity Transliteration in Hashtags ──
  console.log('\n▶ [Test 5] Amharic Subcity Transliteration in Hashtags...');
  const hAmharicMexico = generatePostHashtags({ locations: ['ሜክሲኮ'], isSpace: false, gender: 'Female', budgetMin: 5000, budgetMax: 10000 });
  assert(hAmharicMexico === '#Mexico #LookingForRoom #FemaleRoommate #5k_10k', 'Amharic ሜክሲኮ correctly transliterated to #Mexico');

  const hAmharicBole = generatePostHashtags({ locations: ['ቦሌ'], isSpace: true, preferredGender: 'Any', budgetMin: 10000, budgetMax: 15000 });
  assert(hAmharicBole === '#Bole #RoomAvailable #AnyGender #10k_15k', 'Amharic ቦሌ correctly transliterated to #Bole');

  // ── Test 6: Space Available Preferred Gender Any vs Male Host ──
  console.log('\n▶ [Test 6] Space Available Any Preference with Male Owner...');
  const hSpaceAnyMaleOwner = generatePostHashtags({
    locations: ['Mexico'],
    isSpace: true,
    preferredGender: 'Any',
    gender: 'Male',
    budgetMin: 10000,
    budgetMax: 15000,
  });
  assert(hSpaceAnyMaleOwner === '#Mexico #RoomAvailable #AnyGender #10k_15k', 'Space available post with Any preference produces #AnyGender despite male owner');

  // ── Test 7: HTML Safe Caption Truncation (No Unclosed Tags) ──
  console.log('\n▶ [Test 7] truncateTelegramHtml Safety & Unclosed Tag Balancing...');
  const longHtml = '<b>ROOM AVAILABLE</b>\n<blockquote>' + 'A'.repeat(1200) + '</blockquote>';
  const truncated = truncateTelegramHtml(longHtml, 1024);
  assert(truncated.length <= 1024, 'Truncated length is strictly <= 1024 chars');
  assert(truncated.endsWith('</blockquote>'), 'Truncated HTML tag stack safely closed with </blockquote>');
  assert(truncated.includes('…'), 'Ellipsis appended to truncated content');

  // ── Test 8: Contact Dossier Sanitization ──
  console.log('\n▶ [Test 8] Contact Dossier Sanitization (Invariants Rule 3)...');
  // Case A: Synthetic Listing (negative telegram_id from admin posting)
  const synthContact = sanitizeContactDossier({
    fullName: 'Synthetic Concierge Post',
    phoneNumber: '0911223344',
    telegramUsername: 'admin:123456',
    telegramId: -1001234567,
  });
  assert(synthContact.fullName.includes('@WWEHID'), 'Synthetic listing routed to coordinator @WWEHID');
  assert(synthContact.telegramUsername === 'WWEHID', 'Username sanitized to WWEHID');
  assert(synthContact.telegramUrl === 'https://t.me/WWEHID', 'URL routes to https://t.me/WWEHID');
  assert(!synthContact.fullName.includes('-100'), 'Negative telegram ID never leaked');

  // Case B: Concierge placeholder handle
  const conciergeContact = sanitizeContactDossier({
    fullName: 'Room Host',
    phoneNumber: '0911223344',
    telegramUsername: 'admin_biruk',
  });
  assert(conciergeContact.telegramUsername === 'WWEHID', 'Admin placeholder handle routed to WWEHID');

  // Case C: Invalid RFC handle (less than 5 chars or invalid chars)
  const invalidHandleContact = sanitizeContactDossier({
    fullName: 'Marta Kebede',
    phoneNumber: '0911223344',
    telegramUsername: 'abc', // < 5 chars
  });
  assert(invalidHandleContact.telegramUsername === '', 'Invalid RFC handle stripped');
  assert(invalidHandleContact.telegramUrl === undefined, 'No broken telegramUrl for invalid handle');

  // Case D: Valid verified user
  const validContact = sanitizeContactDossier({
    fullName: 'Mekdes Haile',
    phoneNumber: '0911223344',
    telegramUsername: '@mekdes_h',
  });
  assert(validContact.fullName === 'Mekdes Haile', 'Valid name preserved');
  assert(validContact.phoneNumber === '0911223344', 'Valid phone preserved');
  assert(validContact.telegramUsername === 'mekdes_h', 'Valid handle stripped of @');
  assert(validContact.telegramUrl === 'https://t.me/mekdes_h', 'Direct Telegram link generated');

  console.log('\n========================================================================');
  console.log(' 🎉 ALL BENCHMARK FORMATTING TESTS PASSED (100% SUCCESS RATE)');
  console.log('========================================================================');
}

runTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
