/**
 * scripts/benchmark-concurrency.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Automated Concurrency & High-Traffic Load Benchmark for SpaceMatch Addis Bot.
 *
 * Simulates real-world concurrent Telegram webhook updates hitting the bot
 * simultaneously to measure:
 * 1. Throughput (Requests Per Second - RPS)
 * 2. Latency percentiles: Average, p50, p90, p95, p99, Min, Max
 * 3. Success rate under heavy traffic
 */

import fs from 'fs';
import path from 'path';

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

// We dynamically import the route handler in main() so process.env is populated first
let POST: (req: Request) => Promise<Response>;

interface RequestMetrics {
  durationMs: number;
  statusCode: number;
  success: boolean;
  error?: string;
}

interface BenchmarkReport {
  concurrencyLevel: number;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  totalTimeSec: number;
  requestsPerSecond: number;
  avgLatencyMs: number;
  minLatencyMs: number;
  p50LatencyMs: number;
  p90LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  maxLatencyMs: number;
}

function createMockTelegramRequest(chatId: number, text: string): Request {
  const updatePayload = {
    update_id: 1000000 + Math.floor(Math.random() * 900000),
    message: {
      message_id: 500 + Math.floor(Math.random() * 5000),
      from: {
        id: chatId,
        is_bot: false,
        first_name: `BenchmarkUser_${chatId}`,
        username: `user_${chatId}`,
      },
      chat: {
        id: chatId,
        first_name: `BenchmarkUser_${chatId}`,
        type: 'private',
      },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  };

  return new Request('https://spacematch1-flax.vercel.app/api/telegram/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updatePayload),
  });
}

function createMockCallbackRequest(chatId: number, callbackData: string): Request {
  const updatePayload = {
    update_id: 2000000 + Math.floor(Math.random() * 900000),
    callback_query: {
      id: `cb_${Date.now()}_${Math.random()}`,
      from: {
        id: chatId,
        is_bot: false,
        first_name: `BenchmarkUser_${chatId}`,
      },
      message: {
        message_id: 8000,
        chat: { id: chatId, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: 'Previous bot prompt',
      },
      data: callbackData,
    },
  };

  return new Request('https://spacematch1-flax.vercel.app/api/telegram/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updatePayload),
  });
}

async function runBenchmarkBatch(
  concurrency: number,
  batchRequests: { type: 'message' | 'callback'; chatId: number; payload: string }[]
): Promise<BenchmarkReport> {
  const metrics: RequestMetrics[] = [];
  const startTime = performance.now();

  // Execute in chunks matching concurrency
  for (let i = 0; i < batchRequests.length; i += concurrency) {
    const chunk = batchRequests.slice(i, i + concurrency);
    const promises = chunk.map(async (reqDef) => {
      const reqStart = performance.now();
      try {
        const req = reqDef.type === 'message'
          ? createMockTelegramRequest(reqDef.chatId, reqDef.payload)
          : createMockCallbackRequest(reqDef.chatId, reqDef.payload);

        const res = await POST(req);
        const reqEnd = performance.now();

        return {
          durationMs: reqEnd - reqStart,
          statusCode: res.status,
          success: res.status === 200,
        };
      } catch (err: any) {
        const reqEnd = performance.now();
        return {
          durationMs: reqEnd - reqStart,
          statusCode: 500,
          success: false,
          error: err.message,
        };
      }
    });

    const results = await Promise.all(promises);
    metrics.push(...results);
  }

  const endTime = performance.now();
  const totalTimeSec = (endTime - startTime) / 1000;

  const durations = metrics.map((m) => m.durationMs).sort((a, b) => a - b);
  const successful = metrics.filter((m) => m.success).length;
  const failed = metrics.filter((m) => !m.success).length;

  const percentile = (p: number) => {
    const idx = Math.min(Math.floor((p / 100) * durations.length), durations.length - 1);
    return durations[idx] || 0;
  };

  const avg = durations.reduce((a, b) => a + b, 0) / (durations.length || 1);

  return {
    concurrencyLevel: concurrency,
    totalRequests: metrics.length,
    successfulRequests: successful,
    failedRequests: failed,
    totalTimeSec: Math.round(totalTimeSec * 1000) / 1000,
    requestsPerSecond: Math.round((metrics.length / (totalTimeSec || 0.001)) * 10) / 10,
    avgLatencyMs: Math.round(avg * 10) / 10,
    minLatencyMs: Math.round((durations[0] || 0) * 10) / 10,
    p50LatencyMs: Math.round(percentile(50) * 10) / 10,
    p90LatencyMs: Math.round(percentile(90) * 10) / 10,
    p95LatencyMs: Math.round(percentile(95) * 10) / 10,
    p99LatencyMs: Math.round(percentile(99) * 10) / 10,
    maxLatencyMs: Math.round((durations[durations.length - 1] || 0) * 10) / 10,
  };
}

async function main() {
  process.env.MOCK_TELEGRAM_API = 'true';
  const routeMod = await import('../src/app/api/telegram/webhook/route');
  POST = routeMod.POST;

  console.log('================================================================');
  console.log(' 🚀 SpaceMatch Addis · Telegram Bot Concurrency & Load Benchmark');
  console.log('================================================================');
  console.log(`Environment: Node ${process.version} | Host OS: Windows`);
  console.log(`Target: POST /api/telegram/webhook (In-process High-Concurrency)`);
  console.log('----------------------------------------------------------------\n');

  // Generate diverse requests (start, language switches, subcity toggles, callbacks)
  const generateRequests = (count: number) => {
    const actions: { type: 'message' | 'callback'; payload: string }[] = [
      { type: 'message', payload: '/start' },
      { type: 'message', payload: '/lang' },
      { type: 'callback', payload: 'set_lang:am' },
      { type: 'callback', payload: 'set_lang:en' },
      { type: 'callback', payload: 'dyn_gender:Male' },
      { type: 'callback', payload: 'dyn_religion:Orthodox' },
      { type: 'callback', payload: 'dyn_sub_toggle:Bole' },
      { type: 'message', payload: '8000 - 15000' },
      { type: 'message', payload: 'Accountant' },
      { type: 'callback', payload: 'nav_start' },
    ];

    const list: { type: 'message' | 'callback'; chatId: number; payload: string }[] = [];
    for (let i = 0; i < count; i++) {
      const act = actions[i % actions.length];
      const testChatId = 700000000 + (i % 50); // 50 simulated concurrent users
      list.push({
        type: act.type,
        chatId: testChatId,
        payload: act.payload,
      });
    }
    return list;
  };

  // Warmup run
  console.log('⏳ Performing warmup run (10 requests)...');
  await runBenchmarkBatch(5, generateRequests(10));
  console.log('✅ Warmup complete. In-memory caches primed.\n');

  // Test tiers: 20 concurrent, 50 concurrent, 100 concurrent
  const tiers = [
    { name: 'Tier 1: Normal Active Burst', concurrency: 20, total: 60 },
    { name: 'Tier 2: High Concurrent Traffic', concurrency: 50, total: 100 },
    { name: 'Tier 3: Peak Viral Flash Mob', concurrency: 100, total: 200 },
  ];

  const reports: BenchmarkReport[] = [];

  for (const tier of tiers) {
    console.log(`⚡ Running [${tier.name}] (${tier.concurrency} concurrent workers, ${tier.total} total requests)...`);
    const reqs = generateRequests(tier.total);
    const report = await runBenchmarkBatch(tier.concurrency, reqs);
    reports.push(report);
    console.log(`   └─ Completed in ${report.totalTimeSec}s | Throughput: ${report.requestsPerSecond} RPS | p50: ${report.p50LatencyMs}ms | p95: ${report.p95LatencyMs}ms\n`);
  }

  // Summary Table
  console.log('===========================================================================================');
  console.log(' 📊 BENCHMARK RESULTS SUMMARY');
  console.log('===========================================================================================');
  console.log(
    'Concurrency | Total Req | Success | Total Time | Throughput (RPS) | Avg Latency | p50 (Med) | p95 Latency | p99 Latency'
  );
  console.log(
    '-------------------------------------------------------------------------------------------'
  );
  for (const r of reports) {
    const conc = `${r.concurrencyLevel} workers`.padEnd(12);
    const tot = `${r.totalRequests}`.padEnd(10);
    const succ = `${r.successfulRequests}/${r.totalRequests}`.padEnd(8);
    const time = `${r.totalTimeSec}s`.padEnd(11);
    const rps = `${r.requestsPerSecond} req/s`.padEnd(17);
    const avg = `${r.avgLatencyMs}ms`.padEnd(12);
    const p50 = `${r.p50LatencyMs}ms`.padEnd(10);
    const p95 = `${r.p95LatencyMs}ms`.padEnd(12);
    const p99 = `${r.p99LatencyMs}ms`;
    console.log(`${conc}| ${tot}| ${succ}| ${time}| ${rps}| ${avg}| ${p50}| ${p95}| ${p99}`);
  }
  console.log('===========================================================================================\n');
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
