/**
 * Corre la Guardia de KPIs local (los mismos chequeos del cron horario) e imprime el resultado.
 *   npx tsx scripts/audit-kpis.ts           # solo imprime
 *   npx tsx scripts/audit-kpis.ts --record  # además guarda la corrida y avisa a Slack si algo cambió
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
(async () => {
  const { runKpiGuard, recordAndAlert } = await import('../lib/audit/kpi-guard');
  const run = await runKpiGuard();
  const icon = (s: string) => (s === 'ok' ? '✅' : s === 'warn' ? '⚠️' : '🔴');
  console.log(`🛡️ Guardia KPIs ${icon(run.status)} (${run.seconds}s)`);
  for (const c of run.checks) console.log(`${icon(c.status)} [${c.area}] ${c.line}${c.detail ? '\n   ↳ ' + c.detail.split('\n').join('\n   ↳ ') : ''}`);
  if (process.argv.includes('--record')) console.log(JSON.stringify(await recordAndAlert(run)));
  if (run.status === 'alarm') process.exit(2);
})().catch((e) => { console.error('❌', e instanceof Error ? e.stack ?? e.message : e); process.exit(1); });
