import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseClient } from '@/lib/supabase-server';

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

    // Query strictly from public_spaces_view which includes aggregated space_images JSON
    let query = supabaseClient
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

    // Filter by text search query (matches title or neighborhood)
    if (parsedQuery.query.trim()) {
      const filterStr = parsedQuery.query.trim();
      query = query.or(`title.ilike.%${filterStr}%,neighborhood.ilike.%${filterStr}%`);
    }

    // Filter explicitly by neighborhood
    if (parsedQuery.neighborhood.trim()) {
      query = query.ilike('neighborhood', `%${parsedQuery.neighborhood.trim()}%`);
    }

    // Filter by category / amenity keyword
    if (parsedQuery.category.trim() && parsedQuery.category.toLowerCase() !== 'all') {
      query = query.contains('amenities', [parsedQuery.category.trim()]);
    }

    const { data: spaces, error } = await query;

    if (error) {
      console.error('Supabase query error on public_spaces_view:', error);
      return NextResponse.json(
        { error: 'Failed to retrieve public spaces.', details: error.message },
        { status: 500 }
      );
    }

    // Zero-Trust Guarantee: Double-check stripping of sensitive contact & location parameters
    const sanitizedSpaces = (spaces || []).map((space: Record<string, unknown>) => {
      delete space.exact_address;
      delete space.latitude;
      delete space.longitude;
      delete space.contact_phone;
      delete space.contact_telegram;
      return space;
    });

    return NextResponse.json({
      success: true,
      count: sanitizedSpaces.length,
      spaces: sanitizedSpaces,
    });
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid query parameters.', details: error.issues },
        { status: 400 }
      );
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error('API Spaces Route Exception:', message);
    return NextResponse.json(
      { error: 'Server error retrieving space listings.' },
      { status: 500 }
    );
  }
}
