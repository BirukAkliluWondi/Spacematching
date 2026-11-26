import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-server';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const subcity = (searchParams.get('subcity') || '').trim().toLowerCase();
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
    const rawLimit = parseInt(searchParams.get('limit') || '50', 10) || 50;
    const limit = Math.min(50, Math.max(1, rawLimit));

    const { data: dbSeekers, error: rmErr } = await supabaseAdmin
      .from('roommate_profiles')
      .select('*, users(fayda_status)')
      .eq('status', 'approved')
      .order('created_at', { ascending: false })
      .limit(200);

    if (rmErr) {
      console.error('API Roommates Route DB error:', rmErr.message);
      return NextResponse.json(
        { success: false, error: 'Failed to load roommates from database.' },
        { status: 500, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const rawRows = dbSeekers || [];
    const tgIds = Array.from(
      new Set(rawRows.map((r: any) => Number(r.user_telegram_id)).filter((n) => Number.isFinite(n) && n !== 0))
    );

    const codeByTgId = new Map<number, string>();
    if (tgIds.length > 0) {
      const { data: profRows } = await supabaseAdmin
        .from('profiles')
        .select('telegram_id, display_code')
        .in('telegram_id', tgIds);
      for (const p of profRows || []) {
        if (p.telegram_id && p.display_code) {
          codeByTgId.set(Number(p.telegram_id), String(p.display_code).replace(/^#/, ''));
        }
      }
    }

    let seekers = rawRows.map((s: any) => {
      const resolvedCode =
        codeByTgId.get(Number(s.user_telegram_id)) || `RM${String(s.id).slice(0, 4).toUpperCase()}`;
      return {
        id: s.id,
        display_code: resolvedCode,
        first_name: `Roommate #${resolvedCode}`,
        display_name: `Roommate #${resolvedCode}`,
        preferred_subcity: Array.isArray(s.preferred_subcity) ? s.preferred_subcity : [],
        my_gender: s.my_gender,
        preferred_gender: s.preferred_gender,
        budget_max: Number(s.budget_max || 0),
        lifestyle_bio: s.lifestyle_bio || '',
        fayda_status: s.users?.fayda_status || 'unverified',
        unlock_fee: 100,
        created_at: s.created_at,
      };
    });

    if (subcity && subcity !== 'all') {
      seekers = seekers.filter((s) =>
        s.preferred_subcity.some((sub: string) => String(sub).toLowerCase().includes(subcity))
      );
    }

    const offset = (page - 1) * limit;
    const pagedSeekers = seekers.slice(offset, offset + limit);

    return NextResponse.json(
      {
        success: true,
        count: pagedSeekers.length,
        seekers: pagedSeekers,
      },
      {
        headers: {
          'Cache-Control': 'no-store',
        },
      }
    );
  } catch (err) {
    console.error('API Roommates Route exception:', err);
    return NextResponse.json(
      { success: false, error: 'Failed to load roommates.' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
