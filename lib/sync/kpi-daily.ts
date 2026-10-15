import { createHash } from 'crypto';
import { getBigQueryClient, KINEDU_OPERATIONAL_TABLE } from '@/lib/bigquery/client';
import { createServerClient } from '@/lib/supabase/server';
import { addDays } from '@/lib/kpi/period';

/**
 * kpi_daily — daily replica of an_operational_dash (BigQuery → Supabase).
 *
 * Why: the operational dashboard filters by os/country/language/region/network/plan
 * on every click; reading Supabase is instant and free, BigQuery is neither. The
 * replica keeps the BASE columns only — every KPI is computed on filtered sums with
 * lib/kpi/formulas.ts, exactly like Looker does on the same table.
 *
 * Idempotent per day: delete the day range, insert the fresh rows. Rows are grouped
 * by the 8 dimensions (the source is already at that grain; grouping guards against
 * accidental duplicates upstream).
 */

export const KPI_DAILY_DIMS = ['os', 'network', 'country', 'kinedu_language', 'product', 'plan_type', 'payment_processor', 'kinedu_region'] as const;
export const KPI_DAILY_MEASURES = [
  'signups', 'fts_started', 'fts_converted', 'impressions', 'clicks', 'downloads', 'spend', 'total_spend_retargeting', 'signups_retargeting',
  'new_subscriptions', 'new_subscriptions_sales', 'renewals', 'renewals_sales', 'renewals_yearly_ios', 'renewals_sales_yearly_ios',
  'other_sales', 'other_purchases',
  'refunds_total_amount_refund_date', 'num_of_refunds_refund_date', 'refunds_total_amount_sale_date', 'num_of_refunds_sale_date',
  'refunds_total_amount_refund_date_ft_conv', 'num_of_refunds_refund_date_ft_conv', 'refunds_total_amount_sale_date_ft_conv', 'num_of_refunds_sale_date_ft_conv',
] as const;

type Dim = (typeof KPI_DAILY_DIMS)[number];
type Measure = (typeof KPI_DAILY_MEASURES)[number];
export type KpiDailyRow = { date: string; dim_key: string; synced_at: string } & Record<Dim, string | null> & Record<Measure, number>;

const toNum = (v: unknown): number => { const raw = typeof v === 'object' && v !== null && 'value' in v ? (v as { value: unknown }).value : v; const n = Number(raw); return Number.isFinite(n) ? n : 0; };
const toStr = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export function dimKey(row: Record<Dim, string | null>): string {
  return createHash('md5').update(KPI_DAILY_DIMS.map((d) => row[d] ?? '').join('|')).digest('hex');
}

/** Pull one date range from BigQuery, grouped by the 8 dimensions. */
export async function fetchKpiDailyFromBigQuery(start: string, end: string): Promise<KpiDailyRow[]> {
  const bq = getBigQueryClient();
  const query = `
    SELECT CAST(date AS STRING) AS date, ${KPI_DAILY_DIMS.join(', ')},
      ${KPI_DAILY_MEASURES.map((m) => `SUM(${m}) AS ${m}`).join(',\n      ')}
    FROM ${KINEDU_OPERATIONAL_TABLE}
    WHERE date BETWEEN @start AND @end
    GROUP BY date, ${KPI_DAILY_DIMS.join(', ')}
  `;
  const [rows] = await bq.query({ query, params: { start, end } });
  const synced_at = new Date().toISOString();
  return (rows as Record<string, unknown>[]).map((r) => {
    const dims = Object.fromEntries(KPI_DAILY_DIMS.map((d) => [d, toStr(r[d])])) as Record<Dim, string | null>;
    const measures = Object.fromEntries(KPI_DAILY_MEASURES.map((m) => [m, toNum(r[m])])) as Record<Measure, number>;
    return { date: String(r.date), dim_key: dimKey(dims), synced_at, ...dims, ...measures };
  });
}

/** Month-aligned chunks of [start, end] (each ≤ 1 calendar month). */
export function monthChunks(start: string, end: string): Array<{ start: string; end: string }> {
  const out: Array<{ start: string; end: string }> = [];
  let s = start;
  while (s <= end) {
    const [y, m] = s.split('-').map(Number);
    const monthEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const e = monthEnd < end ? monthEnd : end;
    out.push({ start: s, end: e });
    s = addDays(e, 1);
  }
  return out;
}

/** Recompute the weekly/monthly rollup (kpi_rollup) for the weeks and months touching [start, end]. */
export async function refreshKpiRollup(start: string, end: string): Promise<number> {
  const supabase = createServerClient();
  let rows = 0;
  // ≤ 1 month per call keeps each statement well under Supabase's 8 s timeout.
  for (const c of monthChunks(start, end)) {
    const { data, error } = await supabase.rpc('refresh_kpi_rollup', { p_start: c.start, p_end: c.end });
    if (error) throw new Error(`refresh_kpi_rollup ${c.start}→${c.end}: ${error.message}`);
    rows += Number(((data ?? []) as Array<{ rows_written: number }>)[0]?.rows_written ?? 0);
  }
  return rows;
}

/**
 * Replace the rows of [start, end] in Supabase with a fresh pull, one calendar month at a
 * time (a failure leaves at most one month to re-run, not the whole window), then refresh
 * the rollup for the same range.
 */
export async function syncKpiDaily(start: string, end: string, opts: { rollup?: boolean } = {}): Promise<{ start: string; end: string; rows: number; days: number }> {
  const supabase = createServerClient();
  let rows = 0; let days = 0;
  for (const c of monthChunks(start, end)) {
    const chunk = await fetchKpiDailyFromBigQuery(c.start, c.end);
    const { error: delErr } = await supabase.from('kpi_daily').delete().gte('date', c.start).lte('date', c.end);
    if (delErr) throw new Error(`kpi_daily delete ${c.start}→${c.end}: ${delErr.message}`);
    for (let i = 0; i < chunk.length; i += 1000) {
      const { error } = await supabase.from('kpi_daily').insert(chunk.slice(i, i + 1000));
      if (error) throw new Error(`kpi_daily insert ${c.start}→${c.end} (batch ${i / 1000}): ${error.message}`);
    }
    rows += chunk.length; days += new Set(chunk.map((r) => r.date)).size;
  }
  if (opts.rollup !== false) await refreshKpiRollup(start, end);
  return { start, end, rows, days };
}

// Compared replica vs BigQuery per DAY × OS. Per-OS matters: BigQuery sometimes re-attributes a
// sale to another os after the fact — totals stay equal but Net Sales changes (different store
// commission). Seen 2026-10-15 in Aug-2025, Nov-2025 and Feb-2026. The fields include the ones
// that drift for weeks (FT conversions refunded, refunds attributed to the sale date) and the
// Stripe / other_sales splits that Net Sales depends on.
const VERIFY_FIELDS = [
  'signups', 'spend', 'fts_started', 'fts_converted', 'new_subscriptions', 'new_subscriptions_sales', 'renewals', 'renewals_sales',
  'renewals_sales_yearly_ios', 'other_sales', 'refunds_total_amount_refund_date', 'refunds_total_amount_sale_date', 'num_of_refunds_sale_date',
  'stripe_ns_sales', 'stripe_ren_sales', 'other_sales_stripe_net',
] as const;
const VERIFY_BQ_EXPR: Record<(typeof VERIFY_FIELDS)[number], string> = {
  signups: 'SUM(signups)', spend: 'SUM(spend)', fts_started: 'SUM(fts_started)', fts_converted: 'SUM(fts_converted)',
  new_subscriptions: 'SUM(new_subscriptions)', new_subscriptions_sales: 'SUM(new_subscriptions_sales)', renewals: 'SUM(renewals)',
  renewals_sales: 'SUM(renewals_sales)', renewals_sales_yearly_ios: 'SUM(renewals_sales_yearly_ios)', other_sales: 'SUM(other_sales)',
  refunds_total_amount_refund_date: 'SUM(refunds_total_amount_refund_date)', refunds_total_amount_sale_date: 'SUM(refunds_total_amount_sale_date)',
  num_of_refunds_sale_date: 'SUM(num_of_refunds_sale_date)',
  stripe_ns_sales: 'SUM(IF(payment_processor = "stripe", new_subscriptions_sales, 0))',
  stripe_ren_sales: 'SUM(IF(payment_processor = "stripe", renewals_sales, 0))',
  other_sales_stripe_net: 'SUM(IF(network = "stripe", other_sales, 0))',
};

export interface VerifyResult { days: number; mismatches: Array<{ date: string; os: string; field: string; bq: number; replica: number }>; badDates: string[] }

/** Quarter-aligned chunks (each kpi_daily_agg call stays far below Supabase's 8 s timeout). */
function quarterChunks(start: string, end: string): Array<{ start: string; end: string }> {
  const out: Array<{ start: string; end: string }> = [];
  let s = start;
  while (s <= end) {
    const [y, m] = s.split('-').map(Number);
    const qEndMonth = Math.floor((m - 1) / 3) * 3 + 3;
    const qEnd = new Date(Date.UTC(y, qEndMonth, 0)).toISOString().slice(0, 10);
    const e = qEnd < end ? qEnd : end;
    out.push({ start: s, end: e });
    s = addDays(e, 1);
  }
  return out;
}

/** Compare replica vs BigQuery per day × os over [start, end]. Missing cells on either side count as mismatches. */
export async function verifyKpiDaily(start: string, end: string): Promise<VerifyResult> {
  const { fetchAgg } = await import('@/lib/kpi/replica');
  const bq = getBigQueryClient();
  const [bqRows] = await bq.query({
    query: `SELECT CAST(date AS STRING) AS date, COALESCE(os, "null") AS os, ${VERIFY_FIELDS.map((f) => `${VERIFY_BQ_EXPR[f]} AS ${f}`).join(', ')}
            FROM ${KINEDU_OPERATIONAL_TABLE} WHERE date BETWEEN @start AND @end GROUP BY date, os`,
    params: { start, end },
  });
  const rep = new Map<string, Record<string, unknown>>();
  for (const c of quarterChunks(start, end)) {
    for (const r of await fetchAgg({ start: c.start, end: c.end }, 'day', 'os')) rep.set(`${r.period}|${r.grp}`, r as unknown as Record<string, unknown>);
  }
  const mismatches: VerifyResult['mismatches'] = [];
  const bad = new Set<string>(); const seen = new Set<string>(); const days = new Set<string>();
  const isZero = (r: Record<string, unknown>) => VERIFY_FIELDS.every((f) => Math.abs(toNum(r[f])) <= 0.01);
  for (const r of bqRows as Record<string, unknown>[]) {
    const d = String(r.date); const os = String(r.os); const key = `${d}|${os}`;
    seen.add(key); days.add(d);
    const rr = rep.get(key);
    if (!rr && isZero(r)) continue;
    for (const f of VERIFY_FIELDS) {
      const a = toNum(r[f]); const b = rr ? toNum(rr[f]) : 0;
      if (!rr || Math.abs(a - b) > 0.01) { mismatches.push({ date: d, os, field: f, bq: a, replica: b }); bad.add(d); }
    }
  }
  for (const [key, rr] of rep) {
    if (seen.has(key) || isZero(rr)) continue;
    const [d, os] = key.split('|');
    mismatches.push({ date: d, os, field: '(no existe en BigQuery)', bq: 0, replica: 1 }); bad.add(d);
  }
  return { days: days.size, mismatches, badDates: [...bad].sort() };
}

/** Group sorted YYYY-MM-DD dates into contiguous inclusive ranges. */
export function toRanges(dates: string[]): Array<{ start: string; end: string }> {
  const out: Array<{ start: string; end: string }> = [];
  for (const d of [...dates].sort()) {
    const last = out[out.length - 1];
    if (last && addDays(last.end, 1) === d) last.end = d; else out.push({ start: d, end: d });
  }
  return out;
}

export const KPI_DAILY_HISTORY_START = '2024-01-01';

/** Last rebuild of an_operational_dash (dbt runs several times a day: ≈09:01 and 11:02 MX, …). */
export async function fetchBigQueryModified(): Promise<string | null> {
  const [rows] = await getBigQueryClient().query({ query: `SELECT TIMESTAMP_MILLIS(last_modified_time) AS lm FROM \`celtic-music-240111.dbt_prod_analytics.__TABLES__\` WHERE table_id = 'an_operational_dash'` });
  const lm = (rows as Record<string, unknown>[])[0]?.lm;
  const v = typeof lm === 'object' && lm !== null && 'value' in lm ? (lm as { value: string }).value : lm;
  return v ? new Date(String(v)).toISOString() : null;
}
export const KPI_DAILY_WINDOW_DAYS = 95; // refunds and late re-attributions keep landing for weeks

/**
 * The daily job:
 *  1. Re-sync the last 95 days (refunds attributed to the sale date and late re-attributions
 *     keep changing BigQuery for weeks — 21 days was not enough, seen 2026-10-15).
 *  2. Re-sync ONE older month in rotation, so even pure re-attributions (totals unchanged,
 *     dimension changed) get picked up within ~a month anywhere in the history.
 *  3. Self-heal: compare day totals over the whole history and re-sync any day that differs
 *     (capped per run), so the replica converges to BigQuery without manual backfills.
 */
export async function runDailyKpiSync(today: string, opts: { budgetMs?: number; maxHealDays?: number } = {}) {
  const t0 = Date.now();
  const bqModified = await fetchBigQueryModified();
  const budgetMs = opts.budgetMs ?? 220_000;
  const maxHealDays = opts.maxHealDays ?? 62;
  const windowStart = addDays(today, -KPI_DAILY_WINDOW_DAYS);
  const window = await syncKpiDaily(windowStart, today);

  // Rotating month: all complete months strictly before the window's month.
  const months: string[] = [];
  for (const c of monthChunks(KPI_DAILY_HISTORY_START, addDays(windowStart.slice(0, 8) + '01', -1))) months.push(c.start);
  let rotated: { start: string; end: string; rows: number } | null = null;
  if (months.length) {
    const dayNumber = Math.floor(Date.parse(today + 'T00:00:00Z') / 86_400_000);
    const m = months[dayNumber % months.length];
    const chunk = monthChunks(m, today)[0];
    const r = await syncKpiDaily(chunk.start, chunk.end);
    rotated = { start: r.start, end: r.end, rows: r.rows };
  }

  let heal: { checkedDays: number; badDays: number; healedDays: number; ranges: Array<{ start: string; end: string }>; skipped?: string } = { checkedDays: 0, badDays: 0, healedDays: 0, ranges: [] };
  if (Date.now() - t0 < budgetMs) {
    const v = await verifyKpiDaily(KPI_DAILY_HISTORY_START, today);
    heal = { checkedDays: v.days, badDays: v.badDates.length, healedDays: 0, ranges: [] };
    const toHeal = v.badDates.slice(0, maxHealDays);
    for (const r of toRanges(toHeal)) {
      if (Date.now() - t0 > budgetMs) { heal.skipped = 'presupuesto de tiempo agotado'; break; }
      await syncKpiDaily(r.start, r.end);
      heal.ranges.push(r);
      heal.healedDays += Math.round((Date.parse(r.end) - Date.parse(r.start)) / 86_400_000) + 1;
    }
  } else {
    heal.skipped = 'presupuesto de tiempo agotado antes de verificar';
  }
  return { bqModified, window: { start: window.start, end: window.end, rows: window.rows }, rotated, heal, seconds: Math.round((Date.now() - t0) / 1000) };
}
