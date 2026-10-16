/**
 * Guardia de KPIs — auditor automático del KPI Bot y del dashboard Operativo.
 *
 * Corre cada hora (cron /api/cron/kpi-guard). Cada chequeo tiene un id estable; el resultado se guarda en
 * kpi_guard_runs y SOLO se avisa a Slack cuando un chequeo empeora (ok → aviso/alarma) o se recupera.
 * Qué valida (ver docs/AUDITORIA.md para el detalle y los umbrales):
 *
 *   frescura     BigQuery reconstruido < 26 h · réplica al día con BigQuery · tiendas sincronizadas
 *   réplica      réplica = BigQuery por día × OS (últimos 35 días) · resultado de la auto-reparación diaria
 *   fórmulas     los 31 KPIs del dashboard (lib/kpi/replica.ts) = los de BigQuery (lib/kpi/formulas.ts),
 *                vista Looker completa y Corregido sin montos, en 4 ventanas
 *   calibración  Corregido calibrado = lo que reportan Apple/Google/Stripe (últimas 4 semanas)
 *   tiendas      BigQuery (base Looker) vs tiendas: Apple ±4 %, Stripe ±5 %, Google en su banda conocida
 *   datos        días sin spend/signups/new subs · KPIs fuera de rangos posibles · downloads en cero
 *   página       el cargador de datos del dashboard responde sin error y a tiempo
 *
 * Lo que NO puede validar solo (no hay API del Looker): que el Looker original no haya cambiado. Eso lo
 * cubre la comparación semanal gráfica por gráfica (scripts/looker-parity, agente kpi-auditor).
 */
import { createServerClient } from '@/lib/supabase/server';
import { getBigQueryClient, KINEDU_OPERATIONAL_TABLE } from '@/lib/bigquery/client';
import { KPI_SQL } from '@/lib/kpi/formulas';
import { fetchAgg, sumAgg, computeKpis, fetchReplicaStatus, type KpiValues } from '@/lib/kpi/replica';
import { verifyKpiDaily, fetchBigQueryModified } from '@/lib/sync/kpi-daily';
import { addDays, todayMx, mondayOf } from '@/lib/kpi/period';
import { postToSlack } from '@/lib/slack/post';

export type GuardStatus = 'ok' | 'warn' | 'alarm';
export interface GuardCheck { id: string; area: string; status: GuardStatus; line: string; detail?: string }
export interface GuardRun { ranAt: string; status: GuardStatus; checks: GuardCheck[]; seconds: number }

const worst = (xs: GuardStatus[]): GuardStatus => (xs.includes('alarm') ? 'alarm' : xs.includes('warn') ? 'warn' : 'ok');
const icon = (s: GuardStatus) => (s === 'ok' ? '✅' : s === 'warn' ? '⚠️' : '🔴');
const pct = (a: number, b: number) => (b === 0 ? (a === 0 ? 0 : Infinity) : (a - b) / Math.abs(b));
const hoursSince = (iso: string | null) => (iso ? (Date.now() - Date.parse(iso)) / 3.6e6 : Infinity);

async function safe(id: string, area: string, fn: () => Promise<Omit<GuardCheck, 'id' | 'area'>>): Promise<GuardCheck> {
  try { return { id, area, ...(await fn()) }; }
  catch (e) { return { id, area, status: 'alarm', line: `no se pudo correr el chequeo: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}` }; }
}

// KPI_SQL key → [definición de la réplica, campo de KpiValues]. Los montos del Corregido calibrado se
// validan contra tiendas (chequeo calibración), no contra la fórmula de BigQuery.
const PARITY: Record<string, ['looker' | 'fixed', keyof KpiValues]> = {
  spend: ['looker', 'spend'], signups: ['looker', 'signups'], ftsStarted: ['looker', 'ftsStarted'], ftsConverted: ['looker', 'ftsConverted'],
  newSubs: ['looker', 'newSubs'], conversionRate: ['looker', 'conversionRate'], ftStartRate: ['looker', 'ftStartRate'],
  ftConversionRate: ['looker', 'ftConversionRate'], ftShare: ['looker', 'ftShare'], cac: ['looker', 'cac'], cpnu: ['looker', 'cpnu'],
  cpft: ['looker', 'cpft'], arpu: ['looker', 'arpu'], firstTicketCac: ['looker', 'firstTicketCac'], nsSales: ['looker', 'nsSales'],
  totalRenewalSales: ['looker', 'totalRenewalSales'], renewals: ['looker', 'renewals'], totalSales: ['looker', 'totalSales'],
  refundsAmount: ['looker', 'refundsAmount'], refundsCount: ['looker', 'refundsCount'], newSubsMargin: ['looker', 'newSubsMargin'],
  netSalesLooker: ['looker', 'netSales'], mobileCmLooker: ['looker', 'mobileCm'], totalContributionLooker: ['looker', 'totalContribution'],
  contributionMarginPctLooker: ['looker', 'contributionMarginPct'], purchasesNonFtLooker: ['looker', 'purchasesNonFtLooker'],
  purchasesNonFt: ['fixed', 'purchasesNonFt'],
};

async function formulaParity(): Promise<Omit<GuardCheck, 'id' | 'area'>> {
  const today = todayMx(); const y = addDays(today, -1);
  const lastMonthEnd = addDays(today.slice(0, 8) + '01', -1);
  const windows: Array<[string, string, string]> = [
    ['ayer', y, y], ['7 días', addDays(today, -7), y], ['mes en curso', today.slice(0, 8) + '01', y], ['mes pasado', lastMonthEnd.slice(0, 8) + '01', lastMonthEnd],
  ];
  const bq = getBigQueryClient();
  const sel = Object.keys(PARITY).map((k) => `${KPI_SQL[k as keyof typeof KPI_SQL]} AS ${k}`).join(',\n');
  const bad: string[] = []; let cells = 0;
  for (const [name, s, e] of windows) {
    if (s > e) continue;
    const [rows] = await bq.query({ query: `SELECT ${sel} FROM ${KINEDU_OPERATIONAL_TABLE} WHERE date BETWEEN @s AND @e`, params: { s, e } });
    const b = (rows as Record<string, unknown>[])[0] ?? {};
    const agg = sumAgg(await fetchAgg({ start: s, end: e }, 'total'));
    const k = { looker: computeKpis(agg, 'looker'), fixed: computeKpis(agg, 'fixed') };
    for (const [key, [def, field]] of Object.entries(PARITY)) {
      const a = Number(b[key] ?? 0); const r = Number((k[def][field] as number | null) ?? 0); cells++;
      const tol = Math.abs(a) < 10 ? 0.0005 : Math.max(0.05, Math.abs(a) * 1e-6);
      if (Math.abs(a - r) > tol) bad.push(`${name} · ${key}: BigQuery ${+a.toFixed(4)} · dashboard ${+r.toFixed(4)}`);
    }
  }
  // Una diferencia aquí suele ser datos que cambiaron entre la lectura de BigQuery y la de la réplica (dbt
  // reconstruyó en medio). Si persiste en la siguiente corrida es un cambio de fórmula: alarma.
  return bad.length
    ? { status: bad.length > 3 ? 'alarm' : 'warn', line: `Fórmulas: ${bad.length} de ${cells} KPIs del dashboard no igualan a BigQuery`, detail: bad.slice(0, 8).join('\n') }
    : { status: 'ok', line: `Fórmulas: ${cells} KPIs × ventana iguales a BigQuery (vista Looker completa + Corregido sin montos)` };
}

async function replicaDays(): Promise<Omit<GuardCheck, 'id' | 'area'>> {
  const today = todayMx();
  const v = await verifyKpiDaily(addDays(today, -35), addDays(today, -1));
  return v.badDates.length
    ? { status: v.badDates.length > 5 ? 'alarm' : 'warn', line: `Réplica: ${v.badDates.length} de ${v.days} días difieren de BigQuery (día × OS); la auto-reparación los corrige en el siguiente sync`, detail: v.mismatches.slice(0, 6).map((m) => `${m.date} ${m.os} ${m.field}: BQ ${m.bq} · réplica ${m.replica}`).join('\n') }
    : { status: 'ok', line: `Réplica = BigQuery en los últimos ${v.days} días (día × OS, 16 campos)` };
}

async function freshness(): Promise<Omit<GuardCheck, 'id' | 'area'>> {
  const sb = createServerClient();
  const bqMod = await fetchBigQueryModified();
  const { data: last } = await sb.from('sync_log').select('completed_at,details').eq('source', 'kpi_daily').eq('status', 'success').order('started_at', { ascending: false }).limit(1);
  const l = (last ?? [])[0] as { completed_at: string; details: { bqModified?: string } | null } | undefined;
  const lag = bqMod && l?.details?.bqModified ? (Date.parse(bqMod) - Date.parse(l.details.bqModified)) / 6e4 : null;
  const bqAge = hoursSince(bqMod);
  const parts = [`BigQuery reconstruido hace ${bqAge.toFixed(1)} h`, lag === null ? 'réplica sin marca de versión' : lag <= 0 ? 'réplica al día' : `réplica ${Math.round(lag)} min atrás`];
  const st: GuardStatus = bqAge > 26 ? 'alarm' : lag !== null && lag > 180 ? 'alarm' : lag !== null && lag > 60 ? 'warn' : 'ok';
  return { status: st, line: `Frescura: ${parts.join(' · ')}` };
}

async function storesFresh(): Promise<Omit<GuardCheck, 'id' | 'area'>> {
  const sb = createServerClient();
  const today = todayMx();
  const { data, error } = await sb.rpc('store_coverage', { p_from: addDays(today, -40) });
  if (error) return { status: 'warn', line: 'Tiendas: store_daily no disponible (falta la migración 037)' };
  const rows = (data ?? []) as Array<{ store: string; date: string; status: string }>;
  const lastFinal = (s: string) => rows.filter((r) => r.store === s && r.status === 'final').map((r) => String(r.date)).sort().pop() ?? null;
  const a = lastFinal('apple'), g = lastFinal('google'), s = lastFinal('stripe');
  const lagDays = (d: string | null) => (d ? Math.round((Date.parse(today) - Date.parse(d)) / 864e5) : 99);
  // Apple publica con 1–2 días; Google cierra el mes con el earnings (~día 5 del mes siguiente); Stripe es inmediato.
  const googleExpected = Number(today.slice(8, 10)) > 8 ? addDays(today.slice(0, 8) + '01', -1) : addDays(addDays(today.slice(0, 8) + '01', -1).slice(0, 8) + '01', -1);
  const st = worst([lagDays(a) > 3 ? 'warn' : 'ok', !g || g < googleExpected ? 'warn' : 'ok', lagDays(s) > 1 ? 'warn' : 'ok']);
  return { status: st, line: `Tiendas: definitivo hasta Apple ${a ?? '—'} · Google ${g ?? '—'} · Stripe ${s ?? '—'}` };
}

/** Corregido calibrado vs lo que reportan las tiendas, últimas 4 semanas completas, por procesador. */
async function calibrationVsStores(): Promise<Omit<GuardCheck, 'id' | 'area'>> {
  const sb = createServerClient();
  const today = todayMx();
  const end = addDays(mondayOf(today), -1); const start = addDays(end, -27);
  const rows = await fetchAgg({ start, end }, 'total', 'payment_processor');
  if (!rows.some((r) => r.cal_gross !== 0)) return { status: 'warn', line: 'Calibración: inactiva (falta la migración 037 o el backfill de store_daily)' };
  const store: Record<string, { paid: number; net: number }> = {};
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('store_daily').select('store,paid_usd,net_usd,refunds_paid_usd,refunds_net_usd').gte('date', start).lte('date', end).range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) { const x = (store[r.store] ??= { paid: 0, net: 0 }); x.paid += Number(r.paid_usd) - Number(r.refunds_paid_usd); x.net += Number(r.net_usd) - Number(r.refunds_net_usd); }
    if (!data || data.length < 1000) break;
  }
  const lines: string[] = []; const sts: GuardStatus[] = [];
  for (const pp of ['apple', 'google', 'stripe']) {
    const r = rows.find((x) => x.grp === pp); const s = store[pp];
    if (!r || !s) { lines.push(`${pp}: sin datos`); sts.push('warn'); continue; }
    const calPaid = r.cal_gross - r.cal_ref_gross; const calNet = r.cal_net - r.cal_ref_net;
    const dp = pct(calPaid, s.paid), dn = pct(calNet, s.net);
    // Los factores usan ventanas de 7 días: en 4 semanas el total debe quedar dentro de ±3 %.
    const st: GuardStatus = Math.abs(dp) > 0.08 || Math.abs(dn) > 0.08 ? 'alarm' : Math.abs(dp) > 0.03 || Math.abs(dn) > 0.03 ? 'warn' : 'ok';
    sts.push(st);
    lines.push(`${pp} cobrado ${(dp * 100).toFixed(1)} % · neto ${(dn * 100).toFixed(1)} % ${icon(st)}`);
  }
  return { status: worst(sts), line: `Calibración vs tiendas (${start} → ${end}): ${lines.join(' · ')}` };
}

/** BigQuery en base Looker vs tiendas — la misma lógica de la auditoría diaria, sobre store_daily (barato). */
async function lookerVsStores(): Promise<Omit<GuardCheck, 'id' | 'area'>> {
  const sb = createServerClient();
  const today = todayMx();
  const end = addDays(today, -3); const start = addDays(end, -6);   // Apple publica con 1–2 días
  const rows = await fetchAgg({ start, end }, 'total', 'payment_processor');
  const store: Record<string, number> = {};
  const { data, error } = await sb.from('store_daily').select('store,paid_usd').gte('date', start).lte('date', end).limit(5000);
  if (error) return { status: 'warn', line: 'Tiendas vs Looker: store_daily no disponible (falta la migración 037)' };
  for (const r of data ?? []) store[r.store] = (store[r.store] ?? 0) + Number(r.paid_usd);
  const parts: string[] = []; const sts: GuardStatus[] = [];
  for (const [pp, warnAt, alarmAt] of [['apple', 0.04, 0.08], ['stripe', 0.05, 0.1]] as const) {
    const r = rows.find((x) => x.grp === pp); const gross = r ? r.new_subscriptions_sales + r.refunds_total_amount_sale_date + r.renewals_sales + r.renewals_sales_yearly_ios + r.other_sales : 0;
    const d = pct(gross, store[pp] ?? 0); const st: GuardStatus = Math.abs(d) > alarmAt ? 'alarm' : Math.abs(d) > warnAt ? 'warn' : 'ok';
    sts.push(st); parts.push(`${pp} ${(d * 100).toFixed(1)} % ${icon(st)}`);
  }
  const g = rows.find((x) => x.grp === 'google'); const gg = g ? g.new_subscriptions_sales + g.refunds_total_amount_sale_date + g.renewals_sales + g.renewals_sales_yearly_ios + g.other_sales : 0;
  const ratio = store.google ? gg / store.google : 0;
  // Patrón conocido (impuesto + FX): Looker 3–22 % arriba de lo cobrado por Google. Fuera de la banda = algo cambió.
  const gst: GuardStatus = ratio >= 1.03 && ratio <= 1.22 ? 'ok' : ratio > 0.97 && ratio < 1.03 ? 'ok' : 'warn';
  sts.push(gst); parts.push(`google ${((ratio - 1) * 100).toFixed(1)} % ${gst === 'ok' ? '⏳ patrón conocido' : '⚠️ fuera del patrón'}`);
  return { status: worst(sts), line: `BigQuery (base Looker) vs tiendas ${start} → ${end}: ${parts.join(' · ')}` };
}

async function dataInvariants(): Promise<Omit<GuardCheck, 'id' | 'area'>> {
  const today = todayMx();
  const days = await fetchAgg({ start: addDays(today, -30), end: addDays(today, -1) }, 'day');
  const holes = days.filter((d) => d.spend <= 0 || d.signups <= 0 || d.new_subscriptions <= 0).map((d) => d.period);
  const missing = 30 - days.length;
  const y = days[days.length - 1]; const k = y ? computeKpis(y, 'looker') : null;
  const out: string[] = [];
  if (k) {
    if (k.cac !== null && (k.cac < 5 || k.cac > 80)) out.push(`CAC ayer $${k.cac.toFixed(2)} fuera de [$5, $80]`);
    if (k.conversionRate !== null && (k.conversionRate < 0.01 || k.conversionRate > 0.3)) out.push(`C.R. ayer ${(k.conversionRate * 100).toFixed(1)} % fuera de [1 %, 30 %]`);
    if (k.contributionMarginPct !== null && Math.abs(k.contributionMarginPct) > 1) out.push(`CM/Sales ayer ${(k.contributionMarginPct * 100).toFixed(0)} % fuera de ±100 %`);
    if (k.refundsAmount > k.totalSales + k.refundsAmount) out.push('reembolsos mayores que las ventas');
  }
  const zeroDl = days.filter((d) => d.downloads === 0).length;
  const st: GuardStatus = holes.length || missing > 0 ? 'alarm' : out.length ? 'warn' : 'ok';
  const known = zeroDl ? ` · downloads en 0 en ${zeroDl} de 30 días (problema conocido de la fuente, pendiente con tech)` : '';
  return { status: st, line: `Datos: ${missing > 0 ? `${missing} días sin filas · ` : ''}${holes.length ? `días sin spend/signups/new subs: ${holes.join(', ')} · ` : ''}${out.length ? out.join(' · ') : 'rangos de KPIs normales'}${known}` };
}

async function pageHealth(): Promise<Omit<GuardCheck, 'id' | 'area'>> {
  const t0 = Date.now(); const today = todayMx();
  const f = { start: addDays(today, -30), end: addDays(today, -1) };
  await Promise.all([fetchAgg(f, 'day'), fetchAgg(f, 'total'), ...(['os', 'country', 'kinedu_language', 'kinedu_region'] as const).flatMap((g) => [fetchAgg(f, 'total', g), fetchAgg(f, 'day', g)]), fetchReplicaStatus()]);
  const s = (Date.now() - t0) / 1000;
  return { status: s > 15 ? 'alarm' : s > 6 ? 'warn' : 'ok', line: `Dashboard: las 11 consultas de la vista por default responden en ${s.toFixed(1)} s` };
}

export async function runKpiGuard(): Promise<GuardRun> {
  const t0 = Date.now();
  const checks = await Promise.all([
    safe('frescura.bigquery', 'Frescura', freshness),
    safe('frescura.tiendas', 'Frescura', storesFresh),
    safe('replica.dias', 'Réplica', replicaDays),
    safe('formulas.paridad', 'Fórmulas', formulaParity),
    safe('calibracion.tiendas', 'Calibración', calibrationVsStores),
    safe('tiendas.looker', 'Tiendas', lookerVsStores),
    safe('datos.invariantes', 'Datos', dataInvariants),
    safe('pagina.salud', 'Página', pageHealth),
  ]);
  return { ranAt: new Date().toISOString(), status: worst(checks.map((c) => c.status)), checks, seconds: Math.round((Date.now() - t0) / 100) / 10 };
}

/** Guarda la corrida y avisa a Slack solo si algún chequeo cambió de estado (o sigue en alarma 24 h después). */
export async function recordAndAlert(run: GuardRun, opts: { post?: boolean } = {}): Promise<{ alerted: boolean; changes: string[] }> {
  const sb = createServerClient();
  const { data: prev, error: prevErr } = await sb.from('kpi_guard_runs').select('checks,ran_at,alerted').order('ran_at', { ascending: false }).limit(1);
  // Sin la tabla (migración 037) no hay memoria del estado anterior: no avisar para no repetir cada hora.
  if (prevErr) return { alerted: false, changes: [] };
  const prevChecks = new Map(((prev?.[0]?.checks ?? []) as GuardCheck[]).map((c) => [c.id, c.status]));
  const rank = { ok: 0, warn: 1, alarm: 2 } as const;
  const changes: string[] = [];
  for (const c of run.checks) {
    const p = prevChecks.get(c.id) ?? 'ok';
    if (rank[c.status] > rank[p]) changes.push(`${icon(c.status)} ${c.line}${c.detail ? `\n   ↳ ${c.detail.split('\n').slice(0, 3).join('\n   ↳ ')}` : ''}`);
    else if (rank[c.status] < rank[p] && c.status === 'ok') changes.push(`✅ recuperado — ${c.line}`);
  }
  // Recordatorio diario si sigue habiendo alarmas.
  const { data: lastAlert } = await sb.from('kpi_guard_runs').select('ran_at').eq('alerted', true).order('ran_at', { ascending: false }).limit(1);
  const stale = run.status === 'alarm' && hoursSince(lastAlert?.[0]?.ran_at ?? null) > 24;
  if (stale && !changes.length) changes.push(...run.checks.filter((c) => c.status === 'alarm').map((c) => `🔴 sigue en alarma — ${c.line}`));
  const alerted = changes.length > 0 && opts.post !== false;
  if (alerted) {
    const head = `🛡️ Guardia KPIs — ${run.status === 'ok' ? 'todo recuperado' : `${run.checks.filter((c) => c.status !== 'ok').length} chequeo(s) con problema`}`;
    await postToSlack({ text: head, blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*${head}*` } },
      { type: 'section', text: { type: 'mrkdwn', text: changes.join('\n').slice(0, 2900) } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: '_Auditor automático (cada hora). Detalle en el dashboard Operativo → Auditoría · método en docs/AUDITORIA.md_' }] },
    ] });
  }
  await sb.from('kpi_guard_runs').insert({ ran_at: run.ranAt, status: run.status, checks: run.checks, alerted, seconds: run.seconds });
  return { alerted, changes };
}

/** Una línea para el mensaje diario de la auditoría de tiendas. */
export async function lastGuardSummary(): Promise<string | null> {
  const { data } = await createServerClient().from('kpi_guard_runs').select('ran_at,status,checks').order('ran_at', { ascending: false }).limit(1);
  const r = data?.[0] as { ran_at: string; status: GuardStatus; checks: GuardCheck[] } | undefined;
  if (!r) return null;
  const okN = r.checks.filter((c) => c.status === 'ok').length;
  return `Guardia KPIs: ${okN}/${r.checks.length} chequeos ${icon(r.status)}${r.status === 'ok' ? '' : ` — ${r.checks.filter((c) => c.status !== 'ok').map((c) => c.area).join(', ')}`}`;
}
