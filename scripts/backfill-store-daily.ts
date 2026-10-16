/**
 * Carga store_daily (Apple, Google, Stripe por día y país) y recalibra el Corregido.
 *   npx tsx scripts/backfill-store-daily.ts --from 2024-01-01 --to 2026-10-16
 *   npx tsx scripts/backfill-store-daily.ts --from 2026-09-01 --to 2026-10-16 --stores stripe,google
 *   npx tsx scripts/backfill-store-daily.ts --recalibrate --from 2024-01-01 --to 2026-10-16   # solo recalcula factores + rollup
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
  const { syncStoreDaily } = await import('../lib/sync/store-daily');
  const { monthChunks } = await import('../lib/sync/kpi-daily');
  const from = opt('--from'); const to = opt('--to');
  if (!from || !to) throw new Error('usa --from YYYY-MM-DD --to YYYY-MM-DD');
  if (args.includes('--recalibrate')) {
    const { createServerClient } = await import('../lib/supabase/server');
    const sb = createServerClient();
    for (const c of monthChunks(from, to)) {
      const t0 = Date.now();
      const { error } = await sb.rpc('refresh_store_calibration', { p_start: c.start, p_end: c.end });
      if (error) throw new Error(`${c.start}: ${error.message}`);
      console.log(`recalibrado ${c.start} → ${c.end} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    }
    return;
  }
  const stores = (opt('--stores')?.split(',') ?? ['apple', 'google', 'stripe']) as Array<'apple' | 'google' | 'stripe'>;
  // Un mes a la vez: cada llamada recalibra su mes (y 6 días después) dentro del timeout de Supabase.
  for (const c of monthChunks(from, to)) {
    const t0 = Date.now();
    const r = await syncStoreDaily(c.start, c.end, stores);
    console.log(`${c.start} → ${c.end}: ${Object.entries(r.stores).map(([s, v]) => `${s} ${v.cells} celdas $${v.net.toLocaleString('en-US')} neto${v.estimado ? ` (${v.estimado} est.)` : ''}`).join(' · ')} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
})().catch((e) => { console.error('❌', e instanceof Error ? e.stack ?? e.message : e); process.exit(1); });
