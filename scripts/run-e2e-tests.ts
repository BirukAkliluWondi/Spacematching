#!/usr/bin/env tsx
/**
 * scripts/run-e2e-tests.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Master End-to-End (E2E) Test Suite Runner & Quantitative Evaluation Harness.
 *
 * Executes the complete 4-Tier test suite:
 *  - Tier 1: Feature Coverage (≥5 tests per feature across all bot workflows and APIs)
 *  - Tier 2: Boundary & Corner Cases (empty, extreme, malformed, security limits)
 *  - Tier 3: Cross-Feature Interactions (pairwise combinations)
 *  - Tier 4: Real-World Application Scenarios (multi-turn user journeys)
 *
 * Computes and outputs production-grade quantitative quality metrics:
 *  - Total Test Count & Pass/Fail Count
 *  - Total Execution Duration
 *  - Average & Percentile Latencies (p50, p90, p95, p99)
 *  - Error Rate (0.0% standard)
 *  - Workflow Completion Rate (100.0% standard)
 *
 * Usage:
 *   npx tsx scripts/run-e2e-tests.ts
 */

import fs from 'fs';
import path from 'path';

// Load .env.local natively before any other imports
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

import { TestExecutionCollector } from './helpers/test-harness';
import { runTier1Tests } from '../tests/e2e/tier1-features.test';
import { runTier2Tests } from '../tests/e2e/tier2-boundary.test';
import { runTier3Tests } from '../tests/e2e/tier3-cross-feature.test';
import { runTier4Tests } from '../tests/e2e/tier4-scenarios.test';

async function main() {
  console.log('========================================================================================');
  console.log(' 🚀 SpaceMatch Addis · Comprehensive 4-Tier E2E Test Suite & Quantitative Harness');
  console.log('========================================================================================');
  console.log(` Runtime: Node.js ${process.version} | Host OS: ${process.platform} (${process.arch})`);
  console.log(` Timestamp: ${new Date().toISOString()}`);
  console.log(` Target Environment: In-Process Zero-Network Synthetic Webhook & Mock Services`);
  console.log('----------------------------------------------------------------------------------------\n');

  const collector = new TestExecutionCollector();
  const overallStart = performance.now();

  // ─── Tier 1: Feature Coverage ───────────────────────────────────────────────
  console.log('▶ [Tier 1] Executing Feature Coverage Test Suite (All Bot Workflows & APIs)...');
  const t1Start = performance.now();
  await runTier1Tests(collector);
  const t1Duration = ((performance.now() - t1Start) / 1000).toFixed(2);
  const t1Results = collector.getResults().filter((r) => r.tier === 1);
  const t1Passed = t1Results.filter((r) => r.status === 'PASS').length;
  console.log(`  └─ Completed: ${t1Passed}/${t1Results.length} Passed in ${t1Duration}s\n`);

  // ─── Tier 2: Boundary & Corner Cases ────────────────────────────────────────
  console.log('▶ [Tier 2] Executing Boundary & Corner Cases Test Suite...');
  const t2Start = performance.now();
  await runTier2Tests(collector);
  const t2Duration = ((performance.now() - t2Start) / 1000).toFixed(2);
  const t2Results = collector.getResults().filter((r) => r.tier === 2);
  const t2Passed = t2Results.filter((r) => r.status === 'PASS').length;
  console.log(`  └─ Completed: ${t2Passed}/${t2Results.length} Passed in ${t2Duration}s\n`);

  // ─── Tier 3: Cross-Feature Interactions ─────────────────────────────────────
  console.log('▶ [Tier 3] Executing Cross-Feature Interactions Test Suite...');
  const t3Start = performance.now();
  await runTier3Tests(collector);
  const t3Duration = ((performance.now() - t3Start) / 1000).toFixed(2);
  const t3Results = collector.getResults().filter((r) => r.tier === 3);
  const t3Passed = t3Results.filter((r) => r.status === 'PASS').length;
  console.log(`  └─ Completed: ${t3Passed}/${t3Results.length} Passed in ${t3Duration}s\n`);

  // ─── Tier 4: Real-World Application Scenarios ───────────────────────────────
  console.log('▶ [Tier 4] Executing Real-World Application Scenarios (End-to-End User Journeys)...');
  const t4Start = performance.now();
  await runTier4Tests(collector);
  const t4Duration = ((performance.now() - t4Start) / 1000).toFixed(2);
  const t4Results = collector.getResults().filter((r) => r.tier === 4);
  const t4Passed = t4Results.filter((r) => r.status === 'PASS').length;
  console.log(`  └─ Completed: ${t4Passed}/${t4Results.length} Passed in ${t4Duration}s\n`);

  const overallDurationSec = ((performance.now() - overallStart) / 1000).toFixed(2);
  const summary = collector.computeSummary();

  // ─── Print Failures If Any ──────────────────────────────────────────────────
  const failedTests = collector.getResults().filter((r) => r.status === 'FAIL');
  if (failedTests.length > 0) {
    console.log('========================================================================================');
    console.log(' ❌ TEST FAILURES DETECTED');
    console.log('========================================================================================');
    for (const f of failedTests) {
      console.log(` [Tier ${f.tier}] ${f.feature} :: ${f.name}`);
      console.log(`   Error: ${f.error}\n`);
    }
  }

  // ─── Quantitative Metrics Summary ───────────────────────────────────────────
  console.log('========================================================================================');
  console.log(' 📊 QUANTITATIVE METRICS EVALUATION REPORT');
  console.log('========================================================================================');
  console.log(` Total Tests Executed       : ${summary.totalTests}`);
  console.log(` Total Passed               : ${summary.passedTests}`);
  console.log(` Total Failed               : ${summary.failedTests}`);
  console.log(` Workflow Error Rate        : ${summary.errorRatePercent.toFixed(1)}% (Target: 0.0%)`);
  console.log(` Workflow Completion Rate   : ${summary.completionRatePercent.toFixed(1)}% (Target: 100.0%)`);
  console.log(` Total Test Suite Duration  : ${overallDurationSec}s`);
  console.log(` Mean Workflow Latency      : ${summary.avgLatencyMs.toFixed(1)} ms`);
  console.log(` p50 (Median) Latency       : ${summary.p50LatencyMs.toFixed(1)} ms`);
  console.log(` p90 Latency                : ${summary.p90LatencyMs.toFixed(1)} ms`);
  console.log(` p95 Latency                : ${summary.p95LatencyMs.toFixed(1)} ms`);
  console.log(` p99 Latency                : ${summary.p99LatencyMs.toFixed(1)} ms`);
  console.log('----------------------------------------------------------------------------------------');
  console.log(' Tier Breakdown:');
  console.log(
    `  • Tier 1 (Feature Coverage)      : ${summary.tierBreakdown[1]?.passed || 0}/${summary.tierBreakdown[1]?.total || 0} passed`
  );
  console.log(
    `  • Tier 2 (Boundary & Corner)     : ${summary.tierBreakdown[2]?.passed || 0}/${summary.tierBreakdown[2]?.total || 0} passed`
  );
  console.log(
    `  • Tier 3 (Cross-Feature Pairwise): ${summary.tierBreakdown[3]?.passed || 0}/${summary.tierBreakdown[3]?.total || 0} passed`
  );
  console.log(
    `  • Tier 4 (Real-World Scenarios)  : ${summary.tierBreakdown[4]?.passed || 0}/${summary.tierBreakdown[4]?.total || 0} passed`
  );
  console.log('========================================================================================\n');

  if (summary.failedTests > 0) {
    console.error(`❌ Suite failed with ${summary.failedTests} failing tests.`);
    process.exit(1);
  } else {
    console.log('✅ ALL E2E TEST SUITES PASSED CLEANLY (100% SUCCESSFUL VALIDATION)!\n');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Fatal runner exception:', err);
  process.exit(1);
});
