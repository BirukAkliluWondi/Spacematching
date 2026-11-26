import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

interface RateLimitRecord {
  timestamps: number[];
  lastSeen: number;
}

const MAX_TRACKED_IPS = 10000;
const rateLimitMap = new Map<string, RateLimitRecord>();

function getClientIp(request: NextRequest): string {
  const realIp = request.headers.get('x-real-ip');
  if (realIp) return realIp.trim();
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    // Prefer right-most non-private proxy hop added by edge platform when available
    const hops = forwardedFor.split(',').map((h) => h.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return '127.0.0.1';
}

function pruneRateLimitMap(now: number): void {
  if (rateLimitMap.size <= MAX_TRACKED_IPS) return;
  for (const [ip, record] of rateLimitMap.entries()) {
    if (now - record.lastSeen > 120000 || rateLimitMap.size > MAX_TRACKED_IPS) {
      rateLimitMap.delete(ip);
    }
  }
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl ? request.nextUrl.pathname : new URL(request.url).pathname;
  const now = Date.now();

  if (request.method === 'OPTIONS') {
    return new NextResponse(null, { status: 204, headers: SECURITY_HEADERS });
  }

  // 1. Payload Size Check
  const isWebhook = pathname.startsWith('/api/telegram') || pathname.startsWith('/api/webhooks');
  const maxBytes = isWebhook ? 12 * 1024 * 1024 : 2 * 1024 * 1024;
  const contentLengthHeader = request.headers.get('content-length');

  if (contentLengthHeader) {
    const contentLength = parseInt(contentLengthHeader, 10);
    if (!isNaN(contentLength) && contentLength > maxBytes) {
      return NextResponse.json(
        { error: 'Payload Too Large', maxBytes },
        { status: 413, headers: SECURITY_HEADERS }
      );
    }
  }

  // 2. Per-instance sliding window limiter (Telegram webhooks exempted because Bot API shares IPs)
  const windowMs = 60 * 1000;
  const limit = 100;
  const isRateLimitDisabled = process.env.DISABLE_RATE_LIMIT === 'true' || isWebhook;

  let remaining = limit;
  let resetSeconds = 60;

  if (!isRateLimitDisabled) {
    const ip = getClientIp(request);
    pruneRateLimitMap(now);

    const record = rateLimitMap.get(ip) || { timestamps: [], lastSeen: now };
    record.lastSeen = now;
    const windowStart = now - windowMs;
    record.timestamps = record.timestamps.filter((ts) => ts > windowStart);

    if (record.timestamps.length >= limit) {
      const oldest = record.timestamps[0] || now;
      const retryAfter = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
      rateLimitMap.set(ip, record);
      return NextResponse.json(
        { error: 'Too Many Requests', retryAfter },
        {
          status: 429,
          headers: {
            ...SECURITY_HEADERS,
            'Retry-After': String(retryAfter),
            'X-RateLimit-Limit': String(limit),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(retryAfter),
          },
        }
      );
    }

    record.timestamps.push(now);
    rateLimitMap.set(ip, record);
    remaining = Math.max(0, limit - record.timestamps.length);
    const oldest = record.timestamps[0] || now;
    resetSeconds = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
  }

  const response = NextResponse.next();
  response.headers.set('X-RateLimit-Limit', String(limit));
  response.headers.set('X-RateLimit-Remaining', String(remaining));
  response.headers.set('X-RateLimit-Reset', String(resetSeconds));
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(k, v);
  }
  return response;
}

export const config = {
  matcher: ['/api/:path*'],
};
