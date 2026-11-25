import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-server';
import { verifyAdminRequest } from '@/lib/admin-auth';
import { getNextSpmarbrCode, saveRoommateDraft } from '@/lib/bot-session-store';

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
      religion,
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

    // 1. Resolve Display Code
    let finalCode = (displayCode || '').trim().toUpperCase().replace(/^#/, '');
    if (!finalCode) {
      finalCode = await getNextSpmarbrCode('seeker');
    }
    if (!finalCode.startsWith('#')) {
      finalCode = `#${finalCode}`;
    }

    // Extract digits for synthetic ID allocation
    const codeDigitsMatch = finalCode.match(/\d+/);
    const codeDigits = codeDigitsMatch ? parseInt(codeDigitsMatch[0], 10) : Math.floor(Math.random() * 899999 + 100000);
    // Negative synthetic ID ensures zero collision with authentic Telegram chat IDs
    const synTgId = -(1000000000 + codeDigits);

    const nameParts = fullName.trim().split(/\s+/);
    const firstName = nameParts[0] || 'Roommate';
    const lastName = nameParts.slice(1).join(' ') || '';
    const cleanUsername = (telegramHandle || '').replace(/^@/, '').trim() || 'WWEHID';

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
        fayda_id_number: `SYN-${codeDigits}`,
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
      preferred_gender: preferredGender,
      preferred_subcity: Array.isArray(locations) && locations.length > 0 ? locations : ['Addis Ababa'],
      budget_min: parsedBudgetMin,
      budget_max: parsedBudgetMax,
      lifestyle_bio: bio.trim(),
      unlock_fee: 100,
      status: 'approved',
      created_at: new Date().toISOString(),
    });

    if (rmError) {
      console.warn('[admin/roommates] roommate_profiles insert warning:', rmError.message);
    }

    // 5. Step D: Cache draft in pending_roommate_drafts and memory for instant matchmaker discovery
    await saveRoommateDraft({
      id: `draft_${synTgId}`,
      user_telegram_id: synTgId,
      first_name: firstName,
      last_name: lastName,
      full_name: fullName.trim(),
      gender,
      preferred_gender: preferredGender,
      budget_min: parsedBudgetMin,
      budget_max: parsedBudgetMax,
      locations: Array.isArray(locations) && locations.length > 0 ? locations : ['Addis Ababa'],
      bio: bio.trim(),
      age: age ? Number(age) : null,
      occupation: occupation?.trim() || null,
      religion: religion?.trim() || null,
      phone_number: phone?.trim() || null,
      username: cleanUsername,
      display_code: finalCode,
      fayda_status: 'verified',
      is_admin_listing: true,
      registered_by_admin: true,
    } as any);

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
