import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Sliding window in-memory rate limiter store.
 * Bounded to prevent memory exhaustion under high unique IP volume.
 */
interface RateLimitRecord {
  timestamps: number[];
  lastSeen: number;
}

const MAX_TRACKED_IPS = 10000;
const rateLimitMap = new Map<string, RateLimitRecord>();

function getClientIp(request: NextRequest): string {
  const xForwardedFor = request.headers.get('x-forwarded-for');
  if (xForwardedFor) {
    const firstIp = xForwardedFor.split(',')[0]?.trim();
    if (firstIp) return firstIp;
  }
  const xRealIp = request.headers.get('x-real-ip');
  if (xRealIp) return xRealIp.trim();
  return '127.0.0.1';
}

function pruneRateLimitMap(now: number): void {
  if (rateLimitMap.size <= MAX_TRACKED_IPS) return;
  // Prune entries older than 2 minutes or oldest entries
  for (const [ip, record] of rateLimitMap.entries()) {
    if (now - record.lastSeen > 120000 || rateLimitMap.size > MAX_TRACKED_IPS) {
      rateLimitMap.delete(ip);
    }
  }
}

export function middleware(request: NextRequest) {
  const pathname = request.nextUrl ? request.nextUrl.pathname : new URL(request.url).pathname;
  const now = Date.now();

  // 1. Payload Size Check via Content-Length header
  const isWebhook = pathname.startsWith('/api/telegram') || pathname.startsWith('/api/webhooks');
  const maxBytes = isWebhook ? 12 * 1024 * 1024 : 1 * 1024 * 1024; // 12MB for webhook/photos, 1MB for general APIs
  const contentLengthHeader = request.headers.get('content-length');

  if (contentLengthHeader) {
    const contentLength = parseInt(contentLengthHeader, 10);
    if (!isNaN(contentLength) && contentLength > maxBytes) {
      return NextResponse.json(
        { error: 'Payload Too Large', maxBytes },
        {
          status: 413,
          headers: {
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'X-XSS-Protection': '1; mode=block',
            'Referrer-Policy': 'strict-origin-when-cross-origin',
          },
        }
      );
    }
  }

  // 2. Sliding Window Rate Limiting
  const windowMs = 60 * 1000; // 60-second sliding window
  const limit = isWebhook ? 30 : 100; // 30 req/min for webhook, 100 req/min for general APIs
  const isRateLimitDisabled = process.env.DISABLE_RATE_LIMIT === 'true';

  let remaining = limit;
  let resetSeconds = 60;

  if (!isRateLimitDisabled) {
    const ip = getClientIp(request);
    pruneRateLimitMap(now);

    const record = rateLimitMap.get(ip) || { timestamps: [], lastSeen: now };
    record.lastSeen = now;

    // Filter out timestamps outside the sliding window
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
            'Retry-After': String(retryAfter),
            'X-RateLimit-Limit': String(limit),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(retryAfter),
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'X-XSS-Protection': '1; mode=block',
            'Referrer-Policy': 'strict-origin-when-cross-origin',
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

  // 3. Continue Request Pipeline with Standard Security & Rate Limit Headers
  const response = NextResponse.next();
  response.headers.set('X-RateLimit-Limit', String(limit));
  response.headers.set('X-RateLimit-Remaining', String(remaining));
  response.headers.set('X-RateLimit-Reset', String(resetSeconds));
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-XSS-Protection', '1; mode=block');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  return response;
}

export const config = {
  matcher: ['/api/:path*'],
};
