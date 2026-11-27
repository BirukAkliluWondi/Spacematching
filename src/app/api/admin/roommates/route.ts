import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-server';
import { verifyAdminRequest } from '@/lib/admin-auth';
import { getNextSpmarbrCode, saveRoommateDraft } from '@/lib/bot-session-store';
import { invalidateMatchmakerPoolCache, invalidateRoommatesFeedCache } from '@/lib/cache';

/**
 * GET /api/admin/roommates
 * Lists registered roommate before room profiles directly from DB.
 */
export async function GET(request: Request) {
  try {
    const auth = await verifyAdminRequest(request);
    if (!auth.authenticated) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }
    const { searchParams } = new URL(request.url);
    const query = (searchParams.get('query') || '').trim();

    let dbQuery = supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(100);

    if (query) {
      const clean = query.replace(/^[@#]/, '').replace(/[,()":]/g, ' ').replace(/\s+/g, ' ').trim();
      if (clean) {
        dbQuery = dbQuery.or(
          `full_name.ilike.%${clean}%,display_code.ilike.%${clean}%,roommate_traits.ilike.%${clean}%,telegram_username.ilike.%${clean}%`
        );
      }
    }

    const { data: profiles, error } = await dbQuery;

    if (error) {
      console.error('[admin/roommates] GET error:', error);
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    // Filter to Roommate Before Room / Seeker profiles (display_code starts with SPMARBR or has preferred_roommate_gender/locations)
    const roommates = (profiles || []).filter(
      (p) =>
        p.display_code?.startsWith('SPMARBR') ||
        p.preferred_roommate_gender ||
        (Array.isArray(p.locations) && p.locations.length > 0)
    );

    return NextResponse.json({ success: true, roommates });
  } catch (err: any) {
    console.error('[admin/roommates] GET exception:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

/**
 * POST /api/admin/roommates
 * Registers a Roommate Before Room profile directly into database WITHOUT posting to Telegram channel.
 */
export async function POST(request: Request) {
  try {
    const auth = await verifyAdminRequest(request);
    if (!auth.authenticated) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }
    const body = await request.json();
    const {
      fullName,
      gender,
      preferredGender = 'Any',
      locations = [],
      budgetMin = 0,
      budgetMax,
      bio,
      age,
      occupation,
      phone,
      telegramHandle,
      displayCode,
      lifestyleTraits = [],
    } = body;

    // Validation
    if (!fullName || typeof fullName !== 'string' || !fullName.trim()) {
      return NextResponse.json({ success: false, error: 'Full name is required.' }, { status: 400 });
    }
    if (!gender || (gender !== 'Male' && gender !== 'Female')) {
      return NextResponse.json({ success: false, error: 'Gender must be Male or Female.' }, { status: 400 });
    }
    const parsedBudgetMax = Number(budgetMax);
    if (!parsedBudgetMax || parsedBudgetMax <= 0) {
      return NextResponse.json({ success: false, error: 'Valid maximum budget is required.' }, { status: 400 });
    }
    const parsedBudgetMin = Number(budgetMin) || 0;
    if (!bio || typeof bio !== 'string' || !bio.trim()) {
      return NextResponse.json({ success: false, error: 'Bio / lifestyle description is required.' }, { status: 400 });
    }

    // 1. Resolve canonical Display Code without leading '#' so bot deep links match consistently
    let finalCode = (displayCode || '').trim().toUpperCase().replace(/^#/, '');
    if (!finalCode) {
      finalCode = await getNextSpmarbrCode('seeker');
    }

    // Extract collision-free deterministic negative synthetic ID from canonical finalCode
    let hashVal = 2166136261;
    for (let i = 0; i < finalCode.length; i++) {
      hashVal ^= finalCode.charCodeAt(i);
      hashVal = Math.imul(hashVal, 16777619);
    }
    const synDigits = (hashVal >>> 0) % 899999999;
    const synTgId = -(1000000000 + synDigits);

    const nameParts = fullName.trim().split(/\s+/);
    const firstName = nameParts[0] || 'Roommate';
    const lastName = nameParts.slice(1).join(' ') || '';
    const rawHandle = (telegramHandle || '').replace(/^@/, '').trim();
    const cleanUsername = /^[a-zA-Z0-9_]{5,32}$/.test(rawHandle) ? rawHandle : 'spacematchaddissupport';
    const safePrefGender = ['Male', 'Female', 'Any'].includes(preferredGender) ? preferredGender : 'Any';

    // 2. Step A: Upsert synthetic user record (required by foreign key)
    const { error: userError } = await supabaseAdmin.from('users').upsert(
      {
        telegram_id: synTgId,
        first_name: firstName,
        last_name: lastName,
        username: cleanUsername,
        phone_number: phone?.trim() || null,
        role: 'renter',
        fayda_status: 'verified',
        fayda_id_number: `SYN-${synDigits}`,
        gender: gender,
        created_at: new Date().toISOString(),
      },
      { onConflict: 'telegram_id' }
    );

    if (userError) {
      console.error('[admin/roommates] users upsert error:', userError);
      return NextResponse.json({ success: false, error: `Failed to create user record: ${userError.message}` }, { status: 500 });
    }

    // 3. Step B: Upsert profile record
    const { error: profileError } = await supabaseAdmin.from('profiles').upsert(
      {
        telegram_id: synTgId,
        display_code: finalCode,
        onboarding_step: 'completed',
        full_name: fullName.trim(),
        gender: gender,
        status: 'active',
        kyc_status: 'verified',
        budget_min: parsedBudgetMin,
        budget_max: parsedBudgetMax,
        locations: Array.isArray(locations) && locations.length > 0 ? locations : ['Addis Ababa'],
        roommate_traits: bio.trim(),
        phone_number: phone?.trim() || null,
        telegram_username: cleanUsername,
      },
      { onConflict: 'display_code' }
    );

    if (profileError) {
      console.error('[admin/roommates] profiles upsert error:', profileError);
      return NextResponse.json({ success: false, error: `Failed to create profile: ${profileError.message}` }, { status: 500 });
    }

    // 4. Step C: Insert into roommate_profiles
    const { error: rmError } = await supabaseAdmin.from('roommate_profiles').insert({
      user_telegram_id: synTgId,
      my_gender: gender,
      preferred_gender: safePrefGender,
      preferred_subcity: Array.isArray(locations) && locations.length > 0 ? locations : ['Addis Ababa'],
      budget_min: parsedBudgetMin,
      budget_max: parsedBudgetMax,
      lifestyle_bio: bio.trim(),
      unlock_fee: 100,
      status: 'approved',
      created_at: new Date().toISOString(),
    });

    if (rmError) {
      console.error('[admin/roommates] roommate_profiles insert error:', rmError.message);
      return NextResponse.json({ success: false, error: `Failed to register roommate profile: ${rmError.message}` }, { status: 500 });
    }

    // 5. Step D: Persist draft in pending_roommate_drafts and memory using exact schema fields
    const nowIso = new Date().toISOString();
    await saveRoommateDraft({
      id: finalCode,
      display_code: finalCode,
      user_telegram_id: synTgId,
      user_name: fullName.trim(),
      username: cleanUsername,
      contact_phone: phone?.trim() || undefined,
      phone_number: phone?.trim() || undefined,
      age: age ? Number(age) : 24,
      job: occupation?.trim() || undefined,
      my_gender: gender,
      preferred_gender: safePrefGender,
      preferred_subcity: Array.isArray(locations) && locations.length > 0 ? locations : ['Addis Ababa'],
      budget_min: parsedBudgetMin,
      budget_max: parsedBudgetMax,
      lifestyle_bio: bio.trim(),
      unlock_fee: 100,
      fayda_status: 'verified',
      status: 'approved',
      created_at: nowIso,
      updated_at: nowIso,
    });

    invalidateRoommatesFeedCache();
    invalidateMatchmakerPoolCache();

    return NextResponse.json({
      success: true,
      displayCode: finalCode,
      message: `Roommate profile ${finalCode} successfully registered to database (DB only, no channel post).`,
      profile: {
        displayCode: finalCode,
        fullName: fullName.trim(),
        gender,
        preferredGender,
        budgetMin: parsedBudgetMin,
        budgetMax: parsedBudgetMax,
        locations,
        bio: bio.trim(),
      },
    });
  } catch (err: any) {
    console.error('[admin/roommates] POST exception:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
