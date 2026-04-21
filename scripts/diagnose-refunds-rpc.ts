/**
 * Diagnostic script for the Apple refunds RPC timeouts.
 * Measures:
 *   1. Row count of apple_subscription_events
 *   2. Row count within a typical 12-month window
 *   3. Actual execution time of each of the 6 RPCs the /refunds page runs
 *   4. EXPLAIN ANALYZE of the slowest ones (via a raw SQL RPC we create on-the-fly)
 *
 * Usage:  npx tsx scripts/diagnose-refunds-rpc.ts
 */

import { createClient } from '@supabase/supabase-js';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Load .env.local
const envPath = path.join(process.cwd(), '.env.local');
for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) process.env[m[1]] ||= m[2].replace(/^"|"$/g, '');
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

function today(): string { return new Date().toISOString().slice(0, 10); }
function monthsAgo(n: number): string {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - n);
  d.setUTCDate(1);
  return d.toISOString().slice(0, 10);
}

async function time<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  const t0 = Date.now();
  try {
    const res = await fn();
    const elapsed = Date.now() - t0;
    console.log(`  ${label.padEnd(60)} ${elapsed}ms`);
    return res;
  } catch (e) {
    const elapsed = Date.now() - t0;
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  ${label.padEnd(60)} ${elapsed}ms  ❌ ${msg.slice(0, 100)}`);
    return null;
  }
}

async function rpcTime(label: string, name: string, args: object) {
  const t0 = Date.now();
  const { data, error } = await supabase.rpc(name, args);
  const elapsed = Date.now() - t0;
  const rows = Array.isArray(data) ? data.length : 0;
  const status = error ? `❌ ${error.code} ${error.message.slice(0, 60)}` : `✓ ${rows} rows`;
  console.log(`  ${label.padEnd(60)} ${String(elapsed).padStart(6)}ms  ${status}`);
  return { data, error, elapsed };
}

async function main() {
  const end = today();
  const start12m = monthsAgo(12);
  const start6m  = monthsAgo(6);
  const start3m  = monthsAgo(3);

  console.log('=== Table size ===');
  await time('total rows in apple_subscription_events', async () => {
    const { count } = await supabase
      .from('apple_subscription_events')
      .select('*', { count: 'exact', head: true });
    console.log(`      total rows: ${count?.toLocaleString()}`);
  });

  for (const [label, startDate] of [
    ['rows in last 3 months',  start3m],
    ['rows in last 6 months',  start6m],
    ['rows in last 12 months', start12m],
  ] as const) {
    await time(label, async () => {
      const { count } = await supabase
        .from('apple_subscription_events')
        .select('*', { count: 'exact', head: true })
        .gte('event_date', startDate)
        .lte('event_date', end);
      console.log(`      ${label}: ${count?.toLocaleString()}`);
    });
  }

  console.log('\n=== RPCs — 12-month window ===');
  const args12 = { start_date: start12m, end_date: end };
  await rpcTime('apple_refunds_by_cpp_range', 'apple_refunds_by_cpp_range', args12);
  await rpcTime('apple_refunds_by_days_to_refund_range', 'apple_refunds_by_days_to_refund_range', args12);
  await rpcTime('dim: duration', 'apple_refunds_by_dimension_range', { dim: 'duration', ...args12, top_n: 20 });
  await rpcTime('dim: offer',    'apple_refunds_by_dimension_range', { dim: 'offer',    ...args12, top_n: 20 });
  await rpcTime('dim: country',  'apple_refunds_by_dimension_range', { dim: 'country',  ...args12, top_n: 15 });
  await rpcTime('dim: sku',      'apple_refunds_by_dimension_range', { dim: 'sku',      ...args12, top_n: 15 });

  console.log('\n=== RPCs — 6-month window ===');
  const args6 = { start_date: start6m, end_date: end };
  await rpcTime('apple_refunds_by_cpp_range', 'apple_refunds_by_cpp_range', args6);
  await rpcTime('dim: duration', 'apple_refunds_by_dimension_range', { dim: 'duration', ...args6, top_n: 20 });

  console.log('\n=== RPCs — 3-month window ===');
  const args3 = { start_date: start3m, end_date: end };
  await rpcTime('apple_refunds_by_cpp_range', 'apple_refunds_by_cpp_range', args3);
  await rpcTime('dim: duration', 'apple_refunds_by_dimension_range', { dim: 'duration', ...args3, top_n: 20 });
}

main().catch((e) => { console.error(e); process.exit(1); });
