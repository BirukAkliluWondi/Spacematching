import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-server';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const query = (searchParams.get('query') || '').trim();

    // Query users from database
    let usersQuery = supabaseAdmin
      .from('users')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);

    if (query) {
      const clean = query.replace(/^@/, '').replace(/^#/, '');
      const isNumeric = /^\d+$/.test(clean);
      if (isNumeric) {
        usersQuery = supabaseAdmin
          .from('users')
          .select('*')
          .or(`telegram_id.eq.${clean},fayda_id_number.ilike.%${clean}%`)
          .limit(50);
      } else {
        usersQuery = supabaseAdmin
          .from('users')
          .select('*')
          .or(`first_name.ilike.%${clean}%,last_name.ilike.%${clean}%,username.ilike.%${clean}%,fayda_id_number.ilike.%${clean}%`)
          .limit(50);
      }
    }

    const { data: dbUsers, error: usersErr } = await usersQuery;
    if (usersErr) {
      return NextResponse.json({ success: false, error: usersErr.message }, { status: 500 });
    }

    const usersList = dbUsers ? [...dbUsers] : [];
    const profilesMap = new Map<number, any>();

    if (usersList.length > 0) {
      const tgIds = usersList.map((u) => u.telegram_id);
      const { data: profiles } = await supabaseAdmin
        .from('profiles')
        .select('*')
        .in('telegram_id', tgIds);

      if (profiles) {
        for (const p of profiles) {
          profilesMap.set(Number(p.telegram_id), p);
        }
      }
    }

    // If query given, also search profiles directly to catch any matching full_name or display_code
    if (query) {
      const clean = query.replace(/^@/, '').replace(/^#/, '');
      const { data: extraProfiles } = await supabaseAdmin
        .from('profiles')
        .select('*')
        .or(`full_name.ilike.%${clean}%,telegram_username.ilike.%${clean}%,display_code.ilike.%${clean}%`)
        .limit(30);

      if (extraProfiles) {
        const missingTgIds = extraProfiles
          .map((p) => Number(p.telegram_id))
          .filter((id) => !profilesMap.has(id));

        if (missingTgIds.length > 0) {
          const { data: extraUsers } = await supabaseAdmin
            .from('users')
            .select('*')
            .in('telegram_id', missingTgIds);

          if (extraUsers) {
            for (const u of extraUsers) {
              usersList.push(u);
            }
          }
          for (const p of extraProfiles) {
            profilesMap.set(Number(p.telegram_id), p);
          }
        }
      }
    }

    // Format consolidated user records with rich Fayda information
    const formatted = usersList.map((u) => {
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
