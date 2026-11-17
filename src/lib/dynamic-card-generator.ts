/**
 * lib/dynamic-card-generator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Dynamic Visual Card Generator for Telegram Welcome & Status Screens.
 * Generates modern dark luxury SVG banners rendered into high-DPI PNGs
 * via Sharp for instantaneous in-memory transmission.
 */

import sharp from 'sharp';

export interface StartCardParams {
  userName?: string;
  isMember?: boolean;
  daysRemaining?: number;
  lang?: 'en' | 'am' | 'bilingual';
}

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Builds high-fidelity 1200x630 vector SVG adhering to the Stitch dark UI palette.
 */
export function buildStartCardSvg(params: StartCardParams): string {
  const rawName = params.userName?.trim() || 'Resident';
  const cleanName = escapeXml(rawName.slice(0, 24));
  const isMember = Boolean(params.isMember);
  const days = Math.max(0, params.daysRemaining || 0);

  const statusColor = isMember ? '#10b981' : '#94a3b8';
  const statusBg = isMember ? 'rgba(16, 185, 129, 0.15)' : 'rgba(148, 163, 184, 0.15)';
  const statusBorder = isMember ? '#059669' : '#475569';
  const statusPillText = isMember
    ? `ACTIVE PASS · ${days} DAYS`
    : '30-DAY PASS · 300 ETB';

  return `
<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <!-- Background Gradient -->
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#070f18"/>
      <stop offset="50%" stop-color="#0c1829"/>
      <stop offset="100%" stop-color="#14243b"/>
    </linearGradient>

    <!-- Glow Orbs -->
    <radialGradient id="glowCyan" cx="15%" cy="15%" r="55%">
      <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="#38bdf8" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowIndigo" cx="85%" cy="85%" r="55%">
      <stop offset="0%" stop-color="#6366f1" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="#6366f1" stop-opacity="0"/>
    </radialGradient>

    <!-- Glass card linear gradient -->
    <linearGradient id="glassGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.06"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.015"/>
    </linearGradient>
    <linearGradient id="glassBorder" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.45"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.08"/>
    </linearGradient>
    <linearGradient id="accentGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#9ecaff"/>
      <stop offset="100%" stop-color="#60a5fa"/>
    </linearGradient>
  </defs>

  <!-- Background Base -->
  <rect width="1200" height="630" fill="url(#bgGrad)"/>
  <rect width="1200" height="630" fill="url(#glowCyan)"/>
  <rect width="1200" height="630" fill="url(#glowIndigo)"/>

  <!-- Subtle Blueprint Tech Grid -->
  <g stroke="#ffffff" stroke-opacity="0.025" stroke-width="1">
    <line x1="0" y1="105" x2="1200" y2="105"/>
    <line x1="0" y1="210" x2="1200" y2="210"/>
    <line x1="0" y1="315" x2="1200" y2="315"/>
    <line x1="0" y1="420" x2="1200" y2="420"/>
    <line x1="0" y1="525" x2="1200" y2="525"/>
    <line x1="200" y1="0" x2="200" y2="630"/>
    <line x1="400" y1="0" x2="400" y2="630"/>
    <line x1="600" y1="0" x2="600" y2="630"/>
    <line x1="800" y1="0" x2="800" y2="630"/>
    <line x1="1000" y1="0" x2="1000" y2="630"/>
  </g>

  <!-- Outer Glassmorphic Container -->
  <rect x="50" y="50" width="1100" height="530" rx="28" fill="url(#glassGrad)" stroke="url(#glassBorder)" stroke-width="1.5"/>

  <!-- Top Brand Logo -->
  <g transform="translate(90, 85)">
    <rect width="48" height="48" rx="12" fill="#003258" stroke="#9ecaff" stroke-width="1.5"/>
    <path d="M24 10 L36 16 V26 C36 33 24 38 24 38 C24 38 12 33 12 26 V16 Z" fill="none" stroke="#9ecaff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M20 24 L23 27 L29 20" fill="none" stroke="#4ae176" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
  </g>

  <text x="155" y="110" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="22" font-weight="800" fill="#ffffff" letter-spacing="0.5">SPACEMATCH ADDIS</text>
  <text x="155" y="128" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="14" font-weight="600" fill="#9ecaff" letter-spacing="1.5">VERIFIED RESIDENCE NETWORK · አዲስ አበባ</text>

  <!-- Top Right Membership Pill -->
  <g transform="translate(810, 88)">
    <rect width="250" height="42" rx="21" fill="${statusBg}" stroke="${statusBorder}" stroke-width="1.2"/>
    <circle cx="26" cy="21" r="5" fill="${statusColor}"/>
    <text x="42" y="27" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="14" font-weight="700" fill="${statusColor}" letter-spacing="0.8">${statusPillText}</text>
  </g>

  <!-- Hero Content -->
  <text x="90" y="210" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="20" font-weight="600" fill="#94a3b8">Welcome, <tspan fill="#ffffff" font-weight="700">${cleanName}</tspan>! · እንኳን ደህና መጡ!</text>
  <text x="90" y="275" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="52" font-weight="900" fill="url(#accentGrad)" letter-spacing="-0.5">Find Your Ideal Roommate</text>
  <text x="90" y="325" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="24" font-weight="700" fill="#dbe3f1">የተረጋገጡ የቤት አጋሮች እና ክፍሎች በአዲስ አበባ</text>

  <!-- 3 Glassmorphic Feature Cards -->
  <!-- Feature 1: Search -->
  <g transform="translate(90, 375)">
    <rect width="310" height="155" rx="18" fill="#141c26" fill-opacity="0.85" stroke="#2d3540" stroke-width="1.2"/>
    <circle cx="40" cy="40" r="18" fill="#003258"/>
    <g transform="translate(31, 31)" stroke="#9ecaff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="7.5" cy="7.5" r="5"/>
      <line x1="11.5" y1="11.5" x2="16.5" y2="16.5"/>
    </g>
    <text x="70" y="38" font-family="sans-serif" font-size="16" font-weight="700" fill="#ffffff">Smart Matchmaker</text>
    <text x="70" y="55" font-family="sans-serif" font-size="12" font-weight="600" fill="#9ecaff">የቤት አጋር ፈልግ</text>
    <text x="24" y="95" font-family="sans-serif" font-size="13" fill="#94a3b8">Filter verified roommates by</text>
    <text x="24" y="115" font-family="sans-serif" font-size="13" fill="#94a3b8">area, budget and lifestyle.</text>
  </g>

  <!-- Feature 2: Fayda ID -->
  <g transform="translate(445, 375)">
    <rect width="310" height="155" rx="18" fill="#141c26" fill-opacity="0.85" stroke="#2d3540" stroke-width="1.2"/>
    <circle cx="40" cy="40" r="18" fill="#003915"/>
    <g transform="translate(30, 30)" stroke="#4ae176" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4.5 10 L8.5 14 L16 5.5"/>
    </g>
    <text x="70" y="38" font-family="sans-serif" font-size="16" font-weight="700" fill="#ffffff">Fayda ID Verified</text>
    <text x="70" y="55" font-family="sans-serif" font-size="12" font-weight="600" fill="#4ae176">የፋይዳ ማረጋገጫ</text>
    <text x="24" y="95" font-family="sans-serif" font-size="13" fill="#94a3b8">Instant cryptographic QR</text>
    <text x="24" y="115" font-family="sans-serif" font-size="13" fill="#94a3b8">verification in RAM.</text>
  </g>

  <!-- Feature 3: Post Profile -->
  <g transform="translate(800, 375)">
    <rect width="310" height="155" rx="18" fill="#141c26" fill-opacity="0.85" stroke="#2d3540" stroke-width="1.2"/>
    <circle cx="40" cy="40" r="18" fill="#21496f"/>
    <g transform="translate(30, 30)" stroke="#a4caf6" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 7 L16 7 M12 3 L16 7 L12 11"/>
      <path d="M16 13 L4 13 M8 9 L4 13 L8 17"/>
    </g>
    <text x="70" y="38" font-family="sans-serif" font-size="16" font-weight="700" fill="#ffffff">Direct Connection</text>
    <text x="70" y="55" font-family="sans-serif" font-size="12" font-weight="600" fill="#a4caf6">ቀጥተኛ ግንኙነት</text>
    <text x="24" y="95" font-family="sans-serif" font-size="13" fill="#94a3b8">Unrestricted Telegram &amp;</text>
    <text x="24" y="115" font-family="sans-serif" font-size="13" fill="#94a3b8">phone reveals upon match.</text>
  </g>

  <!-- Footer Notice -->
  <text x="600" y="565" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="13" font-weight="500" fill="#64748b" letter-spacing="0.5">SpaceMatch Addis Ababa · Select an option below to get started</text>
</svg>
`.trim();
}

/**
 * Converts dynamic vector SVG into an optimized PNG Buffer in memory.
 */
export async function generateStartCardPng(params: StartCardParams): Promise<Buffer> {
  const svg = buildStartCardSvg(params);
  return await sharp(Buffer.from(svg))
    .png({ quality: 90, compressionLevel: 8 })
    .toBuffer();
}
