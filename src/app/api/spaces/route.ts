import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin, supabaseClient } from '@/lib/supabase-server';

const spacesQuerySchema = z.object({
  query: z.string().optional().default(''),
  neighborhood: z.string().optional().default(''),
  category: z.string().optional().default(''),
});

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const parsedQuery = spacesQuerySchema.parse({
      query: searchParams.get('query') || '',
      neighborhood: searchParams.get('neighborhood') || '',
      category: searchParams.get('category') || '',
    });

    let spaces: any[] = [];

    // Attempt 1: Fetch from public_spaces_view
    const { data: viewData, error: viewErr } = await supabaseClient
      .from('public_spaces_view')
      .select(`
        id,
        title,
        description,
        price_per_month,
        unlock_fee,
        neighborhood,
        amenities,
        rules,
        status,
        contact_name,
        created_at,
        space_images
      `)
      .order('created_at', { ascending: false });

    if (!viewErr && viewData && viewData.length > 0) {
      spaces = viewData;
    } else {
      // Fallback: Fetch directly from spaces and space_images tables using supabaseAdmin
      const { data: spacesData } = await supabaseAdmin
        .from('spaces')
        .select('*, space_images(*)')
        .eq('status', 'published')
        .order('created_at', { ascending: false });

      if (spacesData) {
        spaces = spacesData;
      }
    }

    // Filter by text search query (matches title or neighborhood)
    if (parsedQuery.query.trim()) {
      const filterStr = parsedQuery.query.trim().toLowerCase();
      spaces = spaces.filter(
        (s) =>
          (s.title || '').toLowerCase().includes(filterStr) ||
          (s.neighborhood || '').toLowerCase().includes(filterStr) ||
          (s.description || '').toLowerCase().includes(filterStr)
      );
    }

    // Filter explicitly by neighborhood
    if (parsedQuery.neighborhood.trim()) {
      const hoodStr = parsedQuery.neighborhood.trim().toLowerCase();
      spaces = spaces.filter((s) => (s.neighborhood || '').toLowerCase().includes(hoodStr));
    }

    // Zero-Trust Guarantee: Double-check stripping of sensitive contact & location parameters
    const sanitizedSpaces = spaces.map((space: Record<string, any>) => {
      const clean = { ...space };
      delete clean.exact_address;
      delete clean.latitude;
      delete clean.longitude;
      delete clean.contact_phone;
      delete clean.contact_telegram;
      return clean;
    });

    return NextResponse.json({
      success: true,
      count: sanitizedSpaces.length,
      spaces: sanitizedSpaces,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('API Spaces Route Exception:', message);
    return NextResponse.json(
      { error: 'Server error retrieving space listings.', details: message },
      { status: 500 }
    );
  }
}
