/**
 * Verifica que la réplica (kpi_daily + lib/kpi/replica.ts) reproduce los KPIs de BigQuery
 * (lib/kpi/formulas.ts, validados al centavo contra el Looker) para varios periodos y filtros.
 *
 *   npx tsx scripts/test-kpi-replica.ts            # casos por default
 *   npx tsx scripts/test-kpi-replica.ts --from 2026-10-05 --to 2026-10-11 --os iOS --country MX
 */
import fs from 'fs';
import path from 'path';

function loadEnvLocal() {
  const p = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(p)) return;
  for (const raw of fs.readFileSync(p, 'utf-8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}
loadEnvLocal();

const args = process.argv.slice(2);
const opt = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const list = (f: string) => { const v = opt(f); return v ? v.split(',') : undefined; };

type Case = { name: string; start: string; end: string; region?: string[]; country?: string[]; os?: string[]; language?: string[] };

const DEFAULT_CASES: Case[] = [
  { name: 'semana 5–11 oct 2026 (todo)', start: '2026-10-05', end: '2026-10-11' },
  { name: 'sept 2026 (todo)', start: '2026-09-01', end: '2026-09-30' },
  { name: 'sept 2026 iOS', start: '2026-09-01', end: '2026-09-30', os: ['iOS'] },
  { name: 'sept 2026 Android · MX', start: '2026-09-01', end: '2026-09-30', os: ['Android'], country: ['MX'] },
  { name: '2026 YTD · pt', start: '2026-01-01', end: '2026-10-13', language: ['pt'] },
  { name: 'ago 2025 · US & CA', start: '2025-08-01', end: '2025-08-31', region: ['US & CA'] },
  { name: 'feb 2024 (todo)', start: '2024-02-01', end: '2024-02-29' },
  { name: '17 ago → 12 oct 2026 (orillas a media semana/mes)', start: '2026-08-17', end: '2026-10-12' },
  { name: 'todo el historial 2024 → ayer', start: '2024-01-01', end: '__YESTERDAY__' },
];

// KPI_SQL key → [definición, campo de KpiValues]
const MAP: Record<string, ['looker' | 'fixed', string]> = {
  spend: ['fixed', 'spend'], signups: ['fixed', 'signups'], ftsStarted: ['fixed', 'ftsStarted'], ftsConverted: ['fixed', 'ftsConverted'],
  newSubs: ['fixed', 'newSubs'], purchasesNonFt: ['fixed', 'purchasesNonFt'], conversionRate: ['fixed', 'conversionRate'],
  ftStartRate: ['fixed', 'ftStartRate'], ftConversionRate: ['fixed', 'ftConversionRate'], ftShare: ['fixed', 'ftShare'],
  cac: ['fixed', 'cac'], cpnu: ['fixed', 'cpnu'], cpft: ['fixed', 'cpft'], arpu: ['fixed', 'arpu'], firstTicketCac: ['fixed', 'firstTicketCac'],
  nsSales: ['fixed', 'nsSales'], totalRenewalSales: ['fixed', 'totalRenewalSales'], renewals: ['fixed', 'renewals'], totalSales: ['fixed', 'totalSales'],
  netSales: ['fixed', 'netSales'], refundsAmount: ['fixed', 'refundsAmount'], refundsCount: ['fixed', 'refundsCount'],
  mobileCm: ['fixed', 'mobileCm'], totalContribution: ['fixed', 'totalContribution'], contributionMarginPct: ['fixed', 'contributionMarginPct'],
  newSubsMargin: ['fixed', 'newSubsMargin'],
  netSalesLooker: ['looker', 'netSales'], mobileCmLooker: ['looker', 'mobileCm'], totalContributionLooker: ['looker', 'totalContribution'],
  contributionMarginPctLooker: ['looker', 'contributionMarginPct'], purchasesNonFtLooker: ['looker', 'purchasesNonFtLooker'],
};

(async () => {
  const { KPI_SQL } = await import('../lib/kpi/formulas');
  const { getBigQueryClient, KINEDU_OPERATIONAL_TABLE } = await import('../lib/bigquery/client');
  const { fetchAgg, sumAgg, computeKpis } = await import('../lib/kpi/replica');
  const bq = getBigQueryClient();

  const cases: Case[] = opt('--from')
    ? [{ name: 'custom', start: opt('--from')!, end: opt('--to') ?? opt('--from')!, region: list('--region'), country: list('--country'), os: list('--os'), language: list('--language') }]
    : DEFAULT_CASES.map((c) => ({ ...c, end: c.end === '__YESTERDAY__' ? new Date(Date.now() - 30 * 3.6e6).toISOString().slice(0, 10) : c.end }));

  let failures = 0;
  for (const c of cases) {
    const where: string[] = ['date BETWEEN @start AND @end'];
    const params: Record<string, unknown> = { start: c.start, end: c.end };
    const dim = (col: string, p: string, v?: string[]) => { if (v?.length) { where.push(`COALESCE(${col}, "null") IN UNNEST(@${p})`); params[p] = v; } };
    dim('kinedu_region', 'region', c.region); dim('country', 'country', c.country); dim('os', 'os', c.os); dim('kinedu_language', 'language', c.language);
    const sel = Object.entries(KPI_SQL).map(([k, sql]) => `${sql} AS ${k}`).join(',\n  ');
    const [rows] = await bq.query({ query: `SELECT\n  ${sel}\nFROM ${KINEDU_OPERATIONAL_TABLE}\nWHERE ${where.join(' AND ')}`, params });
    const bqRow = (rows as Record<string, unknown>[])[0] ?? {};

    const agg = sumAgg(await fetchAgg({ start: c.start, end: c.end, region: c.region, country: c.country, os: c.os, language: c.language }, 'total'));
    const rep = { looker: computeKpis(agg, 'looker'), fixed: computeKpis(agg, 'fixed') };

    const diffs: string[] = [];
    // Con la calibración activa (migración 037) los montos del Corregido salen de las tiendas, no de la fórmula
    // de BigQuery: se validan en scripts/audit-kpis.ts (calibrado vs store_daily), no aquí.
    const CAL_MONEY = new Set(['nsSales', 'totalSales', 'netSales', 'mobileCm', 'totalContribution', 'contributionMarginPct', 'arpu', 'firstTicketCac']);
    for (const [k, [def, field]] of Object.entries(MAP)) {
      if (def === 'fixed' && rep.fixed.calibration.calibrated && CAL_MONEY.has(k)) continue;
      const a = Number(bqRow[k] ?? 0);
      const bRaw = (rep[def] as unknown as Record<string, number | null>)[field];
      const b = bRaw ?? 0;
      const tol = Math.abs(a) < 10 ? 0.0005 : 0.02; // ratios vs montos
      if (Math.abs(a - b) > tol) diffs.push(`   ✗ ${k}: BQ ${a} · réplica ${b}`);
    }
    if (diffs.length) { failures++; console.log(`❌ ${c.name}\n${diffs.join('\n')}`); }
    else console.log(`✅ ${c.name} — ${Object.keys(MAP).length} KPIs iguales (TC fixed $${Math.round(rep.fixed.totalContribution).toLocaleString('en-US')} · Looker $${Math.round(rep.looker.totalContribution).toLocaleString('en-US')})`);
  }
  // Serie semanal (camino del rollup semanal + orillas diarias): spend, NS Sales, Net Sales y TC por semana ISO.
  if (!opt('--from')) {
    const ws = '2026-07-30', we = '2026-10-11'; // empieza en jueves → la 1ª semana sale del diario
    const [bqw] = await bq.query({ query: `SELECT CAST(DATE_TRUNC(date, WEEK(MONDAY)) AS STRING) AS wk, ${KPI_SQL.spend} AS spend, ${KPI_SQL.nsSales} AS nsSales, ${KPI_SQL.netSales} AS netSales, ${KPI_SQL.totalContributionLooker} AS tcLooker FROM ${KINEDU_OPERATIONAL_TABLE} WHERE date BETWEEN @s AND @e GROUP BY wk ORDER BY wk`, params: { s: ws, e: we } });
    const weeks = await fetchAgg({ start: ws, end: we }, 'week');
    const byWk = new Map(weeks.map((w) => [w.period, w]));
    const bad: string[] = [];
    for (const r of bqw as Record<string, unknown>[]) {
      const w = byWk.get(String(r.wk));
      if (!w) { bad.push(`${r.wk}: falta en réplica`); continue; }
      const f = computeKpis(w, 'fixed'), l = computeKpis(w, 'looker');
      for (const [name, a, b] of [['spend', r.spend, f.spend], ['nsSales', r.nsSales, f.nsSales], ['netSales', r.netSales, f.netSales], ['tcLooker', r.tcLooker, l.totalContribution]] as const)
        if (Math.abs(Number(a) - Number(b)) > 0.02) bad.push(`${r.wk} ${name}: BQ ${a} · réplica ${b}`);
    }
    if (bad.length) { failures++; console.log(`❌ serie semanal ${ws} → ${we}\n   ${bad.join('\n   ')}`); }
    else console.log(`✅ serie semanal ${ws} → ${we} — ${(bqw as unknown[]).length} semanas iguales (spend, NS Sales, Net Sales, TC Looker)`);
  }
  if (failures) process.exit(1);
})().catch((e) => { console.error('❌', e instanceof Error ? e.stack ?? e.message : e); process.exit(1); });
