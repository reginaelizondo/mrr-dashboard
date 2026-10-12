import { getBigQueryClient, KINEDU_OPERATIONAL_TABLE } from '@/lib/bigquery/client';
import { KPI_SQL, type KPIKey } from './formulas';

/**
 * BigQuery reads for the daily brief. Every KPI is computed in SQL with the
 * validated formulas (lib/kpi/formulas.ts) — nothing is re-derived in TS, so a
 * ratio over a 7-day window is the ratio of the window's sums, never an
 * average of daily ratios.
 *
 * All periods of one dimension are fetched in a single query via
 * CROSS JOIN UNNEST([STRUCT(...)]) so a brief costs ~6 queries, not ~40.
 */

export type KPIValues = Record<KPIKey, number | null>;

export interface NamedPeriod {
  key: string;   // identifier used to index the result, e.g. 'yesterday'
  start: string; // YYYY-MM-DD inclusive
  end: string;   // YYYY-MM-DD inclusive
}

export type BreakdownDimension = 'os' | 'kinedu_language' | 'country' | 'kinedu_region';

const KPI_KEYS = Object.keys(KPI_SQL) as KPIKey[];
const SELECT_KPIS = KPI_KEYS.map((k) => `  ${KPI_SQL[k]} AS ${k}`).join(',\n');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KEY_RE = /^[a-zA-Z0-9_]{1,40}$/;

/** BigQuery returns NUMERIC as strings and DATE as { value }. Normalise. */
export function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const raw = typeof v === 'object' && v !== null && 'value' in v ? (v as { value: unknown }).value : v;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function emptyValues(): KPIValues {
  const out = {} as KPIValues;
  for (const k of KPI_KEYS) out[k] = null;
  return out;
}

function rowToValues(row: Record<string, unknown>): KPIValues {
  const out = {} as KPIValues;
  for (const k of KPI_KEYS) out[k] = toNumber(row[k]);
  return out;
}

function periodsLiteral(periods: NamedPeriod[]): string {
  for (const p of periods) {
    if (!KEY_RE.test(p.key)) throw new Error(`Invalid period key: ${p.key}`);
    if (!DATE_RE.test(p.start) || !DATE_RE.test(p.end)) throw new Error(`Invalid period dates: ${p.key}`);
  }
  return '[' + periods
    .map((p) => `STRUCT('${p.key}' AS pkey, DATE '${p.start}' AS pstart, DATE '${p.end}' AS pend)`)
    .join(', ') + ']';
}

function bounds(periods: NamedPeriod[]): { minDate: string; maxDate: string } {
  const starts = periods.map((p) => p.start).sort();
  const ends = periods.map((p) => p.end).sort();
  return { minDate: starts[0], maxDate: ends[ends.length - 1] };
}

/** All KPIs for every named period, one query. Periods with no rows come back as nulls. */
export async function fetchKPIsByPeriod(periods: NamedPeriod[]): Promise<Record<string, KPIValues>> {
  const bq = getBigQueryClient();
  const { minDate, maxDate } = bounds(periods);
  const query = `
    SELECT p.pkey AS period_key,
${SELECT_KPIS}
    FROM ${KINEDU_OPERATIONAL_TABLE} t
    CROSS JOIN UNNEST(${periodsLiteral(periods)}) AS p
    WHERE t.date BETWEEN @minDate AND @maxDate
      AND t.date BETWEEN p.pstart AND p.pend
    GROUP BY period_key
  `;
  const [rows] = await bq.query({ query, params: { minDate, maxDate } });
  const out: Record<string, KPIValues> = {};
  for (const p of periods) out[p.key] = emptyValues();
  for (const row of rows as Record<string, unknown>[]) {
    out[String(row.period_key)] = rowToValues(row);
  }
  return out;
}

/** All KPIs for every named period × every value of one dimension. periodKey → dimValue → KPIs. */
export async function fetchKPIsByPeriodAndDimension(
  periods: NamedPeriod[],
  dimension: BreakdownDimension
): Promise<Record<string, Record<string, KPIValues>>> {
  const bq = getBigQueryClient();
  const { minDate, maxDate } = bounds(periods);
  const query = `
    SELECT p.pkey AS period_key,
      COALESCE(CAST(t.\`${dimension}\` AS STRING), '(null)') AS dimension,
${SELECT_KPIS}
    FROM ${KINEDU_OPERATIONAL_TABLE} t
    CROSS JOIN UNNEST(${periodsLiteral(periods)}) AS p
    WHERE t.date BETWEEN @minDate AND @maxDate
      AND t.date BETWEEN p.pstart AND p.pend
    GROUP BY period_key, dimension
  `;
  const [rows] = await bq.query({ query, params: { minDate, maxDate } });
  const out: Record<string, Record<string, KPIValues>> = {};
  for (const p of periods) out[p.key] = {};
  for (const row of rows as Record<string, unknown>[]) {
    const pk = String(row.period_key);
    out[pk] ??= {};
    out[pk][String(row.dimension)] = rowToValues(row);
  }
  return out;
}

export interface DailyRow extends KPIValues {
  date: string;
}

/** One row per day with every KPI — used for the noise band (mean/sd per KPI). */
export async function fetchDailySeries(start: string, end: string): Promise<DailyRow[]> {
  const bq = getBigQueryClient();
  const query = `
    SELECT CAST(date AS STRING) AS day,
${SELECT_KPIS}
    FROM ${KINEDU_OPERATIONAL_TABLE}
    WHERE date BETWEEN @start AND @end
    GROUP BY day
    ORDER BY day
  `;
  const [rows] = await bq.query({ query, params: { start, end } });
  return (rows as Record<string, unknown>[]).map((row) => ({
    date: String(row.day),
    ...rowToValues(row),
  }));
}

/** When dbt last rebuilt the table (ISO UTC string), or null if unavailable. */
export async function fetchTableFreshness(): Promise<string | null> {
  try {
    const bq = getBigQueryClient();
    const [rows] = await bq.query({
      query: `SELECT TIMESTAMP_MILLIS(last_modified_time) AS lm
              FROM \`celtic-music-240111.dbt_prod_analytics.__TABLES__\`
              WHERE table_id = 'an_operational_dash'`,
    });
    const lm = (rows as Record<string, unknown>[])[0]?.lm;
    if (!lm) return null;
    const v = typeof lm === 'object' && lm !== null && 'value' in lm ? (lm as { value: string }).value : String(lm);
    return v;
  } catch (err) {
    console.error('[daily-brief] freshness lookup failed:', err instanceof Error ? err.message : err);
    return null;
  }
}
