import { getBigQueryClient, KINEDU_OPERATIONAL_TABLE } from '@/lib/bigquery/client';
import { KPI_SQL, KPIKey } from './formulas';
import type { Period } from './period';

export type KPIRow = Record<KPIKey, number | null>;

/**
 * Run all top-level KPIs for a given Mon-Sun period. Returns aggregate row.
 */
export async function fetchKPIsForPeriod(period: Period): Promise<KPIRow> {
  const bq = getBigQueryClient();
  const selectClause = (Object.entries(KPI_SQL) as [KPIKey, string][])
    .map(([k, sql]) => `  ${sql} AS ${k}`)
    .join(',\n');

  const query = `
    SELECT
${selectClause}
    FROM ${KINEDU_OPERATIONAL_TABLE}
    WHERE date BETWEEN @start AND @end
  `;

  const [rows] = await bq.query({
    query,
    params: { start: period.start, end: period.end },
  });
  return rows[0] as KPIRow;
}

export interface BreakdownRow extends KPIRow {
  dimension: string;
}

/**
 * Run KPIs grouped by a single dimension (os, kinedu_region, kinedu_language, network, country).
 * Used to explain WoW changes ("the +5% in NS Sales is driven by Android +12%").
 */
export async function fetchKPIsBreakdown(
  period: Period,
  dimensionColumn: string
): Promise<BreakdownRow[]> {
  const bq = getBigQueryClient();
  const selectClause = (Object.entries(KPI_SQL) as [KPIKey, string][])
    .map(([k, sql]) => `  ${sql} AS ${k}`)
    .join(',\n');

  const query = `
    SELECT
      COALESCE(CAST(\`${dimensionColumn}\` AS STRING), '(null)') AS dimension,
${selectClause}
    FROM ${KINEDU_OPERATIONAL_TABLE}
    WHERE date BETWEEN @start AND @end
    GROUP BY dimension
    ORDER BY nsSales DESC
  `;

  const [rows] = await bq.query({
    query,
    params: { start: period.start, end: period.end },
  });
  return rows as BreakdownRow[];
}
