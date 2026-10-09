import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-server';

const FALLBACK_SEEKERS = [
  {
    id: 'seeker-1',
    first_name: 'Helina',
    preferred_subcity: ['Bole', 'Kazanchis'],
    my_gender: 'Female',
    preferred_gender: 'Female',
    budget_max: 12000,
    lifestyle_bio: 'Software Developer working at Kazanchis. Quiet, non-smoker, clean. Looking to share a 2-bedroom condo.',
    fayda_status: 'verified',
    unlock_fee: 50,
    created_at: new Date().toISOString(),
  },
  {
    id: 'seeker-2',
    first_name: 'Amanuel',
    preferred_subcity: ['CMC', 'Sarbet'],
    my_gender: 'Male',
    preferred_gender: 'Male',
    budget_max: 9500,
    lifestyle_bio: 'Civil Engineer, loves gaming and coffee. Looking for a friendly roommate to split rent.',
    fayda_status: 'verified',
    unlock_fee: 50,
    created_at: new Date(Date.now() - 3600000).toISOString(),
  },
  {
    id: 'seeker-3',
    first_name: 'Selam',
    preferred_subcity: ['Piassa', '4 Kilo'],
    my_gender: 'Female',
    preferred_gender: 'Any',
    budget_max: 10000,
    lifestyle_bio: 'Postgrad student at AAU. Respectful, tidy, move-in target by Nov 1.',
    fayda_status: 'pending',
    unlock_fee: 50,
    created_at: new Date(Date.now() - 7200000).toISOString(),
  },
];

export async function GET(request: Request) {
  let seekers: any[] = [];

  try {
    const { searchParams } = new URL(request.url);
    const subcity = (searchParams.get('subcity') || '').trim().toLowerCase();

    try {
      const { data: dbSeekers } = await supabaseAdmin
        .from('roommate_profiles')
        .select('*, users!inner(first_name, fayda_status)')
        .eq('status', 'approved')
        .order('created_at', { ascending: false });

      if (dbSeekers && dbSeekers.length > 0) {
        seekers = dbSeekers.map((s: any) => ({
          id: s.id,
          first_name: s.users?.first_name || 'Seeker',
          preferred_subcity: s.preferred_subcity || [],
          my_gender: s.my_gender,
          preferred_gender: s.preferred_gender,
          budget_max: Number(s.budget_max || 0),
          lifestyle_bio: s.lifestyle_bio || '',
          fayda_status: s.users?.fayda_status || 'verified',
          unlock_fee: Number(s.unlock_fee || 50),
          created_at: s.created_at,
        }));
      }
    } catch {
      // Supabase unreachable, fallback gracefully
    }

    if (seekers.length === 0) {
      seekers = FALLBACK_SEEKERS;
    }

    if (subcity && subcity !== 'all') {
      seekers = seekers.filter((s) =>
        s.preferred_subcity.some((sub: string) => sub.toLowerCase().includes(subcity))
      );
    }
  } catch (err) {
    console.error('API Roommates Route safe catch:', err);
    seekers = FALLBACK_SEEKERS;
  }

  return NextResponse.json({
    success: true,
    count: seekers.length,
    seekers,
  });
}
