/**
 * lib/dynamic-card-generator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Dynamic Visual Card Generator for Telegram Welcome & Status Screens.
 * Uses Next.js native ImageResponse (Satori + resvg-wasm) with bundled
 * Open-Source TTF fonts (Geist + Noto Sans Ethiopic) to guarantee 100% font
 * fidelity on all environments (Vercel serverless Linux, Docker, Windows, macOS)
 * without depending on host OS system fonts.
 */

import fs from 'fs';
import path from 'path';
import React from 'react';
import { ImageResponse } from 'next/og';

export interface StartCardParams {
  userName?: string;
  isMember?: boolean;
  daysRemaining?: number;
  lang?: 'en' | 'am' | 'bilingual';
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

/**
 * Builds the React element representing the Stitch dark luxury welcome card.
 */
export function buildStartCardElement(params: StartCardParams) {
  const rawName = params.userName?.trim() || 'Resident';
  const cleanName = rawName.slice(0, 24);
  const isMember = Boolean(params.isMember);
  const days = Math.max(0, params.daysRemaining || 0);

  const statusColor = isMember ? '#10b981' : '#94a3b8';
  const statusBg = isMember ? 'rgba(16, 185, 129, 0.15)' : 'rgba(148, 163, 184, 0.15)';
  const statusBorder = isMember ? '#059669' : '#475569';
  const statusText = isMember
    ? `ACTIVE PASS · ${days} DAYS`
    : '30-DAY PASS · 300 ETB';

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
      // Top row: Brand Logo + Status Pill
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
              backgroundColor: statusBg,
              border: `1.2px solid ${statusBorder}`,
            },
          },
          React.createElement('div', {
            style: { width: '8px', height: '8px', borderRadius: '4px', backgroundColor: statusColor },
          }),
          React.createElement(
            'span',
            { style: { fontSize: '14px', fontWeight: 'bold', color: statusColor, letterSpacing: '0.8px' } },
            statusText
          )
        )
      ),

      // Hero Center
      React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', marginTop: '12px', marginBottom: '12px' } },
        React.createElement(
          'span',
          { style: { fontSize: '19px', color: '#94a3b8', marginBottom: '6px' } },
          `Welcome, ${cleanName}! · እንኳን ደህና መጡ!`
        ),
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
          'Find Your Ideal Roommate'
        ),
        React.createElement(
          'span',
          { style: { fontSize: '22px', fontWeight: 'bold', color: '#dbe3f1', marginTop: '6px' } },
          'የተረጋገጡ የቤት አጋሮች እና ክፍሎች በአዲስ አበባ'
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
            React.createElement(
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
            ),
            React.createElement(
              'div',
              { style: { display: 'flex', flexDirection: 'column' } },
              React.createElement('span', { style: { fontSize: '15px', fontWeight: 'bold', color: '#ffffff' } }, 'Smart Matchmaker'),
              React.createElement('span', { style: { fontSize: '12px', color: '#9ecaff' } }, 'የቤት አጋር ፈልግ')
            )
          ),
          React.createElement('span', { style: { fontSize: '13px', color: '#94a3b8', lineHeight: 1.3 } }, 'Filter verified roommates by sub-city, budget & lifestyle.')
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
            React.createElement(
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
            ),
            React.createElement(
              'div',
              { style: { display: 'flex', flexDirection: 'column' } },
              React.createElement('span', { style: { fontSize: '15px', fontWeight: 'bold', color: '#ffffff' } }, 'Fayda ID Verified'),
              React.createElement('span', { style: { fontSize: '12px', color: '#4ae176' } }, 'የፋይዳ ማረጋገጫ')
            )
          ),
          React.createElement('span', { style: { fontSize: '13px', color: '#94a3b8', lineHeight: 1.3 } }, 'Instant cryptographic QR verification in volatile RAM.')
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
            React.createElement(
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
            ),
            React.createElement(
              'div',
              { style: { display: 'flex', flexDirection: 'column' } },
              React.createElement('span', { style: { fontSize: '15px', fontWeight: 'bold', color: '#ffffff' } }, 'Direct Connection'),
              React.createElement('span', { style: { fontSize: '12px', color: '#a4caf6' } }, 'ቀጥተኛ ግንኙነት')
            )
          ),
          React.createElement('span', { style: { fontSize: '13px', color: '#94a3b8', lineHeight: 1.3 } }, 'Unrestricted Telegram & phone reveals upon mutual accept.')
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
 * Generates an optimized PNG buffer of the start card with full font fidelity.
 */
export async function generateStartCardPng(params: StartCardParams): Promise<Buffer> {
  const fonts = loadFonts();
  const element = buildStartCardElement(params);

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
