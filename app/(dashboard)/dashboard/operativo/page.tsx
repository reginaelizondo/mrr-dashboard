export const dynamic = 'force-dynamic';
export const maxDuration = 30;

import { OperativoContent, type OperativoData, type PeriodRow, type GroupRow } from '@/components/dashboard/OperativoContent';
import { computeKpis, type AggRow } from '@/lib/kpi/replica';
import { loadCore, loadDims, loadMeta, buildRequest, type PageParams } from '@/lib/kpi/operativo-data';
export type { Preset } from '@/lib/kpi/operativo-data';
function toPeriodRows(rows: AggRow[]): PeriodRow[] {
  return rows.map((a) => ({ period: a.period, looker: computeKpis(a, 'looker'), fixed: computeKpis(a, 'fixed') }));
}
function toGroupRows(rows: AggRow[]): GroupRow[] {
  return rows.map((a) => ({ period: a.period, grp: a.grp, looker: computeKpis(a, 'looker'), fixed: computeKpis(a, 'fixed') }));
}

export default async function OperativoPage({ searchParams }: { searchParams: Promise<PageParams> }) {
  const params = await searchParams;
  const { range, filters, prior, days } = buildRequest(params);

  let error: string | null = null;
  let data: OperativoData | null = null;
  try {
    const [core, dims, meta] = await Promise.all([loadCore(filters, range.grain, prior), loadDims(), loadMeta(range.start, range.end)]);
    const { series, current: cur, previous: prev, breakdown, groupSeries } = core;
    const { status, storeCoverage, guard } = meta;
    data = {
      preset: range.preset, start: range.start, end: range.end, grain: range.grain, days,
      filters: { region: filters.region ?? [], country: filters.country ?? [], os: filters.os ?? [], language: filters.language ?? [] },
      totals: { current: { looker: computeKpis(cur, 'looker'), fixed: computeKpis(cur, 'fixed') }, previous: { looker: computeKpis(prev, 'looker'), fixed: computeKpis(prev, 'fixed') }, priorStart: prior.start, priorEnd: prior.end },
      series: toPeriodRows(series),
      breakdown: { os: toGroupRows(breakdown.os), country: toGroupRows(breakdown.country), kinedu_language: toGroupRows(breakdown.kinedu_language), kinedu_region: toGroupRows(breakdown.kinedu_region) },
      groupSeries,
      dims: dims.map((d) => ({ dim: d.dim, value: d.value, signups: d.signups })),
      status,
      storeCoverage,
      guard,
      generatedAt: new Date().toISOString(),
    };
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[#0E3687]">Operativo</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Réplica del Looker Operational Dashboard sobre la copia diaria de BigQuery (kpi_daily) — mismos filtros, misma fuente, mismas fórmulas, verificada cada mañana.
        </p>
      </div>
      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          No pude leer la réplica: {error}. Si acabas de crear la tabla, falta correr la migración 032 (funciones kpi_daily_agg, kpi_daily_dim_values, kpi_daily_status).
        </div>
      ) : data ? (
        <OperativoContent data={data} />
      ) : null}
    </div>
  );
}
