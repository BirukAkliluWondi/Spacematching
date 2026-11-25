import { NextResponse } from 'next/server';
import { supabaseAdmin, supabaseClient } from '@/lib/supabase-server';

export async function GET(request: Request) {
  let spaces: any[] = [];

  try {
    const { searchParams } = new URL(request.url);
    const q = (searchParams.get('query') || '').trim().toLowerCase();
    const hood = (searchParams.get('neighborhood') || '').trim().toLowerCase();
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
    const rawLimit = parseInt(searchParams.get('limit') || '50', 10) || 50;
    const limit = Math.min(50, Math.max(1, rawLimit));
    const offset = (page - 1) * limit;

    // Attempt Supabase fetch safely with bounded pagination
    try {
      const { data: viewData } = await supabaseClient
        .from('public_spaces_view')
        .select('*')
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (viewData && viewData.length > 0) {
        spaces = viewData;
      }
    } catch {
      // Supabase unreachable, return empty list cleanly
    }

    if (spaces.length === 0) {
      try {
        const { data: spacesData } = await supabaseAdmin
          .from('spaces')
          .select('*, space_images(*)')
          .eq('status', 'published')
          .order('created_at', { ascending: false })
          .range(offset, offset + limit - 1);

        if (spacesData && spacesData.length > 0) {
          spaces = spacesData;
        }
      } catch {
        // Ignore error
      }
    }

    if (q) {
      spaces = spaces.filter(
        (s) =>
          (s.title || '').toLowerCase().includes(q) ||
          (s.neighborhood || '').toLowerCase().includes(q) ||
          (s.description || '').toLowerCase().includes(q)
      );
    }

    if (hood) {
      spaces = spaces.filter((s) => (s.neighborhood || '').toLowerCase().includes(hood));
    }
  } catch (err) {
    console.error('API Spaces Route safe catch:', err);
    spaces = [];
  }

  const pagedSpaces = spaces.slice(0, 50);
  const sanitizedSpaces = pagedSpaces.map((space: Record<string, any>) => {
    const clean: Record<string, any> = { ...space, unlock_fee: 100 };
    delete clean.exact_address;
    delete clean.latitude;
    delete clean.longitude;
    delete clean.contact_phone;
    delete clean.contact_telegram;
    return clean;
  });

  return NextResponse.json(
    {
      success: true,
      count: sanitizedSpaces.length,
      spaces: sanitizedSpaces,
    },
    {
      headers: {
        'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=120',
      },
    }
  );
}
