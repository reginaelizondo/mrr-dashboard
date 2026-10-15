/**
 * Backfill kpi_daily from BigQuery (monthly chunks) and refresh kpi_rollup.
 *   npx tsx scripts/backfill-kpi-daily.ts --from 2024-01-01 --to 2026-10-13            # carga + rollup
 *   npx tsx scripts/backfill-kpi-daily.ts --verify --from 2024-01-01 --to 2026-10-15   # compara contra BigQuery
 *   npx tsx scripts/backfill-kpi-daily.ts --rollup --from 2024-01-01 --to 2026-10-15   # solo recalcula kpi_rollup
 *   npx tsx scripts/backfill-kpi-daily.ts --daily [--today 2026-10-15]                 # job diario completo (95 d + rotación + reparación)
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
const flag = (f: string) => args.includes(f);
(async () => {
  const { syncKpiDaily, verifyKpiDaily, refreshKpiRollup, runDailyKpiSync } = await import('../lib/sync/kpi-daily');
  const { todayMx } = await import('../lib/kpi/period');
  if (flag('--daily')) {
    const r = await runDailyKpiSync(opt('--today') ?? todayMx(), { budgetMs: 1_800_000 });
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  const from = opt('--from'); const to = opt('--to');
  if (!from || !to) throw new Error('usa --from YYYY-MM-DD --to YYYY-MM-DD (o --daily)');
  if (flag('--verify')) {
    const r = await verifyKpiDaily(from, to);
    console.log(`verify ${from} → ${to}: ${r.days} días, ${r.badDates.length} días con diferencias (${r.mismatches.length} celdas día×OS×campo)`);
    for (const m of r.mismatches.slice(0, 20)) console.log('  ', m);
    return;
  }
  if (flag('--rollup')) {
    const t0 = Date.now();
    const n = await refreshKpiRollup(from, to);
    console.log(`rollup ${from} → ${to}: ${n} filas (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    return;
  }
  const t0 = Date.now();
  const r = await syncKpiDaily(from, to);
  console.log(`${from} → ${to}: ${r.rows} filas, ${r.days} días (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
})().catch((e) => { console.error('❌', e instanceof Error ? e.stack ?? e.message : e); process.exit(1); });
