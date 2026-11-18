/**
 * lib/dynamic-card-generator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Universal Dynamic Visual Card Generator for Telegram Bot Screens.
 * Uses Next.js native ImageResponse (Satori + resvg-wasm) with bundled
 * Open-Source TrueType fonts (Geist + Noto Sans Ethiopic) to guarantee 100% font
 * fidelity on all environments (Vercel serverless Linux, Docker, Windows, macOS).
 */

import fs from 'fs';
import path from 'path';
import React from 'react';
import { ImageResponse } from 'next/og';

export type CardScreenType = 'start' | 'post_branch' | 'membership' | 'fayda' | 'search' | 'my_listings';

export interface DynamicCardParams {
  screenType?: CardScreenType;
  userName?: string;
  isMember?: boolean;
  daysRemaining?: number;
  lang?: 'en' | 'am' | 'bilingual';
  badgeText?: string;
  badgeColor?: string;
  badgeBg?: string;
  badgeBorder?: string;
}

interface FontCache {
  geist: Buffer;
  ethiopicBold: Buffer;
  ethiopicRegular: Buffer;
}

let _fontCache: FontCache | null = null;

function loadFonts(): FontCache {
  if (_fontCache) return _fontCache;

  const fontsDir = path.join(process.cwd(), 'src', 'assets', 'fonts');
  const geist = fs.readFileSync(path.join(fontsDir, 'Geist-Regular.ttf'));
  const ethiopicBold = fs.readFileSync(path.join(fontsDir, 'NotoSansEthiopic-Bold.ttf'));
  const ethiopicRegular = fs.readFileSync(path.join(fontsDir, 'NotoSansEthiopic-Regular.ttf'));

  _fontCache = { geist, ethiopicBold, ethiopicRegular };
  return _fontCache;
}

interface CardContent {
  badgeText: string;
  badgeColor: string;
  badgeBg: string;
  badgeBorder: string;
  greeting?: string;
  headline: string;
  subheadline: string;
  pillar1: { icon: 'search' | 'shield' | 'connection' | 'home' | 'payment' | 'list'; title: string; amharic: string; desc: string };
  pillar2: { icon: 'search' | 'shield' | 'connection' | 'home' | 'payment' | 'list'; title: string; amharic: string; desc: string };
  pillar3: { icon: 'search' | 'shield' | 'connection' | 'home' | 'payment' | 'list'; title: string; amharic: string; desc: string };
}

function renderPillarIcon(icon: string) {
  switch (icon) {
    case 'search':
      return React.createElement(
        'div',
        {
          style: {
            width: '32px',
            height: '32px',
            borderRadius: '16px',
            backgroundColor: '#003258',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          },
        },
        React.createElement(
          'svg',
          { width: '16', height: '16', viewBox: '0 0 24 24', fill: 'none', stroke: '#9ecaff', strokeWidth: '2.2', strokeLinecap: 'round', strokeLinejoin: 'round' },
          React.createElement('circle', { cx: '11', cy: '11', r: '7' }),
          React.createElement('line', { x1: '21', y1: '21', x2: '16', y2: '16' })
        )
      );
    case 'shield':
      return React.createElement(
        'div',
        {
          style: {
            width: '32px',
            height: '32px',
            borderRadius: '16px',
            backgroundColor: '#003915',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          },
        },
        React.createElement(
          'svg',
          { width: '16', height: '16', viewBox: '0 0 24 24', fill: 'none', stroke: '#4ae176', strokeWidth: '2.5', strokeLinecap: 'round', strokeLinejoin: 'round' },
          React.createElement('polyline', { points: '20 6 9 17 4 12' })
        )
      );
    case 'home':
      return React.createElement(
        'div',
        {
          style: {
            width: '32px',
            height: '32px',
            borderRadius: '16px',
            backgroundColor: '#2e1c45',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          },
        },
        React.createElement(
          'svg',
          { width: '16', height: '16', viewBox: '0 0 24 24', fill: 'none', stroke: '#d0bcff', strokeWidth: '2.2', strokeLinecap: 'round', strokeLinejoin: 'round' },
          React.createElement('path', { d: 'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }),
          React.createElement('polyline', { points: '9 22 9 12 15 12 15 22' })
        )
      );
    case 'payment':
      return React.createElement(
        'div',
        {
          style: {
            width: '32px',
            height: '32px',
            borderRadius: '16px',
            backgroundColor: '#003915',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          },
        },
        React.createElement(
          'svg',
          { width: '16', height: '16', viewBox: '0 0 24 24', fill: 'none', stroke: '#4ae176', strokeWidth: '2.2', strokeLinecap: 'round', strokeLinejoin: 'round' },
          React.createElement('rect', { x: '2', y: '5', width: '20', height: '14', rx: '2' }),
          React.createElement('line', { x1: '2', y1: '10', x2: '22', y2: '10' })
        )
      );
    case 'list':
      return React.createElement(
        'div',
        {
          style: {
            width: '32px',
            height: '32px',
            borderRadius: '16px',
            backgroundColor: '#21496f',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          },
        },
        React.createElement(
          'svg',
          { width: '16', height: '16', viewBox: '0 0 24 24', fill: 'none', stroke: '#a4caf6', strokeWidth: '2.2', strokeLinecap: 'round', strokeLinejoin: 'round' },
          React.createElement('line', { x1: '8', y1: '6', x2: '21', y2: '6' }),
          React.createElement('line', { x1: '8', y1: '12', x2: '21', y2: '12' }),
          React.createElement('line', { x1: '8', y1: '18', x2: '21', y2: '18' }),
          React.createElement('line', { x1: '3', y1: '6', x2: '3.01', y2: '6' }),
          React.createElement('line', { x1: '3', y1: '12', x2: '3.01', y2: '12' }),
          React.createElement('line', { x1: '3', y1: '18', x2: '3.01', y2: '18' })
        )
      );
    case 'connection':
    default:
      return React.createElement(
        'div',
        {
          style: {
            width: '32px',
            height: '32px',
            borderRadius: '16px',
            backgroundColor: '#21496f',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          },
        },
        React.createElement(
          'svg',
          { width: '16', height: '16', viewBox: '0 0 24 24', fill: 'none', stroke: '#a4caf6', strokeWidth: '2.2', strokeLinecap: 'round', strokeLinejoin: 'round' },
          React.createElement('path', { d: 'M5 12h14' }),
          React.createElement('path', { d: 'M12 5l7 7-7 7' })
        )
      );
  }
}

function getCardConfig(type: CardScreenType, params: DynamicCardParams): CardContent {
  const isMember = Boolean(params.isMember);
  const days = Math.max(0, params.daysRemaining || 0);
  const cleanName = (params.userName?.trim() || 'Resident').slice(0, 24);

  const memBadgeText = isMember ? `ACTIVE PASS · ${days} DAYS` : '30-DAY PASS · 300 ETB';
  const memBadgeColor = isMember ? '#10b981' : '#94a3b8';
  const memBadgeBg = isMember ? 'rgba(16, 185, 129, 0.15)' : 'rgba(148, 163, 184, 0.15)';
  const memBadgeBorder = isMember ? '#059669' : '#475569';

  switch (type) {
    case 'post_branch':
      return {
        badgeText: 'POST PROFILE · መረጃ መለጠፊያ',
        badgeColor: '#38bdf8',
        badgeBg: 'rgba(56, 189, 248, 0.15)',
        badgeBorder: '#0284c7',
        greeting: `Welcome, ${cleanName}! · እንኳን ደህና መጡ!`,
        headline: 'Post Your Profile',
        subheadline: 'የቤት አጋር ወይም የሚከራይ ክፍል ማስታወቂያ ይለጥፉ',
        pillar1: {
          icon: 'connection',
          title: 'Seeker Roommate',
          amharic: 'አብረን ቤት እንፈልጋለን',
          desc: 'Find compatible roommates to search for a house together.',
        },
        pillar2: {
          icon: 'home',
          title: 'Space Host',
          amharic: 'የሚከራይ ክፍል አለኝ',
          desc: 'List an available bedroom or shared flat to find housemates.',
        },
        pillar3: {
          icon: 'shield',
          title: 'Fayda Verified',
          amharic: 'የፋይዳ ማረጋገጫ',
          desc: 'Every listing is cryptographically verified to eliminate brokers.',
        },
      };

    case 'membership':
      return {
        badgeText: '30-DAY PASS · 300 ETB',
        badgeColor: '#10b981',
        badgeBg: 'rgba(16, 185, 129, 0.15)',
        badgeBorder: '#059669',
        greeting: 'Unlimited Access · ሙሉ አገልግሎት',
        headline: 'SpaceMatch 30-Day Pass',
        subheadline: 'ያልተገደበ የቤት አጋር ጥያቄዎች እና ቀጥተኛ ግንኙነት',
        pillar1: {
          icon: 'payment',
          title: 'Instant Telebirr',
          amharic: 'በቴሌብር ወዲያው',
          desc: 'Automated receipt verification in seconds via Telebirr or banks.',
        },
        pillar2: {
          icon: 'connection',
          title: 'Direct Unlocks',
          amharic: 'ቀጥተኛ ስልክ እና ቴሌግራም',
          desc: 'Unlocks phone numbers and handles with no hidden broker cuts.',
        },
        pillar3: {
          icon: 'shield',
          title: 'All-Inclusive',
          amharic: 'የ30 ቀን ያልተገደበ',
          desc: 'Send connection requests to all verified listings across Addis.',
        },
      };

    case 'fayda':
      return {
        badgeText: 'FAYDA SHIELD · ብሔራዊ መታወቂያ',
        badgeColor: '#4ae176',
        badgeBg: 'rgba(74, 225, 118, 0.15)',
        badgeBorder: '#003915',
        greeting: 'Zero Storage Verification · ሙሉ ደህንነት',
        headline: 'Cryptographic Fayda Shield',
        subheadline: '100% የተረጋገጠ እና ከአጭበርባሪ ደላላ ነፃ ማህበረሰብ',
        pillar1: {
          icon: 'shield',
          title: 'In-Memory Only',
          amharic: 'በRAM ብቻ የሚረጋገጥ',
          desc: 'ID photos are checked in volatile RAM and deleted immediately.',
        },
        pillar2: {
          icon: 'search',
          title: 'QR Code Signature',
          amharic: 'የQR ዲጂታል ማረጋገጫ',
          desc: 'Cryptographic RS256 signature verification in milliseconds.',
        },
        pillar3: {
          icon: 'connection',
          title: 'Double-Blind Privacy',
          amharic: 'ሙሉ ሚስጥራዊነት',
          desc: 'Contacts stay 100% hidden until both sides accept connection.',
        },
      };

    case 'search':
      return {
        badgeText: 'SMART MATCH · ብልጥ አጋር ፈላጊ',
        badgeColor: '#38bdf8',
        badgeBg: 'rgba(56, 189, 248, 0.15)',
        badgeBorder: '#0284c7',
        greeting: `Matchmaker · ለ ${cleanName}`,
        headline: 'Find Compatible Roommates',
        subheadline: 'በአካባቢ፣ በበጀት እና በአኗኗር ዘይቤ የተጣጣሙ አጋሮች',
        pillar1: {
          icon: 'search',
          title: 'Sub-City Filter',
          amharic: 'የሰፈር ምርጫ',
          desc: 'Filter verified residents across Bole, CMC, Sarbet, and all Addis.',
        },
        pillar2: {
          icon: 'payment',
          title: 'Rent Split Budget',
          amharic: 'የወር ኪራይ በጀት',
          desc: 'Match compatible rent budgets from 3,000 to 30,000+ ETB.',
        },
        pillar3: {
          icon: 'connection',
          title: 'Mutual Request',
          amharic: 'የጋራ ግንኙነት',
          desc: 'Connect directly with verified roommates matching your habits.',
        },
      };

    case 'my_listings':
      return {
        badgeText: memBadgeText,
        badgeColor: memBadgeColor,
        badgeBg: memBadgeBg,
        badgeBorder: memBadgeBorder,
        greeting: `Resident Dashboard · ${cleanName}`,
        headline: 'My Listings & Membership',
        subheadline: 'የእኔ ክፍት ማስታወቂያዎች እና የአባልነት ሁኔታ',
        pillar1: {
          icon: 'list',
          title: 'Active Broadcasts',
          amharic: 'ክፍት ማስታወቂያዎች',
          desc: 'Track live channel posts and see active connect requests.',
        },
        pillar2: {
          icon: 'connection',
          title: 'One-Tap Close',
          amharic: 'በማንኛውም ጊዜ ዝጋ',
          desc: 'Mark listings as closed or matched instantly from chat.',
        },
        pillar3: {
          icon: 'shield',
          title: 'Verified Resident',
          amharic: 'የተረጋገጠ አባል',
          desc: 'Keep your 30-day pass and Fayda verified status active.',
        },
      };

    case 'start':
    default:
      return {
        badgeText: memBadgeText,
        badgeColor: memBadgeColor,
        badgeBg: memBadgeBg,
        badgeBorder: memBadgeBorder,
        greeting: `Welcome, ${cleanName}! · እንኳን ደህና መጡ!`,
        headline: 'Find Your Ideal Roommate',
        subheadline: 'የተረጋገጡ የቤት አጋሮች እና ክፍሎች በአዲስ አበባ',
        pillar1: {
          icon: 'search',
          title: 'Smart Matchmaker',
          amharic: 'የቤት አጋር ፈልግ',
          desc: 'Filter verified roommates by sub-city, budget & lifestyle.',
        },
        pillar2: {
          icon: 'shield',
          title: 'Fayda ID Verified',
          amharic: 'የፋይዳ ማረጋገጫ',
          desc: 'Instant cryptographic QR verification in volatile RAM.',
        },
        pillar3: {
          icon: 'connection',
          title: 'Direct Connection',
          amharic: 'ቀጥተኛ ግንኙነት',
          desc: 'Unrestricted Telegram & phone reveals upon mutual accept.',
        },
      };
  }
}

/**
 * Builds the React element representing the card layout.
 */
export function buildUniversalCardElement(type: CardScreenType, params: DynamicCardParams) {
  const config = getCardConfig(type, params);

  return React.createElement(
    'div',
    {
      style: {
        width: '1200px',
        height: '630px',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: '#070f18',
        backgroundImage: 'linear-gradient(135deg, #070f18 0%, #0c1829 50%, #14243b 100%)',
        padding: '40px',
        fontFamily: '"Geist", "Noto Sans Ethiopic", sans-serif',
        position: 'relative',
        boxSizing: 'border-box',
      },
    },
    // Glass inner frame
    React.createElement(
      'div',
      {
        style: {
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          borderRadius: '24px',
          border: '1.5px solid rgba(56, 189, 248, 0.35)',
          backgroundColor: 'rgba(255, 255, 255, 0.02)',
          padding: '36px 40px',
          boxSizing: 'border-box',
        },
      },
      // Top row: Brand + Status Pill
      React.createElement(
        'div',
        {
          style: {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            width: '100%',
          },
        },
        // Brand left
        React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '16px' } },
          // Shield emblem
          React.createElement(
            'div',
            {
              style: {
                width: '46px',
                height: '46px',
                borderRadius: '12px',
                backgroundColor: '#003258',
                border: '1.5px solid #9ecaff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              },
            },
            React.createElement(
              'svg',
              { width: '26', height: '26', viewBox: '0 0 24 24', fill: 'none' },
              React.createElement('path', {
                d: 'M12 2 L20 6 V13 C20 18 12 22 12 22 C12 22 4 18 4 13 V6 Z',
                stroke: '#9ecaff',
                strokeWidth: '2',
                strokeLinecap: 'round',
                strokeLinejoin: 'round',
              }),
              React.createElement('path', {
                d: 'M9 12 L11 14 L15 10',
                stroke: '#4ae176',
                strokeWidth: '2',
                strokeLinecap: 'round',
                strokeLinejoin: 'round',
              })
            )
          ),
          React.createElement(
            'div',
            { style: { display: 'flex', flexDirection: 'column' } },
            React.createElement(
              'span',
              { style: { fontSize: '22px', fontWeight: 'bold', color: '#ffffff', letterSpacing: '0.5px' } },
              'SPACEMATCH ADDIS'
            ),
            React.createElement(
              'span',
              { style: { fontSize: '13px', fontWeight: 'bold', color: '#9ecaff', letterSpacing: '1px' } },
              'VERIFIED RESIDENCE NETWORK · አዲስ አበባ'
            )
          )
        ),
        // Status Pill right
        React.createElement(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              padding: '8px 20px',
              borderRadius: '20px',
              backgroundColor: config.badgeBg,
              border: `1.2px solid ${config.badgeBorder}`,
            },
          },
          React.createElement('div', {
            style: { width: '8px', height: '8px', borderRadius: '4px', backgroundColor: config.badgeColor },
          }),
          React.createElement(
            'span',
            { style: { fontSize: '14px', fontWeight: 'bold', color: config.badgeColor, letterSpacing: '0.8px' } },
            config.badgeText
          )
        )
      ),

      // Hero Center
      React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', marginTop: '12px', marginBottom: '12px' } },
        config.greeting ? React.createElement(
          'span',
          { style: { fontSize: '19px', color: '#94a3b8', marginBottom: '6px' } },
          config.greeting
        ) : null,
        React.createElement(
          'span',
          {
            style: {
              fontSize: '46px',
              fontWeight: 'bold',
              color: '#9ecaff',
              letterSpacing: '-0.5px',
              lineHeight: 1.1,
            },
          },
          config.headline
        ),
        React.createElement(
          'span',
          { style: { fontSize: '22px', fontWeight: 'bold', color: '#dbe3f1', marginTop: '6px' } },
          config.subheadline
        )
      ),

      // 3 Feature Cards
      React.createElement(
        'div',
        { style: { display: 'flex', justifyContent: 'space-between', gap: '20px', width: '100%' } },
        // Feature 1
        React.createElement(
          'div',
          {
            style: {
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              backgroundColor: 'rgba(20, 28, 38, 0.9)',
              borderRadius: '16px',
              border: '1.2px solid #2d3540',
              padding: '18px 20px',
            },
          },
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' } },
            renderPillarIcon(config.pillar1.icon),
            React.createElement(
              'div',
              { style: { display: 'flex', flexDirection: 'column' } },
              React.createElement('span', { style: { fontSize: '15px', fontWeight: 'bold', color: '#ffffff' } }, config.pillar1.title),
              React.createElement('span', { style: { fontSize: '12px', color: '#9ecaff' } }, config.pillar1.amharic)
            )
          ),
          React.createElement('span', { style: { fontSize: '13px', color: '#94a3b8', lineHeight: 1.3 } }, config.pillar1.desc)
        ),

        // Feature 2
        React.createElement(
          'div',
          {
            style: {
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              backgroundColor: 'rgba(20, 28, 38, 0.9)',
              borderRadius: '16px',
              border: '1.2px solid #2d3540',
              padding: '18px 20px',
            },
          },
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' } },
            renderPillarIcon(config.pillar2.icon),
            React.createElement(
              'div',
              { style: { display: 'flex', flexDirection: 'column' } },
              React.createElement('span', { style: { fontSize: '15px', fontWeight: 'bold', color: '#ffffff' } }, config.pillar2.title),
              React.createElement('span', { style: { fontSize: '12px', color: '#4ae176' } }, config.pillar2.amharic)
            )
          ),
          React.createElement('span', { style: { fontSize: '13px', color: '#94a3b8', lineHeight: 1.3 } }, config.pillar2.desc)
        ),

        // Feature 3
        React.createElement(
          'div',
          {
            style: {
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              backgroundColor: 'rgba(20, 28, 38, 0.9)',
              borderRadius: '16px',
              border: '1.2px solid #2d3540',
              padding: '18px 20px',
            },
          },
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' } },
            renderPillarIcon(config.pillar3.icon),
            React.createElement(
              'div',
              { style: { display: 'flex', flexDirection: 'column' } },
              React.createElement('span', { style: { fontSize: '15px', fontWeight: 'bold', color: '#ffffff' } }, config.pillar3.title),
              React.createElement('span', { style: { fontSize: '12px', color: '#a4caf6' } }, config.pillar3.amharic)
            )
          ),
          React.createElement('span', { style: { fontSize: '13px', color: '#94a3b8', lineHeight: 1.3 } }, config.pillar3.desc)
        )
      ),

      // Footer
      React.createElement(
        'div',
        { style: { display: 'flex', justifyContent: 'center', width: '100%', marginTop: '6px' } },
        React.createElement(
          'span',
          { style: { fontSize: '12px', color: '#64748b', letterSpacing: '0.5px' } },
          'SpaceMatch Addis Ababa · Select an option below to get started'
        )
      )
    )
  );
}

/**
 * Universal PNG generator supporting all bot screen cards.
 */
export async function generateCardPng(type: CardScreenType, params: DynamicCardParams = {}): Promise<Buffer> {
  const fonts = loadFonts();
  const element = buildUniversalCardElement(type, params);

  const response = new ImageResponse(element, {
    width: 1200,
    height: 630,
    fonts: [
      {
        name: 'Geist',
        data: fonts.geist,
        style: 'normal',
        weight: 400,
      },
      {
        name: 'Noto Sans Ethiopic',
        data: fonts.ethiopicBold,
        style: 'normal',
        weight: 700,
      },
      {
        name: 'Noto Sans Ethiopic',
        data: fonts.ethiopicRegular,
        style: 'normal',
        weight: 400,
      },
    ],
  });

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// Backwards-compatible aliases
export async function generateStartCardPng(params: DynamicCardParams = {}): Promise<Buffer> {
  return generateCardPng('start', params);
}

export async function generatePostBranchCardPng(params: DynamicCardParams = {}): Promise<Buffer> {
  return generateCardPng('post_branch', params);
}

export async function generateMembershipCardPng(params: DynamicCardParams = {}): Promise<Buffer> {
  return generateCardPng('membership', params);
}

export async function generateFaydaCardPng(params: DynamicCardParams = {}): Promise<Buffer> {
  return generateCardPng('fayda', params);
}

export async function generateSearchCardPng(params: DynamicCardParams = {}): Promise<Buffer> {
  return generateCardPng('search', params);
}

export async function generateMyListingsCardPng(params: DynamicCardParams = {}): Promise<Buffer> {
  return generateCardPng('my_listings', params);
}
