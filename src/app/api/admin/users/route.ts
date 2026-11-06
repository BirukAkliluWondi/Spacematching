import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-server';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const rawQuery = (searchParams.get('query') || '').trim();
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
    const rawLimit = parseInt(searchParams.get('limit') || '50', 10) || 50;
    const limit = Math.min(50, Math.max(1, rawLimit));
    const offset = (page - 1) * limit;

    const cleanText = rawQuery.replace(/^[@#]/, '').trim();
    const cleanDigits = cleanText.replace(/[\s-]/g, '');
    const isPureNumeric = /^\d+$/.test(cleanDigits);

    let userPromise: any;
    let profilePromise: any;

    if (cleanText) {
      if (isPureNumeric) {
        const num = Number(cleanDigits);
        userPromise = supabaseAdmin.from('users').select('*').eq('telegram_id', num).limit(limit);
        profilePromise = supabaseAdmin.from('profiles').select('*').eq('telegram_id', num).limit(limit);
      } else {
        const userOrFilters = [
          `first_name.ilike.%${cleanText}%`,
          `last_name.ilike.%${cleanText}%`,
          `username.ilike.%${cleanText}%`,
          cleanDigits.length >= 3 ? `fayda_id_number.ilike.%${cleanDigits}%` : null,
          `fayda_document_url.ilike.%${cleanText}%`,
        ]
          .filter(Boolean)
          .join(',');

        userPromise = supabaseAdmin
          .from('users')
          .select('*')
          .or(userOrFilters)
          .range(offset, offset + limit - 1);

        const profileOrFilters = [
          `full_name.ilike.%${cleanText}%`,
          `telegram_username.ilike.%${cleanText}%`,
          `display_code.ilike.%${cleanText}%`,
        ].join(',');

        profilePromise = supabaseAdmin
          .from('profiles')
          .select('*')
          .or(profileOrFilters)
          .range(offset, offset + limit - 1);
      }
    } else {
      userPromise = supabaseAdmin
        .from('users')
        .select('*')
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      profilePromise = supabaseAdmin
        .from('profiles')
        .select('*')
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);
    }

    const [userRes, profileRes] = await Promise.all([userPromise, profilePromise]);

    const usersMap = new Map<number, any>();
    const profilesMap = new Map<number, any>();

    if (userRes?.data && Array.isArray(userRes.data)) {
      for (const u of userRes.data) {
        if (u?.telegram_id) {
          usersMap.set(Number(u.telegram_id), u);
        }
      }
    }

    if (profileRes?.data && Array.isArray(profileRes.data)) {
      for (const p of profileRes.data) {
        if (p?.telegram_id) {
          profilesMap.set(Number(p.telegram_id), p);
        }
      }
    }

    // Fetch missing profiles for found users (bounded to 50)
    const missingProfileIds = Array.from(usersMap.keys()).filter((id) => !profilesMap.has(id));
    if (missingProfileIds.length > 0) {
      const { data: fetchedProfiles } = await supabaseAdmin
        .from('profiles')
        .select('*')
        .in('telegram_id', missingProfileIds.slice(0, 50));
      if (fetchedProfiles) {
        for (const p of fetchedProfiles) {
          profilesMap.set(Number(p.telegram_id), p);
        }
      }
    }

    // Fetch missing users for found profiles (bounded to 50)
    const missingUserIds = Array.from(profilesMap.keys()).filter((id) => !usersMap.has(id));
    if (missingUserIds.length > 0) {
      const { data: fetchedUsers } = await supabaseAdmin
        .from('users')
        .select('*')
        .in('telegram_id', missingUserIds.slice(0, 50));
      if (fetchedUsers) {
        for (const u of fetchedUsers) {
          usersMap.set(Number(u.telegram_id), u);
        }
      }
    }

    // Synthesize user record fallback when a profile exists without a users row so web dashboard never drops matches
    for (const [tgId, prof] of profilesMap.entries()) {
      if (!usersMap.has(tgId)) {
        const nameParts = (prof.full_name || '').trim().split(/\s+/);
        const synthFirstName = nameParts[0] || 'Resident';
        const synthLastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : null;
        const synthUsername = prof.telegram_username ? prof.telegram_username.replace(/^@/, '') : null;
        const isVer = prof.kyc_status === 'verified';
        const isPend = prof.kyc_status === 'pending';

        usersMap.set(tgId, {
          id: prof.id || `profile-${tgId}`,
          telegram_id: tgId,
          first_name: synthFirstName,
          last_name: synthLastName,
          username: synthUsername,
          phone_number: prof.phone_number || null,
          role: 'renter',
          fayda_status: isVer ? 'verified' : isPend ? 'pending' : 'unverified',
          fayda_id_number: null,
          fayda_verified_at: isVer ? prof.created_at : null,
          fayda_document_url: null,
          gender: prof.gender || prof.my_gender || null,
          created_at: prof.created_at || new Date().toISOString(),
          updated_at: prof.created_at || new Date().toISOString(),
        });
      }
    }

    const consolidatedList = Array.from(usersMap.values());
    consolidatedList.sort(
      (a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
    );

    const formatted = consolidatedList.map((u) => {
      const prof = profilesMap.get(Number(u.telegram_id));
      let faydaMeta: any = null;
      if (u.fayda_document_url && typeof u.fayda_document_url === 'string' && u.fayda_document_url.startsWith('{')) {
        try {
          faydaMeta = JSON.parse(u.fayda_document_url);
        } catch {}
      }

      const isVerified = u.fayda_status === 'verified' || prof?.kyc_status === 'verified';
      const isPending = u.fayda_status === 'pending' || prof?.kyc_status === 'pending';

      const officialName =
        faydaMeta?.full_name ||
        prof?.full_name ||
        [u.first_name, u.last_name].filter(Boolean).join(' ') ||
        'Not provided';

      const fan = faydaMeta?.fan || u.fayda_id_number || null;
      const dob = faydaMeta?.date_of_birth || faydaMeta?.dob || null;
      const gender = faydaMeta?.gender || prof?.gender || u.gender || null;

      return {
        id: u.id,
        telegram_id: u.telegram_id,
        full_name: officialName,
        first_name: u.first_name,
        last_name: u.last_name,
        username: u.username || prof?.telegram_username?.replace('@', '') || null,
        phone_number: prof?.phone_number || u.phone_number || null,
        gender,
        fayda_id_number: fan,
        fayda_status: isVerified ? 'verified' : isPending ? 'pending' : 'unverified',
        fayda_verified_at: u.fayda_verified_at || faydaMeta?.verified_at || null,
        fayda_dob: dob,
        fayda_metadata: faydaMeta,
        verification_method: faydaMeta?.verified_source
          ? (faydaMeta.verified_source.includes('qr')
              ? 'Offline RS256 QR Digital Signature'
              : 'Verhoeff Checksum Engine')
          : (isVerified ? 'Fayda Verification Engine' : 'N/A'),
        role: u.role || 'renter',
        display_code: prof?.display_code ? `#${prof.display_code.toUpperCase().replace(/^#/, '')}` : null,
        profile_status: prof?.status || null,
        locations: prof?.locations || [],
        budget_min: prof?.budget_min || 0,
        budget_max: prof?.budget_max || 0,
        created_at: u.created_at,
      };
    });

    const pageUsers = formatted.slice(0, limit);
    return NextResponse.json({
      success: true,
      users: pageUsers,
      count: pageUsers.length,
      page,
      limit,
    });
  } catch (err: any) {
    console.error('Error fetching admin users:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
