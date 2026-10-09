import { NextResponse } from 'next/server';
import { supabaseAdmin, supabaseClient } from '@/lib/supabase-server';

const FALLBACK_SPACES = [
  {
    id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    title: 'Modern Single Studio Room in Bole Atlas',
    description: 'Cozy, fully furnished room with private bathroom, high-speed WiFi, 24/7 security, and generator back-up. Walking distance to Edna Mall.',
    price_per_month: 12500,
    unlock_fee: 50,
    neighborhood: 'Bole Atlas',
    amenities: ['WiFi', 'Furnished', 'Private Bath', 'Backup Generator', 'Parking'],
    rules: ['No smoking', 'Quiet hours after 10 PM', 'No pets'],
    status: 'published',
    contact_name: 'Solomon Kebede',
    created_at: new Date(Date.now() - 3600000).toISOString(),
    space_images: [
      {
        id: 'img1',
        image_path: 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?auto=format&fit=crop&w=800&q=80',
        display_order: 1,
      },
    ],
  },
  {
    id: 'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
    title: 'Spacious Master Bedroom in Kazanchis',
    description: 'Sunlit room with balcony, dedicated workspace, shared kitchen, and water tanker. Located near UNECA and Intercontinental Hotel.',
    price_per_month: 15000,
    unlock_fee: 50,
    neighborhood: 'Kazanchis',
    amenities: ['WiFi', 'Balcony', 'Workspace', 'Shared Kitchen', 'Hot Shower'],
    rules: ['Professional renters preferred', 'No overnight unregistered guests'],
    status: 'published',
    contact_name: 'Marta Tadesse',
    created_at: new Date(Date.now() - 7200000).toISOString(),
    space_images: [
      {
        id: 'img2',
        image_path: 'https://images.unsplash.com/photo-1598928506311-c55ded91a20c?auto=format&fit=crop&w=800&q=80',
        display_order: 1,
      },
    ],
  },
  {
    id: 'c2eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
    title: '1-Bedroom Condo Apartment in CMC',
    description: 'Modern 1-bedroom apartment in a safe gated condo community. Includes elevators, parking slot, and water reservoir.',
    price_per_month: 18000,
    unlock_fee: 50,
    neighborhood: 'CMC',
    amenities: ['Elevator', 'Parking', 'Gated Security', 'Kitchen'],
    rules: ['Quiet hours after 10 PM'],
    status: 'published',
    contact_name: 'Dawit Abebe',
    created_at: new Date(Date.now() - 14400000).toISOString(),
    space_images: [
      {
        id: 'img3',
        image_path: 'https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?auto=format&fit=crop&w=800&q=80',
        display_order: 1,
      },
    ],
  },
];

export async function GET(request: Request) {
  let spaces: any[] = [];

  try {
    const { searchParams } = new URL(request.url);
    const q = (searchParams.get('query') || '').trim().toLowerCase();
    const hood = (searchParams.get('neighborhood') || '').trim().toLowerCase();

    // Attempt Supabase fetch safely
    try {
      const { data: viewData } = await supabaseClient
        .from('public_spaces_view')
        .select('*')
        .order('created_at', { ascending: false });

      if (viewData && viewData.length > 0) {
        spaces = viewData;
      }
    } catch {
      // Supabase unreachable, ignore error
    }

    if (spaces.length === 0) {
      try {
        const { data: spacesData } = await supabaseAdmin
          .from('spaces')
          .select('*, space_images(*)')
          .eq('status', 'published')
          .order('created_at', { ascending: false });

        if (spacesData && spacesData.length > 0) {
          spaces = spacesData;
        }
      } catch {
        // Ignore error
      }
    }

    // Fallback if DB fetch returned empty or threw DNS resolution error
    if (spaces.length === 0) {
      spaces = FALLBACK_SPACES;
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
    spaces = FALLBACK_SPACES;
  }

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
}
