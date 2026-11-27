import { NextResponse } from 'next/server';
import { supabaseAdmin, supabaseClient } from '@/lib/supabase-server';
import { spacesFeedCache } from '@/lib/cache';

export async function GET(request: Request) {
  let spaces: any[] = [];
  let cacheStatus: 'HIT' | 'STALE' | 'MISS' = 'MISS';

  try {
    const { searchParams } = new URL(request.url);
    const q = (searchParams.get('query') || '').trim().toLowerCase();
    const hood = (searchParams.get('neighborhood') || '').trim().toLowerCase();
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
    const rawLimit = parseInt(searchParams.get('limit') || '50', 10) || 50;
    const limit = Math.min(50, Math.max(1, rawLimit));
    const offset = (page - 1) * limit;
    const cacheKey = `spaces:${q}|${hood}|p${page}|l${limit}`;

    const result = await spacesFeedCache.getOrFetchWithMeta(cacheKey, async () => {
      let fetched: any[] = [];
      let hadError = false;

      try {
        let viewQuery = supabaseClient.from('public_spaces_view').select('*');
        if (q) {
          const safeQ = q.replace(/[,()":%_\\]/g, ' ').trim();
          if (safeQ) {
            viewQuery = viewQuery.or(`title.ilike.%${safeQ}%,neighborhood.ilike.%${safeQ}%,description.ilike.%${safeQ}%`);
          }
        }
        if (hood) {
          const safeHood = hood.replace(/[,()":%_\\]/g, ' ').trim();
          if (safeHood) {
            viewQuery = viewQuery.ilike('neighborhood', `%${safeHood}%`);
          }
        }
        const { data: viewData, error: viewErr } = await viewQuery
          .order('created_at', { ascending: false })
          .range(offset, offset + limit - 1);

        if (viewErr) hadError = true;
        if (viewData && viewData.length > 0) {
          fetched = viewData;
        }
      } catch {
        hadError = true;
      }

      if (fetched.length === 0) {
        try {
          let adminQuery = supabaseAdmin
            .from('spaces')
            .select('*, space_images(*)')
            .eq('status', 'published');
          if (q) {
            const safeQ = q.replace(/[,()":%_\\]/g, ' ').trim();
            if (safeQ) {
              adminQuery = adminQuery.or(`title.ilike.%${safeQ}%,neighborhood.ilike.%${safeQ}%,description.ilike.%${safeQ}%`);
            }
          }
          if (hood) {
            const safeHood = hood.replace(/[,()":%_\\]/g, ' ').trim();
            if (safeHood) {
              adminQuery = adminQuery.ilike('neighborhood', `%${safeHood}%`);
            }
          }
          const { data: spacesData, error: adminErr } = await adminQuery
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

          if (adminErr) hadError = true;
          else hadError = false;
          if (spacesData && spacesData.length > 0) {
            fetched = spacesData;
          }
        } catch {
          hadError = true;
        }
      }

      if (hadError && fetched.length === 0) {
        throw new Error('Upstream spaces query failed');
      }

      if (q) {
        fetched = fetched.filter(
          (s) =>
            (s.title || '').toLowerCase().includes(q) ||
            (s.neighborhood || '').toLowerCase().includes(q) ||
            (s.description || '').toLowerCase().includes(q)
        );
      }

      if (hood) {
        fetched = fetched.filter((s) => (s.neighborhood || '').toLowerCase().includes(hood));
      }

      const pagedSpaces = fetched.slice(0, 50);
      const sanitized = pagedSpaces.map((space: Record<string, any>) => {
        const clean: Record<string, any> = { ...space, unlock_fee: 100 };
        delete clean.exact_address;
        delete clean.latitude;
        delete clean.longitude;
        delete clean.contact_phone;
        delete clean.contact_telegram;
        return clean;
      });
      return { spaces: sanitized };
    });

    spaces = result.value.spaces;
    cacheStatus = result.status;
  } catch (err) {
    console.error('API Spaces Route safe catch:', err);
    spaces = [];
  }

  return NextResponse.json(
    {
      success: true,
      count: spaces.length,
      spaces,
    },
    {
      headers: {
        'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
        'X-Cache': cacheStatus,
      },
    }
  );
}
