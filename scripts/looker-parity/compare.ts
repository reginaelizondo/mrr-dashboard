/**
 * Compara el resumen por columna de cada tabla/gráfica del Looker (digest.json: n, suma, tolerancia
 * acumulada por redondeo) contra la réplica (definición 'looker') en los mismos periodos.
 */
import fs from 'fs'; import path from 'path';
import type { AggRow } from '../../lib/kpi/replica';
const root = path.join(__dirname, '..', '..');
for (const l of fs.readFileSync(path.join(root, '.env.local'), 'utf-8').split('\n')) { const t = l.trim(); if (!t || t.startsWith('#')) continue; const e = t.indexOf('='); if (e < 0) continue; const k = t.slice(0, e).trim(); if (!process.env[k]) process.env[k] = t.slice(e + 1).trim().replace(/^"|"$/g, ''); }

type Grain = 'day' | 'week' | 'month' | 'quarter' | 'year';
type Getter = (k: Record<string, number | null>, a: Record<string, number>) => number | null;
const kpi = (key: string): Getter => (k) => k[key];
const raw = (key: string): Getter => (_k, a) => a[key];
const H: Record<string, Getter> = {};
for (const [names, g] of [
  [['spend', 'sum of spend'], kpi('spend')], [['signups'], kpi('signups')], [['CPNU'], kpi('cpnu')],
  [['New Subs'], kpi('newSubs')], [['CAC'], kpi('cac')], [['C.R.', 'Conversion Rate'], kpi('conversionRate')],
  [['FTS', 'fts_started'], kpi('ftsStarted')], [['CPFT'], kpi('cpft')], [['NS Sales'], kpi('nsSales')], [['New subs $'], raw('new_subscriptions_sales')],
  [['NS mgn', 'New Subs Margin', 'New subs man'], kpi('newSubsMargin')], [['ARPU'], kpi('arpu')],
  [['1stTkt/CAC', '1st Ticket / CAC'], kpi('firstTicketCac')], [['Cont mbl', 'MOBILE CONTRIBUTION MARGIN'], kpi('mobileCm')],
  [['Cont. Tot', 'TOTAL CONTRIBUTION'], kpi('totalContribution')],
  [['CM/Sales', 'Cont. Mgn / Sales', 'contmgn/sales'], kpi('contributionMarginPct')],
  [['Total Sales (refactor) with yearly ios'], kpi('totalSales')], [['Total Renewal Sales'], kpi('totalRenewalSales')],
  [['Net Sales (refactor) with yearly ios'], kpi('netSales')], [['renewals'], raw('renewals')], [['renewals_yearly_ios'], raw('renewals_yearly_ios')],
  [['renewals_sales'], raw('renewals_sales')], [['renewals_sales_yearly_ios'], raw('renewals_sales_yearly_ios')],
  [['fts_converted'], kpi('ftsConverted')], [["Purchases (non FT's)"], kpi('purchasesNonFtLooker')],
  [['Conv. from FT'], kpi('convFromFt')], [['Conv. from Purchases'], kpi('convFromPurchases')],
  [['Sales / Spend'], kpi('salesOverSpend')], [['New Sales / Spend'], kpi('newSalesOverSpend')], [['New Sales / Spend (mensual)'], (_k, a) => a.spend ? a.new_subscriptions_sales / a.spend : null], [['downloads'], kpi('downloads')],
] as Array<[string[], Getter]>) for (const n of names) H[n] = g;

const add = (p: string, g: Grain) => { const x = new Date(p + 'T00:00:00Z'); if (g === 'day') x.setUTCDate(x.getUTCDate() + 1); else if (g === 'week') x.setUTCDate(x.getUTCDate() + 7); else if (g === 'month') x.setUTCMonth(x.getUTCMonth() + 1); else if (g === 'quarter') x.setUTCMonth(x.getUTCMonth() + 3); else x.setUTCFullYear(x.getUTCFullYear() + 1); return x.toISOString().slice(0, 10); };
const between = (a: string, b: string, g: Grain) => { const [s, e] = a < b ? [a, b] : [b, a]; const out: string[] = []; for (let p = s; p <= e; p = add(p, g)) out.push(p); return out; };

(async () => {
  const { fetchAgg, computeKpis } = await import(root + '/lib/kpi/replica');
  const file = process.argv[2]; if (!file) throw new Error('uso: npx tsx scripts/looker-parity/compare.ts <digest.json>');
  const digest = JSON.parse(fs.readFileSync(file, 'utf-8'));
  let cols = 0, ok = 0; const out: string[] = [];
  for (const d of digest) {
    const g = d.g as Grain; const end = d.r[1];
    // "Cont / Spend by Month" tiene rango propio desde el 7-jul-2025 (no usa el filtro de la página).
    const pageStart = d.t === 'Cont / Spend by Month' ? '2025-07-07' : d.r[0];
    const start = pageStart < '2024-01-01' ? '2024-01-01' : pageStart;
    const lines: string[] = [];
    for (const it of d.items) {
      if (it.k === 'block' && it.note) { lines.push(`  · sin comparar [${(it.head ?? []).join(', ')}]: ${it.note}`); continue; }
      if (it.k === 'dim') {
        // spend por valor de la dimensión, sumado en las semanas mostradas (15 de 16: probamos sin la 1ª o sin la última)
        const dow = (new Date(start + 'T00:00:00Z').getUTCDay() + 6) % 7;
        const nextMonday = new Date(Date.parse(start + 'T00:00:00Z') + (dow ? 7 - dow : 0) * 864e5).toISOString().slice(0, 10);
        const variants: Array<[string, string, string]> = [['todas', start, end], ['sin 1ª semana parcial', nextMonday, end]];
        // (Share of Spend) el Looker omite la primera semana parcial del rango.
        let best = ''; let bestOk = -1;
        for (const [name, s, e] of variants) {
          const rows = await fetchAgg({ start: s, end: e }, 'total', it.dim);
          const res = it.cols.map((c: { h: string; sum: number; tol: number }) => { const r = rows.find((x: AggRow) => x.grp === c.h); const v = r ? r.spend : 0; return { h: c.h, ok: Math.abs(v - c.sum) <= c.tol + 0.01, v, l: c.sum }; });
          const n = res.filter((x: { ok: boolean }) => x.ok).length;
          if (n > bestOk) { bestOk = n; best = `${name}: ${n}/${res.length}` + res.filter((x: { ok: boolean }) => !x.ok).map((x: { h: string; v: number; l: number }) => ` ✗ ${x.h} Looker ${x.l} · réplica ${x.v.toFixed(2)}`).join(''); }
        }
        cols += it.cols.length; ok += bestOk;
        lines.push(`  spend por ${it.dim} — ${best}`);
        continue;
      }
      const periods = between(it.periods[1], it.periods[2], g);
      if (periods.length !== it.periods[0]) { lines.push(`  ⚠ ${it.k}: ${it.periods[0]} filas pero ${periods.length} periodos entre ${it.periods[1]} y ${it.periods[2]}`); }
      const rows = await fetchAgg({ start, end }, g);
      const byP = new Map(rows.map((r: AggRow) => [r.period, r]));
      const res: string[] = [];
      for (const c of it.cols as Array<{ h: string; n: number; sum: number; tol: number }>) {
        // "New Sales / Spend" de las páginas mensuales del Looker usa ventas netas (ver docs/DIFERENCIAS-LOOKER.md).
        const monthlyNewSales = c.h === 'New Sales / Spend' && /monthly/i.test(d.t);
        const getter = it.note === 'cont/sales' && c.h === 'CM/Sales' ? kpi('contributionMarginPct') : monthlyNewSales ? H['New Sales / Spend (mensual)'] : H[c.h];
        if (!getter) { res.push(`${c.h}: sin mapeo`); continue; }
        let s = 0, n = 0;
        for (const p of periods) { const a = byP.get(p); if (!a) continue; const v = getter(computeKpis(a, 'looker') as unknown as Record<string, number | null>, a as unknown as Record<string, number>); if (v === null || v === undefined) continue; s += v; n++; }
        cols++;
        const good = Math.abs(s - c.sum) <= c.tol + Math.abs(c.sum) * 1e-9 + 0.01;
        if (good) ok++; else res.push(`✗ ${c.h}: Looker Σ=${c.sum} (±${c.tol}) · réplica Σ=${+s.toFixed(4)} (n ${c.n}/${n})`);
      }
      lines.push(`  ${it.k} ${periods[0]}→${periods[periods.length - 1]} [${it.cols.map((c: { h: string }) => c.h).join(', ')}] ${res.length ? '\n     ' + res.join('\n     ') : '✅'}`);
    }
    out.push(`· ${d.t}\n${lines.join('\n')}`);
  }
  console.log(out.join('\n'));
  console.log(`\nTOTAL columnas iguales: ${ok}/${cols}`);
})().catch((e) => { console.error(e); process.exit(1); });
