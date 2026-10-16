import { Storage } from '@google-cloud/storage';
import { unzipSync } from 'fflate';
import Stripe from 'stripe';
import { createServerClient } from '@/lib/supabase/server';
import { getBigQueryClient, KINEDU_OPERATIONAL_TABLE } from '@/lib/bigquery/client';
import { STRIPE_REFUND_GAP_SQL } from '@/lib/kpi/formulas';
import { addDays, todayMx, dayShortEs, rangeShortEs } from '@/lib/kpi/period';
import type { SlackMessage } from '@/lib/slack/post';

/**
 * Daily store audit — stores vs Looker (an_operational_dash), last 7 days.
 *
 *   Apple  : App Store Connect daily sales (Supabase `apple_sales_daily`, synced by the daily cron)
 *   Google : Play Console "estimated sales" report in GCS (`sales/salesreport_YYYYMM.zip`), converted
 *            with Google's own conversion rates (from the latest earnings report)
 *   Stripe : balance transactions from the Stripe API (MX days)
 *   Looker : gross sales / counts / refunds by payment_processor, table freshness, and the
 *            Stripe double-count factor in TOTAL CONTRIBUTION (goes to ~1.0x once tech fixes it)
 *
 * Output: a list of checks with a status and a 5-line Slack message. Method and
 * thresholds mirror the manual reconciliation of 2026-10-13 (docs/KPI-SOURCES.md).
 */

export type Status = 'ok' | 'warn' | 'alarm' | 'info';
export interface Check { store: string; status: Status; line: string; detail?: string }
export interface AuditResult { date: string; window: { start: string; end: string }; status: Status; checks: Check[]; message: SlackMessage; text: string }

// ---- Thresholds (cumulative over the window; single days are noisy by design) ----
const APPLE_WARN = 0.04, APPLE_ALARM = 0.08;
const STRIPE_WARN = 0.05, STRIPE_ALARM = 0.10;
const COUNT_WARN = 0.10;
/** Google's Looker figure runs structurally above Play's charged amount (tax + FX). Alert only outside this band. */
const GOOGLE_BAND: [number, number] = [1.03, 1.22];
const FRESH_MAX_HOURS = 20;
const DOUBLE_COUNT_FIXED_BELOW = 1.05;

// ---- Small helpers ------------------------------------------------------------------
const num = (v: unknown): number => { const raw = typeof v === 'object' && v !== null && 'value' in v ? (v as { value: unknown }).value : v; const n = Number(raw); return Number.isFinite(n) ? n : 0; };
const money = (v: number) => `$${Math.round(v).toLocaleString('en-US')}`;
const k = (v: number) => Math.abs(v) >= 10_000 ? `$${(v / 1000).toFixed(1)}K` : money(v);
const pct = (a: number, b: number) => (a === 0 ? null : (b - a) / a);
const fpct = (p: number | null) => (p === null ? 'n/d' : `${p >= 0 ? '+' : '−'}${Math.abs(p * 100).toFixed(1)}%`);
const icon = (s: Status) => (s === 'ok' ? '✅' : s === 'warn' ? '⚠️' : s === 'alarm' ? '🔴' : 'ℹ️');
const worst = (xs: Status[]): Status => (xs.includes('alarm') ? 'alarm' : xs.includes('warn') ? 'warn' : xs.includes('info') ? 'info' : 'ok');

export function parseCsv(txt: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], f = '', q = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (q) { if (c === '"') { if (txt[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

// ---- Apple ------------------------------------------------------------------------
interface DayAgg { gross: number; n: number; refunds: number; refundN: number }
const empty = (): DayAgg => ({ gross: 0, n: 0, refunds: 0, refundN: 0 });

export async function fetchAppleFx(): Promise<(cur: string, ym: string) => number> {
  const sb = createServerClient();
  const { data } = await sb.from('apple_fx_rates').select('year_month,currency,rate');
  const map = new Map<string, number>();
  for (const r of data ?? []) map.set(`${r.year_month}|${r.currency}`, Number(r.rate));
  return (cur, ym) => (cur === 'USD' ? 1 : map.get(`${ym}|${cur}`) ?? map.get(`default|${cur}`) ?? 1);
}

export async function fetchAppleDaily(start: string, end: string): Promise<{ days: Record<string, DayAgg>; maxDate: string | null }> {
  const sb = createServerClient();
  const fx = await fetchAppleFx();
  const days: Record<string, DayAgg> = {};
  let last = 0, maxDate: string | null = null;
  for (;;) {
    const { data, error } = await sb.from('apple_sales_daily')
      .select('id,begin_date,units,customer_price,customer_currency')
      .gte('begin_date', start).lte('begin_date', end).gt('id', last).order('id').limit(1000);
    if (error) throw new Error(`apple_sales_daily: ${error.message}`);
    if (!data?.length) break;
    for (const r of data) {
      last = r.id;
      const d = String(r.begin_date); const price = Number(r.customer_price) || 0; const units = Number(r.units) || 0;
      if (!maxDate || d > maxDate) maxDate = d;
      if (price === 0) continue;
      const x = (days[d] ??= empty());
      const usd = (price * units) / fx(String(r.customer_currency), d.slice(0, 7));
      if (units > 0) { x.gross += usd; x.n += units; } else { x.refunds += Math.abs(usd); x.refundN += Math.abs(units); } // refund rows carry negative units AND price
    }
    if (data.length < 1000) break;
  }
  return { days, maxDate };
}

// ---- Google ---------------------------------------------------------------------------
export function gcs() {
  const creds = JSON.parse(Buffer.from(process.env.GCP_SERVICE_ACCOUNT_KEY_B64!, 'base64').toString('utf-8'));
  return new Storage({ credentials: creds }).bucket(process.env.GOOGLE_PLAY_BUCKET!);
}

export async function downloadCsvFromZip(name: string): Promise<string[][]> {
  const [buf] = await gcs().file(name).download();
  const entries = unzipSync(new Uint8Array(buf));
  const csv = Object.keys(entries).find((n) => n.toLowerCase().endsWith('.csv'));
  if (!csv) throw new Error(`zip sin CSV: ${name}`);
  return parseCsv(Buffer.from(entries[csv]).toString('utf-8'));
}

/** Google's own buyer-currency → USD rates from the latest earnings report (median per currency). */
export async function fetchGoogleFx(): Promise<Record<string, number>> {
  const [files] = await gcs().getFiles({ prefix: 'earnings/' });
  const names = files.map((f) => f.name).filter((n) => /earnings_\d{6}/.test(n)).sort();
  if (!names.length) return {};
  const rows = await downloadCsvFromZip(names[names.length - 1]);
  const hdr = rows[0]; const iC = hdr.findIndex((h) => /^buyer currency/i.test(h)); const iR = hdr.findIndex((h) => /currency conversion rate/i.test(h));
  const by: Record<string, number[]> = {};
  for (const r of rows.slice(1)) { const c = r[iC]; const rate = parseFloat(r[iR]); if (c && rate) (by[c] ??= []).push(rate); }
  const out: Record<string, number> = {};
  for (const [c, arr] of Object.entries(by)) { arr.sort((a, b) => a - b); out[c] = arr[Math.floor(arr.length / 2)]; }
  return out;
}

export async function fetchGoogleDaily(start: string, end: string): Promise<{ days: Record<string, DayAgg & { item: number }>; months: string[] }> {
  const gfx = await fetchGoogleFx();
  const afx = await fetchAppleFx();
  const toUsd = (cur: string, amt: number, ym: string) => (cur === 'USD' ? amt : gfx[cur] ? amt * gfx[cur] : amt / afx(cur, ym));
  const months = Array.from(new Set([start.slice(0, 7).replace('-', ''), end.slice(0, 7).replace('-', '')]));
  const days: Record<string, DayAgg & { item: number }> = {};
  for (const ym of months) {
    let rows: string[][];
    try { rows = await downloadCsvFromZip(`sales/salesreport_${ym}.zip`); } catch { continue; }
    const hdr = rows[0];
    const col = (re: RegExp) => hdr.findIndex((h) => re.test(h));
    const iDate = col(/charged date/i), iStatus = col(/financial status/i), iCur = col(/currency of sale/i), iItem = col(/^item price/i), iCharged = col(/charged amount/i);
    for (const r of rows.slice(1)) {
      const d = (r[iDate] || '').slice(0, 10);
      if (!d || d < start || d > end) continue;
      const x = (days[d] ??= { ...empty(), item: 0 });
      const st = (r[iStatus] || '').toLowerCase(); const cur = r[iCur] || 'USD'; const ym2 = d.slice(0, 7);
      const chg = parseFloat(r[iCharged]) || 0, item = parseFloat(r[iItem]) || 0;
      if (st.startsWith('charged')) { x.n++; x.gross += toUsd(cur, chg, ym2); x.item += toUsd(cur, item, ym2); }
      else if (st.startsWith('refund')) { x.refundN++; x.refunds += Math.abs(toUsd(cur, chg || item, ym2)); }
    }
  }
  return { days, months };
}

// ---- Stripe ---------------------------------------------------------------------------
export async function fetchStripeDaily(start: string, end: string): Promise<Record<string, DayAgg & { fee: number }>> {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
  const gte = Math.floor(Date.parse(`${start}T06:00:00Z`) / 1000);
  const lt = Math.floor(Date.parse(`${end}T06:00:00Z`) / 1000) + 86400;
  const mxDay = (ts: number) => new Date((ts - 6 * 3600) * 1000).toISOString().slice(0, 10);
  const days: Record<string, DayAgg & { fee: number }> = {};
  let startingAfter: string | undefined;
  for (;;) {
    const page = await stripe.balanceTransactions.list({ created: { gte, lt }, limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) });
    for (const bt of page.data) {
      const d = mxDay(bt.created); const x = (days[d] ??= { ...empty(), fee: 0 });
      if (bt.type === 'charge' || bt.type === 'payment') { x.n++; x.gross += bt.amount / 100; x.fee += bt.fee / 100; }
      else if (bt.type === 'refund' || bt.type === 'payment_refund') { x.refundN++; x.refunds += -bt.amount / 100; }
    }
    if (!page.has_more || !page.data.length) break;
    startingAfter = page.data[page.data.length - 1].id;
  }
  return days;
}

// ---- Looker / BigQuery ----------------------------------------------------------------
interface LookerDay { gross: number; n: number; refunds: number; refundN: number }
interface LookerDaily { byPp: Record<string, Record<string, LookerDay>>; tc: Record<string, { stripeTerm: number; refundGap: number }>; freshness: string | null }

export async function fetchLookerDaily(start: string, end: string): Promise<LookerDaily> {
  const bq = getBigQueryClient();
  const [rows] = await bq.query({
    query: `
      SELECT CAST(date AS STRING) d, payment_processor pp,
        SUM(new_subscriptions_sales) + SUM(refunds_total_amount_sale_date) + SUM(renewals_sales) + SUM(renewals_sales_yearly_ios) + SUM(other_sales) AS gross,
        SUM(new_subscriptions) + SUM(num_of_refunds_sale_date) + SUM(renewals) + SUM(renewals_yearly_ios) AS n,
        SUM(refunds_total_amount_refund_date) AS refunds, SUM(num_of_refunds_refund_date) AS refund_n
      FROM ${KINEDU_OPERATIONAL_TABLE}
      WHERE date BETWEEN @start AND @end AND payment_processor IN ('apple','google','stripe')
      GROUP BY d, pp`,
    params: { start, end },
  });
  const byPp: LookerDaily['byPp'] = { apple: {}, google: {}, stripe: {} };
  for (const r of rows as Record<string, unknown>[]) byPp[String(r.pp)][String(r.d)] = { gross: num(r.gross), n: num(r.n), refunds: num(r.refunds), refundN: num(r.refund_n) };

  // Stripe dentro de Net Sales (Variante 2, en el Looker desde 2026-10-15): un solo término al 0.965.
  // refund_gap = reembolsos de Stripe por fecha de venta × 0.965 que el Looker resta dos veces.
  const [tcRows] = await bq.query({
    query: `
      SELECT CAST(date AS STRING) d,
        (SUM(IF(payment_processor = "stripe", new_subscriptions_sales, 0)) + SUM(IF(payment_processor = "stripe", renewals_sales, 0))) * 0.965
          + SUM(IF(payment_processor = "stripe", other_sales, 0)) * 0.97
          + SUM(IF(payment_processor = "stripe", renewals_sales_yearly_ios, 0)) * 0.85 AS stripe_term,
        ${STRIPE_REFUND_GAP_SQL} AS refund_gap
      FROM ${KINEDU_OPERATIONAL_TABLE}
      WHERE date BETWEEN @start AND @end
      GROUP BY d`,
    params: { start, end },
  });
  const tc: LookerDaily['tc'] = {};
  for (const r of tcRows as Record<string, unknown>[]) tc[String(r.d)] = { stripeTerm: num(r.stripe_term), refundGap: num(r.refund_gap) };

  let freshness: string | null = null;
  try {
    const [f] = await bq.query({ query: `SELECT TIMESTAMP_MILLIS(last_modified_time) AS lm FROM \`celtic-music-240111.dbt_prod_analytics.__TABLES__\` WHERE table_id = 'an_operational_dash'` });
    const lm = (f as Record<string, unknown>[])[0]?.lm;
    freshness = lm ? (typeof lm === 'object' && lm && 'value' in lm ? String((lm as { value: string }).value) : String(lm)) : null;
  } catch { /* optional */ }
  return { byPp, tc, freshness };
}

// ---- Audit ------------------------------------------------------------------------------
function sumDays<T extends DayAgg>(days: Record<string, T>, from: string, to: string, key: keyof T): number {
  let t = 0; for (const [d, v] of Object.entries(days)) if (d >= from && d <= to) t += Number(v[key] ?? 0); return t;
}
function sumLooker(days: Record<string, LookerDay>, from: string, to: string, key: keyof LookerDay): number {
  let t = 0; for (const [d, v] of Object.entries(days)) if (d >= from && d <= to) t += v[key]; return t;
}
/** Consecutive single-day deviations in the same direction beyond ±30 % — timing noise cancels, real gaps don't. */
function streak(storeDays: Record<string, DayAgg>, lookerDays: Record<string, LookerDay>, from: string, to: string): string | null {
  let prev = 0, run = 0; const bad: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const s = storeDays[d]?.gross ?? 0, l = lookerDays[d]?.gross ?? 0; const p = pct(s, l);
    const sign = p === null ? 0 : Math.abs(p) > 0.3 ? Math.sign(p) : 0;
    run = sign !== 0 && sign === prev ? run + 1 : sign !== 0 ? 1 : 0; prev = sign;
    if (run >= 2) bad.push(d);
  }
  return bad.length ? `desvíos > 30 % dos días seguidos en la misma dirección: ${bad.map((d) => dayShortEs(d)).join(', ')}` : null;
}

// ---- Réplica kpi_daily (sección Operativo del dashboard) ------------------------------
interface HealDetails { checkedDays?: number; badDays?: number; healedDays?: number; skipped?: string }
async function replicaCheck(today: string): Promise<Check> {
  const sb = createServerClient();
  const { data } = await sb.from('sync_log').select('status,completed_at,started_at,details').eq('source', 'kpi_daily').eq('sync_type', 'daily')
    .order('started_at', { ascending: false }).limit(1);
  const last = (data ?? [])[0] as { status: string; completed_at: string | null; started_at: string; details: { heal?: HealDetails; error?: string } | null } | undefined;
  if (!last) {
    // Sin bitácora (p. ej. antes de la migración 034): al menos reportar la frescura de la tabla.
    const { data: st } = await sb.rpc('kpi_daily_status');
    const synced = ((st ?? []) as Array<{ last_synced_at: string | null }>)[0]?.last_synced_at;
    if (!synced) return { store: 'Réplica', status: 'warn', line: 'Réplica dashboard: sin corridas del sync diario registradas' };
    const sMx = new Date(Date.parse(synced) - 6 * 3.6e6).toISOString();
    const ok = sMx.slice(0, 10) === today;
    return { store: 'Réplica', status: ok ? 'ok' : 'warn', line: `Réplica dashboard: sync ${sMx.slice(5, 16).replace('T', ' ')} MX${ok ? '' : ' (no es de hoy)'} · sin detalle de verificación (bitácora no disponible) ${icon(ok ? 'ok' : 'warn')}` };
  }
  const when = last.completed_at ?? last.started_at;
  const whenMx = new Date(Date.parse(when) - 6 * 3.6e6).toISOString().slice(5, 16).replace('T', ' ');
  const isToday = new Date(Date.parse(when) - 6 * 3.6e6).toISOString().slice(0, 10) === today;
  if (last.status !== 'success') return { store: 'Réplica', status: 'alarm', line: `Réplica dashboard: el sync de ${whenMx} MX falló — ${String(last.details?.error ?? last.status).slice(0, 160)}` };
  const h = last.details?.heal ?? {};
  const pending = Math.max(0, (h.badDays ?? 0) - (h.healedDays ?? 0));
  const st: Status = !isToday ? 'warn' : pending > 0 || h.skipped ? 'warn' : 'ok';
  const healTxt = h.checkedDays
    ? `${h.checkedDays} días comparados con BigQuery · ${h.healedDays ?? 0} reparados · ${pending} pendientes`
    : `verificación omitida${h.skipped ? ` (${h.skipped})` : ''}`;
  return { store: 'Réplica', status: st, line: `Réplica dashboard: sync ${whenMx} MX${isToday ? '' : ' (no es de hoy)'} · ${healTxt} ${icon(st)}` };
}

export async function runStoreAudit(opts: { today?: string } = {}): Promise<AuditResult> {
  const today = opts.today ?? todayMx();
  const end = addDays(today, -1), start = addDays(end, -6);
  const [apple, google, stripe, looker] = await Promise.all([
    fetchAppleDaily(addDays(start, -3), end), fetchGoogleDaily(start, end), fetchStripeDaily(start, end), fetchLookerDaily(addDays(start, -3), end),
  ]);
  const checks: Check[] = [];

  // Apple — compare up to Apple's last published day (D-1 is usually not out yet at 10:00 MX)
  const aEnd = apple.maxDate && apple.maxDate < end ? apple.maxDate : end;
  const aStart = addDays(aEnd, -6);
  const aS = sumDays(apple.days, aStart, aEnd, 'gross'), aL = sumLooker(looker.byPp.apple, aStart, aEnd, 'gross');
  const aRs = sumDays(apple.days, aStart, aEnd, 'refunds'), aRl = sumLooker(looker.byPp.apple, aStart, aEnd, 'refunds');
  const aP = pct(aS, aL), aRp = pct(aRs, aRl);
  if (!apple.maxDate || apple.maxDate < addDays(end, -2)) {
    checks.push({ store: 'Apple', status: 'warn', line: `Apple: sin reporte de tienda desde ${apple.maxDate ? dayShortEs(apple.maxDate) : 'nunca'} (esperado hasta ${dayShortEs(addDays(end, -1))}) — revisar sync apple_sales_daily` });
  } else {
    const st: Status = aP === null ? 'warn' : Math.abs(aP) > APPLE_ALARM ? 'alarm' : Math.abs(aP) > APPLE_WARN ? 'warn' : 'ok';
    const rst: Status = aRp === null || Math.abs(aRp) > 0.15 ? 'warn' : 'ok';
    const sk = streak(apple.days, looker.byPp.apple, aStart, aEnd);
    checks.push({ store: 'Apple', status: worst([st, rst, sk ? 'warn' : 'ok']), line: `Apple (${rangeShortEs(aStart, aEnd)}): tienda ${k(aS)} · Looker ${k(aL)} · ${fpct(aP)} ${icon(st)} · refunds ${fpct(aRp)} ${icon(rst)} · último día publicado ${dayShortEs(aEnd)}`, detail: sk ?? undefined });
  }

  // Google — Looker is known to run above Play (tax-inclusive amount + a stronger FX).
  // Inside the known band → ⏳ pending fix (not OK); outside it → ⚠️ something else changed;
  // Looker ≈ Play price ex-tax at Google's FX (±5 %) → ✅ fix applied.
  const gS = sumDays(google.days, start, end, 'gross'), gI = sumDays(google.days, start, end, 'item'), gL = sumLooker(looker.byPp.google, start, end, 'gross');
  const gN = sumDays(google.days, start, end, 'n'), gNl = sumLooker(looker.byPp.google, start, end, 'n');
  const ratio = gS ? gL / gS : null; const ratioItem = gI ? gL / gI : null; const cN = pct(gN, gNl);
  if (!Object.keys(google.days).length) {
    checks.push({ store: 'Google', status: 'warn', line: `Google: no hay reporte diario de Play para ${rangeShortEs(start, end)} en el bucket (sales/salesreport_*.zip)` });
  } else {
    const fixed = ratioItem !== null && Math.abs(ratioItem - 1) <= 0.05;
    const inBand = ratio !== null && ratio >= GOOGLE_BAND[0] && ratio <= GOOGLE_BAND[1];
    const st: Status = fixed ? 'ok' : inBand ? 'info' : 'warn';
    const cst: Status = cN === null || Math.abs(cN) > COUNT_WARN ? 'warn' : 'ok';
    const verdict = fixed
      ? '✅ fix aplicado (Looker ≈ precio sin impuesto al FX de Google)'
      : inBand
        ? `⏳ sobreestimado ${fpct(pct(gI, gL))} vs precio s/imp · pendiente de corrección en tech (impuesto + FX)`
        : `⚠️ FUERA del patrón conocido (+3 a +22 % vs cobrado) — algo más cambió`;
    checks.push({ store: 'Google', status: worst([st, cst]), line: `Google (${rangeShortEs(start, end)}): Play cobrado ${k(gS)} · Looker ${k(gL)} · ${fpct(pct(gS, gL))} ${verdict} · cobros ${gN} vs ${gNl} ${icon(cst)}` });
  }

  // Stripe
  const sS = sumDays(stripe, start, end, 'gross'), sL = sumLooker(looker.byPp.stripe, start, end, 'gross');
  const sN = sumDays(stripe, start, end, 'n'), sNl = sumLooker(looker.byPp.stripe, start, end, 'n');
  const sP = pct(sS, sL), sCn = pct(sN, sNl);
  {
    const st: Status = sP === null ? 'warn' : Math.abs(sP) > STRIPE_ALARM ? 'alarm' : Math.abs(sP) > STRIPE_WARN ? 'warn' : 'ok';
    const cst: Status = sCn === null || Math.abs(sCn) > COUNT_WARN ? 'warn' : 'ok';
    const sk = streak(stripe, looker.byPp.stripe, start, end);
    checks.push({ store: 'Stripe', status: worst([st, cst, sk ? 'warn' : 'ok']), line: `Stripe (${rangeShortEs(start, end)}): API ${k(sS)} · Looker ${k(sL)} · ${fpct(sP)} ${icon(st)} · cobros ${sN} vs ${sNl} ${icon(cst)}`, detail: sk ?? undefined });
  }

  // Looker health: freshness + Stripe double-count factor
  const ageH = looker.freshness ? (Date.now() - Date.parse(looker.freshness)) / 3.6e6 : null;
  const fresh: Status = ageH === null ? 'warn' : ageH > FRESH_MAX_HOURS ? 'alarm' : 'ok';
  const freshTxt = looker.freshness ? `${new Date(Date.parse(looker.freshness) - 6 * 3.6e6).toISOString().slice(5, 16).replace('T', ' ')} MX` : 'desconocida';
  let counted = 0, real = 0, gap = 0;
  for (let d = start; d <= end; d = addDays(d, 1)) { const t = looker.tc[d]; const s = stripe[d]; if (t) { counted += t.stripeTerm; gap += t.refundGap; } if (s) real += s.gross - s.fee; }
  // Stripe en Net Sales/TC (base bruta: término al 0.965 + sus reembolsos) vs Stripe API neto de
  // comisión: ~1.0× = contado una vez (Variante 2, desde 2026-10-15; antes 1.46× por doble conteo).
  const factor = real ? (counted + gap) / real : null;
  const dc: Status = factor === null ? 'warn' : factor < DOUBLE_COUNT_FIXED_BELOW && factor > 0.9 ? 'ok' : 'warn';
  const gapSt: Status = gap > 1 ? 'info' : 'ok';
  checks.push({ store: 'Looker', status: worst([fresh, dc, gapSt]), line: `Looker: tabla actualizada ${freshTxt} ${icon(fresh)} · Stripe en Total Contribution ${factor === null ? 'n/d' : `${factor.toFixed(2)}× vs API`} ${dc === 'ok' ? '✅ contado una vez' : '⚠️ revisar'} · reembolsos de Stripe restados dos veces: −${money(gap)} en la semana ${gapSt === 'ok' ? '✅' : '⏳ fix pendiente en tech'}` });

  // Réplica del dashboard (kpi_daily): último job diario y su auto-reparación contra BigQuery.
  checks.push(await replicaCheck(today));
  // Guardia de KPIs (auditor automático horario): resumen de su última corrida.
  try {
    const { lastGuardSummary } = await import('@/lib/audit/kpi-guard');
    const g = await lastGuardSummary();
    if (g) checks.push({ store: 'Guardia', status: g.includes('✅') ? 'ok' : g.includes('🔴') ? 'alarm' : 'warn', line: g });
  } catch { /* tabla aún no creada (migración 037) */ }

  const status = worst(checks.map((c) => c.status));
  const alarms = checks.filter((c) => c.status === 'alarm').length, warns = checks.filter((c) => c.status === 'warn').length;
  const pending = checks.filter((c) => c.status === 'info').length;
  const parts: string[] = [];
  if (alarms) parts.push(`🔴 ${alarms} alarma${alarms > 1 ? 's' : ''}`);
  if (warns) parts.push(`⚠️ ${warns} aviso${warns > 1 ? 's' : ''}`);
  if (!alarms && !warns) parts.push('✅ Todo cuadra');
  if (pending) parts.push(`⏳ ${pending} pendiente${pending > 1 ? 's' : ''} de tech`);
  const headline = parts.join(' · ');
  const title = `🔎 Auditoría tiendas vs Looker — ${dayShortEs(today)} · ${headline}`;
  const lines = checks.map((c) => `• ${c.line}${c.detail ? `\n   ↳ ${c.detail}` : ''}`);
  const footer = `_Ventana: 7 días hasta ${dayShortEs(end)} (Apple hasta su último día publicado). Apple = App Store Connect · Google = Play ventas estimadas, FX de Google · Stripe = API · Looker = an_operational_dash · Réplica = kpi_daily vs BigQuery. Umbrales: Apple ±4/8 %, Stripe ±5/10 %, Google banda +3–22 %, conteos ±10 %. Método: docs/KPI-SOURCES.md_`;
  const message: SlackMessage = {
    text: title,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*${title}*` } },
      { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n').slice(0, 2900) } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: footer.slice(0, 2900) }] },
    ],
  };
  return { date: today, window: { start, end }, status, checks, message, text: [title, ...lines, footer].join('\n') };
}
