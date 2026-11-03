import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-server';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const rawQuery = (searchParams.get('query') || '').trim();
    const cleanText = rawQuery.replace(/^[@#]/, '').trim();
    const cleanDigits = cleanText.replace(/[\s-]/g, '');
    const digitOnly = cleanText.replace(/\D/g, '');
    const isPureNumeric = /^\d+$/.test(cleanDigits);
    const tokens = cleanText.split(/\s+/).filter(Boolean);

    const userQueries: any[] = [];
    const profileQueries: any[] = [];

    if (cleanText) {
      // 1. Full text / phrase match across users
      userQueries.push(
        supabaseAdmin
          .from('users')
          .select('*')
          .or(`first_name.ilike.%${cleanText}%,last_name.ilike.%${cleanText}%,username.ilike.%${cleanText}%,fayda_document_url.ilike.%${cleanText}%`)
          .limit(50)
      );

      // 2. Unspaced / stripped FAN digits search (>= 3 digits)
      if (cleanDigits.length >= 3 && /\d{3,}/.test(cleanDigits)) {
        userQueries.push(
          supabaseAdmin
            .from('users')
            .select('*')
            .or(`fayda_id_number.ilike.%${cleanDigits}%,fayda_document_url.ilike.%${cleanDigits}%`)
            .limit(50)
        );
      }
      if (digitOnly.length >= 3 && digitOnly !== cleanDigits) {
        userQueries.push(
          supabaseAdmin
            .from('users')
            .select('*')
            .or(`fayda_id_number.ilike.%${digitOnly}%,fayda_document_url.ilike.%${digitOnly}%`)
            .limit(50)
        );
      }

      // 3. Multi-token search across individual name tokens
      if (tokens.length > 1) {
        for (const token of tokens.slice(0, 4)) {
          if (token.length >= 2) {
            userQueries.push(
              supabaseAdmin
                .from('users')
                .select('*')
                .or(`first_name.ilike.%${token}%,last_name.ilike.%${token}%,fayda_document_url.ilike.%${token}%`)
                .limit(30)
            );
          }
        }
      }

      // 4. Pure numeric telegram_id search
      if (isPureNumeric) {
        const num = Number(cleanDigits);
        userQueries.push(
          supabaseAdmin.from('users').select('*').eq('telegram_id', num).limit(10)
        );
        profileQueries.push(
          supabaseAdmin.from('profiles').select('*').eq('telegram_id', num).limit(10)
        );
      }

      // 5. Profiles search: full_name, telegram_username, display_code
      profileQueries.push(
        supabaseAdmin
          .from('profiles')
          .select('*')
          .or(`full_name.ilike.%${cleanText}%,telegram_username.ilike.%${cleanText}%,display_code.ilike.%${cleanText}%`)
          .limit(50)
      );

      // 6. Profiles search with multi-word tokens
      if (tokens.length > 1) {
        for (const token of tokens.slice(0, 4)) {
          if (token.length >= 2) {
            profileQueries.push(
              supabaseAdmin
                .from('profiles')
                .select('*')
                .or(`full_name.ilike.%${token}%,telegram_username.ilike.%${token}%,display_code.ilike.%${token}%`)
                .limit(30)
            );
          }
        }
      }

      if (digitOnly.length >= 3) {
        profileQueries.push(
          supabaseAdmin
            .from('profiles')
            .select('*')
            .ilike('display_code', `%${digitOnly}%`)
            .limit(30)
        );
      }
    } else {
      // Default initial view: recent users and profiles
      userQueries.push(
        supabaseAdmin
          .from('users')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(50)
      );
      profileQueries.push(
        supabaseAdmin
          .from('profiles')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(50)
      );
    }

    const [userResults, profileResults] = await Promise.all([
      Promise.all(userQueries),
      Promise.all(profileQueries),
    ]);

    const usersMap = new Map<number, any>();
    const profilesMap = new Map<number, any>();

    for (const res of userResults) {
      if (res?.data && Array.isArray(res.data)) {
        for (const u of res.data) {
          if (u?.telegram_id) {
            usersMap.set(Number(u.telegram_id), u);
          }
        }
      }
    }

    for (const res of profileResults) {
      if (res?.data && Array.isArray(res.data)) {
        for (const p of res.data) {
          if (p?.telegram_id) {
            profilesMap.set(Number(p.telegram_id), p);
          }
        }
      }
    }

    // Fetch missing profiles for found users
    const missingProfileIds = Array.from(usersMap.keys()).filter((id) => !profilesMap.has(id));
    if (missingProfileIds.length > 0) {
      const { data: fetchedProfiles } = await supabaseAdmin
        .from('profiles')
        .select('*')
        .in('telegram_id', missingProfileIds.slice(0, 100));
      if (fetchedProfiles) {
        for (const p of fetchedProfiles) {
          profilesMap.set(Number(p.telegram_id), p);
        }
      }
    }

    // Fetch missing users for found profiles
    const missingUserIds = Array.from(profilesMap.keys()).filter((id) => !usersMap.has(id));
    if (missingUserIds.length > 0) {
      const { data: fetchedUsers } = await supabaseAdmin
        .from('users')
        .select('*')
        .in('telegram_id', missingUserIds.slice(0, 100));
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

    return NextResponse.json({
      success: true,
      users: formatted,
      count: formatted.length,
    });
  } catch (err: any) {
    console.error('Error fetching admin users:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
