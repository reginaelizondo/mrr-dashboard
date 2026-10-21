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

// ---- Corregido calibrado con tienda (mismo número que el dashboard Operativo) --------------------
// Los montos del Corregido salen de la réplica calibrada (migración 037) cuando está activa; el resto de
// los KPIs (conteos, tasas, CAC, versiones "…Looker") siguen viniendo de BigQuery con formulas.ts.
const CALIBRATED_KEYS: KPIKey[] = ['nsSales', 'totalSales', 'netSales', 'mobileCm', 'totalContribution', 'contributionMarginPct', 'arpu', 'firstTicketCac'];
type Replica = typeof import('./replica');
let replicaMod: Replica | null = null;
const replica = async () => (replicaMod ??= await import('./replica'));

function overlay(values: KPIValues, k: import('./replica').KpiValues): KPIValues {
  if (!k.calibration.calibrated) return values;
  const out = { ...values };
  for (const key of CALIBRATED_KEYS) out[key] = (k as unknown as Record<string, number | null>)[key] ?? null;
  return out;
}

async function overlayPeriods(out: Record<string, KPIValues>, periods: NamedPeriod[]): Promise<void> {
  try {
    const r = await replica();
    await Promise.all(periods.map(async (p) => { out[p.key] = overlay(out[p.key], r.computeKpis(r.sumAgg(await r.fetchAgg({ start: p.start, end: p.end }, 'total')), 'fixed')); }));
  } catch (e) { console.error('[brief] calibración no disponible, se usa BigQuery:', e instanceof Error ? e.message : e); }
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
  await overlayPeriods(out, periods);
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
  try {
    const r = await replica();
    await Promise.all(periods.map(async (p) => {
      for (const a of await r.fetchAgg({ start: p.start, end: p.end }, 'total', dimension)) {
        const seg = a.grp === 'null' ? '(null)' : a.grp;
        if (out[p.key][seg]) out[p.key][seg] = overlay(out[p.key][seg], r.computeKpis(a, 'fixed'));
      }
    }));
  } catch (e) { console.error('[brief] calibración por dimensión no disponible:', e instanceof Error ? e.message : e); }
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
  const series = (rows as Record<string, unknown>[]).map((row) => ({
    date: String(row.day),
    ...rowToValues(row),
  }));
  try {
    const r = await replica();
    const byDay = new Map((await r.fetchAgg({ start, end }, 'day')).map((a) => [a.period, a]));
    return series.map((d) => { const a = byDay.get(d.date); return a ? { ...overlay(d, r.computeKpis(a, 'fixed')), date: d.date } : d; });
  } catch { return series; }
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

// ---- Conversión por cohorte de signup (misma fuente que el Tableau "Conversion (Weekly) by Signup Cohort") ----
// La usa el brief de cohortes (lib/kpi/cohort-brief.ts), que va a su propio canal. El brief diario es calendar basis.

/** Tabla por usuario: fecha de signup y de primera compra premium. Los signups por semana cuadran con el Tableau. */
export const CONVERSION_COHORT_TABLE = '`celtic-music-240111.dbt_prod_analytics.an_conversion_analysis`';
/** Ventanas de conversión (días desde el signup, día 0 incluido). 8 días incluye el cobro del trial
 *  (3 días en Android, 7 en iOS), así que compara cohortes a la misma edad. */
export const COHORT_WINDOW_DAYS = 7;
export const COHORT_LONG_WINDOW_DAYS = 29;

/** Una cohorte diaria de signup por OS y red de adquisición: cuántos se registraron y cuántos compraron el mismo
 *  día, a 8 y a 30 días. `network` = red del signup (Organics, Facebook, Smartlinks…; sin red → 'Sin red'). */
export interface CohortDay { day: string; os: string; network: string; signups: number; d0: number; d8: number; d30: number }

/**
 * Cohortes diarias de signup por OS (iOS, Android) con signup entre `start` y `end`. Los conteos a 8 y 30 días
 * solo son finales si el signup + 7 (o + 29) ≤ último día con datos; quien llama decide qué cohortes ya maduraron.
 */
export async function fetchSignupCohortsDaily(start: string, end: string): Promise<CohortDay[]> {
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) throw new Error(`Invalid cohort range: ${start}..${end}`);
  const bq = getBigQueryClient();
  const query = `
    WITH u AS (
      SELECT user_id, ANY_VALUE(os) AS os, ANY_VALUE(network) AS network, MIN(signup_date) AS s, MIN(premium_conversion_date) AS c
      FROM ${CONVERSION_COHORT_TABLE}
      WHERE signup_date BETWEEN @start AND @end
      GROUP BY user_id
    )
    SELECT CAST(s AS STRING) AS day, os, IFNULL(NULLIF(TRIM(network), ''), 'Sin red') AS network, COUNT(*) AS signups,
      COUNTIF(c IS NOT NULL AND DATE_DIFF(c, s, DAY) = 0) AS d0,
      COUNTIF(c IS NOT NULL AND DATE_DIFF(c, s, DAY) BETWEEN 0 AND ${COHORT_WINDOW_DAYS}) AS d8,
      COUNTIF(c IS NOT NULL AND DATE_DIFF(c, s, DAY) BETWEEN 0 AND ${COHORT_LONG_WINDOW_DAYS}) AS d30
    FROM u WHERE os IN ('iOS', 'Android')
    GROUP BY day, os, network ORDER BY day, os, network
  `;
  const [rows] = await bq.query({ query, params: { start, end } });
  return (rows as Record<string, unknown>[]).map((r) => ({
    day: String(r.day), os: String(r.os), network: String(r.network),
    signups: toNumber(r.signups) ?? 0, d0: toNumber(r.d0) ?? 0, d8: toNumber(r.d8) ?? 0, d30: toNumber(r.d30) ?? 0,
  }));
}
