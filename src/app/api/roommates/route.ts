import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-server';

export async function GET(request: Request) {
  let seekers: any[] = [];

  try {
    const { searchParams } = new URL(request.url);
    const subcity = (searchParams.get('subcity') || '').trim().toLowerCase();
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
    const rawLimit = parseInt(searchParams.get('limit') || '50', 10) || 50;
    const limit = Math.min(50, Math.max(1, rawLimit));
    const offset = (page - 1) * limit;

    try {
      let rmQuery = supabaseAdmin
        .from('roommate_profiles')
        .select('*, users(fayda_status)')
        .eq('status', 'approved');

      if (subcity && subcity !== 'all') {
        const capSubcity = subcity.charAt(0).toUpperCase() + subcity.slice(1);
        rmQuery = rmQuery.overlaps('preferred_subcity', [subcity, capSubcity]);
      }

      const { data: dbSeekers } = await rmQuery
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (dbSeekers && dbSeekers.length > 0) {
        seekers = dbSeekers.map((s: any) => {
          const code = s.display_code || `RM${s.id.slice(0, 4).toUpperCase()}`;
          return {
            id: s.id,
            display_code: code,
            first_name: `Roommate #${code}`,
            display_name: `Roommate #${code}`,
            preferred_subcity: s.preferred_subcity || [],
            my_gender: s.my_gender,
            preferred_gender: s.preferred_gender,
            budget_max: Number(s.budget_max || 0),
            lifestyle_bio: s.lifestyle_bio || '',
            fayda_status: s.users?.fayda_status || 'unverified',
            unlock_fee: 100,
            created_at: s.created_at,
          };
        });
      }
    } catch {
      // Supabase unreachable, return empty list cleanly
    }

    if (subcity && subcity !== 'all') {
      seekers = seekers.filter((s) =>
        s.preferred_subcity.some((sub: string) => sub.toLowerCase().includes(subcity))
      );
    }
  } catch (err) {
    console.error('API Roommates Route safe catch:', err);
    seekers = [];
  }

  const pagedSeekers = seekers.slice(0, 50);

  return NextResponse.json(
    {
      success: true,
      count: pagedSeekers.length,
      seekers: pagedSeekers,
    },
    {
      headers: {
        'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=120',
      },
    }
  );
}
