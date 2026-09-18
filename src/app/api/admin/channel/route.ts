import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-server';
import {
  broadcastListingToChannel,
  deleteChannelPost,
  postCustomToChannel,
} from '@/lib/telegram-broadcast';

export async function GET() {
  try {
    // 1. Fetch published & pending spaces
    const { data: spaces, error: spacesErr } = await supabaseAdmin
      .from('spaces')
      .select('*, space_images(*)')
      .order('created_at', { ascending: false });

    // 2. Fetch orders
    const { data: orders } = await supabaseAdmin
      .from('orders')
      .select('*, spaces(title, price_per_month, unlock_fee)')
      .order('created_at', { ascending: false });

    // 3. Fetch users count
    const { count: usersCount } = await supabaseAdmin
      .from('users')
      .select('*', { count: 'exact', head: true });

    if (spacesErr) {
      return NextResponse.json({ success: false, error: spacesErr.message }, { status: 500 });
    }

    const publishedSpaces = spaces?.filter((s) => s.status === 'published') || [];
    const archivedSpaces = spaces?.filter((s) => s.status === 'archived') || [];

    const completedOrders = orders?.filter((o) => o.payment_status === 'completed') || [];
    const totalRevenue = completedOrders.reduce((acc, o) => acc + (Number(o.amount) || 0), 0);

    return NextResponse.json({
      success: true,
      stats: {
        totalSpaces: spaces?.length || 0,
        publishedCount: publishedSpaces.length,
        archivedCount: archivedSpaces.length,
        ordersCount: orders?.length || 0,
        completedOrdersCount: completedOrders.length,
        totalRevenueETB: totalRevenue,
        usersCount: usersCount || 0,
      },
      spaces: spaces || [],
      orders: orders || [],
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action, listingId, messageId, text, photoUrl } = body;

    if (action === 'broadcast') {
      if (!listingId) {
        return NextResponse.json({ success: false, error: 'listingId is required' }, { status: 400 });
      }
      const res = await broadcastListingToChannel(listingId);
      return NextResponse.json(res);
    }

    if (action === 'delete_post') {
      if (!messageId && !listingId) {
        return NextResponse.json({ success: false, error: 'messageId or listingId is required' }, { status: 400 });
      }

      let msgIdToDelete = messageId;

      // If listingId provided, update space status to archived in DB
      if (listingId) {
        await supabaseAdmin
          .from('spaces')
          .update({ status: 'archived', updated_at: new Date().toISOString() })
          .eq('id', listingId);
      }

      if (msgIdToDelete) {
        const delRes = await deleteChannelPost(Number(msgIdToDelete));
        return NextResponse.json(delRes);
      }

      return NextResponse.json({
        success: true,
        message: 'Space listing archived in database.',
      });
    }

    if (action === 'custom_post') {
      if (!text || !text.trim()) {
        return NextResponse.json({ success: false, error: 'Post text is required' }, { status: 400 });
      }

      const postRes = await postCustomToChannel(text.trim(), photoUrl, listingId);
      return NextResponse.json(postRes);
    }

    if (action === 'delete_space_db') {
      if (!listingId) {
        return NextResponse.json({ success: false, error: 'listingId is required' }, { status: 400 });
      }

      await supabaseAdmin.from('space_images').delete().eq('space_id', listingId);
      await supabaseAdmin.from('orders').delete().eq('space_id', listingId);
      const { error } = await supabaseAdmin.from('spaces').delete().eq('id', listingId);

      if (error) {
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
      }

      return NextResponse.json({
        success: true,
        message: `Listing ${listingId} permanently deleted from database.`,
      });
    }

    return NextResponse.json({ success: false, error: `Invalid action '${action}'` }, { status: 400 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
