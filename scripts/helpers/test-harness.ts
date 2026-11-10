/**
 * scripts/helpers/test-harness.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Comprehensive In-Process Test Harness for Spacematching Bot & API Platform.
 *
 * Provides:
 *  1. Telegram API Interception & Message Tracking (zero network calls)
 *  2. Telegram Mini App initData cryptographic generator
 *  3. In-memory file storage for synthetic photo uploads
 *  4. Direct invocation of all Next.js App Router API handlers
 *  5. Assertions, metrics collection, and latency measurement
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getSyntheticTestKeyPair, generateAuthenticFaydaQrBuffer } from './synthetic-fayda';

// Natively load .env.local without external dependencies
try {
  const envPath = path.resolve('.env.local');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const line of envContent.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const key = trimmed.substring(0, eqIdx).trim();
        let val = trimmed.substring(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
} catch {}

// Route calls through setupTelegramFetchMock interceptor (zero network)
delete process.env.MOCK_TELEGRAM_API;
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '123456789:TEST_BOT_TOKEN_MOCK_SECRET_XYZ';
process.env.NEXT_PUBLIC_BOT_USERNAME = process.env.NEXT_PUBLIC_BOT_USERNAME || 'Spacematchaddis_bot';
process.env.TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID || '-1001234567890';
process.env.FAYDA_PUBLIC_KEY_PEM = getSyntheticTestKeyPair().publicKeyPem;

export interface SentTelegramCall {
  method: string;
  url: string;
  payload?: any;
  timestamp: number;
}

// In-memory photo file store for simulated Telegram CDN
const _simulatedTelegramCdn = new Map<string, Buffer>();
const _recordedTelegramCalls: SentTelegramCall[] = [];

// Intercept globalThis.fetch for telegram API calls
const originalFetch = globalThis.fetch;

export function setupTelegramFetchMock() {
  _recordedTelegramCalls.length = 0;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    // 1. Telegram API methods
    if (urlStr.includes('api.telegram.org/bot')) {
      const methodMatch = urlStr.match(/\/bot[^/]+\/([a-zA-Z0-9_]+)/);
      const method = methodMatch ? methodMatch[1] : 'unknown';

      let parsedBody: any = null;
      if (init?.body) {
        try {
          parsedBody = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
        } catch {}
      }

      _recordedTelegramCalls.push({
        method,
        url: urlStr,
        payload: parsedBody,
        timestamp: Date.now(),
      });

      if (method === 'getFile') {
        const u = new URL(urlStr);
        const fileId = u.searchParams.get('file_id') || 'default_file_id';
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              file_id: fileId,
              file_unique_id: `unique_${fileId}`,
              file_size: 1024,
              file_path: `photos/${fileId}.png`,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Default success response for sendMessage, editMessageText, deleteMessage, etc.
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            message_id: 10000 + Math.floor(Math.random() * 90000),
            date: Math.floor(Date.now() / 1000),
            chat: { id: parsedBody?.chat_id || 123456 },
            text: parsedBody?.text || '',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 2. Telegram File CDN download
    if (urlStr.includes('api.telegram.org/file/bot')) {
      const match = urlStr.match(/photos\/([^/]+)\.png/);
      const fileId = match ? match[1] : 'default';
      const storedBuffer = _simulatedTelegramCdn.get(fileId) || (await generateAuthenticFaydaQrBuffer()).pngBuffer;

      return new Response(new Uint8Array(storedBuffer), {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'Content-Length': storedBuffer.length.toString(),
        },
      });
    }

    // 3. WebAssembly local file loading
    if (urlStr.includes('.wasm') || urlStr.endsWith('.wasm')) {
      try {
        let filePath = '';
        if (urlStr.startsWith('file://')) {
          try {
            filePath = new URL(urlStr).pathname;
            if (process.platform === 'win32' && filePath.startsWith('/')) {
              filePath = filePath.slice(1);
            }
          } catch {}
        } else {
          filePath = urlStr;
        }
        if (filePath && fs.existsSync(filePath)) {
          const wasmBuffer = fs.readFileSync(filePath);
          return new Response(new Uint8Array(wasmBuffer), {
            status: 200,
            headers: { 'Content-Type': 'application/wasm' },
          });
        }
        // Fallback to known paths in node_modules
        const wasmName = path.basename(urlStr.split('?')[0]);
        const candidatePaths = [
          path.resolve('node_modules/zxing-wasm/dist/writer', wasmName),
          path.resolve('node_modules/zxing-wasm/dist/reader', wasmName),
          path.resolve('node_modules/fayda-decoder/node_modules/zxing-wasm/dist/writer', wasmName),
          path.resolve('node_modules/fayda-decoder/node_modules/zxing-wasm/dist/reader', wasmName),
        ];
        for (const cp of candidatePaths) {
          if (fs.existsSync(cp)) {
            const wasmBuffer = fs.readFileSync(cp);
            return new Response(new Uint8Array(wasmBuffer), {
              status: 200,
              headers: { 'Content-Type': 'application/wasm' },
            });
          }
        }
      } catch {}
      return await originalFetch(input, init);
    }

    // Pass through to original fetch for local / other requests
    try {
      return await originalFetch(input, init);
    } catch (err) {
      // If network fails (e.g. offline Supabase or external banking API), return a safe fallback response
      return new Response(
        JSON.stringify({ success: false, error: 'Offline mock network boundary' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
  };
}

export function teardownTelegramFetchMock() {
  globalThis.fetch = originalFetch;
}

/**
 * Registers an image buffer to be served by the mock Telegram CDN for a specific file_id.
 */
export function registerMockTelegramPhoto(fileId: string, buffer: Buffer) {
  _simulatedTelegramCdn.set(fileId, buffer);
}

/**
 * Retrieves all captured Telegram calls since last reset.
 */
export function getCapturedTelegramCalls(): SentTelegramCall[] {
  return [..._recordedTelegramCalls];
}

/**
 * Clears captured Telegram calls history.
 */
export function clearCapturedTelegramCalls() {
  _recordedTelegramCalls.length = 0;
}

// ─── Update Builders ──────────────────────────────────────────────────────────

export function createTelegramMessageUpdate(
  chatId: number,
  text: string,
  options: { messageId?: number; username?: string; firstName?: string } = {}
) {
  const messageId = options.messageId || 5000 + Math.floor(Math.random() * 50000);
  return {
    update_id: 1000000 + Math.floor(Math.random() * 900000),
    message: {
      message_id: messageId,
      from: {
        id: chatId,
        is_bot: false,
        first_name: options.firstName || `User_${chatId}`,
        username: options.username || `user_${chatId}`,
      },
      chat: {
        id: chatId,
        first_name: options.firstName || `User_${chatId}`,
        type: 'private',
      },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  };
}

export function createTelegramCallbackUpdate(
  chatId: number,
  callbackData: string,
  options: { messageId?: number; username?: string; firstName?: string } = {}
) {
  const messageId = options.messageId || 6000 + Math.floor(Math.random() * 50000);
  return {
    update_id: 2000000 + Math.floor(Math.random() * 900000),
    callback_query: {
      id: `cb_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
      from: {
        id: chatId,
        is_bot: false,
        first_name: options.firstName || `User_${chatId}`,
        username: options.username || `user_${chatId}`,
      },
      message: {
        message_id: messageId,
        chat: { id: chatId, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: 'Interactive Prompt',
      },
      data: callbackData,
    },
  };
}

export function createTelegramPhotoUpdate(
  chatId: number,
  fileId: string,
  options: { messageId?: number; username?: string; firstName?: string } = {}
) {
  const messageId = options.messageId || 7000 + Math.floor(Math.random() * 50000);
  return {
    update_id: 3000000 + Math.floor(Math.random() * 900000),
    message: {
      message_id: messageId,
      from: {
        id: chatId,
        is_bot: false,
        first_name: options.firstName || `User_${chatId}`,
        username: options.username || `user_${chatId}`,
      },
      chat: {
        id: chatId,
        first_name: options.firstName || `User_${chatId}`,
        type: 'private',
      },
      date: Math.floor(Date.now() / 1000),
      photo: [
        { file_id: `${fileId}_small`, width: 160, height: 160, file_size: 2048 },
        { file_id: `${fileId}_medium`, width: 320, height: 320, file_size: 4096 },
        { file_id: fileId, width: 800, height: 800, file_size: 16384 },
      ],
    },
  };
}

export function createTelegramDocumentUpdate(
  chatId: number,
  fileId: string,
  fileName: string = 'fayda_card.png',
  mimeType: string = 'image/png',
  options: { messageId?: number; username?: string; firstName?: string } = {}
) {
  const messageId = options.messageId || 8000 + Math.floor(Math.random() * 50000);
  return {
    update_id: 4000000 + Math.floor(Math.random() * 900000),
    message: {
      message_id: messageId,
      from: {
        id: chatId,
        is_bot: false,
        first_name: options.firstName || `User_${chatId}`,
        username: options.username || `user_${chatId}`,
      },
      chat: {
        id: chatId,
        first_name: options.firstName || `User_${chatId}`,
        type: 'private',
      },
      date: Math.floor(Date.now() / 1000),
      document: {
        file_id: fileId,
        file_name: fileName,
        mime_type: mimeType,
        file_size: 16384,
      },
    },
  };
}

export function createTelegramVideoNoteUpdate(
  chatId: number,
  fileId: string,
  options: { messageId?: number; username?: string; firstName?: string; thumbnailFileId?: string } = {}
) {
  const messageId = options.messageId || 9000 + Math.floor(Math.random() * 50000);
  const thumbId = options.thumbnailFileId || `${fileId}_thumb`;
  return {
    update_id: 5000000 + Math.floor(Math.random() * 900000),
    message: {
      message_id: messageId,
      from: {
        id: chatId,
        is_bot: false,
        first_name: options.firstName || `User_${chatId}`,
        username: options.username || `user_${chatId}`,
      },
      chat: {
        id: chatId,
        first_name: options.firstName || `User_${chatId}`,
        type: 'private',
      },
      date: Math.floor(Date.now() / 1000),
      video_note: {
        file_id: fileId,
        file_unique_id: `vn_${fileId}`,
        length: 240,
        duration: 3,
        thumbnail: {
          file_id: thumbId,
          file_unique_id: `vn_thumb_${thumbId}`,
          width: 240,
          height: 240,
          file_size: 8192,
        },
      },
    },
  };
}

// ─── Mini App initData Generator ─────────────────────────────────────────────

export function createMockTelegramInitData(
  user: {
    id: number;
    first_name: string;
    last_name?: string;
    username?: string;
    language_code?: string;
  },
  options: {
    botToken?: string;
    authDateOffsetSec?: number; // 0 for current, e.g. -7300 for expired
    tamperHash?: boolean;
  } = {}
): string {
  const botToken = options.botToken || process.env.TELEGRAM_BOT_TOKEN || 'mock_token';
  const authDate = Math.floor(Date.now() / 1000) + (options.authDateOffsetSec || 0);

  const params = new URLSearchParams();
  params.set('auth_date', authDate.toString());
  params.set('query_id', `AAH_${Date.now()}`);
  params.set('user', JSON.stringify(user));

  // Sort parameters lexicographically
  const dataCheckArr: string[] = [];
  params.forEach((value, key) => {
    dataCheckArr.push(`${key}=${value}`);
  });
  dataCheckArr.sort();
  const dataCheckString = dataCheckArr.join('\n');

  // Compute HMAC
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  let hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (options.tamperHash) {
    hash = hash.replace(/^[0-9a-f]/, (c) => (c === 'a' ? 'b' : 'a'));
  }

  params.set('hash', hash);
  return params.toString();
}

// ─── Direct Route Dispatchers ────────────────────────────────────────────────

export async function dispatchWebhookUpdate(update: any): Promise<{
  status: number;
  body: any;
  durationMs: number;
}> {
  const routeMod = await import('../../src/app/api/telegram/webhook/route');
  const req = new Request('https://spacematch.local/api/telegram/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  });

  const t0 = performance.now();
  const res = await routeMod.POST(req);
  const t1 = performance.now();

  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  return {
    status: res.status,
    body,
    durationMs: t1 - t0,
  };
}

export async function dispatchSpacesApi(params?: { query?: string; neighborhood?: string }): Promise<{
  status: number;
  body: any;
  durationMs: number;
}> {
  const routeMod = await import('../../src/app/api/spaces/route');
  const url = new URL('https://spacematch.local/api/spaces');
  if (params?.query) url.searchParams.set('query', params.query);
  if (params?.neighborhood) url.searchParams.set('neighborhood', params.neighborhood);

  const req = new Request(url.toString(), { method: 'GET' });
  const t0 = performance.now();
  const res = await routeMod.GET(req);
  const t1 = performance.now();

  const body = await res.json();
  return { status: res.status, body, durationMs: t1 - t0 };
}

export async function dispatchRoommatesApi(params?: { subcity?: string }): Promise<{
  status: number;
  body: any;
  durationMs: number;
}> {
  const routeMod = await import('../../src/app/api/roommates/route');
  const url = new URL('https://spacematch.local/api/roommates');
  if (params?.subcity) url.searchParams.set('subcity', params.subcity);

  const req = new Request(url.toString(), { method: 'GET' });
  const t0 = performance.now();
  const res = await routeMod.GET(req);
  const t1 = performance.now();

  const body = await res.json();
  return { status: res.status, body, durationMs: t1 - t0 };
}

export async function dispatchAdminChannelGet(): Promise<{
  status: number;
  body: any;
  durationMs: number;
}> {
  const routeMod = await import('../../src/app/api/admin/channel/route');
  const t0 = performance.now();
  const res = await routeMod.GET();
  const t1 = performance.now();
  const body = await res.json();
  return { status: res.status, body, durationMs: t1 - t0 };
}

export async function dispatchAdminChannelPost(payload: any): Promise<{
  status: number;
  body: any;
  durationMs: number;
}> {
  const routeMod = await import('../../src/app/api/admin/channel/route');
  const req = new Request('https://spacematch.local/api/admin/channel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const t0 = performance.now();
  const res = await routeMod.POST(req);
  const t1 = performance.now();
  const body = await res.json();
  return { status: res.status, body, durationMs: t1 - t0 };
}

export async function dispatchAdminUsersGet(query?: string): Promise<{
  status: number;
  body: any;
  durationMs: number;
}> {
  const routeMod = await import('../../src/app/api/admin/users/route');
  const url = new URL('https://spacematch.local/api/admin/users');
  if (query) url.searchParams.set('query', query);

  const req = new Request(url.toString(), { method: 'GET' });
  const t0 = performance.now();
  const res = await routeMod.GET(req);
  const t1 = performance.now();
  const body = await res.json();
  return { status: res.status, body, durationMs: t1 - t0 };
}

export async function dispatchAuthTelegram(payload: any): Promise<{
  status: number;
  body: any;
  durationMs: number;
}> {
  const routeMod = await import('../../src/app/api/auth/telegram/route');
  const req = new Request('https://spacematch.local/api/auth/telegram', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const t0 = performance.now();
  const res = await routeMod.POST(req);
  const t1 = performance.now();
  const body = await res.json();
  return { status: res.status, body, durationMs: t1 - t0 };
}

export async function dispatchOrdersCreate(payload: any): Promise<{
  status: number;
  body: any;
  durationMs: number;
}> {
  const routeMod = await import('../../src/app/api/orders/create/route');
  const req = new Request('https://spacematch.local/api/orders/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const t0 = performance.now();
  const res = await routeMod.POST(req);
  const t1 = performance.now();
  const body = await res.json();
  return { status: res.status, body, durationMs: t1 - t0 };
}

export async function dispatchOrdersVerify(payload: any): Promise<{
  status: number;
  body: any;
  durationMs: number;
}> {
  const routeMod = await import('../../src/app/api/orders/verify/route');
  const req = new Request('https://spacematch.local/api/orders/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const t0 = performance.now();
  const res = await routeMod.POST(req);
  const t1 = performance.now();
  const body = await res.json();
  return { status: res.status, body, durationMs: t1 - t0 };
}

export async function dispatchFaydaUploadUrl(payload: any): Promise<{
  status: number;
  body: any;
  durationMs: number;
}> {
  const routeMod = await import('../../src/app/api/user/fayda-upload-url/route');
  const req = new Request('https://spacematch.local/api/user/fayda-upload-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const t0 = performance.now();
  const res = await routeMod.POST(req);
  const t1 = performance.now();
  const body = await res.json();
  return { status: res.status, body, durationMs: t1 - t0 };
}

export async function dispatchVerifyFaydaQr(payload: any): Promise<{
  status: number;
  body: any;
  durationMs: number;
}> {
  const routeMod = await import('../../src/app/api/user/verify-fayda-qr/route');
  const req = new Request('https://spacematch.local/api/user/verify-fayda-qr', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const t0 = performance.now();
  const res = await routeMod.POST(req);
  const t1 = performance.now();
  const body = await res.json();
  return { status: res.status, body, durationMs: t1 - t0 };
}

// ─── Test Reporting Data Structures ──────────────────────────────────────────

export interface TestCaseResult {
  id: string;
  tier: 1 | 2 | 3 | 4;
  feature: string;
  name: string;
  status: 'PASS' | 'FAIL';
  durationMs: number;
  error?: string;
}

export interface MetricSummary {
  totalTests: number;
  passedTests: number;
  failedTests: number;
  errorRatePercent: number;
  completionRatePercent: number;
  totalDurationMs: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p90LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  tierBreakdown: Record<number, { total: number; passed: number; failed: number }>;
}

export class TestExecutionCollector {
  private results: TestCaseResult[] = [];

  record(res: TestCaseResult) {
    this.results.push(res);
  }

  getResults(): TestCaseResult[] {
    return [...this.results];
  }

  computeSummary(): MetricSummary {
    const total = this.results.length;
    const passed = this.results.filter((r) => r.status === 'PASS').length;
    const failed = this.results.filter((r) => r.status === 'FAIL').length;
    const durations = this.results.map((r) => r.durationMs).sort((a, b) => a - b);
    const totalDurationMs = durations.reduce((acc, d) => acc + d, 0);

    const percentile = (p: number) => {
      if (durations.length === 0) return 0;
      const idx = Math.min(Math.floor((p / 100) * durations.length), durations.length - 1);
      return Math.round((durations[idx] || 0) * 10) / 10;
    };

    const avg = total > 0 ? Math.round((totalDurationMs / total) * 10) / 10 : 0;

    const tierBreakdown: Record<number, { total: number; passed: number; failed: number }> = {
      1: { total: 0, passed: 0, failed: 0 },
      2: { total: 0, passed: 0, failed: 0 },
      3: { total: 0, passed: 0, failed: 0 },
      4: { total: 0, passed: 0, failed: 0 },
    };

    for (const r of this.results) {
      if (!tierBreakdown[r.tier]) {
        tierBreakdown[r.tier] = { total: 0, passed: 0, failed: 0 };
      }
      tierBreakdown[r.tier].total++;
      if (r.status === 'PASS') tierBreakdown[r.tier].passed++;
      else tierBreakdown[r.tier].failed++;
    }

    return {
      totalTests: total,
      passedTests: passed,
      failedTests: failed,
      errorRatePercent: total > 0 ? Math.round((failed / total) * 1000) / 10 : 0,
      completionRatePercent: total > 0 ? Math.round((passed / total) * 1000) / 10 : 0,
      totalDurationMs: Math.round(totalDurationMs * 10) / 10,
      avgLatencyMs: avg,
      p50LatencyMs: percentile(50),
      p90LatencyMs: percentile(90),
      p95LatencyMs: percentile(95),
      p99LatencyMs: percentile(99),
      tierBreakdown,
    };
  }
}
