import { createHash } from 'crypto';
import { getBigQueryClient, KINEDU_OPERATIONAL_TABLE } from '@/lib/bigquery/client';
import { createServerClient } from '@/lib/supabase/server';

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

/** Replace the rows of [start, end] in Supabase with a fresh pull. Returns row counts. */
export async function syncKpiDaily(start: string, end: string): Promise<{ start: string; end: string; rows: number; days: number }> {
  const rows = await fetchKpiDailyFromBigQuery(start, end);
  const supabase = createServerClient();
  const { error: delErr } = await supabase.from('kpi_daily').delete().gte('date', start).lte('date', end);
  if (delErr) throw new Error(`kpi_daily delete: ${delErr.message}`);
  for (let i = 0; i < rows.length; i += 1000) {
    const { error } = await supabase.from('kpi_daily').insert(rows.slice(i, i + 1000));
    if (error) throw new Error(`kpi_daily insert (batch ${i / 1000}): ${error.message}`);
  }
  return { start, end, rows: rows.length, days: new Set(rows.map((r) => r.date)).size };
}

/**
 * Compare replica vs BigQuery on the day totals that must match to the cent.
 * Used by the daily audit. Returns the days (within the window) that differ.
 */
export async function verifyKpiDaily(start: string, end: string): Promise<{ days: number; mismatches: Array<{ date: string; field: string; bq: number; replica: number }> }> {
  const bq = getBigQueryClient();
  const fields = ['signups', 'spend', 'new_subscriptions', 'new_subscriptions_sales', 'renewals_sales', 'refunds_total_amount_refund_date'] as const;
  const [bqRows] = await bq.query({
    query: `SELECT CAST(date AS STRING) AS date, ${fields.map((f) => `SUM(${f}) AS ${f}`).join(', ')} FROM ${KINEDU_OPERATIONAL_TABLE} WHERE date BETWEEN @start AND @end GROUP BY date`,
    params: { start, end },
  });
  const supabase = createServerClient();
  const { data: repRows, error } = await supabase.from('v_kpi_daily_totals').select('*').gte('date', start).lte('date', end);
  if (error) throw new Error(`v_kpi_daily_totals: ${error.message}`);
  const rep = new Map((repRows ?? []).map((r) => [String(r.date), r as Record<string, unknown>]));
  const mismatches: Array<{ date: string; field: string; bq: number; replica: number }> = [];
  let days = 0;
  for (const r of bqRows as Record<string, unknown>[]) {
    days++;
    const d = String(r.date); const rr = rep.get(d);
    for (const f of fields) {
      const a = toNum(r[f]), b = rr ? toNum(rr[f]) : NaN;
      if (!rr || Math.abs(a - b) > 0.01) mismatches.push({ date: d, field: f, bq: a, replica: rr ? b : 0 });
    }
  }
  return { days, mismatches };
}
