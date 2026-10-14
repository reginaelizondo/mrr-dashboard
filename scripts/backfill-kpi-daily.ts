/**
 * Backfill kpi_daily from BigQuery in monthly chunks.
 *   npx tsx scripts/backfill-kpi-daily.ts --from 2024-01-01 --to 2026-10-13
 *   npx tsx scripts/backfill-kpi-daily.ts --verify --from 2026-10-01 --to 2026-10-13   # compare replica vs BigQuery
 */
import fs from 'fs';
import path from 'path';
(function loadEnv() {
  const p = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(p)) return;
  for (const raw of fs.readFileSync(p, 'utf-8').split('\n')) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('='); if (eq === -1) continue;
    const k = line.slice(0, eq).trim(); let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
})();
const args = process.argv.slice(2);
const opt = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
(async () => {
  const { syncKpiDaily, verifyKpiDaily } = await import('../lib/sync/kpi-daily');
  const { addDays } = await import('../lib/kpi/period');
  const from = opt('--from') ?? '2024-01-01';
  const to = opt('--to') ?? new Date().toISOString().slice(0, 10);
  if (args.includes('--verify')) {
    const r = await verifyKpiDaily(from, to);
    console.log(`verify ${from} → ${to}: ${r.days} días, ${r.mismatches.length} diferencias`);
    for (const m of r.mismatches.slice(0, 20)) console.log('  ', m);
    return;
  }
  let start = from; let total = 0;
  while (start <= to) {
    const [y, m] = start.split('-').map(Number);
    const monthEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // last day of month
    const end = monthEnd < to ? monthEnd : to;
    const t0 = Date.now();
    const r = await syncKpiDaily(start, end);
    total += r.rows;
    console.log(`${start} → ${end}: ${r.rows} filas, ${r.days} días (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    start = addDays(end, 1);
  }
  console.log(`total ${total} filas`);
})().catch((e) => { console.error('❌', e instanceof Error ? e.stack ?? e.message : e); process.exit(1); });
