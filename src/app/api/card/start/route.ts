import { NextRequest, NextResponse } from 'next/server';
import { generateStartCardPng } from '@/lib/dynamic-card-generator';
import { getUserMembershipStatus } from '@/lib/bot-session-store';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const chatIdParam = searchParams.get('chatId');
    const nameParam = searchParams.get('name') || 'Resident';

    let isMember = searchParams.get('isMember') === 'true';
    let daysRemaining = parseInt(searchParams.get('days') || '0', 10);

    if (chatIdParam) {
      const chatId = parseInt(chatIdParam, 10);
      if (!isNaN(chatId)) {
        const mem = await getUserMembershipStatus(chatId);
        isMember = mem.isActive;
        daysRemaining = mem.daysRemaining;
      }
    }

    const pngBuffer = await generateStartCardPng({
      userName: nameParam,
      isMember,
      daysRemaining,
    });

    return new NextResponse(pngBuffer as any, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=60, s-maxage=60',
      },
    });
  } catch (error) {
    console.error('Failed to generate dynamic start card:', error);
    return new NextResponse('Internal Server Error', { status: 500 });
  }
}
